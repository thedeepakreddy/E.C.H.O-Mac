/**
 * Hosted MCP servers, over HTTP.   npm run mcphttptest
 *
 * Echo's MCP layer spoke stdio only — a server was a child process it launched.
 * Half the ecosystem is hosted instead (Composio and the like): an HTTPS
 * endpoint authenticated by a header, with no process to launch. There was no
 * field in mcp.json to even express one, so those servers could not be
 * configured at all.
 *
 * This runs a REAL MCP server over HTTP in-process and drives Echo's own client
 * against it, because the parts worth testing are the ones a shape-check cannot
 * see: that the right transport is chosen, that auth headers actually arrive,
 * that `${VAR}` in the config is expanded from the environment rather than sent
 * literally, and that tearing down an HTTP connection does not try to reap a
 * child process that was never there.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadMcpConfig, isHttpSpec, connectMcpServers, type McpServerSpec } from "./brain/mcp.js";

/** Enable only the explicitly generated fixture config, never the user's MCP. */
function readFixtureConfig(path: string) {
  const previous = process.env.ECHO_MCP;
  delete process.env.ECHO_MCP;
  try {return loadMcpConfig(path);}
  finally {
    if (previous === undefined) delete process.env.ECHO_MCP;
    else process.env.ECHO_MCP = previous;
  }
}

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

// ── a real MCP server, over HTTP ──────────────────────────────────────────

/** Every auth header the server was handed, so the test can check them. */
const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];

/**
 * A fresh server and transport PER REQUEST.
 *
 * Stateless mode (`sessionIdGenerator: undefined`) means exactly that: the
 * transport keeps no session, so reusing one across requests makes the second
 * one — `notifications/initialized` — answer 500 and the client's connect fails
 * with a bare "Error POSTing to endpoint". Building a new pair per request is
 * the documented stateless pattern, and it is a test-harness detail, not
 * anything about Echo.
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "test-hosted", version: "1.0.0" });
  server.tool("echo_back", "Repeat a phrase.", { phrase: z.string() }, async ({ phrase }) => ({
    content: [{ type: "text", text: `you said ${phrase}` }],
  }));
  return server;
}

const http: Server = createServer((req, res) => {
  seenHeaders.push({ ...req.headers });
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }
    void (async () => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    })();
  });
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const port = (http.address() as AddressInfo).port;
const url = `http://127.0.0.1:${port}/mcp`;

console.log("\nHosted MCP servers, over HTTP\n");

// ── the config shape ──────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), "echo-mcphttp-"));
const writeConfig = (servers: Record<string, unknown>): string => {
  const p = join(root, `mcp-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ mcpServers: servers }));
  return p;
};

console.log("  mcp.json can describe a hosted server");
{
  process.env.ECHO_TEST_MCP_KEY = "secret-value";
  const cfg = readFixtureConfig(
    writeConfig({
      hosted: { type: "http", url: "https://example.com/mcp", headers: { "x-api-key": "${ECHO_TEST_MCP_KEY}" } },
      local: { command: "/bin/echo", args: ["hi"], env: { K: "v" } },
    })
  );
  ok(Object.keys(cfg).length === 2, "both transports load side by side");
  const hosted = cfg.hosted;
  ok(isHttpSpec(hosted), "the hosted one is recognised as http");
  if (isHttpSpec(hosted)) {
    ok(hosted.url === "https://example.com/mcp", "its url survives");
    // The whole point of the expansion: mcp.json already holds one API key in
    // the clear, and a hosted server's credential should not join it.
    ok(hosted.headers?.["x-api-key"] === "secret-value",
      "`${VAR}` in a header is expanded from the environment",
      hosted.headers?.["x-api-key"]);
    ok(!JSON.stringify(hosted).includes("${"), "so no placeholder is sent literally");
  }
  ok(!isHttpSpec(cfg.local), "and a stdio server is still a stdio server");
}

console.log("\n  a malformed hosted entry is dropped, not fatal");
{
  const cfg = readFixtureConfig(
    writeConfig({
      nourl: { type: "http" },
      notaurl: { type: "http", url: "not-a-url" },
      fine: { type: "http", url: "https://example.com/ok" },
    })
  );
  ok(!cfg.nourl, "no url at all is dropped");
  ok(!cfg.notaurl, "a url that is not http(s) is dropped");
  ok(!!cfg.fine, "and the valid one still loads");
}

console.log("\n  an unset variable expands to empty, not to the placeholder");
{
  delete process.env.ECHO_TEST_MISSING_KEY;
  const cfg = readFixtureConfig(
    writeConfig({ h: { type: "http", url: "https://example.com/mcp", headers: { auth: "${ECHO_TEST_MISSING_KEY}" } } })
  );
  const h = cfg.h;
  // Sending the literal "${VAR}" produces a puzzling 400; an empty header
  // produces an auth error that says what is wrong.
  if (isHttpSpec(h)) ok(h.headers?.auth === "", "an unset variable becomes empty", JSON.stringify(h.headers));
}

// ── actually talking to it ────────────────────────────────────────────────

console.log("\n  Echo connects to it and lists its tools");
{
  seenHeaders.length = 0;
  const spec: McpServerSpec = { type: "http", url, headers: { "x-api-key": "hunter2" } };
  const live = await connectMcpServers({ config: { hosted: spec }, timeout: 15_000 });
  const names = live.tools.map((t) => t.name);
  const status = live.servers.find((x) => x.name === "hosted");
  ok(status?.ok === true, "the server connected", JSON.stringify(status));
  ok(names.some((n) => n.endsWith("echo_back")), `its tool is offered (${names.join(", ")})`);

  const sent = seenHeaders.find((h) => h["x-api-key"]);
  ok(!!sent, "the auth header reached the server — this is how a hosted server authenticates");
  ok(sent?.["x-api-key"] === "hunter2", "with the right value", String(sent?.["x-api-key"]));

  console.log("\n  and can call a tool over HTTP");
  const tool = live.tools.find((t) => t.name.endsWith("echo_back"));
  const out = await tool!.call({ phrase: "over http" });
  ok(out.status === "success", "the call succeeded", JSON.stringify(out).slice(0, 80));
  ok(String(out.text).includes("you said over http"), "and the result came back", String(out.text).slice(0, 60));

  console.log("\n  closing it does not try to reap a process that never existed");
  let threw = "";
  try { await live.close(); } catch (e: any) { threw = String(e?.message ?? e); }
  ok(!threw, "close() is clean for an HTTP transport", threw);
}

http.close();
console.log(`\n${pass}/${pass + fail} hosted-MCP checks passed`);
console.log("A failure here means a hosted server (Composio and the like) cannot be used.\n");
process.exit(fail === 0 ? 0 : 1);
