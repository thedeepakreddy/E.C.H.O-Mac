/**
 * Recurring tasks.
 *
 *   npm run schedulestest
 *
 * `schedule_task` used to be a setInterval that built a new brain on every
 * tick: never stopped, gone at restart, free to overlap itself, as often as
 * once a second, with no way to list or cancel it. These checks pin what a
 * schedule is now — a saved record whose runs are ordinary swarm Missions —
 * against a fake clock, so nothing here waits and nothing touches real data.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "echo-schedules-"));
process.env.ECHO_DATA_ROOT = root;
process.env.ECHO_MEMORY_ROOT = join(root, "memory");
process.env.ECHO_LOG_DIR = join(root, "logs");
process.env.ECHO_LOG_QUIET = "1";

const { Scheduler, nextDailyRun, describeCadence, MIN_INTERVAL_SECONDS, MAX_SCHEDULES } = await import("./frontier/schedules.js");
const { SwarmManager } = await import("./frontier/swarm.js");
const { taskCoordinator } = await import("./memory/task-state.js");
const { classify } = await import("./safety/risk.js");
const { TOOLS } = await import("./tools/registry.js");

let pass = 0;
const ok = (label: string) => { pass++; console.log(`  ✓ ${label}`); };

// A local wall clock the test owns. 08:00 on an ordinary weekday.
let now = new Date(2026, 10, 12, 8, 0, 0).getTime();
const advance = (seconds: number) => { now += seconds * 1000; };

/** The slice of the swarm a scheduler uses, recording what it was asked to start. */
function fakeHost() {
  const submitted: any[] = [];
  const missions = new Map<string, any>();
  const live = new Set<string>();
  let refuse: string | null = null;
  return {
    submitted, missions, live,
    refuseNext(reason: string) { refuse = reason; },
    finish(id: string, status: string, summary: string) {
      live.delete(id);
      const mission = missions.get(id);
      mission.status = status;
      mission.tasks.work.result = { status, summary };
    },
    host: {
      submitMission(spec: any) {
        if (refuse) { const reason = refuse; refuse = null; return { ok: false, reason }; }
        submitted.push(spec);
        missions.set(spec.id, { id: spec.id, status: "running", tasks: { work: { id: "work" } } });
        live.add(spec.id);
        return { ok: true, missionId: spec.id };
      },
      getMission(id: string) { return missions.get(id) ?? null; },
      isMissionLive(id: string) { return live.has(id); },
    },
  };
}
const deps = () => ({ makeBrain: () => { throw new Error("not used with a fake host"); } }) as any;
let fileNumber = 0;
const newFile = () => join(root, `schedules-${++fileNumber}.json`);

