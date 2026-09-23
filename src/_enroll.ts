/**
 * Teach the built-in wake-word spotter what "Echo" sounds like.
 *
 *   npm run enroll -- --seed       synthesise "Echo" in every English voice on
 *                                  this Mac and calibrate the threshold against
 *                                  words that are NOT the name
 *   npm run enroll                 record YOU saying "Echo" five times
 *   npm run enroll -- --name Mom   ...for someone else who talks to Echo
 *
 * Writes models/wake/templates.json. Seed first; then enroll each person who
 * uses the machine — the spotter is only as speaker-independent as its
 * examples, and thirty seconds per person buys most of the accuracy.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mfccFrames, FRAME_DIMS, cmn, dtwEndAligned, HOP, WINDOW } from "./voice/wake/mfcc.js";
import type { TemplateStore } from "./voice/wake/template.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORE = join(ROOT, "models", "wake", "templates.json");
const args = process.argv.slice(2);
const seed = args.includes("--seed");
const who = args[args.indexOf("--name") + 1] && args.includes("--name") ? args[args.indexOf("--name") + 1] : process.env.USER ?? "user";

/** Words to say for positives, and words that must NOT match, for calibration. */
const POSITIVES = ["Echo", "Echo.", "Hey Echo", "Echo,"];
const NEGATIVES = ["Hello", "Okay", "Open Safari", "What time is it", "Taco", "Elbow", "Ever", "Let go", "Tempo", "Metro", "Alexa", "Hey Siri"];

function loadStore(): TemplateStore {
  if (existsSync(STORE)) {
    try {
      const s = JSON.parse(readFileSync(STORE, "utf8")) as TemplateStore;
      if (s.version === 1 && s.dims === FRAME_DIMS) return s;
    } catch {
      /* rebuild */
    }
  }
  return { version: 1, dims: FRAME_DIMS, threshold: 0, templates: [] };
}

function readWav16k(path: string): Int16Array {
  const buf = readFileSync(path);
  // Walk chunks to the data chunk; afconvert writes a canonical header but be safe.
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(buf.buffer, buf.byteOffset + off + 8, Math.floor(size / 2));
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

/** Keep the spoken part: frames from the first to the last 10 ms slice above 8 % of the peak energy, with a little margin. */
function trimSilence(samples: Int16Array): Int16Array {
  const hop = HOP;
  const energies: number[] = [];
  for (let off = 0; off + WINDOW <= samples.length; off += hop) {
    let s = 0;
    for (let i = 0; i < WINDOW; i++) s += samples[off + i] * samples[off + i];
    energies.push(Math.sqrt(s / WINDOW));
  }
  const peak = Math.max(...energies);
  // Gate between the quiet floor and the peak, not at a fixed 8% OF the peak.
  // On a microphone with a poor signal-to-noise ratio — measured here, speech
  // at RMS ~500 over a floor of ~250 — 8% of the peak lands BELOW the room
  // noise, so every frame counts as speech, nothing is trimmed, and the take
  // comes back the full window long. Anchoring to the floor adapts to the
  // actual contrast in the recording.
  const sortedE = [...energies].sort((a, b) => a - b);
  const floorE = sortedE[Math.floor(sortedE.length * 0.2)] || 0;
  const gate = Math.max(peak * 0.08, floorE + (peak - floorE) * 0.25);
  let first = energies.findIndex((e) => e > gate);
  let last = energies.length - 1 - [...energies].reverse().findIndex((e) => e > gate);
  if (first < 0) return samples;
  first = Math.max(0, first - 3);
  last = Math.min(energies.length - 1, last + 5);
  return samples.subarray(first * hop, Math.min(samples.length, last * hop + WINDOW));
}

function toFloat(s: Int16Array): Float32Array {
  const f = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
  return f;
}

async function synth(text: string, voice: string, rate: number): Promise<Int16Array> {
  const aiff = join(tmpdir(), `enroll-${process.pid}-${Date.now()}.aiff`);
  const wav = aiff.replace(/\.aiff$/, ".wav");
  await run("/usr/bin/say", ["-v", voice, "-r", String(rate), "-o", aiff, text]);
  await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const s = readWav16k(wav);
  try { unlinkSync(aiff); unlinkSync(wav); } catch { /* ignore */ }
  return s;
}

async function englishVoices(): Promise<string[]> {
  const { stdout } = await run("/usr/bin/say", ["-v", "?"]);
  const names = stdout
    .split("\n")
    .filter((l) => /\ben_(US|GB|AU|IN|IE|ZA|CA|SC)\b/.test(l))
    .map((l) => l.trim().split(/\s{2,}|\s(?=en_)/)[0].trim())
    .filter(Boolean);
  // Novelty voices make poor examples of anyone's speech.
  const skip = /^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Pipe Organ|Trinoids|Whisper|Zarvox|Albert|Fred|Junior|Kathy|Ralph|Jester|Organ|Superstar|Wobble|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley)\b/i;
  return [...new Set(names)].filter((n) => !skip.test(n));
}

