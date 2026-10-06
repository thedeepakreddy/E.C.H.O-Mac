import { z } from "zod";
import { classify, bareToolName, speakable, type RiskAssessment } from "./risk.js";
import { capture } from "./snapshot.js";
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

let tsClient: TypeSafeClient | null = null;
function getTsClient() {
  if (!tsClient) tsClient = new TypeSafeClient();
  return tsClient;
}

/** Above this yes-probability, Jev's answer escalates the tier to `high`. */
const JEV_THRESHOLD = 0.5;
/**
 * One attempt, and a short one. The gate sits in front of every tool call, and
 * the SDK's own default is 10s per attempt with two retries and no total
 * budget — a sick API would stall each shell command for ~31s. Failing fast to
 * the local classifier costs nothing, because Jev can only escalate.
 */
const JEV_TIMEOUT_MS = 2500;
import { confirmations } from "./confirm.js";
import { activeConfig } from "../config.js";
import * as demo from "../frontier/demonstrate.js";
import { observeAction } from "../frontier/observe.js";
import { recordStep, captureGroundingFrame } from "../learn/trajectory.js";
import { isReplaying, recordTool, recordToolDenied, takeReplayedTool } from "../agent-replay/runtime.js";
import { agentNow } from "../agent-replay/deps.js";
import { currentLoop } from "../agent-replay/loop-log.js";
import type { ToolDef, ToolOutput } from "../tools/registry.js";
import { currentAgentRunContext } from "../agent-replay/context.js";
import { createInvocation, currentInvocation, runInInvocation } from "../memory/invocation.js";
import { taskCoordinator } from "../memory/task-state.js";
import { normalizeToolOutput } from "../memory/tool-result.js";
import { noteToolOutcome } from "../memory/consolidate.js";
import { captureAllowed } from "../memory/capture-policy.js";
import { runWithReadReuse, INTERNAL_TOOLS } from "../memory/read-cache.js";
import { toolPermitted, withToolPermissions } from './tool-permissions.js';

/**
 * The one gate every tool call goes through.
 *
 * This exists because relying on each brain to remember was not good enough,
 * and a live test proved it. Three brains had three different answers:
 *
 *   - Ollama classified and confirmed correctly.
 *   - Claude delegated to the SDK's `canUseTool`, which is NOT invoked for
 *     in-process MCP tools — so Jarvis's OWN `run_terminal_command` reached the
 *     shell without ever being classified. `rm` on a real file went through
 *     with no confirmation asked.
 *   - Gemini had no risk check of any kind.
 *
 * The classification was right the whole time; it simply was not being called.
 * That is the failure mode a shared choke point prevents: putting the check
 * inside the tool handler means a brain cannot forget it, because there is no
 * path to the handler that goes around it.
 *
 * `canUseTool` is still wired up in the Claude brain — it is the only thing
 * that sees the SDK's own built-in tools (Bash, Write, Edit) — so the two
 * layers overlap deliberately. The dedupe below stops that overlap becoming
 * two confirmation prompts for one action.
 */

export interface GateContext {
  workingDir: string;
  /** Undefined is unrestricted; an empty set grants no tools. */
  allowedTools?: ReadonlySet<string>;
  /** Lets a brain surface risk and tool events in its own shape. */
  emit?: (event: string, payload: any) => void;
}

export interface GateDecision {
  allowed: boolean;
  assessment: RiskAssessment;
  /** What to tell the model when refused. */
  message?: string;
}

/** How long an identical decision is reused, so two layers do not both ask. */
const DEDUPE_MS = 15_000;

const recent = new Map<string, { at: number; allowed: boolean }>();

function keyOf(tool: string, input: unknown, workingDir: string): string {
  let shape = "";
  try {
    shape = JSON.stringify(input ?? {});
  } catch {
    shape = String(input);
  }
  const run = currentAgentRunContext();
  // Deliberately NOT the call ID. This key identifies the ACTION — this task,
  // this actor, this tool, these arguments — because the whole purpose of the
  // dedupe is that two different code paths asking about one action ask the
  // user once. Claude's canUseTool runs before any invocation exists and
  // runGated runs inside a fresh one, so keying on the call would give them
  // different keys and the user would be asked twice for the same thing, and
  // again on every retry.
  return `${run?.taskId ?? "standalone"}:${run?.identity.id ?? "main"}:${workingDir}:${bareToolName(tool)}:${shape}`;
}

