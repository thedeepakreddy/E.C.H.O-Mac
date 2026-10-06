import {toolGranted} from '../safety/tool-permissions.js';
import {codingRequestToolAllowed} from '../coding/tool-selection.js';
import {codingContinuationEligible} from '../coding/continuation.js';
import { z } from "zod";
import { Brain, JARVIS_PERSONA, LOOP_CAPS, buildSystemPrompt, turnContract } from "./types.js";
import type { AudioTurn, BrainExecutionLimits, SendOptions } from "./types.js";
import { TOOLS, ToolDef } from "../tools/registry.js";
import { selectToolNames } from "./tool-router.js";
import { INTERNAL_TOOLS } from '../memory/read-cache.js';
import { modelToolResult } from "../memory/tool-context.js";
import { ExternalToolCatalog } from "./external-tool-catalog.js";
import { currentAgentRunContext } from "../agent-replay/context.js";
import { assess, styleFor, noteActivity } from "../frontier/struggle.js";
import { runGated } from "../safety/gate.js";
import { recordLLM, approxTokens } from "../agent-replay/runtime.js";
import { resolveToolName } from "./localtools.js";
import { currentLoop, classifyProviderError } from "../agent-replay/loop-log.js";
import type { ExitReason } from "../agent-replay/recorder.js";
import type { JarvisConfig } from "../config.js";
import { connectMcpServers, loadMcpConfig, mcpToolDef, type McpConnection, type McpToolHandle } from "./mcp.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";
import { TurnQueue } from "./turn-queue.js";
import { chatgpt, explainPlanError } from "./chatgpt-auth.js";
import type { OpenAIAuth } from "./openai-auth.js";
import { completionRequest, readCompletionStream } from './chat-completions.js';
import { streamStep } from './stream-deadline.js';

/**
 * The OpenAI brain, on the Responses API.
 *
 * It pays one of two ways, chosen in openai-auth.ts: the user's ChatGPT plan
 * (Sign in with ChatGPT) or an API key. Both go through the same loop; only
 * the bearer token, the model and the tool grouping differ.
 *
 * It used to use Chat Completions. Plan usage is Responses-only, and the old
 * loop also dropped every screenshot a tool returned — the OpenAI brain was the
 * one brain that could not see the screen it was driving.
 *
 * Plan usage has rules of its own (developers.openai.com/siwc/
 * token-sharing-open-source/preview-limitations), and both modes follow them
 * so there is one request shape: `store: false` and `stream: true`; the whole
 * history in `input` (no `previous_response_id`); guidance in `instructions`,
 * never a system message; none of temperature, max_output_tokens, metadata and
 * the other rejected fields; function tools grouped in a namespace; no audio.
 */

const RESPONSES_URL = "https://api.openai.com/v1/responses";

/**
 * Where this instance posts, and what it calls itself.
 *
 * OpenRouter speaks the same Responses API, so it is this brain with a
 * different address rather than a second implementation — which matters
 * because every fix to the loop below would otherwise have to be made twice,
 * and in this codebase the second copy is the one that gets missed.
 */
export interface ResponsesEndpoint {
  url: string;
  /** Shown in logs and errors, so "which service refused?" is answerable. */
  label: string;
  /** Attribution headers OpenRouter asks third-party apps to send. */
  headers?: Record<string, string>;
  /**
   * A ceiling on the reply, for hosts that need one. Left unset for OpenAI.
   *
   * The two services disagree about this field and both are right for
   * themselves. The ChatGPT plan route REJECTS `max_output_tokens`, which is
   * why the request below omits it. OpenRouter then assumes the model's
   * maximum — 16,384 for gpt-4o-mini — and refuses the whole call if the
   * key's remaining credit could not cover that worst case:
   *
   *   "You requested up to 16384 tokens, but can only afford 8670"
   *
   * Nothing was actually going to generate 16k tokens; it is a solvency
   * check against a number Echo never chose. Naming a modest ceiling makes
   * the request affordable and costs nothing, since replies here are spoken.
   */
  maxOutputTokens?: number;
  protocol?: 'responses' | 'chat-completions';
  reasoningEffort?: 'low' | 'high' | 'max';
  firstResponseTimeoutMs?: number;
  streamSilenceMs?: number;
  requestTimeoutMs?: number;
}

