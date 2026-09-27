import { execFileSync } from "node:child_process";
import { existsSync, readFileSync , statSync } from "node:fs";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAppPath } from "../utils/appPath.js";
import type { ToolOutput } from "../tools/registry.js";

/**
 * One place that knows how to reach an MCP server.
 *
 * This used to live twice — once in the Gemini brain, once in the Claude brain —
 * and both copies had the same four holes:
 *
 *   1. mcp.json was looked up in process.cwd(). That is the project directory
 *      when Echo is started with `npm start` and `/` when it is launched from
 *      Finder, so a packaged build silently had no MCP servers at all and said
 *      nothing about it.
 *   2. Every server was connected inside ONE try/catch. The first server whose
 *      binary was missing threw, and every server after it was never reached —
 *      with one line on the console as the only trace.
 *   3. `await client.connect(...)` had no timeout. A server that spawns but
 *      never speaks (uvx fetching a package on a bad network is the obvious
 *      one) hangs initMcp forever, and because the agent loop awaits it before
 *      its first request, the brain goes quiet with no error and no turn end.
 *      That is a silent stop with a cause nobody can see.
 *   4. Nothing was ever closed. Every brain switch spawned a fresh set of
 *      server processes and abandoned the previous ones.
 *
 * Everything here is therefore per-server isolated, deadlined, and closeable.
 */

/**
 * How a server is described in mcp.json.
 *
 * Two transports, because the ecosystem has two. A local server is launched as
 * a child process and spoken to over stdio; a hosted one (Composio and the
 * like) is an HTTPS endpoint with an auth header. Echo only ever supported the
 * first, so a hosted server could not be configured at all — there was no
 * field to put its URL in.
 *
 * These are deliberately the shapes the Claude Agent SDK already defines. The
 * Claude brain hands external servers straight to the SDK, so matching its
 * config means one spec serves both Echo's own client and the SDK's, with no
 * conversion step to drift.
 */
export interface McpStdioSpec {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface McpHttpSpec {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}
export type McpServerSpec = McpStdioSpec | McpHttpSpec;

export function isHttpSpec(spec: McpServerSpec): spec is McpHttpSpec {
  return (spec as McpHttpSpec).type === "http";
}

/**
 * Expand `${VAR}` from the environment in a config value.
 *
 * A hosted server's credential is a header, and mcp.json is a plaintext file
 * that already holds one API key in the clear. `"x-api-key": "${COMPOSIO_API_KEY}"`
 * keeps the secret in .env or the keystore where the rest of them live, and
 * leaves the config safe to read over someone's shoulder.
 *
 * An unset variable expands to empty rather than to the literal `${VAR}` — a
 * blank header fails with an auth error that says so, while sending the
 * placeholder text produces a puzzling 400.
 */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => process.env[name] ?? "");
}

/** A single MCP tool, already named the way the model will call it. */
export interface McpToolHandle {
  /** `mcp__<server>__<tool>`, sanitized and unique. */
  name: string;
  serverName: string;
  originalName: string;
  description: string;
  inputSchema: any;
  call(args: Record<string, unknown>): Promise<ToolOutput>;
}

/** What happened to each server, so a failure is reportable rather than lost. */
export interface McpServerStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface McpConnection {
  tools: McpToolHandle[];
  servers: McpServerStatus[];
  /** Close only this brain's clients. Idempotent. */
  close(): Promise<void>;
}

/** Gemini caps a function name at 64 characters and rejects anything longer. */
const MAX_TOOL_NAME = 64;

/**
 * How long a server gets to come up.
 *
 * 30s, measured rather than guessed: `uvx sarvam-mcp` takes about 16 seconds
 * from spawn to tool list on this machine, because uvx checks pypi for the
 * package on every start. A 15s deadline dropped a server that was working
 * perfectly well — so the number has to clear a real cold start with room to
 * spare, and the cost of it being generous is paid in the background (see the
 * eager connect in the Gemini brain) rather than by someone waiting for an
 * answer.
 */
