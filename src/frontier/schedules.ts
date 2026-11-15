import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, dataRoot } from "../memory/paths.js";
import type { MissionState, SwarmDeps, SwarmManager } from "./swarm.js";

/**
 * Recurring work: "check the build every ten minutes", "every morning at nine,
 * tell me what's on my calendar".
 *
 * `schedule_task` used to be a bare `setInterval` in the tool handler that
 * constructed a new brain on every tick and sent it one message. Four things
 * followed from that, none of them visible:
 *
 *   - Nothing ever stopped those brains. Each tick left one behind with its
 *     memory subscriptions, and on a brain that connects MCP servers, another
 *     set of server child processes.
 *   - The schedule lived in a timer. Restart Echo and "every morning" was
 *     gone, with nothing to say it had been there.
 *   - A run that outlasted its interval overlapped the next, without limit,
 *     outside the swarm's concurrency cap.
 *   - The floor was one second, there was no way to list or cancel one, and
 *     what a run found went nowhere the user could read it.
 *
 * A schedule is now a saved record, and each run is an ordinary swarm Mission:
 * capped, budgeted, cleaned up when it ends, on the board while it runs, and
 * with a Result `check_agents` can read afterwards.
 *
 * The clock and the store are injected so the whole thing tests without
 * waiting or touching the real data folder.
 */

/** A run is a full model session; anything more frequent is a runaway, not a schedule. */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_SCHEDULES = 20;
/** After a start, let Echo finish coming up before a missed run is made up. */
const STARTUP_GRACE_MS = 60_000;
/** setTimeout cannot hold more than 2^31-1 ms; re-arm at least this often. */
const MAX_TIMER_MS = 60 * 60_000;

export interface Schedule {
  id: string;
  goal: string;
  /** Seconds between runs. Exactly one of this and `dailyAt` is set. */
  intervalSeconds?: number;
  /** Local time of day, "HH:MM", for a once-a-day run. */
  dailyAt?: string;
  scope: Record<string, unknown>;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastMissionId?: string;
  /** What the most recent run came to, in a sentence. */
  lastOutcome?: string;
  runs: number;
}

export interface NewSchedule {
  goal: string;
  intervalSeconds?: number;
  dailyAt?: string;
  scope?: Record<string, unknown>;
}

type Host = Pick<SwarmManager, "submitMission" | "getMission" | "isMissionLive">;

interface ScheduleFile { version: 1; schedules: Schedule[] }

