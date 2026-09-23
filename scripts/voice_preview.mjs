#!/usr/bin/env node
/**
 * Hear every Gemini Live voice before picking one.   npm run voicepreview
 *
 * Speech-to-speech means the voice IS the model — Echo cannot use a custom or
 * cloned voice in realtime mode, only one of Google's prebuilt set. The only
 * sensible way to choose is by ear, so this renders the same line in each voice
 * and writes them as playable WAVs.
 *
 *   npm run voicepreview                 # all of them
 *   npm run voicepreview Kore Charon     # just these
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";

const ROOT = resolve(import.meta.dirname, "..");

// Tiny .env read rather than importing the app: this script must run without
// building, and loadEnv lives in TypeScript.
for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
  const t = line.trim().replace(/^export\s+/, "");
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if (v.length >= 2 && /^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const ALL = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr", "Sulafat", "Achernar"];
const voices = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const LINE = process.env.ECHO_PREVIEW_LINE
  || "Good evening. I'm Echo. Your build finished, and two tests are still failing.";

const key = process.env.GEMINI_API_KEY;
if (!key) { console.error("no GEMINI_API_KEY in .env"); process.exit(1); }

const outDir = join(ROOT, ".voice-preview");
mkdirSync(outDir, { recursive: true });
const ai = new GoogleGenAI({ apiKey: key });

/** Wrap raw 24 kHz mono PCM16 in a WAV header so it plays anywhere. */
function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(24000 * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

console.log(`\nRendering ${voices.length} voice(s) saying:\n  "${LINE}"\n`);
for (const voice of voices) {
  const chunks = [];
  let done = false, err = "";
  try {
    const session = await ai.live.connect({
      model: process.env.ECHO_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025",
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        systemInstruction: `Say exactly this and nothing else: ${LINE}`,
      },
      callbacks: {
        onmessage: (m) => {
          for (const p of m.serverContent?.modelTurn?.parts ?? []) {
            if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, "base64"));
          }
          if (m.serverContent?.turnComplete) done = true;
        },
        onerror: (e) => { err = String(e?.message ?? e); done = true; },
        onclose: () => { done = true; },
      },
    });
    session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "go" }] }], turnComplete: true });
    const deadline = Date.now() + 20000;
    while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    session.close();
  } catch (e) { err = String(e?.message ?? e); }

  const pcm = Buffer.concat(chunks);
  if (!pcm.length) { console.log(`  ${voice.padEnd(10)} FAILED ${err.slice(0, 70)}`); continue; }
  const file = join(outDir, `${voice}.wav`);
  writeFileSync(file, wav(pcm));
  console.log(`  ${voice.padEnd(10)} ${(pcm.length / 2 / 24000).toFixed(1)}s  ${file}`);
}

console.log(`\nPlay them:  afplay .voice-preview/Kore.wav`);
console.log(`Then set:   config.json -> voice.realtime.voice = "Kore"\n`);
