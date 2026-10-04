/**
 * Talking over Echo without cutting it off.   npm run interjectiontest
 *
 * The complaint this exists for: "while Echo is speaking, a sound comes and it
 * listens — it is not completing the script." Every barge-in cut the voice
 * dead, so a door, a laugh or a chair cost the rest of an answer that nobody
 * had heard yet, and even a real interruption threw away the sentence in
 * progress.
 *
 * Echo now keeps talking and records instead. Two things have to be true for
 * that to work, and both are checked here against the REAL listener rather
 * than a re-implementation of it — the previous barge-in test mirrored the
 * maths, and the bugs since have all been in the state machine around it:
 *
 *   1. a capture can run WHILE playback continues, and arrives as an
 *      interjection rather than as a command
 *   2. Echo's own voice can be subtracted from what that capture heard, since
 *      hardware echo cancellation does not work on this machine and the
 *      recording therefore holds both speakers
 *
 * The dangerous direction is (2) being too aggressive: deleting words the USER
 * said corrupts the command Echo then acts on. Both directions are pinned.
 */
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VoiceListener, SAMPLE_RATE, FRAME_LENGTH, type FrameSource, type CaptureMeta } from "./voice/listener.js";
import { stripEchoWords, classifyInterjection, isEchoItself, isStopIntent } from "./voice/interjection.js";
import { DEFAULTS_FOR_TESTS } from "./config.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

console.log("\nHearing someone out without stopping\n");

// ── subtracting Echo's own voice ──────────────────────────────────────────

console.log("  Echo's own words come back out of the transcript");
{
  // What the microphone actually produces mid-reply: the pre-roll is Echo
  // alone, then the user on top of it.
  const script = "The build finished in about forty seconds and all the tests passed.";
  ok(stripEchoWords("and all the tests passed no wait show me the errors", script)
       === "no wait show me the errors",
     "the leading leak is removed and the user's words survive intact",
     stripEchoWords("and all the tests passed no wait show me the errors", script));

  ok(stripEchoWords("The build finished in about forty seconds", script) === "",
     "a transcript that is ONLY Echo comes back empty",
     stripEchoWords("The build finished in about forty seconds", script));

  ok(stripEchoWords("open the settings", script) === "open the settings",
     "a transcript with no leak is untouched");

  ok(stripEchoWords("hello there", "") === "hello there",
     "and nothing is stripped when Echo has said nothing yet");
}

console.log("\n  but it never eats what the person said");
{
  // The expensive mistake. Short overlaps between two people discussing the
  // same subject are constant, and deleting them corrupts the command.
  ok(stripEchoWords("the tests", "all the tests passed") === "the tests",
     "a two-word overlap is coincidence, not leakage",
     stripEchoWords("the tests", "all the tests passed"));

  const said = stripEchoWords("no I meant the other one", "I will open the other window for you");
  ok(said.includes("no I meant"), "the user's own opening survives a partial overlap", said);

  // Echoing a phrase back at Echo is a real thing people do.
  const echoed = stripEchoWords("run the tests again", "running the tests now");
  ok(echoed === "run the tests again", "repeating Echo's subject back is not treated as leakage", echoed);
}

// ── what the interruption was ─────────────────────────────────────────────

console.log("\n  telling a stop from a command from a noise");
{
  const cases: Array<[string, string]> = [
    ["stop", "stop"],
    ["Stop.", "stop"],
    ["okay echo stop", "stop"],
    ["never mind", "stop"],
    ["shut up", "stop"],
    ["wait", "stop"],
    ["ఆపు", "stop"],
    ["ruko", "stop"],
    ["", "noise"],
    ["a", "noise"],
    ["open my email instead", "command"],
    ["no the other one", "command"],
    // The trap: a stop word inside something that is plainly an instruction.
    ["don't stop the music", "command"],
    ["wait until the build finishes then deploy", "command"],
    ["stop the server on port three thousand", "command"],
  ];
  for (const [text, want] of cases) {
    const got = classifyInterjection(text);
    ok(got === want, `${JSON.stringify(text)} -> ${want}`, `got ${got}`);
  }
  // One list of stop words, shared with the ordinary command path. Two lists
  // drifting apart is exactly how the risk gate ended up denying `rm` and
  // allowing `unlink`.
  ok(isStopIntent("stop") && !isStopIntent("stop the server"),
     "the same stop rule the typed/spoken command path uses is the one exported here");
}

// ── the listener, for real ────────────────────────────────────────────────

const FRAME = FRAME_LENGTH; // samples per frame, as the recorder delivers them
const QUIET = 20, LOUD = 9000;