function framesOf(samples: Int16Array): number[][] {
  return cmn(mfccFrames(toFloat(trimSilence(samples)))).map((f) => Array.from(f));
}

async function seedStore(): Promise<void> {
  const voices = await englishVoices();
  if (!voices.length) throw new Error("no English voices found via `say -v ?`");
  console.log(`\nSeeding "Echo" templates from ${voices.length} voices: ${voices.join(", ")}\n`);
  const store = loadStore();
  store.templates = store.templates.filter((t) => t.source !== "seed");
  const positives: Float32Array[][] = [];
  for (const voice of voices) {
    for (const text of POSITIVES) {
      for (const rate of [170, 215]) {
        try {
          const frames = framesOf(await synth(text, voice, rate));
          if (frames.length < 20 || frames.length > 110) continue;
          store.templates.push({ name: `${voice}:${text}@${rate}`, source: "seed", frames });
          positives.push(frames.map((f) => Float32Array.from(f)));
        } catch (err: any) {
          console.log(`  skip ${voice} "${text}": ${err?.message ?? err}`);
        }
      }
    }
    process.stdout.write(".");
  }
  console.log(`\n  ${positives.length} positive templates`);

  // Calibrate: each positive scored against all OTHER voices' templates
  // (leave-one-voice-out), each negative against everything.
  const byVoice = new Map<string, Float32Array[][]>();
  for (const t of store.templates) {
    const v = t.name.split(":")[0];
    if (!byVoice.has(v)) byVoice.set(v, []);
    byVoice.get(v)!.push(t.frames.map((f) => Float32Array.from(f)));
  }
  const posCosts: number[] = [];
  for (const [v, mine] of byVoice) {
    const others = [...byVoice.entries()].filter(([o]) => o !== v).flatMap(([, t]) => t);
    for (const p of mine) posCosts.push(Math.min(...others.map((t) => dtwEndAligned(t, p))));
  }
  const negCosts: number[] = [];
  const all = store.templates.map((t) => t.frames.map((f) => Float32Array.from(f)));
  for (const voice of voices.slice(0, 6)) {
    for (const text of NEGATIVES) {
      try {
        const frames = cmn(mfccFrames(toFloat(trimSilence(await synth(text, voice, 190)))));
        negCosts.push(Math.min(...all.map((t) => dtwEndAligned(t, frames))));
      } catch {
        /* skip */
      }
    }
  }
  posCosts.sort((a, b) => a - b);
  negCosts.sort((a, b) => a - b);
  const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const pos90 = q(posCosts, 0.9); // 90 % of unseen-voice positives under this
  const neg05 = q(negCosts, 0.05); // 5 % of negatives under this
  // Sit between them; when they overlap, favour recall — whisper verifies anyway.
  const threshold = pos90 < neg05 ? (pos90 + neg05) / 2 : pos90;
  store.threshold = Number(threshold.toFixed(3));
  console.log(`  positives (unseen voice): median ${q(posCosts, 0.5).toFixed(2)} · p90 ${pos90.toFixed(2)}`);
  console.log(`  negatives:                 p5 ${neg05.toFixed(2)} · median ${q(negCosts, 0.5).toFixed(2)}`);
  console.log(`  threshold -> ${store.threshold}${pos90 >= neg05 ? "  (overlap: relying on whisper verification for precision)" : ""}`);
  save(store);
}

