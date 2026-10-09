import assert from "node:assert/strict";
import {createWorldReader, WORLD_REFRESH_MS, type WorldFeed} from "./control-world.js";
let clock = Date.parse("2026-10-09T19:00:00Z"), calls = 0, fail = new Set<WorldFeed>();
const sourceAt = clock - 1000;
const data: Record<WorldFeed, any> = {
  conflicts: {timestamp: new Date(sourceAt).toISOString(), zones: [{label: "Test region", severity: "war", description: "description", events: [{title: "Verified observation", url: "https://example.org/report"}]}, {label: "Unsafe link", events: [{title: "No script execution", url: "javascript:alert(1)"}]}]},
  earthquakes: {earthquakes: [{magnitude: 5.2, place: "Recent", time: clock - 1000, depth: 12, tsunami: 1, url: "https://earthquake.usgs.gov/test"}, {magnitude: 7, place: "Old", time: clock - 86_400_001}, {magnitude: 8, place: "Future", time: clock + 1000}, {magnitude: "bad", time: clock}]},
  fires: {fires: [{confidence: "h"}, {confidence: "low"}]},
  weather: {events: [{title: "Storm observation", type: "Storm", severity: "High", provider: "NASA", date: new Date(clock).toISOString()}]},
};
let release!: () => void;
const gate = new Promise<void>(r => {release = r;});
let wait = true;
const read = createWorldReader({now: () => clock, fetchFeed: async name => {calls++; if (wait) await gate; if (fail.has(name)) throw new Error("Provider secret should remain private"); return data[name];}});
const a = read(), b = read();
assert.equal(calls, 4);release();
const [first, second] = await Promise.all([a, b]);wait = false;
assert.deepEqual(first, second);assert.equal(calls, 4);
assert.equal(first.earthquakes.count, 1);assert.equal(first.earthquakes.top[0].magnitude, 5.2);
assert.equal(first.tsunamis.length, 1);assert.equal(first.fires.count, 2);assert.equal(first.fires.highConfidence, 1);
assert.equal(first.conflicts[1].latest!.url, null);assert.equal(first.feeds.conflicts.sourceUpdatedAt, sourceAt);
assert.equal(first.storms[0].title, "Storm observation");
assert.equal(first.checkedAt, clock);
console.log("✓ concurrent reads coalesce, normalize all four feeds, reject unsafe links, and exclude old/future quakes");
first.conflicts[0].label = "mutated";first.feeds.fires.status = "unavailable";
const cached = await read();assert.equal(calls, 4);assert.equal(cached.conflicts[0].label, "Test region");assert.equal(cached.feeds.fires.status, "current");
console.log("✓ 30-second cache and returned copies cannot be poisoned by callers");
clock += WORLD_REFRESH_MS;fail.add("fires");data.weather.events[0].title = "New storm";
const partial = await read();assert.equal(calls, 8);assert.equal(partial.fires.count, 2);assert.equal(partial.feeds.fires.status, "stale");assert.equal(partial.feeds.fires.updatedAt, cached.feeds.fires.updatedAt);
assert.equal(partial.storms[0].title, "New storm");assert.equal(partial.feeds.weather.updatedAt, clock);
console.log("✓ partial outages retain last-good values and timestamps while healthy feeds update");
clock += WORLD_REFRESH_MS;fail.clear();data.fires = {error: "busy", fires: []};
const malformed = await read();assert.equal(malformed.fires.count, 2);assert.equal(malformed.feeds.fires.status, "stale");
clock += WORLD_REFRESH_MS;data.fires = {fires: []};
const recovered = await read();assert.equal(recovered.fires.count, 0);assert.equal(recovered.feeds.fires.status, "current");
console.log("✓ malformed/provider-error responses retain data; genuine empty results recover to zero");
clock += WORLD_REFRESH_MS;fail = new Set(["conflicts", "earthquakes", "fires", "weather"]);
const outage = await read();assert.equal(outage.conflicts.length, 2);assert.equal(outage.storms[0].title, "New storm");assert.ok(Object.values(outage.feeds).every(f => f.status === "stale"));assert.equal(outage.feeds.weather.updatedAt, recovered.feeds.weather.updatedAt);
assert.ok(!JSON.stringify(outage).includes("secret"));const before = calls;await read();assert.equal(calls, before);
console.log("✓ complete outages preserve observations without exposing provider errors or retrying every click");
let failedCalls = 0;
const unavailable = createWorldReader({now:()=>clock,fetchFeed: async()=>{failedCalls++;throw new Error("offline");}});
const empty = await unavailable();assert.equal(empty.earthquakes.count, null);assert.equal(empty.fires.count, null);assert.ok(Object.values(empty.feeds).every(f=>f.status === "unavailable" && f.updatedAt === null));
await unavailable();assert.equal(failedCalls, 4);
console.log("✓ first-load outages show unavailable, never invented zero counts, and respect retry cooldown");
clock += 86_400_000;
const expired = await read();assert.equal(expired.earthquakes.count, 0);assert.equal(expired.tsunamis.length, 0);
console.log("✓ retained quake observations age out of the rolling 24-hour window");
console.log("7/7 world checks passed");
