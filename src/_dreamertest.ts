/**
 * Self-compressing context (AGI blueprint #6): the LLM-assisted generalisation
 * pass over facts consolidate() already promoted, which its own doc comment
 * names as something the lexical rule cannot do by itself.
 *
 *   npm run dreamertest
 *
 * Isolated the same way _episodictest.ts is: JARVIS_EPISODIC_DIR points the
 * store at a scratch directory so this never touches real data.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JARVIS_EPISODIC_DIR = mkdtempSync(join(tmpdir(), "echo-dreamertest-"));

const { record, consolidate, allFacts, _resetForTests } = await import("./cognition/episodic.js");
const { maybeCompress, _resetCompressionThrottleForTests } = await import("./frontier/dreamer.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nSelf-compressing context (dream compression)\n");
_resetForTests();

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

// Build up two lexically-recurring facts across enough days that consolidate() promotes them.
for (let d = 0; d < 3; d++) {
  record({ kind: "action", text: "opened the project in Brave" }, T0 + d * DAY);
  record({ kind: "action", text: "closed the tab in Chrome without reading it" }, T0 + d * DAY);
  record({ kind: "action", text: "ran the tests with pnpm test" }, T0 + d * DAY);
  record({ kind: "request", text: "always run the build before pushing" }, T0 + d * DAY);
}
const { promoted } = consolidate(undefined, T0 + 3 * DAY);
ok(promoted.length >= 4, `lexical consolidation promoted ${promoted.length} fact(s) to build the test on`);

const cfgOn = { agi: { dreamCompression: { enabled: true } }, ollama: { host: "http://localhost:11434", model: "llama3.2:3b" } } as any;
const cfgOff = { agi: { dreamCompression: { enabled: false } }, ollama: { host: "http://localhost:11434", model: "llama3.2:3b" } } as any;

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
function mockFetch(response: string) {
  fetchCalls = 0;
  (globalThis as any).fetch = async () => {
    fetchCalls++;
    return { ok: true, json: async () => ({ response }) } as any;
  };
}

// ---- disabled: never calls the model -------------------------------------------
_resetCompressionThrottleForTests();
mockFetch(JSON.stringify(["should never be read"]));
await maybeCompress(cfgOff);
ok(fetchCalls === 0, "disabled in config: never calls the local model");

// ---- enabled: infers a new fact, capped confidence, dedup ------------------------
_resetCompressionThrottleForTests();
const before = allFacts().length;
mockFetch(JSON.stringify(["avoids Chrome, prefers Brave", "opened the project in Brave"])); // one new, one a verbatim repeat
await maybeCompress(cfgOn);
const after = allFacts();
ok(fetchCalls === 1, "enabled: calls the local model exactly once");
ok(after.length === before + 1, `exactly one NEW fact added (had ${before}, now ${after.length}) — the verbatim repeat was skipped`);
const inferred = after.find((f) => f.text === "avoids Chrome, prefers Brave");
ok(!!inferred && inferred.kind === "rule", "the inferred fact is recorded, kind 'rule'");
ok(!!inferred && inferred.confidence <= 0.6, `an inferred fact's confidence is capped below a directly-observed one (got ${inferred?.confidence})`);

// ---- throttle: a second call within the window does nothing more ----------------
mockFetch(JSON.stringify(["a third thing"]));
await maybeCompress(cfgOn); // NOT reset — should be throttled
ok(fetchCalls === 0, "a second call inside the 24h window is throttled — no model call at all");

// ---- a bad response never throws, never adds garbage -----------------------------
_resetCompressionThrottleForTests();
mockFetch("not json at all");
let threw = false;
try {
  await maybeCompress(cfgOn);
} catch {
  threw = true;
}
ok(!threw, "an unparsable model response is swallowed, not thrown");
ok(allFacts().length === after.length, "…and adds nothing");

(globalThis as any).fetch = originalFetch;
console.log(`\n${pass}/${pass + fail} dream-compression cases passed\n`);
process.exit(fail ? 1 : 0);