function rememberedDecision(key: string, now: number): boolean | null {
  const hit = recent.get(key);
  if (!hit) return null;
  if (now - hit.at > DEDUPE_MS) {
    recent.delete(key);
    return null;
  }
  return hit.allowed;
}

/**
 * Drop decisions past their reuse window.
 *
 * Entries were only ever removed when the same key was looked up again, and
 * almost none are — so the map held every tool call of the session. Swept on
 * write instead, which keeps it to roughly the last fifteen seconds of calls.
 */
function rememberDecision(key: string, now: number, allowed: boolean): void {
  if (recent.size > 100) {
    for (const [k, v] of recent) if (now - v.at > DEDUPE_MS) recent.delete(k);
  }
  recent.set(key, { at: now, allowed });
}

/** Forget cached decisions. Used by tests. */
export function resetGateMemory(): void {
  recent.clear();
  guiFailureStreak.clear();
  offeredDemo.clear();
}

/**
 * AGI blueprint #4: confidence-driven human-in-the-loop. Physical UI actions
 * — the ones a failure genuinely means "the click landed on the wrong thing",
 * not "the file didn't exist" — that fail repeatedly in the SAME task are the
 * signal: reusing `demonstrate.ts`'s existing recorder (the same one
 * `learn_workflow` uses) rather than inventing a second one, Echo can ask to
 * be shown rather than keep guessing. Declining just lets it keep trying.
 */
const GUI_TOOLS = new Set(["click_ui_element", "click_text", "click", "type_text", "set_value", "drag"]);
const guiFailureStreak = new Map<string, number>();
/** At most one offer per task — repeating "can you show me?" after a no is just noise. */
const offeredDemo = new Set<string>();

/** Called from executeGated once a GUI tool's outcome is known. Exported for tests, which drive it directly rather than fabricating a full AgentRunContext. */
export function noteGuiOutcome(taskId: string | undefined, tool: string, succeeded: boolean): void {
  if (!taskId || !GUI_TOOLS.has(bareToolName(tool))) return;
  if (succeeded) guiFailureStreak.delete(taskId);
  else {
    // Keyed by task and never cleared at a task's end, so bound it.
    if (guiFailureStreak.size > 200) guiFailureStreak.clear();
    guiFailureStreak.set(taskId, (guiFailureStreak.get(taskId) ?? 0) + 1);
  }
}

/**
 * Ask to be shown, once, when the same task has failed the same kind of
 * action repeatedly. Returns true if it asked and the answer means the CALLER
 * should stop and wait rather than execute — either "yes" (a demonstration is
 * about to start) or "no" (declining also ends the offer for this task, but
 * the current call still proceeds normally, so only "yes" holds it back).
 */
export async function maybeOfferDemo(toolName: string, taskId: string | undefined): Promise<boolean> {
  const cfg = activeConfig().agi.confidenceToDemo;
  if (!cfg.enabled || !taskId) return false;
  if (!GUI_TOOLS.has(bareToolName(toolName))) return false;
  if (offeredDemo.has(taskId)) return false;
  if ((guiFailureStreak.get(taskId) ?? 0) < cfg.failureThreshold) return false;
  if (demo.isRecording()) return false; // a demonstration (this or the user's own) is already under way

  if (offeredDemo.size > 200) offeredDemo.clear(); // tasks are short-lived; this only guards a very long session
  offeredDemo.add(taskId);
  const approved = await confirmations
    .request("I've tried this a couple of times without it working. Can you show me how, once?")
    .catch(() => false);
  if (!approved) return false;
  demo.startRecording(`task ${taskId}`);
  guiFailureStreak.delete(taskId);
  return true;
}

export const DENIAL_MESSAGE =
  "The user did not approve this action. Do not retry it. Explain what you were going to do and ask how they would like to proceed instead.";

/**
 * Classify an action, take a snapshot, and ask if it is dangerous.
 *
 * Does not execute anything — callers that already have a handler should use
 * runGated below. This is separated so the Claude brain's `canUseTool` can
 * share exactly the same decision.
 */