function timeoutMs(): number {
  const n = Number(process.env.ECHO_MCP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30_000;
}

/**
 * Where mcp.json lives.
 *
 * The app path first — that is where every other config file in Echo is read
 * from — and the working directory second, so running from a checkout keeps
 * behaving exactly as it did.
 */
export function mcpConfigPath(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(join(getAppPath(), "mcp.json"));
  } catch {
    /* not inside Electron */
  }
  candidates.push(join(process.cwd(), "mcp.json"));
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Cached by path + mtime. Each brain reads this once at startup, which was
 * always fine — but the control panel's live snapshot calls it on every
 * refresh tick (up to ~16/sec while Echo is active) purely to report which
 * servers are configured, and mcp.json does not change while Echo is running.
 * `readFileSync` + `JSON.parse` on every tick was synchronous disk I/O on
 * Electron's single-threaded main process, which blocks IPC for every window
 * — the control panel's own button clicks included — while it runs. A
 * `statSync` to check mtime is orders of magnitude cheaper and still notices
 * a live edit to the file on the very next call.
 */
const mcpConfigCache = new Map<string, { mtimeMs: number; data: Record<string, McpServerSpec> }>();

/**
 * Read the server list, tolerating a file that is missing or malformed.
 *
 * A broken mcp.json must not take the brain down with it: no MCP is a working
 * assistant with fewer tools, while a thrown parse error during startup is no
 * assistant at all.
 */
export function loadMcpConfig(path = mcpConfigPath()): Record<string, McpServerSpec> {
  // `ECHO_MCP=0` turns the whole layer off. Tests that construct a real brain
  // set it — a unit test has no business spawning somebody's uvx server — and
  // it doubles as the switch for running Echo without external tools.
  if (process.env.ECHO_MCP?.trim() === "0") return {};
  if (!path) return {};
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mcpConfigCache.delete(path);
    return {}; // missing file — same as before, just without paying for a full read first
  }
  const cached = mcpConfigCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") return {};
    const out: Record<string, McpServerSpec> = {};
    for (const [name, spec] of Object.entries<any>(servers)) {
      // A hosted server: `{ "type": "http", "url": ..., "headers": {...} }`.
      if (spec?.type === "http" || (typeof spec?.url === "string" && !spec?.command)) {
        const url = typeof spec.url === "string" ? expandEnv(spec.url).trim() : "";
        if (!/^https?:\/\//i.test(url)) {
          console.error(`[mcp] server "${name}" has no usable url — skipping it`);
          continue;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries<any>(spec.headers ?? {})) {
          if (typeof v === "string") headers[k] = expandEnv(v);
        }
        out[name] = { type: "http", url, headers };
        continue;
      }
      if (!spec?.command || typeof spec.command !== "string") {
        console.error(`[mcp] server "${name}" has neither a command nor a url — skipping it`);
        continue;
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries<any>(spec.env ?? {})) {
        if (typeof v === "string") env[k] = expandEnv(v);
      }
      out[name] = {
        command: spec.command,
        args: Array.isArray(spec.args) ? spec.args.map(String) : [],
        env,
      };
    }
    mcpConfigCache.set(path, { mtimeMs, data: out });
    return out;
  } catch (err: any) {
    console.error(`[mcp] could not read ${path}: ${err?.message ?? err}`);
    mcpConfigCache.delete(path);
    return {};
  }
}

/**
 * The name the model sees, guaranteed callable.
 *
 * Three rules, each earned: only `[A-Za-z0-9_]` survives (Gemini rejects the
 * rest), the result is capped at 64 characters (a longer one 400s the WHOLE
 * request, taking every other tool down with it), and a collision gets a
 * numeric suffix rather than silently overwriting the tool registered first.
 */
export function toolNameFor(serverName: string, toolName: string, taken: Set<string> = new Set()): string {
  const clean = (s: string) => String(s ?? "").replace(/[^a-zA-Z0-9_]/g, "_");
  let name = `mcp__${clean(serverName)}__${clean(toolName)}`;
  if (name.length > MAX_TOOL_NAME) {
    // Trim the middle of the tool's own name, not the prefix: the prefix is how
    // the brain routes the call back to the right server.
    const prefix = `mcp__${clean(serverName)}__`;
    name = prefix.length >= MAX_TOOL_NAME
      ? prefix.slice(0, MAX_TOOL_NAME)
      : prefix + clean(toolName).slice(0, MAX_TOOL_NAME - prefix.length);
  }
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const suffix = `_${i}`;
    const candidate = name.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return name; // 98 identical names is not a situation worth more code
}

/** Reject a promise if it has not settled in time, without leaving it dangling. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      // Deliberately NOT unref'd. An unref'd timer cannot hold the event loop
      // open, so when the thing being raced is a promise that never settles —
      // exactly the case this exists for — Node finds nothing pending and the
      // await is abandoned instead of rejecting. The `finally` below clears it,
      // so it can never outlive the call either.
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Text out of an MCP result, which is a list of typed content blocks. */
function textOf(result: any): string {
  const content = (result?.content ?? []) as any[];
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text) return text;
  // Never hand a brain an empty string: an empty tool result reads as failure
  // and is the shape of a turn that ends with nothing said.
  return result?.isError ? "The MCP tool reported an error with no message." : "done";
}

