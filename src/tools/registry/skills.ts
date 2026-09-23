/** Things Echo learns to repeat: skills, recorded workflows, voice shortcuts and routines. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef, ToolOutput } from "../registry.js";
import { TOOLS } from "../registry.js";
import { z } from "zod";
import { normalizeToolOutput } from "../../memory/tool-result.js";
import { dataRoot } from "../../memory/paths.js";
import { owningTaskId } from "../../frontier/task-handoff.js";
import * as system from "../system.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as narrate from "../../frontier/narrate.js";
import * as demo from "../../frontier/demonstrate.js";
import { replay as replayWorkflow } from "../../frontier/replay.js";
import * as journal from "../../frontier/journal.js";
import { minePatterns } from "../../frontier/watchers.js";
import { appRoot, memoryScope } from "./shared.js";

export const SKILL_TOOLS: ToolDef[] = [
  {
    name: "create_skill",
    description:
      "Teach yourself a new reusable skill by chaining tools you ALREADY have. Use this when the user describes a repeatable multi-step task ('make a skill that opens Mail, waits, and reads the screen'). Provide a name and an ordered list of steps, each naming an existing tool and its arguments. A skill is saved data, not code — it can only combine tools you already have.",
    schema: {
      name: z.string().describe("A short name for the skill."),
      description: z.string().optional().describe("What the skill does, in one line."),
      steps: z
        .array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() }))
        .describe("Ordered steps. Each 'tool' MUST be the name of an existing tool."),
    },
    readOnly: false,
    handler: async (a) => {
      const { validateSkill, saveSkill, getSkill } = await import("../../frontier/skills.js");
      const known = new Set(TOOLS.map((t) => t.name));
      const res = validateSkill(a, known);
      if (!res.ok) return { status: "failed", verification: "unverified", error: { category: "invalid_arguments", message: res.errors.join("; ") },
        text: `I couldn't create that skill:\n${res.errors.map((e) => `• ${e}`).join("\n")}` };
      saveSkill(res.skill, dataRoot());
      // A skill the user taught is a procedure they authorised, so it is active
      // immediately. One Echo proposed for itself would be a candidate until it
      // had actually worked several times — see noteProcedureRun.
      const stored = getSkill(res.skill.name, dataRoot()) ?? res.skill;
      try {
        const { recordProcedure } = await import("../../memory/consolidate.js");
        recordProcedure({
          procedureId: stored.procedureId, version: stored.version, name: stored.name,
          description: stored.description || stored.name, steps: stored.steps,
          scope: await memoryScope(), taskId: owningTaskId(), taughtByUser: true,
        });
      } catch (error) { console.error("[memory] procedure not recorded", error); }
      return { text: `Learned the skill "${stored.name}" (${stored.steps.length} steps)${stored.version > 1 ? `, now version ${stored.version}` : ""}. Say "run the ${stored.name} skill" any time.` };
    },
  },
  {
    name: "list_skills",
    description: "List the skills the user has taught Echo. Use when they ask what skills or custom abilities you have.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const { loadSkills, describeSkills } = await import("../../frontier/skills.js");
      return { text: describeSkills(loadSkills(dataRoot())) };
    },
  },
  {
    name: "run_skill",
    description: "Run a skill the user previously taught you, by name. Each step runs as its own tool, so anything irreversible still asks for confirmation as usual.",
    schema: { name: z.string().describe("The skill's name.") },
    readOnly: false,
    handler: async (a) => {
      const { getSkill, screenPlan } = await import("../../frontier/skills.js");
      const { classify } = await import("../../safety/risk.js");
      const skill = getSkill(a.name, dataRoot());
      if (!skill) return { text: `I don't have a skill called "${a.name}". Ask me to list your skills.` };

      // Screen the plan: any high-risk step means Echo hands the plan back to be
      // run step by step (with the usual confirmations) rather than auto-running
      // something irreversible in a batch.
      const screen = screenPlan(skill, (tool, args) => classify(tool, args, { workingDir: appRoot() }).tier);
      const plan = skill.steps.map((s, i) => `${i + 1}. ${s.tool}${Object.keys(s.args ?? {}).length ? " " + JSON.stringify(s.args) : ""}`).join("\n");
      if (!screen.autoRunnable) {
        return { text: `The "${skill.name}" skill includes step(s) ${screen.highSteps.join(", ")} that change things, so I'll run it with you step by step. Plan:\n${plan}` };
      }

      const { runGated } = await import("../../safety/gate.js");
      const results: Array<{ step: number; tool: string; result: ToolOutput }> = [];
      for (const [index, step] of skill.steps.entries()) {
        const tool = TOOLS.find((t) => t.name === step.tool);
        if (!tool || tool.name === "run_skill") {
          return { status: results.length ? "partial" : "failed", verification: "unverified", data: { results },
            text: `The "${skill.name}" skill stopped at step ${index + 1}: ${tool ? "recursive skills are not allowed" : `tool ${step.tool} is unavailable`}.` };
        }
        try {
          const args = z.object(tool.schema).parse(step.args ?? {});
          const result = normalizeToolOutput(await runGated(tool, args, { workingDir: appRoot() }));
          results.push({ step: index + 1, tool: step.tool, result });
          if (result.status !== "success") {
            return { status: results.length > 1 ? "partial" : result.status, verification: "unverified", data: { results },
              text: `The "${skill.name}" skill stopped at step ${index + 1}: ${result.text ?? result.error?.message ?? result.status}.` };
          }
        } catch (error: any) {
          return { status: results.length ? "partial" : "failed", verification: "unverified", data: { results },
            error: { category: "tool_error", message: String(error?.message ?? error) },
            text: `The "${skill.name}" skill stopped at ${step.tool}: ${error?.message ?? error}` };
        }
      }
      try {
        const { noteProcedureRun } = await import("../../memory/consolidate.js");
        // Every step returned success, but no postcondition has been checked —
        // that is exactly the distinction the report is about, so this run does
        // NOT yet count towards trusting the workflow. verify_task is what
        // turns it into one that does.
        noteProcedureRun({ procedureId: skill.procedureId, version: skill.version, scope: await memoryScope(), taskId: owningTaskId(), verified: false, origin: "real" });
      } catch (error) { console.error("[memory] procedure run not recorded", error); }
      return { status: "success", verification: "unverified", data: { results, procedureId: skill.procedureId, version: skill.version },
        text: `Ran every step of the "${skill.name}" skill (${skill.steps.length} steps) without error. That is not proof it worked — call verify_task with what should now be true before telling the user it is done.` };
    },
  },
  {
    name: "manage_shortcuts",
    description: "Manage local voice shortcuts that bypass the AI API to save limits. Use this when the user asks you to memorize a command, create a shortcut, or learn an action so it runs instantly next time.",
    schema: {
      action: z.enum(["add", "remove", "list"]).describe("Action to perform"),
      phrase: z.string().optional().describe("The exact voice phrase to trigger the shortcut (e.g., 'open youtube' or 'play * on youtube')"),
      command: z.string().optional().describe("The bash/cli command to execute (e.g., 'open https://youtube.com'). Use $1 for the wildcard variable."),
      reply: z.string().optional().describe("What Jarvis should say out loud when triggered (e.g., 'Opening YouTube.')"),
    },
    readOnly: false,
    handler: async (a) => {
      const shortcutsPath = join(appRoot(), "shortcuts.json");
      let shortcuts: Record<string, any> = {};
      if (existsSync(shortcutsPath)) {
        try {
          shortcuts = JSON.parse(readFileSync(shortcutsPath, "utf8"));
        } catch (e) {
          /* ignore parse errors */
        }
      }

      if (a.action === "list") {
        const keys = Object.keys(shortcuts);
        if (keys.length === 0) return { text: "No shortcuts exist." };
        return { text: `Shortcuts: ${keys.join(", ")}` };
      }

      if (a.action === "remove") {
        if (!a.phrase) return { text: "You must provide a phrase to remove." };
        if (!shortcuts[a.phrase]) return { text: `Shortcut '${a.phrase}' not found.` };
        delete shortcuts[a.phrase];
        writeFileSync(shortcutsPath, JSON.stringify(shortcuts, null, 2), "utf8");
        return { text: `Removed shortcut: ${a.phrase}` };
      }

      if (a.action === "add") {
        if (!a.phrase || !a.command || !a.reply) {
          return { text: "You must provide a phrase, a bash command, and a spoken reply to add a shortcut." };
        }
        shortcuts[a.phrase.toLowerCase()] = { command: a.command, reply: a.reply };
        writeFileSync(shortcutsPath, JSON.stringify(shortcuts, null, 2), "utf8");
        return { text: `Added shortcut: '${a.phrase}' -> runs '${a.command}' and says '${a.reply}'` };
      }
      
      return { text: "Invalid action." };
    },
  },
  {
    name: "create_jarvis_tool",
    description: "Deprecated and disabled. To give Echo a new ability, use create_skill, which safely chains tools Echo already has instead of writing and running new code.",
    schema: {
      toolCodeString: z.string().optional().describe("Ignored."),
    },
    readOnly: true,
    handler: async () => {
      // Writing new code into the app's own source and rebuilding/rebooting is
      // arbitrary code execution and cannot work in a signed, packaged app.
      // Retired in favour of create_skill (safe composition of existing tools).
      return {
        text: "That unsafe self-programming path is disabled. Use create_skill instead — it lets me learn a new ability by chaining tools I already have, with no code generation.",
      };
    },
  },
  {
    name: "run_shortcut",
    description:
      "Run one of the user's Apple Shortcuts by describing it. This is how you control smart-home devices (lights, locks, thermostat via HomeKit), send Messages, set Reminders, toggle Focus modes, and anything else they have built in the Shortcuts app. Call list_shortcuts first if unsure what exists.",
    schema: {
      name: z.string().describe("The shortcut to run, by name or description"),
      input: z.string().optional().describe("Optional text to pass into the shortcut"),
    },
    readOnly: false,
    handler: async (a) => {
      const match = await system.findShortcut(a.name);
      if (!match) {
        const have = await system.listShortcuts();
        return { text: `No shortcut matches "${a.name}". Available: ${have.slice(0, 15).join(", ") || "none"}.` };
      }
      const r = await system.runShortcut(match, a.input);
      return { text: r.output };
    },
  },
  {
    name: "list_shortcuts",
    description: "List the Apple Shortcuts the user has installed, so you know what smart-home and system actions are available.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const s = await system.listShortcuts();
      return { text: s.length ? `Shortcuts available: ${s.join(", ")}` : "No Apple Shortcuts are installed." };
    },
  },
  {
    name: "learn_workflow",
    description:
      "Start or finish learning a task by watching the user do it. Use action 'start' with a name when they say 'watch what I'm doing', and 'finish' when they say they are done. Steps are remembered by the LABELS of what was clicked, so the workflow survives the app moving its buttons.",
    schema: {
      action: z.enum(["start", "finish", "cancel"]),
      name: z.string().default("").describe("What to call this workflow"),
    },
    readOnly: false,
    handler: async (a) => {
      if (a.action === "start") {
        demo.startRecording(a.name || "untitled");
        return { text: "Watching. Do the task, then tell me you're done." };
      }
      if (a.action === "cancel") {
        demo.cancelRecording();
        return { text: "Stopped watching; nothing saved." };
      }
      const wf = demo.finishRecording();
      return {
        text: wf
          ? `Learned "${wf.name}" — ${wf.steps.length} steps. Say "do ${wf.name}" to run it.`
          : "I didn't capture any steps.",
      };
    },
  },
  {
    name: "run_workflow",
    description:
      "Replay a workflow learned earlier. Each control is re-found by meaning at replay time, so it survives layout changes; it stops and reports rather than clicking the wrong thing.",
    schema: {
      name: z.string().describe("Which workflow to run"),
      values: z.record(z.string(), z.string()).default({}).describe("Values for any parameters"),
    },
    readOnly: false,
    handler: async (a) => {
      const wf = demo.load(a.name);
      if (!wf) return { text: `I don't know a workflow called "${a.name}". Known: ${demo.list().join(", ") || "none yet"}.` };
      const steps = demo.bind(wf.steps, a.values ?? {});
      const report = await replayWorkflow(wf, steps);
      return { text: report.summary };
    },
  },
  {
    name: "preview_workflow",
    description:
      "Show what a workflow WOULD do without doing it. Every control is resolved and highlighted on screen, but nothing is clicked, typed or pressed. Use this when the user asks what a workflow would do, wants to check one before running it, or says 'show me first' / 'dry run'. Also use it proactively before running a workflow that sends, deletes, buys or submits anything.",
    schema: {
      name: z.string().describe("Which workflow to preview"),
      values: z.record(z.string(), z.string()).default({}).describe("Values for any parameters"),
    },
    readOnly: true,
    handler: async (a) => {
      const wf = demo.load(a.name);
      if (!wf) return { text: `I don't know a workflow called "${a.name}". Known: ${demo.list().join(", ") || "none yet"}.` };
      const steps = demo.bind(wf.steps, a.values ?? {});

      const report = await replayWorkflow(wf, steps, {
        dryRun: true,
        // Draw the brackets around each control as it resolves, so the preview
        // is watchable rather than a wall of text at the end.
        onStep: (r, i) => {
          narrate.feed({ line: `${i + 1}. ${r.note}`, kind: r.ok ? "" : "warn" });
          if (r.at) narrate.feed({ target: { x: r.at.x - 40, y: r.at.y - 16, w: 80, h: 32 } });
        },
      });
      return { text: report.summary };
    },
  },
  {
    name: "list_workflows",
    description: "List workflows learned by demonstration, or describe one in detail.",
    schema: { name: z.string().default("").describe("Optional: describe just this one") },
    readOnly: true,
    handler: async (a) => {
      if (a.name) {
        const wf = demo.load(a.name);
        return { text: wf ? demo.describe(wf) : `No workflow called "${a.name}".` };
      }
      const names = demo.list();
      return { text: names.length ? `Learned workflows: ${names.join(", ")}` : "I haven't learned any workflows yet." };
    },
  },
  {
    name: "find_routines",
    description: "Look for repeated patterns worth offering to automate — an action that reliably follows another.",
    schema: {},
    readOnly: true,
    handler: async () => {
      const entries = journal.all().map((e) => ({ action: e.what.split(" ")[0], at: e.at }));
      const found = minePatterns(entries);
      return {
        text: found.length
          ? found.slice(0, 5).map((p) => `After "${p.trigger}" you usually "${p.followUp}" (${p.count}x, ${Math.round(p.confidence * 100)}% of the time)`).join("\n")
          : "I haven't seen enough repetition yet to spot a routine.",
      };
    },
  },
  {
    name: 'predict_next_command',
    description: "Suggest what the user is likely to do next, learned only from the commands they've given Echo before (no keylogging). Use to complete a half-typed command or anticipate the next one. Returns suggestions only — it never runs anything on its own.",
    schema: {
      prefix: z.string().optional().describe("A half-typed command to complete."),
      after: z.string().optional().describe("A command just given, to predict what usually follows it."),
    },
    readOnly: true,
    handler: async (a) => {
      const { prefetch } = await import("../../brain/prefetch.js");
      const out = a.prefix ? prefetch.complete(a.prefix) : a.after ? prefetch.predictNext(a.after) : [];
      return { text: out.length ? `You often follow with:\n${out.map((c) => `• ${c}`).join("\n")}` : "No confident prediction yet." };
    }
  },
];