export async function decide(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GateContext,
  now = agentNow()
): Promise<GateDecision> {
  // Ahead of ordinary risk classification: a repeatedly-failing GUI action
  // isn't dangerous, it's stuck, and that's a different question.
  const askedForDemo = await maybeOfferDemo(toolName, currentAgentRunContext()?.taskId);
  if (askedForDemo) {
    return {
      allowed: false,
      assessment: { tier: "low", reason: "waiting for the user to demonstrate this" },
      message:
        "The user agreed to show you. Tell them you're watching and wait — do not retry this action yourself. " +
        "Once they say they're done, call learn_workflow with action 'finish' (a recording is already in progress) " +
        "so you can replay what they just did.",
    };
  }

  let assessment = classify(toolName, input, { workingDir: ctx.workingDir });
  const bareTool = bareToolName(toolName);

  // --- TypeSafe Jev: a second opinion that may only ESCALATE ---
  //
  // Jev is asked about the two tools whose danger lives in free text a regex
  // cannot fully read: a shell command and a button label. It is a SECOND
  // opinion, never the deciding one, and two rules keep it that way.
  //
  // It can only raise the tier. The first cut replaced `assessment` outright,
  // so a score under the threshold overwrote a curated `high` with `medium` —
  // and medium is auto-allowed further down, with no confirmation. Measured
  // against DANGEROUS_SHELL, six of eighteen known-dangerous commands came
  // back under the threshold and were downgraded, including `shutdown -h now`
  // (0.04), `truncate -s 0 <file>` (0.08) and `git reset --hard` (0.34). Echo
  // would have shut the machine down without asking. The curated list is the
  // floor; Jev may add to it and never subtract.
  //
  // And it is skipped once the local classifier already says `high`, because
  // the answer can no longer change the outcome. That keeps a ~850ms network
  // round trip — up to ~31s if the API is unwell, at 10s per attempt with two
  // retries — off the hot path of every shell command.
  if (assessment.tier !== "high") {
    const escalate = (next: RiskAssessment) => {
      assessment = { ...next, snapshot: next.snapshot ?? assessment.snapshot };
    };
    // A failure here leaves the local assessment standing, which is the safe
    // direction: the floor holds and the turn is not blocked on the network.
    const ask = async <K extends string>(state: Record<string, string>, key: K, question: string) => {
      try {
        const res = await getTsClient().systemOne(
          { state, questions: { [key]: noul(question) } },
          { timeout: JEV_TIMEOUT_MS, retry: { maxRetries: 0 } }
        );
        return (res.answers as Record<string, { noul: number }>)[key]?.noul ?? 0;
      } catch (e) {
        console.error("[gate] Jev evaluation failed (keeping the local assessment):", (e as any)?.message ?? e);
        return 0;
      }
    };

    if (bareTool === "Bash" || bareTool === "BashOutput" || bareTool === "KillShell" || bareTool === "run_terminal_command" || bareTool === "start_process") {
      const cmd = bareTool === "start_process" ? `${String(input.program)} ${JSON.stringify(input.args ?? [])}` : typeof input?.command === "string" ? input.command : (typeof input?.cmd === "string" ? input.cmd : "");
      if (cmd) {
        const p = await ask({ command: cmd }, "isDangerous",
          "Does this shell command delete files, format disks, change system settings, or send data externally?");
        if (p > JEV_THRESHOLD) {
          escalate({
            tier: "high",
            reason: `run a destructive command — ${speakable(cmd)}`,
            detail: cmd,
            snapshot: { kind: "git", target: ctx.workingDir },
          });
        }
      }
    } else if (bareTool === "click_ui_element" || bareTool === "click_text") {
      const label = typeof input?.description === "string" ? input.description : (typeof input?.text === "string" ? input.text : "");
      if (label) {
        const p = await ask({ label }, "isIrreversible",
          "Does this button label trigger an irreversible action like spending money, deleting data, confirming a purchase, or sending a message?");
        if (p > JEV_THRESHOLD) {
          escalate({ tier: "high", reason: `click "${label}" — that will take an irreversible action`, detail: label });
        }
      }
    }
  }
  const bare = bareTool;
  const key = keyOf(toolName, input, ctx.workingDir);

  // If this exact call was just decided, reuse it rather than asking twice.
  const already = rememberedDecision(key, now);
  if (already !== null) {
    return {
      allowed: already,
      assessment,
      message: already ? undefined : DENIAL_MESSAGE,
    };
  }

  ctx.emit?.("risk", { tool: bare, ...assessment });

  // Every tool call funnels through here, which makes this the one place that
  // can see the whole session. Two features hang off that: the reversible
  // journal behind "undo the last ten minutes", and the step recorder behind
  // learning a workflow by demonstration.
  try {
    if (captureAllowed()) observeAction(bare, input, assessment.reason, assessment.tier);
  } catch (err) {
    // Best-effort by design — but a journal that has silently stopped recording
    // is exactly the kind of thing that only shows up when you need it.
    console.error("[gate] observation failed:", (err as any)?.message ?? err);
  }

  if (assessment.tier !== "high") {
    // Snapshot ordinary edits too — cheap, and it makes "undo that" work for
    // the routine changes people actually want to take back.
    if (assessment.snapshot) {
      await capture(assessment.snapshot, assessment.reason).catch(() => null);
    }
    rememberDecision(key, now, true);
    return { allowed: true, assessment };
  }

  // High risk: capture state first, so approving is recoverable.
  const snap = assessment.snapshot
    ? await capture(assessment.snapshot, assessment.reason).catch(() => null)
    : null;

  const undoable = snap ? " I've taken a snapshot first." : "";
  const approved = await confirmations.request(
    `I'm about to ${assessment.reason}.${undoable} Should I go ahead?`
  );

  rememberDecision(key, now, approved);
  return {
    allowed: approved,
    assessment,
    message: approved ? undefined : DENIAL_MESSAGE,
  };
}

