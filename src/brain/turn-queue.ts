import { AsyncResource } from "node:async_hooks";

/**
 * Messages that reach a brain while its loop is already running.
 *
 * Gemini, OpenAI and Ollama used to push a new message straight into the live
 * history and only start a loop if none was running. Two things went wrong:
 *
 *   - Mid-task, the message landed between a tool call and that call's result.
 *     Every provider requires the result to follow the call directly, so the
 *     next request could be rejected — and the bad history went out again on
 *     every later turn.
 *   - Nothing looked at the history once the loop finished, so a message that
 *     arrived during a task was never answered. "Stop — now do X" lost X,
 *     because X arrived while the stopped loop was still unwinding.
 *
 * Now a message sent while busy waits here. A loop that is still working takes
 * it in at its next step boundary (`takeForRunningLoop`). A loop that was
 * stopped hands the queue to a fresh loop (`takeForNextLoop`).
 *
 * Each entry keeps the async context it was sent from. After a stop, the
 * recorder has already opened a new run for the next command, and that
 * command's tools must be attributed to the new run, not the one that just
 * ended — so the fresh loop is started inside the context the command arrived
 * in, not the one the old loop happens to be finishing in.
 */
export interface QueuedTurn<T> {
  item: T;
  /** The sender asked for a fresh conversation (a different task or project). */
  reset: boolean;
  /** Runs `fn` in the async context this entry was sent from. */
  resume: (fn: () => void) => void;
}

export class TurnQueue<T> {
  private entries: QueuedTurn<T>[] = [];

  push(item: T, reset = false): void {
    this.entries.push({ item, reset, resume: AsyncResource.bind((fn: () => void) => fn()) });
  }

  get size(): number {
    return this.entries.length;
  }

  /** Follow-ups a loop that is still working can take in at a step boundary. */
  takeForRunningLoop(): T[] {
    // A follow-up that asks for a fresh conversation cannot be folded into
    // this one; it, and anything after it, waits for the next loop.
    const stopAt = this.entries.findIndex((e) => e.reset);
    const n = stopAt < 0 ? this.entries.length : stopAt;
    return this.entries.splice(0, n).map((e) => e.item);
  }

  /** Everything, for a fresh loop started after the current one ends. */
  takeForNextLoop(): QueuedTurn<T>[] {
    return this.entries.splice(0);
  }

  /** A stop cancels what was queued for the task being stopped. */
  clear(): void {
    this.entries.length = 0;
  }
}
