import { modelToolResult } from '../memory/tool-context.js';
import { EventEmitter } from "node:events";
import type { JarvisConfig } from "../config.js";
import { TOOL_MAP, TOOLS, type ToolDef } from "../tools/registry.js";
import { toFunctionDeclaration } from "../brain/gemini.js";
import { runGated } from "../safety/gate.js";
import { connectMcpServers, loadMcpConfig, mcpToolDef, jsonSchemaToGoogleForRealtime, type McpConnection, type McpToolHandle } from "../brain/mcp.js";
import { conversationId, contextSettings, contextTokens, contextWindow, conversations, seedConversationFromRecordings } from "../memory/conversation.js";
import { ProviderMemoryContext } from "../memory/provider-context.js";
import { memoryService } from "../memory/service.js";
import { taskCoordinator } from "../memory/task-state.js";
import { Recorder } from "../agent-replay/recorder.js";
import { captureAllowed } from "../memory/capture-policy.js";
import { ephemeralRecorder, loopLogRoot } from "../agent-replay/runtime.js";
import { LoopLog } from "../agent-replay/loop-log.js";
import { runInAgentContext, type AgentRunContext } from "../agent-replay/context.js";
import type { MemoryScope } from "../memory/types.js";
import { randomUUID } from "node:crypto";

/**
 * Speech-to-speech voice, on the model itself.
 *
 * Echo's ordinary voice is a PIPELINE — mic -> STT -> text -> brain -> text ->
 * TTS -> speaker — and every arrow throws something away. By the time the brain
 * reads "what's on my screen" the audio is gone: tone, urgency, hesitation,
 * whether it was a joke. At the far end the TTS re-synthesises speech from bare
 * text with no idea how it was meant to sound. That is why a pipeline reads
 * rather than talks, however good its voice is.
 *
 * This runs the turn on a model that takes audio in and gives audio out, so
 * none of that is lost. Measured on this key (see `npm run realtimespike`):
 * ~1.6s to first audio, function calls really are emitted from speech, and
 * Telugu is understood and answered in Telugu.
 *
 * It is a HYBRID, not a replacement, and the split is deliberate:
 *
 *   - the model handles hearing, speaking and deciding WHICH tool to call;
 *   - Echo still EXECUTES every tool, through `runGated`, exactly as the four
 *     text brains do.
 *
 * That second half is the point. Every brain routes execution through the one
 * choke point in safety/gate.ts, and a voice that could act without passing it
 * would be a hole straight through the risk gate — the same class of mistake as
 * a cached workflow replaying "click Send" unconfirmed. Nothing here bypasses
 * confirmation; a high-risk call simply waits on the gate like any other, and
 * the model is told when it is refused.
 *
 * Events: 'open' · 'audio'(Buffer, 24k PCM16) · 'heard'(text) · 'said'(text)
 *         'tool'(name) · 'interrupted' · 'turnComplete' · 'error'(msg) · 'closed'
 */

/** Gemini Live wants 16 kHz in and returns 24 kHz out. */
export const REALTIME_INPUT_RATE = 16000;
export const REALTIME_OUTPUT_RATE = 24000;

const DEFAULT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

/**
 * Corrections the shared persona needs before a speech-to-speech model reads it.
 *
 * The persona was written for the PIPELINE, where Echo writes text and a TTS
 * reads it, and it says so out loud: "your voice picks which language to speak
 * from the script you write in". That is simply false here — this model speaks
 * directly, there is no script for a voice to read. Left uncorrected, its long
 * Telugu section (with pages of Telugu script examples) reads as an instruction
 * to speak Telugu, and Echo switched into Telugu unprompted mid-conversation.
 *
 * So this re-frames those rules for a model that talks, rather than deleting
 * them: the everyday-register guidance is still exactly right, it just has to
 * be about how Echo SOUNDS rather than which script it types.
 */
export const REALTIME_VOICE_GUIDANCE = `
## You are SPEAKING, not writing

You are talking out loud, directly. There is no text-to-speech step and no
script: you produce the sound yourself. Anything in your instructions about
"writing in a script" or a voice "picking the language from the script you write
in" describes a different mode and does not apply — read those rules as being
about how you SOUND.

## Language

Speak the language the user just spoke to you in, and keep speaking it until
they change. If they speak English, reply in English. If they speak Telugu or
Hindi, reply in that language. NEVER switch language on your own: not to show
you can, not because your instructions discuss another language at length, not
mid-conversation. The Telugu and Hindi guidance in your instructions is about
how to sound natural WHEN the user is speaking those languages — it is not an
instruction to start speaking them.

If you genuinely cannot tell what language was spoken, or you did not hear it
clearly, stay in the language of the conversation so far and say you did not
catch that. Do not guess by switching language.

The everyday-register rule still holds when you ARE speaking Telugu or Hindi:
talk the way people actually talk, mixed with the English words real speakers
use, never the pure literary form.
`.trim();

