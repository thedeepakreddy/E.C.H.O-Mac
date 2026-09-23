/**
 * When has Echo actually stopped talking?
 *
 * On the realtime path the model says `turnComplete` when it stops GENERATING,
 * which is not when the speaker stops. Audio handed to the player is still
 * queued, sometimes for several seconds. Re-arming the microphone at
 * turnComplete points an un-gated mic at Echo's own voice and burns the
 * conversation window down during its own reply.
 *
 * The obvious fix — wait for the player's `drained` event — was worse. It did
 * not arrive, the "still speaking" flag stuck at true, and because the
 * auto-listen guard reads that flag, the conversation window then never opened
 * AT ALL: every turn needed the wake word again. An event that may never fire
 * is not something re-arming the microphone can depend on.
 *
 * So the end of speech is COMPUTED. The audio is a known format at a known
 * rate, so the bytes handed to the player say exactly how long they take to
 * play. `drained` is still honoured as an early finish when it does come, and a
 * hard cap guarantees the flag always clears. The worst case is re-arming
 * slightly late, never never.
 */
export interface SpeechClockOptions {
  /** Playback rate in bytes per second (24 kHz mono PCM16 = 48000). */
  bytesPerSecond: number;
  /** The flag can never stay set longer than this, whatever goes wrong. */
  capMs?: number;
  /** A beat of slack so the mic does not open on the final syllable. */
  slackMs?: number;
  /** Injected in tests; defaults to the real timer and clock. */
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (h: any) => void;
  now?: () => number;
}

export class SpeechClock {
  private speakingFlag = false;
  private turnPending = false;
  private bytes = 0;
  private startedAt = 0;
  private timer: any = null;

  private readonly bytesPerSecond: number;
  private readonly capMs: number;
  private readonly slackMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => any;
  private readonly clearTimer: (h: any) => void;
  private readonly now: () => number;

  /** @param onEnd called once per turn, when the speaker is genuinely quiet. */
  constructor(opts: SpeechClockOptions, private readonly onEnd: () => void) {
    this.bytesPerSecond = opts.bytesPerSecond;
    this.capMs = opts.capMs ?? 120_000;
    this.slackMs = opts.slackMs ?? 150;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Is audio still expected to be coming out of the speaker? */
  get speaking(): boolean {
    return this.speakingFlag;
  }

  /** Audio handed to the player. */
  noteAudio(byteLength: number): void {
    if (!this.speakingFlag) {
      this.startedAt = this.now();
      this.bytes = 0;
    }
    this.speakingFlag = true;
    this.bytes += byteLength;
    // More audio for a turn already finished generating: extend the estimate.
    if (this.turnPending) this.schedule();
  }

  /** The model finished generating. Speech ends once the queue plays out. */
  noteTurnComplete(): void {
    if (!this.speakingFlag) {
      // Nothing was ever spoken — a tool-only turn, or a silent failure. The
      // turn still has to END, or the mic is never re-armed and the user is
      // back to saying the wake word. Mark it pending so finish() reports it.
      this.turnPending = true;
      this.finish();
      return;
    }
    this.turnPending = true;
    this.schedule();
  }

  /** The player says it is empty: finish early rather than waiting out the clock. */
  noteDrained(): void {
    if (!this.speakingFlag && !this.turnPending) return;
    this.finish();
  }

  /** A new turn must never inherit the last one's state. */
  reset(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.speakingFlag = false;
    this.turnPending = false;
    this.bytes = 0;
    this.startedAt = 0;
  }

  private schedule(): void {
    if (this.timer) this.clearTimer(this.timer);
    const playMs = (this.bytes / this.bytesPerSecond) * 1000;
    const elapsed = this.startedAt ? this.now() - this.startedAt : 0;
    const remaining = Math.max(0, Math.min(playMs - elapsed, this.capMs));
    this.timer = this.setTimer(() => this.finish(), remaining + this.slackMs);
  }

  private finish(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const wasPending = this.turnPending;
    this.speakingFlag = false;
    this.turnPending = false;
    this.bytes = 0;
    this.startedAt = 0;
    // Only a turn that actually reached turnComplete ends here; a bare
    // `drained` between sentences must not close a turn still being generated.
    if (wasPending) this.onEnd();
  }
}

/**
 * Is this capture Echo's own voice, fed back in?
 *
 * Pure, and separate from the clock, because getting it wrong is expensive in
 * both directions: too loose and Echo answers itself in a paid loop, too tight
 * and it goes deaf to the user. Both have now happened.
 *
 * EVERY TIME ARGUMENT HERE IS `performance.now()`. The first version compared
 * `CaptureMeta.captureStartAt` (monotonic) against `Date.now()` (wall clock);
 * a monotonic reading is always the smaller number, so every capture looked
 * like self-audio and Echo stopped hearing anything at all after its first
 * reply. Mixing the two is silent and total.
 */
export function isSelfAudio(opts: {
  /** Echo is producing audio at this instant. */
  speaking: boolean;
  /** `CaptureMeta.captureStartAt`, monotonic. Undefined when unknown. */
  captureStartAt?: number;
  /** When Echo's audio last stopped, monotonic. */
  spokeUntil: number;
  /** The tail of Echo's own audio can trip the detector just after the end. */
  graceMs?: number;
}): boolean {
  if (opts.speaking) return true;
  if (opts.captureStartAt === undefined) return false;
  return opts.captureStartAt < opts.spokeUntil + (opts.graceMs ?? 250);
}

