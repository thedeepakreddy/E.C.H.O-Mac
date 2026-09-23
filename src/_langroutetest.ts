/**
 * Language routing: English turns take the ordinary pipeline (Piper's voice),
 * other languages go to Gemini — Gemini Live for speech, Gemini's voice for any
 * non-Latin text that reaches the pipeline.
 *
 *   npm run langroutetest
 *
 * The whisper half synthesises real speech with the Mac's own English, Telugu
 * and Hindi voices, so it needs macOS and the multilingual whisper model.
 */
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULTS_FOR_TESTS, type JarvisConfig } from "./config.js";
import { detectSpokenLanguage, transcribeLocal, stopSttServer, NOT_ENGLISH_BELOW } from "./voice/stt.js";
import { createTtsStream, isLatinText } from "./voice/tts-stream.js";
import { SpeechStream } from "./voice/speech-stream.js";
import type { AudioPlayer } from "./voice/player.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── script detection ────────────────────────────────────────────────────────
console.log("\nScript\n");
ok(isLatinText("What's the weather like?"), "English is Latin");
ok(!isLatinText("ఈ రోజు వాతావరణం ఎలా ఉంది?"), "Telugu is not");
ok(!isLatinText("आज मौसम कैसा है?"), "Hindi is not");
ok(isLatinText("Café, naïve, jalapeño."), "accented Latin still counts as Latin");
ok(!isLatinText("Echo ఈ రోజు వాతావరణం ఎలా ఉంది"), "a Telugu sentence with one English word is Telugu");

// ── which voice a sentence gets ─────────────────────────────────────────────
console.log("\nVoice per sentence\n");
{
  const cfg: JarvisConfig = { ...DEFAULTS_FOR_TESTS, voice: { ...DEFAULTS_FOR_TESTS.voice, ttsEngine: "piper", ttsStreaming: true, ttsEnabled: true, realtime: { enabled: true, voice: "Charon" } } };
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  ok(createTtsStream(cfg, "నమస్కారం, ఎలా ఉన్నారు?")?.name === "gemini-tts", "with the piper engine, Telugu text gets Gemini's voice");
  ok(["piper", "say"].includes(createTtsStream(cfg, "Hello there.")?.name ?? ""), "English text stays local");
  delete process.env.GEMINI_API_KEY;
  ok(createTtsStream(cfg, "నమస్కారం")?.name !== "gemini-tts", "without a Gemini key, Telugu falls back to the local voice rather than failing");
  if (saved) process.env.GEMINI_API_KEY = saved;

  class FakePlayer extends EventEmitter implements AudioPlayer {
    readonly name = "fake"; readonly aec = false; readonly frameSource = null;
    playing = false; playedMs = 0;
    async start() {}
    play() { if (this.playing) return; this.playing = true; setTimeout(() => { this.playing = false; this.emit("drained"); }, 5); }
    endSentence() {} stop() { this.playing = false; } dispose() {}
  }
  const said: Array<[string, string]> = [];
  class Voice extends EventEmitter {
    readonly sampleRate = 24000;
    constructor(readonly name: string) { super(); }
    async open() {}
    speak(text: string, i: number) {
      said.push([this.name, text]);
      setTimeout(() => { this.emit("audio", { pcm: Buffer.alloc(480), sampleRate: 24000, sentence: i }); this.emit("sentenceDone", i); }, 5);
    }
    async close() {} abort() {}
  }
  const speech = new SpeechStream(cfg, new FakePlayer(), {
    maxSentences: () => 0,
    createTts: (_c, text) => new Voice(isLatinText(text) ? "piper" : "gemini-tts") as any,
  });
  speech.speakText("Here is the weather. ఈ రోజు వర్షం పడుతుంది. Anything else?");
  for (let i = 0; i < 300 && (speech.isSpeaking || said.length < 3); i++) await sleep(10);
  ok(said.map(([v]) => v).join(",") === "piper,gemini-tts,piper", `a mixed reply switches voice per sentence (${said.map(([v]) => v).join(",")})`);
}

// ── what whisper hears ──────────────────────────────────────────────────────
console.log("\nWhisper language detection\n");
const cfg = loadConfig(process.cwd());
const haveVoices = (() => {
  try {
    const list = execFileSync("/usr/bin/say", ["-v", "?"], { encoding: "utf8" });
    return /Geeta\s/.test(list) && /Lekha\s/.test(list);
  } catch {
    return false;
  }
})();
if (!existsSync(cfg.voice.sttModel) || /\.en\.bin$/.test(cfg.voice.sttModel) || !haveVoices) {
  console.log("  - skipped: needs the multilingual whisper model and the Mac's Telugu/Hindi voices");
} else {
  const dir = mkdtempSync(join(tmpdir(), "echo-langroute-"));
  const clip = (voice: string, text: string, name: string) => {
    const aiff = join(dir, `${name}.aiff`);
    const wav = join(dir, `${name}.wav`);
    execFileSync("/usr/bin/say", ["-v", voice, "-o", aiff, text]);
    execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    return wav;
  };
  const cases: Array<[string, string, string, boolean]> = [
    ["Daniel", "Echo, what's the weather like today?", "en", true],
    ["Daniel", "Echo, what time is it?", "en_short", true],
    ["Geeta", "ఈ రోజు వాతావరణం ఎలా ఉంది? నా క్యాలెండర్ లో ఏముంది?", "te", false],
    ["Geeta", "సమయం ఎంత?", "te_short", false],
    ["Lekha", "आज मौसम कैसा है? मेरे कैलेंडर में क्या है?", "hi", false],
  ];
  for (const [voice, text, name, english] of cases) {
    const wav = clip(voice, text, name);
    const t0 = Date.now();
    const heard = await detectSpokenLanguage(wav, cfg);
    const routedEnglish = heard.english >= NOT_ENGLISH_BELOW;
    ok(routedEnglish === english,
      `${name}: ${english ? "English → Piper" : "not English → Gemini Live"} (heard ${heard.language}, English ${heard.english.toFixed(2)}, ${Date.now() - t0} ms)`);
    if (english) {
      const said = await transcribeLocal(wav, cfg);
      ok(/weather|time/i.test(said), `${name}: the English transcript is intact: ${JSON.stringify(said)}`);
    }
  }
  stopSttServer();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} language-routing checks passed\n`);
process.exit(fail ? 1 : 0);
