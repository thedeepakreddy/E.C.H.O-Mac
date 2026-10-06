/**
 * The five open-intelligence sources, against the real services.
 *   npm run inteltest              offline checks only
 *   npm run inteltest -- --live    also hit the network
 *
 * These are five unrelated public APIs, each of which can change or start
 * demanding a key without telling anyone — four of their obvious neighbours
 * (OpenSanctions, abuse.ch, OpenAQ, Cloudflare Radar) already did, which is
 * why they are not in the catalogue. So the live half of this file is the
 * point: it is the only thing that can tell "Echo answered wrongly" from
 * "the service moved".
 *
 * The offline half needs no network and runs in CI: name resolution, argument
 * parsing, the OSM tag table, caching, and that every failure says WHICH
 * service failed rather than a bare stack trace.
 */
import { INTEL_SOURCES, resolveIntelSource, intelSourceNames, clearIntelCache, cached, geocode } from "./tools/intel-feeds.js";
import { TOOL_MAP } from "./tools/registry.js";

const live = process.argv.includes("--live");
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

console.log("\nOpen intelligence feeds\n");

console.log("  the catalogue");
{
  ok(INTEL_SOURCES.length === 5, `five sources (${INTEL_SOURCES.length})`);
  const ids = INTEL_SOURCES.map((s) => s.id).sort().join(",");
  ok(ids === "exploited,nearby,network,news,satellites", `ids: ${ids}`);
  ok(new Set(INTEL_SOURCES.flatMap((s) => s.aliases)).size ===
     INTEL_SOURCES.flatMap((s) => s.aliases).length, "no alias is claimed by two sources");
  ok(INTEL_SOURCES.every((s) => s.argHint.length > 10), "every source explains its argument");
}

console.log("\n  spoken names resolve to the right source");
{
  const cases: Array<[string, string]> = [
    ["satellites", "satellites"], ["ISS", "satellites"], ["passes", "satellites"], ["overhead", "satellites"],
    ["news", "news"], ["headlines", "news"], ["world news", "news"],
    ["nearby", "nearby"], ["near me", "nearby"], ["nearest", "nearby"],
    ["network", "network"], ["bgp", "network"], ["who owns", "network"],
    ["exploited", "exploited"], ["kev", "exploited"], ["cve", "exploited"], ["being exploited", "exploited"],
  ];
  for (const [spoken, want] of cases) {
    const got = resolveIntelSource(spoken)?.id;
    ok(got === want, `"${spoken}" -> ${want}`, `got ${got}`);
  }
  ok(resolveIntelSource("nonsense-xyz") === undefined, "an unknown name resolves to nothing");
  // Short aliases must not match inside longer words: "astrology" contains
  // "as", which the network source answers to.
  for (const trap of ["astrology", "assassin", "cassette", "satisfaction", "newsagent's history"]) {
    ok(resolveIntelSource(trap) === undefined, `"${trap}" is not mistaken for a source`, String(resolveIntelSource(trap)?.id));
  }
  ok(resolveIntelSource("") === undefined, "so does an empty one");
}

console.log("\n  the tool is wired into the registry");
{
  const def = TOOL_MAP.get("open_intel");
  ok(!!def, "open_intel is registered");
  ok(def?.readOnly === true, "and marked read-only — it only ever reads public data");
  ok(/satellites/.test(def?.description ?? "") && /exploited/.test(def?.description ?? ""),
    "its description names the sources, so the model knows when to reach for it");
  ok(intelSourceNames().includes("satellites"), "intelSourceNames lists them for the error path");
}

