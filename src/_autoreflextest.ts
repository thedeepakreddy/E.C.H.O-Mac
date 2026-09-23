/**
 * The reflex fast path can actually be LEARNED.   npm run autoreflextest
 *
 * `matchReflex` was wired into main.ts from the start, so a cache hit would
 * have replayed instantly with no model call — but the only caller of
 * `saveReflex` was autoreflex.ts, and nothing imported it. The cache could
 * never be written, `~/.jarvis/reflex/` did not even exist, and so every
 * repeated command paid a full model round trip forever. The read half of a
 * cache is not a cache.
 *
 * This drives the whole loop the way main.ts now does: ask once, ask again,
 * finish successfully, answer the prompt, and then check that the NEXT ask is
 * served from the cache without the model.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Private data root: this test writes reflexes and must never touch the real
// ~/.jarvis cache, which is the user's own learned fast paths.
const root = mkdtempSync(join(tmpdir(), "echo-autoreflex-"));
process.env.ECHO_DATA_ROOT = root;

const autoreflex = await import("./frontier/autoreflex.js");
const demo = await import("./frontier/demonstrate.js");
const { matchReflex, loadCache } = await import("./frontier/reflex.js");
const { confirmations } = await import("./safety/confirm.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

/** Answer the "want me to remember this?" prompt however the case needs. */
let answer = true;
confirmations.on("ask", ({ id }: { id: string }) => confirmations.settle(id, answer, "test"));

const ON = { enabled: true };
const steps = () => ([
  { kind: "open", app: "Safari" },
  { kind: "click", target: "Bookmarks" },
  { kind: "click", target: "Reading List" },
] as any[]);

/** One full turn: dispatch -> do GUI steps -> finish. */
async function turn(command: string, success = true, withSteps = steps()) {
  const capture = await autoreflex.beginTurn(command, ON, process.cwd());
  if (capture.capturing) for (const s of withSteps) demo.noteStep(s);
  await autoreflex.endTurn(command, capture, success, process.cwd());
  return capture;
}

console.log(`\nLearning a reflex (data root ${root})\n`);

console.log("  a first-time ask is only remembered as a candidate");
{
  const c = await turn("open my safari reading list");
  ok(!c.capturing, "nothing is recorded the first time a thing is asked");
  ok(Object.keys(loadCache()).length === 0, "and nothing is saved to the reflex cache");
}

console.log("\n  asking again — a near-miss phrasing, not the same string");
{
  const c = await turn("open the reading list in safari");
  ok(c.capturing, "the second, similar ask IS recorded", "beginTurn declined to capture");
  const cache = loadCache();
  ok(Object.keys(cache).length === 1, `it was saved after the prompt (cache has ${Object.keys(cache).length})`);
}

console.log("\n  and the next ask is served from the cache, with no model call");
{
  const hit = matchReflex("open the reading list in safari");
  ok(!!hit, "matchReflex returns the saved entry");
  ok((hit?.steps.length ?? 0) === 3, `with all three steps (got ${hit?.steps.length ?? 0})`);
}

console.log("\n  a FAILED turn is never kept");
{
  const before = Object.keys(loadCache()).length;
  await turn("archive last month's invoices");            // first ask: candidate only
  const c = await turn("archive the invoices from last month", false); // second: fails
  ok(c.capturing, "the repeat ask was being recorded");
  ok(Object.keys(loadCache()).length === before, "but a failure saves nothing");
}

console.log("\n  and a declined prompt is never kept");
{
  answer = false;
  const before = Object.keys(loadCache()).length;
  await turn("rename the screenshots on my desktop");
  const c = await turn("rename those desktop screenshots");
  ok(c.capturing, "the repeat ask was being recorded");
  ok(Object.keys(loadCache()).length === before, "but saying no saves nothing");
  answer = true;
}

console.log("\n  a one-step task is not worth a fast path");
{
  const before = Object.keys(loadCache()).length;
  await turn("open calculator", true, [{ kind: "open", app: "Calculator" }] as any[]);
  await turn("launch the calculator", true, [{ kind: "open", app: "Calculator" }] as any[]);
  ok(Object.keys(loadCache()).length === before, "a single-step turn is not saved");
}

console.log("\n  an unrelated ask does not count as a repeat");
{
  await turn("what is the weather in hyderabad");
  const c = await turn("compile the rust project");
  ok(!c.capturing, "two different asks never trigger a recording");
}

console.log("\n  the user's own learn_workflow session is never stolen");
{
  demo.startRecording("user's own workflow");
  const c = await turn("open my safari reading list");
  ok(!c.capturing, "beginTurn declines while a demonstration is in progress");
  demo.cancelRecording();
}

console.log("\n  it stays off when the config says so");
{
  const c = await autoreflex.beginTurn("open the reading list in safari", { enabled: false }, process.cwd());
  ok(!c.capturing, "disabled means nothing is ever recorded");
}

// Everything above exercises autoreflex directly — and would have passed
// unchanged on the day the bug existed, because the bug was never inside this
// module. It was that NOTHING IMPORTED IT: `saveReflex` had exactly one caller
// and that caller was unreachable, so the cache stayed empty forever. A test
// for dead code has to assert the code is reached.
console.log("\n  main.ts actually calls it (the bug was that nothing did)");
{
  // Tests run from the project root; esbuild would resolve import.meta.url to dist/.
  const main = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
  ok(/import \* as autoreflex from ".\/frontier\/autoreflex.js"/.test(main),
    "main.ts imports autoreflex");
  ok(/autoreflex\s*\n?\s*\.beginTurn\(/.test(main),
    "main.ts calls beginTurn when a command is dispatched");
  ok(/autoreflex\s*\n?\s*\.endTurn\(/.test(main),
    "main.ts calls endTurn when the turn finishes");
  // Success and failure both have to close the recording, or a capture leaks
  // into the next turn and the wrong steps get saved under the wrong command.
  ok((main.match(/endAutoReflex\(/g) ?? []).length >= 4,
    `every turn terminal closes the recording (found ${(main.match(/endAutoReflex\(/g) ?? []).length} call sites, need >= 4)`);
  ok(/endAutoReflex\(true\)/.test(main) && /endAutoReflex\(false\)/.test(main),
    "both the success and the failure terminals are wired");
}

// And the test's own isolation, asserted rather than assumed.
ok(root.startsWith(tmpdir()) && process.env.ECHO_DATA_ROOT === root,
  "this test wrote to a private data root, never the real ~/.jarvis cache");

console.log(`\n${pass}/${pass + fail} autoreflex cases passed`);
console.log("A failure here means Echo cannot learn a fast path, so every repeat ask pays the model again.\n");
process.exit(fail === 0 ? 0 : 1);