/**
 * Gate a tool and then run it.
 *
 * The refusal is returned as ordinary tool output rather than thrown: the model
 * needs to read what happened and respond to the user, and an exception would
 * end the turn with nothing said.
 */
export async function runGated(
  def: ToolDef,
  args: Record<string, unknown>,
  ctx: GateContext
): Promise<ToolOutput> {
  return withToolPermissions(ctx.allowedTools, () => runAuthorizedTool(def, args, ctx));
}

async function runAuthorizedTool(def: ToolDef, args: Record<string, unknown>, ctx: GateContext): Promise<ToolOutput> {
  const run = currentAgentRunContext();
  if (!toolPermitted(def.name, run?.allowedTools)) {
    const message = `This agent has no grant for ${def.name}. The tool was not executed.`;
    const denied: ToolOutput = {text: message, status: 'denied', verification: 'unverified', error: {category: 'tool_not_granted', message, retryable: false}};
    if (run && !isReplaying() && !run.loop?.hasExited) {
      try {
        const invocation = createInvocation(run.taskId, run.identity.id, def.name, args, ctx.workingDir);
        return runInInvocation(invocation, () => {
          taskCoordinator.startCall(invocation, def.name, 'internal');
          recordToolDenied(def.name, args, message);
          ctx.emit?.('tool', {name: def.name, summary: message});
          const output = {...denied, callId: invocation.callId, taskId: run.taskId};
          taskCoordinator.endCall(invocation, output);
          return output;
        });
      } catch { /* A stopped task still receives the same refusal. */ }
    }
    recordToolDenied(def.name, args, message);
    ctx.emit?.('tool', {name: def.name, summary: message});
    return denied;
  }
  // Resolve names before risk assessment and resource leasing, so aliases and
  // UUIDs cannot acquire separate locks for the same coding project.
  if (typeof args.projectId === 'string' && Object.hasOwn(def.schema, 'projectId')) {
    const {CODING_TOOL_NAMES} = await import('../coding/tool-selection.js');
    if (CODING_TOOL_NAMES.includes(def.name)) {
      try { const {resolveProjectId} = await import('../coding/session.js'); args = {...args, projectId:resolveProjectId(args.projectId)}; }
      catch (error:any) {return {status:'failed',verification:'unverified',text:error.message};}
    }
  }
  if (!run || isReplaying()) return executeGated(def, args, ctx);
  if (run.loop?.hasExited) return {status: 'cancelled', text: 'The task has stopped; this action was not attempted.', error: {category: 'task_stopped', message: 'No tool may start after the task exits', retryable: false}};
  let invocation;
  try { invocation = createInvocation(run.taskId, run.identity.id, def.name, args, ctx.workingDir); }
  catch (error: any) { return { text: error.message, status: "cancelled", error: { category: "task_unavailable", message: error.message } }; }
  return runInInvocation(invocation, async () => {
    taskCoordinator.startCall(invocation, def.name, INTERNAL_TOOLS.has(def.name) ? 'internal' : def.readOnly ? 'observation' : 'action');
    const lease = taskCoordinator.acquireResources(invocation);
    let out: ToolOutput;
    if (!lease.ok) {
      const holder = taskCoordinator.resourceState()[lease.resource!];
      const detail = lease.quarantined
        ? `An interrupted action holds an internal safety lock (task ${holder?.taskId}, call ${holder?.callId}). The action was not attempted. This is not a macOS permission error. Recovery requires checking the interrupted action and explicitly reconciling its resource; restarting alone will not clear it.`
        : "Another task currently holds this resource. The action was not attempted.";
      out = { text: `Resource ${lease.resource} is ${lease.quarantined ? "awaiting reconciliation after an uncertain action" : "being used by another task"}. ${detail}`, status: "denied", error: { category: "resource_contention", message: lease.quarantined ? "Interrupted action requires resource reconciliation" : "Resource is busy", retryable: !lease.quarantined } };
    } else {
      try { out = await executeGated(def, args, ctx); }
      catch (error: any) { out = { text: String(error.message ?? error), status: "failed", error: { category: "execution_error", message: String(error.message ?? error) } }; }
    }
    out = { ...normalizeToolOutput(out), callId: invocation.callId, taskId: invocation.taskId };
    taskCoordinator.endCall(invocation, { ...out, image: undefined } as any);
    taskCoordinator.releaseResources(invocation, out.status === "timeout" || out.status === "uncertain");
    if (!run.privateMode && run.identity.kind !== "rehearsal") {
      try { noteToolOutcome({ tool: def.name, taskId: run.taskId, callId: invocation.callId, scope: run.scope as any, status: out.status!, verified: out.verification === "verified", durationMs: out.durationMs, errorCategory: out.error?.category, origin: "real" }); } catch (error) { console.error("[memory] tool outcome recording failed", error); }
    }
    return out;
  });
}