export interface RealtimeOptions {
  scope?: MemoryScope;
  /** Restrict the session to these tools (the fleet's allowedTools contract). */
  allowedTools?: Set<string>;
  /**
   * Testing seam: supply the live session instead of dialling Google.
   * `onmessage` is handed back so a test can drive server events, which is the
   * only way to exercise the tool path without a network and a preview model.
   */
  transport?: (handlers: { onmessage: (m: any) => void; onopen: () => void; onerror: (e: any) => void; onclose: (e: any) => void }) => Promise<any>;
  /** Spoken persona / system instruction. */
  instruction?: string;
  workingDir?: string;
}

export class RealtimeVoiceSession extends EventEmitter {
  readonly conversationId: string;
  private memory = new ProviderMemoryContext("gemini-live");
  private toolContext?: AgentRunContext;
  private heardText = "";
  private saidText = "";
  private recordedUser = false;
  private syncedMessageId?: string;
  private session: any = null;
  private closed = false;
  private opening: Promise<void> | null = null;
  /** Tool calls currently running, so close() can stop waiting on them. */
  private inflight = 0;
  /**
   * Outside tools (Composio and the like), resolved before the session opens.
   *
   * This path had none, and the gap was invisible: the four text brains all
   * reach Composio, so Echo could read your mail — until the turn happened to
   * be spoken in Telugu, which routes to Gemini Live, where the same request
   * answered that it had no such tool. Same assistant, same account, different
   * answer depending on the language it was asked in.
   *
   * They have to be attached BEFORE `open()`, because a Live session fixes its
   * tool list in the setup message and there is no way to add one later.
   */
  private mcpTools = new Map<string, McpToolHandle>();
  private mcpConnection: McpConnection | null = null;

  constructor(
    private readonly cfg: JarvisConfig,
    private readonly apiKey: string,
    private readonly opts: RealtimeOptions = {}
  ) {
    super();
    this.conversationId = conversationId("echo", opts.scope);
    if (ProviderMemoryContext.enabled && !memoryService.isSuppressed(opts.scope ?? {})) seedConversationFromRecordings(this.conversationId, "echo", opts.scope);
    this.memory.configure(cfg.context);
    this.memory.begin("", { conversationId: this.conversationId, scope: opts.scope });
  }

