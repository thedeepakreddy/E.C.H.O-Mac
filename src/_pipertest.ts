/**
 * Piper, the offline voice (voice/tts-stream.ts), and the fallback that hands a
 * reply to it when a cloud voice fails (voice/speech-stream.ts).
 *
 *   npm run pipertest
 *
 * Part one drives the real Piper install and is skipped if it is missing.
 * Part two uses fake voices, so it runs anywhere.
 */
import { EventEmitter } from "node:events";
import { SpeechStream, CLOUD_RETRY_MS } from "./voice/speech-stream.js";
import { PiperTtsStream, PiperWorker, piperPaths, DEFAULT_PIPER_VOICE } from "./voice/tts-stream.js";
import type { AudioPlayer } from "./voice/player.js";
import { DEFAULTS_FOR_TESTS, type JarvisConfig } from "./config.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
};

// ── the real Piper ───────────────────────────────────────────────────────────
console.log("\nPiper (real)\n");
ok(piperPaths("../../etc/passwd") === null, "a voice name cannot walk out of the voices folder");
ok(piperPaths("no_such-voice") === null, "a voice that is not installed is reported missing, not guessed");
const paths = piperPaths(DEFAULT_PIPER_VOICE);
if (!paths) {
  console.log(`  - skipped: ${DEFAULT_PIPER_VOICE} is not installed (npm run piper:setup)`);
} else {
  ok(paths.sampleRate === 22050, `sample rate read from the voice's own config (${paths.sampleRate})`);
  const stream = new PiperTtsStream(paths);
  const t0 = Date.now();
  await stream.open();
  ok(Date.now() - t0 < 10_000, `voice loaded in ${Date.now() - t0} ms`);
  ok(PiperWorker.for(paths) === PiperWorker.for(paths), "every stream for one voice shares one Piper process");

  const audio = new Map<number, number>();
  const done: number[] = [];
  stream.on("audio", (a: any) => audio.set(a.sentence, (audio.get(a.sentence) ?? 0) + a.pcm.length));
  stream.on("sentenceDone", (i: number) => done.push(i));
  const t1 = Date.now();
  let firstAt = 0;
  stream.once("audio", () => (firstAt = Date.now() - t1));
  stream.speak("Good evening.", 3);
  stream.speak("All systems are running normally.", 7);
  await stream.close();
  ok(done.join(",") === "3,7", "both sentences finish, in order, under their own indices");
  ok((audio.get(3) ?? 0) > 22050 && (audio.get(7) ?? 0) > (audio.get(3) ?? 0), "each carries real audio, the longer sentence more of it");
  ok(firstAt > 0 && firstAt < 2000, `first audio after ${firstAt} ms`);

  const second = new PiperTtsStream(paths);
  await second.open();
  const heard: number[] = [];
  second.on("audio", (a: any) => heard.push(a.sentence));
  second.speak("This one starts playing.", 0);
  second.speak("This one must never be heard.", 1);
  await until(() => heard.length > 0);
  second.abort();
  await sleep(1500);
  ok(!heard.includes(1), "abort drops the sentence that had not started");

  const again = new PiperTtsStream(paths);
  await again.open();
  let after = 0;
  again.on("sentenceDone", () => after++);
  again.speak("Still here.", 0);
  await again.close();
  ok(after === 1, "the shared process keeps working after another stream aborted");
  PiperWorker.for(paths).stop();
}

// ── failover, with fake voices ──────────────────────────────────────────────
console.log("\nFallback to the offline voice\n");

class FakePlayer extends EventEmitter implements AudioPlayer {
  readonly name = "fake";
  readonly aec = false;
  readonly frameSource = null;
  playing = false;
  playedMs = 0;
  async start() {}
  play() {
    if (this.playing) return;
    this.playing = true;
    this.emit("started");
    setTimeout(() => {
      this.playing = false;
      this.emit("drained");
    }, 5);
  }
  endSentence() {}
  stop() {
    this.playing = false;
  }
  dispose() {}
}

