/**
 * A reply in another language has to be HEARD, not just shown.
 *   npm run scriptvoicetest
 *
 * Reported symptom: "apart from English, when it is speaking any other
 * language, it just shows the message but couldn't speak."
 *
 * The cause was not the voice engine — Gemini's voice reads Telugu and Hindi
 * perfectly well. It was the fallback. `offlineTtsStream` is Piper with an
 * English model, or macOS `say` with an English voice, and neither REFUSES a
 * line of Telugu: they emit silence or a mangled transliteration. So one
 * rate-limited cloud call set `onFallback`, and from then on the rest of the
 * reply went to a voice that cannot pronounce a word of it — while the text
 * appeared on screen as though it had been spoken.
 *
 * Worse, the script-switch check that existed carried `&& !this.onFallback`
 * — "not while standing in for a failed voice" — so the one situation that
 * put Echo on an English-only voice was the one situation where it refused
 * to switch off it.
 */
import { EventEmitter } from "node:events";
import { SpeechStream, CLOUD_RETRY_MS } from "./voice/speech-stream.js";
import { OFFLINE_STREAMS, STREAMING_ENGINES, createTtsStream, type TtsStream } from "./voice/tts-stream.js";
import { DEFAULTS_FOR_TESTS } from "./config.js";
import { loadEnv } from "./env.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

loadEnv(process.cwd());

const TELUGU = "నమస్కారం, ఈరోజు వాతావరణం చాలా బాగుంది.";
const ENGLISH = "The weather today is very good.";

/** A player that swallows everything; nothing here is about audio output. */
function player(): any {
  const p: any = new EventEmitter();
  p.playedMs = 0; p.name = "test"; p.aec = false;
  p.write = () => {}; p.endSentence = () => {}; p.beginSentence = () => {};
  p.stop = () => {}; p.reset = () => {}; p.close = () => {};
  return p;
}

/** A named stream that never produces audio; `openFails` makes it die on open. */
function stubStream(name: string, openFails = false): TtsStream {
  const s: any = new EventEmitter();
  s.name = name; s.sampleRate = 24000;
  s.open = async () => { if (openFails) throw new Error("rate limited"); };
  s.speak = () => {}; s.abort = () => {}; s.close = async () => {};
  return s as TtsStream;
}

function build(opts: { createTts?: any; createOfflineTts?: any; engine?: string } = {}) {
  const cfg = structuredClone(DEFAULTS_FOR_TESTS);
  cfg.voice.ttsEngine = (opts.engine ?? "gemini") as any;
  return new SpeechStream(cfg as any, player(), { maxSentences: () => 10, ...opts });
}

// Two different failures, and the difference decides what CAN be done:
//
//   a cloud voice that is not Gemini dies  -> Gemini can still read Telugu
//   Gemini itself dies                     -> nothing can; do not loop on it
//
// Conflating them is how the first version of this fix turned into an
// infinite fallback. `sarvam-ws` stands in for the first case.
const otherCloud = () => stubStream("sarvam-ws", true);

console.log("\nA reply in another language must be spoken, not just shown\n");

console.log("  when the cloud voice fails on a Telugu reply");
{
  // The exact shape of the bug: the configured voice cannot open (quota,
  // network, bad key) and something has to speak the line anyway.
  const s: any = build({ engine: "sarvam", createTts: otherCloud });
  await s.ensureTts(TELUGU);
  const chosen = s.tts?.name ?? "(none)";
  ok(!!s.tts, "a voice was chosen at all", chosen);
  ok(!OFFLINE_STREAMS.has(chosen),
    `it is not the English-only local voice (${chosen})`,
    `${chosen} cannot pronounce Telugu — this is the silence the user reported`);
}

console.log("\n  and the English case is unchanged");
{
  const s: any = build({ engine: "sarvam", createTts: otherCloud });
  await s.ensureTts(ENGLISH);
  ok(OFFLINE_STREAMS.has(s.tts?.name ?? ""),
    `English still falls back to the local voice (${s.tts?.name})`,
    "falling back to the cloud for English would spend money for nothing");
}

console.log("\n  a voice already standing in is still replaced for another script");
{
  // `&& !this.onFallback` was the whole bug: being ON the fallback is the
  // most common way to be stuck on an English-only voice.
  const s: any = build({ engine: "sarvam", createTts: otherCloud });
  await s.ensureTts(ENGLISH);            // now on the local voice, onFallback = true
  ok(s.onFallback === true, "the English sentence left it on the fallback");
  const before = s.tts?.name;
  await s.ensureTts(TELUGU);             // a Telugu sentence in the same reply
  ok(!OFFLINE_STREAMS.has(s.tts?.name ?? ""),
    `the Telugu sentence moved it off ${before} (now ${s.tts?.name})`,
    "this is the regression: it used to stay on the English voice for the rest of the reply");
}