  /** Bring externally produced text turns into an already-open voice session. */
  syncContext(): void {
    const last = conversations.read(this.conversationId).at(-1)?.id;
    if (!this.session || !last || last === this.syncedMessageId || this.inflight || this.heardText) return;
    const used = contextTokens(this.opts.instruction ?? "") + contextTokens(this.declarations());
    const packet = this.memory.packet(used);
    if (packet) this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: packet }] }], turnComplete: false });
    this.syncedMessageId = last;
  }

  private ensureTask(): AgentRunContext {
    if (this.toolContext) return this.toolContext;
    const task = taskCoordinator.create({ ownerActorId: "echo", goal: this.heardText || "Realtime voice turn", scope: this.opts.scope });
    const runId = `Echo-voice--${randomUUID()}`;
    const root = loopLogRoot();
    const payloadRecording = !!root && process.env.ECHO_FULL_LOG !== '0' && captureAllowed() && !memoryService.isSuppressed(this.opts.scope ?? {}, task.taskId);
    let recorder = ephemeralRecorder(runId);
    if (payloadRecording && root) {
      try { recorder = new Recorder(root, runId); }
      catch (error) { console.error('[realtime] run recording unavailable:', error); }
    }
    const context: AgentRunContext = { identity: { id: "echo", name: "Echo", kind: "main" }, taskId: task.taskId,
      conversationId: this.conversationId, recorder, loop: new LoopLog(recorder, "gemini-live", this.cfg.voice.realtime?.model ?? DEFAULT_MODEL), payloadRecording: payloadRecording && !!recorder.dir, scope: this.opts.scope, provider: "gemini-live" };
    this.toolContext = context;
    context.loop.runStart({actor: context.identity, taskId: task.taskId, transport: 'gemini-live'});
    if (context.payloadRecording) recorder.emit({type: 'session.tools', toolsRef: recorder.blob(this.declarations())});
    this.memory.begin(this.heardText, { taskId: task.taskId, conversationId: this.conversationId, scope: this.opts.scope });
    return context;
  }

  private recordTurn(cancelled = false): void {
    if (!this.heardText && !this.saidText && !this.toolContext) return;
    const context = this.ensureTask();
    const taskId = context.taskId;
    if (context.payloadRecording && captureAllowed()) {
      context.recorder.emit({type: 'agent.input', bodyRef: context.recorder.blob(this.heardText)});
      context.recorder.emit({type: 'agent.text', textRef: context.recorder.blob(this.saidText), interrupted: cancelled});
    }
    context.loop.exit(cancelled ? 'abort_signal' : 'completed');
    if (ProviderMemoryContext.enabled && !memoryService.isSuppressed(this.opts.scope ?? {}, taskId)) {
      const base = { actorId: "echo", provider: "gemini-live", projectId: this.opts.scope?.projectId, taskId };
      if (this.heardText && !this.recordedUser) conversations.append(this.conversationId, { ...base, role: "user", text: this.heardText });
      if (this.saidText) conversations.append(this.conversationId, { ...base, role: "assistant", text: this.saidText + (cancelled ? "\n[Reply interrupted; delivery may be partial.]" : "") });
    }
    if (taskId) {
      const task = taskCoordinator.get(taskId);
      if (task && !task.result) {
        if (cancelled) taskCoordinator.cancel(taskId);
        else taskCoordinator.finish(taskId, { status: "completed", summary: this.saidText, verificationRefs: Object.keys(task.calls).length ? task.verificationRefs : [`voice-response:${taskId}`] });
      }
    }
    this.heardText = ""; this.saidText = ""; this.recordedUser = false; this.toolContext = undefined;
    this.syncedMessageId = conversations.read(this.conversationId).at(-1)?.id;
    this.memory.begin("", { conversationId: this.conversationId, scope: this.opts.scope });
  }

  get active(): boolean {
    return !!this.session && !this.closed;
  }

  /** The tools this session may call, as Gemini declarations. */
  private declarations(): any[] {
    const allowed = this.opts.allowedTools;
    const tools = allowed ? TOOLS.filter((t) => allowed.has(t.name)) : TOOLS;
    const own = tools.map(toFunctionDeclaration);
    const outside = [...this.mcpTools.values()].map((t) => {
      const schema = jsonSchemaToGoogleForRealtime(t.inputSchema);
      return {
        name: t.name,
        description: t.description,
        parameters: { type: "OBJECT", properties: schema.properties ?? {}, required: schema.required ?? [] },
      };
    });
    return [...own, ...outside];
  }

  /**
   * Connect the configured MCP servers and keep their tools for `declarations`.
   *
   * Failure here is not fatal and must not be: losing Gmail is worth far less
   * than losing the voice, so a server that is down costs its own tools and
   * the session opens anyway.
   */
  private async attachMcp(): Promise<void> {
    if (this.cfg.voice.realtime?.outsideTools === false) return;
    if (!Object.keys(loadMcpConfig()).length) return;
    try {
      this.mcpConnection = await connectMcpServers();
      const allowed = this.opts.allowedTools;
      for (const t of this.mcpConnection.tools) {
        if (allowed && !allowed.has(t.name)) continue;
        this.mcpTools.set(t.name, t);
      }
      const failed = this.mcpConnection.servers.filter((x) => !x.ok);
      if (failed.length) console.error(`[realtime] MCP servers unavailable: ${failed.map((x) => x.name).join(", ")}`);
      // Logged because it is paid on every session and is otherwise invisible:
      // the tool list goes in the setup message and never changes after.
      if (this.mcpTools.size) console.log(`[realtime] ${this.mcpTools.size} outside tool(s) attached to the spoken session`);
    } catch (err: any) {
      console.error("[realtime] MCP unavailable, continuing without it:", err?.message ?? err);
    }
  }

  async connect(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.open();
    return this.opening;
  }

  private async open(): Promise<void> {
    // Before the transport: a Live session's tool list is fixed in its setup
    // message, so anything not known by now cannot be called for the whole
    // conversation.
    await this.attachMcp();
    if (this.opts.transport) {
      this.session = await this.opts.transport({
        onmessage: (m: any) => this.onMessage(m),
        onopen: () => this.emit("open"),
        onerror: (e: any) => this.emit("error", String(e?.message ?? e)),
        onclose: (e: any) => { this.recordTurn(true); this.memory.close(); this.closed = true; this.emit("closed", e?.reason ?? ""); },
      });
      return;
    }
    const { GoogleGenAI, Modality } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    const model = this.cfg.voice.realtime?.model || DEFAULT_MODEL;
    const settings = contextSettings(this.cfg.context);
    const window = contextWindow(settings, "gemini-live", model);
    const used = contextTokens(this.opts.instruction ?? "") + contextTokens(this.declarations());
    if (used + 256 >= this.memory.inputBudget(model)) throw new Error("Voice instructions and tools exceed the configured context budget.");

    this.session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        // Both transcripts, because the rest of Echo is built around text: the
        // HUD, the voice log, memory and the trajectory recorder all still want
        // to know what was said, even though the audio never became text on its
        // way through the model.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: `${this.opts.instruction ?? ""}\n\n${this.memory.packet(used, true, model)}`,
        contextWindowCompression: { triggerTokens: String(Math.floor(window * settings.compactAt)), slidingWindow: { targetTokens: String(Math.floor(window * 0.5)) } },
        // Unset means Google's default voice. Named here so Echo does not
        // silently sound like whatever the provider ships this month.
        ...(this.cfg.voice.realtime?.voice || this.cfg.voice.realtime?.language
          ? {
              speechConfig: {
                ...(this.cfg.voice.realtime?.voice
                  ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.cfg.voice.realtime.voice } } }
                  : {}),
                // Unset means the model decides per turn, which is what let it
                // wander into Telugu unprompted. Pin it to stop that outright.
                ...(this.cfg.voice.realtime?.language ? { languageCode: this.cfg.voice.realtime.language } : {}),
              },
            }
          : {}),
        tools: [{ functionDeclarations: this.declarations() }] as any,
      },
      callbacks: {
        onopen: () => this.emit("open"),
        onmessage: (m: any) => this.onMessage(m),
        onerror: (e: any) => this.emit("error", String(e?.message ?? e)),
        onclose: (e: any) => {
          this.recordTurn(true);
          this.memory.close();
          this.closed = true;
          this.emit("closed", e?.reason ?? "");
        },
      },
    });
  }

  private onMessage(m: any): void {
    const sc = m.serverContent;
    if (sc?.inputTranscription?.text) { this.heardText += sc.inputTranscription.text; this.emit("heard", sc.inputTranscription.text); }
    if (sc?.outputTranscription?.text) { this.saidText += sc.outputTranscription.text; this.emit("said", sc.outputTranscription.text); }

    for (const p of sc?.modelTurn?.parts ?? []) {
      const b64 = p.inlineData?.data;
      if (b64) this.emit("audio", Buffer.from(b64, "base64"));
    }

    // The server detected the user talking over the reply. Echo's own barge-in
    // machinery is for the pipeline; here the model has already stopped, so all
    // that is left is to drop whatever audio is still queued for the speaker.
    if (sc?.interrupted) { this.recordTurn(true); this.emit("interrupted"); }
    if (sc?.turnComplete) { this.recordTurn(); this.emit("turnComplete"); }

    const calls = m.toolCall?.functionCalls;
    if (calls?.length) void this.runTools(calls);
  }

  /**
   * Execute what the model asked for — through the gate, never around it.
   *
   * Every response is sent back, including refusals and failures. A tool call
   * that is silently dropped leaves the session waiting forever, and the user
   * hears nothing at all: the same silent stop this project has fixed twice in
   * the text loop.
   */
  private async runTools(calls: Array<{ id?: string; name: string; args?: Record<string, unknown> }>): Promise<void> {
    const responses: any[] = [];
    const context = this.ensureTask();
    if (context.payloadRecording && captureAllowed()) context.recorder.emit({type: 'session.toolrequest', callsRef: context.recorder.blob(calls)});
    for (const call of calls) {
      this.inflight++;
      // One shared adapter, so an outside tool is gated here exactly as it
      // would be on any of the text brains.
      const handle = this.mcpTools.get(call.name);
      const def: ToolDef | undefined = handle ? mcpToolDef(handle) : TOOL_MAP.get(call.name);
      try {
        if (!def) {
          responses.push({ id: call.id, name: call.name, response: { error: `unknown tool ${call.name}`, status: "failed" } });
          continue;
        }
        if (this.opts.allowedTools && !this.opts.allowedTools.has(call.name)) {
          responses.push({ id: call.id, name: call.name, response: { error: `${call.name} is not available in this session`, status: "denied" } });
          continue;
        }
        this.emit("tool", call.name);
        const context = this.ensureTask();
        const out = await runInAgentContext(context, () => runGated(def, call.args ?? {}, {
          workingDir: this.opts.workingDir ?? this.cfg.control.workingDir,
          emit: (e, p) => this.emit("gate", e, p),
        }));
        responses.push({
          id: call.id,
          name: call.name,
          response: modelToolResult(out),
        });
      } catch (err: any) {
        responses.push({ id: call.id, name: call.name, response: { error: String(err?.message ?? err), status: "failed" } });
      } finally {
        this.inflight--;
      }
    }
    // The session can be closed while a slow tool (or a confirmation the user
    // never answered) was still running. Sending then would throw.
    if (!this.session || this.closed) return;
    if (context.payloadRecording && captureAllowed()) context.recorder.emit({type: 'session.toolresponse', responsesRef: context.recorder.blob(responses)});
    try {
      this.session.sendToolResponse({ functionResponses: responses });
    } catch (err: any) {
      this.emit("error", `tool response failed: ${err?.message ?? err}`);
    }
  }

  /** One frame of microphone audio, 16 kHz mono PCM16. */
  push(frame: Int16Array): void {
    if (!this.active) return;
    const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    try {
      this.session.sendRealtimeInput({
        audio: { data: buf.toString("base64"), mimeType: `audio/pcm;rate=${REALTIME_INPUT_RATE}` },
      });
    } catch (err: any) {
      this.emit("error", `send failed: ${err?.message ?? err}`);
    }
  }

  /** The user stopped talking. */
  endOfSpeech(): void {
    if (!this.active) return;
    try { this.session.sendRealtimeInput({ audioStreamEnd: true }); } catch { /* closing */ }
  }

  /** Send a typed message into the same session, so text and voice share one context. */
  sendText(text: string): void {
    this.syncContext();
    this.heardText += text;
    if (!this.active) return;
    try {
      this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
    } catch (err: any) {
      this.emit("error", `send failed: ${err?.message ?? err}`);
    }
  }

  close(): void {
    this.recordTurn(true);
    this.memory.close();
    this.closed = true;
    const s = this.session;
    this.session = null;
    try { s?.close(); } catch { /* already gone */ }
  }
}

