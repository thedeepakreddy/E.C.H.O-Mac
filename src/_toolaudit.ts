/**
 * Every tool a connected MCP server actually offers, rated by Echo's gate,
 * and cross-checked against what the server itself says is destructive.
 *
 *   npm run toolaudit -- <mcp-server-id> [user_id]
 *
 * Connecting a toolkit is the moment to do this. Gmail's 60 names found a
 * silent-delete hole the first time; the point of keeping it as a script is
 * that the next toolkit gets the same treatment for free.
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./env.js";
import { connectMcpServers } from "./brain/mcp.js";
import { classify } from "./safety/risk.js";

loadEnv(process.cwd());
const id = process.argv[2];
const uid = process.argv[3] ?? "deepak";
const hintFile = process.argv[4];

const live = await connectMcpServers({ config: { composio: {
  type: "http" as const,
  url: `https://backend.composio.dev/v3/mcp/${id}?user_id=${encodeURIComponent(uid)}`,
  headers: { "x-api-key": process.env.COMPOSIO_API_KEY ?? "" },
} }, timeout: 60_000 });

console.log(`\n${live.tools.length} tools reach Echo from this server\n`);

const kitOf = (n: string) => n.replace(/^mcp__composio__/, "").split("_")[0];
const byKit = new Map<string, number>();
const tiers = { low: 0, medium: 0, high: 0 };
const rated: Array<{ name: string; bare: string; tier: string }> = [];
for (const t of live.tools) {
  const tier = classify(t.name, {}, { workingDir: process.cwd() }).tier;
  tiers[tier]++;
  byKit.set(kitOf(t.name), (byKit.get(kitOf(t.name)) ?? 0) + 1);
  rated.push({ name: t.name, bare: t.name.replace(/^mcp__composio__/, ""), tier });
}
console.log("per toolkit :", [...byKit].map(([k, n]) => `${k} ${n}`).join(" · "));
console.log("gate tiers  :", `low ${tiers.low} · medium ${tiers.medium} · high ${tiers.high}`);

// The check that matters: anything the SERVER calls destructive must not be
// something Echo runs without asking. `medium` is auto-allowed, so only
// `high` counts as "asks first".
if (hintFile) {
  const hints: Record<string, Array<{ slug: string; tags: string[] }>> = JSON.parse(readFileSync(hintFile, "utf8"));
  const tagOf = new Map<string, string[]>();
  for (const list of Object.values(hints)) for (const t of list) tagOf.set(t.slug, t.tags);

  const missed = rated.filter((r) => (tagOf.get(r.bare) ?? []).includes("destructiveHint") && r.tier !== "high");
  const nagged = rated.filter((r) => (tagOf.get(r.bare) ?? []).includes("readOnlyHint") && r.tier === "high");
  console.log(`\nagainst the server's OWN annotations (${tagOf.size} tools annotated):`);
  console.log(`  destructive but NOT gated high : ${missed.length}`);
  for (const m of missed) console.log(`     ${m.tier.padEnd(6)} ${m.bare}`);
  console.log(`  read-only but gated high (nags): ${nagged.length}`);
  for (const n of nagged.slice(0, 12)) console.log(`     ${n.bare}`);
}
await live.close();
process.exit(0);
