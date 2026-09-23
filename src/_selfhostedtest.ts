/**
 * Self-hosted services (tools/selfhosted.ts): SearXNG and Glances, against a
 * fake network — plus how the risk gate sees their tools.
 *
 *   npm run selfhostedtest
 */
export {};

const S = await import("./tools/selfhosted.js");
const { classify } = await import("./safety/risk.js");
const { TOOL_MAP } = await import("./tools/registry.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const rejects = async (p: Promise<unknown>) => p.then(() => null, (e) => e as Error);

type Seen = { url: string; init?: RequestInit };
function fakeFetch(routes: Record<string, unknown | ((u: string) => unknown)>, seen: Seen[] = []): typeof fetch {
  return (async (url: any, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const u = new URL(String(url));
    const hit = Object.entries(routes).find(([path]) => u.pathname === path || u.pathname + u.search === path);
    if (!hit) return new Response("not found", { status: 404 });
    const body = typeof hit[1] === "function" ? (hit[1] as any)(String(url)) : hit[1];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any;
}
const refused = (async () => { throw new TypeError("fetch failed"); }) as any;

// ── SearXNG ─────────────────────────────────────────────────────────────────
console.log("\nSearXNG\n");
{
  const seen: Seen[] = [];
  const r = await S.webSearch(
    { query: "ha mcp", category: "News", timeRange: "week", limit: 2 },
    {
      fetchImpl: fakeFetch({
        "/search": {
          results: [
            { title: "Home <b>Assistant</b> MCP", url: "https://a.example", content: "The   official\nserver", engines: ["brave", "google"], publishedDate: "2026-09-20T10:00:00" },
            { title: "", url: "https://b.example", content: "", engines: ["brave"] },
            { title: "Third", url: "https://c.example" },
            { title: "No url" },
          ],
          answers: [],
          unresponsive_engines: [["duckduckgo", "CAPTCHA"]],
        },
      }, seen),
    }
  );
  const q = new URL(seen[0].url).searchParams;
  ok(q.get("format") === "json" && q.get("q") === "ha mcp", "asks SearXNG for JSON");
  ok(q.get("categories") === "news" && q.get("time_range") === "week", "passes category and time range, case-folded");
  ok(r.hits.length === 2, "respects the limit");
  ok(r.hits[0].title === "Home Assistant MCP" && r.hits[0].snippet === "The official server", "strips markup and collapses whitespace");
  ok(r.hits[0].published === "2026-09-20", "keeps the publish date");
  ok(r.hits[1].title === "https://b.example", "an untitled result falls back to its URL");
  ok(/duckduckgo/.test(r.text), "names the engines that did not answer");

  const seen2: Seen[] = [];
  await S.webSearch({ query: "x", category: "porn", timeRange: "decade" }, { fetchImpl: fakeFetch({ "/search": { results: [] } }, seen2) });
  const q2 = new URL(seen2[0].url).searchParams;
  ok(!q2.has("categories") && !q2.has("time_range"), "an unknown category or range is dropped, not forwarded");

  const empty = await S.webSearch({ query: "zzz" }, { fetchImpl: fakeFetch({ "/search": { results: [], unresponsive_engines: [] } }) });
  ok(/No results/.test(empty.text), "says so when nothing matched");

  const down = await rejects(S.webSearch({ query: "x" }, { fetchImpl: refused }));
  ok(down instanceof S.ServiceDownError && /selfhosted:setup searxng/.test(down.message), "an unreachable SearXNG is a ServiceDownError with the fix in it");

  const html = await rejects(S.webSearch({ query: "x" }, { fetchImpl: fakeFetch({ "/search": new Response("<html>", { status: 200 }) }) }));
  ok(!!html && /JSON output/.test(html.message), "an HTML answer (JSON format disabled) is explained, not a parse crash");
}

// ── Glances ─────────────────────────────────────────────────────────────────
console.log("\nGlances\n");
{
  const GB = 2 ** 30;
  const routes = {
    "/api/4/quicklook": { cpu: 46.5 },
    "/api/4/mem": { percent: 78.6, available: 1.7 * GB },
    "/api/4/memswap": { percent: 85.5 },
    "/api/4/load": { min1: 2.7, cpucore: 8 },
    "/api/4/fs": [
      { mnt_point: "/", size: 228 * GB, free: 6 * GB, percent: 62 },
      { mnt_point: "/System/Volumes/Data", size: 228 * GB, free: 6 * GB, percent: 96.5 },
      { mnt_point: "/System/Volumes/VM", size: 228 * GB, free: 6 * GB, percent: 41 },
      { mnt_point: "/System/Volumes/xarts", size: 0.5 * GB, free: 0, percent: 1 },
      { mnt_point: "/Volumes/dmg.YbOfWr", size: 2 * GB, free: 1 * GB, percent: 33 },
      { mnt_point: "/Volumes/Backup", size: 1000 * GB, free: 500 * GB, percent: 50 },
    ],
    "/api/4/sensors": [{ type: "battery", value: 53, status: "Discharging", label: "Battery" }],
    "/api/4/alert": [
      { type: "MEMSWAP", state: "WARNING", end: -1 },
      { type: "MEM", state: "WARNING", end: -1 },
      { type: "CPU_TOTAL", state: "CRITICAL", end: 1790000000 },
    ],
    "/api/4/uptime": "2 days, 3:41:48",
    "/api/4/processlist/top/5": [
      { name: "Renderer", cpu_percent: 7.94, memory_percent: 4, pid: 1 },
      { name: "claude", cpu_percent: 3.7, memory_percent: 3, pid: 2 },
    ],
    "/api/4/processlist": [
      { name: "small", cpu_percent: 50, memory_percent: 1, pid: 3 },
      { name: "hog", cpu_percent: 1, memory_percent: 30, pid: 4 },
    ],
  };
  const r = await S.systemSitrep("cpu", { fetchImpl: fakeFetch(routes) });
  ok(r.cpu === 47 && r.memPercent === 79 && r.swapPercent === 86, "reads CPU, memory and swap");
  ok(r.disks.map((d) => d.mount).join(",") === "Macintosh HD,/Volumes/Backup", "macOS system volumes, tiny volumes and mounted installers are hidden; the Data volume shows as Macintosh HD");
  ok(r.warnings.includes("Macintosh HD is 97% full, 6.0 GB left"), "a nearly full disk becomes a warning");
  ok(r.warnings.includes("swap warning") && r.warnings.includes("memory warning"), "Glances' ongoing alerts are reported in words");
  ok(!r.warnings.some((w) => /CPU/i.test(w)), "an alert that has already ended is not");
  ok(r.battery?.percent === 53 && r.battery.status === "discharging", "battery level and state");
  ok(/Up 2 days, 3h 41m/.test(r.text), "uptime is spoken as hours and minutes");
  ok(r.top[0].name === "Renderer" && r.top[0].cpu === 7.9, "busiest processes by CPU");

  const m = await S.systemSitrep("memory", { fetchImpl: fakeFetch(routes) });
  ok(m.top[0].name === "hog", "sorting by memory ranks the full process list by memory");

  let topCalls = 0;
  const fresh = await S.systemSitrep("cpu", {
    fetchImpl: fakeFetch({
      ...routes,
      "/api/4/processlist/top/5": () => (++topCalls === 1
        ? [{ name: "a", cpu_percent: 0, memory_percent: 1, pid: 1 }]
        : [{ name: "a", cpu_percent: 12.3, memory_percent: 1, pid: 1 }]),
    }),
  });
  ok(topCalls === 2 && fresh.top[0].cpu === 12.3, "an all-zero process list (Glances just started) is read again once");

  const down = await rejects(S.systemSitrep("cpu", { fetchImpl: refused }));
  ok(down instanceof S.ServiceDownError, "an unreachable Glances is a ServiceDownError");
}

// ── autostart guard ─────────────────────────────────────────────────────────
console.log("\nAutostart\n");
{
  process.env.GLANCES_URL = "http://10.0.0.9:61208";
  let calls = 0;
  const err = await rejects(S.withAutostart("glances", "/nonexistent", async () => {
    calls++;
    throw new S.ServiceDownError("down");
  }, 500));
  ok(err instanceof S.ServiceDownError && calls === 1, "a service pointed elsewhere by its URL variable is never launched locally");
  delete process.env.GLANCES_URL;

  const other = await rejects(S.withAutostart("searxng", "/nonexistent", async () => { throw new Error("answered 500"); }, 500));
  ok(other?.message === "answered 500", "only 'not reachable' triggers a launch; other errors pass straight through");
  ok(S.localLaunch("searxng", "/nonexistent") === null, "no local install means no launch");
}

// ── the gate ────────────────────────────────────────────────────────────────
console.log("\nRisk gate\n");
{
  const ctx = { workingDir: "/tmp" } as any;
  for (const t of ["web_search", "system_sitrep"]) {
    ok(classify(t, {}, ctx).tier === "low", `${t} is classified as reading`);
    ok(TOOL_MAP.get(t)?.readOnly === true, `${t} is registered read-only`);
  }
}

console.log(`\n${pass}/${pass + fail} self-hosted checks passed\n`);
process.exit(fail ? 1 : 0);