console.log("\n  it does not fall back to the voice that just failed");
{
  // Reported as "the Telugu voice is coming very late". With ttsEngine
  // "gemini" and the TTS quota spent, the cloud voice was BOTH the configured
  // engine and the only one that can read Telugu — so the fallback handed
  // back the thing that had just failed, forever, one REST round trip a lap.
  // `GeminiTtsStream.open()` is a no-op, so every replacement reported
  // success and only failed later on `speak`, which is why it spun instead of
  // erroring. English never looped: its fallback is Piper.
  let built = 0;
  const s: any = build({ createTts: () => { built++; return stubStream("gemini-tts", true); } });
  await s.ensureTts(TELUGU);
  const first = s.tts?.name;
  // Now simulate the reply continuing: more sentences, same dead cloud.
  for (let i = 0; i < 5; i++) await s.ensureTts(TELUGU);
  ok(built <= 2, `the dead cloud voice is not rebuilt on every sentence (built ${built})`,
    "each rebuild is a network round trip, and this is the delay the user heard");
  ok(OFFLINE_STREAMS.has(s.tts?.name ?? ""),
    `it settles on something that answers instantly (${s.tts?.name})`,
    `still on ${first} — the voice that cannot work right now`);
}

console.log("\n  but once the cloud has had time to recover, it is used again");
{
  // The cooldown must not become permanent: a momentary 429 should not cost
  // the only Telugu-capable voice for the rest of the session.
  let t = 0;
  const s: any = build({ createTts: () => stubStream("gemini-tts", true) });
  s.opts.now = () => t;
  await s.ensureTts(TELUGU);
  ok(OFFLINE_STREAMS.has(s.tts?.name ?? ""), "right after the failure it stays local");
  t += CLOUD_RETRY_MS + 1;
  s.tts = null;
  const back = s.fallbackFor(TELUGU);
  ok(!OFFLINE_STREAMS.has(back.name), `and reaches for the Gemini voice again after the cooldown (${back.name})`);
}

console.log("\n  a mid-reply collapse picks the voice for what is still owed");
{
  const s: any = build({ engine: "sarvam", createTts: () => stubStream("sarvam-ws") });
  await s.ensureTts(TELUGU);
  s.sentences = [TELUGU];
  s.awaitingAudio = new Set([0]);
  await s.failOver(s.tts, s.generation);
  ok(!OFFLINE_STREAMS.has(s.tts?.name ?? ""),
    `the replacement can read the owed sentence (${s.tts?.name})`);
}

// ── the streaming path has to be switched on at all ──────────────────────
//
// All of the above lives in SpeechStream, and main.ts only builds one when
// the configured engine is in a list — which was hardcoded separately from
// the switch that implements the streams, and had drifted. `gemini` and
// `piper` both have a stream and neither was in it, so with
// `ttsEngine: "gemini"` the log said "streaming speech: off (file path)" and
// every reply went to the non-streaming tts.ts, which has no gemini branch
// either and lands on Piper. Piper is English only. That is how a Telugu
// reply came out in an English voice while every fix above sat unused.
console.log("\n  every engine that HAS a stream is allowed to use one");
{
  const engines = ["sarvam", "elevenlabs", "gemini", "mac", "piper"] as const;
  for (const e of engines) {
    const cfg = structuredClone(DEFAULTS_FOR_TESTS);
    cfg.voice.ttsEngine = e as any;
    const stream = createTtsStream(cfg as any, "hello");
    // The two must agree in BOTH directions, or one of them is dead weight.
    ok(!!stream === STREAMING_ENGINES.has(e),
      `${e}: has a stream (${!!stream}) and is allowed one (${STREAMING_ENGINES.has(e)})`,
      "the allowlist and the implementations have drifted apart again");
    try { (stream as any)?.abort?.(); } catch { /* nothing opened */ }
  }
  // And the ones that genuinely have no stream stay out.
  for (const e of ["fakeyou", "local-clone"]) {
    ok(!STREAMING_ENGINES.has(e), `${e} is correctly left out — it returns a file path, not a stream`);
  }
}

console.log(`\n${pass}/${pass + fail} script-voice cases passed`);
console.log("A failure here means a non-English reply is shown on screen and never heard.\n");
process.exit(fail === 0 ? 0 : 1);
