import {toolGranted} from '../safety/tool-permissions.js';
import {codingRequestToolAllowed} from '../coding/tool-selection.js';
import {codingContinuationEligible, codingActionRequest, CODING_ACTION_TOOLS} from '../coding/continuation.js';
import { FunctionCallingConfigMode, GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import {
  AUDIO_TURN_GUIDANCE,
  Brain,
  GEMINI_MODEL_FALLBACKS,
  JARVIS_PERSONA,
  LOOP_CAPS,
  buildSystemPrompt,
  VOICE_TURN_CONTRACT,
} from "./types.js";
import type { AudioTurn, BrainExecutionLimits, SendOptions } from "./types.js";
import { stripAudioParts, toInlineDataPart } from "../voice/audio-turn.js";
import { TOOLS, ToolDef } from "../tools/registry.js";
import { selectToolNames } from "./tool-router.js";
import { INTERNAL_TOOLS } from '../memory/read-cache.js';
import { modelToolResult } from "../memory/tool-context.js";
import { ExternalToolCatalog } from "./external-tool-catalog.js";
import { currentAgentRunContext } from "../agent-replay/context.js";
import { runGated } from "../safety/gate.js";
import { trimGeminiHistory } from "./history.js";
import { modelHealth } from "./model-health.js";
import { recordLLM, approxTokens } from "../agent-replay/runtime.js";
import { assess, styleFor, noteActivity } from "../frontier/struggle.js";
import { resolveToolName } from "./localtools.js";
import { currentLoop, normalizeGeminiFinish, classifyProviderError } from "../agent-replay/loop-log.js";
import type { ExitReason } from "../agent-replay/recorder.js";
import type { JarvisConfig } from "../config.js";
import { connectMcpServers, loadMcpConfig, mcpToolDef, type McpConnection, type McpToolHandle } from "./mcp.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";
import {streamStep,streamSilenceMs} from './stream-deadline.js';
import { TurnQueue } from "./turn-queue.js";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const JSON_TYPE_TO_GOOGLE: Record<string, any> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

/**
 * Translate a JSON Schema node into Google's function-declaration schema.
 *
 * We go through JSON Schema rather than reading Zod's internals: those are
 * private and did change shape between Zod 3 and 4, which silently broke this
 * conversion. `z.toJSONSchema()` is the supported route.
 */
function jsonSchemaToGoogle(node: any): any {
  if (!node || typeof node !== "object") return { type: Type.STRING };

  // Optional/nullable fields arrive as a union — take the first real branch.
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length) {
    const pick = variants.find((v: any) => v?.type !== "null") ?? variants[0];
    return jsonSchemaToGoogle(pick);
  }

  const out: any = {};
  if (node.description) out.description = node.description;

  const jsonType = Array.isArray(node.type)
    ? node.type.find((t: any) => t !== "null")
    : node.type;
  out.type = JSON_TYPE_TO_GOOGLE[jsonType] ?? Type.STRING;

  if (Array.isArray(node.enum)) {
    out.type = Type.STRING;
    out.enum = node.enum.map(String);
  }
  if (jsonType === "array") {
    out.items = jsonSchemaToGoogle(node.items ?? {});
  }
  if (jsonType === "object") {
    out.properties = Object.fromEntries(
      Object.entries(node.properties ?? {}).map(([k, v]) => [k, jsonSchemaToGoogle(v)])
    );
    if (node.required?.length) out.required = node.required;
  }
  return out;
}

/** Exported so the realtime voice session declares tools the same way — one
 *  copy of this conversion, not two that drift. */
export function toFunctionDeclaration(t: ToolDef) {
  // io: "input" — a field with a default is optional for the *caller*.
  const json: any = z.toJSONSchema(z.object(t.schema), { io: "input" });
  const converted = jsonSchemaToGoogle(json);
  return {
    name: t.name,
    description: t.description,
    parameters: {
      type: Type.OBJECT,
      properties: converted.properties ?? {},
      required: converted.required ?? [],
    },
  };
}

/**
 * Why a Gemini failure is worth another model from the fallback ladder, or
 * `null` when it is not.
 *
 * Exported and used twice on purpose: by the catch that actually performs the
 * fallback, and by the `willRetry` predicate handed to `recordLLM`. Two copies
 * of this expression would drift, and the whole point of recording the decision
 * is that the tape agrees with what the loop did.
 */
export function geminiFallbackReason(
  error: unknown
): "quota" | "not found" | "temporarily overloaded" | "stalled" | null {
  const text = String((error as any)?.message ?? error ?? "");
  if ((error as any)?.code==='ECHO_STREAM_STALLED' || /model request timed out|Model stream made no progress/.test(text)) return 'stalled';
  if (text.includes("429") || text.includes("Quota exceeded") || text.includes("RESOURCE_EXHAUSTED")) return "quota";
  if (text.includes("404") || text.includes("NOT_FOUND") || text.includes("no longer available")) return "not found";
  // A 503/UNAVAILABLE is normally a short-lived capacity spike. Move to the next
  // fast model so a spoken command remains responsive.
  if (text.includes("503") || text.includes("UNAVAILABLE") || text.includes("high demand")) return "temporarily overloaded";
  return null;
}

