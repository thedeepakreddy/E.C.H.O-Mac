/** Background agents: missions, clones, delegated tasks, results and run replays. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import { currentInvocation } from "../../memory/invocation.js";
import { taskCoordinator } from "../../memory/task-state.js";
import { owningTaskId } from "../../frontier/task-handoff.js";
import * as vision from "../vision.js";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as research from "../../frontier/research.js";
import { homedir } from "node:os";
import { sendToOverlay } from "../../overlay.js";
import { exec, spawn } from "node:child_process";
import { race } from "../../frontier/parallel.js";
import { inspectRun, loadEvents, renderInspectionHtml } from "../../agent-replay/index.js";
import { appRoot, memoryScope } from "./shared.js";

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: "inspect_agent_replay",
    description: "Show Echo's recorded run timeline and a clear answer to why it ended. Use when a run stopped, failed, was interrupted, or the user asks to inspect the latest agent replay.",
    schema: {
      runId: z.string().optional().describe("Optional exact replay run ID. Omit to inspect the latest run."),
      actorName: z.string().optional().describe("Optional actor name, such as 'Echo' or 'Echo Clone 1'. Omit for the latest actor."),
    },
    readOnly: true,
    handler: async (a) => {
      // Full named journals are always-on unless ECHO_FULL_LOG=0. Inspect
      // whichever run store Echo is currently using.
      const root = process.env.ECHO_REPLAY_DIR?.trim()
        || process.env.ECHO_LOG_DIR?.trim()
        || join(appRoot(), "runs");
      if (!existsSync(root)) {
        return { text: "There are no recorded Echo runs yet." };
      }
      const actorPrefix = a.actorName ? `${String(a.actorName).trim()}--` : "";
      const runId = a.runId || readdirSync(root)
        .filter((entry) => {
          try {
            return statSync(join(root, entry)).isDirectory() &&
              existsSync(join(root, entry, "events.jsonl")) &&
              (!actorPrefix || entry.startsWith(actorPrefix));
          } catch { return false; }
        })
        .sort((left, right) => statSync(join(root, right)).mtimeMs - statSync(join(root, left)).mtimeMs)[0];
      if (!runId) return { text: "There are no recorded Echo runs yet." };
      const runDir = join(root, runId);
      try {
        const summary = inspectRun(loadEvents(runDir));
        sendToOverlay("show-data-pane", {
          title: `${summary.actorName.toUpperCase()} · ${summary.status.toUpperCase()}`,
          content: renderInspectionHtml(summary),
          duration: 30000,
        });
        const detail = summary.exitDetail ? ` ${summary.exitDetail}` : "";
        return { text: `${summary.actorName} run ${summary.runId} ${summary.status} after ${summary.iterations} iteration(s): ${summary.exitReason ?? "no exit event"}.${detail}` };
      } catch (error: any) {
        return { text: `I couldn't read replay ${runId}: ${error?.message ?? error}` };
      }
    },
  },
  {
    name: "check_agents",
    description:
      "Check on the agent board or background agents you have dispatched (spawn_subagent, or a board run from the control panel): their status and what each one actually found or produced. Call this whenever the user asks what an agent found, whether a task finished, or refers to work you delegated — their real report is here, do not guess at it or say you don't know before checking. Omit missionId to see every board from this session.",
    schema: {
      missionId: z.string().optional().describe("One specific board/mission id, from an earlier check_agents call. Omit to see all of them."),
    },
    readOnly: true,
    handler: async (a) => {
      const { swarm } = await import("../../frontier/swarm.js");
      const missions = a.missionId
        ? [swarm.getMission(a.missionId)].filter((m): m is NonNullable<typeof m> => !!m)
        : swarm.listMissions();
      if (!missions.length) {
        return { text: a.missionId ? `No board or mission with id "${a.missionId}".` : "No agents have been dispatched this session." };
      }
      const live = new Map(swarm.list().map((c) => [c.name, c.progress]));
      const describeTask = (id: string, task: (typeof missions)[number]["tasks"][string]) => {
        const label = task.actorName || id;
        if (task.status === "working") {
          const progress = task.actorName ? live.get(task.actorName) : undefined;
          return `  • ${label}: still working${progress ? ` — "${progress}"` : ""}`;
        }
        if (task.status === "pending") return `  • ${label}: queued, waiting on ${(task.dependsOn ?? []).join(", ") || "nothing"}`;
        if (task.status === "blocked") return `  • ${label}: blocked (${task.result?.blockers?.join(", ") ?? "unresolved dependency"})`;
        const r = task.result;
        const artifacts = (r?.artifacts ?? [])
          .filter((x) => x.kind === "text" && x.value)
          .map((x) => `\n      ${x.label ? `${x.label}: ` : ""}${x.value.slice(0, 4000)}`)
          .join("");
        return `  • ${label} [${task.status}]: ${r?.summary ?? "no summary submitted"}${artifacts}`;
      };
      const lines = missions.map((m) => {
        const tasks = Object.entries(m.tasks).map(([id, t]) => describeTask(id, t as any));
        return `Board "${m.goal}" (id: ${m.id}, ${m.status}):\n${tasks.join("\n")}`;
      });
      return { text: lines.join("\n\n") };
    },
  },
  {
    name: "inspect_task",
    description:
      "Show the state of the task you are working on right now: the goal, every tool call and how it ended, what has been verified, what is still uncertain, and anything blocking it. Use it when the user asks where things stand, when you resume after an interruption, or when you have lost track of what you already did — reading your own state is cheaper and far more reliable than guessing from the conversation.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const taskId = owningTaskId();
      const state = taskId ? taskCoordinator.get(taskId) : undefined;
      if (!state) return { text: "There is no active task state to report." };
      const calls = Object.values(state.calls);
      const unresolved = calls.filter((c) => ["running", "timeout", "uncertain", "partial"].includes(c.status));
      const failed = calls.filter((c) => c.status === "failed" || c.status === "denied");
      const line = (c: typeof calls[number]) => `  • ${c.tool} (${c.status})${c.result?.error ? ` — ${c.result.error.category}: ${c.result.error.message}` : ""}`;
      const parts = [
        `Task ${state.taskId} · revision ${state.revision} · ${state.status}`,
        `Goal: ${state.goal || "(not recorded)"}`,
        `Calls: ${calls.length} (${calls.filter((c) => c.status === "success").length} succeeded, ${failed.length} failed or denied, ${unresolved.length} unresolved).`,
        failed.length ? `Failed:\n${failed.map(line).join("\n")}` : "",
        unresolved.length ? `Still uncertain — an external effect may have happened; look before retrying:\n${unresolved.map(line).join("\n")}` : "",
        state.verificationRefs.length ? `Verified evidence: ${state.verificationRefs.join(", ")}` : "Nothing has been verified yet.",
        state.artifacts.length ? `Artifacts: ${JSON.stringify(state.artifacts).slice(0, 800)}` : "",
        state.blockers.length ? `Blockers: ${JSON.stringify(state.blockers).slice(0, 800)}` : "",
        state.childTaskIds.length ? `Child tasks: ${state.childTaskIds.join(", ")}` : "",
      ];
      return { text: parts.filter(Boolean).join("\n"), status: "success", verification: "unverified", data: { taskId: state.taskId, revision: state.revision } };
    },
  },
  {
    name: "verify_task",
    description:
      "Prove an action task actually happened, by checking the result yourself before you tell the user it is done. A tool that returned without error is not evidence that the file was written, the app changed, or the message is on screen — this is what turns 'the call succeeded' into 'the thing exists'. Call it with the concrete conditions that must now be true. Checks are read-only and never change anything. Use it for tasks that DID something; a question you answered needs no verification.",
    schema: {
      checks: z
        .array(
          z.object({
            kind: z.enum(["file_exists", "file_absent", "file_contains", "screen_contains"]).describe("What to check."),
            path: z.string().optional().describe("Absolute path to the file, for the file checks. ~ is expanded. A relative path is refused rather than guessed at."),
            text: z.string().optional().describe("The text that must be present, for file_contains and screen_contains."),
          })
        )
        .min(1)
        .describe("Every condition that must hold for the task to be genuinely complete."),
      summary: z.string().optional().describe("One sentence on what was accomplished, recorded with the outcome."),
    },
    readOnly: true,
    handler: async (a) => {
      const taskId = owningTaskId();
      const results: { check: string; ok: boolean; detail: string }[] = [];
      for (const check of a.checks) {
        // Absolute only, like the other file tools. Guessing a base directory
        // is how a check passes against the wrong file and reports a task done.
        const given = check.path?.trim() ?? "";
        const target = given.startsWith("~/") ? join(homedir(), given.slice(2)) : given === "~" ? homedir() : given;
        const label = `${check.kind}${target ? ` ${target}` : ""}${check.text ? ` ~ ${JSON.stringify(check.text.slice(0, 60))}` : ""}`;
        try {
          if (check.kind === "file_exists" || check.kind === "file_absent" || check.kind === "file_contains") {
            if (!target) { results.push({ check: label, ok: false, detail: "no path given" }); continue; }
            if (!isAbsolute(target)) { results.push({ check: label, ok: false, detail: `"${given}" is relative — give the absolute path so the check cannot land on the wrong file` }); continue; }
            const there = existsSync(target);
            if (check.kind === "file_exists") results.push({ check: label, ok: there, detail: there ? `exists, ${statSync(target).size} bytes` : "not found" });
            else if (check.kind === "file_absent") results.push({ check: label, ok: !there, detail: there ? "still exists" : "absent" });
            else {
              const found = there && readFileSync(target, "utf8").includes(check.text ?? "");
              results.push({ check: label, ok: found, detail: !there ? "not found" : found ? "contains the text" : "file exists but the text is not in it" });
            }
          } else {
            // Read the screen rather than trust the model's recollection of it.
            const screen = vision.summarizeOcr(await vision.ocr("accurate"));
            const found = screen.toLowerCase().includes((check.text ?? "").toLowerCase());
            results.push({ check: label, ok: found && !!check.text, detail: found ? "on screen now" : "not on screen" });
          }
        } catch (error: any) {
          results.push({ check: label, ok: false, detail: `could not check: ${error?.message ?? error}` });
        }
      }
      const passed = results.filter((r) => r.ok);
      const verified = passed.length === results.length;
      const refs = passed.map((r) => `verified:${r.check}@${new Date().toISOString()}`);
      if (taskId && refs.length) {
        try { taskCoordinator.recordVerification(taskId, refs); }
        catch (error) { console.error("[memory] verification not recorded", error); }
      }
      // A workflow that ran in this task is only credited once its result has
      // actually been checked — which is the moment this tool succeeds.
      if (taskId && verified) {
        try {
          const { noteProcedureRun } = await import("../../memory/consolidate.js");
          const scope = await memoryScope();
          const ran = Object.values(taskCoordinator.get(taskId)?.calls ?? {})
            .filter((c) => c.tool === "run_skill" && c.status === "success");
          for (const call of ran) {
            const data = (call.result?.data ?? {}) as { procedureId?: string; version?: number };
            if (data.procedureId) noteProcedureRun({ procedureId: data.procedureId, version: data.version, scope, taskId, verified: true, verificationRefs: refs, origin: "real" });
          }
        } catch (error) { console.error("[memory] verified procedure run not recorded", error); }
      }
      const report = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.check} — ${r.detail}`).join("\n");
      return {
        text: verified
          ? `Verified — every postcondition holds:\n${report}`
          : `NOT verified. Do not report this task as done; fix what failed and check again:\n${report}`,
        status: verified ? "success" : "failed",
        verification: verified ? "verified" : "contradicted",
        verificationRefs: refs,
        ...(verified ? {} : { error: { category: "verification_failed", message: `${results.length - passed.length} of ${results.length} postconditions did not hold`, retryable: true } }),
        data: { results, summary: a.summary },
      };
    },
  },
  {
    name: "delegate_task",
    description: "Delegate a background task to a durable, named Echo clone. The clone is logged and resumes from its checkpoint after an unexpected stop.",
    schema: {
      agentName: z.string().describe("The name of the sub-agent (e.g. 'Jarvis-Worker-1')."),
      taskDescription: z.string().describe("The complex task for the sub-agent to perform."),
    },
    readOnly: false,
    handler: async (a) => {
      const { loadConfig } = await import("../../config.js");
      const { makeFleetBrain } = await import("../../frontier/fleet-brain.js");
      const { swarm } = await import("../../frontier/swarm.js");
      const cfg = loadConfig(appRoot());
      const goal = `${a.taskDescription}\nRequested worker label: ${a.agentName}`;
      const result = swarm.spawn(goal, {
        makeBrain: makeFleetBrain(cfg),
      });
      return result.ok
        ? { text: `${result.name} started. Its full run log and recovery checkpoint are active.` }
        : { text: `The clone was not started: ${result.reason ?? "unknown reason"}.` };
    },
  },
  {
    name: "try_approaches_in_parallel",
    description:
      "Try several fixes at once in isolated copies of a git repository, run a verification command on each, and keep only the one that passes. The user's working copy is never touched.",
    schema: {
      repo: z.string().describe("Path to the git repository"),
      attempts: z.array(z.object({ name: z.string(), apply: z.string() })).describe("Each attempt: a name and the shell command that makes the change"),
      verify: z.string().describe("Shell command that succeeds when the fix works, e.g. 'npm test'"),
    },
    readOnly: false,
    handler: async (a) => {
      const report = await race(a.repo, a.attempts, a.verify);
      return { text: report.summary + (report.winner?.diff ? `\n\nWinning diff:\n${report.winner.diff.slice(0, 2500)}` : "") };
    },
  },
  {
    name: "spawn_subagent",
    description: "Spawn one or more background sub-agents to handle long-running, parallel GUI or web tasks asynchronously while you remain available to talk to the user. Each sub-agent runs in its own isolated context. Pass multiple goals to spawn multiple clones at once.",
    schema: { goals: z.array(z.string()).describe("A list of detailed instructions, one for each sub-agent you wish to spawn.") },
    readOnly: false,
    handler: async (a) => {
      const { loadConfig } = await import("../../config.js");
      const { makeFleetBrain } = await import("../../frontier/fleet-brain.js");
      const { swarm } = await import("../../frontier/swarm.js");
      const cfg = loadConfig(appRoot());

      const goals = (Array.isArray(a.goals) ? a.goals : [a.goals]).filter(Boolean);
      let spawned = 0;
      let refusal = "";
      for (const goal of goals) {
        // Each clone is its own background brain; the swarm caps concurrency so
        // they can't trample each other over the single mouse and keyboard.
        const r = swarm.spawn(String(goal), {
          makeBrain: makeFleetBrain(cfg),
        });
        if (r.ok) spawned++;
        else refusal = r.reason ?? "refused";
      }
      let msg = spawned ? `Spawned ${spawned} sub-agent(s); ${swarm.count()} now running.` : "";
      if (refusal) msg += ` ${goals.length - spawned} not started (${refusal}).`;
      return { text: msg.trim() || "Nothing to spawn." };
    }
  },
  {
    name: "run_agent_mission",
    description:
      "Start a durable multi-agent Mission with dependencies, acceptance criteria, focused execution lanes, and hard budgets. Use for substantial work that benefits from research or preparation before a later Agent Task. Knowledge tasks may run in parallel; GUI tasks are serialized because they share one pointer and keyboard. Returns immediately with a Mission ID for inspect_agent_mission.",
    schema: {
      goal: z.string().min(1).describe("The overall user outcome"),
      tasks: z.array(z.object({
        id: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
        goal: z.string().min(1),
        dependsOn: z.array(z.string()).default([]),
        lane: z.enum(["knowledge", "gui"]).default("knowledge"),
        acceptanceCriteria: z.array(z.string()).default([]),
        profile: z.string().optional().describe("A fleet agent id — lead, research, plan, write, review, analyse, or one of the user's own agents. It sets that agent's brief, model tier and tool limits; any other text is only a display name."),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
        maxIterations: z.number().int().min(1).max(200).default(50),
        maxRecoveryAttempts: z.number().int().min(0).max(5).default(2),
      })).min(1).max(50),
    },
    readOnly: false,
    handler: async (args) => {
      const { loadConfig } = await import("../../config.js");
      const { makeFleetBrain } = await import("../../frontier/fleet-brain.js");
      const { swarm } = await import("../../frontier/swarm.js");
      const cfg = loadConfig(appRoot());
      const result = swarm.submitMission({
        goal: args.goal,
        scope: { ...(await memoryScope()) },
        tasks: args.tasks.map((task: any) => ({
          id: task.id,
          goal: task.goal,
          dependsOn: task.dependsOn,
          lane: task.lane,
          acceptanceCriteria: task.acceptanceCriteria,
          profile: task.profile,
          budget: {
            timeoutMs: task.timeoutMs,
            maxIterations: task.maxIterations,
            maxRecoveryAttempts: task.maxRecoveryAttempts,
          },
        })),
      }, {
        makeBrain: makeFleetBrain(cfg),
      });
      return result.ok
        ? { text: `Mission ${result.missionId} started with ${args.tasks.length} Agent Task(s). Use inspect_agent_mission to read its Results.`, data: result }
        : { text: `Mission was not started: ${result.reason}`, status: "failed", data: result };
    },
  },
  {
    name: "inspect_agent_mission",
    description: "Read current Agent Task states and structured Results for one Mission, or list recent Missions when no ID is supplied.",
    schema: { missionId: z.string().optional() },
    readOnly: true,
    handler: async (args) => {
      const { swarm } = await import("../../frontier/swarm.js");
      if (!args.missionId) {
        const missions = swarm.listMissions();
        return { text: missions.length ? JSON.stringify(missions, null, 2) : "No Missions are active in this process.", data: { missions } };
      }
      const mission = swarm.getMission(args.missionId);
      return mission
        ? { text: JSON.stringify(mission, null, 2), data: { mission } }
        : { text: `Mission ${args.missionId} was not found in this process.`, status: "failed" };
    },
  },
  {
    name: "cancel_agent_mission",
    description: "Cancel a running Mission and all of its pending or active Agent Tasks.",
    schema: { missionId: z.string().min(1) },
    readOnly: false,
    handler: async (args) => {
      const { swarm } = await import("../../frontier/swarm.js");
      const cancelled = swarm.cancelMission(args.missionId);
      return cancelled
        ? { text: `Mission ${args.missionId} cancelled.` }
        : { text: `Mission ${args.missionId} is not running or was not found.`, status: "failed" };
    },
  },
  {
    name: "send_message",
    description: "Send a message to another active agent (Main or a Clone). Use this for Swarm Intelligence.",
    schema: {
      recipient: z.string().describe("The name of the recipient (e.g., 'Main' or 'Echo Clone 1')."),
      message: z.string().describe("The message content.")
    },
    readOnly: false,
    handler: async (a) => {
      const g = global as any;
      if (a.recipient.toLowerCase() === "main") {
        if (!g.__mainBrain) return { text: "Main brain not found." };
        g.__mainBrain.send(`[Message from Clone]: ${a.message}`);
        return { text: "Message sent to Main." };
      }
      const { swarm } = await import("../../frontier/swarm.js");
      if (swarm.send(a.recipient, a.message)) {
        return { text: `Message sent to ${a.recipient}.` };
      }
      return { text: `Recipient '${a.recipient}' not found.` };
    }
  },
  {
    name: "create_worktree",
    description: "Create an isolated Git worktree in a temporary directory so you can safely build or modify code without affecting the user's main working directory.",
    schema: {
      repoPath: z.string().describe("The path to the git repository."),
      branchName: z.string().describe("The name of the new branch to create.")
    },
    readOnly: false,
    handler: async (a) => {
      const { exec } = await import("node:child_process");
      const { randomUUID } = await import("node:crypto");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const worktreePath = join(tmpdir(), `echo-worktree-${randomUUID()}`);
      
      return new Promise<{ text: string }>((resolve) => {
        exec(`git worktree add -b "${a.branchName.replace(/"/g, '')}" "${worktreePath}"`, { cwd: a.repoPath }, (err, stdout, stderr) => {
          if (err) {
            resolve({ text: `Failed to create worktree: ${stderr}` });
          } else {
            resolve({ text: `Worktree created at ${worktreePath}. You can now cd into it and work safely.` });
          }
        });
      });
    }
  },
  {
    name: "schedule_task",
    description: "Schedule a task to run automatically in the future by spawning a Clone. Useful for recurring checks (cron).",
    schema: {
      intervalSeconds: z.number().describe("The number of seconds between each run."),
      goal: z.string().describe("The instruction to give the Clone when it wakes up.")
    },
    readOnly: false,
    handler: async (a) => {
      const g = global as any;
      if (!g.__activeCrons) g.__activeCrons = new Map<number, NodeJS.Timeout>();
      
      const { createBrain } = await import("../../brain/index.js");
      const { loadConfig } = await import("../../config.js");
      const cfg = loadConfig(appRoot());

      const cronId = Date.now();
      const intervalMs = Math.max(1000, a.intervalSeconds * 1000);
      
      const timer = setInterval(() => {
        const identity = {
          id: `scheduled_${cronId}_${Date.now()}`,
          name: `Echo Scheduled ${cronId}`,
          kind: "scheduled" as const,
        };
        const { brain: subBrain } = createBrain(cfg, { identity });
        subBrain.send(`[SYSTEM: CRON TRIGGER] Your recurring task is: ${a.goal}. When finished, remember to save results.`);
      }, intervalMs);
      
      g.__activeCrons.set(cronId, timer);
      return { text: `Task scheduled successfully with Cron ID: ${cronId}.` };
    }
  },
  {
    name: "update_clone_progress",
    description: "Update the progress status of this Clone in the user's HUD dashboard (e.g. 'Scraped 15/100 pages').",
    schema: {
      cloneName: z.string().describe("Your assigned clone name."),
      progress: z.string().describe("The short progress status to display.")
    },
    readOnly: false,
    handler: async (a) => {
      const { swarm } = await import("../../frontier/swarm.js");
      if (swarm.updateProgress(a.cloneName, a.progress)) {
        return { text: "Progress updated on HUD." };
      }
      return { text: "Clone not found in active list." };
    }
  },
  {
    name: "submit_agent_result",
    description:
      "Finish the current delegated Agent Task with a structured Result. A normal reply is not completion. Use completed only when verificationRefs contains direct evidence that the acceptance criteria passed; otherwise use partial, blocked, or failed and explain what remains.",
    schema: {
      status: z.enum(["completed", "partial", "blocked", "failed", "cancelled"]),
      summary: z.string().min(1).describe("Concise outcome for the parent Mission"),
      artifacts: z.array(z.object({
        kind: z.enum(["text", "file", "url", "data"]),
        label: z.string().min(1),
        value: z.string(),
      })).default([]).describe("Durable outputs produced by the Agent Task"),
      verificationRefs: z.array(z.string()).default([]).describe("Evidence references proving acceptance criteria; required for completed"),
      blockers: z.array(z.string()).default([]).describe("Anything preventing full completion"),
    },
    readOnly: false,
    handler: async (args) => {
      const invocation = currentInvocation();
      const taskId = invocation?.taskId ?? owningTaskId();
      if (!taskId || !invocation?.actorId) {
        return { text: "No active delegated Agent Task is available for a Result.", status: "failed" };
      }
      const delegated = taskCoordinator.get(taskId);
      if (!delegated?.parentTaskId?.startsWith("mission.")) {
        return { text: "Only an Agent Task inside a Mission can submit a delegated Result.", status: "failed" };
      }
      const state = taskCoordinator.submitResult(taskId, invocation.actorId, {
        status: args.status,
        summary: args.summary,
        artifacts: args.artifacts ?? [],
        verificationRefs: args.verificationRefs ?? [],
        blockers: args.blockers ?? [],
      });
      return {
        text: `Result accepted for ${taskId}: ${state.result?.status} — ${state.result?.summary}`,
        status: "success",
        verification: state.result?.status === "completed" ? "verified" : "unverified",
        data: { result: state.result },
      };
    },
  },
];
