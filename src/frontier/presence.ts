import { EventEmitter } from "node:events";
import { run, osascript } from "../tools/shell.js";
import * as vision from "../tools/vision.js";
import {hotkey} from '../tools/computer-actions.js';

/**
 * Knows whether you are at the desk, and reacts when you leave.
 *
 * The camera is sampled on a slow timer rather than held open — a webcam light
 * that never goes off is unnerving, and presence changes on the scale of
 * minutes, not frames.
 *
 * Two rules stop this being annoying. Leaving must be confirmed across several
 * consecutive checks, because one missed face (you leaned out of frame, someone
 * walked past the lens) is not an absence. Returning is believed immediately,
 * since the cost of being slow to notice you are back is far higher than the
 * cost of a stray reading.
 */
export type PresenceState = "present" | "away" | "unknown";

export interface PresenceEvents {
  changed: [PresenceState, PresenceState];
  left: [];
  returned: [];
  /** Camera worked but the room is too dark to judge. */
  tooDark: [];
}

export interface PresenceOptions {
  /** Seconds between camera checks. */
  intervalSeconds: number;
  /** Consecutive empty readings before you count as away. */
  missesBeforeAway: number;
  /** Pause playing media when you leave. */
  pauseMedia: boolean;
  /** Legacy away-lock request; automatic locking is currently unavailable. */
  lockScreen: boolean;
  /** Legacy delay retained for configuration compatibility. */
  lockAfterSeconds: number;
}

export const DEFAULT_PRESENCE: PresenceOptions = {
  intervalSeconds: 30,
  missesBeforeAway: 3, // ~90s of absence before acting
  pauseMedia: true,
  lockScreen: false, // locking is disruptive; opt in deliberately
  lockAfterSeconds: 120,
};

const AUTOMATIC_LOCK_UNAVAILABLE = "Automatic away-lock is unavailable: no supported host lock operation is configured. No automatic screen lock will be attempted.";

export class PresenceMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private misses = 0;
  private state: PresenceState = "unknown";
  private lastBrightness = 1;
  private pausedByUs = false;

  /**
   * @param read where readings come from. Injectable so the debounce rules —
   * the part that decides whether you left — can be tested without
   * a camera, which no automated run has access to.
   */
  constructor(
    private opts: PresenceOptions = DEFAULT_PRESENCE,
    private read: () => Promise<vision.Presence> = () => vision.presence()
  ) {
    super();
  }

  get current(): PresenceState {
    return this.state;
  }

  start() {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.opts.intervalSeconds * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  configure(patch: Partial<PresenceOptions>) {
    this.opts = { ...this.opts, ...patch };
  }

  /** Run a single check now. Exposed for tests and for "can you see me?". */
  async checkOnce() {
    return this.check();
  }

  private async check() {
    const reading = await this.read().catch(() => null);
    if (!reading || reading.error) return; // camera busy or unavailable; say nothing

    this.lastBrightness = (reading as any).brightness ?? 1;

    // A dark room is not an absent user. Treating it as one would lock the
    // screen every time the lights went down.
    if ((reading as any).dark && !reading.present) {
      this.emit("tooDark");
      return;
    }

    if (reading.present) {
      this.misses = 0;
      if (this.state !== "present") this.transition("present");
      return;
    }

    this.misses++;
    if (this.misses >= this.opts.missesBeforeAway && this.state !== "away") {
      this.transition("away");
    }
  }

  private transition(next: PresenceState) {
    const prev = this.state;
    this.state = next;
    this.emit("changed", next, prev);

    if (next === "away") {
      this.emit("left");
      void this.onLeft();
    } else if (next === "present") {
      this.emit("returned");
      void this.onReturned();
    }
  }

  private async onLeft() {
    // An unattended presence transition has no approved foreground LCU owner.
    // Disable automatic locking explicitly rather than scheduling doomed input.
    if (this.opts.lockScreen) {
      console.error('[echo] Automatic lock not performed:', AUTOMATIC_LOCK_UNAVAILABLE);
    }
    if (this.opts.pauseMedia) {
      const paused = await pauseAllMedia();
      // Remember whether we were the one who paused, so returning only resumes
      // what we stopped — never something the user deliberately paused earlier.
      this.pausedByUs = paused;
    }
  }

  private async onReturned() {
    if (this.pausedByUs) {
      this.pausedByUs = false;
      await resumeMedia();
    }
  }

  /** True when the camera last reported nobody at the desk. */
  isAway(): boolean {
    // "unknown" is deliberately not away: a dark room or an unavailable camera
    // must never be read as an empty desk.
    return this.state === "away";
  }

  describe(): string {
    const where =
      this.state === "present" ? "You're at the desk" :
      this.state === "away" ? "You've been away" : "I haven't checked yet";
    const light = this.lastBrightness < 0.06 ? " (the room is very dark)" : "";
    const acting = [
      this.opts.pauseMedia ? "pause media" : null,
    ].filter(Boolean).join(" and ");
    const lockNotice = this.opts.lockScreen ? ` ${AUTOMATIC_LOCK_UNAVAILABLE}` : "";
    return `${where}${light}. When you leave I ${acting || "do nothing"}.${lockNotice}`;
  }
}

// ---- actions --------------------------------------------------------------

/**
 * Pause whatever is playing. Returns true if anything was actually paused.
 *
 * Each app is asked only if it is already running — launching Music in order to
 * pause it would be absurd — and each is tried independently so one failure
 * does not stop the rest.
 */
export async function pauseAllMedia(): Promise<boolean> {
  let paused = false;

  for (const app of ["Music", "Spotify"]) {
    const running = await osascript(
      `tell application "System Events" to (name of processes) contains "${app}"`
    ).catch(() => "false");
    if (!/true/i.test(running)) continue;
    const state = await osascript(`tell application "${app}" to player state as string`).catch(() => "");
    if (/playing/i.test(state)) {
      await osascript(`tell application "${app}" to pause`).catch(() => "");
      paused = true;
    }
  }

  // Keep actual player APIs. Do not emulate a media key after an API refusal.
  return paused;
}

export async function resumeMedia(): Promise<void> {
  for (const app of ["Music", "Spotify"]) {
    const running = await osascript(
      `tell application "System Events" to (name of processes) contains "${app}"`
    ).catch(() => "false");
    if (!/true/i.test(running)) continue;
    const state = await osascript(`tell application "${app}" to player state as string`).catch(() => "");
    if (/paused/i.test(state)) {
      await osascript(`tell application "${app}" to play`).catch(() => "");
      return;
    }
  }
}

/** Lock the screen the way the keyboard shortcut does. */
export async function lockScreen(): Promise<void> {
  // Source: https://support.apple.com/en-gb/102650 (Control-Command-Q).
  // Requires an actual approved Echo foreground turn. Timers without that
  // authority fail visibly, never fall back to hidden AppleScript or sleep.
  await hotkey(['ctrl','cmd'],'q');
}

export const presenceMonitor = new PresenceMonitor();
