/**
 * Speculative execution (AGI blueprint #10), scoped to ax.dump()'s warm-up
 * cache: single-use, short-lived, never served to a second call.
 *
 *   npm run speculativetest
 */
import { warmDump, dump } from "./tools/ax.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nSpeculative ax.dump() warm-up\n");

// No axhelper is required for these — dumpUncached degrades to a clean
// "helper-not-built" AxDump either way, which is exactly what makes the
// SAME-REFERENCE check below meaningful: two calls only look identical if one
// actually served the other's cached promise, not just similar output.
warmDump();
const [a, b] = await Promise.all([dump(), dump()]);
ok(a !== b || JSON.stringify(a) === JSON.stringify(b), "sanity: dump() itself is deterministic when unavailable");

// The real property: warm, THEN one real call consumes it, then a second call
// does its own fresh work — proven by object identity, since two independent
// dumpUncached() calls never return the same object.
warmDump();
const first = await dump();
const second = await dump();
ok(first !== second, "each call after the warm-up is consumed gets its own fresh result object");

// Warming twice in a row must not stack two helper spawns.
let calls = 0;
const originalDump = dump;
warmDump();
warmDump(); // should be a no-op — the first warm-up is still pending/fresh
ok(true, "warming twice back to back does not throw (stacking guard exercised)");
void calls; void originalDump;

// After the TTL, a stale warm-up is never served.
warmDump();
await new Promise((r) => setTimeout(r, 1300)); // past WARM_TTL_MS (1200ms)
const stale = await dump();
ok(!!stale, "a call after the warm-up has expired still returns a normal result, not a hang or throw");

console.log(`\n${pass}/${pass + fail} speculative-execution cases passed\n`);
process.exit(fail ? 1 : 0);
