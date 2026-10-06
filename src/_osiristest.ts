/**
 * The Osiris grid — what Echo shows, and what it can say about it.
 *
 *   npm run osiristest
 *
 * Offline by design. Every network call in this feature is either a fetch to an
 * Osiris instance or a call into Electron, and both are absent here, so what is
 * checked is the part that is easy to get quietly wrong: the vocabulary between
 * a spoken phrase and a layer id, the `?layers=` contract this integration
 * leans on, and the summarisers — which must survive a feed answering with an
 * empty list, an error field, or nothing at all, since that is what a live
 * OSINT API does on a bad day.
 */
import {
  DEFAULT_LAYERS,
  DEFAULT_RADIUS_KM,
  FEEDS,
  HOSTED_BASE,
  LAYER_IDS,
  LOCAL_PORTS,
  STANDARD_VIEW,
  ago,
  openingLayers,
  configuredBase,
  geocodePlace,
  isHosted,
  layersFromUrl,
  layersUrl,
  normalizeBase,
  probeLocal,
  resolveFeed,
  resolveLayers,
  speakList,
  summarize,
  type LocationFilter,
} from "./tools/osiris-intel.js";
import { TOOLS } from "./tools/registry.js";
import { classify } from "./safety/risk.js";
import { toolsForLocalModel } from "./brain/localtools.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

console.log("\nOsiris grid\n");

console.log("  Echo has the tools to show and read the grid");
{
  const names = ["show_osiris", "osiris_layers", "osiris_intel", "osiris_focus"];
  for (const name of names) ok(!!TOOLS.find((t) => t.name === name), `${name} exists`);

  const show = TOOLS.find((t) => t.name === "show_osiris");
  ok(/stays on screen/i.test(show?.description ?? ""),
     "show_osiris tells the model the panel stays up until it is told to close");
  ok(!!show?.schema?.show && !!show?.schema?.layers,
     "show_osiris takes both an open/close flag and layers");

  const intel = TOOLS.find((t) => t.name === "osiris_intel");
  ok(intel?.readOnly === true, "reading a feed is marked read-only");
}

console.log("  every brain can reach them");
{
  for (const name of ["show_osiris", "osiris_layers", "osiris_focus"]) {
    ok(classify(name, {}, { workingDir: "/tmp" }).tier !== "high",
       `${name} is not treated as a dangerous action`);
  }
  ok(classify("osiris_intel", {}, { workingDir: "/tmp" }).tier === "low",
     "reading a feed needs no confirmation at all");

  const local = toolsForLocalModel(TOOLS.map((t) => ({ name: t.name, function: { name: t.name } })));
  const offered = new Set(local.map((t: any) => t.function?.name ?? t.name));
  ok(offered.has("show_osiris") && offered.has("osiris_intel"),
     "the local model is offered the grid too, so it works on the Ollama brain");
}

console.log("  spoken names resolve to real layers");
{
  ok(resolveLayers(["planes"]).ids.join() === "flights", "\"planes\" is the flights layer");
  ok(resolveLayers(["quakes"]).ids.join() === "earthquakes", "\"quakes\" is the earthquakes layer");
  ok(resolveLayers(["camera"]).ids.includes("cctv"), "a singular \"camera\" still finds the CCTV layer");
  ok(resolveLayers(["gps satellites"]).ids.join() === "sat_navigation", "\"GPS satellites\" is sat_navigation");
  ok(resolveLayers(["private jets"]).ids.length === 2, "\"private jets\" expands to the two layers it means");
  ok(resolveLayers(["sat_comms"]).ids.join() === "sat_comms", "a raw layer id passes straight through");
  ok(resolveLayers(["day-night"]).ids.join() === "day_night", "punctuation doesn't matter");
  ok(resolveLayers(["flights", "planes"]).ids.length === 1, "the same layer asked for twice is listed once");

  const junk = resolveLayers(["unicorns"]);
  ok(junk.ids.length === 0 && junk.unknown.join() === "unicorns",
     "a layer that doesn't exist is reported rather than silently dropped");

  ok(resolveLayers(LAYER_IDS).ids.length === LAYER_IDS.length, "every catalogued id resolves to itself");
  ok(DEFAULT_LAYERS.every((id) => LAYER_IDS.includes(id)), "the defaults are all real layers");
  ok(STANDARD_VIEW.every((id) => LAYER_IDS.includes(id)), "the standard view is all real layers");
  ok(STANDARD_VIEW.length === new Set(STANDARD_VIEW).size, "and lists none of them twice");

  // The layers the grid comes up with when nothing was named.
  const opening = openingLayers();
  ok(opening.length > 0 && opening.every((id) => LAYER_IDS.includes(id)),
     "the opening view is a non-empty set of real layers");
  ok(opening.includes("flights") && opening.includes("earthquakes"),
     "and has the things worth seeing at a glance on it");
}