/**
 * Reaching the whole server, not just the process we spawned.
 *
 * A launcher like `uvx` is not the server: it execs into `uv tool uvx` and
 * FORKS the real worker, so the thing burning CPU is our grandchild. The
 * transport only owns the direct child, and closing it leaves that worker
 * alive, reparented to launchd, spinning on a stdin that will never speak
 * again. Two of those were holding ~26% CPU each before this existed.
 *
 * Killing by process group is not an option: the SDK spawns without
 * `detached`, so the child sits in *Echo's* group and `kill(-pgid)` would
 * take Echo down with it. So we walk the tree explicitly instead.
 */
type ProcRow = { pid: number; ppid: number; args: string };

function processTable(): ProcRow[] {
  try {
    // Sync is fine here: this runs once at startup and once per server at
    // shutdown, never on a hot path.
    const out = execFileSync("ps", ["-Ao", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 8 << 20 });
    const rows: ProcRow[] = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
    }
    return rows;
  } catch {
    return []; // no `ps` (or it failed) — fall back to closing the child only
  }
}

function descendantsOf(rows: ProcRow[], root: number): number[] {
  const byParent = new Map<number, number[]>();
  for (const row of rows) {
    const kids = byParent.get(row.ppid);
    if (kids) kids.push(row.pid); else byParent.set(row.ppid, [row.pid]);
  }
  const found: number[] = [];
  const stack = [root];
  while (stack.length) {
    for (const kid of byParent.get(stack.pop()!) ?? []) { found.push(kid); stack.push(kid); }
  }
  return found;
}

const KILL_GRACE_MS = 1500;

/** Ask a server tree to stop, then insist. */
async function killTree(pid: number): Promise<void> {
  const targets = [...descendantsOf(processTable(), pid), pid];
  for (const target of targets) { try { process.kill(target, "SIGTERM"); } catch { /* already gone */ } }
  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
  for (const target of targets) {
    try { process.kill(target, 0); } catch { continue; } // exited on SIGTERM
    try { process.kill(target, "SIGKILL"); } catch { /* raced us */ }
  }
}

/**
 * Kill servers left behind by a previous run.
 *
 * No exit handler can cover a crash, a force quit, or `app.exit()`, and this
 * is how five stale servers accumulated across three days. An orphan is
 * identified by PPID 1 — which also means another app's live server is never
 * touched, because its parent is still there holding it.
 */
export function reapOrphanedMcpServers(config: Record<string, McpServerSpec> = loadMcpConfig()): number {
  const specs = Object.values(config);
  if (!specs.length) return 0;
  const rows = processTable();
  let killed = 0;
  for (const row of rows) {
    if (row.ppid !== 1 || row.pid === process.pid) continue;
    // Match the launcher ("uvx sarvam-mcp") and the worker it forked
    // ("…/bin/sarvam-mcp"), which no longer carries the launcher's name.
    const mine = specs.some((spec) => {
      // Only a stdio server has a process to orphan; a hosted one has none.
      if (isHttpSpec(spec)) return false;
      const tokens = spec.args?.length ? spec.args : [basename(spec.command)];
      return tokens.every((token) => row.args.includes(token));
    });
    if (!mine) continue;
    for (const target of [...descendantsOf(rows, row.pid), row.pid]) {
      try { process.kill(target, "SIGKILL"); killed++; } catch { /* already gone */ }
    }
  }
  return killed;
}

let reapedThisProcess = false;

/** Live clients, so they can be shut down when a brain is replaced. */
type LiveClient = { name: string; client: Client; transport: McpTransport };
const connections = new Set<Set<LiveClient>>();
async function closeClient(item: LiveClient): Promise<void> {
  // Only a stdio transport owns a child process; an HTTP one has nothing to
  // reap, and reading `.pid` off it would be undefined rather than an error.
  const pid = (item.transport as StdioClientTransport).pid ?? null;
  try { await item.client.close(); } catch { /* transport owns process */ }
  try { await item.transport.close(); } catch { /* already closed */ }
  // The graceful close is a request. A wedged server ignores it, and the
  // forked worker never saw it at all, so verify and finish the job.
  if (pid !== null) await killTree(pid);
}
/** Preserve structured content and errors rather than laundering them into prose. */
export function mcpToolOutput(result: any): ToolOutput {
  const content = Array.isArray(result?.content) ? result.content : [];
  const picture = content.find((b: any) => b?.type === "image" && typeof b.data === "string");
  return {
    text: textOf(result),
    status: result?.isError ? "failed" : "success",
    verification: "unverified",
    ...(result?.isError ? { error: { category: "tool_error", message: textOf(result) } } : {}),
    data: { content, structuredContent: result?.structuredContent ?? null, isError: !!result?.isError },
    ...(picture ? { image: { data: picture.data, mimeType: picture.mimeType ?? "image/png" } as any } : {}),
  };
}

