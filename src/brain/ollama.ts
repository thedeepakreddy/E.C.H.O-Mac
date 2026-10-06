import {toolGranted} from '../safety/tool-permissions.js';
import { z } from "zod";
import { Brain, LOOP_CAPS, LOCAL_PERSONA, turnContract, type AudioTurn, type BrainExecutionLimits, type SendOptions } from "./types.js";
import { TOOLS, TOOL_MAP } from "../tools/registry.js";
import { classify, bareToolName } from "../safety/risk.js";
import { runGated } from "../safety/gate.js";
import { parseCallsFromText, resolveToolName, toolsForLocalModel, fitLocalTools } from "./localtools.js";
import { selectToolNames } from "./tool-router.js";
import { connectMcpServers, loadMcpConfig, mcpToolDef, type McpConnection, type McpToolHandle } from "./mcp.js";
import { assess, styleFor, noteActivity } from "../frontier/struggle.js";
import { capture } from "../safety/snapshot.js";
import { confirmations } from "../safety/confirm.js";
import { recordLLM, approxTokens } from "../agent-replay/runtime.js";
import { currentLoop, normalizeOllamaFinish, classifyProviderError } from "../agent-replay/loop-log.js";
import type { ExitReason } from "../agent-replay/recorder.js";
import type { JarvisConfig } from "../config.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";
import { TurnQueue } from "./turn-queue.js";
import { localContextBudget } from "./local-budget.js";
import { contextTokens } from "../memory/conversation.js";
import { modelToolResult } from "../memory/tool-context.js";

/**
 * Fully-offline brain backed by a local Ollama model.
 *
 * No network, no API limits, nothing leaves the machine. A small local model is
 * far weaker than Claude at driving a GUI, so this is best for private Q&A and
 * simple actions, or as the cheap workhorse for constant background jobs. It
 * runs every tool call through the SAME risk gate as the cloud brains — the
 * safety layer must not depend on which model is thinking.
 *
 * Ollama exposes an OpenAI-style tool-calling chat API, so the zod tool schemas
 * convert to JSON Schema and the loop is a plain call/observe cycle.
 */
export class OllamaBrain extends Brain {
  private messages: any[] = [];
  private busy = false;
  /** Messages that arrived while the loop was running — see turn-queue.ts. */
  private queue = new TurnQueue<string>();
  private aborted = false;
  /** How the current turn arrived; shapes the reply for the ear when spoken. */
  private lastSend: SendOptions = {};
  private memory = new ProviderMemoryContext("ollama", 650);
  private modelContextTokens: number | undefined;
  private contextChecked = false;
  private requestController: AbortController | null = null;
  // A 3B model given all 73 definitions (~22KB per turn) cannot pick the right
  // one and starts inventing names. A focused list is what makes tool use work
  // at all locally.
  private tools: any[];
  /** Outside servers (Composio and the like). Empty until initMcp runs. */
  private mcpTools = new Map<string, McpToolHandle>();
  private mcpReady: Promise<McpConnection> | null = null;
  private mcpConnection: McpConnection | null = null;
  private mcpInitialized = false;
  /** This turn's pruned subset (AGI blueprint #9) of the list above, or null to send them all. */
  private activeTools: any[] | null = null;