/** PvRecorder's fixed rate, and how much fresh audio one take keeps. */
const RECORDER_RATE = 16000;
const TAKE_MS = 1800;
/** Speech has to be this much louder than the take's own quiet frames. */
const SPEECH_OVER_FLOOR = 3;
/** Fewer good takes than this is a worse spotter than none — see enrollPerson. */
const MIN_TAKES = 3;
/**
 * How long a template may be, derived from the 69 SEEDED "Echo" templates:
 * 30..77 frames, median 44. The old 20..110 was nearly three times that spread,
 * and the cost is not merely a sloppy template — it destroys the spotter.
 *
 * Measured: five takes of 103/102/92/24/54 frames were accepted, and the
 * wake-engine costs then collapsed from
 *   positives 19.4 19.8 19.4 … | negatives 19.5 22.1 … 22.1 21.7
 * to
 *   positives 19.0 19.0 19.0 … | negatives 19.0 19.0 … 19.0 19.0
 * — every word scoring the same. A one-second template is mostly silence, and
 * DTW matches silence against anything, so an over-long example becomes a
 * universal weak match that flattens the separation between "Echo" and "Taco".
 * Stay near the length of the actual word.
 */
const MIN_FRAMES = 30;
const MAX_FRAMES = 80;

async function enrollPerson(): Promise<void> {
  const { PvRecorder } = await import("@picovoice/pvrecorder-node");
  const store = loadStore();
  const rec = new PvRecorder(512, -1);
  rec.start();
  console.log(`\nEnrolling ${who}. Say "Echo" when prompted — five times, normal voice, normal distance.\n`);
  // A rejected take retries by decrementing n, which never terminates if the
  // microphone is silent — the wrong input device, a denied permission, or
  // simply nobody speaking. That is an infinite loop holding the mic open, so
  // the retries are bounded and the reason is said out loud.
  let rejected = 0;
  const MAX_REJECTED = 12;
  for (let n = 1; n <= 5; n++) {
    if (rejected >= MAX_REJECTED) {
      console.log(
        `\n  giving up after ${rejected} unusable takes — is the right microphone selected, and is Echo allowed to use it?` +
        `\n  \`npm run miccheck\` lists the input devices.\n`
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 600));
    process.stdout.write(`  ${n}/5  say "Echo" now... `);
    const frames: Int16Array[] = [];
    const start = Date.now();
    while (Date.now() - start < TAKE_MS) frames.push(await rec.read());
    const total = new Int16Array(frames.length * 512);
    frames.forEach((f, i) => total.set(f, i * 512));
    // The recorder runs continuously, so audio piles up in its buffer during
    // the pause and the console write between takes — and the loop above then
    // reads that stale audio instantly BEFORE any live audio arrives. Every
    // take came out 2.4s long (600ms of buffer + a 1.8s window), a constant
    // 241 frames, which is always over the limit: enrolment could never
    // succeed, whatever the user said. Keep only the newest TAKE_MS.
    const want = (TAKE_MS / 1000) * RECORDER_RATE;
    const fresh = total.length > want ? total.subarray(total.length - want) : total;

    // Name the real problem rather than a symptom. `trimSilence` finds the word
    // by its energy PEAK, so on a microphone whose gain is turned down there is
    // no peak to find, nothing gets trimmed, and every take comes back the full
    // window long. The message then said "too long — say just the word", which
    // is advice about the one thing that was not wrong: the speaking. Measured
    // on this machine at input volume 18/100, room noise and speech both sat
    // around RMS 2–37 and were indistinguishable.
    // Compared against the take's OWN noise floor, not an absolute level. An
    // absolute threshold is wrong at every gain but one: at input volume 18 the
    // room measured RMS 17 and at 75 it measured 78, so any fixed number is
    // either deaf or permanently tripped. What actually matters is whether one
    // part of the take stands out from the rest — which is exactly what
    // `trimSilence` needs to find the word, and exactly what is missing when
    // the gain is too low.
    const frameRms: number[] = [];
    for (let off = 0; off + 400 <= fresh.length; off += 160) {
      let s2 = 0;
      for (let i = 0; i < 400; i++) s2 += fresh[off + i] * fresh[off + i];
      frameRms.push(Math.sqrt(s2 / 400));
    }
    const sorted = [...frameRms].sort((a, b) => a - b);
    // The 20th percentile, NOT the median. The median is only the noise floor
    // when speech is a minority of the take — and at these prompts it is not:
    // a clearly-spoken "Echo" filled enough of the 1.8s window that the median
    // WAS speech, so peak/median came out at a flat ~2.0 every single time and
    // every take was rejected as "no speech". Measured on this machine: peaks
    // of 137/165/191/444/504 against medians of 73/81/104/222/251.
    const floor = sorted[Math.floor(sorted.length * 0.2)] || 1;
    const peak = sorted[sorted.length - 1] || 0;
    if (peak < floor * SPEECH_OVER_FLOOR) {
      console.log(
        `no speech stood out from the background (peak ${peak.toFixed(0)} vs floor ${floor.toFixed(0)}).` +
        `\n       Either nothing was said, or the microphone gain is too low —` +
        ` osascript -e 'set volume input volume 75'`
      );
      rejected++;
      n--;
      continue;
    }

    // ECHO_ENROLL_DEBUG=1 writes each take to /tmp and prints its energy
    // profile. Rejections describe a symptom; the profile shows what the
    // microphone actually heard, which is the only way to tell "spoke too long"
    // from "the room never goes quiet" from "the gate is in the wrong place".
    if (process.env.ECHO_ENROLL_DEBUG === "1") {
      const wav = join(tmpdir(), `echo-take-${n}-${Date.now()}.wav`);
      const head = Buffer.alloc(44);
      head.write("RIFF", 0); head.writeUInt32LE(36 + fresh.length * 2, 4); head.write("WAVE", 8);
      head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
      head.writeUInt32LE(RECORDER_RATE, 24); head.writeUInt32LE(RECORDER_RATE * 2, 28);
      head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
      head.write("data", 36); head.writeUInt32LE(fresh.length * 2, 40);
      const pcm = Buffer.alloc(fresh.length * 2);
      for (let i = 0; i < fresh.length; i++) pcm.writeInt16LE(fresh[i], i * 2);
      writeFileSync(wav, Buffer.concat([head, pcm]));
      const tenth = Math.max(1, Math.floor(frameRms.length / 20));
      const bars = frameRms.filter((_, i) => i % tenth === 0).map((r) => Math.round(r)).join(" ");
      console.log(`\n       [debug] ${wav}`);
      console.log(`       [debug] p20 ${floor.toFixed(0)}  p50 ${sorted[Math.floor(sorted.length/2)].toFixed(0)}  peak ${peak.toFixed(0)}`);
      console.log(`       [debug] profile: ${bars}`);
    }

    const f = framesOf(fresh);
    if (f.length < MIN_FRAMES || f.length > MAX_FRAMES) {
      console.log(
        `${f.length < MIN_FRAMES ? "too short" : "too long"} (${(f.length / 100).toFixed(1)}s; "Echo" should be about 0.4s)` +
        `${f.length < MIN_FRAMES
            ? " — say the whole word, do not clip the end"
            : " — say just the word and stop; a pause on either side gets recorded too"} — try again`
      );
      rejected++;
      n--;
      continue;
    }
    store.templates.push({ name: `${who}:enroll:${Date.now()}`, source: "enroll", frames: f });
    console.log(`ok (${f.length} frames)`);
  }
  rec.stop();
  rec.release();

  // A PARTIAL enrolment is worse than none. Measured: a single clipped 28-frame
  // take (a clean "Echo" is ~44) added to 69 seeded templates pulled the
  // spotter's firing point 384ms earlier and broke a wake-engine case that had
  // passed all session. One bad example does not average out — it widens what
  // the matcher will accept. So either enough good takes, or nothing.
  const fresh = store.templates.filter((t) => t.source === "enroll" && t.name.startsWith(`${who}:enroll:`)).length;
  if (fresh < MIN_TAKES) {
    console.log(
      `\n  only ${fresh} usable take${fresh === 1 ? "" : "s"} of ${MIN_TAKES} needed — the template store is UNCHANGED.` +
      `\n  A part-finished enrolment makes the spotter worse, not better, so nothing was saved.` +
      `\n  Try again somewhere quieter, saying just "Echo" clearly at each prompt.\n`
    );
    return;
  }
  if (!store.threshold) store.threshold = 20;
  save(store);
}

function save(store: TemplateStore): void {
  mkdirSync(join(ROOT, "models", "wake"), { recursive: true });
  writeFileSync(STORE, JSON.stringify(store));
  const seeds = store.templates.filter((t) => t.source === "seed").length;
  console.log(`\n  saved ${store.templates.length} templates (${seeds} seed, ${store.templates.length - seeds} enrolled), threshold ${store.threshold}`);
  console.log(`  -> ${STORE}\n`);
}

try {
  if (seed) await seedStore();
  else await enrollPerson();
} catch (err: any) {
  console.error(`enroll failed: ${err?.message ?? err}`);
  process.exit(1);
}