const OPENAI_ENDPOINT: ResponsesEndpoint = { url: RESPONSES_URL, label: "openai" };
/** Function tools on the plan route must be grouped; this is the group's name. */
const TOOL_NAMESPACE = "echo";

function jsonSchemaToOpenAI(node: any): any {
  if (!node || typeof node !== "object") return { type: "string" };
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length) {
    const pick = variants.find((v: any) => v?.type !== "null") ?? variants[0];
    return jsonSchemaToOpenAI(pick);
  }
  const out: any = {};
  if (node.description) out.description = node.description;
  const jsonType = Array.isArray(node.type) ? node.type.find((t: any) => t !== "null") : node.type;
  out.type = ["string", "number", "integer", "boolean", "array", "object"].includes(jsonType) ? jsonType : "string";
  if (Array.isArray(node.enum)) {
    out.type = "string";
    out.enum = node.enum.map(String);
  }
  if (jsonType === "array") out.items = jsonSchemaToOpenAI(node.items ?? {});
  if (jsonType === "object") {
    out.properties = Object.fromEntries(Object.entries(node.properties ?? {}).map(([k, v]) => [k, jsonSchemaToOpenAI(v)]));
    if (node.required?.length) out.required = node.required;
  }
  return out;
}

function functionTool(name: string, description: string, jsonSchema: any) {
  const converted = jsonSchemaToOpenAI(jsonSchema);
  return {
    type: "function",
    name,
    description: String(description ?? "").slice(0, 1024),
    parameters: { type: "object", properties: converted.properties ?? {}, required: converted.required ?? [] },
  };
}

const toolFor = (t: ToolDef) => functionTool(t.name, t.description, (z as any).toJSONSchema(z.object(t.schema), { io: "input" }));

/** An API failure, carrying the status and machine-readable code the docs tell us to act on. */
export class OpenAIRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export function openAIFallbackReason(error: unknown): "quota" | "not found" | "temporarily overloaded" | null {
  const status = (error as any)?.status;
  const text = String((error as any)?.message ?? error ?? "");
  if (status === 429 || text.includes("insufficient_quota")) return "quota";
  if (status === 404 || text.includes("model_not_found")) return "not found";
  if (status === 503 || text.includes("server_error")) return "temporarily overloaded";
  return null;
}

const TOOL_RESULT_BUDGET = 12_000;

