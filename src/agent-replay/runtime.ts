import { randomUUID } from "node:crypto";
import {requestedWindowClose} from '../brain/window-intent.js';
import { basename, dirname, join } from "node:path";
import { Brain, type AudioTurn , type SendOptions } from "../brain/types.js";
import { Recorder, contentHash, INCOMPLETE_EXITS, type ExitReason, type ReplayEvent } from "./recorder.js";
import { DEFAULT_REQUEST_DEADLINE_MS, LoopLog, clearCurrentLoop, consoleMirror, currentLoop, setCurrentLoop, serializeError } from "./loop-log.js";
import { getAppPath } from "../utils/appPath.js";
import { rememberRequest, rememberOutcome } from "../cognition/outcomes.js";
import { BlobStore, type Override, ReplaySource, ReplayedError, loadEvents } from "./replay-source.js";
import { agentNow, liveDeps, replayDeps, resetAgentDeps, setAgentDeps } from "./deps.js";
import {
  currentAgentRunContext,
  runInAgentContext,
  type AgentIdentity,
  type AgentRunContext,
} from "./context.js";
import {
  createRecoveryCheckpoint,
  pendingRecoveryCheckpoints,
  pruneRunLogs,
  recoveryPrompt,
  writeRecoveryCheckpoint,
  type RecoveryCheckpoint,
} from "./recovery.js";

import { taskCoordinator, type TaskState } from "../memory/task-state.js";
import { currentInvocation } from "../memory/invocation.js";
import { consolidateTask, recordTaskStarted } from "../memory/consolidate.js";
import { setPrivateTask } from "../memory/capture-policy.js";
import { dataRoot } from "../memory/paths.js";
import { conversationId, conversations, seedConversationFromRecordings } from "../memory/conversation.js";
import {endEchoComputerTurn,echoAppCompletionProof} from '../tools/lcu-control.js';
import {isAppOperationRequest,calculatorPostcondition} from '../brain/app-intent.js';
import {calculatorResultMatches,isCalculatorReference} from '../tools/gui-completion-policy.js';
import { memoryService } from "../memory/service.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";

/** Diagnostics can be off while the authoritative task coordinator remains active. */
export function ephemeralRecorder(runId: string): Recorder {
  let seq = 0;
  const rec: any = { runId, dir: "", mirror: null, blob: contentHash, close() {}, finish() {},
    emit(event: any) { const full = { ...event, seq: seq++, ts: Date.now(), mono: 0, runId }; rec.mirror?.(full); return full; } };
  return rec as Recorder;
}

const activeRecorders = new Set<Recorder>();
let fallbackActive: Recorder | null = null;
let processHandlersInstalled = false;
let replaySession: { source: ReplaySource; runDir: string } | null = null;

function replayRoot(): string | null {
  // An explicit replay root still overrides the ordinary named run directory.
  const configured = process.env.ECHO_REPLAY_DIR?.trim();
  return configured ? configured : null;
}

/** Full journaling is on by default because recovery needs the original task. */
function payloadRecordingEnabled(): boolean {
  if (replayRoot() || configuredReplayRun()) return true;
  return process.env.ECHO_FULL_LOG?.trim() !== "0";
}

/**
 * Where the diagnostic loop log goes, and whether it runs at all.
 *
 * ON by default. `ECHO_LOG=0` disables both the journal and automatic restart
 * recovery; `ECHO_FULL_LOG=0` retains only diagnostic metadata.
 */
export function loopLogRoot(): string | null {
  if (process.env.ECHO_LOG?.trim() === "0") return null;
  const configured = process.env.ECHO_LOG_DIR?.trim();
  if (configured) return configured;
  const replay = replayRoot();
  if (replay) return replay;
  try {
    return join(dataRoot(), "runs");
  } catch {
    return null;
  }
}

/** Rough token count. Cheap and provider-agnostic: ~4 characters per token. */
export function approxTokens(value: unknown): number {
  try {
    return Math.round(JSON.stringify(value ?? "").length / 4);
  } catch {
    return 0;
  }
}

function configuredReplayRun(): string | null {
  return process.env.ECHO_REPLAY_RUN?.trim() || null;
}

function configuredOverride(): Override | undefined {
  const raw = process.env.ECHO_REPLAY_OVERRIDE_JSON?.trim();
  if (!raw) return undefined;
  try {
    const candidate = JSON.parse(raw) as Override;
    if ((candidate.target?.type === "tool" && typeof candidate.target.callId === "string") ||
      (candidate.target?.type === "llm" && typeof candidate.target.reqId === "string")) return candidate;
  } catch {
    /* reported as an unavailable replay below rather than crashing Echo */
  }
  return undefined;
}

function getReplaySession(): { source: ReplaySource; runDir: string } | null {
  if (replaySession) return replaySession;
  const runDir = configuredReplayRun();
  if (!runDir) return null;
  try {
    replaySession = {
      runDir,
      source: new ReplaySource(loadEvents(runDir), new BlobStore(runDir), configuredOverride()),
    };
    return replaySession;
  } catch (error) {
    console.error("[replay] could not load recording:", error);
    return null;
  }
}

export function isReplaying(): boolean {
  return Boolean(getReplaySession());
}

/** The provider named by a configured recording, without consuming its tape. */
export function configuredReplayProvider(): string | null {
  const runDir = configuredReplayRun();
  if (!runDir) return null;
  try {
    const start = loadEvents(runDir).find((event) => event.type === "run.start");
    const provider = start?.provider ?? (start?.config as any)?.provider;
    return typeof provider === "string" ? provider : null;
  } catch {
    return null;
  }
}

export function configuredReplayDirectory(): string | null {
  return configuredReplayRun();
}

function replayOutputRoot(runDir: string): string {
  return process.env.ECHO_REPLAY_OUTPUT_DIR?.trim() || join(dirname(runDir), `${basename(runDir)}.replay`);
}

function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Recorder controls alter where/how traces are written, never what the
    // agent decides. Keeping them out lets a faithful replay verify its own
    // event stream without treating its control plane as code drift.
    if (/^(NODE_ENV|JARVIS_|ECHO_(?!REPLAY_))/.test(key) && typeof value === "string") env[key] = value;
  }
  return env;
}

/**
 * Catch what escapes the loop entirely.
 *
 * Exported so the Electron entry can install these BEFORE anything else boots —
 * a rejection thrown during startup used to happen before any recorder existed
 * and left nothing behind at all. Neither handler swallows: `uncaughtException`
 * is observed through `uncaughtExceptionMonitor`, which runs alongside Node's
 * own handling rather than replacing it, so the process still dies exactly as
 * it did before. It just says why on the way out.
 */
export function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  const report = (type: string, error: Error, extra: Record<string, unknown> = {}) => {
    const payload = { type, error: serializeError(error), ...extra };
    for (const recorder of activeRecorders) {
      try {
        recorder.emit(payload, true);
      } catch {
        /* the console line below is the fallback when the disk is gone */
      }
    }
    console.error(`[echo:${type}]`, error?.stack ?? error?.message ?? error);
  };
  process.on("unhandledRejection", (reason: unknown) => {
    report("process.unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on("uncaughtExceptionMonitor", (error) => {
    report("process.uncaughtException", error);
  });
}

/** Forwarded from a renderer window, so a UI-side failure lands in the same file. */
export function recordRendererError(payload: { kind: string; message: string; stack?: string; source?: string }): void {
  for (const recorder of activeRecorders) {
    try {
      recorder.emit(
        {
          type: "renderer.error",
          kind: payload.kind,
          message: String(payload.message ?? "").slice(0, 2000),
          stack: payload.stack ? String(payload.stack).slice(0, 8000) : undefined,
          source: payload.source,
        },
        true
      );
    } catch {
      /* never let a renderer fault take out the main process */
    }
  }
  console.error(`[echo:renderer.${payload.kind}]`, payload.message, payload.stack ?? "");
}

export function currentRecorder(): Recorder | null {
  return currentAgentRunContext()?.recorder ?? fallbackActive;
}

