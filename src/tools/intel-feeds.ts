/**
 * Open intelligence feeds Echo can answer out loud.
 *
 * Osiris (osiris-intel.ts) is ONE service with many layers, read through one
 * base URL. These are five unrelated public sources, each with its own host,
 * shape and failure mode, so they are kept apart from it rather than bolted
 * into its layer catalogue:
 *
 *   satellites  CelesTrak orbital elements + SGP4 — where something is NOW and
 *               when it next passes over you. Osiris draws satellites; this
 *               one answers about a named satellite from where you stand.
 *   news        GDELT — world news as machine-read events, any topic, 100+
 *               languages. Osiris's intel feed is curated; this is queryable.
 *   nearby      Overpass over OpenStreetMap — not a feed but a QUERY language
 *               over the world map: what is actually around this point.
 *   network     RIPEstat — BGP and registry data. Who owns this address, what
 *               are they announcing, does the routing look sane.
 *   exploited   CISA KEV — vulnerabilities confirmed exploited in the wild.
 *               The few hundred that matter out of tens of thousands of CVEs.
 *
 * Every one is free and keyless, which is why these five and not others: the
 * obvious neighbours (OpenSanctions, abuse.ch, OpenAQ, Cloudflare Radar) all
 * answered 401 when probed — still free, but registration now.
 *
 * Deliberately imports nothing from Electron, so `npm run inteltest` exercises
 * the whole thing in plain Node — the same rule osiris-intel.ts follows.
 */
import { speakList } from "./osiris-intel.js";

// ── shared plumbing ───────────────────────────────────────────────────────

/** Public APIs are politer to a request that says who it is. */
const UA = "Echo/1.0 (+https://osirisai.live) voice assistant";

export interface FetchOpts {
  timeoutMs?: number;
  /** Testing seam: swap the network out entirely. */
  fetchImpl?: typeof fetch;
}

async function getText(url: string, opts: FetchOpts = {}): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return body;
}

async function getJson(url: string, opts: FetchOpts = {}): Promise<any> {
  const body = await getText(url, opts);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${new URL(url).hostname} answered with a page instead of data`);
  }
}

/**
 * A tiny TTL cache, because two of these sources genuinely require it: GDELT
 * rate-limits to one request every five seconds (a second question inside that
 * window gets a 429, not data), and the KEV catalogue is a 1.7MB download that
 * changes at most daily. Asking either one twice in a conversation is rude to
 * them and slow for the user.
 */
const cache = new Map<string, { at: number; value: unknown }>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** For tests, and for "ignore what you already know". */
export function clearIntelCache(): void {
  cache.clear();
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

/**
 * A place name to coordinates, via Open-Meteo's free geocoder — the same one
 * the control panel's weather card uses, so "Hyderabad" resolves identically
 * in both places.
 */
export async function geocode(query: string, opts: FetchOpts = {}): Promise<Place | null> {
  const q = query.trim();
  if (!q) return null;
  // "17.38,78.48" — coordinates given directly, no lookup needed.
  const pair = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (pair) {
    const lat = Number(pair[1]);
    const lon = Number(pair[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { name: `${lat}, ${lon}`, lat, lon };
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(q)}`;
  const j = await cached(`geo:${q.toLowerCase()}`, 24 * 3600_000, () => getJson(url, opts));
  const hit = j?.results?.[0];
  if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return null;
  return {
    name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
    lat: hit.latitude,
    lon: hit.longitude,
  };
}

/**
 * Where "here" is, when the user did not say.
 *
 * Derived from the system timezone's city ("Asia/Kolkata" -> "Kolkata"), which
 * is a coarse but honest guess that needs no permission prompt and no network
 * beyond the geocoder. The answer always names the place it used, so a wrong
 * guess is visible rather than silently shaping the result.
 */
export async function here(opts: FetchOpts & { timezone?: string } = {}): Promise<Place | null> {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  const city = tz.split("/").pop()?.replace(/_/g, " ") ?? "";
  if (!city) return null;
  return geocode(city, opts);
}

