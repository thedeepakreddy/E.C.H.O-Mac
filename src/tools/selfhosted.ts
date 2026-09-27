/**
 * Self-hosted services Echo reads from, each one running on this machine:
 *
 *   SearXNG        private meta-search: web results as data, no API key, and
 *                  no single search engine sees every query.
 *   Glances        live system telemetry: CPU, memory, swap, disks, battery,
 *                  the busiest processes, and Glances' own warnings.
 *
 * Addresses come from SEARXNG_URL and GLANCES_URL, defaulting to the ports
 * scripts/selfhosted.mjs sets them up on. No Electron imports, so
 * `npm run selfhostedtest` runs it in plain Node against a fake network.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceOpts {
  baseUrl?: string;
  timeoutMs?: number;
  /** Testing seam: swap the network out entirely. */
  fetchImpl?: typeof fetch;
}

type Service = "searxng" | "glances";

const DEFAULT_URL: Record<Service, string> = {
  searxng: "http://127.0.0.1:8888",
  glances: "http://127.0.0.1:61208",
};
const ENV_URL: Record<Service, string> = { searxng: "SEARXNG_URL", glances: "GLANCES_URL" };
const LABEL: Record<Service, string> = { searxng: "SearXNG", glances: "Glances" };

export function serviceUrl(service: Service, opts: ServiceOpts = {}): string {
  return (opts.baseUrl || process.env[ENV_URL[service]]?.trim() || DEFAULT_URL[service]).replace(/\/+$/, "");
}

/** A request that could not reach the service at all, as opposed to one it refused. */
export class ServiceDownError extends Error {}

async function call(service: Service, path: string, opts: ServiceOpts, init: RequestInit = {}): Promise<any> {
  const base = serviceUrl(service, opts);
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      headers: { Accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") throw new Error(`${LABEL[service]} at ${base} did not answer in time`);
    throw new ServiceDownError(
      `${LABEL[service]} is not running at ${base}. Install it with: npm run selfhosted:setup ${service}`
    );
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`${LABEL[service]} answered ${res.status}: ${body.slice(0, 160)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${LABEL[service]} answered with a page instead of data — is JSON output enabled?`);
  }
}

/** How to launch a service installed by scripts/selfhosted.mjs, or null if it is not installed here. */
export function localLaunch(service: Service, appRoot: string): { cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | null {
  if (service === "glances") {
    const bin = join(homedir(), ".local", "bin", "glances");
    const port = new URL(DEFAULT_URL.glances).port;
    return existsSync(bin) ? { cmd: bin, args: ["-w", "--disable-webui", "--bind", "127.0.0.1", "--port", port] } : null;
  }
  if (service === "searxng") {
    const dir = join(appRoot, "vendor", "searxng");
    const py = join(dir, ".venv", "bin", "python");
    const settings = join(homedir(), ".jarvis", "searxng", "settings.yml");
    if (!existsSync(py) || !existsSync(settings)) return null;
    return { cmd: py, args: ["-m", "searx.webapp"], cwd: dir, env: { ...process.env, SEARXNG_SETTINGS_PATH: settings } };
  }
  return null;
}

const HEALTH: Record<Service, string> = { searxng: "/healthz", glances: "/api/4/status" };

/**
 * Run `fn`; if the service is down, installed locally and not pointed elsewhere
 * by its URL variable, start it in the background and try once more.
 */
export async function withAutostart<T>(service: Service, appRoot: string, fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ServiceDownError) || process.env[ENV_URL[service]]?.trim()) throw err;
    const launch = localLaunch(service, appRoot);
    if (!launch) throw err;
    console.log(`[selfhosted] ${LABEL[service]} was not running — starting it`);
    spawn(launch.cmd, launch.args, { cwd: launch.cwd, env: launch.env, detached: true, stdio: "ignore" }).unref();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750));
      const up = await fetch(`${DEFAULT_URL[service]}${HEALTH[service]}`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (up) return fn();
    }
    throw new Error(`${LABEL[service]} did not come up within ${waitMs / 1000}s of starting it`);
  }
}