try {
  console.log("\nwhat can be scheduled");
  {
    const fake = fakeHost(), scheduler = new Scheduler(fake.host as any, () => now, newFile);
    assert.throws(() => scheduler.add({ goal: "x" }), /either intervalSeconds or dailyAt/);
    assert.throws(() => scheduler.add({ goal: "x", intervalSeconds: 600, dailyAt: "09:00" }), /not both/);
    assert.throws(() => scheduler.add({ goal: "  ", intervalSeconds: 600 }), /needs to say what to do/);
    assert.throws(() => scheduler.add({ goal: "x", dailyAt: "25:00" }), /not a time of day/);
    assert.throws(() => scheduler.add({ goal: "x", intervalSeconds: -5 }), /positive/);
    ok("a schedule needs a goal and exactly one valid cadence");
    assert.equal(scheduler.add({ goal: "x", intervalSeconds: 1 }).intervalSeconds, MIN_INTERVAL_SECONDS);
    ok(`an interval under ${MIN_INTERVAL_SECONDS}s is raised to it — once a second is a runaway, not a schedule`);
    assert.equal(scheduler.add({ goal: "x", dailyAt: "9:05" }).dailyAt, "09:05");
    ok("a time of day is stored in one form");
    assert.equal(describeCadence({ intervalSeconds: 600 }), "every 10 minutes");
    assert.equal(describeCadence({ intervalSeconds: 3600 }), "every hour");
    assert.equal(describeCadence({ intervalSeconds: 90 }), "every 90 seconds");
    assert.equal(describeCadence({ dailyAt: "09:00" }), "daily at 09:00");
    ok("a cadence reads the way a person would say it");
  }

  console.log("\nan interval schedule");
  const file = newFile();
  const fake = fakeHost();
  const scheduler = new Scheduler(fake.host as any, () => now, () => file);
  scheduler.start(deps);
  const created = scheduler.add({ goal: "check whether the build is green", intervalSeconds: 600, scope: { projectId: "alpha" } });
  {
    assert.deepEqual(scheduler.runDue(), []);
    advance(599);
    assert.deepEqual(scheduler.runDue(), []);
    ok("nothing runs before it is due");
    advance(1);
    assert.deepEqual(scheduler.runDue(), [created.id]);
    assert.equal(fake.submitted.length, 1);
    const mission = fake.submitted[0];
    assert.equal(mission.goal, "check whether the build is green");
    assert.equal(mission.scope.projectId, "alpha");
    assert.equal(mission.scope.scheduleId, created.id);
    assert.match(mission.tasks[0].goal, /scheduled run \(every 10 minutes, run 1\)/);
    ok("a due schedule starts one Mission, in the scope it was made in");
    const after = scheduler.list()[0];
    assert.equal(after.runs, 1);
    assert.equal(after.nextRunAt, now + 600_000);
    assert.equal(after.lastOutcome, "Running.");
    ok("and is not due again until a full interval has passed");

    advance(600);
    assert.deepEqual(scheduler.runDue(), []);
    assert.equal(fake.submitted.length, 1);
    assert.match(scheduler.list()[0].lastOutcome!, /Running\.|Skipped a run/);
    ok("a run still working is never overlapped by the next one");

    fake.finish(fake.submitted[0].id, "completed", "The build is green.");
    assert.equal(scheduler.list()[0].lastOutcome, "completed: The build is green.");
    ok("what the last run found is on the schedule, readable later");
    advance(600);
    assert.deepEqual(scheduler.runDue(), [created.id]);
    assert.equal(fake.submitted.length, 2);
    ok("once it has finished, the next run starts on time");
    fake.finish(fake.submitted[1].id, "completed", "Still green.");
  }

  console.log("\na restart");
  {
    assert.ok(existsSync(file));
    const restarted = new Scheduler(fake.host as any, () => now, () => file);
    assert.equal(restarted.list().length, 1);
    assert.equal(restarted.list()[0].goal, "check whether the build is green");
    ok("a schedule is still there after a restart");
    // Echo was closed for ten days: 1,440 runs were missed.
    advance(10 * 86_400);
    const before = fake.submitted.length;
    restarted.start(deps);
    assert.deepEqual(restarted.runDue(), []);
    advance(61);
    assert.deepEqual(restarted.runDue(), [created.id]);
    advance(30);
    assert.deepEqual(restarted.runDue(), []);
    assert.equal(fake.submitted.length, before + 1);
    ok("runs missed while closed are made up once, a minute after start — not once each");
    restarted.stop();
  }

  console.log("\na daily schedule");
  {
    const fakeDaily = fakeHost(), daily = new Scheduler(fakeDaily.host as any, () => now, newFile);
    daily.start(deps);
    now = new Date(2026, 10, 12, 8, 0, 0).getTime();
    const morning = daily.add({ goal: "tell me what is on my calendar", dailyAt: "09:00" });
    assert.equal(morning.nextRunAt, new Date(2026, 10, 12, 9, 0, 0).getTime());
    advance(3600);
    assert.deepEqual(daily.runDue(), [morning.id]);
    assert.equal(daily.list()[0].nextRunAt, new Date(2026, 10, 13, 9, 0, 0).getTime());
    ok("it runs at that time today if it has not passed, then at the same time tomorrow");
    assert.equal(nextDailyRun("09:00", new Date(2026, 10, 12, 9, 0, 0).getTime()), new Date(2026, 10, 13, 9, 0, 0).getTime());
    ok("exactly on the minute counts as passed, so one day cannot run it twice");
    daily.stop();
  }

  console.log("\ncancelling and limits");
  {
    assert.equal(scheduler.cancel("sched-nothere"), null);
    assert.equal(scheduler.cancel(created.id)!.id, created.id);
    assert.equal(scheduler.list().length, 0);
    assert.equal(new Scheduler(fake.host as any, () => now, () => file).list().length, 0);
    advance(10_000);
    assert.deepEqual(scheduler.runDue(), []);
    ok("a cancelled schedule is gone for good, including after a restart");
    for (let n = 0; n < MAX_SCHEDULES; n++) scheduler.add({ goal: `task ${n}`, intervalSeconds: 3600 });
    assert.throws(() => scheduler.add({ goal: "one too many", intervalSeconds: 3600 }), new RegExp(`already ${MAX_SCHEDULES}`));
    ok(`at most ${MAX_SCHEDULES} schedules exist at once`);
    scheduler.stop();
  }

  console.log("\nwhen a run cannot start");
  {
    const fakeFail = fakeHost(), failing = new Scheduler(fakeFail.host as any, () => now, newFile);
    failing.start(deps);
    const entry = failing.add({ goal: "read the news", intervalSeconds: 600 });
    advance(600);
    const logged: string[] = [], error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      fakeFail.refuseNext("Agent scheduler is shutting down");
      assert.deepEqual(failing.runDue(), []);
    } finally { console.error = error; }
    const state = failing.list()[0];
    assert.equal(state.lastOutcome, "Could not start: Agent scheduler is shutting down");
    assert.ok(logged.some((line) => line.includes(entry.id) && line.includes("shutting down")));
    assert.equal(state.nextRunAt, now + 600_000);
    assert.deepEqual(failing.runDue(), []);
    ok("the reason is kept on the schedule and logged, and it waits a full interval instead of retrying every tick");
    failing.stop();
  }

  console.log("\na damaged file");
  {
    const damaged = newFile();
    writeFileSync(damaged, JSON.stringify({ version: 1, schedules: [
      { id: "sched-tightloop", goal: "run constantly", intervalSeconds: 1, nextRunAt: 0, runs: 0, createdAt: 0, scope: {} },
      { id: "../escape", goal: "x", intervalSeconds: 600, nextRunAt: 0, runs: 0, createdAt: 0, scope: {} },
      { id: "sched-both", goal: "x", intervalSeconds: 600, dailyAt: "09:00", nextRunAt: 0, runs: 0, createdAt: 0, scope: {} },
      { id: "sched-good0001", goal: "a valid one", intervalSeconds: 600, nextRunAt: now + 1000, runs: 3, createdAt: 0, scope: {} },
    ] }));
    const loaded = new Scheduler(fakeHost().host as any, () => now, () => damaged).list();
    assert.deepEqual(loaded.map((s) => s.id), ["sched-good0001"]);
    ok("an entry that would launch in a tight loop, or is otherwise invalid, is dropped rather than trusted");
    const garbage = newFile();
    writeFileSync(garbage, "{ not json");
    const error = console.error; console.error = () => {};
    try { assert.equal(new Scheduler(fakeHost().host as any, () => now, () => garbage).list().length, 0); }
    finally { console.error = error; }
    ok("an unreadable file is an empty schedule list, not a crash at startup");
  }

  console.log("\nthrough the real swarm");
  {
    class FakeBrain extends EventEmitter {
      sent = ""; stopped = false;
      send(text: string) { this.sent = text; }
      interrupt() {}
      async stop() { this.stopped = true; }
    }
    const swarm = new SwarmManager();
    const brains: FakeBrain[] = [];
    let unavailable = false;
    const real = new Scheduler(swarm, () => now, newFile);
    real.start(() => ({
      makeBrain: () => {
        if (unavailable) throw new Error("ECHO_TEST_KEY isn't set; reconnect it before starting this agent.");
        const brain = new FakeBrain(); brains.push(brain); return brain as any;
      },
      broadcast: () => {},
    }));
    const entry = real.add({ goal: "summarise new pull requests", intervalSeconds: 600 });
    advance(600);
    assert.deepEqual(real.runDue(), [entry.id]);
    assert.equal(brains.length, 1);
    assert.match(brains[0].sent, /summarise new pull requests/);
    assert.match(brains[0].sent, /submit_agent_result/);
    assert.equal(swarm.count(), 1);
    ok("a run is an ordinary agent on the board, asked to submit a Result");

    const missionId = real.list()[0].lastMissionId!;
    const task = swarm.getMission(missionId)!.tasks.work;
    taskCoordinator.submitResult(task.taskId!, task.actorId!, { status: "completed", summary: "Two new pull requests, both small.", artifacts: [{ kind: "text", label: "Pull requests", value: "Two new pull requests, both small." }], verificationRefs: ["fixture"], blockers: [] });
    brains[0].emit("turnEnd");
    assert.equal(swarm.count(), 0);
    assert.equal(brains[0].stopped, true);
    assert.equal(real.list()[0].lastOutcome, "completed: Two new pull requests, both small.");
    ok("when it ends its brain is stopped and its result is on the schedule — nothing is left running");

    // The brain Echo is on has lost its key between runs.
    unavailable = true;
    advance(600);
    const logged: string[] = [], error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try { assert.doesNotThrow(() => real.runDue()); } finally { console.error = error; }
    assert.match(real.list()[0].lastOutcome!, /^failed: .*ECHO_TEST_KEY/);
    assert.ok(logged.some((line) => /ECHO_TEST_KEY/.test(line)));
    assert.equal(swarm.count(), 0);
    ok("an unavailable brain fails that run, says why on the schedule and in the log, and crashes nothing");
    real.stop();
    await swarm.close();
  }

  console.log("\nthe tools");
  {
    for (const name of ["schedule_task", "list_scheduled_tasks", "cancel_scheduled_task"]) assert.ok(TOOLS.some((t) => t.name === name), `${name} is registered`);
    ok("scheduling, listing and cancelling are all tools");
    const asked = classify("schedule_task", { intervalSeconds: 600, goal: "check the build" }, { workingDir: root });
    assert.equal(asked.tier, "high");
    assert.match(asked.reason, /every 10 minutes, until cancelled/);
    assert.equal(classify("schedule_task", { dailyAt: "09:00", goal: "x" }, { workingDir: root }).tier, "high");
    ok("starting a recurring unattended agent asks first, like starting a single one does");
    assert.equal(classify("list_scheduled_tasks", {}, { workingDir: root }).tier, "low");
    assert.equal(classify("cancel_scheduled_task", { id: "sched-1" }, { workingDir: root }).tier, "medium");
    ok("looking is free, and cancelling does not need a second confirmation");
    assert.ok(JSON.parse(readFileSync(file, "utf8")).version === 1);
    ok("the saved file is versioned");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass} scheduled-task checks passed`);