/** A frame source the test drives by hand, one frame per read. */
function source(levels: () => number): FrameSource & { readonly reads: number } {
  let reads = 0;
  return {
    aec: false,
    describe: () => "test source",
    stop() {}, release() {},
    async read() {
      // A real recorder blocks on the sound card. Resolving immediately would
      // keep the listener's loop entirely in microtasks, which starves every
      // timer in the process — including this test's own.
      await new Promise((r) => setImmediate(r));
      reads++;
      const amp = levels();
      const f = new Int16Array(FRAME);
      // Alternating +/- amplitude: constant RMS, and not digital silence,
      // which the listener treats as a dead microphone.
      for (let i = 0; i < FRAME; i++) f[i] = i % 2 ? amp : -amp;
      return f;
    },
    get reads() { return reads; },
  };
}

function listenerUnderTest() {
  const cfg = structuredClone(DEFAULTS_FOR_TESTS);
  cfg.voice.bargeIn = true;
  cfg.voice.silenceMs = 300;
  cfg.voice.maxUtteranceMs = 10_000;
  cfg.voice.wakeTranscriptFallback = false; // no always-on capture confusing the picture
  let level = QUIET;
  const src = source(() => level);
  const l = new VoiceListener(cfg, src);
  const events: Array<{ name: string; args: any[] }> = [];
  for (const e of ["bargein", "interjection", "utterance", "discarded", "listening"]) {
    l.on(e, (...args: any[]) => events.push({ name: e, args }));
  }
  return { listener: l, cfg, events, set: (n: number) => { level = n; }, src };
}

/** Let the read loop run until it has consumed at least `n` more frames. */
async function frames(src: { reads: number }, n: number) {
  const target = src.reads + n;
  const deadline = Date.now() + 10_000;
  while (src.reads < target && Date.now() < deadline) await new Promise((r) => setImmediate(r));
}

/**
 * Let real time pass while frames keep flowing.
 *
 * The barge-in settling window is wall-clock (`Date.now() - speakingSince`),
 * because it exists to cover how long a synthesiser takes to make its first
 * sound. This harness consumes frames as fast as the event loop allows, so
 * frame count and elapsed time come apart and only real waiting will clear it.
 */
async function settle(src: { reads: number }, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) await frames(src, 4);
}

/** How much audio actually ended up in a capture, header excluded. */
function wavMs(path: string): number {
  const bytes = statSync(path).size - 44;
  return (bytes / 2 / SAMPLE_RATE) * 1000;
}

/** The level of the first `ms` of a capture — what the ring buffer had in it. */
function openingLevel(path: string, ms = 300): number {
  const buf = readFileSync(path).subarray(44);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const n = Math.min(pcm.length, Math.round((ms / 1000) * SAMPLE_RATE));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += pcm[i] * pcm[i];
  return Math.round(Math.sqrt(sum / Math.max(1, n)));
}

console.log("\n  a reply is NOT cut short — the capture runs over the top of it");
{
  const t = listenerUnderTest();
  await t.listener.start();
  await frames(t.src, 40);            // settle the noise floor on a quiet room

  t.listener.setPaused(true);          // Echo starts speaking
  t.set(600);                          // its own voice arriving at the mic
  await settle(t.src, 1700);           // past the wall-clock settling window

  t.set(LOUD);                         // someone talks over it
  await frames(t.src, 20);
  const barge = t.events.find((e) => e.name === "bargein");
  ok(!!barge, "barge-in is detected while Echo speaks");

  // This is what main.ts does in "finish" mode: record, do not stop.
  t.listener.captureInterjection("turn-1");
  ok(t.listener.capturingInterjection, "a capture starts even though playback is still paused-for-speech");

  await frames(t.src, 20);             // they keep talking
  t.set(QUIET);                        // and stop
  await frames(t.src, 40);             // silence endpoints it

  const inter = t.events.find((e) => e.name === "interjection");
  ok(!!inter, "it arrives as an `interjection`", t.events.map((e) => e.name).join(","));
  ok(!t.events.some((e) => e.name === "utterance"),
     "and NOT as an ordinary utterance, which would have been answered mid-reply");
  const meta: CaptureMeta | undefined = inter?.args[1];
  ok(meta?.overlap === true, "flagged as overlapping Echo's own voice");
  // `listening` means two things downstream: the HUD switches out of
  // "speaking", and a streaming-STT connection opens and is fed every frame.
  // Neither is right for a recording of Echo's own voice made while it talks.
  ok(!t.events.some((e) => e.name === "listening"),
     "and it never announced itself as listening — that would flip the HUD and open a cloud STT stream mid-reply");
  ok(meta?.wake === "bargein", "and attributed to the interruption");
  ok(meta?.turnId === "turn-1", "carrying the turn it interrupted", String(meta?.turnId));
  await t.listener.stop();
}

