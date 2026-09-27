/**
 * Which realtime provider should Echo's voice run on?   npm run realtimespike
 *
 * A pipeline (STT -> text -> LLM -> text -> TTS) throws the audio away at the
 * first arrow: by the time the model reads "what's on my screen", your tone,
 * urgency and hesitation are gone, and the TTS at the far end re-synthesises
 * speech from bare text with no idea how it was meant to sound. Speech-to-speech
 * keeps all of it, which is the whole reason ChatGPT's voice mode sounds human.
 *
 * Echo cannot simply move, though: its value is CONTROLLING THE MAC, and that
 * runs on the text + tool-call loop (140 tools, the risk gate, the reflex
 * cache). So the only two questions that decide the design are:
 *
 *   1. Does the provider emit a real FUNCTION CALL from speech? Without that,
 *      a realtime mode can only chat, and every tool turn falls back anyway.
 *   2. Does it handle TELUGU? Sarvam was chosen for exactly that (see the
 *      Telugu voice work), and losing it would be a downgrade, not an upgrade.
 *
 * Measures both providers on both, plus latency. Nothing here is wired into the
 * app — this is the data the hybrid design is chosen from.
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadEnv } from "./env.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
loadEnv(ROOT);

/** Render a sentence to mono PCM16 at the rate the provider wants. */
async function speak(text: string, voice: string, rate: number): Promise<Buffer> {
  const aiff = join(tmpdir(), `spike-${Date.now()}-${Math.random().toString(36).slice(2)}.aiff`);
  const wav = aiff.replace(/\.aiff$/, ".wav");
  await run("/usr/bin/say", ["-v", voice, "-o", aiff, text]);
  await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", `LEI16@${rate}`, "-c", "1", aiff, wav]);
  const buf = readFileSync(wav);
  try { unlinkSync(aiff); unlinkSync(wav); } catch { /* ignore */ }
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in wav");
}

/** The one tool both providers are offered, shaped like a real Echo tool. */
const TOOL = {
  name: "get_screen_info",
  description: "Describe what is currently on the user's screen. Call this whenever the user asks about their screen.",
  parameters: { type: "object", properties: {}, required: [] as string[] },
};

const SYSTEM =
  "You are Echo, a concise voice assistant on a Mac. Reply in one short sentence. " +
  "Always reply in the SAME LANGUAGE the user spoke. " +
  "When the user asks what is on their screen, you MUST call the get_screen_info tool rather than guessing.";

interface Result {
  provider: string;
  connectMs: number | null;
  firstAudioMs: number | null;
  heard: string;
  said: string;
  toolCalled: string | null;
  error: string | null;
}

const results: Result[] = [];
const show = (r: Result) => {
  console.log(`  connect        ${r.connectMs === null ? "—" : r.connectMs + "ms"}`);
  console.log(`  first audio    ${r.firstAudioMs === null ? "never" : "+" + r.firstAudioMs + "ms after end of speech"}`);
  if (r.heard) console.log(`  heard          ${JSON.stringify(r.heard.trim().slice(0, 90))}`);
  if (r.said) console.log(`  said           ${JSON.stringify(r.said.trim().slice(0, 90))}`);
  console.log(`  tool call      ${r.toolCalled ?? "NONE"}`);
  if (r.error) console.log(`  error          ${r.error.slice(0, 160)}`);
  results.push(r);
};

// ---------------------------------------------------------------- Gemini Live
async function gemini(label: string, pcm: Buffer, wantTool: boolean): Promise<void> {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.ECHO_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
  console.log(`\nGemini Live — ${label}`);
  if (!key) { console.log("  no GEMINI_API_KEY"); return; }
  const { GoogleGenAI, Modality } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: key });
  const r: Result = { provider: `gemini:${label}`, connectMs: null, firstAudioMs: null, heard: "", said: "", toolCalled: null, error: null };
  const t0 = performance.now();
  let firstAudio = -1, done = false, tEnd = 0;
  try {
    const session: any = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: SYSTEM,
        ...(wantTool ? { tools: [{ functionDeclarations: [TOOL] }] as any } : {}),
      },
      callbacks: {
        onopen: () => { r.connectMs = Math.round(performance.now() - t0); },
        onmessage: (m: any) => {
          const sc = m.serverContent;
          if (sc?.inputTranscription?.text) r.heard += sc.inputTranscription.text;
          if (sc?.outputTranscription?.text) r.said += sc.outputTranscription.text;
          for (const p of sc?.modelTurn?.parts ?? []) {
            if (p.inlineData?.data && firstAudio < 0) firstAudio = performance.now();
          }
          for (const c of m.toolCall?.functionCalls ?? []) { r.toolCalled = c.name; done = true; }
          if (sc?.turnComplete) done = true;
        },
        onerror: (e: any) => { r.error = String(e?.message ?? e); },
        onclose: (e: any) => { if (!done && !r.error) r.error = `closed: ${e?.reason ?? ""}`; },
      },
    });
    for (let off = 0; off < pcm.length; off += 3200) {
      session.sendRealtimeInput({ audio: { data: pcm.subarray(off, off + 3200).toString("base64"), mimeType: "audio/pcm;rate=16000" } });
      await new Promise((res) => setTimeout(res, 100));
    }
    session.sendRealtimeInput({ audioStreamEnd: true });
    tEnd = performance.now();
    const deadline = Date.now() + 20000;
    while (!done && !r.error && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    session.close();
  } catch (err: any) {
    r.error = String(err?.message ?? err);
  }
  if (firstAudio > 0 && tEnd) r.firstAudioMs = Math.round(firstAudio - tEnd);
  show(r);
}