const oneLine = (s: unknown, max = 200) =>
  String(s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, max);

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0)} GB`;

// ── SearXNG ───────────────────────────────────────────────────────────────

export const SEARCH_CATEGORIES = ["general", "news", "it", "science", "videos", "images", "map"] as const;
export const TIME_RANGES = ["day", "week", "month", "year"] as const;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  engines: string[];
  published?: string;
}

export interface WebSearchArgs {
  query: string;
  category?: string;
  timeRange?: string;
  limit?: number;
}

export async function webSearch(args: WebSearchArgs, opts: ServiceOpts = {}): Promise<{ text: string; hits: SearchHit[] }> {
  const query = args.query.trim();
  if (!query) throw new Error("say what to search for");
  const params = new URLSearchParams({ q: query, format: "json" });
  const category = args.category?.toLowerCase().trim();
  if (category && (SEARCH_CATEGORIES as readonly string[]).includes(category)) params.set("categories", category);
  const range = args.timeRange?.toLowerCase().trim();
  if (range && (TIME_RANGES as readonly string[]).includes(range)) params.set("time_range", range);

  const data = await call("searxng", `/search?${params}`, opts);
  const limit = Math.min(Math.max(args.limit ?? 6, 1), 15);
  const hits: SearchHit[] = (Array.isArray(data?.results) ? data.results : [])
    .filter((r: any) => r?.url)
    .slice(0, limit)
    .map((r: any) => ({
      title: oneLine(r.title, 140) || r.url,
      url: String(r.url),
      snippet: oneLine(r.content, 280),
      engines: Array.isArray(r.engines) ? r.engines.map(String) : [],
      ...(r.publishedDate ? { published: String(r.publishedDate).slice(0, 10) } : {}),
    }));

  const answers = (Array.isArray(data?.answers) ? data.answers : [])
    .map((a: any) => oneLine(typeof a === "string" ? a : a?.answer, 300))
    .filter(Boolean);
  const failed = (Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : [])
    .map((e: any) => (Array.isArray(e) ? e[0] : e))
    .filter(Boolean);

  if (!hits.length && !answers.length) {
    return {
      text: `No results for "${query}".${failed.length ? ` Engines that failed: ${failed.join(", ")}.` : ""}`,
      hits,
    };
  }
  const lines = hits.map(
    (h, i) => `${i + 1}. ${h.title}${h.published ? ` (${h.published})` : ""}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`
  );
  return {
    text:
      `Results for "${query}"${category ? ` in ${category}` : ""}${range ? `, past ${range}` : ""}:\n` +
      (answers.length ? `Direct answer: ${answers[0]}\n` : "") +
      lines.join("\n") +
      (failed.length ? `\n(Not answering right now: ${failed.join(", ")}.)` : ""),
    hits,
  };
}

// ── Glances ───────────────────────────────────────────────────────────────

const ALERT_WORDS: Record<string, string> = {
  MEM: "memory", MEMSWAP: "swap", LOAD: "system load", FS: "disk space",
  CPU_USER: "CPU", CPU_SYSTEM: "CPU", CPU_IOWAIT: "disk wait", CPU_TOTAL: "CPU", SENSORS: "temperature",
};

/**
 * The disks worth reporting. On macOS "/" is the sealed system snapshot and
 * /System/Volumes/Data is where the user's files actually live, so the second
 * one stands in for the first. Tiny and mounted-installer volumes are noise.
 */
export function relevantDisks(fs: any[]): Array<{ mount: string; percent: number; free: number; size: number }> {
  const all = (Array.isArray(fs) ? fs : []).filter((f) => Number(f?.size) >= 2 ** 30);
  const hasData = all.some((f) => f.mnt_point === "/System/Volumes/Data");
  return all
    .filter((f) => {
      const m = String(f.mnt_point);
      if (m === "/System/Volumes/Data") return true;
      if (m.startsWith("/System/Volumes/")) return false;
      if (m === "/" && hasData) return false;
      if (/^\/Volumes\/dmg\./.test(m)) return false;
      return true;
    })
    .map((f) => ({ mount: f.mnt_point === "/System/Volumes/Data" ? "Macintosh HD" : String(f.mnt_point), percent: Number(f.percent), free: Number(f.free), size: Number(f.size) }));
}

export interface Sitrep {
  text: string;
  cpu: number;
  memPercent: number;
  swapPercent: number;
  disks: ReturnType<typeof relevantDisks>;
  battery?: { percent: number; status: string };
  top: Array<{ name: string; cpu: number; mem: number; pid: number }>;
  warnings: string[];
}

export async function systemSitrep(sortBy: "cpu" | "memory" = "cpu", opts: ServiceOpts = {}): Promise<Sitrep> {
  const get = (p: string) => call("glances", `/api/4/${p}`, opts);
  const [quick, mem, swap, load, fs, sensors, alerts, uptime, procs] = await Promise.all([
    get("quicklook"), get("mem"), get("memswap"), get("load"), get("fs"), get("sensors"), get("alert"), get("uptime"),
    // The top/N endpoint follows Glances' own sort, which is CPU. For memory the
    // full list is sorted here — it is a few hundred KB over localhost.
    sortBy === "memory" ? get("processlist") : get("processlist/top/5"),
  ]);

  const cpu = Math.round(Number(quick?.cpu) || 0);
  const memPercent = Math.round(Number(mem?.percent) || 0);
  const swapPercent = Math.round(Number(swap?.percent) || 0);
  const disks = relevantDisks(fs);
  const bat = (Array.isArray(sensors) ? sensors : []).find((s: any) => s?.type === "battery");
  const battery = bat ? { percent: Math.round(Number(bat.value)), status: String(bat.status ?? "").toLowerCase() } : undefined;

  // Per-process CPU needs two samples, so a Glances that just started reports
  // every process at 0%. One refresh cycle later the numbers are real.
  let procList = procs;
  if (sortBy === "cpu" && Array.isArray(procs) && procs.length && procs.every((p: any) => !Number(p?.cpu_percent))) {
    await new Promise((r) => setTimeout(r, opts.fetchImpl ? 0 : 2500));
    procList = await get("processlist/top/5");
  }

  const key = sortBy === "memory" ? "memory_percent" : "cpu_percent";
  const top = (Array.isArray(procList) ? procList : [])
    .slice()
    .sort((a: any, b: any) => (Number(b?.[key]) || 0) - (Number(a?.[key]) || 0))
    .slice(0, 5)
    .map((p: any) => ({ name: String(p.name), cpu: Math.round((Number(p.cpu_percent) || 0) * 10) / 10, mem: Math.round((Number(p.memory_percent) || 0) * 10) / 10, pid: Number(p.pid) }));

  const warnings = [...new Set(
    (Array.isArray(alerts) ? alerts : [])
      .filter((a: any) => a?.end === -1)
      .map((a: any) => `${ALERT_WORDS[a.type] ?? String(a.type).toLowerCase()} ${String(a.state).toLowerCase()}`)
  )];
  for (const d of disks) {
    if (d.percent >= 90) warnings.push(`${d.mount} is ${Math.round(d.percent)}% full, ${gb(d.free)} left`);
  }

  const memFree = Number(mem?.available) || 0;
  const lines = [
    `CPU ${cpu}%, load ${Number(load?.min1 ?? 0).toFixed(1)} on ${load?.cpucore ?? "?"} cores.`,
    `Memory ${memPercent}% used (${gb(memFree)} available), swap ${swapPercent}%.`,
    ...disks.map((d) => `Disk ${d.mount}: ${Math.round(d.percent)}% full, ${gb(d.free)} free of ${gb(d.size)}.`),
    ...(battery ? [`Battery ${battery.percent}%${battery.status ? `, ${battery.status}` : ""}.`] : []),
    ...(uptime ? [`Up ${String(uptime).replace(/:\d\d$/, "").replace(/(\d+):(\d+)$/, "$1h $2m")}.`] : []),
    `Busiest by ${sortBy}: ${top.map((p) => `${p.name} ${sortBy === "memory" ? `${p.mem}% RAM` : `${p.cpu}% CPU`}`).join(", ") || "nothing notable"}.`,
    warnings.length ? `Warnings: ${warnings.join("; ")}.` : "No warnings.",
  ];
  return { text: lines.join("\n"), cpu, memPercent, swapPercent, disks, battery, top, warnings };
}