// ── the answer shape ──────────────────────────────────────────────────────

export interface IntelAnswer {
  /** Written for the ear: short, no URLs, no tables. */
  speak: string;
  /**
   * The parsed payload. Reaches the model through `ToolOutput.data`, which is
   * the only structured channel a tool has — there is deliberately no `html`
   * here. An earlier draft built HTML summaries for a panel card, and
   * `ToolOutput` carries only `text`, `image` and `data`, so every one of them
   * would have been assembled and thrown away. Rich output needs a panel
   * feature first; until there is one, this stays honest about what it can do.
   */
  data?: unknown;
}

export interface IntelSource {
  id: string;
  /** Spoken name, used in Echo's answer and in errors. */
  label: string;
  aliases: string[];
  /** What the argument means here, shown in the tool schema. */
  argHint: string;
  run(arg: string | undefined, opts: FetchOpts & { timezone?: string }): Promise<IntelAnswer>;
}


// ── satellites: CelesTrak + SGP4 ──────────────────────────────────────────

/**
 * CelesTrak publishes orbital ELEMENTS, not positions: a small set of numbers
 * from which SGP4 computes where the object is at any time. So one download
 * answers "where is it now" and "when does it next pass over me" for days,
 * entirely offline afterwards.
 */
const SAT_TTL = 6 * 3600_000; // elements are refreshed a few times a day

/**
 * Names people say, mapped to catalogue numbers.
 *
 * CelesTrak's `NAME=` is a SUBSTRING search, so asking for "ISS" returns
 * `UME (ISS)` — a Japanese satellite launched in 1976 whose name happens to
 * contain those letters — at 997km, and Echo confidently reports the wrong
 * object. For the handful of satellites anyone asks for by name, go straight
 * to the catalogue number instead.
 */
const WELL_KNOWN: Record<string, string> = {
  iss: "25544",
  "space station": "25544",
  "international space station": "25544",
  zarya: "25544",
  css: "48274",
  tiangong: "48274",
  hubble: "20580",
  hst: "20580",
  "james webb": "50463",
  jwst: "50463",
};

async function satelliteElements(query: string, opts: FetchOpts): Promise<any[]> {
  const q = query.trim();
  const known = WELL_KNOWN[q.toLowerCase()];
  const catnr = known ?? (/^\d+$/.test(q) ? q : "");
  const url = catnr
    ? `https://celestrak.org/NORAD/elements/gp.php?CATNR=${encodeURIComponent(catnr)}&FORMAT=json`
    : `https://celestrak.org/NORAD/elements/gp.php?NAME=${encodeURIComponent(q)}&FORMAT=json`;
  const j = await cached(`sat:${catnr || q.toLowerCase()}`, SAT_TTL, () => getJson(url, opts));
  const all: any[] = Array.isArray(j) ? j : [];
  if (catnr || all.length < 2) return all;
  // A substring search: an exact name wins over one that merely contains it.
  const want = q.toLowerCase();
  const exact = all.filter((o) => String(o.OBJECT_NAME ?? "").trim().toLowerCase() === want);
  const starts = all.filter((o) => String(o.OBJECT_NAME ?? "").trim().toLowerCase().startsWith(want));
  return exact.length ? exact : starts.length ? starts : all;
}

