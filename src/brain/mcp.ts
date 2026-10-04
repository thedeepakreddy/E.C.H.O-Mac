import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync , statSync } from "node:fs";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { getAppPath } from "../utils/appPath.js";
import type { ToolDef, ToolOutput } from "../tools/registry.js";
import { classify } from "../safety/risk.js";
import { hasExternalToolGrants } from '../safety/tool-permissions.js';
import { currentAgentRunContext } from '../agent-replay/context.js';

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
  call(args: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<ToolOutput>;
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

/**
 * An MCP tool dressed as one of Echo's own, so it goes through the safety gate.
 *
 * `runGated` takes a `ToolDef`; an `McpToolHandle` is not one. Every brain that
 * can call an outside server needs this same adapter, and for a while each one
 * carried its own copy — which had already drifted (one logged a failed
 * playback, the other swallowed it). A tool that arrives from outside Echo is
 * exactly the kind that must not be gated differently depending on which brain
 * happened to answer, so there is one adapter now and every caller uses it.
 *
 * Only tools already classified as low-risk observations are reusable reads.
 * Unknown capabilities remain actions and still pass the argument-aware gate.
 */
/**
 * An MCP input schema as Google's function-declaration dialect wants it.
 *
 * Re-exported from here rather than imported from gemini.ts by the realtime
 * voice session: that would pull a whole brain — its SDK client, its memory
 * context, its loop logging — into the voice path just for a schema walk.
 */
export function jsonSchemaToGoogleForRealtime(node: any): any {
  return toGoogle(node);
}

function toGoogle(node: any): any {
  if (!node || typeof node !== "object") return { type: "STRING" };
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const pick = (node.anyOf ?? node.oneOf).find((x: any) => x?.type !== "null") ?? {};
    return toGoogle(pick);
  }
  const t = Array.isArray(node.type) ? node.type.find((x: string) => x !== "null") : node.type;
  const out: any = { type: String(t ?? "string").toUpperCase() };
  if (node.description) out.description = String(node.description);
  if (node.enum) out.enum = node.enum.map(String);
  if (out.type === "ARRAY") out.items = toGoogle(node.items ?? {});
  if (out.type === "OBJECT") {
    out.properties = Object.fromEntries(Object.entries(node.properties ?? {}).map(([k, v]) => [k, toGoogle(v)]));
    if (Array.isArray(node.required)) out.required = node.required.map(String);
  }
  return out;
}

const definitions = new WeakMap<McpToolHandle, ToolDef>();

