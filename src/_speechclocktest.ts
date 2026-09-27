/**
 * Echo must know when it has stopped talking.   npm run speechclocktest
 *
 * This exists because of a real regression with a very confusing symptom: the
 * user reported "Echo still needs the wake word every time". The conversation
 * window had been working — the logs showed it — and then stopped opening at
 * all after realtime voice was wired in.
 *
 * The chain was: `turnComplete` (the MODEL stopped generating) was treated as
 * the end of speech, which re-armed the mic while audio was still playing. The
 * fix for THAT waited on the player's `drained` event — which never arrived, so
 * the "speaking" flag stuck at true, and since the auto-listen guard reads that
 * flag, `maybeAutoListen()` returned early forever. One missing event silently
 * disabled the conversation window for the whole session.
 *
 * So the property under test is not "the timing is exact". It is that the
 * speaking flag ALWAYS clears and the turn ALWAYS ends, whatever the player
 * does or does not report. Timers and the clock are injected, so this runs
 * instantly and deterministically rather than sleeping.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SpeechClock, isSelfAudio } from "./voice/speech-clock.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

const RATE = 48000; // 24 kHz mono PCM16

/** A fake clock and timer queue, so "two seconds later" is exact and instant. */
function harness() {
  let now = 0;
  let ends = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const clock = new SpeechClock(
    {
      bytesPerSecond: RATE,
      now: () => now,
      setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
      clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
    },
    () => { ends++; }
  );
  /** Advance time, firing anything due. */
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.fn();
    }
    now = target;
  };
  /** One second of audio. */
  const second = (n = 1) => clock.noteAudio(RATE * n);
  return { clock, advance, second, ends: () => ends };
}

console.log("\nEnd of speech is computed, never awaited\n");

console.log("  the regression: `drained` never arrives");
{
  const h = harness();
  h.second(2);                 // two seconds of audio handed to the player
  h.clock.noteTurnComplete();  // model done generating
  ok(h.clock.speaking, "still speaking while the audio plays");
  ok(h.ends() === 0, "the mic is NOT re-armed yet");
  h.advance(3000);             // no drained event, ever
  ok(!h.clock.speaking, "the speaking flag clears on its own");
  ok(h.ends() === 1, "the turn ends and the mic is re-armed", `ends=${h.ends()}`);
}

console.log("\n  it does not re-arm early, while Echo is still talking");
{
  const h = harness();
  h.second(5);
  h.clock.noteTurnComplete();
  h.advance(2000);
  ok(h.ends() === 0, "two seconds into five, still quiet");
  ok(h.clock.speaking, "and still reported as speaking");
  h.advance(3500);
  ok(h.ends() === 1, "ends once the audio would have finished");
}

console.log("\n  `drained` is honoured as an EARLY finish when it comes");
{
  const h = harness();
  h.second(10);
  h.clock.noteTurnComplete();
  h.advance(500);
  h.clock.noteDrained();
  ok(h.ends() === 1, "ended immediately rather than waiting out ten seconds");
  ok(!h.clock.speaking, "and is no longer speaking");
  h.advance(20000);
  ok(h.ends() === 1, "and does not end twice", `ends=${h.ends()}`);
}

console.log("\n  audio that keeps arriving pushes the end out");
{
  const h = harness();
  h.second(1);
  h.clock.noteTurnComplete();
  h.advance(500);
  h.second(2);                 // a late sentence
  h.advance(900);
  ok(h.ends() === 0, "still speaking: more audio arrived after turnComplete");
  h.advance(3000);
  ok(h.ends() === 1, "and ends once that audio has played too");
}

console.log("\n  a turn that spoke nothing still ends");
{
  const h = harness();
  h.clock.noteTurnComplete();  // tool-only turn, or a silent failure
  ok(h.ends() === 1, "the mic is re-armed rather than waiting forever");
  ok(!h.clock.speaking, "and nothing is left marked as speaking");
}

console.log("\n  `drained` between sentences does not end a turn still generating");
{
  const h = harness();
  h.second(1);
  h.clock.noteDrained();       // player momentarily empty, model still going
  ok(h.ends() === 0, "no turn ended");
  h.second(1);
  h.clock.noteTurnComplete();
  h.advance(2000);
  ok(h.ends() === 1, "the turn ends when it actually completes");
}