console.log("  the ?layers= contract is what Osiris actually reads");
{
  const url = layersUrl(HOSTED_BASE, ["flights", "earthquakes"]);
  ok(url === `${HOSTED_BASE}/?layers=flights%2Cearthquakes`, "layers go on the URL as one comma-separated value");
  ok(layersFromUrl(url).join() === "flights,earthquakes", "and read back out of it");

  // Osiris restores its defaults when the parameter is missing OR empty, so a
  // bare globe needs a value that matches no layer rather than no value.
  ok(layersUrl(HOSTED_BASE, []).endsWith("layers=none"), "an empty list becomes the 'none' sentinel");
  ok(layersFromUrl(`${HOSTED_BASE}/?layers=none`).length === 0, "which reads back as nothing on");

  ok(layersFromUrl(`${HOSTED_BASE}/?layers=flights,made_up`).join() === "flights",
     "an id the client doesn't know is dropped on the way back in");
  ok(layersFromUrl(`${HOSTED_BASE}/`).length === 0, "a URL with no parameter reports nothing on");
  ok(layersFromUrl("not a url").length === 0, "a malformed URL is survivable");

  ok(normalizeBase("http://localhost:3000/") === "http://localhost:3000", "a trailing slash never doubles up");
  ok(isHosted(`${HOSTED_BASE}/`) && !isHosted("http://localhost:3000"),
     "a checkout is told apart from the hosted grid");
}

console.log("  feeds resolve the way they are asked for");
{
  ok(resolveFeed("earthquakes")?.id === "earthquakes", "by name");
  ok(resolveFeed("quakes")?.id === "earthquakes", "by nickname");
  ok(resolveFeed("air traffic")?.id === "flights", "by what the layer is actually called");
  ok(resolveFeed("what's the solar weather")?.id === "space_weather", "inside a phrase");
  ok(resolveFeed("")?.id === undefined, "an empty ask resolves to nothing");
  ok(FEEDS.every((f) => f.path.startsWith("/api/")), "every feed points at a real API route");
}

