import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync, constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { NVIDIA_KEY_SHAPE, REDACTED } from '../safety/redact.js';
import { accountDiagnosticWrite, checkDiagnosticWrite, validateDiagnosticPath, reserveDiagnosticSpace, directoryBytes, REPLAY_BUDGET, StorageBudgetError, type DiagnosticOptions } from '../diagnostics/storage-budget.js';

export interface ReplayStorageOptions extends DiagnosticOptions {
  eventBytes?: number; blobBytes?: number; singleBlobBytes?: number; eventCount?: number;
  terminalReserveBytes?: number; terminalEventBytes?: number;
}

/**
 * Why a run stopped.
 *
 * A closed union on purpose: every `break`, `return` and `throw` that can end
 * the loop has to name one of these, so "the run just ended" stops being a
 * possible outcome. `unknown_fallthrough` is the default, and seeing it in a log
 * means a path was missed rather than that the cause is mysterious.
 *
 * The first four names are kept for recordings written before this widened, so
 * an old trace still loads in the inspector.
 */
export type ExitReason =
  | "completed"
  | "no_progress"
  | "max_iterations"
  | "model_stop_no_tool_call"
  | "abort_signal"
  | "tool_error"
  | "provider_error"
  | "rate_limit_429"
  | "context_overflow"
  | "stream_closed"
  | "unknown_fallthrough"
  // Pre-existing names, still read by the inspector for older runs.
  | "error"
  | "aborted"
  | "unknown";

/** Exit reasons that mean the task did NOT finish, whatever the model said. */
export const INCOMPLETE_EXITS: ReadonlySet<string> = new Set([
  "no_progress",
  "max_iterations",
  "model_stop_no_tool_call",
  "abort_signal",
  "tool_error",
  "provider_error",
  "rate_limit_429",
  "context_overflow",
  "stream_closed",
  "unknown_fallthrough",
  "error",
  "aborted",
  "unknown",
]);

/** Payloads at or above this many bytes are spilled to blobs/ and referenced. */
export const BLOB_THRESHOLD_BYTES = 32 * 1024;

export type ReplayEvent = {
  seq: number;
  ts: number;
  mono: number;
  runId: string;
  type: string;
  [key: string]: unknown;
};

export type Redactor = (path: string, value: unknown) => unknown;

/**
 * Redact before bytes touch the replay directory, never while rendering them.
 *
 * A bare `token` here also matched `totalContextTokens` and `promptTokens`, so
 * the telemetry that diagnoses a context overflow was being redacted as if it
 * were a credential. "token" only implies a secret when it is the whole field
 * name or is qualified by one (access, refresh, bearer, session…) — a count is
 * never sensitive.
 */
export const defaultRedactor: Redactor = (path, value) =>
  /api[-_]?key|authorization|password|secret|cookie|credential|(^|[^A-Za-z])(access|refresh|bearer|auth|session|id|api)[-_]?token|\.tokens?$/i.test(path)
    ? "[REDACTED]"
    : typeof value === 'string' ? value.replace(NVIDIA_KEY_SHAPE, REDACTED) : value;

export function stableJson(value: unknown, redact: Redactor = defaultRedactor, path = "$"): string {
  const visit = (current: unknown, currentPath: string): unknown => {
    const redacted = redact(currentPath, current);
    if (redacted !== current) return redacted;
    if (Array.isArray(current)) return current.map((item, i) => visit(item, `${currentPath}[${i}]`));
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, visit(item, `${currentPath}.${key}`)])
      );
    }
    return current;
  };
  return JSON.stringify(visit(value, path));
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * An append-only per-turn recorder. Critical terminal events are synchronously
 * appended and fsynced, so a hard crash still leaves the explanation behind.
 */
export class Recorder {
  readonly runId: string;
  readonly dir: string;
  private seq = 0;
  private readonly started = performance.now();
  private closed = false;
  private eventCount = 0;
  private blobBytes = 0;
  private storageFailure: StorageBudgetError | null = null;
  private readonly terminals = new Set<string>();
  private readonly budget: { [K in keyof typeof REPLAY_BUDGET]: number } & DiagnosticOptions;
  private readonly releaseReservation: () => void;

