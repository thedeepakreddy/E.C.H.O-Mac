/**
 * Composio, end to end, from the real mcp.json.   npm run composiolive
 *
 * Composio is a HOSTED MCP server: no process to launch, just an HTTPS endpoint
 * and an API key in a header. Echo could not express that at all until the http
 * transport went in, and `_mcphttptest` proves the transport against a local
 * server it controls. This proves the other half — the parts a local server
 * cannot exercise:
 *
 *   - the entry in the REAL mcp.json parses and expands `${COMPOSIO_API_KEY}`
 *     from .env, so the secret is not sitting in a config file
 *   - a real Composio endpoint accepts that header and hands back real tools
 *   - the risk gate classifies names it has never seen — Composio tools are not
 *     in any of Echo's lists — by what the NAME says they do
 *   - and a call actually returns data
 *
 * Network-dependent by design, so it is not part of the regression suite.
 */
import { z } from "zod";
import { loadEnv } from "./env.js";
import { loadMcpConfig, isHttpSpec, connectMcpServers } from "./brain/mcp.js";
import { classify } from "./safety/risk.js";
import { runGated } from "./safety/gate.js";
import type { ToolDef } from "./tools/registry.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

loadEnv(process.cwd());
const cwd = process.cwd();

console.log("\nComposio over hosted MCP\n");

console.log("  the real mcp.json describes it");
const cfg = loadMcpConfig();
const spec = cfg.composio;
ok(!!spec, "there is a `composio` server in mcp.json");
ok(!!spec && isHttpSpec(spec), "and it is an http server, not a process to spawn");
if (!spec || !isHttpSpec(spec)) { console.log("\ncannot continue\n"); process.exit(1); }

const key = spec.headers?.["x-api-key"] ?? "";
ok(key.length > 10, "its api key header is filled in", `len=${key.length}`);
ok(!key.includes("${"), "expanded from .env, not sent as a literal `${VAR}`");
ok(key !== "", "and .env actually had the variable — an empty header would 401");
// The secret must not be in the config file itself. Read the raw text.
const raw = (await import("node:fs")).readFileSync("mcp.json", "utf8");
ok(!raw.includes(key), "and the key itself is NOT written in mcp.json");

console.log("\n  Echo connects to it");
const live = await connectMcpServers({ config: { composio: spec }, timeout: 30_000 });
const status = live.servers.find((s) => s.name === "composio");
ok(status?.ok === true, "the hosted server connected", JSON.stringify(status));
ok(live.tools.length > 0, `it offers ${live.tools.length} tool(s)`);
if (!live.tools.length) { await live.close(); process.exit(1); }

for (const t of live.tools.slice(0, 6)) console.log(`      ${t.name}`);

console.log("\n  the gate judges names it has never seen");
{
  // None of these are in READ_ONLY or any other list — the tier comes purely
  // from the words in the name. That is the whole point: a Composio account can
  // add Gmail or Supabase tomorrow and the gate must not wave them through.
  const tiers = live.tools.map((t) => ({ name: t.name, tier: classify(t.name, {}, { workingDir: cwd }).tier }));
  for (const t of tiers.slice(0, 4)) console.log(`      ${t.tier.padEnd(6)} ${t.name}`);
  const reads = tiers.filter((t) => /_GET_|_LIST_|_SEARCH_/.test(t.name));
  ok(reads.length > 0 && reads.every((t) => t.tier === "low"),
    `every GET/LIST/SEARCH tool is low risk (${reads.length})`,
    reads.filter((t) => t.tier !== "low").map((t) => t.name).join(", "));

  // And the other direction, on names Composio really uses for the apps he
  // wants next. A gate that called everything low would pass the check above.
  const dangerous: Array<[string, string]> = [
    ["mcp__composio__GMAIL_SEND_EMAIL", "high"],
    ["mcp__composio__GMAIL_DELETE_MESSAGE", "high"],
    ["mcp__composio__SUPABASE_RUN_SQL_QUERY", "high"],
    ["mcp__composio__GITHUB_MERGE_PULL_REQUEST", "high"],
    ["mcp__composio__STRIPE_CREATE_REFUND", "high"],
    ["mcp__composio__GITHUB_CREATE_ISSUE", "medium"],
  ];
  for (const [name, want] of dangerous) {
    const got = classify(name, {}, { workingDir: cwd });
    ok(got.tier === want, `${name.replace("mcp__composio__", "")} -> ${want}`, `got ${got.tier}: ${got.reason}`);
  }
}

console.log("\n  and a real call returns real data");
{
  // A read whose schema demands nothing, so the call exercises auth and
  // transport rather than this test's ability to guess a message id. Picking
  // the first `_GET_` by name found GMAIL_GET_ATTACHMENT once Gmail was
  // connected, which needs three arguments and fails on all of them.
  const noArgs = (t: { inputSchema: any }) => !(t.inputSchema?.required ?? []).length;
  const tool = live.tools.find((t) => /_GET_|_LIST_/.test(t.name) && noArgs(t));
  ok(!!tool, "found a read-only tool that needs no arguments");
  if (tool) {
    const def: ToolDef = {
      name: tool.name,
      description: tool.description,
      schema: {} as Record<string, z.ZodTypeAny>,
      readOnly: true,
      handler: (a) => tool.call(a ?? {}),
    };
    console.log(`      calling ${tool.name} …`);
    const t0 = Date.now();
    const out = await runGated(def, {}, { workingDir: cwd });
    ok(out.status === "success", `the gate ran it and it succeeded in ${Date.now() - t0}ms`,
      `${out.status}: ${String(out.text).slice(0, 120)}`);
    ok(String(out.text).length > 20, "and there is data in the answer");
    console.log(`      ${String(out.text).replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

console.log("\n  and it tears down without reaping a process that never existed");
{
  let threw = "";
  try { await live.close(); } catch (e: any) { threw = String(e?.message ?? e); }
  ok(!threw, "close() is clean", threw);
}

console.log(`\n${pass}/${pass + fail} Composio checks passed\n`);
process.exit(fail === 0 ? 0 : 1);