type Mode = "ok" | "open-fails" | "error-on-second" | "drop-after-partial";
class FakeVoice extends EventEmitter {
  spoken: string[] = [];
  readonly sampleRate = 24000;
  constructor(readonly name: string, private mode: Mode = "ok") {
    super();
  }
  async open() {
    if (this.mode === "open-fails") throw new Error("getaddrinfo ENOTFOUND api.example");
  }
  speak(text: string, sentence: number) {
    this.spoken.push(text);
    const n = this.spoken.length;
    setTimeout(() => {
      if (this.mode === "error-on-second" && n === 2) {
        this.emit("error", "quota exceeded");
        this.emit("sentenceDone", sentence);
        return;
      }
      if (this.mode === "drop-after-partial" && n === 2) {
        this.emit("audio", { pcm: Buffer.alloc(480), sampleRate: 24000, sentence });
        this.emit("closed");
        return;
      }
      if (this.mode === "drop-after-partial" && n > 2) return;
      this.emit("audio", { pcm: Buffer.alloc(480), sampleRate: 24000, sentence });
      this.emit("sentenceDone", sentence);
    }, 5);
  }
  async close() {}
  abort() {}
}

const cfg: JarvisConfig = { ...DEFAULTS_FOR_TESTS, voice: { ...DEFAULTS_FOR_TESTS.voice, ttsEngine: "sarvam", ttsStreaming: true, ttsEnabled: true, maxSpokenSentences: 0 } };

function rig(mode: Mode, clock = { t: 1_000_000 }) {
  const clouds: FakeVoice[] = [];
  const locals: FakeVoice[] = [];
  const speech = new SpeechStream(cfg, new FakePlayer(), {
    maxSentences: () => 0,
    createTts: () => {
      const v = new FakeVoice("sarvam-ws", mode);
      clouds.push(v);
      return v as any;
    },
    createOfflineTts: () => {
      const v = new FakeVoice("piper");
      locals.push(v);
      return v as any;
    },
    now: () => clock.t,
  });
  const spokenLocally = () => locals.flatMap((l) => l.spoken);
  return { speech, clouds, locals, spokenLocally, clock };
}
const quiet = (s: SpeechStream) => until(() => !s.isSpeaking);

{
  const r = rig("open-fails");
  r.speech.speakText("The network is down. I am still talking.");
  ok(await quiet(r.speech), "a reply whose cloud voice cannot connect still finishes");
  ok(r.spokenLocally().join(" | ") === "The network is down. | I am still talking.", "every sentence is spoken by the offline voice instead of dropped");
  ok(r.locals.length === 1, "one offline voice serves the whole reply");
}
{
  const r = rig("error-on-second");
  r.speech.speakText("First works. Second hits the quota. Third follows.");
  ok(await quiet(r.speech), "a reply whose cloud voice errors mid-way still finishes");
  ok(r.clouds[0].spoken[0] === "First works.", "the cloud voice spoke until it failed");
  ok(r.spokenLocally().join(" | ") === "Second hits the quota. | Third follows.", "the failed sentence and everything after it move to the offline voice");
  ok(!r.spokenLocally().includes("First works."), "a sentence that was already heard is not repeated");
}
{
  const r = rig("drop-after-partial");
  r.speech.speakText("One is fine. Two is cut off. Three never started.");
  ok(await quiet(r.speech), "a dropped connection does not leave Echo stuck speaking");
  ok(r.spokenLocally().join(" | ") === "Three never started.", "a half-heard sentence is let go; only unheard ones are re-spoken");
}
{
  const clock = { t: 5_000_000 };
  const r = rig("open-fails", clock);
  r.speech.speakText("Fails once.");
  await quiet(r.speech);
  const cloudsAfterFailure = r.clouds.length;
  clock.t += CLOUD_RETRY_MS - 1000;
  r.speech.newTurn();
  r.speech.speakText("Soon after.");
  await quiet(r.speech);
  ok(r.clouds.length === cloudsAfterFailure, "within the cooldown the cloud voice is not even tried");
  clock.t += 2000;
  r.speech.newTurn();
  r.speech.speakText("Much later.");
  await quiet(r.speech);
  ok(r.clouds.length === cloudsAfterFailure + 1, "after the cooldown the cloud voice gets another chance");
}
{
  const locals: FakeVoice[] = [];
  const speech = new SpeechStream({ ...cfg, voice: { ...cfg.voice, ttsEngine: "piper" } }, new FakePlayer(), {
    maxSentences: () => 0,
    createTts: () => new FakeVoice("piper", "error-on-second") as any,
    createOfflineTts: () => {
      const v = new FakeVoice("piper");
      locals.push(v);
      return v as any;
    },
  });
  speech.speakText("Local one. Local two. Local three.");
  ok(await quiet(speech), "an offline voice's own error does not hang the reply");
  ok(locals.length === 0, "and it is never 'failed over' to itself");
}

console.log(`\n${pass}/${pass + fail} piper checks passed\n`);
process.exit(fail ? 1 : 0);
