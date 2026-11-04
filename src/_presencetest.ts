/**
 * Presence debounce rules.
 *
 * These decide whether you are reported absent, so the failure that matters is
 * declaring you absent when you merely leaned out of frame.
 *
 *   npm run presencetest
 */
import { PresenceMonitor, DEFAULT_PRESENCE } from "./frontier/presence.js";
import type { Presence } from "./tools/vision.js";
import { mock } from "node:test";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const reading = (p: Partial<Presence>): Presence =>
  ({ present: false, faces: 0, prominence: 0, brightness: 0.5, dark: false, ...p });

console.log("\nPresence detection\n");

// Never act on side effects during tests.
const quiet = { ...DEFAULT_PRESENCE, pauseMedia: false, lockScreen: false, missesBeforeAway: 3 };

// ---- leaving needs confirmation ------------------------------------------
let next: Presence = reading({ present: true, faces: 1 });
const m = new PresenceMonitor(quiet, async () => next);
const events: string[] = [];
m.on("left", () => events.push("left"));
m.on("returned", () => events.push("returned"));
m.on("tooDark", () => events.push("dark"));

await m.checkOnce();
ok(m.current === "present", "seeing a face means present");

next = reading({ present: false });
await m.checkOnce();
ok(m.current === "present", "one missed reading does NOT mean you left");
await m.checkOnce();
ok(m.current === "present", "two missed readings still does not");
await m.checkOnce();
ok(m.current === "away", "three consecutive misses does");
ok(events.filter((e) => e === "left").length === 1, "leaving fires exactly once");

// ---- returning is immediate ----------------------------------------------
next = reading({ present: true, faces: 1 });
await m.checkOnce();
ok(m.current === "present", "a single sighting brings you straight back");
ok(events.includes("returned"), "returning is announced");

// ---- a miss part-way through resets the count ----------------------------
next = reading({ present: false });
await m.checkOnce();
await m.checkOnce();
next = reading({ present: true, faces: 1 });
await m.checkOnce();          // seen again — counter must reset
next = reading({ present: false });
await m.checkOnce();
await m.checkOnce();
ok(m.current === "present", "the miss counter resets when you are seen again");

// ---- darkness is not absence ---------------------------------------------
const darkEvents: string[] = [];
let darkReading: Presence = reading({ present: false, dark: true, brightness: 0.01 });
const d = new PresenceMonitor(quiet, async () => darkReading);
d.on("left", () => darkEvents.push("left"));
d.on("tooDark", () => darkEvents.push("dark"));
for (let i = 0; i < 6; i++) await d.checkOnce();
ok(d.current !== "away", "a dark room is never treated as you having left");
ok(darkEvents.includes("dark") && !darkEvents.includes("left"), "it reports darkness instead");

// ---- a camera error changes nothing --------------------------------------
const e = new PresenceMonitor(quiet, async () => reading({ error: "camera busy" }));
for (let i = 0; i < 5; i++) await e.checkOnce();
ok(e.current === "unknown", "a camera error leaves the state unknown, not away");

// ---- unsupported automatic locking fails closed ---------------------------
// Capture timers without ever invoking their callbacks: even the RED version
// cannot reach a keyboard, shell, camera or provider through this fixture.
const lockTimers = mock.method(globalThis, "setTimeout", () => undefined);
const notices: string[] = [];
const lockErrors = mock.method(console, "error", (...args: unknown[]) => {
  notices.push(args.map(String).join(" "));
});
try {
  for (const delay of [0, 120]) {
    let lockReading = reading({ present: true, faces: 1 });
    const locking = new PresenceMonitor({ ...quiet, lockScreen: true, lockAfterSeconds: delay }, async () => lockReading);
    const lockEvents: string[] = [];
    locking.on("left", () => lockEvents.push("left"));
    locking.on("returned", () => lockEvents.push("returned"));
    const before = notices.length;
    try {
      ok(/automatic.*lock.*unavailable/i.test(locking.describe()), `requested away-lock (${delay}s) is visibly unavailable before any reading`);
      ok(!/lock after \d+s/i.test(locking.describe()), "status does not promise an unsupported lock");
      await locking.checkOnce();
      lockReading = reading({ present: false });
      await locking.checkOnce();
      await locking.checkOnce();
      ok(locking.current === "present", "requesting away-lock retains the absence debounce");
      await locking.checkOnce();
      ok(locking.isAway() && lockEvents.filter(event => event === "left").length === 1, "confirmed absence is still announced");
      ok(lockTimers.mock.callCount() === 0, "confirmed absence schedules no automatic lock or input callback");
      ok(notices.length === before + 1 && /automatic.*lock.*unavailable/i.test(notices.at(-1) ?? ""), "confirmed absence emits an honest unavailability notice");
      await locking.checkOnce();
      ok(notices.length === before + 1, "repeated empty readings do not repeat the lock notice");
      lockReading = reading({ present: true, faces: 1 });
      await locking.checkOnce();
      ok(locking.current === "present" && lockEvents.filter(event => event === "returned").length === 2, "returning remains immediate with away-lock requested");
      locking.configure({ lockScreen: false });
      ok(!/automatic.*lock.*unavailable/i.test(locking.describe()), "disabling the request clears its status notice");
      locking.configure({ lockScreen: true });
      ok(/automatic.*lock.*unavailable/i.test(locking.describe()), "re-enabling the request reports unavailability immediately");
    } finally {
      locking.stop();
    }
  }
  const before = notices.length;
  const disabled = new PresenceMonitor(quiet, async () => reading({ present: false }));
  const darkLock = new PresenceMonitor({ ...quiet, lockScreen: true }, async () => reading({ dark: true }));
  const errorLock = new PresenceMonitor({ ...quiet, lockScreen: true }, async () => reading({ error: "camera busy" }));
  for (let i = 0; i < 5; i++) {
    await disabled.checkOnce();
    await darkLock.checkOnce();
    await errorLock.checkOnce();
  }
  ok(disabled.isAway(), "presence detection still works with away-lock disabled");
  ok(darkLock.current === "unknown" && errorLock.current === "unknown", "requested away-lock does not turn darkness or camera errors into absence");
  ok(notices.length === before && lockTimers.mock.callCount() === 0, "disabled locking and invalid readings produce no lock action or absence notice");
  ok(/automatic.*lock.*unavailable/i.test(errorLock.describe()), "lock unavailability is described even when presence is unknown");
  const mediaStatus = new PresenceMonitor({ ...quiet, pauseMedia: true, lockScreen: true }, async () => reading({}));
  ok(/pause media/.test(mediaStatus.describe()) && /automatic.*lock.*unavailable/i.test(mediaStatus.describe()), "status retains the media setting alongside the unsupported lock notice");
} finally {
  lockTimers.mock.restore();
  lockErrors.mock.restore();
}

console.log(`\n${pass}/${pass + fail} presence checks passed\n`);
process.exit(fail ? 1 : 0);