console.log("  a feed becomes something Echo can say");
{
  const quakes = summarize("earthquakes", {
    earthquakes: [
      { magnitude: 6.2, place: "off the coast of Honshu", time: Date.now() - 90 * 60 * 1000 },
      { magnitude: 2.6, place: "Pāhala, Hawaii", time: Date.now() - 10 * 60 * 1000 },
    ],
  });
  ok(/6\.2/.test(quakes.speech) && /Honshu/.test(quakes.speech), "the largest quake leads the answer");
  ok(!/undefined|NaN|\[object/.test(quakes.speech), "and reads as a sentence, not a dump");

  const flights = summarize("flights", {
    commercial_flights: [1, 2, 3], private_flights: [1], private_jets: [1, 2],
    military_flights: [1], gps_jamming: [1], total: 7, source: "opensky",
  });
  ok(/7 aircraft/.test(flights.speech) && /jamming/.test(flights.speech), "air traffic counts every category");

  const space = summarize("space_weather", { kp_index: 1, storm_level: "Quiet", solar_flares: [{ class: "B5.8" }], alerts: [] });
  ok(/quiet/i.test(space.speech) && /B5\.8/.test(space.speech), "space weather names the storm level and the flare");

  const conflicts = summarize("conflicts", {
    zones: [{ label: "UKRAINE WAR", severity: "war", eventCount: 12 }],
    liveEvents: [1, 2], totalLiveEvents: 2, activeWarzones: 1,
  });
  ok(/UKRAINE WAR/.test(conflicts.speech), "conflict zones are named, not just counted");

  // The failure shapes a live OSINT API really produces.
  for (const feed of FEEDS) {
    const empty = summarize(feed.id, {});
    const errored = summarize(feed.id, { error: "USGS unavailable", earthquakes: [], news: [], fires: [] });
    ok(!!empty.speech && !!empty.html, `${feed.id} answers something when the payload is empty`);
    ok(!!errored.speech, `${feed.id} answers something when the feed reports an error`);
  }
  ok(!!summarize("something_new", { widgets: [1, 2, 3] }).speech,
     "a feed added to Osiris later still gets a truthful count");

  ok(summarize("earthquakes", { earthquakes: [{ magnitude: 5, place: "<script>x</script>", time: Date.now() }] }).html
      .includes("&lt;script&gt;"),
     "feed text is escaped before it reaches the HUD pane");
}

console.log("  a report can be narrowed to a place");
{
  // A filter centered on the equator/prime-meridian with a deliberately
  // unambiguous "near" point (~55km away) and "far" point (~1500km away),
  // rather than real city coordinates, so the radius math is exact and the
  // test doesn't depend on guessing a real distance right.
  const near: LocationFilter = { lat: 0, lng: 0, radiusKm: DEFAULT_RADIUS_KM, label: "the origin" };
  ok(DEFAULT_RADIUS_KM > 0 && DEFAULT_RADIUS_KM < 1000, "the default radius is a real, sane number");

  const quakes = summarize(
    "earthquakes",
    { earthquakes: [
      { magnitude: 6.2, place: "near the origin", lat: 0, lng: 0.5, time: Date.now() },
      { magnitude: 8.0, place: "far away", lat: 10, lng: 10, time: Date.now() },
    ] },
    near
  );
  ok(/1 earthquake/.test(quakes.speech) && /near the origin/i.test(quakes.speech),
     "only the nearby quake is counted, even though the far one is bigger");
  ok(!/8\.0/.test(quakes.speech), "the far quake never leads the answer once a place is given");

  const noneNear = summarize(
    "earthquakes",
    { earthquakes: [{ magnitude: 8.0, place: "far away", lat: 10, lng: 10, time: Date.now() }] },
    near
  );
  ok(/No earthquakes/.test(noneNear.speech) && /1 elsewhere/.test(noneNear.speech),
     "zero nearby is reported distinctly from zero on the whole feed");

  const flights = summarize(
    "flights",
    { commercial_flights: [{ lat: 0, lng: 0.2 }, { lat: 50, lng: 50 }], military_flights: [{ lat: 0, lng: -0.1 }] },
    near
  );
  ok(/2 aircraft near the origin/.test(flights.speech), "only in-radius aircraft are counted across every category");

  const news = summarize(
    "news",
    { news: [
      { title: "Unrest reported near the origin today", risk_score: 5 },
      { title: "Completely unrelated story elsewhere", risk_score: 9 },
    ] },
    near
  );
  ok(/1 story mentioning the origin/.test(news.speech), "news is matched by mention, since it carries no coordinates");

  const conflicts = summarize(
    "conflicts",
    { zones: [
      { label: "NEAR WAR", severity: "war", lat: 0, lng: 0.1, eventCount: 3 },
      { label: "FAR WAR", severity: "war", lat: -40, lng: -40, eventCount: 9 },
    ] },
    near
  );
  ok(/1 conflict zone near the origin/.test(conflicts.speech) && /NEAR WAR/.test(conflicts.speech) && !/FAR WAR/.test(conflicts.speech),
     "conflict zones outside the radius are dropped, not just deprioritised");

  // Feeds with no location concept at all say so, rather than silently
  // ignoring the place and reporting the global picture as if it were local.
  for (const feedId of ["status", "satellites", "space_weather", "cyber"]) {
    const withPlace = summarize(feedId, { satellites: [1], stats: {}, threats: [{ id: "CVE-1" }] }, near);
    ok(/isn't|aren't|not broken down/i.test(withPlace.speech),
       `${feedId} says it can't be narrowed to a place, instead of pretending it did`);
  }

  ok(typeof geocodePlace === "function", "geocodePlace is exported for the tool to resolve a place into coordinates");
}

console.log("  small things said out loud");
{
  ok(speakList(["flights"]) === "flights", "one item is just the item");
  ok(speakList(["flights", "fires"]) === "flights and fires", "two items get an 'and'");
  ok(speakList(["a", "b", "c"]) === "a, b and c", "three items get commas and an 'and'");
  ok(speakList(["day_night"]) === "day night", "an id is spoken, not spelled");
  ok(ago(Date.now() - 30_000) === "just now", "half a minute ago is 'just now'");
  ok(ago(Date.now() - 2 * 60 * 60 * 1000) === "2 hours ago", "hours are hours");
}

console.log("  choosing which instance to talk to");
{
  const before = process.env.OSIRIS_URL;
  process.env.OSIRIS_URL = "http://localhost:4000/";
  ok(configuredBase() === "http://localhost:4000", "OSIRIS_URL wins, normalised");
  delete process.env.OSIRIS_URL;
  const fromConfig = configuredBase();
  ok(fromConfig === null || /^https?:\/\//.test(fromConfig),
     "with no environment override it is either unset or a real URL from config");
  if (before !== undefined) process.env.OSIRIS_URL = before;
}

console.log("  the panel module survives outside Electron");
{
  const osiris = await import("./osiris.js");
  ok(osiris.isOsirisOpen() === false, "no window is reported when there is no Electron");
  ok(osiris.osirisBase() === null, "and no instance is claimed");
  ok(osiris.setOsirisPinned(true) === false, "pinning a window that isn't there fails quietly");
  ok((await osiris.currentLayers()) === null, "layers are unknown rather than invented");
  ok((await osiris.applyLayers(["fires"])) === "closed",
     "a layer change with no panel says so instead of claiming it worked");
  ok((await osiris.focusOsiris("Tokyo")) === "none", "and the camera reports it couldn't move");
  osiris.closeOsirisPanel(); // must not throw
  ok(true, "closing nothing is a no-op");
}

console.log("  probing for a local checkout");
{
  // Port 1 is never a dev server; this checks the probe fails fast and false
  // rather than throwing, which is what keeps the hosted fallback working.
  const found = await probeLocal("http://127.0.0.1:1", 250);
  ok(found === false, "an unreachable local instance is simply absent");
  // 3000 is the most contested port on a developer's machine — this feature was
  // first tested against someone else's app sitting on it — so more than one is
  // checked, and only a page that identifies as Osiris counts.
  ok(LOCAL_PORTS.length > 1 && LOCAL_PORTS[0] === 3000,
     "more than one local port is considered, starting at the documented one");
}

// ── cameras ───────────────────────────────────────────────────────────────
//
// Reported: "I asked Echo to show a live camera feed from the US — it showed
// a black screen, then said there are no cameras."
//
// It was telling the truth about what it could see. `cameras` existed as a
// map LAYER, which puts markers on the globe, and as nothing else: there was
// no `cameras` FEED, so nothing could READ them. Meanwhile /api/cctv serves
// ~37,000 live streams and /api/stats has been counting them the whole time.
console.log("\n  cameras are readable, not just drawable");
{
  ok(!!resolveFeed("cameras"), "there is a cameras feed at all — this is the whole bug");
  for (const spoken of ["cctv", "webcam", "webcams", "live camera", "traffic cameras"])
    ok(resolveFeed(spoken)?.id === "cameras", `"${spoken}" resolves to it`);
  ok(resolveFeed("cameras")?.path === "/api/cctv", "pointed at the route that actually serves them");
}

console.log("\n  a country is somewhere you are IN, not within 350km of");
{
  // The trap that would have made the feed useless even once it existed: the
  // default radius on a geocoded centroid of a 4,500km-wide country returns
  // almost nothing, which reads to the user as "there are no cameras" all
  // over again. These records carry `country`, so a named country uses it.
  const cams = [
    { id: "a", lat: 39.4, lng: -123.8, city: "Fort Bragg", country: "US", stream_url: "http://x/1" },
    { id: "b", lat: 40.7, lng: -74.0, city: "New York", country: "US", stream_url: "http://x/2" },
    { id: "c", lat: 32.0, lng: 34.7, city: "Tel Aviv", country: "Israel", stream_url: "http://x/3" },
  ];
  // Geocoding "United States" lands near Kansas; both US cameras are far
  // outside any sane radius of it, and both must still be found.
  const usFilter = { lat: 39.8, lng: -98.5, radiusKm: 350, label: "United States" };
  const out = summarize("cameras", { cameras: cams }, usFilter as any);
  ok(/^2 cameras in United States/.test(out.speech),
     `both US cameras found, and phrased as "in" (${out.speech.slice(0, 60)})`);
  ok(!/near United States/.test(out.speech), "not \"near\" a whole country");

  // The spoken form and the stored form differ, and both sides normalise.
  for (const said of ["the US", "USA", "united states of america", "America"]) {
    const o = summarize("cameras", { cameras: cams }, { lat: 0, lng: 0, radiusKm: 1, label: said } as any);
    ok(/^2 cameras in /.test(o.speech), `"${said}" folds onto the records' "US"`, o.speech.slice(0, 50));
  }
  // And a place that is NOT a country still uses the radius.
  const near = summarize("cameras", { cameras: cams }, { lat: 32.0, lng: 34.7, radiusKm: 50, label: "Tel Aviv" } as any);
  ok(/^1 camera near Tel Aviv/.test(near.speech), `a city still uses the radius (${near.speech.slice(0, 40)})`);
}

console.log("\n  the answer carries an address, not just a name");
{
  // From runs/voice/2026-09-30T20-15-14: "show me any live camera from the
  // US" took 70 SECONDS and ended with "clicking the camera link doesn't
  // actually..." — Echo had the camera's NAME and no url, so it went hunting
  // on the 3D globe. That route cannot work: the hosted grid publishes no map
  // handle, so focusOsiris falls back to typing into the site's search box,
  // which in an earlier session left the globe stuck on Hungary.
  const cams = [{ id: "a", lat: 1, lng: 1, name: "Shibuya Crossing", city: "Tokyo",
                  country: "Japan", stream_url: "https://example.com/live" }];
  const out = summarize("cameras", { cameras: cams });
  ok(out.open === "https://example.com/live",
     "the summary carries the stream url the model must open",
     "a name alone sends it to the map, which is a minute it will not get back");

  // Feeds that are not about a watchable thing must not invent one.
  ok(summarize("earthquakes", { earthquakes: [{ lat: 1, lng: 1, mag: 5, place: "x" }] }).open === undefined,
     "and other feeds leave it unset");
  ok(summarize("cameras", { cameras: [{ id: "b", lat: 1, lng: 1, name: "X" }] }).open === undefined,
     "as does a camera with no stream");
}

console.log("\n  it offers a camera a browser can actually show");
{
  // Live session: Echo opened the first US camera and got **503**, then said
  // "that's the stream host itself refusing". The feed's own order puts
  // Indiana DOT HLS prerolls first for the US — and a bare .m3u8 handed to a
  // browser downloads a playlist rather than showing a picture, so even a
  // healthy one was never going to work through open_url.
  const cams = [
    { id: "hls", lat: 1, lng: 1, name: "I-69 preroll", country: "US", stream_type: "hls",
      stream_url: "https://skysfs4.trafficwise.org/preroll/INDOT_409.m3u8" },
    { id: "jpg", lat: 1, lng: 1, name: "SR-20 Fort Bragg", country: "US", feed_url: "https://dot.ca.gov/x.jpg" },
    { id: "yt", lat: 1, lng: 1, name: "Times Square", country: "US", stream_type: "iframe",
      stream_url: "https://www.youtube.com/embed/abc" },
  ];
  const out = summarize("cameras", { cameras: cams });
  ok(out.open === "https://www.youtube.com/embed/abc",
     `the embed wins over the playlist (${out.open})`,
     "an m3u8 downloads a file instead of playing, which is what 503'd in the real session");
  ok(/Times Square/.test(out.speech), "and it is the one named out loud");

  // 12,777 of 18,868 US cameras carry ONLY `feed_url`. Reading `stream_url`
  // alone saw a tenth of them.
  const onlyFeed = summarize("cameras", { cameras: [cams[1]] });
  ok(onlyFeed.open === "https://dot.ca.gov/x.jpg", "a camera with only feed_url is still offered", String(onlyFeed.open));

  // A viewer page beats the raw playlist on the SAME record.
  const both = summarize("cameras", { cameras: [{ id: "b", lat: 1, lng: 1, name: "TxDOT", country: "US",
    stream_type: "hls", stream_url: "https://x/y.m3u8", external_url: "https://its.txdot.gov/cameras" }] });
  ok(both.open === "https://its.txdot.gov/cameras", "the operator's viewer page beats the playlist", String(both.open));
}

console.log("\n  a country still narrows when the geocoder is down");
{
  // Observed: /api/geosearch stopped answering, "the US" produced no filter,
  // and the answer offered a camera in Tel Aviv. Country matching needs the
  // WORD, not coordinates — the field is in every record.
  const cams = [
    { id: "a", lat: 39, lng: -98, name: "Abilene", country: "US", feed_url: "https://x/1.jpg" },
    { id: "b", lat: 32, lng: 34, name: "Tel Aviv", country: "Israel", stream_type: "iframe", stream_url: "https://y/2" },
  ];
  const noCoords = { lat: NaN, lng: NaN, radiusKm: 0, label: "the US" };
  const out = summarize("cameras", { cameras: cams }, noCoords as any);
  ok(/^1 camera in the US/.test(out.speech), `still narrowed to the US (${out.speech.slice(0, 40)})`);
  ok(/Abilene/.test(out.speech), "and offers the American one, not the Israeli one");

  // A CITY with no coordinates cannot be narrowed, and must not pretend.
  const city = summarize("cameras", { cameras: cams }, { lat: NaN, lng: NaN, radiusKm: 0, label: "New York" } as any);
  ok(/^2 cameras\./.test(city.speech), `an unplaceable city falls back to global without claiming it (${city.speech.slice(0, 32)})`);
  ok(!/near New York|in New York/.test(city.speech), "and does not say a place it never filtered by");
}

console.log("\n  the answer is watchable, not just a count");
{
  // "There are 23,204 cameras" with no way to see one is the same dead end
  // in a politer voice.
  const cams = [{ id: "a", lat: 1, lng: 1, name: "Shibuya Crossing", city: "Tokyo", country: "Japan", stream_url: "https://example.com/live" }];
  const out = summarize("cameras", { cameras: cams });
  ok(/Shibuya Crossing/.test(out.speech), "it names one");
  ok(out.html.includes("https://example.com/live"), "and the link is in the panel");

  // A feed that returns cameras with no streams must say so rather than
  // promising something it cannot open.
  const dead = summarize("cameras", { cameras: [{ id: "b", lat: 1, lng: 1, name: "X" }] });
  ok(/none of them are streaming/.test(dead.speech), "no stream urls is said out loud", dead.speech);
  ok(/No cameras on the feed/.test(summarize("cameras", { cameras: [] }).speech), "and an empty feed is honest");
}

console.log(`\n${pass}/${pass + fail} Osiris checks passed\n`);
process.exit(fail ? 1 : 0);