export function mcpToolDef(handle: McpToolHandle): ToolDef {
  const cached = definitions.get(handle);
  if (cached) return cached;
  // Compile once per discovered handle, not on every model iteration. A broken
  // server schema denies execution rather than silently disabling validation.
  let validate: (args: unknown) => string | null;
  try {
    const schema = handle.inputSchema ?? {type: 'object'};
    const dialect = String(schema.$schema ?? '');
    // Modern keywords such as prefixItems must be enforced, not ignored by a
    // draft-7 validator. Respect explicitly declared legacy server dialects.
    const options = {strict: false, allErrors: true, validateFormats: true};
    const ajv = dialect.includes('draft-07') ? new Ajv(options)
      : dialect.includes('2019-09') ? new Ajv2019(options) : new Ajv2020(options);
    addFormats(ajv);
    const validator = ajv.compile(schema);
    validate = args => validator(args) ? null : ajv.errorsText(validator.errors);
  } catch (error) {
    validate = () => `Server input schema could not be compiled: ${String(error)}`;
  }
  const definition: ToolDef = {
    name: handle.name,
    description: handle.description || "MCP tool",
    schema: {},
    validateInput: validate,
    readOnly: classify(handle.name, {}, {workingDir: process.cwd()}).tier === 'low',
    handler: async (args: any): Promise<ToolOutput> => {
      const result = await handle.call(args ?? {}, {signal: currentAgentRunContext()?.toolSignal});
      const text = result.text ?? "";
      // Sarvam and friends answer with a path to synthesised audio rather than
      // with sound. Playing it is the difference between Echo speaking the
      // translation and Echo reciting a filename.
      const wav = text.match(/(\/[^\s"']+\.wav)/i);
      if (wav && existsSync(wav[1])) {
        try {
          spawn("/usr/bin/afplay", [wav[1]]);
        } catch (err) {
          console.error("[mcp] could not play generated audio:", (err as any)?.message ?? err);
        }
      }
      return { ...result, text: text || "done" };
    },
  };
  definitions.set(handle, definition);
  return definition;
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
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = name.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
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
const connections = new Map<Set<LiveClient>, () => Promise<void>>();
async function closeClient(item: LiveClient): Promise<void> {
  // Only a stdio transport owns a child process; an HTTP one has nothing to
  // reap, and reading `.pid` off it would be undefined rather than an error.
  const pid = (item.transport as StdioClientTransport).pid ?? null;
  try { await withDeadline(item.client.close(), 5000, `${item.name} client close`); } catch { /* transport owns process */ }
  try { await withDeadline(item.transport.close(), 1000, `${item.name} transport close`); } catch { /* already closed */ }
  // The graceful close is a request. A wedged server ignores it, and the
  // forked worker never saw it at all, so verify and finish the job.
  if (pid !== null) await killTree(pid);
}
/** Preserve structured content and errors rather than laundering them into prose. */
export function mcpToolOutput(result: any): ToolOutput {
  const content = Array.isArray(result?.content) ? result.content : [];
  const picture = content.find((b: any) => b?.type === "image" && typeof b.data === "string");
  const payloads = [result?.structuredContent, ...content.filter((b: any) => b?.type === 'text').map((b: any) => {try {return JSON.parse(b.text);} catch {return null;}})];
  const failed = !!result?.isError || payloads.some(payload => payload && (payload.successfull === false || payload.successful === false || payload.success === false));
  return {
    text: textOf(result),
    status: failed ? "failed" : "success",
    verification: "unverified",
    ...(failed ? { error: { category: "tool_error", message: textOf(result) } } : {}),
    data: { content, structuredContent: result?.structuredContent ?? null, isError: !!result?.isError },
    ...(picture ? { image: { data: picture.data, mimeType: picture.mimeType ?? "image/png" } as any } : {}),
  };
}

export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

export type ClientFactory = (
  serverName: string,
  spec: McpServerSpec
) => Promise<{ client: Client; transport: McpTransport }>;

function configuredClient(serverName: string, spec: McpServerSpec): {client: Client; transport: McpTransport} {
  const client = new Client({ name: `echo-${serverName}`, version: "1.0.0" }, { capabilities: {} });
  if (isHttpSpec(spec)) {
    // Headers ride on every request, which is how a hosted server authenticates
    // — there is no login step, the key IS the session.
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers ?? {} },
    });
    return { client, transport };
  }
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
  });
  return { client, transport };
}

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
  allowedTools?: ReadonlySet<string>;
} = {}): Promise<McpConnection> {
  if (!hasExternalToolGrants(options.allowedTools)) return {tools: [], servers: [], close: async () => {}};
  const owned = new Set<LiveClient>();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    connections.delete(owned);
    const closing = [...owned];
    owned.clear();
    await Promise.all(closing.map(closeClient));
  };
  connections.set(owned, close);

  const config = options.config ?? loadMcpConfig();
  const factory: ClientFactory = options.factory ?? (async (name, spec) => {
    const item = configuredClient(name, spec);
    // Own the transport before connect can spawn or wait. Global shutdown and
    // startup deadlines must also see half-initialized server processes.
    owned.add({name, ...item});
    await item.client.connect(item.transport);
    return item;
  });
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
    if (closed) break;
    let connected: { client: Client; transport: McpTransport } | null = null;
    try {
      let accepted = true;
      const pending = factory(serverName, spec).then(async item => {
        if (!accepted || closed) { await closeClient({ name: serverName, ...item }); throw new Error("MCP connection expired"); }
        return item;
      });
      try { connected = await withDeadline(pending, deadline, `MCP server "${serverName}"`); }
      finally { accepted = false; }
      if (closed) throw new Error('MCP connection closed during startup');
      if (![...owned].some(item => item.client === connected!.client)) owned.add({name: serverName, ...connected});
      const listed = await withDeadline(
        connected.client.listTools(),
        deadline,
        `listing tools for "${serverName}"`
      );
      if (closed) throw new Error('MCP connection closed during tool discovery');

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
          call: async (args, options) => {
            if (closed) return { status: "failed", text: "This MCP connection is closed.", error: { category: "unavailable", message: "MCP connection closed" }, verification: "unverified" };
            if (options?.signal?.aborted) return {status: 'cancelled', text: 'The task was cancelled before the MCP call started.', verification: 'unverified'};
            // A hung tool call stalls the agent loop exactly like a hung
            // connect does, so it gets the same deadline.
            const controller = new AbortController();
            const requestSignal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
            const timer = setTimeout(() => controller.abort(), deadline);
            try {
              const result = await withDeadline(
                client.callTool({ name: tool.name, arguments: args ?? {} }, undefined, {signal: requestSignal, timeout: deadline}),
                deadline, name
              );
              return mcpToolOutput(result);
            } catch (error: any) {
              if (options?.signal?.aborted) return {status: 'uncertain', text: `${name} was interrupted. Remote side effects are unverified.`, verification: 'unverified', error: {category: 'cancelled', message: 'MCP call interrupted; verify remote state before retrying', retryable: false}};
              if (controller.signal.aborted || error?.code === -32001 || /timed out|timeout/i.test(String(error?.message))) {
                controller.abort();
                return {status: 'timeout', text: `${name} exceeded its deadline. Cancellation was requested; remote side effects are unverified.`, verification: 'unverified', error: {category: 'timeout', message: 'MCP call timed out; verify remote state before retrying', retryable: false}};
              }
              throw error;
            } finally { clearTimeout(timer); }
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
      const failed = [...owned].filter(item => item.name === serverName);
      for (const item of failed) owned.delete(item);
      if (connected && !failed.some(item => item.client === connected!.client)) failed.push({name: serverName, ...connected});
      await Promise.all(failed.map(closeClient));
    }
  }

  return { tools, servers, close };
}

/** Explicit process shutdown only. A brain must call its own connection.close(). */
export async function closeMcpServers(): Promise<void> {
  await Promise.all([...connections.values()].map(close => close()));
}

export function openMcpServerCount(): number {
  return [...connections.keys()].reduce((sum, owned) => sum + owned.size, 0);
}