/**
 * Is the realtime voice path configured and usable RIGHT NOW?
 *
 * Gated on the configured brain, which is easy to miss: this mode does not just
 * change the voice, it runs the whole turn — hearing, reasoning, tool choice and
 * speaking — on Gemini Live. With only the `enabled` flag checked, switching the
 * brain to Claude left every spoken turn still being answered by Gemini, and
 * Claude never ran at all. The user would have no way to tell from the outside;
 * Echo would simply not be the assistant they selected.
 *
 * So realtime engages only when Gemini is the brain anyway. Wanting Echo's
 * Gemini VOICE while a different brain thinks is a separate, legitimate thing —
 * that is `ttsEngine: "gemini"` (GeminiTtsStream), which speaks whatever any
 * brain produced.
 */
export function realtimeAvailable(cfg: JarvisConfig): boolean {
  if (!cfg?.voice?.realtime?.enabled) return false;
  if ((cfg.brain ?? "gemini") !== "gemini") return false;
  return !!process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"];
}

/**
 * Why realtime is not running, for a one-line startup log. `null` when it is.
 * Silence about a mode the user switched on is its own bug.
 */
export function realtimeUnavailableReason(cfg: JarvisConfig): string | null {
  // A startup diagnostic must never be the thing that breaks startup. This was
  // called four lines before `cfg` was assigned and threw an unhandled
  // rejection on boot; optional chaining keeps a future misordering silent
  // instead of fatal.
  if (!cfg?.voice?.realtime?.enabled) return null; // deliberately off, or not loaded yet
  if ((cfg.brain ?? "gemini") !== "gemini") {
    return `realtime voice is on but the brain is "${cfg.brain}" — realtime runs the whole turn on Gemini, so it is off. ` +
      `For Echo's Gemini voice with this brain, set voice.ttsEngine to "gemini".`;
  }
  if (!process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"]) {
    return `realtime voice is on but ${cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"} is not set — falling back to the speech pipeline.`;
  }
  return null;
}
