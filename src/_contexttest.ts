/** Exercises the real runtime/provider handoff without model calls or user data. */
import { mkdtempSync, rmSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const root = mkdtempSync(join(tmpdir(), "echo-context-test-"));
process.env.ECHO_DATA_ROOT = root;
process.env.ECHO_MEMORY_ROOT = join(root, "os");
process.env.ECHO_LOG_DIR = join(root, "runs");
process.env.ECHO_LOG_QUIET = "1";
process.env.ECHO_MCP = "0";
const { Brain } = await import("./brain/types.js");
const { RecordingBrain } = await import("./agent-replay/runtime.js");
const { currentLoop } = await import("./agent-replay/loop-log.js");
const { ProviderMemoryContext } = await import("./memory/provider-context.js");
const { ConversationStore, conversations, conversationId, contextTokens, contextSettings, contextWindow, contextInputBudget, seedConversationFromRecordings } = await import("./memory/conversation.js");
const { taskCoordinator } = await import("./memory/task-state.js");
const { forgetEverywhere } = await import("./memory/deletion.js");
const { RealtimeVoiceSession } = await import("./voice/realtime.js");
const { DEFAULTS_FOR_TESTS } = await import("./config.js");
const { GeminiBrain } = await import("./brain/gemini.js");
const { TOOL_MAP } = await import("./tools/registry.js");
import type { SendOptions } from "./brain/types.js";
let count = 0;
function check(condition: unknown, message: string) { assert.ok(condition, message); count++; console.log(`PASS ${message}`); }
class ProbeBrain extends Brain {
  memory: InstanceType<typeof ProviderMemoryContext>;
  packet = ""; options?: SendOptions;
  constructor(provider: string) { super(); this.memory = new ProviderMemoryContext(provider); }
  send(text: string, _audio?: any, opts?: SendOptions) { this.options = opts; this.memory.begin(text, opts); this.packet = this.memory.packet(); }
  finish(text: string) { this.emitEvent("text", text); currentLoop()?.exit("completed"); this.emitEvent("turnEnd"); }
  interrupt() { currentLoop()?.exit("abort_signal"); }
  async stop() { this.memory.close(); }
}
try {
  const settings = contextSettings();
  check(settings.maxTokens === 128000, "shared context starts at 128k");
  check(contextInputBudget(settings, "gemini") === 112000, "output space is reserved within the configured window");
  check(contextWindow(contextSettings({ providerLimits: { ollama: 4096, tiny: 100000 } }), "ollama", "tiny") === 4096, "a model override cannot bypass a smaller provider capacity");
  const legacyRoot = join(root, "legacy-runs"), migrated = new ConversationStore(join(root, "migrated"));
  const legacyScope = { projectId: "legacy" }, legacyId = conversationId("echo", legacyScope);
  const legacyBase = { version: 1, actor: { id: "echo", kind: "main" }, provider: "gemini", taskId: "legacy-task", scope: legacyScope, restartable: true,
    originalPrompt: "The previous release used silver.", lastAssistantText: "Silver confirmed.", createdAt: 1700000000000, updatedAt: 1700000001000 };
  for (const [name, patch] of Object.entries({ real: {}, private: { privateMode: true, taskId: "private", originalPrompt: "private seed canary" }, test: { provider: "test", taskId: "test" }, other: { scope: { projectId: "other" }, taskId: "other" }, metadata: { restartable: false, taskId: "metadata" } })) {
    mkdirSync(join(legacyRoot, name), { recursive: true }); writeFileSync(join(legacyRoot, name, "checkpoint.json"), JSON.stringify({ ...legacyBase, ...patch }));
  }
  check(seedConversationFromRecordings(legacyId, "echo", legacyScope, migrated, legacyRoot) === 2, "existing real recordings seed the shared context before new turns");
  check(migrated.read(legacyId).every(row => row.taskId === "legacy-task") && migrated.read(legacyId)[0].at.startsWith("2023-"), "migration excludes private, diagnostic, metadata-only and other-project recordings and preserves dates");
  check(seedConversationFromRecordings(legacyId, "echo", legacyScope, migrated, legacyRoot) === 0, "recording migration is idempotent");
  const scope = { projectId: "atlas" };
  const first = new ProbeBrain("gemini"); const a = new RecordingBrain(first, "gemini", {}, { autoResume: false });
  a.send("The release target is harbour. Always use port 7301.", undefined, { scope });
  check(Boolean(first.options?.taskId), "runtime forwards its generated task ID into the provider");
  check(first.packet.includes(first.options!.taskId!), "current task state reaches the model packet");
  first.finish("Noted: harbour uses port 7301.");
  await a.stop();
  const second = new ProbeBrain("openai"); const b = new RecordingBrain(second, "openai", {}, { autoResume: false });
  b.send("Continue with that release target.", undefined, { scope });
  check(first.options!.conversationId === second.options!.conversationId, "switching providers keeps one conversation ID");
  check(second.packet.includes("port 7301") && second.packet.includes("Noted: harbour"), "the new provider receives the earlier user message and reply");
  check(second.packet.includes("Recent task outcomes"), "the handoff carries the prior task outcome as evidence");
  second.finish("Continuing with harbour."); await b.stop();
  const id = conversationId("echo", scope);
  const reopened = new ConversationStore(join(root, "os/conversations"));
  check(reopened.packet(id, 1000).includes("7301"), "conversation survives a new store instance/process restart");
  check(!reopened.packet(conversationId("echo", { projectId: "other" }), 1000), "projects have isolated conversation histories");
  check(!reopened.packet(conversationId("clone", scope), 1000), "clone history cannot overwrite or enter the main conversation");
  appendFileSync(join(root, "os/conversations", `${id}.jsonl`), '{"incomplete":');
  const crashRecovered = new ConversationStore(join(root, "os/conversations"));
  crashRecovered.append(id, { role: "user", actorId: "echo", provider: "gemini", text: "After crash", projectId: "atlas" });
  check(new ConversationStore(join(root, "os/conversations")).search(id, "After crash").length === 1, "a truncated journal tail cannot swallow the next appended message");

  const privateBrain = new ProbeBrain("gemini"); const p = new RecordingBrain(privateBrain, "gemini", {}, { autoResume: false });
  p.send("private-canary", undefined, { privateMode: true, scope });
  privateBrain.finish("private-answer-canary"); await p.stop();
  check(!conversations.read(id).some(row => /private-canary|private-answer/.test(row.text)), "private turns never enter the shared archive");
  const blocked = new ProviderMemoryContext("openai"); blocked.begin("harbour", { conversationId: id, scope });
  ProviderMemoryContext.cloudRecall = false;
  check(!blocked.packet().includes("7301"), "cloud recall disabled also blocks historical conversation sharing");
  ProviderMemoryContext.cloudRecall = true;
  const deletion = forgetEverywhere({ query: "harbour", scope, appRoot: root });
  check(Object.keys(deletion.stores).some(key => key.endsWith("conversations")), "forgetting removes the original transcript as well as memories");
  check(!blocked.packet().includes("harbour"), "forgotten content cannot return through the rolling summary");
  check(blocked.takeInvalidation(), "conversation deletion invalidates cached provider context"); blocked.close();

  const stressId = conversationId("stress");
  const store = new ConversationStore(join(root, "stress"));
  store.append(stressId, { role: "user", actorId: "stress", provider: "gemini", text: "Always preserve the launch constraint." });
  for (let i = 0; i < 45; i++) store.append(stressId, { role: i % 2 ? "assistant" : "user", actorId: "stress", provider: "gemini", text: `Turn ${i}: ${"長い記録 ".repeat(150)}`, taskId: `t-${Math.floor(i / 2)}` });
  const packed = store.packet(stressId, 3000);
  check(contextTokens(packed) <= 3000, "summary plus recent turns stays inside its budget with non-Latin text");
  check(packed.includes("launch constraint"), "explicit user constraints survive compaction");
  check(packed.includes("Rolling summary") && packed.includes("Recent conversation"), "compaction retains structured earlier excerpts and recent conversation");
  check(store.search(stressId, "Turn 0:")[0].text.includes("長い記録"), "full originals remain retrievable after compaction");
  const narrow = new ProviderMemoryContext("openai"); narrow.configure({ maxTokens: 8000, outputReserveTokens: 1000 }); narrow.begin("Continue the release", { scope });
  const history = [{ type: "function_call", call_id: "old", name: "click", arguments: "{}" }, { type: "function_call_output", call_id: "old", output: "x".repeat(25000) }];
  const used = narrow.prepareHistory(history, [], "system", "openai");
  check(history.length === 1 && (history[0] as any).role === "user", "transport compaction removes complete tool transactions at a safe boundary");
  check(used + contextTokens(narrow.packet(used)) <= 7000, "request context leaves the requested output reserve"); narrow.close();

  // Actual Gemini loop, with the provider response replaced but real runtime wiring.
  const cfg = structuredClone(DEFAULTS_FOR_TESTS); cfg.agi.toolPruning.enabled = false;
  const gemini = new GeminiBrain(cfg, "offline-key") as any; let request: any;
  gemini.generateStreaming = async (r: any) => { request = r; return { candidates: [{ content: { role: "model", parts: [{ text: "Loop checked." }] }, finishReason: "STOP" }] }; };
  const g = new RecordingBrain(gemini, "gemini", {}, { autoResume: false });
  const done = new Promise<void>(resolve => g.once("turnEnd", resolve));
  g.send("Continue the port 7301 discussion", undefined, { scope });
  await Promise.race([done, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Gemini context test timed out")), 4000); timer.unref(); })]);
  check(request?.config?.systemInstruction?.includes("7301"), "the actual Gemini request includes shared history");
  check(contextTokens(request) < 128000, "the actual model request stays below the 128k target"); await g.stop();

  // Voice rejoins the same transcript and exposes it to its tool context.
  const voiceScope = { projectId: "voice-context" }; const voiceId = conversationId("echo", voiceScope);
  conversations.append(voiceId, { role: "user", provider: "openai", actorId: "echo", projectId: voiceScope.projectId, text: "The spoken target is copper." });
  let drive: (m: any) => void = () => {}; const voicePackets: any[] = [];
  const voice = new RealtimeVoiceSession(cfg, "offline", { scope: voiceScope, transport: async handlers => { drive = handlers.onmessage; return { sendClientContent: (data: any) => voicePackets.push(data), sendToolResponse() {}, sendRealtimeInput() {}, close() {} }; } });
  await voice.connect(); voice.syncContext();
  check(JSON.stringify(voicePackets).includes("copper"), "voice receives the same conversation as the text brains");
  drive({ serverContent: { inputTranscription: { text: "Use copper." }, outputTranscription: { text: "Copper selected." }, turnComplete: true } });
  check(conversations.read(voiceId).some(row => row.text === "Copper selected."), "voice replies enter the shared transcript for the next text brain");
  voice.close();
  check(TOOL_MAP.has("conversation_history"), "every brain has a tool to retrieve archived originals");
  check(existsSync(join(root, "os/conversations", `${id}.jsonl`)), "conversation archive uses the configured memory root");
  console.log(`\n${count}/${count} shared context checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
