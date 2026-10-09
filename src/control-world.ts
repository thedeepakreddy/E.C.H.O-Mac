import { HOSTED_BASE, osirisFetch } from "./tools/osiris-intel.js";

export const WORLD_REFRESH_MS = 30_000;
export const WORLD_FEEDS = ["conflicts", "earthquakes", "fires", "weather"] as const;
export type WorldFeed = typeof WORLD_FEEDS[number];
export interface WorldFeedState {
  status: "current" | "stale" | "unavailable";
  updatedAt: number | null;
  sourceUpdatedAt: number | null;
}
export interface WorldConflict { label: string; severity: string; description: string; latest: { title: string; url: string | null } | null }
export interface WorldQuake { magnitude: number; place: string; at: number; depthKm: number | null; tsunami: boolean; url: string | null }
export interface WorldStorm { title: string; type: string; severity: string; source: string; at: number | null }
export interface WorldSnapshot {
  checkedAt: number;
  feeds: Record<WorldFeed, WorldFeedState>;
  conflicts: WorldConflict[];
  earthquakes: { count: number | null; top: WorldQuake[] };
  tsunamis: WorldQuake[];
  fires: { count: number | null; highConfidence: number | null };
  storms: WorldStorm[];
}
const text = (value: unknown, max = 240) => typeof value === "string" ? value.trim().slice(0, max) : "";
const time = (value: unknown): number | null => {
  const n = typeof value === "string" ? Date.parse(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};
const link = (value: unknown): string | null => {
  try { const u = new URL(String(value)); return u.protocol === "https:" && !u.username && !u.password ? u.href : null; } catch { return null; }
};

/** Fixed public feeds only. No credentials, model or Phone pairing are needed. */
export function createWorldReader(deps: {
  fetchFeed?: (name: WorldFeed) => Promise<any>;
  now?: () => number;
} = {}) {
  const now = deps.now ?? Date.now;
  const fetchFeed = deps.fetchFeed ?? (name => osirisFetch(`/api/${name}`, {base: HOSTED_BASE, timeoutMs: 10_000}));
  let checkedAt: number | null = null;
  let loading: Promise<WorldSnapshot> | null = null;
  let conflicts: WorldConflict[] = [], quakes: WorldQuake[] = [], storms: WorldStorm[] = [];
  let fires: WorldSnapshot["fires"] = {count: null, highConfidence: null};
  const feeds = Object.fromEntries(WORLD_FEEDS.map(name => [name, {status: "unavailable", updatedAt: null, sourceUpdatedAt: null}])) as WorldSnapshot["feeds"];
  const snapshot = (): WorldSnapshot => {
    // Cached earthquake observations still age out of the rolling 24-hour window.
    const recent = quakes.filter(q => q.at > now() - 86_400_000 && q.at <= now());
    return structuredClone({checkedAt: checkedAt ?? now(), feeds, conflicts,
      earthquakes: {count: feeds.earthquakes.updatedAt === null ? null : recent.length,
        top: [...recent].sort((a, b) => b.magnitude - a.magnitude).slice(0, 12)},
      tsunamis: recent.filter(q => q.tsunami), fires, storms});
  };
  return async function readWorld(): Promise<WorldSnapshot> {
    if (loading) return loading;
    if (checkedAt !== null && now() - checkedAt < WORLD_REFRESH_MS) return snapshot();
    loading = (async () => {
      await Promise.all(WORLD_FEEDS.map(async name => {
        try {
          const data = await fetchFeed(name);
          const key = {conflicts: "zones", earthquakes: "earthquakes", fires: "fires", weather: "events"}[name];
          if (!data || data.error || !Array.isArray(data[key])) throw new Error("Invalid feed");
          const list = data[key].filter((item: any) => item && typeof item === "object");
          if (name === "conflicts") conflicts = list.slice(0, 120).map((z: any) => {
            const latest = Array.isArray(z.events) ? z.events.find((e: any) => e && text(e.title)) : null;
            return {label: text(z.label), severity: text(z.severity, 40), description: text(z.description),
              latest: latest ? {title: text(latest.title, 200), url: link(latest.url)} : null};
          }).filter((z: WorldConflict) => z.label);
          if (name === "earthquakes") quakes = list.filter((q: any) => Number.isFinite(q.magnitude) && time(q.time) !== null)
            .map((q: any) => ({magnitude: q.magnitude, place: text(q.place), at: time(q.time)!,
              depthKm: Number.isFinite(q.depth) ? q.depth : null, tsunami: q.tsunami === true || q.tsunami === 1, url: link(q.url)}));
          if (name === "fires") fires = {count: list.length, highConfidence: list.filter((f: any) => /^(h|high)$/i.test(text(f.confidence))).length};
          if (name === "weather") storms = list.slice(0, 12).map((e: any) => ({title: text(e.title), type: text(e.type, 60),
            severity: text(e.severity, 40), source: text(e.provider, 60), at: time(e.date)})).filter((e: WorldStorm) => e.title);
          feeds[name] = {status: "current", updatedAt: now(), sourceUpdatedAt: time(data.timestamp)};
        } catch {
          feeds[name] = {...feeds[name], status: feeds[name].updatedAt === null ? "unavailable" : "stale"};
        }
      }));
      checkedAt = now();
      return snapshot();
    })().finally(() => { loading = null; });
    return loading;
  };
}
export const getControlWorld = createWorldReader();