console.log("\n  an unknown source is refused, not thrown");
{
  const def: any = TOOL_MAP.get("open_intel");
  const out = await def.handler({ source: "astrology" });
  ok(out.status === "failed", "status is failed");
  ok(/don't have an intel source/.test(out.text), "and it says so in words");
  ok(/satellites/.test(out.text), "listing what it does have", out.text?.slice(0, 60));
}

// ── the wrong tool winning ────────────────────────────────────────────────
//
// Reported live: "show me a live camera feed from the US". Echo called THIS
// tool with source `news`, GDELT searched for ARTICLES about cameras, and
// answered "no recent coverage of live camera feed from the US" — which the
// user heard as Echo saying there is no camera coverage. Osiris had ~37,000
// live cameras the whole time.
//
// Nothing was broken. Two similar-sounding tools, and the wrong one won. A
// sharper description is the primary fix; this is the guarantee behind it.
console.log("\n  a camera question is sent to the tool that has cameras");
{
  const def: any = TOOL_MAP.get("open_intel");
  for (const q of ["live camera feed from the US", "cctv in Tokyo", "show me a webcam"]) {
    const out = await def.handler({ source: "news", query: q });
    ok(out.status === "failed", `"${q}" is not answered as news`, JSON.stringify(out).slice(0, 70));
    ok(/osiris_intel/.test(out.text) && /cameras/.test(out.text),
      "and it names the tool and feed that can answer", out.text?.slice(0, 80));
  }
  // `nearby` legitimately finds physical things at a place, so a speed camera
  // there is a real question — it must not be hijacked.
  const near: any = TOOL_MAP.get("open_intel");
  const out = await near.handler({ source: "nearby", query: "speed camera near 17.385,78.4867" });
  ok(out.status !== "failed" || !/osiris_intel/.test(out.text ?? ""),
    "but `nearby` is left alone — a camera ON THE GROUND is its job",
    String(out.text).slice(0, 70));

  // And an ordinary news question still works.
  const news = await def.handler({ source: "news", query: "India" });
  ok(!/osiris_intel/.test(news.text ?? ""), "an ordinary news query is untouched", String(news.text).slice(0, 60));
}

console.log("\n  the cache actually caches");
{
  clearIntelCache();
  let calls = 0;
  const load = async () => { calls++; return calls; };
  await cached("k", 60_000, load);
  await cached("k", 60_000, load);
  ok(calls === 1, `one call for two reads (${calls})`);
  await cached("k", -1, load); // expired
  ok(calls === 2, "and it reloads once stale");
  clearIntelCache();
  await cached("k", 60_000, load);
  ok(calls === 3, "clearIntelCache empties it");
}

console.log("\n  coordinates given directly skip the geocoder");
{
  // No network: a "lat,lon" argument is parsed, not looked up.
  const p = await geocode("17.385, 78.4867", { fetchImpl: (async () => { throw new Error("should not be called"); }) as any });
  ok(p?.lat === 17.385 && p?.lon === 78.4867, `parsed to ${p?.lat}, ${p?.lon}`);
  const bad = await geocode("999, 999", { fetchImpl: (async () => { throw new Error("no network"); }) as any }).catch(() => null);
  ok(bad === null, "an out-of-range pair is not treated as coordinates");
}

console.log("\n  a dead service is reported by name, not as a stack trace");
{
  const dead = (async () => { throw new Error("connect ECONNREFUSED"); }) as any;
  for (const s of INTEL_SOURCES) {
    // `nearby` and `satellites` need an argument that reaches the network.
    const arg = s.id === "network" ? "AS15169" : s.id === "nearby" ? "pharmacy near 17.38,78.48" : s.id === "news" ? "test" : s.id === "satellites" ? "ISS" : "";
    let msg = "";
    try { await s.run(arg, { fetchImpl: dead }); } catch (e: any) { msg = String(e?.message ?? e); }
    ok(msg.length > 0, `${s.id} surfaces the failure`, msg.slice(0, 40));
  }
}

// ── live ──────────────────────────────────────────────────────────────────

if (!live) {
  console.log("\n  (skipping the live services — run with `-- --live` to check them)");
} else {
  console.log("\n  against the real services");
  clearIntelCache();
  const check = async (id: string, arg: string | undefined, want: RegExp) => {
    const s = INTEL_SOURCES.find((x) => x.id === id)!;
    const t0 = Date.now();
    try {
      const a = await s.run(arg, { timeoutMs: 30_000 });
      const good = want.test(a.speak);
      ok(good, `${id} answered in ${Date.now() - t0}ms`, a.speak.slice(0, 90));
      if (good) console.log(`        "${a.speak.slice(0, 110)}"`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Rate limiting is the service protecting itself, not Echo being broken,
      // and the two are indistinguishable from the outside. Report it loudly
      // but do not fail on it — anything ELSE from the same source still does.
      if (/rate-limit|429/i.test(msg)) {
        console.log(`  ⚠ ${id} is rate-limiting us right now — not counted as a failure`);
        console.log(`        ${msg.slice(0, 100)}`);
        return;
      }
      ok(false, `${id} threw after ${Date.now() - t0}ms`, msg.slice(0, 70));
    }
  };
  await check("satellites", "ISS over Hyderabad", /ISS|ZARYA|kilometres/i);
  await check("news", "India", /stories|coverage/i);
  // Hyderabad city centre HAS mapped pharmacies. Accepting "none mapped" here
  // is what let a Switzerland-only mirror pass as working: it answered 200 with
  // an empty list and the regex was happy. Require a real count.
  await check("nearby", "pharmacy near 17.385,78.4867", /^\d+ pharmac/i);

  await check("network", "AS15169", /GOOGLE/i);
  await check("exploited", undefined, /vulnerabilit/i);
  await check("exploited", "Chrome", /vulnerabilit|good news/i);
}

console.log(`\n${pass}/${pass + fail} intel checks passed`);
console.log("A failure in the live section usually means the service changed, not that Echo did.\n");
process.exit(fail === 0 ? 0 : 1);