function emitReplayedTool<T>(name: string, args: unknown, onExecutionStart?: () => void): T {
  const session = getReplaySession();
  if (!session) throw new Error("replay session is not active");
  const exchange = session.source.nextToolExchange(name, args);
  const rec = currentRecorder();
  if (rec) {
    const argsRef = rec.blob(args);
    rec.emit({ type: "tool.call", callId: exchange.call.callId, name, argsRef, argsHash: argsRef });
    // A saved refusal or reused observation has no handler activity. Reproduce
    // only the recorded execution, at the same point inside the tool boundary.
    if (onExecutionStart && session.source.events.some(event => event.type === 'agent.tool' &&
      event.callId === exchange.call.callId && event.seq > exchange.call.seq && event.seq < exchange.terminal.seq)) onExecutionStart();
    if (exchange.terminal.type === "tool.error") {
      rec.emit({ type: "tool.error", callId: exchange.call.callId, durationMs: Number(exchange.terminal.durationMs ?? 0), message: String(exchange.terminal.message), stack: exchange.terminal.stack });
      throw new ReplayedError(String(exchange.terminal.message), typeof exchange.terminal.stack === "string" ? exchange.terminal.stack : undefined);
    }
    rec.emit({
      type: "tool.result",
      callId: exchange.call.callId,
      durationMs: Number(exchange.terminal.durationMs ?? 0),
      resultRef: rec.blob(exchange.value),
    });
  }
  return exchange.value as T;
}

/** Returns a recorded tool value before the gate, handler, or side effect can run. */
export async function takeReplayedTool<T>(
  name: string,
  args: unknown,
  clockAlreadyConsumed = false,
  onExecutionStart?: () => void
): Promise<{ handled: boolean; value?: T }> {
  if (!isReplaying()) return { handled: false };
  // `decide()` captures the clock before emitting a live tool call. Consume the
  // same input here without invoking any of its snapshots or confirmations.
  if (!clockAlreadyConsumed) agentNow();
  return { handled: true, value: emitReplayedTool<T>(name, args, onExecutionStart) };
}

function timeoutFromEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : fallback;
}