const satellites: IntelSource = {
  id: "satellites",
  label: "satellites",
  aliases: ["satellite", "sat", "iss", "space station", "orbit", "pass", "passes", "overhead", "starlink"],
  argHint: 'a satellite name or NORAD id, optionally "over <place>" — e.g. "ISS over Hyderabad"',
  async run(arg, opts) {
    // "ISS over Hyderabad" / "25544" / "" -> ISS, here
    const raw = (arg ?? "").trim() || "ISS";
    const overMatch = raw.match(/^(.*?)\s+(?:over|above|from)\s+(.+)$/i);
    const name = (overMatch ? overMatch[1] : raw).trim() || "ISS";
    const placeQuery = overMatch ? overMatch[2].trim() : "";

    const elements = await satelliteElements(name, opts);
    if (!elements.length) {
      return { speak: `I couldn't find a satellite called ${name} in the CelesTrak catalogue.` };
    }
    const place = placeQuery ? await geocode(placeQuery, opts) : await here(opts);

    const sat: any = await import("satellite.js");
    const now = new Date();
    const spoken: string[] = [];

    for (const omm of elements.slice(0, 3)) {
      let rec: any;
      try {
        rec = sat.json2satrec(omm);
      } catch {
        continue;
      }
      const pv = sat.propagate(rec, now);
      if (!pv?.position) continue;
      const gmst = sat.gstime(now);
      const geo = sat.eciToGeodetic(pv.position, gmst);
      const lat = sat.degreesLat(geo.latitude);
      const lon = sat.degreesLong(geo.longitude);
      const altKm = geo.height;
      // Orbital period straight from mean motion, which is revolutions per day.
      const periodMin = 1440 / Number(omm.MEAN_MOTION || 0);

      let passLine = "";
      if (place) {
        const obs = {
          latitude: sat.degreesToRadians(place.lat),
          longitude: sat.degreesToRadians(place.lon),
          height: 0.1,
        };
        const pass = nextPass(sat, rec, obs, now);
        passLine = pass
          ? `next pass above 10° from ${place.name} at ${pass.when}, ${pass.peakEl}° up`
          : `no pass above 10° over ${place.name} in the next 24 hours`;
      }

      const label = String(omm.OBJECT_NAME ?? "satellite").trim();
      spoken.push(
        `${label} is over ${Math.abs(lat).toFixed(0)}° ${lat >= 0 ? "north" : "south"}, ` +
          `${Math.abs(lon).toFixed(0)}° ${lon >= 0 ? "east" : "west"}, at ${altKm.toFixed(0)} kilometres, ` +
          `going round once every ${periodMin.toFixed(0)} minutes` +
          (passLine ? `. ${passLine}` : "")
      );
    }

    if (!spoken.length) return { speak: `CelesTrak has ${name}, but its elements could not be propagated.` };
    return { speak: spoken.join(" "), data: elements.slice(0, 3) };
  },
};

/** Step forward a minute at a time looking for the next rise above 10°. */
function nextPass(
  sat: any,
  rec: any,
  obs: { latitude: number; longitude: number; height: number },
  from: Date
): { when: string; peakEl: number } | null {
  let best = -90;
  let bestAt: Date | null = null;
  for (let m = 0; m < 1440; m++) {
    const t = new Date(from.getTime() + m * 60_000);
    const pv = sat.propagate(rec, t);
    if (!pv?.position) continue;
    const look = sat.ecfToLookAngles(obs, sat.eciToEcf(pv.position, sat.gstime(t)));
    const el = sat.radiansToDegrees(look.elevation);
    if (el > 10) {
      // Walk the rest of this pass to report its highest point, which is what
      // decides whether it is actually worth going outside for.
      for (let k = m; k < 1440; k++) {
        const t2 = new Date(from.getTime() + k * 60_000);
        const p2 = sat.propagate(rec, t2);
        if (!p2?.position) break;
        const e2 = sat.radiansToDegrees(
          sat.ecfToLookAngles(obs, sat.eciToEcf(p2.position, sat.gstime(t2))).elevation
        );
        if (e2 <= 10) break;
        if (e2 > best) {
          best = e2;
          bestAt = t2;
        }
      }
      const start = new Date(from.getTime() + m * 60_000);
      return {
        when: start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        peakEl: Math.round(best),
      };
    }
  }
  return null;
}

// ── news: GDELT ───────────────────────────────────────────────────────────

/**
 * Half an hour, not five minutes. GDELT's published limit is one request every
 * five seconds, but in practice it punishes a bursty client for far longer —
 * after a session of testing it answered 429 to every request for many minutes,
 * including ones twenty-five seconds apart. World coverage of a topic does not
 * change meaningfully in half an hour, and a cached answer costs the service
 * nothing.
 */
