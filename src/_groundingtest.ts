/**
 * The looking tools carry the screen they looked at.   npm run groundingtest
 *
 * Counted over 1,793 real recorded steps: `click` carried an image 98% of the
 * time and `scroll` 96%, while `list_ui_elements` managed 19% and
 * `read_screen_text` 34%. The difference was not subtle or accidental — the
 * first two were in `GROUNDING_TOOLS` and got a pre-action frame; the other
 * two were not, and only ever had an image when a screenshot happened to come
 * first. That is ~160 steps of the dataset, and for a vision model a step
 * with no screen is not a weak example, it is not an example.
 *
 * Deciding to go and read the screen IS a judgement made from a screen, so
 * those steps are worth as much as the clicks that follow them.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "echo-traj-"));
process.env.ECHO_DATA_ROOT = ROOT;
const { configureLearning, startTurn, recordStep, captureGroundingFrame, finishTurn, flushTrajectory } =
  await import("./learn/trajectory.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

configureLearning({ enabled: true, captureScreens: true, maxStepsPerTurn: 0 });

/** Every step row written so far, in order. */
async function rows(): Promise<any[]> {
  await flushTrajectory();
  const dir = join(ROOT, "trajectories");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) =>
    readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  );
}

const step = (tool: string, resultText = "", image?: any) =>
  recordStep({ tool, args: {}, tier: "low", reason: "test", allowed: true, resultText, image });

console.log("\nThe looking tools carry the screen they looked at\n");

startTurn("find the send button", "gemini", "test");
// The gate calls this before the handler runs; drive the same order.
await captureGroundingFrame("list_ui_elements");
step("list_ui_elements", 'Mail — 3 elements:\n#0 Button "Send" @100,200');
await captureGroundingFrame("read_screen_text");
step("read_screen_text", "Send\nDraft saved");
await captureGroundingFrame("click");
step("click", "clicked");
step("remember", "noted");          // not a screen tool; must stay imageless
finishTurn("success", "done");

const all = await rows();
const steps = all.filter((r) => r.type === "step");
const by = (t: string) => steps.find((r) => r.tool === t);
const captured = steps.some((r) => r.observation?.image);

if (!captured) {
  // screencapture needs a real framebuffer; on a machine without one there is
  // nothing to assert about pixels. Say so rather than passing vacuously.
  console.log("  ⚠ no framebuffer here — screencapture produced nothing, so the pixel");
  console.log("    assertions cannot run. The ordering and non-capture checks still do.\n");
} else {
  ok(!!by("list_ui_elements")?.observation?.image, "list_ui_elements carries the screen it listed");
  ok(!!by("read_screen_text")?.observation?.image, "read_screen_text carries the screen it read");
  ok(!!by("click")?.observation?.image, "and click still does, as it always did");
  // The bug behind the carry-forward: a seeing tool replaced the observation
  // wholesale, so the pixels taken moments earlier were dropped and the NEXT
  // step inherited text only.
  ok(!!by("click")?.observation?.text, "the click's observation kept the TEXT the look produced too",
    "pixels and text are the same screen — an example should carry both");
}

// `remember` legitimately INHERITS the current observation — the screen has
// not changed since the click, and "the state before this action" is still
// that screen. What it must not do is pay for a NEW capture, and the way to
// tell the difference is the filename.
ok(by("remember")?.observation?.image === by("click")?.observation?.image,
  "a tool that is not about the screen reuses the last frame rather than taking one",
  `click=${by("click")?.observation?.image} remember=${by("remember")?.observation?.image} — a needless capture is ~300ms on the user's turn`);

// And the count on disk is the real proof: four steps, but only the two
// looking tools and the click were entitled to a frame, and the click was
// inside FRESH_FRAME_MS of the read before it so it reused that one.
{
  const shots = readdirSync(join(ROOT, "trajectories", "screens")).filter((f) => f.endsWith(".jpg"));
  ok(shots.length <= 3, `at most one capture per entitled tool (${shots.length} for 4 steps)`);
}

ok(steps.map((r) => r.step).join(",") === "1,2,3,4",
  `rows are in order (${steps.map((r) => r.step).join(",")})`);
ok(steps.every((r) => r.turn === steps[0].turn), "and belong to one turn");

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} grounding-capture cases passed`);
console.log("A failure here means steps land in the training set with nothing for a vision model to see.\n");
process.exit(fail === 0 ? 0 : 1);
