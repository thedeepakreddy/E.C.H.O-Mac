/**
 * The critic (AGI blueprint #1) and confidence-to-demo (#4) — the free
 * confidence signal ax.rank was already computing and discarding, and the
 * failure-streak trigger in gate.ts that offers a demonstration.
 *
 *   npm run critictest
 */
import { criticVerdict, rankScored, type AxElement } from "./tools/ax.js";
import { maybeOfferDemo, noteGuiOutcome, resetGateMemory } from "./safety/gate.js";
import { confirmations } from "./safety/confirm.js";
import * as demo from "./frontier/demonstrate.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nCritic + confidence-to-demo\n");

const el = (label: string, overrides: Partial<AxElement> = {}): AxElement =>
  ({ i: 0, label, value: "", role: "AXButton", enabled: true, press: true, x: 0, y: 0, w: 10, h: 10, path: [0], ...overrides } as AxElement);

// ---- rankScored / criticVerdict ------------------------------------------------
{
  const scored = rankScored([el("Send"), el("Send to Drafts")], "send");
  ok(scored.length === 2 && scored[0].element.label === "Send", "exact label ranks first");
  ok(criticVerdict(scored).ok, "a clear winner passes the critic");
}
{
  // A single weak partial hit — the failure mode the blueprint describes: a
  // guess that would otherwise fail silently and only surface as a bad click.
  // Neither word of the query is a substring of the label as a whole (or vice
  // versa) — only the per-word overlap fires, which is deliberately worth
  // little on its own.
  const scored = rankScored([el("Deleted Items View", { press: false })], "delete items");
  const v = criticVerdict(scored);
  ok(!v.ok && v.reason === "weak", `a lone weak partial match is held back (got ${JSON.stringify(v)}, score ${scored[0]?.score})`);
}
{
  // Two candidates that score identically by construction — neither is a
  // substring of "save changes" or vice versa, so both rest on the same
  // per-word overlap. Genuinely ambiguous, worth a rethink.
  const scored = rankScored([el("Save Draft Changes"), el("Save All Changes")], "save changes");
  const v = criticVerdict(scored);
  ok(!v.ok && v.reason === "ambiguous", `two equally-scored candidates are flagged ambiguous (got ${JSON.stringify(v)}, scores ${scored.map((s) => s.score)})`);
}
{
  // A real exact match must never be held back even with a distant second place.
  const scored = rankScored([el("Export"), el("Export All")], "export");
  ok(criticVerdict(scored).ok, "an exact match is never blocked by a weaker second candidate");
}
ok(criticVerdict([]).ok, "no candidates is not the critic's problem — the caller's own 'nothing matches' path handles it");

// ---- confidence-to-demo: fails N times on one task, then offers exactly once ------
{
  resetGateMemory();
  let asked = 0;
  const orig = confirmations.request.bind(confirmations);
  (confirmations as any).request = async (_q: string) => { asked++; return true; };

  const taskId = "critictest-yes";
  noteGuiOutcome(taskId, "click_ui_element", false);
  const before = await maybeOfferDemo("click_ui_element", taskId);
  ok(before === false, "one failure alone does not trigger an offer (threshold is 2)");
  noteGuiOutcome(taskId, "click_ui_element", false);
  const triggered = await maybeOfferDemo("click_ui_element", taskId);
  ok(triggered === true, "a second consecutive failure triggers the offer, and 'yes' holds the caller back");
  ok(asked === 1, `confirmations.request was called exactly once (was ${asked})`);
  ok(demo.isRecording(), "a recording starts once the user agrees to demonstrate");
  demo.cancelRecording();

  const again = await maybeOfferDemo("click_ui_element", taskId);
  ok(again === false && asked === 1, "the same task is never asked twice, even if failures keep coming");

  (confirmations as any).request = orig;
}
{
  resetGateMemory();
  (confirmations as any).request = async () => false; // decline
  const taskId = "critictest-no";
  noteGuiOutcome(taskId, "click_ui_element", false);
  noteGuiOutcome(taskId, "click_ui_element", false);
  const declined = await maybeOfferDemo("click_ui_element", taskId);
  ok(declined === false, "declining returns false — the triggering call proceeds normally");
  ok(!demo.isRecording(), "declining never starts a recording");
}
{
  resetGateMemory();
  const taskId = "critictest-reset";
  noteGuiOutcome(taskId, "click_ui_element", false);
  noteGuiOutcome(taskId, "click_ui_element", true); // a success resets the streak
  const afterSuccess = await maybeOfferDemo("click_ui_element", taskId);
  ok(afterSuccess === false, "a success in between resets the failure streak");
}
{
  resetGateMemory();
  const taskId = "critictest-nongui";
  noteGuiOutcome(taskId, "read_local_file", false);
  noteGuiOutcome(taskId, "read_local_file", false);
  noteGuiOutcome(taskId, "read_local_file", false);
  const nonGuiOffer = await maybeOfferDemo("read_local_file", taskId);
  ok(nonGuiOffer === false, "a non-GUI tool never triggers the demo offer, however often it fails");
}

console.log(`\n${pass}/${pass + fail} critic/confidence-to-demo cases passed\n`);
process.exit(fail ? 1 : 0);