/**
 * How much of one tool result is allowed back into the conversation.
 *
 * The whole history is re-sent on every iteration, so an un-capped result is
 * not paid for once — it is paid for again on every remaining step of the task.
 * One read of something large could therefore end a run by itself, and
 * `context_overflow` would name the symptom rather than the cause.
 *
 * Head and tail rather than a plain truncation: the beginning says what the
 * thing is, and the end is usually where the error or the total lives.
 */
const TOOL_RESULT_BUDGET = 12_000;

function withinBudget(text: string): string {
  if (typeof text !== "string" || text.length <= TOOL_RESULT_BUDGET) return text;
  const head = text.slice(0, Math.floor(TOOL_RESULT_BUDGET * 0.7));
  const tail = text.slice(-Math.floor(TOOL_RESULT_BUDGET * 0.25));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n[... ${dropped.toLocaleString()} characters withheld to protect the context window. ` +
    `Narrow the request — a filter, a range, or a more specific query — if you need what is missing ...]\n\n${tail}`;
}

/**
 * What to say when the model calls a tool that does not exist.
 *
 * "unknown tool" is a dead end: it names no alternative, so the model either
 * repeats the same call or abandons the step. Naming the near misses turns a
 * wasted iteration into a corrected one.
 */
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
    ? `There is no tool called "${called}". The closest tools that do exist are: ${scored.join(", ")}. ` +
      `Call one of those, or a different tool entirely — do not call "${called}" again.`
    : `There is no tool called "${called}", and nothing close to it exists. ` +
      `Choose a different tool from the ones you were given, or answer without one.`;
}

export class GeminiBrain extends Brain {
  private ai: GoogleGenAI;
  private contents: any[] = [];
  private functionDeclarations: any[];
  /** This turn's pruned subset (AGI blueprint #9), or null to send them all. Recomputed once per runLoop(). */
  private activeFunctionDeclarations: any[] | null = null;
  private busy = false;
  private aborted = false;
  private mcpInitialized = false;
  private mcpTools: Map<string, McpToolHandle> = new Map();
  /** A recording is sitting in the history, waiting to be heard exactly once. */
  private audioPending = false;
  /** How the current turn arrived; shapes the reply for the ear when spoken. */
  private lastSend: SendOptions = {};
  /** MCP servers, connected during startup rather than on the first turn. */
  private mcpReady: Promise<McpConnection> | null = null;
  private mcpConnection: McpConnection | null = null;
  private memory = new ProviderMemoryContext("gemini");
  /** Messages that arrived while the loop was running — see turn-queue.ts. */
  private queue = new TurnQueue<{ parts: any[]; audio: boolean }>();

  /**
   * Built once per session, not per request: it is re-sent on every one of up to
   * 150 iterations, and re-reading the memory files that often would be pure
   * disk churn for a value that does not change mid-task.
   */
  private systemPrompt = JARVIS_PERSONA;
  private externalCatalog: ExternalToolCatalog | null = null;

  constructor(private cfg: JarvisConfig, apiKey: string, private readonly limits: BrainExecutionLimits = {}) {
    super();
    this.limits = {...limits, allowedTools: limits.allowedTools === undefined ? undefined : new Set(limits.allowedTools)};
    this.ai = new GoogleGenAI({ apiKey });
    this.memory.configure(cfg.context);
    // A restricted agent (a custom fleet member — see frontier/fleet.ts) never
    // sees a tool outside its allowlist in the first place; per-turn pruning
    // (tool-router.ts) only ever narrows further within this.
    const allowed = this.limits.allowedTools;
    this.functionDeclarations = (allowed ? TOOLS.filter((t) => toolGranted(allowed,t.name)) : TOOLS).map(toFunctionDeclaration);
    // The listening instructions are only true when audio is actually attached,
    // so they are only in the prompt when it is.
    this.systemPrompt = buildSystemPrompt(
      undefined,
      cfg.voice?.sendAudioToBrain ? AUDIO_TURN_GUIDANCE : undefined,
      false
    );

    // Start the MCP servers NOW rather than on the first turn. Measured: uvx
    // takes ~16s to bring the Sarvam server up because it re-resolves the
    // package against pypi every time. Paid here it overlaps with the app
    // finishing its own startup and with the user deciding what to say; paid on
    // the first turn it is sixteen seconds of an assistant appearing to ignore
    // someone. Nothing awaits this until initMcp does.
    if (Object.keys(loadMcpConfig()).length) {
      this.mcpReady = connectMcpServers({allowedTools: this.limits.allowedTools}).catch((err) => {
        console.error("[gemini] MCP startup failed:", (err as any)?.message ?? err);
        return { tools: [], servers: [], close: async () => {} };
      });
    }
  }

  /**
   * Attach whatever MCP servers are configured, once per session.
   *
   * The connecting, deadlining and naming all live in brain/mcp.ts now, so a
   * server that is missing or hung costs its own tools and nothing else. This
   * is only responsible for turning what came back into Gemini declarations.
   *
   * Note it is awaited at the top of the agent loop: before the deadline
   * existed, a server that spawned but never answered held the FIRST request of
   * every turn open indefinitely, which looked exactly like the brain ignoring
   * the user.
   */
  private async initMcp() {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;
    // Await the connection started in the constructor. Connecting again here
    // would close those servers and spawn a second set.
    this.mcpConnection = await (this.mcpReady ?? connectMcpServers({allowedTools: this.limits.allowedTools}));
    const { tools, servers } = this.mcpConnection;
    for (const tool of tools) {
      if (this.limits.allowedTools && !toolGranted(this.limits.allowedTools,tool.name)) continue;
      const schema = jsonSchemaToGoogle(tool.inputSchema);
      this.functionDeclarations.push({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: Type.OBJECT,
          properties: schema.properties ?? {},
          required: schema.required ?? [],
        },
      });
      this.mcpTools.set(tool.name, tool);
    }
    const failed = servers.filter((s) => !s.ok);
    if (failed.length) {
      // Said once, out loud in the log, rather than buried: a tool the user
      // asked for by name that simply is not there is worth knowing about.
      console.error(`[gemini] MCP servers unavailable: ${failed.map((s) => s.name).join(", ")}`);
    }
  }

  /**
   * Whether Echo is configured to let this brain hear the turn.
   *
   * Every Gemini model in the fallback list accepts audio, so the only question
   * is whether the user asked for it — sending the recording of everything
   * spoken in the room to a cloud model is a decision, not a detail.
   */
  get hearsAudio(): boolean {
    return this.cfg.voice?.sendAudioToBrain === true;
  }

  send(userText: string, audio?: AudioTurn, opts?: SendOptions) {
    this.lastSend = opts ?? {};
    const reset = this.memory.begin(userText, opts);
    // A spoken turn gets the per-turn reminder that it will be read aloud.
    if (opts?.modality === "voice") userText = `${userText}\n\n${VOICE_TURN_CONTRACT}`;
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

    // Audio first, transcript second: the model reads the parts in order, and
    // this is the order that says "here is what was said, and here is a guess
    // at it" rather than the reverse.
    const parts: any[] = [];
    let heard = false;
    if (audio && this.hearsAudio) {
      const part = toInlineDataPart(audio);
      if (part) {
        parts.push(part);
        heard = true;
      }
    }
    parts.push({ text: userText });
    // Never straight into a live history: mid-task that lands between a tool
    // call and its result, which Gemini rejects. The loop takes it in at its
    // next step, or a fresh loop does once this one has stopped.
    if (this.busy) {
      this.queue.push({ parts, audio: heard }, reset);
      return;
    }
    if (reset) this.contents = [];
    this.appendUser(parts, heard);
    void this.runLoop();
  }

  /**
   * Add a user message, folding it into the last user turn when there is one.
   *
   * After a tool round the last turn is the user turn carrying the function
   * responses, and a message added there keeps each response directly after
   * its call — the same way screenshots already ride along with them.
   */
  private appendUser(parts: any[], heard: boolean) {
    const last = this.contents[this.contents.length - 1];
    if (last?.role === "user") last.parts = [...(last.parts ?? []), ...parts];
    else this.contents.push({ role: "user", parts });
    if (heard) this.audioPending = true;
  }

  /** Take in what was said while this loop was working. True if anything was. */
  private joinQueued(): boolean {
    const joined = this.queue.takeForRunningLoop();
    for (const q of joined) this.appendUser(q.parts, q.audio);
    return joined.length > 0;
  }

  /**
   * Forget the recording once it has been heard.
   *
   * One spoken command can drive a hundred iterations of the agent loop, every
   * one of which re-sends the whole history. The audio is only evidence for the
   * first reply; after that it is a quarter-megabyte re-uploaded per step, and
   * a token estimate that makes the history limiter trim real conversation to
   * make room for bytes nobody is listening to any more.
   */
  private forgetAudio() {
    if (!this.audioPending) return;
    this.audioPending = false;
    const dropped = stripAudioParts(this.contents);
    if (dropped) console.log(`[gemini] heard the turn; dropped ${dropped} recording(s) from history`);
  }

  /** Aborts the request in flight on a hard stop (never on a barge-in). */
  private turnAbort: AbortController | null = null;

  /**
   * One model call, streamed. Text fragments go out as `textDelta` the moment
   * they arrive — that is what lets the voice start on the first sentence
   * while the model writes the second — and the whole response is assembled
   * into the same shape `generateContent` returns, so the loop below, the
   * replay recorder and the history are none the wiser.
   */
  private async generateStreaming(request: any): Promise<any> {
    const parent = this.turnAbort?.signal;
    const requestAbort = new AbortController();
    const signal = parent ? AbortSignal.any([parent,requestAbort.signal]) : requestAbort.signal;
    const hardLimit=Number(process.env.ECHO_LLM_TIMEOUT_MS??120000);
    const overallMs=hardLimit>0?Math.max(1,hardLimit-1000):0;
    const overallTimer=overallMs?setTimeout(()=>requestAbort.abort(new Error(`model request timed out after ${overallMs}ms`)),overallMs):undefined;
    const turnId = this.lastSend.turnId;
    try {
    const stream = await streamStep(()=>this.ai.models.generateContentStream({
      ...request,
      config: { ...request.config, abortSignal: signal },
    }),requestAbort,streamSilenceMs(),parent);
    let text = "";
    const otherParts: any[] = [];
    let last: any = null;
    let streamedText = false;
    const iterator=(stream as AsyncIterable<any>)[Symbol.asyncIterator]();
    while(true) {
      const step=await streamStep(()=>iterator.next(),requestAbort,streamSilenceMs(),parent);
      if(step.done)break;
      const chunk=step.value;
      last = chunk;
      const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === "string" && p.text) {
          if (p.thought) continue; // the model thinking aloud is not the reply
          text += p.text;
          streamedText = true;
          this.emitEvent("textDelta", { text: p.text, turnId });
        } else if (p.functionCall || p.inlineData || p.executableCode || p.codeExecutionResult) {
          otherParts.push(p);
        }
      }
      if (signal?.aborted) break;
    }
    if (streamedText) this.emitEvent("textDone", { text, turnId });
    const cand = last?.candidates?.[0] ?? {};
    const merged = [...(text ? [{ text }] : []), ...otherParts];
    // A candidate with no content at all — blocked by a safety filter, cut
    // off at the token limit with nothing produced yet, a recitation halt —
    // is exactly the case runLoop's `if (!content)` exists to catch and name
    // out loud (see its own comment: "the reason was sitting on the response
    // the whole time and was never read"). Synthesizing a content object here
    // unconditionally, even when nothing was ever streamed, would make every
    // one of those candidates look like an ordinary empty-but-present reply
    // and silently defeat that check — reintroducing the exact silent stop
    // the non-streaming path was fixed to catch.
    const content = merged.length ? { role: cand?.content?.role ?? "model", parts: merged } : undefined;
    return {
      ...last,
      candidates: [{ ...cand, content }],
    };
    } finally {if(overallTimer)clearTimeout(overallTimer);requestAbort.abort();}
  }

  /**
   * The user cut the reply off. The model must not believe it said the whole
   * thing: its last message becomes what was actually heard.
   */
  noteInterrupted(spoken: string): void {
    for (let i = this.contents.length - 1; i >= 0; i--) {
      const c = this.contents[i];
      if (c.role !== "model") continue;
      const textPart = (c.parts ?? []).find((p: any) => typeof p.text === "string");
      if (!textPart) return;
      textPart.text = `${spoken ? spoken + " " : ""}[interrupted by the user before finishing]`;
      return;
    }
  }

  private async runLoop() {
    // Busy BEFORE the first await. Set after it, a second message sent while
    // the MCP servers were still connecting started a second loop on the same
    // history.
    this.busy = true;
    try {
      await this.initMcp();
    } catch (err) {
      console.error("[gemini] MCP initialisation failed:", (err as any)?.message ?? err);
    }
    this.aborted = false;
    this.turnAbort = new AbortController();
    this.emitEvent("status", "thinking");
    this.externalCatalog = new ExternalToolCatalog([...this.mcpTools.values()]);
    const run = currentAgentRunContext(); if (run) run.toolCatalog = this.externalCatalog;
    await this.externalCatalog.begin(this.memory.query);

    // Tool pruning (AGI blueprint #9): computed once per turn, from the text
    // that started it, and held for every iteration of the loop below — a
    // tool that gets pruned out mid-turn because the model wrote a tool-result
    // message would look like the tool vanished. `null` (pruning off,
    // unavailable, or not trusted) means "send everything", today's behaviour.
    if (this.cfg.agi?.toolPruning?.enabled) {
      const lastUserText = [...this.contents].reverse().find((c) => c.role === "user")
        ?.parts?.find((p: any) => typeof p.text === "string")?.text ?? "";
      const keep = await selectToolNames(lastUserText, this.cfg.agi.toolPruning.topK).catch(() => null);
      this.activeFunctionDeclarations = keep
        ? this.functionDeclarations.filter((d: any) => keep.has(d.name) || this.mcpTools.has(d.name))
        : null;
    } else {
      this.activeFunctionDeclarations = null;
    }

    const log = currentLoop();
    let exitReason: ExitReason | null = null;
    let exitDetail: string | undefined;
    let iteration = 0;
    let lastFinish: unknown = null;

    /**
     * End the loop, on the record, and say so out loud.
     *
     * The silent-stop bug was never one bug: it was five different exits that
     * all looked like "finished" because none of them said anything. Anything
     * that is not an ordinary completion now gets a spoken sentence, so the
     * failure mode is at worst a wrong explanation rather than no explanation.
     */
    const stop = (reason: ExitReason, detail: string, spoken?: string) => {
      if (exitReason) return;
      exitReason = reason;
      exitDetail = detail;
      if (spoken) this.emitEvent("text", spoken);
    };

    try {
      // Shared with the hearing pass — see GEMINI_MODEL_FALLBACKS — minus the
      // models this key has already been told it cannot use. Without that
      // filter every exhausted turn re-ran the whole ladder: four 404s for
      // models retired weeks ago, then the same 429 as last turn.
      const FALLBACK_MODELS = modelHealth.ladder([this.cfg.gemini.model, ...GEMINI_MODEL_FALLBACKS]);
      if (!FALLBACK_MODELS.length) {
        throw new Error(
          `No Gemini model is usable right now — ${modelHealth.explain([this.cfg.gemini.model, ...GEMINI_MODEL_FALLBACKS])}. ` +
          `Switch brains (Claude or the local model) or add quota.`
        );
      }

      // Gemini flash likes to stop mid-task with a text-only "next I will…"
      // rather than continuing to call tools. These bound an automatic nudge so
      // the user doesn't have to keep saying "finish it".
      let autoContinues = 0;
      let successfulModelIndex = 0;
      let didAnyToolCall = false;
      const MAX_ITERATIONS = this.limits.maxIterations ?? LOOP_CAPS.gemini.maxIterations;
      const AUTO_CONTINUE_LIMIT = LOOP_CAPS.gemini.autoContinueLimit;

      // The cap and the abort flag used to share one `for` condition, so the two
      // were indistinguishable afterwards — and both were silent. Split so each
      // can name itself.
      let i = 0;
      for (; i < MAX_ITERATIONS; i++) {
        if (this.aborted) {
          stop("abort_signal", `interrupted at iteration ${i}`);
          break;
        }
        // Anything said since the last step joins the conversation here, at
        // a boundary, rather than wherever it happened to arrive.
        this.joinQueued();
        iteration = i;
        log?.iterationStart(i, this.contents.length, approxTokens(this.contents));

        let res;
        let attempt = successfulModelIndex;
        let turnStartedAt = Date.now();
        let currentModel = FALLBACK_MODELS[attempt];
        
        // Auto-fallback logic for quota exhaustion
        while (attempt < FALLBACK_MODELS.length) {
          try {
            if (this.memory.takeInvalidation()) {
              this.contents = [{ role: "user", parts: [{ text: "Continue from the saved task state. Forgotten evidence is unavailable; re-observe if needed." }] }];
            }
            const declarations = (this.activeFunctionDeclarations ?? this.functionDeclarations)
              .filter((tool: any) => (!this.cfg.agi?.toolPruning?.enabled || !this.memory.isCodingTurn() || codingRequestToolAllowed(tool.name)) && (!this.mcpTools.has(tool.name) || this.externalCatalog?.selected.has(tool.name)));
            const used = this.memory.prepareHistory(this.contents, declarations, this.systemPrompt, "gemini", currentModel);
            // Until a coding turn has done something, a text-only reply is not
            // allowed: Flash-Lite answered "I'm building it now" five turns in
            // a row and never called a tool. Forced only for an instruction (or
            // after a nudge), so "Can you build an app?" still gets an answer.
            const forced = !didAnyToolCall && this.memory.isCodingTurn() && (autoContinues > 0 || codingActionRequest(this.memory.query))
              ? declarations.map((tool: any) => tool.name).filter((name: string) => CODING_ACTION_TOOLS.has(name))
              : [];
            const request = {
              model: currentModel,
              contents: this.contents,
              config: {
                systemInstruction: `${this.systemPrompt}\n\n${this.memory.packet(used, true, currentModel)}`,
                tools: [{ functionDeclarations: declarations }],
                ...(forced.length ? { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: forced } } } : {}),
              },
            };
            log?.enterState("awaiting_llm", `gemini:${currentModel}`);
            log?.setModel(currentModel);
            turnStartedAt = Date.now();
            res = await recordLLM(
              request,
              () => this.generateStreaming(request),
              attempt,
              // Asked the moment the failure surfaces, before the catch below
              // runs, so `attempt` still holds the value that catch is about to
              // increment and test against the ladder's length.
              {
                willRetry: (error) =>
                  geminiFallbackReason(error) !== null && attempt + 1 < FALLBACK_MODELS.length,
              }
            );
            // If it succeeded, persist the successful model for the next turn
            this.cfg.gemini.model = currentModel;
            successfulModelIndex = attempt;
            break;
          } catch (err: any) {
            const errStr = String(err?.message ?? err);
            // The same expression the willRetry predicate above uses, so the
            // tape's retry decision cannot drift from the retry itself.
            const reason = geminiFallbackReason(err);

            if (reason) {
              // Remember it, so the next turn does not pay for this discovery
              // again. A 404 means this key has lost the model for good; a 429
              // means its quota window has to pass first.
              if (reason === "not found") modelHealth.markDead(currentModel, errStr);
              else if (reason === "quota") modelHealth.markExhausted(currentModel, errStr);
              else modelHealth.markUnavailable(currentModel,reason);

              const from = currentModel;
              attempt++;
              // Straight down the ladder. It used to wrap back to the first
              // model when it ran off the end, so the last thing a doomed turn
              // did was re-ask the model that had already failed it.
              const next = FALLBACK_MODELS[attempt];
              console.warn(`[gemini] ${from} failed (${reason})${next ? `; trying ${next}` : ""}`);
              log?.note("llm.model_fallback", { from, to: next ?? null, reason, attempt });
              this.emitEvent('progress',`The model ${reason==='stalled'?'stopped responding':'is unavailable'}. ${next?'Trying another model; saved work is preserved.':'No fallback is available; the task is not finished.'}`);
              if (!next) {
                throw new Error(
                  `Gemini has no model left to try (${FALLBACK_MODELS.join(", ")}). Last error: ${errStr}`
                );
              }
              currentModel = next;
            } else {
              throw err; // Bubble up other errors immediately
            }
          }
        }

        if (!res) throw new Error("No response generated from any model.");

        // The model has now heard the recording. Everything after this point in
        // the task is conditioned on its own first reply, so the audio comes out
        // of the history rather than riding along for another 149 iterations.
        this.forgetAudio();

        const candidate = (res as any).candidates?.[0];
        const rawFinish = candidate?.finishReason;
        const blockReason = (res as any).promptFeedback?.blockReason;
        lastFinish = rawFinish ?? blockReason ?? null;
        const usage = (res as any).usageMetadata ?? {};
        const content = candidate?.content;

        const parts = content?.parts ?? [];
        const calls = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);

        log?.turnEnd({
          iteration: i,
          provider: "gemini",
          model: currentModel,
          finishReason: normalizeGeminiFinish(rawFinish ?? blockReason),
          rawFinishReason: rawFinish ?? blockReason ?? null,
          toolCallCount: calls.length,
          toolNames: calls.map((c: any) => String(c?.name ?? "?")),
          promptTokens: usage.promptTokenCount ?? null,
          completionTokens: usage.candidatesTokenCount ?? null,
          totalContextTokens: usage.totalTokenCount ?? null,
          latencyMs: Date.now() - turnStartedAt,
          cacheHit: usage.cachedContentTokenCount ? true : null,
        });

        // THE silent stop. A candidate with no content means the model produced
        // nothing usable — blocked by a safety filter, cut off at the token
        // limit, or a recitation halt. The reason was sitting on the response
        // the whole time and was never read, so the loop simply broke and the
        // turn reported success. Now it is named, and said out loud.
        if (!content) {
          const why = String(rawFinish ?? blockReason ?? "no reason given");
          const finish = normalizeGeminiFinish(rawFinish ?? blockReason);
          const reason: ExitReason =
            finish === "length" ? "context_overflow"
              : finish === "content_filter" ? "provider_error"
                : "model_stop_no_tool_call";
          const spoken =
            finish === "length"
              ? "I ran out of context before finishing. I'm restarting from my checkpoint and continuing."
              : finish === "content_filter"
                ? `The model blocked that step (${why}), so I've stopped partway through.`
                : `The model returned nothing for that step (${why}). I've stopped rather than pretend I finished.`;
          stop(reason, `empty candidate content, finishReason=${why}`, spoken);
          break;
        }

        this.contents.push({ role: content.role || "model", parts: content.parts || [] });

        for (const p of parts) {
          if (p.text?.trim()) this.emitEvent("text", p.text.trim());
        }

        if (!calls.length) {
          // The user said something while this reply was being written. That
          // is the next thing to answer, not a reason to end the turn.
          if (!this.aborted && this.joinQueued()) continue;
          // A text-only reply normally ends the turn. But if Gemini has been
          // acting and this reply clearly means to keep going ("next I'll…",
          // "shall I continue?") rather than reporting completion, nudge it on
          // automatically instead of dumping the job back on the user.
          const said = parts.map((p: any) => p.text || "").join(" ").trim();
          const meansToContinue =
            /\b(next|then|now (?:i|installing|assembling|implementing|building|testing)|after that|let me|i['’]?ll|i will|i['’]?m (?:continuing|building|implementing)|continu(?:e|ing)|proceed|moving on|going to|start(ing)? (with|by))\b/i.test(said) &&
            !/\b(done|finished|complete|all set|here'?s the|the result|in summary|to summari[sz]e|anything else)\b/i.test(said);
          const asksToContinue = /\b(shall i|should i|do you want me to|would you like me to)\b/i.test(said);
          // With no tool run yet, eligibility already means the reply promised
          // work ("I'm building it now") that nothing has started.
          if (codingContinuationEligible(didAnyToolCall,this.memory.isCodingTurn(),said) && (meansToContinue || asksToContinue || !didAnyToolCall) && autoContinues < AUTO_CONTINUE_LIMIT) {
            autoContinues++;
            log?.note("loop.auto_continue", { n: autoContinues, limit: AUTO_CONTINUE_LIMIT });
            this.contents.push({
              role: "user",
              parts: [{ text: "Take the next concrete step now; a progress sentence alone does not finish the task. For a large coding build, open/inspect the saved project, save milestones and start_project_build so the foreground remains available. Continue using tools until checks and acceptance evidence pass. If a genuinely blocking requirement is missing, save it with ask_build_question and wait for the answer." }],
            });
            continue;
          }

          // The nudge budget is spent but the model still sounds mid-task. It
          // used to fall through this same `break` as a finished turn.
          if (codingContinuationEligible(didAnyToolCall,this.memory.isCodingTurn(),said) && (meansToContinue || asksToContinue || !didAnyToolCall)) {
            stop(
              "model_stop_no_tool_call",
              `auto-continue limit ${AUTO_CONTINUE_LIMIT} reached while still mid-task`,
              `I've used ${AUTO_CONTINUE_LIMIT} in-context continuations without finishing. I'm restarting from my durable checkpoint and continuing.`
            );
            break;
          }

          // A genuine end of turn: the model answered and wanted nothing more.
          stop("completed", "text-only reply with no tool calls");
          break;
        }

        this.emitEvent("status", "acting");
        didAnyToolCall = true;
        const responseParts: any[] = [];
        /**
         * Run one tool call and return the parts it contributes to the reply.
         *
         * Pulled out of the loop so independent calls can be run together. The
         * parts are returned rather than appended, because the reply has to stay
         * in the model's own call order however the work was scheduled.
         */
        const runOneCall = async (call: any): Promise<any[]> => {
          const parts: any[] = [];
          let tool = TOOLS.find((t) => t.name === call.name);
          const mcpInfo = this.mcpTools.get(call.name);

          // A name close enough to be unambiguous is worth honouring rather than
          // bouncing: the model meant a real tool and spelled it its own way.
          // Echo already knew how to do this — it was only wired to Ollama.
          if (!tool && !mcpInfo) {
            const resolved = resolveToolName(call.name);
            if (resolved) {
              tool = TOOLS.find((t) => t.name === resolved);
              if (tool) log?.note("tool.name_resolved", { called: call.name, ran: resolved });
            }
          }

          if (!tool && !mcpInfo) {
            const advice = unknownToolAdvice(call.name, TOOLS.map((t) => t.name).concat([...this.mcpTools.keys()]));
            log?.note("tool.unknown", { called: call.name });
            this.emitEvent("tool", { name: call.name, summary: call.name });
            return [{ functionResponse: { name: call.name, response: { error: advice } } }];
          }

          try {
            if (mcpInfo) {
              // No "tool" event here: runGated emits one for every tool it runs,
              // so announcing it first reported each MCP call TWICE in the HUD
              // and the phone feed — and with the raw mcp__server__name at that,
              // where the gate's version reads "sarvam_tools_translate".
              // One shared adapter (brain/mcp.ts) so every brain gates an outside
              // tool identically — these copies had already drifted apart.
              const def = mcpToolDef(mcpInfo);
              const out = await runGated(def, call.args ?? {}, {
                workingDir: this.cfg.control.workingDir,
                allowedTools: this.limits.allowedTools,
                emit: (e, p) => this.emitEvent(e as any, p),
              });
              parts.push({
                functionResponse: { name: call.name, response: modelToolResult(out) },
              });
            } else if (tool) {
              // Through the shared gate, exactly as the other brains are.
              const out = await runGated(tool, call.args ?? {}, {
                workingDir: this.cfg.control.workingDir,
                allowedTools: this.limits.allowedTools,
                emit: (e, p) => this.emitEvent(e as any, p),
              });
              parts.push({
                functionResponse: { name: call.name, response: modelToolResult(out) },
              });
              if (out.image) {
                parts.push({
                  inlineData: { mimeType: out.image.mimeType, data: out.image.data },
                });
              }
            }
          } catch (err: any) {
            // tool.start / tool.end come from runGated, the one path every brain
            // shares; this only records what the model is told.
            parts.push({
              functionResponse: { name: call.name, response: { error: String(err?.message ?? err) } },
            });
          }
          return parts;
        };

        /**
         * Gemini can ask for several tools in one turn, and they were executed
         * strictly one after another — so four independent observations cost four
         * round trips of latency for no reason.
         *
         * Only the LEADING run of read-only calls is batched. A call that changes
         * the machine runs alone, and nothing after it is hoisted ahead of it,
         * because a write can change what a later read would have seen. Read-only
         * is the tool's own declaration, and observations no longer take an
         * exclusive lease on the pointer, so a batch cannot contend with itself.
         */
        const isObservation = (call: any): boolean => {
          const handle = this.mcpTools.get(call.name);
          if (handle) return mcpToolDef(handle).readOnly;
          const named = TOOLS.find((t) => t.name === call.name)
            ?? TOOLS.find((t) => t.name === resolveToolName(call.name));
          return Boolean(named?.readOnly) && !INTERNAL_TOOLS.has(named!.name);
        };
        let batched = 0;
        while (batched < calls.length && isObservation(calls[batched])) batched++;

        if (batched > 1) {
          log?.note("tool.parallel_batch", { count: batched, names: calls.slice(0, batched).map((c: any) => String(c?.name ?? "?")) });
          for (let start = 0; start < batched; start += 3) {
            const settled = await Promise.all(calls.slice(start, Math.min(start + 3, batched)).map((call: any) => runOneCall(call)));
            for (const parts of settled) responseParts.push(...parts);
          }
        } else {
          batched = 0;
        }
        for (const call of calls.slice(batched)) {
          responseParts.push(...(await runOneCall(call)));
        }
        log?.enterState("reflecting", "trimming history");
        this.contents.push({ role: "user", parts: responseParts });

        // Free the bytes of older screenshots before the next request. Without
        // this the conversation grows by 1-3 MB per screenshot and is re-sent
        // whole on every step — which is what drove this machine into swap.
        const freed = trimGeminiHistory(this.contents);
        if (freed > 1_000_000) {
          console.log(`[gemini] released ${(freed / 1_048_576).toFixed(1)} MB of old screenshots from context`);
        }
      }

      // Ran the cap out. Previously this fell straight into `finally`, which
      // emitted turnEnd — a long task that hit 150 steps was indistinguishable
      // from one that finished in three.
      if (i >= MAX_ITERATIONS) {
        stop(
          "max_iterations",
          `hit the ${MAX_ITERATIONS}-iteration cap`,
          `I hit my ${MAX_ITERATIONS}-step limit before finishing. I'm opening a fresh recovery attempt from the checkpoint.`
        );
      }
    } catch (err: any) {
      const reason = classifyProviderError(err);
      stop(reason, String(err?.message ?? err));
      this.emitEvent("error", String(err?.message ?? err));
      log?.exit(reason, {
        iteration,
        error: err,
        messageCount: this.contents.length,
        approxTokensInContext: approxTokens(this.contents),
        rawFinishReason: lastFinish,
        detail: exitDetail,
      });
    } finally {
      this.busy = false;
      // Also on the way out of a turn that never got a reply — an interrupted or
      // failed request must not leave a recording in the history to be uploaded
      // again with the next thing the user says.
      this.forgetAudio();
      // `unknown_fallthrough` is deliberately the default. If it ever shows up
      // in a log, a path out of this loop was added without naming itself.
      log?.exit(exitReason ?? "unknown_fallthrough", {
        iteration,
        detail: exitDetail,
        messageCount: this.contents.length,
        approxTokensInContext: approxTokens(this.contents),
        rawFinishReason: lastFinish,
      });
      log?.enterState("idle");
      this.emitEvent("turnEnd");
      this.emitEvent("status", "idle");
      this.drainQueue();
    }
  }

  /**
   * The loop has ended with messages still waiting.
   *
   * After a stop they are the user's NEXT request ("stop — do this instead"),
   * so a fresh loop answers them, inside the run the recorder opened for them.
   * After a failed run they stay in the history instead: the recorder's
   * checkpoint already carries them into its recovery attempt, and running
   * them here as well would do the work twice.
   */
  private drainQueue() {
    const next = this.queue.takeForNextLoop();
    if (!next.length) return;
    if (!this.aborted) {
      for (const q of next) this.appendUser(q.item.parts.filter((p: any) => !p.inlineData), false);
      console.log(`[gemini] ${next.length} message(s) arrived as the task failed; kept for its recovery`);
      return;
    }
    if (next.some((q) => q.reset)) this.contents = [];
    for (const q of next) this.appendUser(q.item.parts, q.item.audio);
    next[0].resume(() => void this.runLoop());
  }

  interrupt() {
    this.aborted = true;
    // What was queued belonged to the task being stopped.
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
    // Every MCP server is a child process this brain spawned. Without this, a
    // brain switch left the old set running and started a second one.
    this.memory.close();
    const connection = this.mcpConnection ?? await this.mcpReady;
    await connection?.close().catch((err) =>
      console.error("[gemini] MCP shutdown failed:", (err as any)?.message ?? err)
    );
  }
}