const GDELT_TTL = 30 * 60_000;

const news: IntelSource = {
  id: "news",
  label: "world news",
  aliases: ["news", "headlines", "gdelt", "world news", "coverage", "stories about"],
  argHint: "a topic, place or name to search world coverage for",
  async run(arg, opts) {
    const q = (arg ?? "").trim();
    if (!q) return { speak: "Tell me what to search the news for." };
    const url =
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}` +
      `&mode=artlist&maxrecords=8&sort=datedesc&format=json`;
    // GDELT is the slowest and least reliable of these services, and both
    // halves of that matter. Measured over four attempts twenty seconds apart:
    // one connection failure at 10.5s, one 429 at 11.4s, then two successes at
    // 20.3s and 13.0s. So a fifteen-second timeout races its ordinary response
    // and reports a healthy service as broken, and a single attempt fails
    // roughly half the time for reasons that clear on their own.
    //
    // Hence a generous timeout and exactly one retry. Not more: its published
    // limit is one request every five seconds, and retrying harder is how a
    // client earns a longer ban rather than an answer.
    const j = await cached(`gdelt:${q.toLowerCase()}`, GDELT_TTL, async () => {
      const timeoutMs = opts.timeoutMs ?? 30_000;
      let last: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 6_000)); // clear its window first
        try {
          return await getJson(url, { ...opts, timeoutMs });
        } catch (e: any) {
          last = e;
        }
      }
      const m = String(last?.message ?? last);
      throw new Error(
        /429/.test(m)
          ? "GDELT is rate-limiting this connection — it allows one request every few seconds"
          : `GDELT did not answer (${m})`
      );
    });
    const arts: any[] = Array.isArray(j?.articles) ? j.articles : [];
    if (!arts.length) return { speak: `GDELT has no recent coverage of ${q}.` };

    const titles = arts.slice(0, 3).map((a) => String(a.title ?? "").replace(/\s+-\s+[^-]*$/, "").trim());
    const langs = new Set(arts.map((a) => String(a.language ?? "")).filter(Boolean));
    return {
      speak:
        `${arts.length} recent stories on ${q}` +
        (langs.size > 1 ? ` across ${langs.size} languages` : "") +
        `. ${speakList(titles)}`,
      data: arts,
    };
  },
};

// ── nearby: Overpass / OpenStreetMap ──────────────────────────────────────

/**
 * Spoken words for the things people actually ask about, mapped to the OSM
 * tags that represent them. Overpass is a query language, not a search box:
 * "pharmacy" has to become `amenity=pharmacy` or it finds nothing.
 */
const OSM_TAGS: Array<[RegExp, string]> = [
  [/pharmac|chemist|medical store/i, 'amenity=pharmacy'],
  [/hospital|emergency/i, 'amenity=hospital'],
  [/atm|cash machine/i, 'amenity=atm'],
  [/bank/i, 'amenity=bank'],
  [/cafe|coffee/i, 'amenity=cafe'],
  [/restaurant|food|eat/i, 'amenity=restaurant'],
  [/fuel|petrol|gas station/i, 'amenity=fuel'],
  [/charging|ev charge/i, 'amenity=charging_station'],
  [/supermarket|grocer/i, 'shop=supermarket'],
  [/police/i, 'amenity=police'],
  [/toilet|restroom/i, 'amenity=toilets'],
  [/water|drinking/i, 'amenity=drinking_water'],
  [/park\b|garden/i, 'leisure=park'],
  [/bus stop|bus/i, 'highway=bus_stop'],
  [/train|railway|metro|station/i, 'railway=station'],
  [/airport/i, 'aeroway=aerodrome'],
  [/hotel|stay/i, 'tourism=hotel'],
  [/library/i, 'amenity=library'],
];

const nearby: IntelSource = {
  id: "nearby",
  label: "what's nearby",
  aliases: ["nearby", "near me", "around me", "closest", "nearest", "overpass", "osm", "find nearby"],
  argHint: 'what to look for, optionally "near <place>" — e.g. "pharmacy near Banjara Hills"',
  async run(arg, opts) {
    const raw = (arg ?? "").trim();
    if (!raw) return { speak: "Tell me what to look for nearby." };
    const nearMatch = raw.match(/^(.*?)\s+(?:near|around|by|close to|in)\s+(.+)$/i);
    const what = (nearMatch ? nearMatch[1] : raw).trim();
    const placeQuery = nearMatch ? nearMatch[2].trim() : "";

    const tag = OSM_TAGS.find(([re]) => re.test(what))?.[1];
    if (!tag) {
      return {
        speak: `I don't have an OpenStreetMap tag for "${what}". Try a pharmacy, hospital, ATM, cafe, fuel, supermarket, park or station.`,
      };
    }
    const place = placeQuery ? await geocode(placeQuery, opts) : await here(opts);
    if (!place) return { speak: "I couldn't work out where to search around." };

    // Widen once rather than answer "nothing nearby" when the nearest is just
    // outside the circle. Measured: Hyderabad's centre has no pharmacy mapped
    // within 1.5km but several within 2km, and "none within 1.5 kilometres" is
    // a true statement that is useless to someone who wants a pharmacy.
    const [k, v] = tag.split("=");
    const query = (radius: number) =>
      `[out:json][timeout:20];` +
      `(node["${k}"="${v}"](around:${radius},${place.lat},${place.lon});` +
      `way["${k}"="${v}"](around:${radius},${place.lat},${place.lon}););` +
      `out center 30;`;
    // ONE request at a radius wide enough to be useful, not two that narrow.
    // The widen-if-empty version doubled the load on a service that is already
    // the flakiest dependency here — public Overpass answers 504 under load
    // several times an hour — and made a timeout twice as likely in exchange
    // for a slightly tighter number.
    const radius = 2500;
    const j = await overpass(query(radius), opts);
    const els: any[] = Array.isArray(j?.elements) ? j.elements : [];
    const found = els
      .map((e: any) => ({
        name: String(e.tags?.name ?? "").trim(),
        lat: e.lat ?? e.center?.lat,
        lon: e.lon ?? e.center?.lon,
      }))
      .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon))
      .map((e) => ({ ...e, m: Math.round(haversine(place.lat, place.lon, e.lat, e.lon)) }))
      .sort((a, b) => a.m - b.m);

    if (!found.length) {
      return { speak: `No ${what} mapped within ${radius / 1000} kilometres of ${place.name}.` };
    }
    const km = radius / 1000;
    const named = found.filter((f) => f.name);
    const top = (named.length ? named : found).slice(0, 3);
    return {
      speak:
        `${found.length} ${what} within ${km} kilometre${km === 1 ? "" : "s"} of ${place.name}. ` +
        speakList(top.map((f) => `${f.name || "one unnamed"} about ${f.m} metres away`)),
      data: found,
    };
  },
};