export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

export type ClientFactory = (
  serverName: string,
  spec: McpServerSpec
) => Promise<{ client: Client; transport: McpTransport }>;

const defaultFactory: ClientFactory = async (serverName, spec) => {
  const client = new Client({ name: `echo-${serverName}`, version: "1.0.0" }, { capabilities: {} });
  if (isHttpSpec(spec)) {
    // Headers ride on every request, which is how a hosted server authenticates
    // — there is no login step, the key IS the session.
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers ?? {} },
    });
    await client.connect(transport);
    return { client, transport };
  }
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
  });
  await client.connect(transport);
  return { client, transport };
};

/**
 * Connect every configured server and collect their tools.
 *
 * Never throws and never hangs: a server that fails is reported in `servers`
 * and the others still load, which is the whole difference between "the Sarvam
 * server is missing" and "Echo has no tools tonight".
 */
export async function connectMcpServers(options: {
  config?: Record<string, McpServerSpec>;
  factory?: ClientFactory;
  timeout?: number;
} = {}): Promise<McpConnection> {
  const owned = new Set<LiveClient>();
  connections.add(owned);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    connections.delete(owned);
    const closing = [...owned];
    owned.clear();
    await Promise.all(closing.map(closeClient));
  };

  const config = options.config ?? loadMcpConfig();
  const factory = options.factory ?? defaultFactory;
  const deadline = options.timeout ?? timeoutMs();

  // Once per process, and only when we are really spawning: a test with its
  // own factory has no business killing anything on this machine.
  if (!options.factory && !reapedThisProcess) {
    reapedThisProcess = true;
    const reaped = reapOrphanedMcpServers(config);
    if (reaped) console.error(`[mcp] reaped ${reaped} orphaned server process(es) left by an earlier run`);
  }
  const tools: McpToolHandle[] = [];
  const servers: McpServerStatus[] = [];
  const taken = new Set<string>();

  for (const [serverName, spec] of Object.entries(config)) {
    let connected: { client: Client; transport: McpTransport } | null = null;
    try {
      let accepted = true;
      const pending = factory(serverName, spec).then(async item => {
        if (!accepted || closed) { await closeClient({ name: serverName, ...item }); throw new Error("MCP connection expired"); }
        return item;
      });
      try { connected = await withDeadline(pending, deadline, `MCP server "${serverName}"`); }
      finally { accepted = false; }
      const listed = await withDeadline(
        connected.client.listTools(),
        deadline,
        `listing tools for "${serverName}"`
      );
      owned.add({ name: serverName, ...connected });

      for (const tool of listed?.tools ?? []) {
        const name = toolNameFor(serverName, tool.name, taken);
        taken.add(name);
        const client = connected.client;
        tools.push({
          name,
          serverName,
          originalName: tool.name,
          description: tool.description || `MCP tool ${tool.name} from ${serverName}`,
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          call: async (args) => {
            if (closed) return { status: "failed", text: "This MCP connection is closed.", error: { category: "unavailable", message: "MCP connection closed" }, verification: "unverified" };
            // A hung tool call stalls the agent loop exactly like a hung
            // connect does, so it gets the same deadline.
            const result = await withDeadline(
              client.callTool({ name: tool.name, arguments: args ?? {} }),
              deadline,
              `${name}`
            );
            return mcpToolOutput(result);
          },
        });
      }
      servers.push({ name: serverName, ok: true, toolCount: listed?.tools?.length ?? 0 });
      console.log(`[mcp] ${serverName}: ${listed?.tools?.length ?? 0} tool(s)`);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      servers.push({ name: serverName, ok: false, toolCount: 0, error: message });
      console.error(`[mcp] ${serverName} unavailable: ${message}`);
      // A server that timed out has a child process sitting there; the transport
      // owns it, so closing the transport is what actually kills it.
      try {
        await connected?.transport.close();
      } catch {
        /* it may already be gone */
      }
    }
  }

  return { tools, servers, close };
}

/** Explicit process shutdown only. A brain must call its own connection.close(). */
export async function closeMcpServers(): Promise<void> {
  const all = [...connections];
  connections.clear();
  await Promise.all(all.flatMap(owned => {
    const items = [...owned]; owned.clear();
    return items.map(closeClient);
  }));
}

export function openMcpServerCount(): number {
  return [...connections].reduce((sum, owned) => sum + owned.size, 0);
}
