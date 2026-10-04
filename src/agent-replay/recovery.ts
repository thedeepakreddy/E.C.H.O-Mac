import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ReplayEvent } from "./recorder.js";
import type { AgentIdentity } from "./context.js";

export type RecoveryStatus = "running" | "pending" | "completed" | "cancelled" | "exhausted";

export interface RecoveryAction {
  callId?: string;
  name: string;
  argsHash?: string;
  status: "started" | "completed" | "failed";
  at: number;
}

/** Crash-safe state copied into every attempt directory for one logical task. */
export interface RecoveryCheckpoint {
  version: 1;
  taskId: string;
  taskRevision?: number;
  privateMode?: boolean;
  scope?: Record<string, any>;
  actor: AgentIdentity;
  originalPrompt: string;
  restartable: boolean;
  followUpPrompts?: string[];
  provider?: string;
  model?: string;
  status: RecoveryStatus;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  createdAt: number;
  updatedAt: number;
  lastRunId: string;
  runDirs: string[];
  lastExitReason?: string;
  lastExitDetail?: string;
  lastAssistantText?: string;
  actions: RecoveryAction[];
}

const FILE = "checkpoint.json";

function maxAttemptsFromEnv(): number {
  const n = Number(process.env.ECHO_RECOVERY_ATTEMPTS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

export function createRecoveryCheckpoint(
  actor: AgentIdentity,
  prompt: string,
  maxRecoveryAttempts = maxAttemptsFromEnv(),
  restartable = true
): RecoveryCheckpoint {
  const now = Date.now();
  return {
    version: 1,
    taskId: randomUUID(),
    actor,
    originalPrompt: prompt,
    restartable,
    status: "running",
    recoveryAttempts: 0,
    maxRecoveryAttempts,
    createdAt: now,
    updatedAt: now,
    lastRunId: "",
    runDirs: [],
    actions: [],
  };
}

/** Atomic replace: a power loss leaves either the previous or the new JSON. */
export function writeRecoveryCheckpoint(runDir: string, checkpoint: RecoveryCheckpoint): void {
  if (!runDir || checkpoint.privateMode) return;
  checkpoint.updatedAt = Date.now();
  checkpoint.lastRunId = runDir.split("/").filter(Boolean).at(-1) ?? checkpoint.lastRunId;
  if (!checkpoint.runDirs.includes(runDir)) checkpoint.runDirs.push(runDir);
  const file = join(runDir, FILE);
  const tmp = join(runDir, `.${FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

export function readRecoveryCheckpoint(runDir: string): RecoveryCheckpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, FILE), "utf8"));
    if (parsed?.version !== 1 || typeof parsed.taskId !== "string" || !parsed.actor?.name) return null;
    return parsed as RecoveryCheckpoint;
  } catch {
    return null;
  }
}

/**
 * Return the newest durable copy of every unfinished task.
 *
 * Runs written before recovery support have no checkpoint and are deliberately
 * ignored: guessing an old prompt and replaying old side effects is unsafe.
 */
export function pendingRecoveryCheckpoints(root: string): RecoveryCheckpoint[] {
  if (!existsSync(root)) return [];
  const newest = new Map<string, RecoveryCheckpoint>();
  for (const entry of readdirSync(root)) {
    const runDir = join(root, entry);
    try {
      if (!statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const checkpoint = readRecoveryCheckpoint(runDir);
    if (!checkpoint) continue;
    const tape = loadEvents(runDir);
    const exit = [...tape].reverse().find((event) => event.type === "loop.exit");
    const end = [...tape].reverse().find((event) => event.type === "run.end");
    // run.end is fsynced before the checkpoint listener runs. If power dies in
    // that tiny gap, trust the terminal tape and do not repeat a finished task.
    if (end && exit?.reason === "completed") checkpoint.status = "completed";
    if (end && (exit?.reason === "abort_signal" || exit?.reason === "aborted")) checkpoint.status = "cancelled";
    const previous = newest.get(checkpoint.taskId);
    if (!previous || checkpoint.updatedAt > previous.updatedAt ||
      (checkpoint.updatedAt === previous.updatedAt && checkpoint.runDirs.length > previous.runDirs.length)) {
      newest.set(checkpoint.taskId, checkpoint);
    }
  }
  // A newer main command supersedes an older one even when the old journal
  // still contains a pending retry. Keep it for inspection, never wake it.
  const latestMain = new Map<string, RecoveryCheckpoint>();
  for (const item of newest.values()) if (item.actor.kind === 'main') {
    const previous = latestMain.get(item.actor.id);
    if (!previous || item.createdAt > previous.createdAt || (item.createdAt === previous.createdAt && item.updatedAt > previous.updatedAt)) latestMain.set(item.actor.id, item);
  }
  return [...newest.values()]
    .filter((item) => !item.privateMode && item.recoveryAttempts < item.maxRecoveryAttempts &&
      (item.actor.kind !== 'main' || latestMain.get(item.actor.id)?.taskId === item.taskId) &&
      item.restartable !== false && Boolean(item.originalPrompt) &&
      (item.status === "running" || item.status === "pending"))
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

function loadEvents(runDir: string): ReplayEvent[] {
  try {
    return readFileSync(join(runDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReplayEvent);
  } catch {
    return [];
  }
}

/** Build the state handoff a fresh provider session can continue from. */
export function recoveryPrompt(checkpoint: RecoveryCheckpoint): string {
  const tape = checkpoint.runDirs.flatMap(loadEvents);
  const calls = new Map<string, ReplayEvent>();
  const tapeActions: RecoveryAction[] = [];
  for (const event of tape) {
    if (event.type === "tool.call") calls.set(String(event.callId), event);
    if (event.type !== "tool.result" && event.type !== "tool.error") continue;
    const call = calls.get(String(event.callId));
    if (!call) continue;
    tapeActions.push({
      callId: String(event.callId),
      name: String(call.name ?? "unknown tool"),
      argsHash: typeof call.argsHash === "string" ? call.argsHash : undefined,
      status: event.type === "tool.error" ? "failed" : "completed",
      at: Number(event.ts ?? call.ts ?? Date.now()),
    });
  }

  const actions = checkpoint.actions.slice(-20).map((action) => ({ ...action }));
  for (const action of actions) {
    if (action.status !== "started") continue;
    const terminal = [...tapeActions].reverse().find((candidate) =>
      (action.callId ? candidate.callId === action.callId : candidate.name === action.name && candidate.at >= action.at) &&
      (!action.argsHash || !candidate.argsHash || candidate.argsHash.startsWith(action.argsHash))
    );
    if (terminal) action.status = terminal.status;
  }
  const completed = actions
    .filter((action) => action.status !== "started")
    .map((action) => `- ${action.name} (${action.status}${action.argsHash ? `, args ${action.argsHash}` : ""})`);
  const uncertain = actions
    .filter((action) => action.status === "started")
    .map((action) => `- ${action.name}${action.argsHash ? ` (args ${action.argsHash})` : ""}`);

  // The checkpoint is authoritative, but a process can die between the JSONL
  // append and the checkpoint rewrite. Fill additional final tool results from
  // the tape; a repeated line is harmless, a repeated side effect is not.
  for (const action of tapeActions.slice(-20)) {
    const line = `- ${action.name} (${action.status}${action.argsHash ? `, args ${action.argsHash.slice(0, 16)}` : ""})`;
    if (!completed.includes(line)) completed.push(line);
  }

  return `[SYSTEM: DURABLE RECOVERY CHECKPOINT]
You are ${checkpoint.actor.name}. The previous process or agent loop stopped before this task was complete. Continue the SAME task autonomously from the checkpoint below.

Original task:
${checkpoint.originalPrompt}

Follow-up instructions received during the same task:
${checkpoint.followUpPrompts?.map((text) => `- ${text}`).join("\n") || "- none"}

Last recorded assistant progress:
${checkpoint.lastAssistantText?.trim() || "No assistant text was recorded before the stop."}

Actions that reached a recorded result:
${completed.join("\n") || "- none recorded"}

Actions whose result is uncertain because recording stopped after they began:
${uncertain.join("\n") || "- none"}

Recovery rules:
1. Inspect the current screen/files/state before repeating a mutable action.
2. Treat completed actions as done unless verification proves otherwise.
3. Resolve uncertain actions by observing state; never repeat them blindly.
4. Continue from the next unfinished step. Do not ask the user to say continue.
5. Keep working until the original task is fully finished, verify it, and report completion.`;
}

/** Persistent clone numbering, derived from every checkpoint ever written. */
export function nextCloneNumber(root: string): number {
  if (!existsSync(root)) return 1;
  let highest = 0;
  for (const entry of readdirSync(root)) {
    const cp = readRecoveryCheckpoint(join(root, entry));
    const match = cp?.actor?.name?.match(/^Echo Clone (\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/**
 * Delete old run logs.
 *
 * Every run keeps its full prompt, tool arguments and results — useful for a
 * week, and nothing Echo ever cleaned up: one machine had 466 runs and 447 MB.
 * A run is removed once it is older than `keepDays` OR beyond the newest
 * `keepRuns`, unless its checkpoint says it may still be resumed, or it was
 * touched in the last hour (it may be the run in progress).
 *
 * `ECHO_LOG_KEEP_DAYS` / `ECHO_LOG_KEEP_RUNS` override the limits; 0 keeps all.
 */
export async function pruneRunLogs(
  root: string,
  opts: { keepDays?: number; keepRuns?: number; now?: number; beforeRemove?: (runDir: string) => Promise<void> } = {}
): Promise<number> {
  const envNum = (name: string) => {
    const raw = process.env[name]?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  };
  const keepDays = opts.keepDays ?? envNum("ECHO_LOG_KEEP_DAYS") ?? 14;
  const keepRuns = opts.keepRuns ?? envNum("ECHO_LOG_KEEP_RUNS") ?? 200;
  const now = opts.now ?? Date.now();
  if (!existsSync(root) || (keepDays === 0 && keepRuns === 0)) return 0;

  const runs: Array<{ dir: string; mtime: number }> = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    try {
      const info = statSync(dir);
      if (info.isDirectory()) runs.push({ dir, mtime: info.mtimeMs });
    } catch {
      /* vanished while listing */
    }
  }
  runs.sort((a, b) => b.mtime - a.mtime);

  let removed = 0;
  for (const [index, run] of runs.entries()) {
    const age = now - run.mtime;
    if (age < 3_600_000) continue;
    const tooOld = keepDays > 0 && age > keepDays * 86_400_000;
    const tooMany = keepRuns > 0 && index >= keepRuns;
    if (!tooOld && !tooMany) continue;
    const status = readRecoveryCheckpoint(run.dir)?.status;
    if (status === "running" || status === "pending") continue;
    try {
      await opts.beforeRemove?.(run.dir);
      await rm(run.dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.error(`[echo:log] could not remove ${run.dir}:`, (err as any)?.message ?? err);
    }
  }
  return removed;
}