/**
 * Check a call against the schema the model was actually given.
 *
 * Every tool carries a Zod shape, and all three brains turn it into JSON Schema
 * to show the model what to send — but nothing ever checked what came back.
 * Malformed arguments went straight into the handler, so a missing field
 * surfaced to the model as whatever the handler happened to throw: "Cannot read
 * properties of undefined (reading 'x')". That names a line of Echo's source,
 * not the mistake, so the model has nothing to correct and usually repeats the
 * same call.
 *
 * Rejecting here instead means no handler runs, nothing is touched, and the
 * model gets back the field that was wrong, what was expected, and the shape it
 * should have used — which is enough to fix it on the next call rather than
 * burning iterations guessing.
 */
/** Closest accepted argument name, when one is close enough to be meant. */
function nearestKey(given: string, known: string[]): string | null {
  const a = given.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of known) {
    const b = candidate.toLowerCase();
    const rows = [Array.from({ length: b.length + 1 }, (_, i) => i)];
    for (let i = 1; i <= a.length; i++) {
      rows[i] = [i];
      for (let j = 1; j <= b.length; j++) {
        rows[i][j] = Math.min(
          rows[i - 1][j] + 1,
          rows[i][j - 1] + 1,
          rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    const score = rows[a.length][b.length];
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  // Only a genuinely near miss; an unrelated name suggested confidently is worse
  // than no suggestion, because the model will take it.
  return best !== null && bestScore <= Math.max(2, Math.floor(best.length / 3)) ? best : null;
}

const schemaCache = new Map<string, { json: any; text: string }>();

function acceptedArguments(def: ToolDef): { json: any; text: string } {
  const cached = schemaCache.get(def.name);
  if (cached) return cached;
  let json: any = { properties: {}, required: [] };
  try {
    json = z.toJSONSchema(z.object(def.schema), { io: "input" });
  } catch {
    /* an untypable schema must never be the reason a tool cannot run */
  }
  const props = json?.properties ?? {};
  const required: string[] = json?.required ?? [];
  const names = Object.keys(props);
  const text = names.length
    ? names
        .map((key) => {
          const kind = props[key]?.type ?? props[key]?.anyOf?.map((v: any) => v.type).join("|") ?? "value";
          return `${key} (${kind}${required.includes(key) ? ", required" : ", optional"})`;
        })
        .join(", ")
    : "none — call it with no arguments";
  const entry = { json, text };
  schemaCache.set(def.name, entry);
  return entry;
}

function validateArguments(def: ToolDef, args: Record<string, unknown>): ToolOutput | null {
  if (def.validateInput) {
    let detail: string | null;
    try { detail = def.validateInput(args); }
    catch (error) { detail = `Input validation unavailable: ${String(error)}`; }
    if (detail) {
      const message = `${def.name}: ${detail}. Nothing was executed; correct the tool arguments.`;
      return {text: message, status: 'failed', verification: 'unverified', error: {category: 'invalid_arguments', message, retryable: true}};
    }
    return null;
  }
  // An empty shape means the tool declares no arguments to check. MCP tools are
  // wrapped that way on purpose: their server owns validation, not Echo.
  if (!def.schema || Object.keys(def.schema).length === 0) return null;
  let result: { success: boolean; error?: any };
  try {
    result = z.object(def.schema).safeParse(args ?? {});
  } catch {
    return null;
  }
  const known = new Set(Object.keys(def.schema));
  const unknown = Object.keys(args ?? {}).filter((key) => !known.has(key));
  // Zod ignores unknown keys, so an invented parameter name is silently dropped
  // and the tool runs on nothing. Naming it is usually the whole fix: the model
  // reached for a plausible synonym and needs to be told the real one.
  if (result.success && unknown.length === 0) return null;

  const issues = (result.error?.issues ?? []).slice(0, 6).map((issue: any) => {
    const where = Array.isArray(issue.path) && issue.path.length ? issue.path.join(".") : "(root)";
    return `  \u2022 ${where}: ${issue.message}`;
  });
  for (const key of unknown.slice(0, 4)) {
    const near = nearestKey(key, [...known]);
    issues.push(`  \u2022 ${key}: not an argument of this tool${near ? ` — did you mean "${near}"?` : ""}`);
  }
  const accepted = acceptedArguments(def).text;
  const message =
    `${bareToolName(def.name)} was not called correctly, so nothing was run.\n` +
    `${issues.join("\n")}\n` +
    `Accepted arguments: ${accepted}\n` +
    `Fix the arguments and call it again.`;
  return {
    text: message,
    status: "failed",
    verification: "unverified",
    error: { category: "invalid_arguments", message, retryable: true },
  };
}

async function executeGated(def: ToolDef, args: Record<string, unknown>, ctx: GateContext): Promise<ToolOutput> {
  // Replay is a hard side-effect boundary. It comes before risk assessment,
  // snapshots, observation, and grounding screenshots so a replay cannot send
  // a confirmation, touch the screen, or mutate a journal entry.
  // Instrumented here rather than in each loop, for the same reason the risk
  // check is: this is the only path to a handler, so no brain can omit it — and
  // Claude, whose loop lives inside the SDK, gets identical tool telemetry to
  // the two loops Echo owns.
  //
  // Above the replay branch, not below it, so a replayed run emits the same
  // events in the same order as the run it is replaying. Below, the live path
  // recorded a `tool.start` the replay had no way to produce, and verification
  // read that as the agent having diverged.
  const log = currentLoop();
  const callId = log?.toolStart(def.name, args ?? {}, currentInvocation()?.callId);
  const toolStartedAt = Date.now();
  let toolFailed = false;
  let toolDetail: string | undefined;
  const finishTool = () => {
    if (callId) log?.toolEnd(callId, def.name, toolStartedAt, toolFailed, toolDetail);
  };

  if (isReplaying()) {
    // Preserve the same observable agent-loop event ordering while serving the
    // cassette. The handler itself is still never reached.
    // Classification is pure; snapshots, confirmations, observation and the
    // handler remain below the replay boundary. Re-emitting it keeps the audit
    // tape faithful without creating a side effect.
    agentNow();
    const assessment = classify(def.name, args ?? {}, { workingDir: ctx.workingDir });
    ctx.emit?.("tool", { name: def.name, summary: bareToolName(def.name) });
    ctx.emit?.("risk", { tool: bareToolName(def.name), ...assessment });
    const replayed = await takeReplayedTool<ToolOutput>(def.name, args ?? {}, true);
    if (replayed.handled) {
      // Deliberately no extra detail: a replayed run has to emit exactly what
      // the run it replays emitted, or verification reads the annotation itself
      // as the agent behaving differently.
      finishTool();
      return replayed.value ?? {};
    }
  }

  ctx.emit?.("tool", { name: def.name, summary: bareToolName(def.name) });

  // Before the risk decision: there is no sense asking the user to approve an
  // action whose arguments cannot describe a real action.
  const invalid = validateArguments(def, args);
  if (invalid) {
    toolFailed = true;
    toolDetail = "arguments rejected by the tool's own schema";
    finishTool();
    return { ...invalid, durationMs: Date.now() - toolStartedAt };
  }

  const decision = await decide(def.name, args ?? {}, ctx);
  const bare = bareToolName(def.name);

  // Capture the call as training data. This is the same argument as the gate
  // itself: put it on the one path to the handler and no brain can omit it.
  // Every call is wrapped so a logging fault can never break a real action.
  const learn = (
    resultText: string,
    image: ToolOutput["image"] | null,
    succeeded = true
  ) => {
    try {
      recordStep({
        tool: bare,
        args: args ?? {},
        tier: decision.assessment.tier,
        reason: decision.assessment.reason,
        allowed: decision.allowed,
        resultText,
        image: image ? { data: image.data, mimeType: image.mimeType } : null,
        succeeded,
      });
    } catch (err) {
      console.error("[gate] step recorder failed:", (err as any)?.message ?? err);
    }
  };

  if (!decision.allowed) {
    const refused = decision.message ?? DENIAL_MESSAGE;
    // A refusal is worth keeping: it is a labelled example of what NOT to do.
    learn(refused, null);
    recordToolDenied(def.name, args ?? {}, refused);
    toolDetail = "denied by the risk gate";
    finishTool();
    return { text: refused, status: "denied", verification: "unverified", error: { category: "approval_denied", message: refused } };
  }
  try {
    // For a pointer action, grab the screen it is aimed at BEFORE it fires —
    // this is what turns a click into a grounding example. No-op unless learning
    // is on, and best-effort, so it can never delay or break the action.
    if (currentInvocation()) taskCoordinator.assertInvocation(currentInvocation()!);
    if (captureAllowed()) await captureGroundingFrame(bare);
    const out = await recordTool(def.name, args ?? {}, () => runWithReadReuse(currentAgentRunContext(), def, args ?? {},
      currentInvocation()?.callId, async () => normalizeToolOutput(await def.handler(args ?? {}))));
    toolFailed = out.status !== "success";
    toolDetail = out.error?.message;
    learn(out.text ?? "", out.image ?? null, out.status === "success");
    noteGuiOutcome(currentAgentRunContext()?.taskId, def.name, out.status === "success");
    finishTool();
    return { ...out, durationMs: Date.now() - toolStartedAt };
  } catch (err: any) {
    toolFailed = true;
    toolDetail = String(err?.message ?? err);
    finishTool();
    const failed: ToolOutput = { text: `${def.name} failed: ${err?.message ?? err}`, status: /timed? out|timeout/i.test(toolDetail) ? "timeout" : "failed", verification: "unverified", durationMs: Date.now() - toolStartedAt, error: { category: /timed? out|timeout/i.test(toolDetail) ? "timeout" : "execution_error", message: toolDetail } };
    // This is a real failed action even though the error is returned to the
    // brain as normal tool output. The trajectory must not later be promoted
    // to a successful demonstration by the turn-end event.
    learn(failed.text ?? "", null, false);
    noteGuiOutcome(currentAgentRunContext()?.taskId, def.name, false);
    return failed;
  }
}
