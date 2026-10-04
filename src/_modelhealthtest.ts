/**
 * A model that is out of quota must stay out.   npm run modelhealthtest
 *
 * Measured from 72 real turns: median time to first token was 6.7s, with a
 * tail to 39s. The voice log showed why — every turn opened with the same
 * three failed round trips:
 *
 *   gemini-3.6-flash      → quota
 *   gemini-3.5-flash      → quota
 *   gemini-3.1-flash-lite → quota
 *
 * repeated on turn after turn, which is precisely what `markExhausted` exists
 * to prevent. The cause was one regex. Google reports a daily cap two ways,
 * and only the verbose one said "PerDay"; the short form names the metric
 * instead, so a DAILY exhaustion was filed as a five-minute rate limit and
 * any turn more than five minutes later paid to learn it again.
 *
 * On a free tier that is not only slow: the cap is 20 requests per day per
 * model, and three of them per turn went on rediscovery.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ECHO_DATA_ROOT = mkdtempSync(join(tmpdir(), "echo-health-"));
const { modelHealth } = await import("./brain/model-health.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

const HOUR = 3600_000;
/** The notes as they were actually written to disk — the copy the next turn reads. */
const health = () => JSON.parse(readFileSync(join(process.env.ECHO_DATA_ROOT!, "model-health.json"), "utf8"));

console.log("\nA model that is out of quota stays out\n");

console.log("  the short form of a daily quota error");
{
  // Exactly what the SDK surfaced in the logs — no "PerDay" anywhere in it.
  const short =
    "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
    "limit: 20, model: gemini-3.5-flash\nPlease retry in 12.744577068s.";
  modelHealth.markExhausted("short-form", short);
  ok(!modelHealth.usable("short-form"), "it is skipped right away");
  // The whole point: still skipped an hour later, not five minutes later.
  const notes = health();
  const until = notes["short-form"].until - Date.now();
  ok(until > HOUR,
    `and for hours, not minutes (${(until / HOUR).toFixed(1)}h)`,
    `${(until / 60000).toFixed(0)} minutes — a turn after that pays the failed call again`);
}

console.log("\n  the verbose form still works");
{
  modelHealth.markExhausted("verbose-form",
    '{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}');
  const notes = health();
  ok(notes["verbose-form"].until - Date.now() > HOUR, "the quotaId route is unchanged");
}

console.log("\n  a real per-minute limit still clears quickly");
{
  // Over-marking is the expensive mistake in the other direction: it would
  // drop a perfectly good model for the rest of the day over a momentary spike.
  modelHealth.markExhausted("per-minute",
    '{"error":{"details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}}');
  const notes = health();
  const until = notes["per-minute"].until - Date.now();
  ok(until < HOUR, `a minute-limit is still short (${(until / 60000).toFixed(0)}m)`,
    "a momentary spike must not cost the model for the whole day");
}

console.log("\n  the ladder skips what it knows will fail");
{
  const ladder = modelHealth.ladder(["short-form", "fresh-model", "verbose-form"]);
  ok(ladder.length === 1 && ladder[0] === "fresh-model",
    `only the untried model is left (${ladder.join(", ") || "none"})`,
    "every extra entry here is a failed network round trip before the first token");
  ok(/out of quota/.test(modelHealth.explain(["short-form"])), "and it can say why in words");
}

rmSync(process.env.ECHO_DATA_ROOT!, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} model-health cases passed`);
console.log("A failure here means every reply pays for failed API calls before it starts.\n");
process.exit(fail === 0 ? 0 : 1);