console.log("\n  the first syllable is not lost to the detection delay");
{
  // Barge-in only confirms after ~190ms of sustained speech, so by the time
  // anyone can ask for a recording the start of the word is already gone
  // unless the ring buffer was being filled during playback.
  const t = listenerUnderTest();
  await t.listener.start();
  await frames(t.src, 40);
  t.listener.setPaused(true);
  t.set(600);
  await settle(t.src, 1700);
  t.set(LOUD);
  await frames(t.src, 20);
  t.listener.captureInterjection();
  await frames(t.src, 10);
  t.set(QUIET);
  await frames(t.src, 40);
  const inter = t.events.find((e) => e.name === "interjection");
  const meta: CaptureMeta | undefined = inter?.args[1];
  ok(!!inter, "the interjection was captured");
  // `durationMs` counts only what arrived AFTER the trigger; the pre-roll is
  // prepended to the audio itself. So the file is the only place the answer
  // lives, and it must be substantially longer than the live part alone.
  const audio = inter ? wavMs(inter.args[0]) : 0;
  const live = meta?.durationMs ?? 0;
  ok(audio - live >= 700,
     `the recording reaches ${Math.round(audio - live)}ms back before the trigger`,
     `audio ${Math.round(audio)}ms, live ${Math.round(live)}ms`);

  // Length alone proves nothing — a ring buffer that stopped being filled when
  // Echo started talking is still FULL, just full of the wrong thing. This is
  // the same stale-buffer trap that made wake enrolment reject every take.
  // The room was near-silent (20) before playback and ~600 during it, so the
  // opening of the recording says which audio the buffer actually held.
  const opening = inter ? openingLevel(inter.args[0]) : 0;
  ok(opening > 400,
     `the pre-roll holds audio from just before the interruption (level ${opening})`,
     `level ${opening} is the silence from before Echo started speaking — a stale buffer`);
  await t.listener.stop();
}

console.log("\n  someone still talking when the reply ends is an ordinary command");
{
  const t = listenerUnderTest();
  await t.listener.start();
  await frames(t.src, 40);
  t.listener.setPaused(true);
  t.set(600);
  await settle(t.src, 1700);
  t.set(LOUD);
  await frames(t.src, 20);
  t.listener.captureInterjection();
  await frames(t.src, 10);

  t.listener.setPaused(false);         // Echo finishes while they are mid-sentence
  ok(!t.listener.capturingInterjection, "it stops being an interjection the moment playback ends");
  await frames(t.src, 10);
  t.set(QUIET);
  await frames(t.src, 40);

  ok(t.events.some((e) => e.name === "utterance"),
     "and lands as a normal utterance instead", t.events.map((e) => e.name).join(","));
  ok(!t.events.some((e) => e.name === "interjection"),
     "not as an interjection with nothing left to interject into");
  await t.listener.stop();
}

console.log("\n  nothing is captured while Echo speaks unless it was asked for");
{
  // The regression that would bring back Echo answering itself: if playback
  // alone opened a capture, every reply would be transcribed as a command.
  const t = listenerUnderTest();
  await t.listener.start();
  await frames(t.src, 40);
  t.listener.setPaused(true);
  t.set(LOUD);                         // a very loud reply, and nobody in the room
  await settle(t.src, 2000);
  ok(!t.listener.capturingInterjection, "no capture opened on its own");
  ok(!t.events.some((e) => e.name === "interjection" || e.name === "utterance"),
     "and nothing was handed on to be answered", t.events.map((e) => e.name).join(","));
  await t.listener.stop();
}