function withDeadline<T>(action: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const running = Promise.resolve().then(action);
  if (timeoutMs === 0) return running;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    running.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** Record one tool boundary without allowing recorder faults to affect Echo. */
export function recordTool<T>(name: string, args: unknown, action: () => Promise<T>, executionId?: string): Promise<T> {
  if (isReplaying()) return Promise.resolve().then(() => emitReplayedTool<T>(name, args));
  const run = () => withDeadline(action, timeoutFromEnv("ECHO_TOOL_TIMEOUT_MS", DEFAULT_REQUEST_DEADLINE_MS), `tool ${name}`);
  const rec = currentRecorder();
  if (!rec || !payloadRecordingEnabled()) return run();
  let callId: string;
  try {
    callId = currentInvocation()?.callId ?? executionId ?? randomUUID();
    const argsRef = rec.blob(args);
    rec.emit({ type: "tool.call", callId, name, argsRef, argsHash: argsRef });
  } catch {
    // A recorder must be observational. A full disk or an unwritable replay
    // directory can lose a trace, but must never keep Echo from acting.
    return run();
  }
  const started = performance.now();
  return run().then(
    (result) => {
      try {
        rec.emit({ type: "tool.result", callId, durationMs: performance.now() - started, resultRef: rec.blob(result) });
      } catch {
        /* recording must not alter a successful tool result */
      }
      return result;
    },
    (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      try {
        rec.emit({ type: "tool.error", callId, durationMs: performance.now() - started, message: err.message, stack: err.stack });
      } catch {
        /* preserve the original tool failure */
      }
      throw error;
    }
  );
}

/** Record a gate refusal as a tool result, even though no handler may run. */
export function recordToolDenied(name: string, args: unknown, message: string): void {
  const rec = currentRecorder();
  if (!rec || !payloadRecordingEnabled()) return;
  try {
    const callId = currentInvocation()?.callId ?? randomUUID();
    const argsRef = rec.blob(args);
    rec.emit({ type: "tool.call", callId, name, argsRef, argsHash: argsRef });
    rec.emit({ type: "tool.result", callId, durationMs: 0, resultRef: rec.blob({ text: message, denied: true }) });
  } catch (err) {
    console.error("[replay] could not record a denied tool:", (err as any)?.message ?? err);
  }
}

/**
 * Token counts from whatever shape the provider used.
 *
 * Every recorded `llm.response` carried `usage: {}` because the field was a
 * hardcoded empty object, so no tape could be tied to a cost and the one number
 * that shows a run heading for a context overflow was never written down.
 *
 * Each provider spells this differently and none of them is going to stop:
 * Gemini nests `usageMetadata`, Ollama puts `prompt_eval_count` at the top
 * level, OpenAI-shaped APIs use `usage.prompt_tokens`. Reading all of them here
 * keeps that spread out of the recorder's callers.
 */
export function normalizeUsage(response: unknown): Record<string, number> {
  if (!response || typeof response !== "object") return {};
  const source = response as Record<string, any>;
  const meta = (source.usageMetadata ?? source.usage ?? source) as Record<string, any>;
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = Number(meta?.[key]);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const usage: Record<string, number> = {};
  const input = pick("promptTokenCount", "prompt_tokens", "promptTokens", "prompt_eval_count", "input_tokens");
  const output = pick("candidatesTokenCount", "completion_tokens", "completionTokens", "eval_count", "output_tokens");
  const total = pick("totalTokenCount", "total_tokens", "totalTokens");
  const cached = pick("cachedContentTokenCount", "cached_tokens", "cache_read_input_tokens");
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  else if (input !== undefined && output !== undefined) usage.totalTokens = input + output;
  if (cached !== undefined) usage.cachedTokens = cached;
  return usage;
}

export interface RecordLLMOptions {
  /**
   * Whether this caller is about to try again, asked at the moment the failure
   * surfaces and before the caller's own catch runs.
   *
   * `willRetry` used to be the literal `false` on every recorded error, and the
   * replay path at the top of this function believes what the tape says. A tape
   * from 10 September holds `llm.error ... willRetry: false` immediately followed
   * by `llm.request attempt: 1` — the recorder said it would not retry, then
   * retried. Recovery is the most intricate path in the runtime and the likeliest
   * home for a silent stop, and it was the one path replay could not reproduce.
   *
   * A predicate rather than a value, because only the caller knows its policy,
   * and it has to be the same expression its catch block uses — see
   * `geminiFallbackReason`.
   */
  willRetry?: (error: unknown) => boolean;

  /**
   * This request may be abandoned on purpose — a warm-up or a guess the loop
   * never intends to wait for.
   *
   * Labelled requests are excluded from the loop's open-work ledger, so an
   * unpaired `llm.request` in a tape always means a call that was genuinely
   * walked away from, rather than one the design expected to discard.
   */
  speculative?: boolean;
}

/**
 * Capture a complete non-streaming provider exchange. Providers that stream
 * should emit llm.chunk separately; Gemini and Ollama currently return their
 * assembled response, which is still sufficient for inspection and retries.
 */
export function recordLLM<T>(
  request: unknown,
  action: () => Promise<T>,
  attempt = 0,
  opts: RecordLLMOptions = {}
): Promise<T> {
  const session = getReplaySession();
  if (session) {
    return Promise.resolve().then(() => {
      const exchange = session.source.nextLLMExchange(request);
      const rec = currentRecorder();
      if (rec) {
        const bodyRef = rec.blob(request);
        rec.emit({ type: "llm.request", reqId: String(exchange.request.reqId), attempt: Number(exchange.request.attempt ?? attempt), bodyRef, bodyHash: bodyRef, speculative: exchange.request.speculative || undefined });
        if (exchange.errorEvent) {
          rec.emit({
            type: "llm.error",
            reqId: String(exchange.request.reqId),
            status: exchange.errorEvent.status,
            message: String(exchange.errorEvent.message),
            stack: exchange.errorEvent.stack,
            willRetry: Boolean(exchange.errorEvent.willRetry),
          });
          throw new ReplayedError(String(exchange.errorEvent.message), typeof exchange.errorEvent.stack === "string" ? exchange.errorEvent.stack : undefined);
        }
        if (exchange.responseEvent) {
          rec.emit({
            type: "llm.response",
            reqId: String(exchange.request.reqId),
            stopReason: exchange.responseEvent.stopReason ?? "complete",
            usage: exchange.responseEvent.usage ?? {},
            bodyRef: rec.blob(exchange.response),
          });
        }
      }
      if (exchange.errorEvent) {
        throw new ReplayedError(String(exchange.errorEvent.message), typeof exchange.errorEvent.stack === "string" ? exchange.errorEvent.stack : undefined);
      }
      return exchange.response as T;
    });
  }
  const run = () => withDeadline(action, timeoutFromEnv("ECHO_LLM_TIMEOUT_MS", DEFAULT_REQUEST_DEADLINE_MS), "model request");
  const rec = currentRecorder();
  if (!rec || !payloadRecordingEnabled()) return run();
  const loop = currentLoop();
  let reqId: string;
  try {
    reqId = randomUUID();
    const bodyRef = rec.blob(request);
    rec.emit({ type: "llm.request", reqId, attempt, bodyRef, bodyHash: bodyRef, speculative: opts.speculative || undefined });
    // The loop now owes this request a terminal event. If the run ends first,
    // `exit()` says the call was abandoned instead of leaving a silent gap.
    if (!opts.speculative) loop?.openedWork(reqId, "llm.request", `attempt ${attempt}`);
  } catch {
    return run();
  }
  return run().then(
    (response) => {
      loop?.closedWork(reqId);
      try {
        rec.emit({ type: "llm.response", reqId, stopReason: "complete", usage: normalizeUsage(response), bodyRef: rec.blob(response) });
      } catch {
        /* never turn a complete model response into a failed turn */
      }
      return response;
    },
    (error) => {
      loop?.closedWork(reqId);
      const err = error instanceof Error ? error : new Error(String(error));
      let willRetry = false;
      try {
        willRetry = opts.willRetry?.(error) === true;
      } catch {
        // A fault in a caller's retry policy must not change what is recorded
        // about the provider's failure, and must not become the failure.
      }
      try {
        rec.emit({ type: "llm.error", reqId, message: err.message, stack: err.stack, willRetry });
      } catch {
        /* preserve the provider's original failure */
      }
      throw error;
    }
  );
}

export interface RecordingBrainOptions {
  limits?: {allowedTools?: ReadonlySet<string>};
  identity?: AgentIdentity;
  /** Disable only for diagnostics/tests. User-facing brains recover by default. */
  autoResume?: boolean;
  maxRecoveryAttempts?: number;
  recoveryDelayMs?: number;
}

export const MAIN_ECHO_IDENTITY: AgentIdentity = { id: "echo", name: "Echo", kind: "main" };

function runIdFor(identity: AgentIdentity): string {
  const readable = identity.name.replace(/[^a-zA-Z0-9 _.-]/g, "").trim().slice(0, 60) || "Echo";
  return `${readable}--${randomUUID()}`;
}

function configuredRecoveryDelay(reason: ExitReason): number {
  const configured = Number(process.env.ECHO_RECOVERY_DELAY_MS);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  return reason === "rate_limit_429" ? 5_000 : 750;
}

/**
 * Decorates every provider with an isolated, named run journal and recovery.
 * AsyncLocalStorage keeps simultaneous clones from ever sharing a recorder.
 */
export class RecordingBrain extends Brain {
  readonly identity: AgentIdentity;
  private context: AgentRunContext | null = null;
  private lastContext: AgentRunContext | null = null;
  private checkpoint: RecoveryCheckpoint | null = null;
  private interrupted = false;
  private stopped = false;
  private recoveryTimer: NodeJS.Timeout | null = null;
  /**
   * Every failure this run surfaced, in order.
   *
   * This was one slot written under two opposite rules: `forward()` overwrote
   * it with the newest error, and the exhausted-recovery path kept whichever
   * was already there. With more than one failure in a run, which one the user
   * finally saw depended on the order the two paths happened to run — and a
   * task that failed three different ways reported exactly one of them, chosen
   * by accident.
   */
  private readonly pendingErrors: string[] = [];
  private finalFailureMessage: string | null = null;
  private readonly suppressedTurnEnds = new Set<string>();
  private readonly terminalRuns = new Set<string>();
  private readonly autoResume: boolean;
  private readonly maxRecoveryAttempts?: number;
  private readonly recoveryDelayMs?: number;
  private readonly allowedTools?: ReadonlySet<string>;
  private toolAbort: AbortController | null = null;
  private privateConversationId?: string;
  private heldAppText='';
  // Always kept in memory, even when privacy settings omit durable prompts.
  private appRequest='';
  private appPause?:{context:AgentRunContext;ack:boolean;drained:boolean;failed:boolean;scheduled:boolean;timer?:NodeJS.Timeout;pending:Array<{text:string;audio?:AudioTurn;opts?:SendOptions}>};

  private failAppPause(pause:NonNullable<RecordingBrain['appPause']>):void {
    if(this.appPause!==pause||pause.failed)return;
    pause.failed=true;if(pause.timer)clearTimeout(pause.timer);
    const message='The provider could not confirm a safe pause. Queued instructions were not started. Restart the brain before continuing.';
    if(this.checkpoint?.status!=='cancelled'&&this.checkpoint?.taskId===pause.context.taskId){
      this.checkpoint.status='exhausted';this.checkpoint.lastExitReason='provider_error';
      taskCoordinator.finish(this.checkpoint.taskId,{status:'blocked',summary:message});
      this.persistCheckpoint(pause.context.recorder.dir,this.checkpoint);
    }
    this.emit('error',message);this.emitTerminal(pause.context.recorder.runId);
  }
  private releaseAppPause(pause:NonNullable<RecordingBrain['appPause']>):void {
    if(this.appPause!==pause||pause.failed||!pause.ack||!pause.drained||pause.scheduled)return;
    pause.scheduled=true;
    // Let the original provider finish its finally/drain code before a new run.
    queueMicrotask(()=>{
      if(this.appPause!==pause||pause.failed)return;
      if(pause.timer)clearTimeout(pause.timer);
      this.appPause=undefined;
      for(const pending of pause.pending)this.send(pending.text,pending.audio,pending.opts);
    });
  }

  private appTaskRequiresProof():boolean {
    return this.identity.kind==='main'&&!!this.checkpoint&&isAppOperationRequest(this.appRequest);
  }
  private configureAppPause(context:AgentRunContext):void {
    if(!this.appTaskRequiresProof())return;
    context.onAppQuestion=()=>{
      if(this.context!==context||context.loop.hasExited||!context.appQuestion)return;
      const abort=this.toolAbort;
      const pause:NonNullable<RecordingBrain['appPause']>={context,ack:false,drained:false,failed:false,scheduled:false,pending:[]};
      this.appPause=pause;
      pause.timer=setTimeout(()=>this.failAppPause(pause),15000);pause.timer.unref();
      // Called by the gate only after the question call result is committed.
      context.loop.exit('completed',{detail:'Awaiting the user’s app clarification'});
      abort?.abort();
      void Promise.resolve().then(()=>this.inner.pauseForInput()).then(()=>{
        pause.ack=true;this.releaseAppPause(pause);
      },()=>this.failAppPause(pause));
    };
  }
  private appTaskProved(runId:string):boolean {
    const proof=echoAppCompletionProof(runId);if(!proof)return false;
    const request=this.appRequest;
    if(/\bclose\b/i.test(request)){
      if(proof.kind!=='window_closed'||proof.condition?.kind!=='window_closed'||proof.inputCount<=0)return false;
      return !!proof.nativeAppName&&requestedWindowClose(request,proof.condition.title,proof.nativeAppName);
    }
    if(/\bcalculator\b/i.test(request)&&!isCalculatorReference(proof.app))return false;
    const arithmetic=calculatorPostcondition(request);
    if(/\bcalculator\b/i.test(request)&&/\b(?:calculate|compute)\b/i.test(request)&&!arithmetic)return false;
    if(arithmetic){
      const normalize=(value:string)=>value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\s]/g,'').replace(/×/g,'*').replace(/÷/g,'/').replace(/−/g,'-').replace(/=$/,'');
      if(!isCalculatorReference(proof.app)||proof.kind!=='text'||proof.condition?.kind!=='text'||!proof.inputCount||!proof.expression||normalize(proof.expression)!==arithmetic.expression)return false;
      return calculatorResultMatches(proof.condition.expected.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,''),arithmetic.value);
    }
    if(/\b(?:calculate|compute|type|enter|fill|click|tap|scroll|drag)\b/i.test(request))return proof.kind==='text'&&proof.inputCount>0;
    if(/\b(?:move)\b/i.test(request))return proof.kind==='pointer';
    return proof.kind==='visible'||proof.kind==='text';
  }

  private recordConversation(role: "user" | "assistant", text: string, taskId?: string): void {
    if (isReplaying() || this.provider === "test" || this.identity.kind === "rehearsal" || !ProviderMemoryContext.enabled || this.lastSendOpts?.privateMode) return;
    const opts = this.lastSendOpts;
    if (!opts?.conversationId || memoryService.isSuppressed(opts.scope ?? {}, taskId)) return;
    try {
      if (role === "user" && this.identity.kind === "main") seedConversationFromRecordings(opts.conversationId, this.identity.id, opts.scope);
      conversations.append(opts.conversationId, { role, text, taskId, provider: this.provider,
      actorId: this.identity.id, projectId: opts.scope?.projectId }); }
    catch (error) { console.error("[context] conversation recording failed", error); }
  }

  constructor(
    private readonly inner: Brain,
    readonly provider: string,
    private readonly loopConfig: Record<string, unknown> = {},
    options: RecordingBrainOptions = {}
  ) {
    super();
    this.identity = options.identity ?? MAIN_ECHO_IDENTITY;
    this.autoResume = options.autoResume !== false;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts;
    this.recoveryDelayMs = options.recoveryDelayMs;
    this.allowedTools = options.limits?.allowedTools === undefined ? undefined : new Set(options.limits.allowedTools);
    this.supportsTaskUpdates = inner.supportsTaskUpdates;
    for (const event of ["status", "text", "textDelta", "textDone", "tool", "toolEnd", "risk", "error", "turnEnd", "progress"] as const) {
      inner.on(event, (...args: any[]) => this.forward(event, args));
    }
  }

  private contextForEvent(): AgentRunContext | null {
    return currentAgentRunContext() ?? this.context;
  }

  readonly supportsTaskUpdates: boolean;
  private readonly toolRuns = new Map<string, {taskId: string; actorId: string; runId: string}>();

  queueTaskUpdate(text: string, applied: () => void): boolean {
    const context = this.context;
    if (!this.supportsTaskUpdates || !context) return false;
    const generation = taskCoordinator.get(context.taskId)?.generation;
    const ownsRun = () => {
      const ambient = currentAgentRunContext();
      const task = taskCoordinator.get(context.taskId);
      return this.context === context && !this.stopped && !this.interrupted && !this.appPause &&
        !context.loop.hasExited && !context.toolSignal?.aborted &&
        context.identity.id === this.identity.id && (!ambient || ambient === context) &&
        task?.ownerActorId === this.identity.id && task.generation === generation && task.status === 'running';
    };
    if (!ownsRun()) return false;
    let accepted = false, consumed = false, acknowledged = false;
    const acknowledge = () => {
      if (!accepted || !consumed || acknowledged || !ownsRun()) return;
      acknowledged = true;
      const appUpdate = isAppOperationRequest(text);
      if (appUpdate) {
        this.appRequest = text;
        this.heldAppText = '';
        this.configureAppPause(context);
      }
      // Enqueue is not an applied update. Save the instruction only when the
      // owning provider actually incorporates it at its request boundary.
      if (this.checkpoint && context.payloadRecording) {
        (this.checkpoint.followUpPrompts ??= []).push(text);
        if (this.checkpoint.followUpPrompts.length > 20) this.checkpoint.followUpPrompts.shift();
        if (appUpdate) this.checkpoint.appRequest = text;
        this.persistCheckpoint(context.recorder.dir, this.checkpoint);
      }
      this.recordConversation('user', text, context.taskId);
      applied();
    };
    accepted = runInAgentContext(context, () => this.inner.queueFencedTaskUpdate(text, () => {
      consumed = true;
      acknowledge();
    }, ownsRun));
    // Also support providers that consume synchronously, but never acknowledge
    // a refusing provider even if it incorrectly called back before returning.
    acknowledge();
    return accepted;
  }

  private updateCheckpoint(event: ReplayEvent, checkpoint: RecoveryCheckpoint, runDir: string): void {
    let changed = false;
    if (event.type === "tool.start") {
      checkpoint.actions.push({
        callId: typeof event.callId === "string" ? event.callId : undefined,
        name: String(event.name ?? "unknown tool"),
        argsHash: typeof event.argsHash === "string" ? event.argsHash : undefined,
        status: "started",
        at: Number(event.ts ?? Date.now()),
      });
      if (checkpoint.actions.length > 100) checkpoint.actions.splice(0, checkpoint.actions.length - 100);
      changed = true;
    } else if (event.type === "tool.end") {
      const pending = [...checkpoint.actions].reverse().find((action) =>
        action.status === "started" && (action.callId ? action.callId === event.callId : action.name === String(event.name ?? "unknown tool"))
      );
      // A timed-out handler may still finish in the background because not all
      // tools expose cancellation. Keep it uncertain so recovery observes the
      // real state before deciding whether the action needs repeating.
      const uncertainTimeout = event.isError && /timed? out|timeout/i.test(String(event.detail ?? ""));
      if (pending) {
        if (!uncertainTimeout) pending.status = event.isError ? "failed" : "completed";
      } else {
        checkpoint.actions.push({
          name: String(event.name ?? "unknown tool"),
          status: uncertainTimeout ? "started" : event.isError ? "failed" : "completed",
          at: Number(event.ts ?? Date.now()),
        });
      }
      changed = true;
    }
    if (changed) {
      try { writeRecoveryCheckpoint(runDir, checkpoint); }
      catch (error) { console.error("[echo:recovery] checkpoint write failed:", (error as any)?.message ?? error); }
    }
  }

  private persistCheckpoint(runDir: string, checkpoint: RecoveryCheckpoint): void {
    try { writeRecoveryCheckpoint(runDir, checkpoint); }
    catch (error) { console.error("[echo:recovery] checkpoint write failed:", (error as any)?.message ?? error); }
  }

  private forward(event: string, args: any[]): void {
    const context = this.contextForEvent();
    if (event === 'tool' || event === 'toolEnd') {
      // Provider/model-supplied owner fields are not authority. Stamp the
      // actual emitting context, never another worker's ambient context.
      if (!context || context.identity.id !== this.identity.id) return;
      const info = args[0] ?? {};
      const callId = currentInvocation()?.callId ?? info.callId;
      const owner = {taskId: context.taskId, actorId: context.identity.id, runId: context.recorder.runId};
      if (event === 'tool') {
        if (this.stopped || this.interrupted || context !== this.context || context.loop.hasExited) return;
        if (typeof callId === 'string') this.toolRuns.set(callId, owner);
      }
      // An old handler can drain after a successor starts. Its end closes only
      // its original call/run, even with the SDK's successor-following context.
      const stamp = event === 'toolEnd' && typeof callId === 'string' ? this.toolRuns.get(callId) ?? owner : owner;
      if (event === 'toolEnd' && typeof callId === 'string') this.toolRuns.delete(callId);
      args = [{...info, ...stamp, ...(callId === undefined ? {} : {callId})}, ...args.slice(1)];
    }
    // Provider speech is not a proof of GUI success. Hold both streamed and
    // whole replies until the same foreground run verifies its native result.
    if(this.appTaskRequiresProof()&&['text','textDelta','textDone'].includes(event)){
      if(event==='text')this.heldAppText=String(args[0]??'').slice(-12000);
      return;
    }
    if (event === "text" && !this.stopped) this.recordConversation("assistant", String(args[0] ?? ""), context?.taskId ?? this.checkpoint?.taskId);
    const rec = context?.recorder ?? null;
    try {
      if (rec && !context?.loop.hasExited && event === "text") {
        rec.emit({ type: "agent.text", textRef: rec.blob(args[0]) });
        if (this.checkpoint && context?.payloadRecording) {
          this.checkpoint.lastAssistantText = String(args[0] ?? "").slice(-4000);
          writeRecoveryCheckpoint(rec.dir, this.checkpoint);
        }
      }
      if (rec && !context?.loop.hasExited && event === "status") rec.emit({ type: "agent.status", status: args[0] });
      if (rec && !context?.loop.hasExited && event === "tool") {
        const info = args[0] ?? {};
        const name = String(info.name ?? "unknown tool");
        rec.emit({
          type: "agent.tool",
          name,
          callId: info.callId,
          summary: context?.payloadRecording ? String(info.summary ?? name).slice(0, 1000) : undefined,
        });
        if (this.checkpoint) {
          const duplicate = [...this.checkpoint.actions].reverse().find((action) =>
            action.status === "started" && action.name === name && Date.now() - action.at < 2_000
          );
          if (!duplicate) this.checkpoint.actions.push({ name, status: "started", at: Date.now() });
          writeRecoveryCheckpoint(rec.dir, this.checkpoint);
        }
      }
      if (rec && !context?.loop.hasExited && event === "risk") {
        const risk = args[0] ?? {};
        rec.emit({ type: "agent.risk", tool: risk.tool, tier: risk.tier, reason: risk.reason });
      }
      if (rec && !context?.loop.hasExited && event === "error") {
        rec.emit({ type: "agent.error", message: String(args[0] ?? "Unknown brain error").slice(0, 4000) }, true);
      }
    } catch (err) {
      console.error("[replay] recording disabled mid-run:", (err as any)?.message ?? err);
    }

    if (event === "error") {
      if (!context) {
        this.emit(event, ...args);
        return;
      }
      // A transient provider error is not the end of the user's task anymore.
      // Hold it until recovery is exhausted; a successful retry stays quiet.
      this.notePendingError(args[0]);
      return;
    }

    if (event === "turnEnd") {
      if(this.appPause){
        const pause=this.appPause;
        this.emitTerminal(pause.context.recorder.runId);
        pause.drained=true;this.releaseAppPause(pause);return;
      }
      const runId = context?.recorder.runId;
      if (context && !context.loop.hasExited) {
        context.loop.exit(this.interrupted ? "abort_signal" : "unknown_fallthrough", {
          detail: "brain ended the turn without reporting an exit",
        });
      }
      if (runId && this.suppressedTurnEnds.has(runId)) return;
      if (runId) this.emitTerminal(runId);
      else this.emit(event, ...args);
      return;
    }

    this.emit(event, ...args);
  }

  private notePendingError(message: unknown): void {
    const text = String(message ?? "").trim() || "Unknown brain error";
    // A provider that reports the same failure twice is one fact, not two.
    if (this.pendingErrors.at(-1) === text) return;
    this.pendingErrors.push(text);
    if (this.pendingErrors.length > 20) this.pendingErrors.splice(0, this.pendingErrors.length - 20);
  }

  /**
   * What went wrong, as one message: the first failure, the most recent one,
   * and how many there were. The first is usually the cause and the last is
   * usually what the user saw, so reporting either alone loses the run.
   */
  private summarizePendingErrors(): string | null {
    const count = this.pendingErrors.length;
    if (count === 0) return null;
    if (count === 1) return this.pendingErrors[0];
    return `${this.pendingErrors[0]}\n\n(${count} errors in this run; most recent: ${this.pendingErrors[count - 1]})`;
  }

  private emitTerminal(runId: string): void {
    if (this.terminalRuns.has(runId)) return;
    this.terminalRuns.add(runId);
    const reason = this.checkpoint?.lastExitReason;
    if (this.finalFailureMessage) this.emit("text", this.finalFailureMessage);
    const failures = this.summarizePendingErrors();
    if (failures && reason !== "completed" && reason !== "abort_signal") {
      this.emit("error", failures);
    }
    this.finalFailureMessage = null;
    this.pendingErrors.length = 0;
    this.emit("turnEnd");
  }

  private cleanup(context: AgentRunContext): void {
    // The LCU controller retains the desktop lease until cleanup is confirmed.
    void endEchoComputerTurn(context.recorder.runId,context.toolSignal?.aborted?'Interrupt':'Stop').catch(error=>{
      console.error('[echo:lcu] cleanup incomplete; desktop remains fenced:',error);
      this.emit('error','Computer-control cleanup is incomplete. Further desktop input is blocked until cleanup succeeds.');
    });
    activeRecorders.delete(context.recorder);
    clearCurrentLoop(context.loop);
    if (fallbackActive === context.recorder) fallbackActive = null;
    if (this.context === context) this.context = null;
    if (configuredReplayRun()) replaySession = null;
  }

  private onRunExit(
    context: AgentRunContext,
    checkpoint: RecoveryCheckpoint,
    reason: ExitReason,
    payload: Record<string, unknown>
  ): void {
    checkpoint.lastExitReason = reason;
    checkpoint.lastExitDetail = typeof payload.detail === "string" ? payload.detail : undefined;
    if (reason === 'no_progress') {
      checkpoint.status = 'exhausted';
      taskCoordinator.finish(checkpoint.taskId, {status: 'blocked', summary: 'Repeated tool calls produced no new progress.'});
      this.persistCheckpoint(context.recorder.dir, checkpoint);
      this.cleanup(context);
      return;
    }

    if (reason === "completed") {
      if(this.appTaskRequiresProof()){
        const question=context.appQuestion;
        if(question){
          checkpoint.status='waiting';checkpoint.lastAssistantText=question;
          taskCoordinator.finish(checkpoint.taskId,{status:'waiting',summary:question});
          this.heldAppText='';this.recordConversation('assistant',question,checkpoint.taskId);this.emit('text',question);
          context.recorder.emit({type:'task.waiting_for_input'});
          this.persistCheckpoint(context.recorder.dir,checkpoint);this.cleanup(context);return;
        }
        if(!this.appTaskProved(context.recorder.runId)){
          const message="I haven’t verified the requested result in the app, so this task is not complete. "+(checkpoint.restartable?'Recorded progress is preserved. ':'')+"I won’t claim success or replay uncertain input.";
          checkpoint.status='exhausted';checkpoint.lastExitReason='model_stop_no_tool_call';checkpoint.lastExitDetail='App completion rejected: no current native postcondition';
          this.heldAppText='';this.finalFailureMessage=message;
          taskCoordinator.finish(checkpoint.taskId,{status:'blocked',summary:message});
          context.recorder.emit({type:'task.completion_refused',reason:'missing_app_postcondition'});
          this.persistCheckpoint(context.recorder.dir,checkpoint);this.cleanup(context);return;
        }
        const arithmetic=calculatorPostcondition(this.appRequest),condition=echoAppCompletionProof(context.recorder.runId)?.condition;
        const text=arithmetic&&condition?.kind==='text'
          ? `Calculator shows ${condition.expected.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim()} for ${arithmetic.expression}.`
          :condition?.kind==='window_closed'?`Closed the “${condition.title}” window.`
          :this.heldAppText;
        this.heldAppText='';
        if(text){checkpoint.lastAssistantText=text;this.recordConversation('assistant',text,checkpoint.taskId);this.emit('text',text);}
      }
      checkpoint.status = "completed";
      this.finalizeTask(checkpoint, "completed");
      this.persistCheckpoint(context.recorder.dir, checkpoint);
      this.cleanup(context);
      return;
    }
    if (reason === "abort_signal" || this.interrupted || this.stopped) {
      checkpoint.status = "cancelled";
      this.finalizeTask(checkpoint, "cancelled");
      this.persistCheckpoint(context.recorder.dir, checkpoint);
      this.cleanup(context);
      return;
    }

    // Retrying an exhausted account cannot advance this task and delays the
    // actual provider error behind several checkpoint announcements.
    const providerFailure = [checkpoint.lastExitDetail, ...this.pendingErrors,
      payload.error instanceof Error ? payload.error.message : String(payload.error ?? "")].join("\n");
    const exhaustedQuota = reason === "provider_error" &&
      /subscription sharing.*usage limit|reached.*usage limit|out of (?:credits|quota)|insufficient_quota|exceeded.*(?:current quota|session limit)|(?:quota|session limit).*exhausted/i.test(providerFailure);
    const recoverable = INCOMPLETE_EXITS.has(reason) && !exhaustedQuota;
    const canRetry = recoverable && checkpoint.restartable !== false && this.autoResume &&
      checkpoint.recoveryAttempts < checkpoint.maxRecoveryAttempts;
    if (canRetry) {
      checkpoint.recoveryAttempts++;
      checkpoint.status = "pending";
      this.persistCheckpoint(context.recorder.dir, checkpoint);
      this.suppressedTurnEnds.add(context.recorder.runId);
      this.cleanup(context);

      const delay = this.recoveryDelayMs ?? configuredRecoveryDelay(reason);
      console.warn(
        `[echo:recovery] ${checkpoint.actor.name} stopped (${reason}); resuming task ${checkpoint.taskId} ` +
        `from checkpoint, attempt ${checkpoint.recoveryAttempts}/${checkpoint.maxRecoveryAttempts}`
      );
      this.emit("status", "thinking");
      if (checkpoint.recoveryAttempts === 1) {
        this.emit("text", `${checkpoint.actor.name} stopped before finishing, so I'm continuing from its checkpoint.`);
      }
      // Deliberately NOT unref'd. The line above has already told the user the
      // task is continuing from its checkpoint, so this timer is a promise
      // that has been made out loud. An unref'd timer does not hold the event
      // loop open, so whenever nothing else does — a headless run, a detached
      // worker, a rehearsal actor — the process exits during the backoff and
      // the promised recovery simply never happens. That is a silent stop
      // manufactured by the recovery mechanism itself.
      //
      // Nothing is left dangling at quit in exchange: both `interrupt()` and
      // `stop()` clear this timer through `cancelPendingRecovery`.
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = null;
        this.beginRun(recoveryPrompt(checkpoint), checkpoint);
      }, delay);
      return;
    }

    checkpoint.status = "exhausted";
    this.finalizeTask(checkpoint, "failed");
    this.persistCheckpoint(context.recorder.dir, checkpoint);
    this.cleanup(context);
    this.suppressedTurnEnds.add(context.recorder.runId);
    const message = recoverable
      ? `${checkpoint.actor.name} could not finish after ${checkpoint.recoveryAttempts} automatic recovery attempt(s). ` +
        `The checkpoint is preserved in ${context.recorder.dir}.`
      : `${checkpoint.actor.name} stopped for an unrecoverable reason (${reason}).`;
    // Only when the run said nothing else: this is the wrapper's own summary,
    // and `finalFailureMessage` already speaks it. It should not displace a
    // real provider failure, nor be appended beside it.
    if (this.pendingErrors.length === 0) this.notePendingError(message);
    this.finalFailureMessage = exhaustedQuota ? null : message;
    queueMicrotask(() => this.emitTerminal(context.recorder.runId));
  }

  private beginRun(userText: string, checkpoint?: RecoveryCheckpoint, audio?: AudioTurn): void {
    this.heldAppText='';
    this.appRequest=checkpoint?.appRequest||checkpoint?.originalPrompt|| (checkpoint ? this.appRequest : userText);
    const replay = getReplaySession();
    const root = replay ? replayOutputRoot(replay.runDir) : loopLogRoot();
    let admission:{taskId:string;revision:number;ownerActorId:string}|undefined;
    let pendingRecorder:Recorder|undefined;
    let admissionOpen=true;
    try {
      installProcessHandlers();
      const privateMode = this.lastSendOpts?.privateMode === true || checkpoint?.privateMode === true;
      const fullPayload = !privateMode && !!root && payloadRecordingEnabled();
      // A metadata-only trace (ECHO_FULL_LOG=0) must not keep the prompt: the
      // checkpoint sits on disk next to the redacted journal, and storing the
      // goal there would put back exactly the text that mode exists to omit.
      // Restart follows from the same fact — there is no prompt to restart.
      const task = checkpoint ?? createRecoveryCheckpoint(
        this.identity,
        fullPayload ? userText : "",
        this.maxRecoveryAttempts,
        fullPayload
      );
      task.taskId = checkpoint?.taskId ?? this.lastSendOpts?.taskId ?? task.taskId;
      task.privateMode = privateMode;
      task.scope = this.lastSendOpts?.scope ?? checkpoint?.scope ?? {};
      this.lastSendOpts = { ...this.lastSendOpts, taskId: task.taskId, scope: task.scope, privateMode };
      if (!this.lastSendOpts.conversationId) this.lastSendOpts.conversationId = conversationId(this.identity.id, task.scope);
      if (!checkpoint) this.recordConversation("user", userText, task.taskId);
      task.restartable = !privateMode && fullPayload && !!task.originalPrompt;
      if (!replay) {
        const state = taskCoordinator.create({ taskId: task.taskId, parentTaskId: this.lastSendOpts?.parentTaskId ?? this.identity.parentTaskId, ownerActorId: this.identity.id, goal: userText, scope: task.scope, privateMode });
        admission={taskId:state.taskId,revision:state.revision,ownerActorId:state.ownerActorId};
        task.taskRevision = state.revision;
        setPrivateTask(task.taskId, privateMode);
        try {
          // Preserve the coordinator's original goal and normalized scope on
          // retries; a recovery prompt is provider guidance, not task memory.
          recordTaskStarted({
            taskId: state.taskId,
            scope: state.scope,
            goal: state.goal,
            actorId: state.ownerActorId,
            origin: task.actor.kind === "rehearsal" ? "rehearsal" : "real",
            privateMode: state.privateMode,
          });
        } catch (error) {
          // Never leave a task appearing active when its matching working
          // memory could not be made durable.
          try { taskCoordinator.cancel(state.taskId); } catch { /* task storage may be unavailable too */ }
          setPrivateTask(state.taskId, false);
          throw error;
        }
      }
      const recorder = root && !privateMode ? new Recorder(root, runIdFor(task.actor)) : ephemeralRecorder(runIdFor(task.actor));
      pendingRecorder=recorder;
      if (!replay) taskCoordinator.recordAttempt(task.taskId, recorder.runId);
      if (checkpoint) taskCoordinator.finish(task.taskId,{status:'running'});
      if(admission)admission.revision=taskCoordinator.get(admission.taskId)?.revision??admission.revision;
      task.provider = this.provider;
      task.model = String(this.loopConfig.model ?? "unknown");
      const log = new LoopLog(recorder, this.provider, String(this.loopConfig.model ?? "unknown"));
      this.toolAbort = new AbortController();
      const context: AgentRunContext = {
        identity: task.actor,
        taskId: task.taskId,
        conversationId: this.lastSendOpts.conversationId,
        recorder,
        loop: log,
        payloadRecording: fullPayload,
        provider: this.provider,
        allowedTools: this.allowedTools,
        toolSignal: this.toolAbort.signal,
        privateMode,
        scope: task.scope,
      };
      if (this.lastContext) this.lastContext.successor = context;
      this.lastContext = context;
      context.deps = replay ? replayDeps(replay.source, recorder) : liveDeps(recorder);

      this.context = context;
      this.checkpoint = task;
      this.configureAppPause(context);
      this.interrupted = false;
      task.status = "running";
      task.lastRunId = recorder.runId;
      writeRecoveryCheckpoint(recorder.dir, task);

      activeRecorders.add(recorder);
      fallbackActive = recorder;
      setCurrentLoop(log);
      let lastProgressAt=0;
      recorder.mirror = (event) => {
        if (recorder.dir && !privateMode && process.env.ECHO_LOG_QUIET?.trim() !== "1") consoleMirror(event);
        this.updateCheckpoint(event, task, recorder.dir);
        if(event.type==='loop.heartbeat'&&event.state!=='idle'&&Number(event.elapsedInStateMs)>=15000&&Number(event.ts)-lastProgressAt>=30000){
          lastProgressAt=Number(event.ts);
          const wait=event.state==='awaiting_llm'?'the model response':event.state==='awaiting_tool'?'the current tool':'the current step';
          this.emit('progress',`Waiting for ${wait} (${Math.round(Number(event.elapsedInStateMs)/1000)} seconds). The task is not finished.`);
        }
      };

      log.onExit((reason, payload) => {
        if (!replay && !privateMode && task.actor.kind !== "rehearsal") rememberOutcome(reason, payload, task.originalPrompt);
        this.onRunExit(context, task, reason, payload);
      });
      log.onStall((payload) => {
        if (log.hasExited) return;
        const waitingOn = String(payload.waitingOn ?? payload.state ?? "unknown work");
        this.notePendingError(`${task.actor.name} stalled while waiting on ${waitingOn}.`);
        log.exit("stream_closed", {
          detail: `watchdog stopped a stalled run while waiting on ${waitingOn}`,
        });
        try { this.inner.interrupt(); }
        catch { /* the separate recovery attempt still starts from the checkpoint */ }
      });
      context.onNoProgress = () => {
        if (log.hasExited) return;
        this.finalFailureMessage = "I stopped a repeating tool loop. The progress is saved, but the task is not complete.";
        log.exit('no_progress', {detail: 'Repeated successful observation without new progress'});
        this.inner.interrupt();
      };
      log.runStart({
        ...this.loopConfig,
        env: safeEnv(),
        actor: task.actor,
        taskId: task.taskId,
        recoveryAttempt: task.recoveryAttempts,
        resumedFrom: task.runDirs.length > 1 ? task.runDirs.at(-2) : null,
      });

      if (context.payloadRecording) {
        const promptRef = recorder.blob(userText);
        recorder.emit({ type: "agent.input", bodyRef: promptRef, recovery: task.recoveryAttempts > 0 });
      }
      if (!checkpoint && !replay && !privateMode && task.actor.kind !== "rehearsal") rememberRequest(userText);
      runInAgentContext(context, () => {
        setAgentDeps(context.deps as any);
        pendingRecorder=undefined;admissionOpen=false;
        this.inner.send(userText, audio, this.lastSendOpts);
      });
    } catch (error) {
      console.error("[echo:log] could not start the run log:", (error as any)?.message ?? error);
      // Admission lasts through durable checkpoint/prompt setup, until provider
      // dispatch. A context object alone does not mean execution has started.
      if(admissionOpen&&admission&&!replay)try{
        const state=taskCoordinator.get(admission.taskId);
        if(state&&state.ownerActorId===admission.ownerActorId&&state.revision===admission.revision
          &&!state.result&&['running','waiting','verifying'].includes(state.status)){
          const blocked=taskCoordinator.finish(state.taskId,{status:'blocked',summary:'This attempt could not start because task/diagnostic storage could not be persisted. No new action started; saved progress is unchanged. Check storage before Retry.'});
          if(!blocked.privateMode&&this.identity.kind!=='rehearsal')consolidateTask({
            taskId:blocked.taskId,scope:blocked.scope as any,goal:blocked.goal,
            outcome:'failed',executionStatus:'failed',verificationRefs:blocked.verificationRefs,
            attemptIds:blocked.attemptIds,actorId:blocked.ownerActorId,origin:'real',
          });
        }
        setPrivateTask(admission.taskId,false);
      }catch{/* Storage may also prevent the blocked state; the explicit error remains. */}
      if(admissionOpen&&this.context&&admission?.taskId===this.context.taskId){
        this.context.loop.stopHeartbeat();
        if(this.checkpoint?.taskId===admission.taskId){
          this.checkpoint.status='exhausted';this.checkpoint.lastExitReason='provider_error';
          this.checkpoint.lastExitDetail='Startup persistence failed before provider dispatch; review storage before retrying.';
          this.persistCheckpoint(this.context.recorder.dir,this.checkpoint);
        }
      }
      try{pendingRecorder?.finish(false,'provider_error',0,'Startup persistence failed before provider dispatch.');}
      catch{/* Preserve the original admission error if terminal recording also fails. */}
      finally{try{pendingRecorder?.close();}catch{/* Best-effort reservation release. */}}
      if (this.context) this.cleanup(this.context);
      replaySession = null;
      resetAgentDeps();
      this.emit("error", `Could not persist task state; action paused: ${(error as any)?.message ?? error}`);
      this.emit("turnEnd");
    }
  }

  get currentTaskId(): string | undefined { return this.context?.taskId ?? this.checkpoint?.taskId; }
  get currentTaskState(): TaskState | null { return this.currentTaskId ? taskCoordinator.get(this.currentTaskId) : null; }
  getTaskId(): string | undefined { return this.currentTaskId; }
  exportTaskState(): TaskState | null { return this.currentTaskState; }
  get projectHint(): string | undefined { return this.inner.projectHint; }
  set projectHint(value: string | undefined) { this.inner.projectHint = value; }
  invalidateMemory(): void { this.inner.invalidateMemory(); }

  private finalizeTask(checkpoint: RecoveryCheckpoint, status: "completed" | "failed" | "cancelled"): void {
    if (isReplaying()) return;
    const existing = taskCoordinator.get(checkpoint.taskId); if (!existing) return;
    let state: TaskState;
    // A delegated Agent Task may already have committed its structured Result
    // through submit_agent_result. The provider stream closing afterwards is
    // transport lifecycle, not a second opinion about the task outcome.
    if (existing.result) state = existing;
    else if (status === "cancelled") state = taskCoordinator.cancel(checkpoint.taskId);
    else {
      // Tool-free responses can complete communication; an action needs an explicit verified postcondition.
      const noActions = Object.keys(existing.calls).length === 0 && checkpoint.actions.length === 0;
      state = taskCoordinator.finish(checkpoint.taskId, { status: existing.status === "completed" ? "completed" : status,
        verificationRefs: existing.verificationRefs.length ? existing.verificationRefs : noActions && status === "completed" ? [`response:${checkpoint.lastRunId}`] : [], summary: checkpoint.lastAssistantText });
    }
    setPrivateTask(checkpoint.taskId, false);
    if (state.privateMode || checkpoint.actor.kind === "rehearsal") return;
    try { consolidateTask({ taskId: state.taskId, scope: state.scope as any, goal: state.goal,
      outcome: state.status === "completed" ? "verified_success" : state.status === "failed" ? "failed" : state.status === "cancelled" ? "cancelled" : "partial",
      executionStatus: status, verificationRefs: state.verificationRefs, attemptIds: state.attemptIds, actorId: state.ownerActorId, origin: "real" }); }
    catch (error) { console.error("[memory] consolidation failed", error); }
  }

  /** The wrapped brain's actual audio capability. */
  get hearsAudio(): boolean {
    return this.inner.hearsAudio;
  }

  /**
   * Cancel a retry that is still waiting out its backoff.
   *
   * The window between a failed attempt and its retry is the one moment when
   * stopping does not stop anything. `cleanup` has already run, so `this.context`
   * is null and the `context?.loop.exit("abort_signal")` in interrupt/stop is a
   * no-op — nothing marks the checkpoint, it stays `pending` on disk, and
   * pendingRecoveries() resumes `pending` at the next launch. The task you
   * killed comes back hours later, at a moment with no context for it.
   *
   * A new command has always cancelled the retry; interrupting and stopping
   * have to mean at least as much as talking over it.
   */
  private cancelPendingRecovery(cause: "superseded" | "halted"): void {
    if (!this.recoveryTimer || this.checkpoint?.status !== "pending") return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    const checkpoint = this.checkpoint;
    checkpoint.status = "cancelled";
    // The user aborted. The provider failure that opened this backoff is no
    // longer the story, and must not be reported as the reason the turn ended.
    checkpoint.lastExitReason = "abort_signal";
    checkpoint.lastExitDetail =
      cause === "halted" ? "cancelled during the recovery backoff" : "superseded by a new command";
    this.finalizeTask(checkpoint, "cancelled");
    const lastDir = checkpoint.runDirs.at(-1);
    if (lastDir) this.persistCheckpoint(lastDir, checkpoint);

    // A new command is about to open its own run, which will end itself. Only a
    // halt leaves the turn with nothing left to close it.
    if (cause === "halted") {
      // Nothing else can end this turn. The failed attempt's `turnEnd` was
      // suppressed precisely so recovery could carry the task on, and the
      // recovery has just been cancelled — so without this the caller waits in
      // "thinking" forever and the cancel is the thing that silently does
      // nothing. For an agent with real machine access, a cancel that appears
      // not to land is worse than a stop that does.
      //
      // `this.checkpoint` is still set here on purpose: emitTerminal reads
      // `lastExitReason` from it, and abort_signal is what keeps the stale
      // provider error from surfacing as this turn's failure.
      this.emit("text", `Stopped. ${checkpoint.actor.name} will not resume that task.`);
      this.emitTerminal(checkpoint.lastRunId);
    }
    this.checkpoint = null;
  }

  private lastSendOpts?: SendOptions;

  noteInterrupted(spoken: string): void {
    this.inner.noteInterrupted?.(spoken);
    this.recordConversation("assistant", `Delivery correction: the reply was interrupted. The user heard only: ${spoken}`, this.currentTaskId);
  }

  send(userText: string, audio?: AudioTurn, opts?: SendOptions): void {
    if(this.appPause){
      if(this.appPause.failed)this.emit('error','Provider pause failed. Restart the brain before continuing; no instruction was started.');
      else if(this.appPause.pending.length<20)this.appPause.pending.push({text:userText,audio,opts});
      else this.emit('error','Too many instructions are waiting for the provider to pause. No additional instruction was queued.');
      return;
    }
    const previousOptions=this.lastSendOpts;
    const scope = opts?.scope ?? {};
    if (opts?.privateMode && !this.privateConversationId) this.privateConversationId = conversationId(`${this.identity.id}:private:${randomUUID()}`, scope);
    if (!opts?.privateMode) this.privateConversationId = undefined;
    this.lastSendOpts = { ...opts, conversationId: opts?.conversationId ?? this.privateConversationId ?? conversationId(this.identity.id, scope) };
    this.cancelPendingRecovery("superseded");
    if (this.context && !this.context.loop.hasExited) {
      // A follow-up can arrive while the provider is still draining the same
      // conversation. Keep it in the owning clone's async context and tape.
      const context = this.context;
      if(isAppOperationRequest(userText)){
        this.appRequest=userText;this.heldAppText='';
        if(this.checkpoint&&context.payloadRecording)this.checkpoint.appRequest=userText;
        this.configureAppPause(context);
      }
      this.lastSendOpts = { ...this.lastSendOpts, taskId: context.taskId, conversationId: context.conversationId, privateMode: context.privateMode, scope: context.scope };
      this.recordConversation("user", userText, context.taskId);
      if (context.payloadRecording) {
        const bodyRef = context.recorder.blob(userText);
        context.recorder.emit({ type: "agent.input", bodyRef, queued: true });
        if (this.checkpoint) {
          (this.checkpoint.followUpPrompts ??= []).push(userText);
          if (this.checkpoint.followUpPrompts.length > 20) this.checkpoint.followUpPrompts.shift();
          writeRecoveryCheckpoint(context.recorder.dir, this.checkpoint);
        }
      }
      runInAgentContext(context, () => this.inner.send(userText, audio, this.lastSendOpts));
      return;
    }
    this.stopped = false;
    if(this.checkpoint?.status==='waiting'){
      const waiting=this.checkpoint;
      const sameConversation=previousOptions?.conversationId===this.lastSendOpts.conversationId&&(previousOptions?.privateMode===true)===(this.lastSendOpts.privateMode===true);
      if(sameConversation&&!isAppOperationRequest(userText)&& !/^(?:stop|cancel|forget|new task|instead)\b/i.test(userText.trim())){
        if(!waiting.privateMode&&waiting.restartable)(waiting.followUpPrompts??=[]).push(userText);
        this.recordConversation('user',userText,waiting.taskId);
        this.beginRun(`${this.appRequest}\n\nUser answer to the clarification: ${userText}`,waiting,audio);return;
      }
      waiting.status='cancelled';this.finalizeTask(waiting,'cancelled');
      const dir=waiting.runDirs.at(-1);if(dir)this.persistCheckpoint(dir,waiting);
      this.checkpoint=null;
    }
    this.beginRun(userText, undefined, audio);
  }

  /** Resume a task left `running` by a dead process. Used once during startup. */
  recoverFromCheckpoint(checkpoint: RecoveryCheckpoint): boolean {
    if (this.context || this.stopped || this.appPause) return false;
    if(checkpoint.status==='waiting')return false;
    if (checkpoint.restartable === false || !checkpoint.originalPrompt) return false;
    if (checkpoint.recoveryAttempts >= checkpoint.maxRecoveryAttempts) {
      checkpoint.status = "exhausted";
      const lastDir = checkpoint.runDirs.at(-1);
      if (lastDir) this.persistCheckpoint(lastDir, checkpoint);
      return false;
    }
    checkpoint.recoveryAttempts++;
    checkpoint.status = "pending";
    this.checkpoint = checkpoint;
    this.emit("text", `${checkpoint.actor.name} was interrupted, so I'm resuming it from the last checkpoint.`);
    this.beginRun(recoveryPrompt(checkpoint), checkpoint);
    return true;
  }

  interrupt(): void {
    if(this.appPause)this.appPause.pending=[];
    this.interrupted = true;
    if(this.checkpoint?.status==='waiting'){
      this.checkpoint.status='cancelled';this.finalizeTask(this.checkpoint,'cancelled');
      const dir=this.checkpoint.runDirs.at(-1);if(dir)this.persistCheckpoint(dir,this.checkpoint);
    }
    this.toolAbort?.abort();
    // Before the unconditional clear below, which would otherwise drop the
    // timer and leave the checkpoint behind as pending.
    this.cancelPendingRecovery("halted");
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.inner.interrupt();
    const context = this.context;
    context?.loop.exit("abort_signal", { detail: "user interrupted" });
  }

  async stop(): Promise<void> {
    if(this.appPause){this.appPause.pending=[];if(this.appPause.timer)clearTimeout(this.appPause.timer);this.appPause.failed=true;}
    this.stopped = true;
    if(this.checkpoint?.status==='waiting'){
      this.checkpoint.status='cancelled';this.finalizeTask(this.checkpoint,'cancelled');
      const dir=this.checkpoint.runDirs.at(-1);if(dir)this.persistCheckpoint(dir,this.checkpoint);
    }
    this.toolAbort?.abort();
    this.interrupted = true;
    // Quitting mid-backoff is the likeliest way to hit this: the loop has just
    // gone quiet after a 429, and the app is closed before the retry fires.
    this.cancelPendingRecovery("halted");
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    const context = this.context;
    context?.loop.exit("abort_signal", { detail: "brain stopped" });
    await this.inner.stop();
    if(context)await endEchoComputerTurn(context.recorder.runId,'Interrupt');
  }
}

/** Age out old run logs under the live log root. Never throws. */
export async function pruneOldRunLogs(): Promise<number> {
  if (configuredReplayRun()) return 0;
  const root = loopLogRoot();
  if (!root) return 0;
  try {
    const {learningEnabled} = await import('../learn/trajectory.js');
    const {archiveDatasetRun} = await import('../learn/dataset-archive.js');
    return await pruneRunLogs(root, {beforeRemove: learningEnabled() ? archiveDatasetRun : undefined});
  } catch (err) {
    console.error("[echo:log] pruning failed:", (err as any)?.message ?? err);
    return 0;
  }
}

/** Unfinished checkpoints owned by processes that are no longer alive. */
export function pendingRecoveries(): RecoveryCheckpoint[] {
  // Exact replay is a side-effect-free lab mode. Never wake real unfinished
  // tasks beside it just because their checkpoints share the normal log root.
  if (configuredReplayRun()) return [];
  const root = loopLogRoot();
  return root ? pendingRecoveryCheckpoints(root) : [];
}