/**
 * Overpass, whichever instance is answering today.
 *
 * The main one returns 504 under load often enough that one host is not a
 * usable dependency. But a mirror list has a trap that is worse than an
 * outage: SOME PUBLIC INSTANCES SERVE A REGIONAL EXTRACT, and they answer a
 * query outside their region with `200 OK` and an empty result — not an error.
 *
 * Measured: overpass.osm.ch (the Swiss chapter's) was the fastest host by far
 * at 613ms, so it was tried first — and it returned "5 pharmacies" for Zurich
 * and "0 pharmacies" for Hyderabad and London. Echo was confidently telling
 * the user nothing was mapped near them. A silently wrong answer beat a slow
 * right one purely because it was quicker.
 *
 * So every host here must be verified GLOBAL, on more than one continent,
 * before it is added. Of the well-known public instances, only these two
 * answered for Hyderabad, London and Zurich alike; kumi.systems and
 * private.coffee were unreachable from this network entirely.
 *
 * Note the second is operated by mail.ru. A query carries the point being
 * asked about, so it reveals a rough location to whoever runs the instance —
 * fine for "a pharmacy in this city", worth knowing before it becomes a habit.
 * Drop it from this list to use only the canonical instance.
 */
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

async function overpass(ql: string, opts: FetchOpts): Promise<any> {
  let last = "";
  for (const host of OVERPASS_MIRRORS) {
    try {
      return await getJson(`${host}?data=${encodeURIComponent(ql)}`, {
        ...opts,
        timeoutMs: opts.timeoutMs ?? 20_000,
      });
    } catch (e: any) {
      last = String(e?.message ?? e);
    }
  }
  throw new Error(`every OpenStreetMap mirror refused (${last})`);
}

