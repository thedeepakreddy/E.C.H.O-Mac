import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Hand-off: jobs left on the phone while the Mac was away, run when it's back.
 *
 * The phone approves each job's exact text with Face ID — the passkey signs a
 * hash of the task — and the relay only holds it. This Mac decides: it checks
 * the signature against the Face ID key the phone registered here, refuses a
 * task that's too old, edited, forged or already run, and only then runs it as
 * a normal Echo chat turn (so every safety check and approval still applies).
 * One at a time, and only while Echo is idle.
 */

export interface HandoffTask { id: string; text: string; createdAt: number; device: string }
export type HandoffStatus = "started" | "done" | "failed" | "rejected";

export const MAX_AGE_MS = 7 * 86400_000;
export const MAX_TEXT = 2000;
const TASK_ID = /^[a-f0-9-]{8,40}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;

/** What Face ID signed: the hash of exactly these fields, in this order (the phone builds the same). */
export function taskChallenge(t: HandoffTask): string {
  return createHash("sha256").update(JSON.stringify({ v: 1, id: t.id, text: t.text, createdAt: t.createdAt, device: t.device })).digest("base64url");
}

export function taskProblem(t: any, now = Date.now()): string | null {
  if (!t || typeof t.id !== "string" || !TASK_ID.test(t.id)) return "That job is malformed.";
  if (typeof t.text !== "string" || !t.text.trim() || t.text.length > MAX_TEXT) return "That job has no text.";
  if (typeof t.device !== "string" || !DEVICE_ID.test(t.device)) return "That job doesn't say which phone sent it.";
  if (!Number.isFinite(t.createdAt) || t.createdAt > now + 10 * 60_000) return "That job's time is wrong.";
  if (now - t.createdAt > MAX_AGE_MS) return "That job is more than a week old. Approve it again if you still want it.";
  return null;
}

/** Task ids this Mac has already run, so a task can never run twice. */
export class SeenTasks {
  private ids: string[] = [];
  constructor(private readonly file: string | null) {
    if (!file || !existsSync(file)) return;
    try { const v = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(v?.ids)) this.ids = v.ids.filter((x: unknown) => typeof x === "string"); } catch { /* start empty */ }
  }
  has(id: string): boolean { return this.ids.includes(id); }
  add(id: string): void {
    this.ids = [...this.ids.filter((x) => x !== id), id].slice(-500);
    if (this.file) try { writeFileSync(this.file, JSON.stringify({ ids: this.ids }), { mode: 0o600 }); } catch { /* holds for this run */ }
  }
}

export interface HandoffDeps {
  /** Waiting tasks from the relay, each with the phone's Face ID assertion. */
  list(): Promise<Array<{ task: HandoffTask; assertion: unknown }>>;
  update(id: string, status: HandoffStatus, summary?: string): Promise<void>;
  /** Throws with the reason if Face ID didn't approve exactly this task. */
  verify(task: HandoffTask, assertion: unknown): void;
  run(task: HandoffTask): Promise<{ ok: boolean; summary: string }>;
  busy(): boolean;
  seen: SeenTasks;
  log?(line: string): void;
  now?(): number;
}

/** Run what's waiting, oldest first, one at a time. Returns how many ran. Stops early if Echo is busy. */
export async function processHandoffs(deps: HandoffDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now();
  const waiting = (await deps.list()).filter((w) => w?.task).sort((a, b) => a.task.createdAt - b.task.createdAt);
  let ran = 0;
  for (const { task, assertion } of waiting) {
    if (deps.seen.has(task.id)) { await deps.update(task.id, "done", "Already done on your Mac."); continue; }
    const problem = taskProblem(task, now);
    if (problem) { await deps.update(task.id, "rejected", problem); continue; }
    try { deps.verify(task, assertion); }
    catch (e: any) {
      deps.log?.(`hand-off ${task.id} refused: ${e?.message ?? e}`);
      await deps.update(task.id, "rejected", `Face ID check failed: ${e?.message ?? e}`);
      continue;
    }
    if (deps.busy()) break;
    deps.seen.add(task.id);
    await deps.update(task.id, "started");
    deps.log?.(`hand-off ${task.id} started`);
    const result = await deps.run(task).catch((e: any) => ({ ok: false, summary: String(e?.message ?? e) }));
    await deps.update(task.id, result.ok ? "done" : "failed", result.summary.slice(0, 500));
    ran++;
  }
  return ran;
}