// ── the self-conversation, from a real recorded session ──────────────────
//
// 2026-09-30, runs/voice/2026-09-30T20-04-10. Eight turns; SIX of them were
// Echo answering its own voice. What it said, then what it dispatched as a
// command a few seconds later:
//
//   said  "Found over 23,000 US cameras — first one"
//   acted "Found over 23,000 US cameras. First one's a traffic cam on I-69…"
//
// Two separate faults, both mine:
//
//  1. `spokenThisReply` was cleared at the start of every turn, on the belief
//     that "a new answer means the old one can no longer be in the room".
//     The SOUND outlives the turn. By the time the microphone's copy of reply
//     A was transcribed, the record of A had been wiped — so there was
//     nothing to subtract, and answering it started another turn, which wiped
//     it again. Self-reinforcing.
//  2. Whisper does not transcribe Echo verbatim ("First one's" for "first one
//     is"), so the exact three-word runs `stripEchoWords` needs keep breaking
//     and fragments survive.
console.log("\n  Echo's own voice, from the session where it answered itself");
{
  // Verbatim from the log: what Echo spoke, and what the mic then heard.
  const pairs: Array<[string, string]> = [
    ["Found over 23,000 US cameras — first one is a traffic cam on I-69 in Indiana. Want me to open it?",
     "Found over 23,000 US cameras. First one's a traffic cam on I-69 in Indiana. Want me to o"],
    ["The grid's up but centered on Hungary, not the US.",
     "The grid's up, but centered on Hungary, not the US."],
    ["The map's stuck on Hungary and won't navigate to the US, no matter what I click.",
     "The map's stuck on Hungary and won't navigate to the US, no matter what I click."],
    ["Let me point it at the US and pull up that Indiana camera marker.",
     "Let me point it at the US and pull up that Indiana camera marker."],
  ];
  for (const [spoke, heardBack] of pairs) {
    ok(isEchoItself(heardBack, spoke),
      `recognised as its own voice: "${heardBack.slice(0, 44)}…"`,
      "this exact line was dispatched to the brain as a user command");
  }

  // The reply is still recognisable AFTER the next turn has begun — which is
  // the whole point, and exactly what clearing the window destroyed.
  const twoRepliesAgo = "Opening the Osiris grid with camera markers. " + pairs[1][0];
  ok(isEchoItself(pairs[1][1], twoRepliesAgo),
    "and still recognised once a later reply has been spoken over it");
}

console.log("\n  but a real interruption is still heard");
{
  // The cost of getting this wrong in the other direction is Echo ignoring
  // the user mid-reply, which is the bug this whole path exists to fix.
  const reply = "Found over 23,000 US cameras — first one is a traffic cam on I-69 in Indiana. Want me to open it?";
  for (const real of ["no the other one", "stop", "open the second one instead",
                      "actually show me Tokyo", "what about Japan"]) {
    ok(!isEchoItself(real, reply), `"${real}" is the user`, "a real interruption must not be swallowed");
  }
  // A short echo of one word is left to the strip rule rather than guessed at.
  ok(!isEchoItself("yes", reply), "and a one-word answer is not judged by overlap");
}

// ── the wiring in main.ts ─────────────────────────────────────────────────

console.log("\n  and main.ts actually does this with it");
{
  // Behavioural checks stop at the listener's edge — main.ts only runs inside
  // Electron. These pin the three joins that the whole change rests on, each
  // of which has a silent failure mode rather than a loud one.
  const main = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
  const bargeIn = main.slice(main.indexOf("function onBargeIn("));
  const body = bargeIn.slice(0, bargeIn.indexOf("\n}"));

  ok(/captureInterjection\(/.test(body), "barge-in starts a recording");
  // The order is the point: the deferred branch must return before anything
  // touches the voice, or the reply is cut short exactly as it was before.
  ok(body.indexOf("captureInterjection(") < body.indexOf("tts.stop()"),
     "and returns before tts.stop(), so the reply keeps playing");
  ok(/bargeInMode/.test(body), "unless the older cut-it-off behaviour was asked for");

  ok(/if \(drainPendingInterjection\(\)\) return;/.test(main),
     "the held interjection is answered when the reply finishes, before the mic reopens");
  ok(/!meta\.overlap && isEchoTalkingToItself/.test(main),
     "and the self-audio guard lets it through — it was recorded over Echo on purpose");
  ok(/listener\.on\("interjection"/.test(main), "the listener's interjection event is consumed");
  // One stop vocabulary, not two.
  ok(!/function isStopIntent/.test(main) && /isStopIntent/.test(main),
     "main.ts uses the shared stop rule rather than keeping its own copy");

  // The reset that caused the self-conversation. The window has to outlive
  // the turn, because the SOUND does.
  // The declaration `let spokenThisReply = ""` is fine; a RE-assignment is the
  // bug. Anchored so the two are not confused, which they were on first write.
  ok(!/^\s+spokenThisReply = "";/m.test(main),
     "the record of what Echo just said is not wiped when a new turn starts",
     "clearing it mid-session is what let Echo answer its own previous reply");
  ok(/isEchoItself\(/.test(main), "and the whole-capture self-audio check is actually consulted");
}

console.log(`\n${pass}/${pass + fail} interjection cases passed`);
console.log("A failure here means Echo either cuts its answers short again, or starts answering itself.\n");
process.exit(fail === 0 ? 0 : 1);