  // `runId: string`, not the UUID template type randomUUID() infers: a caller
  // may supply a readable id, and a run's identity is not required to be a UUID.
  constructor(private readonly rootDir: string, runId: string = randomUUID(), private readonly redact: Redactor = defaultRedactor, options: ReplayStorageOptions = {}) {
    this.budget = { ...REPLAY_BUDGET, ...options };
    const b = this.budget;
    if (!Object.values({ eventBytes:b.eventBytes, blobBytes:b.blobBytes, singleBlobBytes:b.singleBlobBytes, eventCount:b.eventCount, terminalReserveBytes:b.terminalReserveBytes, terminalEventBytes:b.terminalEventBytes }).every(n => Number.isSafeInteger(n) && n > 0) || b.terminalReserveBytes < 3*b.terminalEventBytes || b.eventBytes <= b.terminalReserveBytes) throw new StorageBudgetError('invalid-replay-limit');
    // Existing run names are readable basenames (including spaces/Unicode).
    // Preserve their exact identity; only path syntax can escape this store.
    if (typeof runId !== 'string' || !runId || runId === '.' || runId === '..' || /[/\\\0]/.test(runId)) throw new StorageBudgetError('unsafe-run-path');
    this.runId = runId;
    this.dir = join(rootDir, runId);
    validateDiagnosticPath(rootDir, join(this.dir, 'blobs'));
    try {
      const reservation = reserveDiagnosticSpace(rootDir, join(this.dir, 'events.jsonl'), b.terminalReserveBytes, { ...options, fileBytes: b.eventBytes });
      this.releaseReservation = reservation.release;
      this.budget.reservationOwner = reservation.owner;
      try {
        mkdirSync(join(this.dir, "blobs"), { recursive: true });
        this.blobBytes = directoryBytes(join(this.dir, 'blobs'), options);
      } catch (error) { this.releaseReservation(); throw error; }
    } catch (error) { (options.warn ?? console.warn)('[storage] Replay admission stopped; terminal capacity could not be reserved. Manually archive diagnostics before retrying.'); throw error; }
  }