// ------------------------------------------------------------ OpenAI Realtime
async function openai(label: string, pcm: Buffer, wantTool: boolean): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.ECHO_REALTIME_MODEL || "gpt-realtime";
  console.log(`\nOpenAI Realtime — ${label}`);
  if (!key) { console.log("  no OPENAI_API_KEY"); return; }
  const { WebSocket } = await import("ws");
  const r: Result = { provider: `openai:${label}`, connectMs: null, firstAudioMs: null, heard: "", said: "", toolCalled: null, error: null };
  const t0 = performance.now();
  let firstAudio = -1, done = false, tEnd = 0;
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    // No "OpenAI-Beta: realtime=v1" header: that selects the retired Beta API,
    // which now answers "The Realtime Beta API is no longer supported." The GA
    // endpoint is the same URL without it.
    headers: { Authorization: `Bearer ${key}` },
  });
  const send = (o: unknown) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  await new Promise<void>((resolve) => {
    ws.on("open", () => { r.connectMs = Math.round(performance.now() - t0); resolve(); });
    ws.on("error", (e: any) => { r.error = String(e?.message ?? e); resolve(); });
    setTimeout(resolve, 15000);
  });
  if (!r.error && ws.readyState === 1) {
    send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: SYSTEM,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "whisper-1" },
            turn_detection: null, // we commit the buffer ourselves
          },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
        },
        ...(wantTool ? { tools: [{ type: "function", ...TOOL }], tool_choice: "auto" } : {}),
      },
    });
    ws.on("message", (raw: any) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if ((m.type === "response.audio.delta" || m.type === "response.output_audio.delta") && firstAudio < 0) firstAudio = performance.now();
      if (m.type === "conversation.item.input_audio_transcription.completed") r.heard += m.transcript ?? "";
      if (m.type === "response.audio_transcript.delta" || m.type === "response.output_audio_transcript.delta") r.said += m.delta ?? "";
      if (m.type === "response.function_call_arguments.done") { r.toolCalled = m.name ?? "(unnamed)"; done = true; }
      if (m.type === "response.output_item.done" && m.item?.type === "function_call") { r.toolCalled = m.item.name; done = true; }
      if (m.type === "response.done") done = true;
      if (m.type === "error") r.error = String(m.error?.message ?? "error");
    });
    for (let off = 0; off < pcm.length; off += 4800) {
      send({ type: "input_audio_buffer.append", audio: pcm.subarray(off, off + 4800).toString("base64") });
      await new Promise((res) => setTimeout(res, 100));
    }
    send({ type: "input_audio_buffer.commit" });
    send({ type: "response.create" });
    tEnd = performance.now();
    const deadline = Date.now() + 20000;
    while (!done && !r.error && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  }
  try { ws.close(); } catch { /* ignore */ }
  if (firstAudio > 0 && tEnd) r.firstAudioMs = Math.round(firstAudio - tEnd);
  show(r);
}

// ------------------------------------------------------------------------ run
const EN = "Hello. In one short sentence, what can you help me with?";
const EN_TOOL = "What is on my screen right now?";
const TE = "నమస్కారం, నా స్క్రీన్ మీద ఏముంది?"; // "Hello, what is on my screen?"

console.log("\nRealtime provider spike — latency, tool calls, and Telugu\n" + "=".repeat(60));

for (const [label, text, voice, tool] of [
  ["english", EN, "Samantha", false],
  ["english + tool", EN_TOOL, "Samantha", true],
  ["telugu", TE, "Geeta", false],
] as Array<[string, string, string, boolean]>) {
  await gemini(label, await speak(text, voice, 16000), tool);
  await openai(label, await speak(text, voice, 24000), tool);
}

console.log("\n" + "=".repeat(60) + "\nSummary\n");
for (const r of results) {
  const ok = r.error ? "FAIL" : "ok  ";
  console.log(`  ${ok} ${r.provider.padEnd(22)} audio ${String(r.firstAudioMs ?? "—").padStart(6)}ms  tool=${r.toolCalled ?? "none"}`);
}
console.log("\nDecides: which provider the hybrid voice mode runs on.\n");
