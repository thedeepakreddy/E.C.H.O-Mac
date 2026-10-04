import { AsyncLocalStorage } from "node:async_hooks";
import type { Recorder } from "./recorder.js";
import type { LoopLog } from "./loop-log.js";

/** A stable identity for the Echo instance that owns a run. */
export interface AgentIdentity {
  id: string;
  name: string;
  kind: "main" | "clone" | "scheduled" | "research" | "rehearsal";
  parentTaskId?: string;
}

/**
 * State that must follow one async agent loop, even while other clones run.
 *
 * A mutable object is intentional. Claude keeps one async iterator alive over
 * several turns; replacing `loop` and `recorder` lets that iterator see the
 * current turn without falling back to process-global state.
 */
export interface AgentRunContext {
  identity: AgentIdentity;
  taskId: string;
  conversationId?: string;
  recorder: Recorder;
  loop: LoopLog;
  payloadRecording: boolean;
  privateMode?: boolean;
  scope?: Record<string, any>;
  /** Provider identity is used to enforce memory model-access policy at tool boundaries. */
  provider?: string;
  /** Execution authority, independent of which tools a model can see. */
  allowedTools?: ReadonlySet<string>;
  /** Cancels invocation-owned work when this brain is interrupted or stopped. */
  toolSignal?: AbortSignal;
  deps?: unknown;
  /** New turn for the same long-lived provider session (not another clone). */
  successor?: AgentRunContext;
  observationEpoch?: number;
  onNoProgress?: () => void;
  toolCatalog?: {discover(query: string): Promise<unknown>};
}

const storage = new AsyncLocalStorage<AgentRunContext | null>();

export function currentAgentRunContext(): AgentRunContext | null {
  let context = storage.getStore() ?? null;
  // Claude's async iterator outlives a single turn. Follow the owner-specific
  // handoff instead of consulting a process-global "current" recorder, which
  // is exactly what caused concurrent clones to cross-write their logs.
  while (context?.successor) context = context.successor;
  return context;
}

export function runInAgentContext<T>(context: AgentRunContext, action: () => T): T {
  return storage.run(context, action);
}
/** A background lifecycle must not inherit the launching turn's recorder or cancellation. */
export function outsideAgentContext<T>(action: () => T): T {return storage.run(null,action);}