/** Metres between two points on the earth. */
function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const p = Math.PI / 180;
  const dLat = (bLat - aLat) * p;
  const dLon = (bLon - aLon) * p;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ── network: RIPEstat ─────────────────────────────────────────────────────

const network: IntelSource = {
  id: "network",
  label: "network ownership",
  aliases: ["network", "bgp", "asn", "as", "routing", "whois", "ip owner", "who owns"],
  argHint: 'an IP address, prefix or AS number — e.g. "8.8.8.8" or "AS15169"',
  async run(arg, opts) {
    const q = (arg ?? "").trim().replace(/^as\s*/i, "AS");
    if (!q) return { speak: "Give me an IP address, a prefix or an AS number." };

    if (/^AS?\d+$/i.test(q)) {
      const asn = q.replace(/^AS/i, "");
      const [overview, prefixes] = await Promise.all([
        getJson(`https://stat.ripe.net/data/as-overview/data.json?resource=AS${asn}`, opts),
        getJson(`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`, opts).catch(() => null),
      ]);
      const holder = overview?.data?.holder ?? "unknown";
      const announced = overview?.data?.announced;
      const count = prefixes?.data?.prefixes?.length ?? null;
      return {
        speak:
          `AS${asn} belongs to ${holder}. ` +
          (announced === false
            ? "It isn't announcing anything right now."
            : count !== null
              ? `It announces ${count} prefix${count === 1 ? "" : "es"}.`
              : "It is announced."),
        data: { overview: overview?.data, prefixes: prefixes?.data },
      };
    }

    const info = await getJson(
      `https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(q)}`,
      opts
    );
    const prefix = info?.data?.prefix;
    const asns: string[] = info?.data?.asns ?? [];
    if (!prefix) return { speak: `RIPEstat doesn't recognise ${q} as an address or prefix.` };
    let holder = "";
    if (asns[0]) {
      const ov = await getJson(
        `https://stat.ripe.net/data/as-overview/data.json?resource=AS${asns[0]}`,
        opts
      ).catch(() => null);
      holder = ov?.data?.holder ?? "";
    }
    return {
      speak:
        `${q} sits in ${prefix}` +
        (asns.length ? `, announced by AS${asns[0]}${holder ? `, ${holder}` : ""}` : ", not currently announced") +
        ".",
      data: info?.data,
    };
  },
};

// ── exploited: CISA KEV ───────────────────────────────────────────────────

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const KEV_TTL = 6 * 3600_000; // 1.7MB, changes at most daily