  /**
   * Spill any oversized field to blobs/ and leave a reference behind.
   *
   * The messages array is re-sent whole on every iteration, so writing it inline
   * would make the file grow quadratically with the run and the interesting last
   * lines would be buried under megabytes of repeated context.
   */
  private spill(event: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (value === undefined) continue;
      const redacted = this.redact(`$.${key}`, value);
      if (redacted !== value) { out[key] = redacted; continue; }
      if (value === null || typeof value !== "object") {
        out[key] = value;
        continue;
      }
      let json: string;
      try {
        json = stableJson(value, this.redact, `$.${key}`);
      } catch {
        out[key] = "[unserializable]";
        continue;
      }
      if (Buffer.byteLength(json, "utf8") < BLOB_THRESHOLD_BYTES) {
        out[key] = value;
        continue;
      }
      try {
        out[`${key}Ref`] = this.writeBlob(json);
        out[`${key}Bytes`] = Buffer.byteLength(json, "utf8");
      } catch (error) {
        // A missing payload must never masquerade as replayable evidence.
        throw error;
      }
    }
    return out;
  }

  blob(value: unknown): string {
    return this.writeBlob(stableJson(value, this.redact));
  }

  private writeBlob(json: string): string {
    if (this.closed) throw new Error('cannot write to a closed replay recorder');
    if (this.storageFailure) throw this.storageFailure;
    const hash = createHash("sha256").update(json).digest("hex");
    const file = join(this.dir, "blobs", hash);
    try {
      validateDiagnosticPath(this.rootDir, file);
      if (!existsSync(file)) {
        const bytes = Buffer.byteLength(json);
        if (bytes > this.budget.singleBlobBytes || this.blobBytes + bytes > this.budget.blobBytes) throw new StorageBudgetError('replay-blob-limit');
        checkDiagnosticWrite(this.rootDir, file, bytes, { ...this.budget, reservationOwner: undefined, fileBytes: this.budget.singleBlobBytes });
        writeFileSync(file, json, { mode: 0o600, flag: 'wx' });
        this.blobBytes += bytes; accountDiagnosticWrite(this.rootDir, file, bytes);
      }
    } catch (error) { this.stopRecording(error); throw this.storageFailure; }
    return hash;
  }

  emit(event: Record<string, unknown> & { type: string }, critical = false): ReplayEvent {
    if (this.closed) throw new Error("cannot write to a closed replay recorder");
    const terminal = event.type === 'loop.exit' || event.type === 'run.end';
    if (!terminal && this.storageFailure) throw this.storageFailure;
    if (terminal && this.terminals.has(event.type)) throw new StorageBudgetError('duplicate-terminal');
    try {
      if (!terminal && this.eventCount >= this.budget.eventCount) throw new StorageBudgetError('replay-event-count');
      let payload = terminal ? event : this.spill(event);
      if (terminal && this.storageFailure) payload = { ...event, evidenceComplete: false, recordingStopped: this.storageFailure.code,
        ...(event.type === 'loop.exit' ? { detail: `${typeof event.detail === 'string' ? event.detail + ' ' : ''}Recording incomplete: ${this.storageFailure.code}.` } : {}) };
      let full = this.envelope(payload);
      if (terminal && Buffer.byteLength(stableJson(full, this.redact)) + 1 > this.budget.terminalEventBytes) {
        this.stopRecording(new StorageBudgetError('terminal-payload-limit'));
        // Keep the actual outcome, but explicitly label omitted oversized detail.
        full = this.envelope({ type: event.type, reason: typeof event.reason === 'string' && event.reason.length < 128 ? event.reason : undefined,
          ok: event.ok, iteration: event.iteration, durationMs: event.durationMs, evidenceComplete: false, terminalPayloadOmitted: true,
          detail: 'Recording incomplete: terminal payload exceeded its reserved bytes.', originalBytes: Buffer.byteLength(stableJson(event, this.redact)), originalHash: createHash('sha256').update(stableJson(event, this.redact)).digest('hex') });
      }
      const protectedBytes = terminal ? (1 - this.terminals.size) * this.budget.terminalEventBytes : this.budget.terminalReserveBytes;
      this.write(full, critical || terminal, protectedBytes);
      if (terminal) this.terminals.add(event.type); else this.eventCount++;
      this.mirror?.(full);
      return full;
    } catch (error) { this.stopRecording(error); throw this.storageFailure; }
  }

  private envelope(event: Record<string, unknown>): ReplayEvent {
    return {
      seq: this.seq++,
      ts: Date.now(),
      iso: new Date().toISOString(),
      mono: performance.now() - this.started,
      runId: this.runId,
      ...event,
      type: String(event.type),
    };
  }

  private write(full: ReplayEvent, critical: boolean, protectedBytes: number): void {
    const file = join(this.dir, "events.jsonl");
    const line = `${stableJson(full, this.redact)}\n`;
    checkDiagnosticWrite(this.rootDir, file, Buffer.byteLength(line), { ...this.budget, fileBytes: this.budget.eventBytes }, protectedBytes);
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      appendFileSync(fd, line);
      accountDiagnosticWrite(this.rootDir, file, Buffer.byteLength(line));
      // The runs worth reading are the ones that died, so every line is on disk
      // before the next one is built. `critical` additionally forces the
      // platform to flush its own cache, for a hard kill rather than a crash.
      if (critical) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private stopRecording(error: unknown): void {
    if (this.storageFailure) return;
    this.storageFailure = error instanceof StorageBudgetError ? error : new StorageBudgetError('replay-write-unavailable');
    (this.budget.warn ?? console.warn)(`[storage] Replay recording incomplete: ${this.storageFailure.message}`);
    try {
      this.write(this.envelope({ type: 'storage.budget', code: this.storageFailure.code, evidenceComplete: false,
        detail: 'Payload and ordinary event recording stopped. Existing evidence is intact; manually archive after Echo exits.' }), true, 2 * this.budget.terminalEventBytes);
    } catch { /* Disk/permission failure can defeat the reserve; the console warning remains explicit. */ }
  }

  /** Watch a live run. Set by the loop logger; never used for replay fidelity. */
  mirror: ((event: ReplayEvent) => void) | null = null;

  finish(ok: boolean, reason: ExitReason, iteration: number, detail?: string): void {
    if (this.closed) return;
    try {
      this.emit({ type: "loop.exit", reason, iteration, detail }, true);
      this.emit({ type: "run.end", ok, durationMs: performance.now() - this.started }, true);
    } finally { this.close(); }
  }

  /** Close after LoopLog has written its one run.end event. */
  close(): void {
    this.closed = true;
    this.releaseReservation();
  }
}
