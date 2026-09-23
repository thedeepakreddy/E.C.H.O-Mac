/** Finding things out: web search, research, open intelligence feeds, Osiris, maps, calendar and translation. Assembled into TOOLS by ../registry.ts. */
import type { ToolDef } from "../registry.js";
import { z } from "zod";
import type { LocationFilter } from "../osiris-intel.js";
import * as vision from "../vision.js";
import * as system from "../system.js";
import { join } from "node:path";
import { resolveDisplay } from "../displays.js";
import * as scan from "../../frontier/scan.js";
import * as translate from "../../frontier/translate.js";
import * as research from "../../frontier/research.js";
import * as researcher from "../../frontier/researcher.js";
import { qrDataUrl } from "../../frontier/remotelink.js";
import { sendToOverlay, toOverlaySpace } from "../../overlay.js";
import { nodeRequire, appRoot, pointerAt } from "./shared.js";

export const KNOWLEDGE_TOOLS: ToolDef[] = [
  {
    name: "research_while_away",
    description:
      "Queue a question for Jarvis to research while the user is away from the desk, producing a written brief with sources. Use this when they say 'look into X while I'm gone', 'find out about Y overnight', or ask you to research something for later. It only runs when they're actually away.",
    schema: {
      question: z.string().describe("What to find out, in the user's own words."),
    },
    readOnly: false,
    handler: async (a) => {
      const r = research.addQuestion(a.question);
      const status = researcher.isResearching() ? "" : ` ${researcher.researchStatus()}`;
      return { text: r.added ? `${r.reason}${status}` : r.reason };
    },
  },
  {
    name: "morning_brief",
    description:
      "Report what Jarvis researched while the user was away, with the short answer for each. Use this when they come back and ask what you found, what you looked into, or for their briefing.",
    schema: {},
    readOnly: true,
    handler: async () => ({ text: research.morningBrief() }),
  },
  {
    name: "read_research_brief",
    description:
      "Read one research brief in full, including its sources. Use this after morning_brief when the user asks about a specific thing you looked into.",
    schema: {
      question: z.string().describe("Which brief — any distinctive part of the question will do."),
    },
    readOnly: true,
    handler: async (a) => {
      const full = research.readBrief(a.question);
      return { text: full ?? `I don't have a brief matching "${a.question}". ${research.morningBrief()}` };
    },
  },
  {
    name: "list_research_queue",
    description:
      "List the questions waiting to be researched while the user is away, and whether overnight research is switched on.",
    schema: {},
    readOnly: true,
    handler: async () => ({
      text: `${research.describeQueue()}\n\n${researcher.researchStatus()}`,
    }),
  },
  {
    name: "set_overnight_research",
    description:
      "Turn overnight research on or off. When on, Jarvis works through the queued questions while the user is away, up to a nightly limit. Use this when they ask you to start or stop researching in the background.",
    schema: { enable: z.boolean().describe("True to switch it on.") },
    readOnly: false,
    handler: async (a) => {
      researcher.setResearchEnabled(a.enable === true);
      return {
        text: a.enable
          ? `Overnight research is on. ${research.describeQueue()}`
          : "Overnight research is off — I won't look anything up on my own.",
      };
    },
  },
  {
    name: "translate_screen",
    description:
      "Read the text on screen so it can be translated. Use this when the user asks to translate what they're looking at, or says they can't read something. Returns numbered passages — you translate them yourself, then call show_translation with the numbered translations to lay them over the screen.",
    schema: {
      language: z.string().optional().describe("Target language. Defaults to English."),
      display: z.string().optional().describe("Which screen, if the user has more than one."),
    },
    readOnly: true,
    handler: async (a) => {
      const language = a.language?.trim() || "English";
      const list = await vision.displays();
      const chosen = list.length > 1 ? resolveDisplay(list, a.display ?? "this", await pointerAt()) : null;

      const r = await vision.ocr("accurate", chosen?.index ?? 0);
      if (r.error) return { text: `I couldn't read the screen: ${r.error}` };

      const blocks = translate.translatableBlocks(r.lines);
      if (!blocks.length) {
        translate.clearPending();
        return { text: "I couldn't find any readable text on screen to translate." };
      }
      const resource = await scan.frontContext();
      const handle = translate.stashBlocks(blocks, language, translate.translationVersion(blocks, JSON.stringify(resource)));

      return {
        text:
          `Found ${blocks.length} passages on screen. Translate each into ${language}, then call show_translation ` +
          `with handleId "${handle.id}" and one numbered line per passage, using these exact numbers:\n\n` +
          blocks.map((b, i) => `${i + 1}. ${b.text}`).join("\n"),
        data: { handleId: handle.id, expiresAt: handle.expiresAt },
      };
    },
  },
  {
    name: "show_translation",
    description:
      "Lay translated text over the screen, on top of the original. Call this after translate_screen, passing your translations as numbered lines matching the numbers you were given.",
    schema: {
      handleId: z.string().optional().describe("Exact handle from translate_screen; prevents stale or cross-task results."),
      translations: z
        .string()
        .describe("One numbered line per passage, e.g. '1. Hello\\n2. Goodbye'. Use the same numbers you were given."),
    },
    readOnly: false,
    handler: async (a) => {
      const handle = translate.pendingTranslation(a.handleId);
      if (!handle) return { status: "failed", text: "The translation handle is missing, stale, or belongs to another task. Call translate_screen again." };
      const [resource, fresh] = await Promise.all([scan.frontContext(), vision.ocr("accurate")]);
      const version = translate.translationVersion(translate.translatableBlocks(fresh.lines ?? []), JSON.stringify(resource));
      if (fresh.error || version !== handle.resourceVersion) {
        translate.clearPending();
        return { status: "failed", text: "The screen changed since translation was captured. Call translate_screen again." };
      }
      const blocks = handle.value.blocks;
      const target = handle.value.language;
      const parsed = translate.parseTranslations(a.translations, blocks);
      const shown = translate.drawable(parsed);

      if (shown.length) {
        sendToOverlay("show-translation", {
          // The overlay window spans the whole desktop and starts at its
          // top-left, which is not the origin when a monitor sits to the left.
          blocks: shown.map((b) => {
            const p = toOverlaySpace({ x: b.x, y: b.y });
            return { ...b, x: p.x, y: p.y };
          }),
          note: `${target} · say "clear translation" to dismiss`,
        });
      }
      translate.clearPending();
      return { text: translate.describe(shown, target, blocks.length), status: "success", verification: "unverified" };
    },
  },
  {
    name: "clear_translation",
    description:
      "Remove the translated text laid over the screen. Use this when the user says they're done with the translation, or asks to clear or hide it.",
    schema: {},
    readOnly: false,
    handler: async () => {
      sendToOverlay("clear-translation");
      translate.clearPending();
      return { text: "Cleared the translation." };
    },
  },
  {
    name: "open_intel",
    description:
      "Query a live open-intelligence source and answer out loud. Sources: " +
      "`satellites` (CelesTrak + SGP4 — where a satellite is now and when it next passes overhead, e.g. \"ISS over Hyderabad\"), " +
      "`news` (GDELT — world coverage of any topic in 100+ languages), " +
      "`nearby` (OpenStreetMap — what is actually around a point: pharmacy, hospital, ATM, cafe, fuel, supermarket, park, station), " +
      "`network` (RIPEstat — who owns an IP or AS number and what they announce), " +
      "`exploited` (CISA KEV — vulnerabilities confirmed exploited in the wild, optionally filtered by vendor or product). " +
      "Use for questions about satellites or passes overhead, world news on a topic, what is near a place, who owns an address or network, and which vulnerabilities are actively exploited. " +
      "This is separate from show_osiris: that opens a map, this answers a question.",
    schema: {
      source: z
        .string()
        .describe("Which source: satellites, news, nearby, network, or exploited. Spoken aliases also work (passes, headlines, near me, who owns, kev)."),
      query: z
        .string()
        .optional()
        .describe(
          "The argument for that source. satellites: a name or NORAD id, optionally 'over <place>'. news: a topic. " +
          "nearby: what to find, optionally 'near <place>'. network: an IP, prefix or AS number. exploited: an optional vendor/product/CVE filter."
        ),
    },
    readOnly: true,
    handler: async (a) => {
      const { resolveIntelSource, intelSourceNames, recordIntel } = await import("../intel-feeds.js");
      const source = resolveIntelSource(String(a.source ?? ""));
      if (!source) {
        return { text: `I don't have an intel source called "${a.source}". I have: ${intelSourceNames()}.`, status: "failed" };
      }
      const query = a.query ? String(a.query) : "";
      try {
        const answer = await source.run(query || undefined, {});
        recordIntel({ label: source.label, query, answer: answer.speak, ok: true });
        return { text: answer.speak, data: answer.data as any };
      } catch (err: any) {
        // Named, not swallowed: these are five different services and knowing
        // WHICH one is unreachable is most of the diagnosis. The failure is
        // recorded too — a card that only ever shows successes hides exactly
        // the thing worth noticing.
        const why = String(err?.message ?? err);
        recordIntel({ label: source.label, query, answer: why, ok: false });
        return { text: `${source.label} is unavailable: ${why}`, status: "failed" };
      }
    },
  },
  {
    name: "web_search",
    description:
      "Search the web privately through the user's own SearXNG and get the results back as data — titles, links and snippets merged from several engines, no API key. " +
      "Use whenever you need facts from the web: current events, documentation, prices, how-tos, anything you would otherwise open a browser for. " +
      "Prefer this over opening a search page in the browser when you only need to READ results. Use category \"news\" with a timeRange for recent events.",
    schema: {
      query: z.string().min(1).describe("What to search for."),
      category: z.string().optional().describe("Optional: general (default), news, it, science, videos, images, map."),
      timeRange: z.string().optional().describe("Optional: day, week, month or year — only results from that recent window."),
      limit: z.number().int().min(1).max(15).optional().describe("How many results, default 6."),
    },
    readOnly: true,
    handler: async (a) => {
      const { webSearch, withAutostart } = await import("../selfhosted.js");
      try {
        const r = await withAutostart("searxng", appRoot(), () =>
          webSearch({ query: String(a.query), category: a.category, timeRange: a.timeRange, limit: a.limit }));
        return { text: r.text, data: { hits: r.hits } as any };
      } catch (err: any) {
        return { text: `Web search failed: ${err?.message ?? err}`, status: "failed" };
      }
    },
  },
  {
    name: "show_osiris",
    description:
      "Open (or close) the Osiris panel — the live global intelligence grid: a 3D world map layered with real-time flights, earthquakes, fires, satellites, CCTV cameras, undersea cables, conflict zones and 24/7 news. Use when the user asks to see the world map, the globe, global intelligence, OSINT, what's happening in the world, or Osiris by name. THE PANEL STAYS ON SCREEN until they ask to close it — never close it as tidying up, only when they say so. Pass layers to open it already showing something specific.",
    schema: {
      show: z.boolean().optional().describe("true to open (default), false to close."),
      layers: z
        .array(z.string())
        .optional()
        .describe("Layers to show on arrival — e.g. flights, earthquakes, fires, satellites, cameras, news, war, cables."),
      pin: z
        .boolean()
        .optional()
        .describe("Keep the grid above other windows and on every desktop."),
    },
    readOnly: false,
    handler: async (a) => {
      const osiris = await import("../../osiris.js");
      if (a.show === false) {
        if (!osiris.isOsirisOpen()) return { text: "The Osiris grid isn't open." };
        osiris.closeOsirisPanel();
        return { text: "Closed the Osiris grid." };
      }

      const { resolveLayers, isHosted, speakList } = await import("../osiris-intel.js");
      const { ids, unknown } = resolveLayers(a.layers ?? []);
      const wasOpen = osiris.isOsirisOpen();
      const { base } = await osiris.openOsirisPanel({ layers: ids, pin: a.pin });

      const where = isHosted(base) ? "the live grid" : `the instance at ${base}`;
      // With no layers named the panel opens on the standard view, which is two
      // dozen layers — a count, not a recital.
      const showing = ids.length ? `showing ${speakList(ids)}` : "with the standard view";
      const opened = wasOpen
        ? `The Osiris grid is already up${ids.length ? `, switching to ${speakList(ids)}` : ""}.`
        : `Opening the Osiris grid on ${where}, ${showing}. It'll appear once the globe has loaded, and it stays up until you tell me to close it.`;
      const missed = unknown.length ? ` I don't have a layer called ${speakList(unknown)}.` : "";
      return { text: opened + missed };
    },
  },
  {
    name: "osiris_layers",
    description:
      "Turn layers on or off on the Osiris grid, or report which are showing. Layers include flights, private jets, military flights, ships, satellites, cameras, live news, earthquakes, fires, weather, radiation, infrastructure, conflict zones, undersea cables, day/night, terrain, malware and cyber attacks. Use when the user asks to add, remove, or check something on the world map. Opens the grid first if it isn't up.",
    schema: {
      on: z.array(z.string()).optional().describe("Layers to switch on, keeping what's already showing."),
      off: z.array(z.string()).optional().describe("Layers to switch off."),
      only: z.array(z.string()).optional().describe("Show exactly these and nothing else."),
    },
    readOnly: false,
    handler: async (a) => {
      const osiris = await import("../../osiris.js");
      const { resolveLayers, speakList, openingLayers } = await import("../osiris-intel.js");

      const wanted = resolveLayers(a.only ?? []);
      const add = resolveLayers(a.on ?? []);
      const drop = resolveLayers(a.off ?? []);
      const unknown = [...wanted.unknown, ...add.unknown, ...drop.unknown];

      // "Only show X" where X isn't a layer must not be read as "show nothing" —
      // clearing the globe is the opposite of what was asked for.
      if (a.only && !wanted.ids.length) {
        return { text: `I don't have a layer called ${speakList(unknown.length ? unknown : a.only)}, so I've left the grid as it is.` };
      }

      if (!osiris.isOsirisOpen()) {
        const start = a.only ? wanted.ids : [...new Set([...openingLayers(), ...add.ids])].filter((id) => !drop.ids.includes(id));
        if (!start.length && !add.ids.length && !wanted.ids.length) {
          return { text: "The Osiris grid isn't open — say the word and I'll put it on screen." };
        }
        await osiris.openOsirisPanel({ layers: start });
        return { text: `Opening the Osiris grid showing ${speakList(start)}.` };
      }

      // If the page's URL can't be read, assume what Echo opened it with.
      const current = (await osiris.currentLayers()) ?? openingLayers();
      if (!a.on && !a.off && !a.only) {
        return {
          text: current.length
            ? `The grid is showing ${speakList(current)}.`
            : "The grid is showing a bare globe — no layers on.",
        };
      }

      const next = a.only
        ? wanted.ids
        : [...new Set([...current, ...add.ids])].filter((id) => !drop.ids.includes(id));
      const result = await osiris.applyLayers(next);

      const missed = unknown.length ? ` I don't have a layer called ${speakList(unknown)}.` : "";
      if (result === "failed" || result === "closed") {
        return {
          text: `The grid wouldn't take that change just now — it's still showing ${speakList(current)}.` + missed,
        };
      }
      const lead = result === "pending" ? "Switching to" : "Now showing";
      return {
        text: (next.length ? `${lead} ${speakList(next)}.` : "Clearing the grid down to a bare globe.") + missed,
      };
    },
  },
  {
    name: "osiris_intel",
    description:
      "Read a live Osiris intelligence feed and answer out loud — earthquakes, air traffic, fires, the OSINT news feed, satellites, conflict zones, space weather, severe weather, cyber threats, or an overall grid status. Use whenever the user asks what's happening in the world, whether anything has happened (a quake, a fire, a conflict), or for a world briefing. Pass `place` when they asked about somewhere specific ('earthquakes near Tokyo', 'what's happening in Ukraine') so the report is narrowed to there instead of the whole planet — status, satellites, space weather and cyber threats aren't broken down by place and say so rather than silently ignoring it. This reads data and does not need the panel open.",
    schema: {
      feed: z
        .string()
        .describe("Which feed: status, earthquakes, flights, fires, news, satellites, conflicts, space_weather, weather, or cyber."),
      place: z
        .string()
        .optional()
        .describe("Narrow the report to near this place — a city, country, region or landmark, as the user said it."),
      radiusKm: z
        .number()
        .optional()
        .describe("How far from the place still counts as near it. Defaults to 350km; widen it for a whole country or region, narrow it for a single city."),
    },
    readOnly: true,
    handler: async (a) => {
      const { resolveFeed, osirisFetch, summarize, activeBase, FEEDS, geocodePlace, DEFAULT_RADIUS_KM } = await import("../osiris-intel.js");
      const feed = resolveFeed(a.feed ?? "status");
      if (!feed) {
        return { text: `I don't have a feed called "${a.feed}". I can read ${FEEDS.map((f) => f.id).join(", ")}.` };
      }

      // When the panel is up, its page is the fallback route to the API: a
      // deployment that answers a plain server-side request with a bot check
      // answers the browser that already cleared it.
      const osiris = await import("../../osiris.js");
      const base = osiris.osirisBase() ?? (await activeBase());
      const relay = osiris.isOsirisOpen() ? osiris.relayFetch : undefined;

      const place = String(a.place ?? "").trim();
      let filter: LocationFilter | undefined;
      let placeMissed = "";
      if (place) {
        const coords = await geocodePlace(place, { base, relay });
        if (coords) filter = { ...coords, radiusKm: a.radiusKm ?? DEFAULT_RADIUS_KM, label: place };
        else placeMissed = ` I couldn't place "${place}", so here's the global picture instead.`;
      }

      let data: any;
      try {
        data = await osirisFetch(feed.path, { base, relay });
      } catch (e: any) {
        return { text: `I couldn't read the ${feed.label} feed — ${e?.message ?? e}.` };
      }

      const summary = summarize(feed.id, data, filter);
      sendToOverlay("show-data-pane", {
        title: `OSIRIS · ${feed.label.toUpperCase()}${filter ? ` · ${place.toUpperCase()}` : ""}`,
        content: summary.html,
        duration: 30000,
      });
      if (placeMissed) return { text: summary.speech + placeMissed };
      return { text: summary.speech };
    },
  },
  {
    name: "osiris_focus",
    description:
      "Point the Osiris globe at a place — a city, country, region or landmark. Use when the user asks to look at somewhere specific on the world map ('show me Ukraine', 'zoom into Tokyo'). Opens the grid first if it isn't up.",
    schema: {
      place: z.string().describe("Where to look — a place name, as spoken."),
      lat: z.number().optional().describe("Exact latitude, if known."),
      lng: z.number().optional().describe("Exact longitude, if known."),
      zoom: z.number().optional().describe("Zoom level, 2 (whole globe) to 12 (a city block). Defaults to 6."),
    },
    readOnly: false,
    handler: async (a) => {
      const osiris = await import("../../osiris.js");
      const { osirisFetch, activeBase } = await import("../osiris-intel.js");
      const place = String(a.place ?? "").trim();

      if (!osiris.isOsirisOpen()) {
        await osiris.openOsirisPanel({});
        // The globe needs to exist before the camera can be told to move.
        await new Promise((r) => setTimeout(r, 6000));
      }

      let coords =
        Number.isFinite(a.lat) && Number.isFinite(a.lng)
          ? { lat: a.lat as number, lng: a.lng as number, zoom: a.zoom }
          : undefined;

      // Osiris geocodes with its own search service, so a place Echo resolves
      // this way is the same place its search box would have found.
      if (!coords && place) {
        try {
          const base = osiris.osirisBase() ?? (await activeBase());
          const found = await osirisFetch(`/api/geosearch?q=${encodeURIComponent(place)}`, {
            base,
            timeoutMs: 12000,
            relay: osiris.isOsirisOpen() ? osiris.relayFetch : undefined,
          });
          const hit = found?.results?.[0];
          if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) {
            coords = { lat: hit.lat, lng: hit.lng, zoom: a.zoom };
          }
        } catch {
          /* the search-box route below doesn't need coordinates */
        }
      }

      const route = await osiris.focusOsiris(place, coords);
      if (route === "map") return { text: `Bringing ${place || "that position"} up on the grid.` };
      if (route === "search") return { text: `Searching the grid for ${place} and flying there.` };
      return { text: `The grid is open, but I couldn't move the camera to ${place || "there"} from here.` };
    },
  },
  {
    name: "check_calendar",
    description:
      "Look at the user's upcoming calendar events. Use to answer what's next, or to proactively flag a meeting that is about to start.",
    schema: {
      hoursAhead: z.number().int().min(1).max(72).default(12).describe("How far ahead to look"),
    },
    readOnly: true,
    handler: async (a) => ({ text: system.describeEvents(await system.upcomingEvents(a.hoursAhead ?? 12)) }),
  },
  {
    name: 'echoMaps',
    description: 'CRITICAL: ALWAYS use this tool by default when the user asks for a map, to show a location, or to navigate somewhere. DO NOT use the browser/open_url to show maps unless the user EXPLICITLY asks to open the map "in the browser". This renders a holographic map directly on their screen.',
    schema: {
      location: z.string().describe('The destination or place to display on the map'),
      startLocation: z.string().optional().describe('If the user asks for directions, provide the starting location. If they say "from my location", pass "Current Location" or their city.'),
      mode: z.enum(['d', 'w', 'b', 'r']).optional().describe('Routing mode: d=driving (car), w=walking, b=bicycling, r=transit. Default is d.')
    },
    readOnly: false,
    handler: async (a) => {
      nodeRequire("node:fs").appendFileSync("/Users/thedeepakreddy/.jarvis/tool_log.txt", `echoMaps called with location: ${a.location}, start: ${a.startLocation}\n`);
      try {
        let mapUrl;
        let qrUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a.location)}&travelmode=driving`;
        
        if (a.startLocation) {
          const saddr = encodeURIComponent(a.startLocation);
          const daddr = encodeURIComponent(a.location);
          const dirflg = a.mode || 'd';
          mapUrl = `https://maps.google.com/maps?saddr=${saddr}&daddr=${daddr}&dirflg=${dirflg}&ie=UTF8&output=embed`;
          if (a.startLocation !== "Current Location") {
            qrUrl += `&origin=${saddr}`;
          }
        } else {
          const query = encodeURIComponent(a.location);
          mapUrl = `https://maps.google.com/maps?q=${query}&t=&z=14&ie=UTF8&iwloc=&output=embed`;
        }
        
        const qrData = await qrDataUrl(qrUrl);
        const html = `<style>#data-pane-content { padding: 0 !important; overflow: hidden !important; }</style><div style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column;"><iframe width="100%" height="100%" frameborder="0" scrolling="no" marginheight="0" marginwidth="0" allow="geolocation" src="${mapUrl}" style="flex: 1; border: none; border-radius: 0 0 24px 24px;"></iframe><div style="position: absolute; bottom: 15px; right: 15px; width: 80px; background: rgba(0,0,0,0.75); padding: 5px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); backdrop-filter: blur(10px);"><img src="${qrData}" style="width: 100%; display: block; filter: brightness(1.2);" /><div style="font-size: 8px; color: #fff; font-family: -apple-system, sans-serif; text-align: center; margin-top: 4px; line-height: 1.1; font-weight: bold;">SCAN TO GO</div></div></div>`;
        
        const title = a.startLocation ? `ROUTE: ${a.location.toUpperCase()}` : `MAP: ${a.location.toUpperCase()}`;
        
        sendToOverlay("show-data-pane", {
          title: title,
          content: html,
          duration: 45000
        });
        
        return { text: `Echo Maps: Displaying map for ${a.location} on the HUD for 30 seconds.` };
      } catch (err: any) {
        return { text: `Failed to display map: ${err.message}` };
      }
    }
  },
  {
    name: 'echoVideoPlayer',
    description: 'Plays a YouTube video directly on the holographic HUD (using Privacy-Enhanced mode for an ad-free experience).',
    schema: {
      url: z.string().describe('The YouTube video URL to play')
    },
    readOnly: false,
    handler: async (a) => {
      try {
        const match = a.url.match(/(?:v=|youtu\.be\/|embed\/)([^&?]+)/);
        if (!match || !match[1]) {
          return { text: "Could not parse a valid YouTube video ID from the provided URL." };
        }
        const videoId = match[1];
        const embedUrl = `https://yewtu.be/embed/${videoId}?autoplay=1`;
        
        const html = `<style>#data-pane-content { padding: 0 !important; overflow: hidden !important; }</style><div style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column;"><iframe width="100%" height="100%" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen src="${embedUrl}" style="flex: 1; border: none; border-radius: 0 0 24px 24px;"></iframe></div>`;
        
        const { sendToOverlay } = await import("../../overlay.js");
        sendToOverlay("show-data-pane", {
          title: "SECURE MEDIA LINK",
          content: html,
          duration: 0 // 0 means it will not auto-close
        });
        
        return { text: `Playing video ${videoId} on the HUD. It will remain open until closed.` };
      } catch (err: any) {
        return { text: `Error showing video: ${err.message}` };
      }
    }
  },
];