function withinBudget(text: string): string {
  if (typeof text !== "string" || text.length <= TOOL_RESULT_BUDGET) return text;
  const head = text.slice(0, Math.floor(TOOL_RESULT_BUDGET * 0.7));
  const tail = text.slice(-Math.floor(TOOL_RESULT_BUDGET * 0.25));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n[... ${dropped.toLocaleString()} characters withheld to protect the context window. Narrow the request ...]\n\n${tail}`;
}

function unknownToolAdvice(called: string, known: string[]): string {
  const want = String(called).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = known
    .map((name) => {
      const have = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const shared = want.filter((w) => have.some((h) => h.startsWith(w) || w.startsWith(h))).length;
      return { name, shared };
    })
    .filter((c) => c.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 5)
    .map((c) => c.name);
  return scored.length
    ? `There is no tool called "${called}". The closest tools that do exist are: ${scored.join(", ")}. Call one of those, or a different tool entirely — do not call "${called}" again.`
    : `There is no tool called "${called}", and nothing close to it exists. Choose a different tool from the ones you were given, or answer without one.`;
}

/** Screenshots kept in the history. Each is re-sent on every step, so older ones are dropped. */
const KEEP_IMAGES = 2;

/** Replace all but the newest images with a note, so a long task does not resend megabytes per step. */
export function trimResponseImages(items: any[], keep = KEEP_IMAGES): number {
  let seen = 0;
  let freed = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const content = items[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j]?.type !== "input_image") continue;
      seen++;
      if (seen > keep) {
        freed += String(content[j].image_url ?? "").length;
        content[j] = { type: "input_text", text: "[an earlier screenshot, removed to save space — take a new one if you need it]" };
      }
    }
  }
  return freed;
}

/** The model's output items, made safe to send back as input when nothing is stored server-side. */
export function replayableOutput(output: any[]): any[] {
  const items: any[] = [];
  for (const item of output ?? []) {
    if (item?.type === "message" && item.role === "assistant") {
      const content = (item.content ?? [])
        .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
        .map((c: any) => ({ type: "output_text", text: c.text }));
      if (content.length || typeof item.reasoning_content === 'string') items.push({ type: "message", role: "assistant", content,
        ...(typeof item.reasoning_content === 'string' ? {reasoning_content: item.reasoning_content} : {}) });
    } else if (item?.type === "function_call") {
      // No ids: with store:false there is nothing on the server for an id to
      // point at. Reasoning items are dropped for the same reason.
      items.push({
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        ...(item.namespace ? { namespace: item.namespace } : {}),
      });
    }
  }
  return items;
}

const textOf = (output: any[]) =>
  (output ?? [])
    .filter((i: any) => i?.type === "message")
    .flatMap((i: any) => (i.content ?? []).filter((c: any) => c?.type === "output_text").map((c: any) => c.text))
    .join("");

export class OpenAIBrain extends Brain {
  /** The Responses `input`: user messages, the model's echoed output, tool results. */
  private items: any[] = [];
  private tools: any[];
  /** This turn's pruned subset, or null to send them all. */
  private activeTools: any[] | null = null;
  private externalCatalog: ExternalToolCatalog | null = null;
  private busy = false;
  /** Messages that arrived while the loop was running — see turn-queue.ts. */
  private queue = new TurnQueue<{ content: any[] }>();
  private aborted = false;
  private mcpInitialized = false;
  private mcpTools: Map<string, McpToolHandle> = new Map();
  private lastSend: SendOptions = {};
  private mcpReady: Promise<McpConnection> | null = null;
  private mcpConnection: McpConnection | null = null;
  private memory: ProviderMemoryContext;
  private systemPrompt = JARVIS_PERSONA;
  private turnAbort: AbortController | null = null;
  /** The plan model, resolved once from the account's catalog when none is configured. */
  private planModel: string | null = null;

  /**
   * @param auth How to pay. null only for a recorded-run replay, where no
   * request ever leaves the machine.
   */
  constructor(
    private cfg: JarvisConfig,
    private readonly auth: OpenAIAuth | null,
    private readonly limits: BrainExecutionLimits = {},
    private readonly endpoint: ResponsesEndpoint = OPENAI_ENDPOINT
  ) {
    super();
    this.memory = new ProviderMemoryContext(endpoint.label);
    this.limits = {...limits, allowedTools: limits.allowedTools === undefined ? undefined : new Set(limits.allowedTools)};
    this.memory.configure(cfg.context);
    const allowed = this.limits.allowedTools;
    this.tools = (allowed ? TOOLS.filter((t) => toolGranted(allowed,t.name)) : TOOLS).map(toolFor);
    this.systemPrompt = buildSystemPrompt(undefined, undefined, false);
    if (Object.keys(loadMcpConfig()).length) {
      this.mcpReady = connectMcpServers({allowedTools: this.limits.allowedTools}).catch((err) => {
        console.error("[openai] MCP startup failed:", (err as any)?.message ?? err);
        return { tools: [], servers: [], close: async () => {} };
      });
    }
  }

  /** Which way this brain is paying, for logs and the control panel. */
  get billing(): "chatgpt" | "apiKey" | "replay" {
    return this.auth?.via ?? "replay";
  }

  /**
   * Audio input is not supported on the plan route, and the API-key model
   * (gpt-4o) takes it only through a different endpoint. The hearing pass in
   * main.ts describes the tone instead, as it does for Claude.
   */
  get hearsAudio(): boolean {
    return false;
  }

  private async initMcp() {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;
    this.mcpConnection = await (this.mcpReady ?? connectMcpServers({allowedTools: this.limits.allowedTools}));
    for (const tool of this.mcpConnection.tools) {
      if (this.limits.allowedTools && !toolGranted(this.limits.allowedTools,tool.name)) continue;
      this.tools.push(functionTool(tool.name, tool.description ?? "", tool.inputSchema));
      this.mcpTools.set(tool.name, tool);
    }
    const failed = this.mcpConnection.servers.filter((s) => !s.ok);
    if (failed.length) console.error(`[openai] MCP servers unavailable: ${failed.map((s) => s.name).join(", ")}`);
  }

  send(userText: string, _audio?: AudioTurn, opts?: SendOptions) {
    this.lastSend = opts ?? {};
    const reset = this.memory.begin(userText, opts);
    const contract = turnContract(opts);
    if (contract) userText = `${userText}\n\n${contract}`;
    noteActivity();
    const style = styleFor(assess());
    if (style) userText = `${userText}\n\n[context: ${style}]`;
    const content = [{ type: "input_text", text: userText }];
    // Never straight into a live history: mid-task it would land between a
    // function call and its output. See turn-queue.ts.
    if (this.busy) {
      this.queue.push({ content }, reset);
      return;
    }
    if (reset) this.items = [];
    this.appendUser(content);
    void this.runLoop();
  }

  /** Add a user message, merging into a trailing user message if there is one. */
  private appendUser(content: any[]) {
    const last = this.items[this.items.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content = [...last.content, ...content];
    else this.items.push({ role: "user", content });
  }

  private joinQueued(): boolean {
    const joined = this.queue.takeForRunningLoop();
    for (const q of joined) this.appendUser(q.content);
    return joined.length > 0;
  }

  /** After a stop, queued messages are the next request; after a failure, recovery carries them. */
  private drainQueue() {
    const next = this.queue.takeForNextLoop();
    if (!next.length) return;
    if (next.some((q) => q.reset) && this.aborted) this.items = [];
    for (const q of next) this.appendUser(q.item.content);
    if (!this.aborted) {
      console.log(`[openai] ${next.length} message(s) arrived as the task failed; kept for its recovery`);
      return;
    }
    next[0].resume(() => void this.runLoop());
  }

  noteInterrupted(spoken: string): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item?.type !== "message" || item.role !== "assistant") continue;
      item.content = [{ type: "output_text", text: `${spoken ? spoken + " " : ""}[interrupted by the user before finishing]` }];
      return;
    }
  }

  /** The bearer token and model for the next request. */
  private async credential(): Promise<{ token: string; model: string }> {
    if (!this.auth) throw new Error("No OpenAI credential: this brain was built for replay only.");
    if (this.auth.via === "apiKey") return { token: this.auth.key, model: this.cfg.openai.model };
    const token = await chatgpt.accessToken();
    const configured = this.cfg.openai.chatgptModel?.trim();
    if (configured) return { token, model: configured };
    if (!this.planModel) {
      const models = await chatgpt.listModels();
      if (!models.length) throw new OpenAIRequestError("Your ChatGPT plan didn't offer any models to Echo.", 403);
      this.planModel = models[0].slug;
      console.log(`[openai] using ${models[0].displayName} (${models[0].slug}) from your ChatGPT plan`);
    }
    return { token, model: this.planModel };
  }

  /**
   * One streamed Responses request. Text fragments go out as `textDelta` as
   * they arrive; the result is the completed response's output items.
   */
  private async streamResponse(request: any, token: string): Promise<{ output: any[]; usage: any; incomplete?: string }> {
    const turnId = this.lastSend.turnId;
    const controller = this.turnAbort ?? new AbortController();
    const send = () => fetch(this.endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(this.endpoint.headers ?? {}),
      },
      body: JSON.stringify(request),
      signal: this.endpoint.requestTimeoutMs
        ? AbortSignal.any([controller.signal, AbortSignal.timeout(this.endpoint.requestTimeoutMs)]) : controller.signal,
    });
    const res = this.endpoint.firstResponseTimeoutMs
      ? await streamStep(send, controller, this.endpoint.firstResponseTimeoutMs) : await send();
    if (!res.ok || !res.body) {
      const body: any = await res.json().catch(() => null);
      const code = body?.error?.code ?? undefined;
      const message = body?.error?.message ?? body?.detail ?? `${this.endpoint.label} request failed (${res.status})`;
      throw new OpenAIRequestError(String(message), res.status, code ? String(code) : undefined);
    }

    if (this.endpoint.protocol === 'chat-completions') {
      let text = '';
      const result = await readCompletionStream(res, delta => {
        text += delta; this.emitEvent('textDelta', {text: delta, turnId});
      }, this.endpoint.streamSilenceMs ? {controller, silenceMs: this.endpoint.streamSilenceMs} : undefined);
      if (text) this.emitEvent('textDone', {text, turnId});
      return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    let text = "";
    let finished: any = null;
    let incomplete: string | undefined;
    const doneItems: any[] = [];

    const dispatch = () => {
      const payload = data.join("\n");
      data = [];
      if (!payload || payload === "[DONE]") return;
      let event: any;
      try { event = JSON.parse(payload); } catch { return; }
      switch (event?.type) {
        case "response.output_text.delta":
          if (typeof event.delta === "string" && event.delta) {
            text += event.delta;
            this.emitEvent("textDelta", { text: event.delta, turnId });
          }
          break;
        case "response.output_item.done":
          if (event.item) doneItems.push(event.item);
          break;
        case "response.completed":
          finished = event.response ?? {};
          break;
        case "response.incomplete":
          finished = event.response ?? {};
          incomplete = String(event.response?.incomplete_details?.reason ?? "incomplete");
          break;
        case "response.failed":
        case "error": {
          const err = event.response?.error ?? event.error ?? event;
          throw new OpenAIRequestError(String(err?.message ?? "The response failed."), Number(err?.status ?? 400), err?.code ? String(err.code) : undefined);
        }
      }
    };

    try {
      for (;;) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        let nl: number;
        while ((nl = buffer.search(/\r?\n/)) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + (buffer[nl] === "\r" ? 2 : 1));
          if (line === "") dispatch();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (chunk.done) {
          if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
          dispatch();
          break;
        }
        if (finished) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (text) this.emitEvent("textDone", { text, turnId });
    if (!finished) {
      if (this.turnAbort?.signal.aborted) return { output: doneItems, usage: null, incomplete: "aborted" };
      throw new OpenAIRequestError("The response stream ended before it finished.", 502, "stream_interrupted");
    }
    const output = Array.isArray(finished.output) && finished.output.length ? finished.output : doneItems;
    return { output, usage: finished.usage ?? null, incomplete };
  }

  private toolsForRequest(): any[] {
    const tools = (this.activeTools ?? this.tools).filter(tool => (!this.cfg.agi?.toolPruning?.enabled || !this.memory.isCodingTurn() || codingRequestToolAllowed(tool.name)) && (!this.mcpTools.has(tool.name) || this.externalCatalog?.selected.has(tool.name)));
    if (!tools.length) return [];
    // The plan route takes function tools only inside a namespace.
    return this.auth?.via === "chatgpt"
      ? [{ type: "namespace", name: TOOL_NAMESPACE, description: "Echo's tools for seeing and operating this Mac.", tools }]
      : tools;
  }

  /** A call's name without the namespace a model may have prefixed it with. */
  private bareCallName(name: string): string {
    return String(name ?? "").replace(new RegExp(`^${TOOL_NAMESPACE}(?:\\.|__|:)`), "");
  }

  private async runLoop() {
    // Busy before the first await, or a second message during MCP startup
    // starts a second loop on the same history.
    this.busy = true;
    try {
      await this.initMcp();
    } catch (err) {
      console.error("[openai] MCP initialisation failed:", (err as any)?.message ?? err);
    }
    this.aborted = false;
    this.turnAbort = new AbortController();
    this.emitEvent("status", "thinking");
    this.externalCatalog = new ExternalToolCatalog([...this.mcpTools.values()]);
    const run = currentAgentRunContext(); if (run) run.toolCatalog = this.externalCatalog;
    await this.externalCatalog.begin(this.memory.query);

    if (this.cfg.agi?.toolPruning?.enabled) {
      const lastUser = [...this.items].reverse().find((c) => c.role === "user");
      const lastUserText = (lastUser?.content ?? []).filter((p: any) => p?.type === "input_text").map((p: any) => p.text).join("\n");
      const keep = await selectToolNames(lastUserText, this.cfg.agi.toolPruning.topK).catch(() => null);
      this.activeTools = keep ? this.tools.filter((d: any) => keep.has(d.name) || this.mcpTools.has(d.name)) : null;
    } else {
      this.activeTools = null;
    }

    const log = currentLoop();
    let exitReason: ExitReason | null = null;
    let exitDetail: string | undefined;
    let iteration = 0;
    let lastFinish: unknown = null;

    const stop = (reason: ExitReason, detail: string, spoken?: string) => {
      if (exitReason) return;
      exitReason = reason;
      exitDetail = detail;
      if (spoken) this.emitEvent("text", spoken);
    };

    try {
      let autoContinues = 0;
      let didAnyToolCall = false;
      const MAX_ITERATIONS = this.limits.maxIterations ?? LOOP_CAPS.openai.maxIterations;
      const AUTO_CONTINUE_LIMIT = LOOP_CAPS.openai.autoContinueLimit;

      let i = 0;
      for (; i < MAX_ITERATIONS; i++) {
        if (this.aborted) {
          stop("abort_signal", `interrupted at iteration ${i}`);
          break;
        }
        this.joinQueued();
        iteration = i;
        log?.iterationStart(i, this.items.length, approxTokens(this.items));

        if (this.memory.takeInvalidation()) {
          this.items = [{ role: "user", content: [{ type: "input_text", text: "Continue from the saved task state. Forgotten evidence is unavailable; re-observe if needed." }] }];
        }
        const { token, model } = await this.credential();
        const tools = this.toolsForRequest();
        const used = this.memory.prepareHistory(this.items, tools, this.systemPrompt, "openai", model);
        // Exactly the fields the plan route accepts — see the header comment.
        const request = {
          model,
          instructions: `${this.systemPrompt}\n\n${this.memory.packet(used, true, model)}`,
          input: this.items,
          ...(tools.length ? { tools } : {}),
          ...(this.endpoint.maxOutputTokens ? { max_output_tokens: this.endpoint.maxOutputTokens } : {}),
          store: false,
          stream: true,
        };
        log?.enterState("awaiting_llm", `${this.endpoint.label}:${model}`);
        log?.setModel(model);
        const startedAt = Date.now();
        const wireRequest = this.endpoint.protocol === 'chat-completions' ? completionRequest(request, this.endpoint.reasoningEffort) : request;
        const res = await recordLLM(wireRequest, () => this.streamResponse(wireRequest, token), 0, { willRetry: () => false });

        const output = res.output ?? [];
        const calls = output.filter((o: any) => o?.type === "function_call");
        lastFinish = res.incomplete ?? (calls.length ? "tool_calls" : "stop");
        log?.turnEnd({
          iteration: i,
          provider: this.endpoint.label,
          model,
          finishReason: res.incomplete ? "length" : calls.length ? "tool_calls" : "stop",
          rawFinishReason: lastFinish,
          toolCallCount: calls.length,
          toolNames: calls.map((c: any) => String(c?.name ?? "?")),
          promptTokens: res.usage?.input_tokens ?? null,
          completionTokens: res.usage?.output_tokens ?? null,
          totalContextTokens: res.usage?.total_tokens ?? null,
          latencyMs: Date.now() - startedAt,
          cacheHit: res.usage?.input_tokens_details?.cached_tokens ? true : null,
        } as any);

        if (res.incomplete === "aborted") {
          stop("abort_signal", `interrupted while streaming at iteration ${i}`);
          break;
        }

        this.items.push(...replayableOutput(output));
        const said = textOf(output).trim();
        if (said) this.emitEvent("text", said);

        if (res.incomplete && !calls.length) {
          stop(
            res.incomplete === "max_output_tokens" ? "context_overflow" : "model_stop_no_tool_call",
            `response incomplete: ${res.incomplete}`,
            `The model stopped before finishing (${res.incomplete}). I've stopped rather than pretend it was done.`
          );
          break;
        }

        if (!calls.length) {
          // Something new was said while this reply was written: answer it.
          if (!this.aborted && this.joinQueued()) continue;
          const meansToContinue =
            /\b(next|then|now (?:i|installing|assembling|implementing|building|testing)|after that|let me|i['’]?ll|i will|i['’]?m (?:continuing|building|implementing)|continu(?:e|ing)|proceed|moving on|going to|start(ing)? (with|by))\b/i.test(said) &&
            !/\b(done|finished|complete|all set|here'?s the|the result|in summary|to summari[sz]e|anything else)\b/i.test(said);
          const asksToContinue = /\b(shall i|should i|do you want me to|would you like me to)\b/i.test(said);
          if (codingContinuationEligible(didAnyToolCall,this.memory.isCodingTurn(),said) && (meansToContinue || asksToContinue || !didAnyToolCall) && autoContinues < AUTO_CONTINUE_LIMIT) {
            autoContinues++;
            log?.note("loop.auto_continue", { n: autoContinues, limit: AUTO_CONTINUE_LIMIT });
            this.appendUser([{ type: "input_text", text: "Take the next concrete step now; a progress sentence alone does not finish the task. For a large coding build, open/inspect the saved project, save milestones and start_project_build so the foreground remains available. Continue using tools until checks and acceptance evidence pass. If a genuinely blocking requirement is missing, save it with ask_build_question and wait for the answer." }]);
            continue;
          }
          if (codingContinuationEligible(didAnyToolCall,this.memory.isCodingTurn(),said) && (meansToContinue || asksToContinue || !didAnyToolCall)) {
            stop(
              "model_stop_no_tool_call",
              `auto-continue limit ${AUTO_CONTINUE_LIMIT} reached while still mid-task`,
              `I've used ${AUTO_CONTINUE_LIMIT} in-context continuations without finishing. I'm restarting from my durable checkpoint and continuing.`
            );
            break;
          }
          stop("completed", said ? "text-only reply with no tool calls" : "empty reply with no tool calls");
          break;
        }

        this.emitEvent("status", "acting");
        didAnyToolCall = true;
        const images: Array<{ tool: string; mimeType: string; data: string }> = [];

        const runOneCall = async (call: any): Promise<any> => {
          const called = this.bareCallName(call.name);
          let args: any = {};
          try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
          let tool = TOOLS.find((t) => t.name === called);
          const mcpInfo = this.mcpTools.get(called);
          if (!tool && !mcpInfo) {
            const resolved = resolveToolName(called);
            if (resolved) {
              tool = TOOLS.find((t) => t.name === resolved);
              if (tool) log?.note("tool.name_resolved", { called, ran: resolved });
            }
          }
          const reply = (body: unknown) => ({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(body) });
          if (!tool && !mcpInfo) {
            log?.note("tool.unknown", { called });
            this.emitEvent("tool", { name: called, summary: called });
            return reply({ error: unknownToolAdvice(called, TOOLS.map((t) => t.name).concat([...this.mcpTools.keys()])) });
          }
          try {
            const def = mcpInfo ? mcpToolDef(mcpInfo) : tool!;
            const out = await runGated(def, args, {
              workingDir: this.cfg.control.workingDir,
              allowedTools: this.limits.allowedTools,
              emit: (e, p) => this.emitEvent(e as any, p),
            });
            if (out.image) images.push({ tool: called, mimeType: out.image.mimeType, data: out.image.data });
            return reply(modelToolResult(out));
          } catch (err: any) {
            return reply({ error: String(err?.message ?? err) });
          }
        };

        const isObservation = (call: any): boolean => {
          const name = this.bareCallName(call.name);
          const handle = this.mcpTools.get(name);
          if (handle) return mcpToolDef(handle).readOnly;
          const named = TOOLS.find((t) => t.name === name) ?? TOOLS.find((t) => t.name === resolveToolName(name));
          return Boolean(named?.readOnly) && !INTERNAL_TOOLS.has(named!.name);
        };
        let batched = 0;
        while (batched < calls.length && isObservation(calls[batched])) batched++;
        const outputs: any[] = [];
        if (batched > 1) {
          log?.note("tool.parallel_batch", { count: batched, names: calls.slice(0, batched).map((c: any) => String(c?.name ?? "?")) });
          for (let start = 0; start < batched; start += 3) {
            outputs.push(...(await Promise.all(calls.slice(start, Math.min(start + 3, batched)).map(runOneCall))));
          }
        } else {
          batched = 0;
        }
        for (const call of calls.slice(batched)) outputs.push(await runOneCall(call));

        log?.enterState("reflecting", "trimming history");
        this.items.push(...outputs);
        // A tool's screenshot follows its result as an image the model can
        // actually see — the Chat Completions loop dropped these entirely.
        if (images.length) {
          this.items.push({
            role: "user",
            content: images.flatMap((img) => [
              { type: "input_text", text: `Screenshot returned by ${img.tool}:` },
              { type: "input_image", image_url: `data:${img.mimeType};base64,${img.data}`, detail: "auto" },
            ]),
          });
        }
        const freed = trimResponseImages(this.items);
        if (freed > 1_000_000) console.log(`[openai] released ${(freed / 1_048_576).toFixed(1)} MB of old screenshots from context`);
      }

      if (i >= MAX_ITERATIONS) {
        stop("max_iterations", `hit the ${MAX_ITERATIONS}-iteration cap`, `I hit my ${MAX_ITERATIONS}-step limit before finishing. I'm opening a fresh recovery attempt from the checkpoint.`);
      }
    } catch (err: any) {
      const reason = this.aborted ? "abort_signal" : classifyProviderError(err);
      stop(reason, String(err?.message ?? err));
      if (!this.aborted) {
        // On the plan route, the docs name specific codes with specific fixes;
        // say the fix rather than the raw error.
        const planned = this.auth?.via === "chatgpt" ? explainPlanError(err?.code, err?.status) : null;
        this.emitEvent("error", planned ?? String(err?.message ?? err));
      }
      log?.exit(reason, {
        iteration,
        error: err,
        messageCount: this.items.length,
        approxTokensInContext: approxTokens(this.items),
        rawFinishReason: lastFinish,
        detail: exitDetail,
      });
    } finally {
      this.busy = false;
      log?.exit(exitReason ?? "unknown_fallthrough", {
        iteration,
        detail: exitDetail,
        messageCount: this.items.length,
        approxTokensInContext: approxTokens(this.items),
        rawFinishReason: lastFinish,
      });
      log?.enterState("idle");
      this.emitEvent("turnEnd");
      this.emitEvent("status", "idle");
      this.drainQueue();
    }
  }

  interrupt() {
    this.aborted = true;
    this.queue.clear();
    try {
      this.turnAbort?.abort();
    } catch {
      /* nothing in flight */
    }
    this.emitEvent("status", "idle");
  }

  invalidateMemory(): void {
    this.memory.invalidate();
  }

  async stop() {
    this.aborted = true;
    this.turnAbort?.abort();
    this.queue.clear();
    this.memory.close();
    const connection = this.mcpConnection ?? (await this.mcpReady);
    await connection?.close().catch((err) => console.error("[openai] MCP shutdown failed:", (err as any)?.message ?? err));
  }
}