  constructor(
    private cfg: JarvisConfig,
    private host = "http://localhost:11434",
    private readonly limits: BrainExecutionLimits = {}
  ) {
    super();
    this.limits = {...limits, allowedTools: limits.allowedTools === undefined ? undefined : new Set(limits.allowedTools)};
    this.memory.configure(cfg.context);
    // A restricted agent (frontier/fleet.ts) is filtered here FIRST, before the
    // local-model curation above narrows further — see gemini.ts's constructor
    // for why this is a hard filter, not a hint.
    const allowed = this.limits.allowedTools;
    this.tools = toolsForLocalModel(
      (allowed ? TOOLS.filter((t) => toolGranted(allowed,t.name)) : TOOLS).map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: z.toJSONSchema(z.object(t.schema), { io: "input" }),
        },
      }))
    );
    // Start the outside servers now, not on the first turn — see gemini.ts's
    // constructor. This brain is the offline one, but "offline" is about where
    // the MODEL runs; a local model with no reach beyond the machine could not
    // read mail or search GitHub at all, which is the gap this closes.
    if (Object.keys(loadMcpConfig()).length) {
      this.mcpReady = connectMcpServers({allowedTools: this.limits.allowedTools}).catch((err) => {
        console.error("[ollama] MCP startup failed:", (err as any)?.message ?? err);
        return { tools: [], servers: [], close: async () => {} };
      });
    }
    const system = LOCAL_PERSONA;
    this.messages.push({ role: "system", content: system });
  }

  send(userText: string, _audio?: AudioTurn, opts?: SendOptions) {
    this.lastSend = opts ?? {};
    const reset = this.memory.begin(userText, opts);
    const contract = turnContract(opts);
    if (contract) userText = `${userText}\n\n${contract}`;
    // How the user is doing changes how a reply should read, and it changes
    // between turns — so it rides along with each message rather than being
    // baked into the system prompt at startup. Silent in the ordinary case: a
    // fresh state contributes nothing.
    //
    // This was wired into the Claude brain only, so the same person got a
    // different Echo depending on which model was answering — the exact drift
    // `buildSystemPrompt` exists to prevent.
    noteActivity();
    const style = styleFor(assess());
    if (style) userText = `${userText}\n\n[context: ${style}]`;

    // Never straight into a live history: mid-task it would land between an
    // assistant's tool calls and their results. See turn-queue.ts.
    if (this.busy) {
      this.queue.push(userText, reset);
      return;
    }
    if (reset) this.messages = this.messages.filter((m) => m.role === "system");
    this.messages.push({ role: "user", content: userText });
    void this.run();
  }

  /** Take in what was said while this loop was working. True if anything was. */
  private joinQueued(): boolean {
    const joined = this.queue.takeForRunningLoop();
    for (const text of joined) this.messages.push({ role: "user", content: text });
    return joined.length > 0;
  }

  /** After a stop, queued messages are the next request; after a failure, recovery carries them. */
  private drainQueue() {
    const next = this.queue.takeForNextLoop();
    if (!next.length) return;
    if (next.some((q) => q.reset) && this.aborted) this.messages = this.messages.filter((m) => m.role === "system");
    for (const q of next) this.messages.push({ role: "user", content: q.item });
    if (!this.aborted) {
      console.log(`[ollama] ${next.length} message(s) arrived as the task failed; kept for its recovery`);
      return;
    }
    next[0].resume(() => void this.run());
  }

  interrupt() {
    this.aborted = true;
    this.requestController?.abort();
    this.queue.clear();
    this.emitEvent("status", "idle");
  }

  /** The user cut the reply off: the history keeps what was heard, not what was written. */
  noteInterrupted(spoken: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "assistant" || typeof m.content !== "string") continue;
      m.content = `${spoken ? spoken + " " : ""}[interrupted by the user before finishing]`;
      return;
    }
  }

  async stop() {
    this.aborted = true;
    this.requestController?.abort();
    this.queue.clear();
    this.memory.close();
  }

  invalidateMemory(): void { this.memory.invalidate(); }

  private async chat(): Promise<any> {
    const controller = new AbortController();
    this.requestController = controller;
    try {
      // Ask the installed model rather than assuming it has the cloud window.
      if (!this.contextChecked) {
        this.contextChecked = true;
        try {
          const res = await fetch(`${this.host}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.cfg.ollama.model }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]) });
          if (res.ok) {
            const info = await res.json() as any;
            const capacity = Object.entries(info.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1];
            const configured = String(info.parameters ?? "").match(/(?:^|\n)num_ctx\s+(\d+)/)?.[1];
            const candidates = [Number(capacity), Number(configured)].filter(n => Number.isFinite(n) && n >= 2048);
            if (candidates.length) this.modelContextTokens = Math.min(...candidates);
          }
        } catch { /* server's error is reported by the actual chat request */ }
        this.modelContextTokens ??= this.cfg.context?.providerLimits?.[this.cfg.ollama.model] ?? this.cfg.context?.providerLimits?.ollama ?? 4096;
        this.modelContextTokens = localContextBudget(this.cfg, this.modelContextTokens);
        this.memory.configure({ ...this.cfg.context, providerLimits: { ...this.cfg.context?.providerLimits, ollama: Math.min(this.cfg.context?.providerLimits?.ollama ?? Infinity, this.modelContextTokens) } });
      }
      controller.signal.throwIfAborted();
      if (this.memory.takeInvalidation()) {
        this.messages = this.messages.filter((m) => m.role === "system");
        this.messages.push({ role: "user", content: "Continue from the current saved task state. Re-observe any evidence that was forgotten." });
      }
      const model = this.cfg.ollama?.model ?? "llama3.2:3b";
      const systemTokens = contextTokens(this.messages.filter(m => m.role === "system"));
      const latestUser = [...this.messages].reverse().find(m => m.role === "user")?.content ?? "";
      const tools = fitLocalTools(this.activeTools ?? this.tools, `${this.memory.query} ${latestUser}`,
        Math.max(0, this.memory.inputBudget(model) - systemTokens - 1800));
      const used = this.memory.prepareHistory(this.messages, tools, "", "ollama", model);
      const packet = this.memory.packet(used, true, model);
      const request = {
        model,
        messages: this.messages.map((m) => m.role === "system" ? { ...m, content: `${m.content}\n\n${packet}` } : m),
        tools,
        stream: true,
        keep_alive: "60s",
        options: { temperature: 0.4, num_ctx: localContextBudget(this.cfg, this.modelContextTokens), num_thread: 2 },
      };
      return await recordLLM(request, async () => {
        const res = await fetch(`${this.host}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
        });
        if (!res.ok || !res.body) throw new Error(`ollama ${res.status}: ${await res.text()}`);
        // NDJSON: one object per line, the reply growing a few tokens at a time.
        // Fragments are spoken as they come; the whole is reassembled into the
        // single-message shape the loop expects.
        const decoder = new TextDecoder();
        let buffered = "";
        let content = "";
        let toolCalls: any[] = [];
        let last: any = {};
        let streamed = false;
        const turnId = this.lastSend.turnId;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffered += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, nl).trim();
            buffered = buffered.slice(nl + 1);
            if (!line) continue;
            let obj: any;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }
            last = obj;
            const piece = obj.message?.content;
            if (typeof piece === "string" && piece) {
              content += piece;
              streamed = true;
              this.emitEvent("textDelta", { text: piece, turnId });
            }
            if (Array.isArray(obj.message?.tool_calls) && obj.message.tool_calls.length) toolCalls = toolCalls.concat(obj.message.tool_calls);
            if (this.aborted) break;
          }
        }
        if (streamed) this.emitEvent("textDone", { text: content, turnId });
        return { ...last, message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } };
      });
    } finally {
      if (this.requestController === controller) this.requestController = null;
    }
  }

  /**
   * Attach the configured MCP servers, once per session.
   *
   * Unlike the cloud brains, these tools are NOT exempt from pruning below.
   * There they are always sent, which is affordable because the model can
   * pick from hundreds; here the whole point of `toolsForLocalModel` is that
   * a small model cannot, so seventy Composio tools arriving unfiltered would
   * undo the curation rather than extend it. They join the pool and compete
   * on relevance like everything else.
   */
  private async initMcp() {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;
    if (!this.mcpReady) return;
    this.mcpConnection = await this.mcpReady;
    const allowed = this.limits.allowedTools;
    for (const tool of this.mcpConnection.tools) {
      if (allowed && !toolGranted(allowed,tool.name)) continue;
      this.mcpTools.set(tool.name, tool);
      this.tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      });
    }
    const failed = this.mcpConnection.servers.filter((x) => !x.ok);
    if (failed.length) console.error(`[ollama] MCP servers unavailable: ${failed.map((x) => x.name).join(", ")}`);
  }

  private async run() {
    // Busy before the first await, or a second message during MCP startup
    // starts a second loop on the same history.
    this.busy = true;
    try {
      await this.initMcp();
    } catch (err) {
      console.error("[ollama] MCP initialisation failed:", (err as any)?.message ?? err);
    }
    this.aborted = false;
    this.emitEvent("status", "thinking");
    let hadError = false;

    // Tool pruning (AGI blueprint #9), once per turn — see gemini.ts's runLoop
    // for the same pattern and why it must not change mid-turn. Narrows WITHIN
    // the already-curated local-model tool list, not the full registry: a
    // small model already struggles with the curated ~20; the point here is
    // to hand it fewer still, the ones this turn is actually about.
    if (this.cfg.agi?.toolPruning?.enabled) {
      const lastUser = [...this.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const keep = await selectToolNames(
        String(lastUser), Math.min(this.cfg.agi.toolPruning.topK, this.tools.length),
        undefined,
        this.tools.map((t: any) => ({ name: t.function?.name ?? t.name, description: t.function?.description ?? "" }))
      ).catch(() => null);
      this.activeTools = keep ? this.tools.filter((t: any) => keep.has(t.function?.name ?? t.name)) : null;
    } else {
      this.activeTools = null;
    }

    const log = currentLoop();
    const MAX_TURNS = this.limits.maxIterations ?? LOOP_CAPS.ollama.maxIterations;
    let exitReason: ExitReason | null = null;
    let exitDetail: string | undefined;
    let turn = 0;
    const stop = (reason: ExitReason, detail: string, spoken?: string) => {
      if (exitReason) return;
      exitReason = reason;
      exitDetail = detail;
      if (spoken) this.emitEvent("text", spoken);
    };

    try {
      for (; turn < MAX_TURNS; turn++) {
        if (this.aborted) {
          stop("abort_signal", `interrupted at turn ${turn}`);
          break;
        }
        // Anything said since the last step joins here, after the tool results.
        this.joinQueued();
        log?.iterationStart(turn, this.messages.length, approxTokens(this.messages));
        log?.enterState("awaiting_llm", `ollama:${this.cfg.ollama?.model ?? "llama3.2:3b"}`);
        const startedAt = Date.now();
        const data = await this.chat();
        const msg = data.message ?? {};
        this.messages.push(msg);

        let calls = msg.tool_calls ?? [];

        // Small models often write the call into the message body instead of
        // the structured field. Recover it rather than losing the request —
        // this is the difference between "turn on gestures" working and
        // silently doing nothing.
        if (!calls.length && msg.content?.trim()) {
          const recovered = parseCallsFromText(msg.content);
          if (recovered.length) {
            calls = recovered.map((c) => ({ function: { name: c.name, arguments: c.args } }));
            console.log(`[ollama] recovered ${calls.length} tool call(s) written as text`);
          }
        }

        log?.turnEnd({
          iteration: turn,
          provider: "ollama",
          model: String(this.cfg.ollama?.model ?? "llama3.2:3b"),
          finishReason: normalizeOllamaFinish(data.done_reason, calls.length > 0),
          rawFinishReason: data.done_reason ?? null,
          toolCallCount: calls.length,
          toolNames: calls.map((c: any) => String(c?.function?.name ?? "?")),
          promptTokens: data.prompt_eval_count ?? null,
          completionTokens: data.eval_count ?? null,
          totalContextTokens: null,
          latencyMs: Date.now() - startedAt,
          cacheHit: null,
        });

        // Only speak the content when it is prose, not a tool call it mislaid.
        if (msg.content?.trim() && !calls.length) this.emitEvent("text", msg.content.trim());

        if (!calls.length) {
          // Something new was said while this reply was written: answer it.
          if (!this.aborted && this.joinQueued()) continue;
          stop(
            msg.content?.trim() ? "completed" : "model_stop_no_tool_call",
            msg.content?.trim() ? "text-only reply" : "empty reply with no tool calls",
            msg.content?.trim() ? undefined : "My local model returned nothing that time, so I've stopped rather than guess."
          );
          break;
        }

        this.emitEvent("status", "acting");
        for (const call of calls) {
          if (this.aborted) {
            stop("abort_signal", `interrupted during tool calls at turn ${turn}`);
            break;
          }
          const called = call.function?.name;
          // "update_hand_gesture_params" is not a tool; "toggle_hand_gestures"
          // is. Small models guess names, and refusing outright would make the
          // local brain unusable when the intent was perfectly clear.
          const name = resolveToolName(called) ?? called;
          if (name !== called) console.log(`[ollama] "${called}" -> "${name}"`);
          const args = typeof call.function?.arguments === "string"
            ? safeParse(call.function.arguments)
            : (call.function?.arguments ?? {});
          // tool.start / tool.end come from runGated, which every brain shares.
          let result: string;
          try {
            result = await this.invokeTool(name, args);
          } catch (err: any) {
            result = `${name} failed: ${err?.message ?? err}`;
          }
          this.messages.push({ role: "tool", content: result });
        }
      }

      if (turn >= MAX_TURNS) {
        stop(
          "max_iterations",
          `hit the ${MAX_TURNS}-turn cap`,
          `I hit my ${MAX_TURNS}-step limit before finishing. I'm continuing from a fresh recovery checkpoint.`
        );
      }
    } catch (err: any) {
      if (this.aborted) {
        stop("abort_signal", `interrupted during local inference at turn ${turn}`);
        return;
      }
      const reason = classifyProviderError(err);
      stop(reason, String(err?.message ?? err));
      this.emitEvent("error", friendly(err));
      hadError = true;
      log?.exit(reason, { iteration: turn, error: err, messageCount: this.messages.length });
    } finally {
      this.busy = false;
      log?.exit(exitReason ?? "unknown_fallthrough", {
        iteration: turn,
        detail: exitDetail,
        messageCount: this.messages.length,
        approxTokensInContext: approxTokens(this.messages),
      });
      log?.enterState("idle");
      this.emitEvent("turnEnd");
      this.emitEvent("status", "idle");
      
      // Prevent infinite loops: if we failed, drop the offending user message so we don't retry it infinitely.
      if (hadError && this.messages[this.messages.length - 1]?.role === "user") {
        this.messages.pop();
      }
      this.drainQueue();
    }
  }

  /**
   * Same risk gate as the cloud brains — literally the same code now.
   *
   * This brain had its own correct copy of the classify-snapshot-confirm
   * sequence while Claude and Gemini had different, weaker ones. Three
   * implementations meant three chances to be wrong, and two of them were.
   */
  private async invokeTool(name: string, args: any): Promise<string> {
    // An outside tool is wrapped into the same shape and put through the same
    // gate — one shared adapter, so this brain cannot classify a Composio
    // delete differently from the way Gemini or OpenAI would.
    const handle = this.mcpTools.get(name);
    const def = handle ? mcpToolDef(handle) : TOOL_MAP.get(name);
    if (!def) return `No such tool: ${name}`;

    const out = await runGated(def, args ?? {}, {
      workingDir: this.cfg.control.workingDir,
      allowedTools: this.limits.allowedTools,
      emit: (e, p) => this.emitEvent(e as any, p),
    });
    // A local model can't see images; describe instead of returning pixels.
    return JSON.stringify(modelToolResult(out));
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    // Small models emit half-formed JSON constantly; this is the expected case,
    // not a fault, and the recovered-call path above already logs what it found.
    console.warn(`[ollama] unparseable tool arguments, treating as empty: ${s.slice(0, 120)}`);
    return {};
  }
}

function friendly(err: any): string {
  const msg = String(err?.message ?? err);
  if (/ECONNREFUSED|fetch failed|11434/.test(msg)) {
    return "My offline brain isn't running. Start it with `brew services start ollama`.";
  }
  if (/not found|no such model/i.test(msg)) {
    return "That local model isn't installed. Pull it with `ollama pull`.";
  }
  return msg;
}