const DAILY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** The next local HH:MM strictly after `from`. Date arithmetic, so a DST change lands on the wall clock. */
export function nextDailyRun(dailyAt: string, from: number): number {
  const match = DAILY.exec(dailyAt.trim());
  if (!match) throw new Error(`"${dailyAt}" is not a time of day. Use 24-hour HH:MM, for example 09:00.`);
  const next = new Date(from);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** "every 10 minutes", "daily at 09:00" — for the user and for the board. */
export function describeCadence(schedule: Pick<Schedule, "intervalSeconds" | "dailyAt">): string {
  if (schedule.dailyAt) return `daily at ${schedule.dailyAt}`;
  const seconds = schedule.intervalSeconds ?? 0;
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "every day" : `every ${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "every hour" : `every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "every minute" : `every ${seconds / 60} minutes`;
  return `every ${seconds} seconds`;
}

export class Scheduler {
  private schedules = new Map<string, Schedule>();
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private deps: (() => SwarmDeps) | null = null;
  private stopped = false;

  constructor(
    private readonly host: Host,
    // Late-bound, so a test that moves the clock moves this one too.
    private readonly now: () => number = () => Date.now(),
    private readonly file: () => string = () => join(dataRoot(), "schedules.json")
  ) {}

  /**
   * Restore saved schedules and begin running them.
   *
   * A run missed while Echo was closed is made up ONCE, a minute after start,
   * however many were missed: a week away must not come back as a week of
   * queued runs. Idempotent, so the tool can call it as well as startup.
   */
  start(deps: () => SwarmDeps): void {
    this.deps = deps;
    this.stopped = false;
    this.load();
    const now = this.now();
    let changed = false;
    for (const schedule of this.schedules.values()) {
      if (schedule.nextRunAt <= now) {
        schedule.nextRunAt = now + STARTUP_GRACE_MS;
        changed = true;
      }
    }
    if (changed) this.save();
    this.arm();
  }

  /** Stop firing. Saved schedules stay saved and resume at the next start. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  add(input: NewSchedule): Schedule {
    this.load();
    const goal = String(input.goal ?? "").trim();
    if (!goal) throw new Error("A scheduled task needs to say what to do.");
    const hasInterval = input.intervalSeconds !== undefined && input.intervalSeconds !== null;
    const hasDaily = typeof input.dailyAt === "string" && input.dailyAt.trim() !== "";
    if (hasInterval === hasDaily) throw new Error("Give either intervalSeconds or dailyAt (HH:MM), not both and not neither.");
    if (this.schedules.size >= MAX_SCHEDULES) throw new Error(`There are already ${MAX_SCHEDULES} scheduled tasks. Cancel one first.`);
    const now = this.now();
    const schedule: Schedule = {
      id: `sched-${randomUUID().slice(0, 8)}`,
      goal: goal.slice(0, 4000),
      scope: structuredClone(input.scope ?? {}),
      createdAt: now,
      nextRunAt: 0,
      runs: 0,
    };
    if (hasDaily) {
      schedule.dailyAt = input.dailyAt!.trim().replace(/^(\d):/, "0$1:");
      schedule.nextRunAt = nextDailyRun(schedule.dailyAt, now);
    } else {
      const seconds = Number(input.intervalSeconds);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("intervalSeconds must be a positive number.");
      schedule.intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds));
      schedule.nextRunAt = now + schedule.intervalSeconds * 1000;
    }
    this.schedules.set(schedule.id, schedule);
    this.save();
    this.arm();
    return structuredClone(schedule);
  }

  list(): Schedule[] {
    this.load();
    let changed = false;
    for (const schedule of this.schedules.values()) changed = this.refreshOutcome(schedule) || changed;
    if (changed) this.save();
    return [...this.schedules.values()].sort((a, b) => a.nextRunAt - b.nextRunAt).map((s) => structuredClone(s));
  }

  /** Stop a schedule for good. A run already in progress finishes; it is the schedule that ends. */
  cancel(id: string): Schedule | null {
    this.load();
    const schedule = this.schedules.get(id);
    if (!schedule) return null;
    this.schedules.delete(id);
    this.save();
    this.arm();
    return structuredClone(schedule);
  }

  /** Start every schedule that is due. Returns the ids it launched. Exposed for tests. */
  runDue(): string[] {
    this.load();
    const now = this.now();
    const launched: string[] = [];
    let changed = false;
    for (const schedule of this.schedules.values()) {
      if (schedule.nextRunAt > now) continue;
      changed = true;
      this.refreshOutcome(schedule);
      // The next occurrence is fixed BEFORE launching, so a launch that throws
      // cannot leave the schedule due forever and firing on every tick.
      schedule.nextRunAt = schedule.dailyAt
        ? nextDailyRun(schedule.dailyAt, now)
        : now + (schedule.intervalSeconds ?? MIN_INTERVAL_SECONDS) * 1000;
      if (schedule.lastMissionId && this.host.isMissionLive(schedule.lastMissionId)) {
        schedule.lastOutcome = "Skipped a run: the previous one was still working.";
        continue;
      }
      if (this.launch(schedule, now)) launched.push(schedule.id);
    }
    if (changed) this.save();
    return launched;
  }

  private launch(schedule: Schedule, now: number): boolean {
    const deps = this.deps?.();
    if (!deps) {
      schedule.lastOutcome = "Not started: the scheduler has no way to launch an agent yet.";
      return false;
    }
    const missionId = `${schedule.id}-${now.toString(36)}`;
    let result: ReturnType<Host["submitMission"]>;
    try {
      result = this.host.submitMission({
        id: missionId,
        goal: schedule.goal,
        scope: { ...schedule.scope, scheduleId: schedule.id },
        tasks: [{
          id: "work",
          lane: "knowledge",
          goal: `${schedule.goal}\n\nThis is a scheduled run (${describeCadence(schedule)}, run ${schedule.runs + 1}). ` +
            `Nobody may be at the desk: do the work, then submit a Result that states what you found or changed, so it can be read later.`,
        }],
      }, deps);
    } catch (error) {
      result = { ok: false, reason: String(error instanceof Error ? error.message : error) };
    }
    schedule.lastRunAt = now;
    if (!result.ok) {
      schedule.lastOutcome = `Could not start: ${result.reason ?? "unknown reason"}`;
      console.error(`[scheduler] ${schedule.id} could not start: ${result.reason ?? "unknown reason"}`);
      return false;
    }
    schedule.runs++;
    schedule.lastMissionId = result.missionId;
    schedule.lastOutcome = "Running.";
    // An agent that cannot be constructed (a missing key, say) fails inside the
    // swarm, which records it on the Mission. Surface that here as well, so the
    // schedule itself says why nothing happened.
    this.refreshOutcome(schedule);
    if (schedule.lastOutcome.startsWith("failed")) console.error(`[scheduler] ${schedule.id} run did not start: ${schedule.lastOutcome}`);
    return true;
  }

  /** Bring `lastOutcome` up to date from the last run's Mission. True if it changed. */
  private refreshOutcome(schedule: Schedule): boolean {
    if (!schedule.lastMissionId) return false;
    let mission: MissionState | null = null;
    try { mission = this.host.getMission(schedule.lastMissionId); } catch { /* a forgotten mission keeps its last known outcome */ }
    if (!mission) return false;
    const work = Object.values(mission.tasks)[0];
    const summary = (work?.result?.summary ?? mission.result?.summary ?? "").trim();
    const outcome = mission.status === "running"
      ? "Running."
      : `${mission.status}${summary ? `: ${summary.slice(0, 400)}` : ""}`;
    if (outcome === schedule.lastOutcome) return false;
    schedule.lastOutcome = outcome;
    return true;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || !this.deps || !this.schedules.size) return;
    const soonest = Math.min(...[...this.schedules.values()].map((s) => s.nextRunAt));
    const delay = Math.min(MAX_TIMER_MS, Math.max(1000, soonest - this.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.runDue(); }
      catch (error) { console.error("[scheduler] tick failed:", (error as any)?.message ?? error); }
      this.arm();
    }, delay);
    // A schedule waiting for tomorrow must not hold a quitting app open.
    this.timer.unref?.();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.file();
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as ScheduleFile;
      for (const raw of Array.isArray(parsed?.schedules) ? parsed.schedules : []) {
        const valid = raw && typeof raw.id === "string" && /^sched-[a-z0-9-]{1,40}$/.test(raw.id)
          && typeof raw.goal === "string" && raw.goal.trim()
          && Number.isFinite(raw.nextRunAt)
          && ((typeof raw.intervalSeconds === "number" && raw.intervalSeconds >= MIN_INTERVAL_SECONDS && raw.dailyAt === undefined)
            || (typeof raw.dailyAt === "string" && DAILY.test(raw.dailyAt) && raw.intervalSeconds === undefined));
        // A hand-edited or half-written entry is dropped rather than trusted:
        // an invalid interval here would be an agent launching in a tight loop.
        if (!valid || this.schedules.size >= MAX_SCHEDULES) continue;
        this.schedules.set(raw.id, { ...raw, scope: raw.scope && typeof raw.scope === "object" ? raw.scope : {}, runs: Number(raw.runs) || 0 });
      }
    } catch (error) {
      console.error(`[scheduler] could not read ${file}: ${(error as any)?.message ?? error}`);
    }
  }

  private save(): void {
    try {
      atomicWrite(this.file(), `${JSON.stringify({ version: 1, schedules: [...this.schedules.values()] } satisfies ScheduleFile, null, 2)}\n`);
    } catch (error) {
      console.error("[scheduler] could not save schedules:", (error as any)?.message ?? error);
    }
  }
}

let shared: Scheduler | null = null;

/** The app's one scheduler, bound to the shared swarm on first use. */
export async function scheduler(): Promise<Scheduler> {
  if (!shared) {
    const { swarm } = await import("./swarm.js");
    shared = new Scheduler(swarm);
  }
  return shared;
}

/** Test seam: forget the shared instance so a new data root is read afresh. */
export function _resetSchedulerForTests(): void {
  shared?.stop();
  shared = null;
}