const exploited: IntelSource = {
  id: "exploited",
  label: "exploited vulnerabilities",
  aliases: ["exploited", "kev", "cve", "vulnerabilities", "vulns", "patch", "cisa", "being exploited"],
  argHint: 'optional vendor, product or CVE id — e.g. "Chrome", "CVE-2026-1234"',
  async run(arg, opts) {
    const j = await cached("kev", KEV_TTL, () => getJson(KEV_URL, { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 }));
    const all: any[] = Array.isArray(j?.vulnerabilities) ? j.vulnerabilities : [];
    if (!all.length) throw new Error("the KEV catalogue came back empty");

    const q = (arg ?? "").trim().toLowerCase();
    // The catalogue is NOT ordered by dateAdded — sort, never assume.
    const byDate = [...all].sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));

    if (!q) {
      const newest = byDate.slice(0, 3);
      const latest = newest[0]?.dateAdded ?? "";
      const sameDay = byDate.filter((v) => v.dateAdded === latest).length;
      return {
        speak:
          `${all.length} vulnerabilities are known to be exploited. ` +
          `The most recent batch was added ${latest}: ${sameDay} of them. ` +
          speakList(newest.map((v) => `${v.cveID}, ${v.vendorProject} ${v.product}`)),
        data: { count: all.length, newest },
      };
    }

    const hits = byDate.filter((v) =>
      `${v.cveID} ${v.vendorProject} ${v.product} ${v.vulnerabilityName}`.toLowerCase().includes(q)
    );
    if (!hits.length) return { speak: `Nothing matching ${arg} is in the CISA known-exploited-vulnerability catalogue. Absence from KEV does not establish that it is safe or unexploited.` };
    const top = hits.slice(0, 3);
    const ransom = hits.filter((v) => v.knownRansomwareCampaignUse === "Known").length;
    return {
      speak:
        `${hits.length} exploited ${hits.length === 1 ? "vulnerability matches" : "vulnerabilities match"} ${arg}` +
        (ransom ? `, ${ransom} used in ransomware` : "") +
        `. ` +
        speakList(top.map((v) => `${v.cveID}, ${v.vulnerabilityName}`)),
      data: hits.slice(0, 25),
    };
  },
};

// ── what the panel shows ──────────────────────────────────────────────────

export interface IntelEntry {
  id: string;
  /** The source's spoken name, for the card's heading. */
  label: string;
  query: string;
  answer: string;
  at: number;
  ok: boolean;
}

/**
 * The last few answers, for the control panel's Intel card.
 *
 * Kept HERE rather than pushed into the panel's telemetry so this module still
 * imports nothing from Electron and `inteltest` keeps running in plain Node.
 * The panel reads it; nothing here knows the panel exists.
 *
 * Bounded at six because the card shows three and a ring buffer that grows is
 * a leak with extra steps.
 */
const RECENT_MAX = 6;
const recent: IntelEntry[] = [];

export function recordIntel(entry: Omit<IntelEntry, "id" | "at">): void {
  recent.unshift({ ...entry, id: `${Date.now()}-${recent.length}`, at: Date.now() });
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
}

export function recentIntel(): IntelEntry[] {
  return recent.slice();
}

/** For tests. */
export function clearRecentIntel(): void {
  recent.length = 0;
}

// ── catalogue ─────────────────────────────────────────────────────────────

export const INTEL_SOURCES: IntelSource[] = [satellites, news, nearby, network, exploited];

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Match a spoken source name ("passes", "who owns this IP") to a source.
 *
 * The loose pass at the end matches whole WORDS only, and ignores aliases
 * shorter than three characters. A plain `includes()` sent "astrology" to the
 * network source, because that source answers to "as" and the word contains
 * it — and a voice assistant that hears "astrology" and starts reciting BGP
 * announcements is worse than one that admits it did not understand.
 */
export function resolveIntelSource(name: string): IntelSource | undefined {
  const spoken = normalize(name);
  if (!spoken) return undefined;
  const words = new Set(spoken.split(" "));
  const hasPhrase = (alias: string) => {
    const a = normalize(alias);
    if (a.length < 3) return words.has(a); // "as", "sat" — exact word or nothing
    if (a.includes(" ")) return spoken.includes(a); // multi-word aliases stay substrings
    return words.has(a);
  };
  return (
    INTEL_SOURCES.find((s) => s.id === spoken.replace(/ /g, "_")) ??
    INTEL_SOURCES.find((s) => s.aliases.some((a) => normalize(a) === spoken)) ??
    INTEL_SOURCES.find((s) => normalize(s.label) === spoken) ??
    INTEL_SOURCES.find((s) => s.aliases.some(hasPhrase))
  );
}

/** Every spoken name Echo will recognise, for the tool description. */
export function intelSourceNames(): string {
  return INTEL_SOURCES.map((s) => `${s.id} (${s.label})`).join(", ");
}