console.log("\n  the flag can never stick for a whole session");
{
  const h = harness();
  h.clock.noteAudio(RATE * 3600);   // an hour of audio, somehow
  h.clock.noteTurnComplete();
  h.advance(130_000);               // past the 120s cap
  ok(!h.clock.speaking, "the cap cleared it");
  ok(h.ends() === 1, "and the turn ended");
}

console.log("\n  a new turn never inherits the last one's state");
{
  const h = harness();
  h.second(30);
  h.clock.noteTurnComplete();
  h.clock.reset();
  ok(!h.clock.speaking, "reset clears the speaking flag");
  h.advance(60_000);
  ok(h.ends() === 0, "and the abandoned turn does not fire later", `ends=${h.ends()}`);
}

console.log("\n  telling Echo's own voice from the user's");
{
  // Both failure directions have actually happened, so both are pinned.
  //
  // Too loose: Echo answered itself in a paid loop. Too tight: the guard
  // compared a MONOTONIC captureStartAt against a WALL-CLOCK spokeUntil, so
  // every capture looked like self-audio and Echo went completely deaf after
  // its first reply — the user's questions were discarded fifty seconds after
  // Echo had stopped talking. The last case below is that exact bug.
  const SPOKE_UNTIL = 34_470; // performance.now()-style, ms since start

  ok(isSelfAudio({ speaking: true, captureStartAt: 99_999, spokeUntil: SPOKE_UNTIL }),
    "a capture while Echo is mid-sentence is its own voice");
  ok(isSelfAudio({ speaking: false, captureStartAt: 33_000, spokeUntil: SPOKE_UNTIL }),
    "one that began during the reply, delivered late, still is");
  ok(isSelfAudio({ speaking: false, captureStartAt: 34_600, spokeUntil: SPOKE_UNTIL }),
    "and one inside the grace window, where the tail still rings");

  ok(!isSelfAudio({ speaking: false, captureStartAt: 34_800, spokeUntil: SPOKE_UNTIL }),
    "but just past the grace window it is the USER");
  ok(!isSelfAudio({ speaking: false, captureStartAt: 38_320, spokeUntil: SPOKE_UNTIL }),
    "four seconds later, certainly the user");
  ok(!isSelfAudio({ speaking: false, captureStartAt: 84_070, spokeUntil: SPOKE_UNTIL }),
    "fifty seconds later, certainly the user (the deafness bug)");
  ok(!isSelfAudio({ speaking: false, captureStartAt: undefined, spokeUntil: SPOKE_UNTIL }),
    "an unknown start time is never assumed to be Echo");

  // The regression itself: a wall-clock spokeUntil against a monotonic start.
  // Every real capture is a smaller number, so everything reads as self-audio.
  ok(!isSelfAudio({ speaking: false, captureStartAt: 38_320, spokeUntil: 34_470 }),
    "same clock on both sides — a wall-clock spokeUntil would reject everything");
}

console.log("\n  the microphone is paused for exactly as long as Echo speaks");
{
  // The self-conversation loop: the realtime path never paused capture, so the
  // open conversation window (no wake word required) fed Echo's own voice back
  // in as the next command. It answered itself, in alternating languages, one
  // paid audio round trip per cycle, until a human stopped it.
  //
  // The pairing below is the fix, so it is asserted rather than assumed: every
  // start-of-speech must be matched by exactly one end, or the mic is either
  // deaf for the rest of the session or open while Echo talks.
  const main = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
  ok(/session\.on\("audio"[\s\S]{0,1600}?listener\?\.setPaused\(true\)/.test(main),
    "realtime audio pauses capture");
  ok(/new SpeechClock\([\s\S]{0,500}?listener\?\.setPaused\(false\)/.test(main),
    "the speech clock's end releases it again");
  ok(/isEchoTalkingToItself/.test(main) && /reason: "echo_self_audio"/.test(main),
    "and a capture that began during speech is dropped on arrival");
  ok((main.match(/listener\?\.setPaused\(true\)/g) ?? []).length ===
     (main.match(/session\.on\("audio"/g) ?? []).length,
    "one pause per realtime audio handler, no more");
}

console.log(`\n${pass}/${pass + fail} speech-clock cases passed`);
console.log("A failure here means the conversation window can stop opening, and every turn needs the wake word.\n");
process.exit(fail === 0 ? 0 : 1);
