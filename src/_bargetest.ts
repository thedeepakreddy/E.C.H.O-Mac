/**
 * Barge-in logic, driven by synthetic audio levels.
 *
 * The failure that matters is Jarvis interrupting ITSELF: the microphone hears
 * its own voice through the speakers, so a naive "any sound = interruption"
 * check fires on every sentence it speaks. These cases replay realistic RMS
 * sequences through the same echo-floor maths the listener uses.
 *
 *   npm run bargetest
 */
export {};

const BARGE_FACTOR = 1.6;
const BARGE_FRAMES = 6;
const BARGE_BLOCK_MS = 1500;
const MS_PER_FRAME = 32;
const SPEECH_THRESHOLD = 164; // representative value from the live mic
const ROOM_NOISE = 60; // idle noise floor the peak estimate starts from
const ECHO_PEAK_DECAY = 0.99945; // ~40s half-life — see listener.ts's own comment

/** Mirrors VoiceListener.watchForBargeIn, fed a sequence of frame levels. */
function simulate(levels: number[]): { fired: boolean; atFrame: number } {
  let echoPeak = ROOM_NOISE; // seeded from the room, never zero
  let bargeFrames = 0;

  for (let i = 0; i < levels.length; i++) {
    const rms = levels[i];

    const settling = i * MS_PER_FRAME < BARGE_BLOCK_MS;

    const bar = Math.max(echoPeak * BARGE_FACTOR, SPEECH_THRESHOLD);
    if (settling || rms < bar) {
      echoPeak = Math.max(rms, echoPeak * ECHO_PEAK_DECAY);
    }
    if (settling) continue;

    if (rms >= bar) {
      if (++bargeFrames >= BARGE_FRAMES) return { fired: true, atFrame: i };
    } else if (bargeFrames > 0) {
      bargeFrames--;
    }
  }
  return { fired: false, atFrame: -1 };
}

const rand = (base: number, spread: number) => base + (Math.random() - 0.5) * spread;
const frames = (n: number, gen: (i: number) => number) => Array.from({ length: n }, (_, i) => gen(i));

// Mirrors VoiceListener.setPaused's reset-vs-resume choice, from Sep 2026.
// The full BARGE_BLOCK_MS settling window is sized for learning a brand-new
// reply's volume from a standing start; reapplying it on every ordinary
// sentence-boundary resume doesn't produce a wrong answer (the peak still
// relearns fast within it either way) but it does mean Echo is deaf to a
// REAL interruption for a full 1.5s after every such resume. Keeping the
// peak the reply already earned and reopening only a brief settle catches a
// genuine barge-in right after a resume much sooner, without introducing a
// false one.
const BARGE_RESUME_SETTLE_MS = 300;
function simulateWithGap(levels: number[], gapAtFrame: number, resetOnResume: boolean): { fired: boolean; atFrame: number } {
  let echoPeak = ROOM_NOISE;
  let bargeFrames = 0;
  let settleUntilFrame = Math.ceil(BARGE_BLOCK_MS / MS_PER_FRAME);

  for (let i = 0; i < levels.length; i++) {
    if (i === gapAtFrame) {
      if (resetOnResume) {
        echoPeak = ROOM_NOISE;
        settleUntilFrame = i + Math.ceil(BARGE_BLOCK_MS / MS_PER_FRAME);
      } else {
        settleUntilFrame = i + Math.ceil(BARGE_RESUME_SETTLE_MS / MS_PER_FRAME);
      }
      bargeFrames = 0;
    }
    const rms = levels[i];
    const settling = i < settleUntilFrame;
    const bar = Math.max(echoPeak * BARGE_FACTOR, SPEECH_THRESHOLD);
    if (settling || rms < bar) echoPeak = Math.max(rms, echoPeak * ECHO_PEAK_DECAY);
    if (settling) continue;
    if (rms >= bar) {
      if (++bargeFrames >= BARGE_FRAMES) return { fired: true, atFrame: i };
    } else if (bargeFrames > 0) {
      bargeFrames--;
    }
  }
  return { fired: false, atFrame: -1 };
}

interface Case {
  name: string;
  levels: number[];
  expect: boolean;
}

const cases: Case[] = [
  {
    // Speaker playback: Jarvis's own voice is loud and continuous at the mic.
    name: "Jarvis speaking on open speakers — must NOT self-trigger",
    levels: frames(90, () => rand(650, 400)),
    expect: false,
  },
  {
    // Headphones: barely any echo.
    name: "Jarvis speaking on headphones — must NOT self-trigger",
    levels: frames(90, () => rand(70, 60)),
    expect: false,
  },
  {
    // Natural gaps between words dip toward silence.
    name: "speech with pauses between words — must NOT self-trigger",
    levels: frames(90, (i) => (i % 9 < 6 ? rand(600, 300) : rand(40, 30))),
    expect: false,
  },
  {
    // The real thing: user talks over quiet headphone playback.
    name: "user interrupts over headphones — MUST fire",
    levels: [...frames(55, () => rand(70, 40)), ...frames(30, () => rand(700, 200))],
    expect: true,
  },
  {
    // Over loud speaker playback the user has to be clearly louder.
    name: "user interrupts over speakers — MUST fire",
    levels: [...frames(55, () => rand(600, 200)), ...frames(30, () => rand(2600, 500))],
    expect: true,
  },
  {
    // Regression: `say` is slow to spawn, so the first ~400ms after Jarvis is
    // told to speak is silence. Timing the learning window from the request
    // rather than from real audio taught the floor "silence", after which its
    // own first word cleared the bar and it interrupted itself every sentence.
    name: "playback starts late (spawn lag) then Jarvis speaks — must NOT self-trigger",
    levels: [...frames(16, () => rand(8, 12)), ...frames(80, () => rand(1000, 500))],
    expect: false,
  },
  {
    // Same lag, but the user really does cut in afterwards.
    name: "playback starts late, then user interrupts — MUST fire",
    levels: [
      ...frames(30, () => rand(8, 12)),
      ...frames(40, () => rand(700, 250)),
      ...frames(30, () => rand(3000, 500)),
    ],
    expect: true,
  },
  {
    // Documents a known limitation rather than hiding it: `say` can take up to
    // 1.3s to make a sound, so an interruption inside the block window is
    // indistinguishable from playback finally starting. Use the reactor or the
    // hotkey to cut in that early.
    name: "user interrupts inside the block window — does NOT fire (known limit)",
    levels: [...frames(10, () => rand(70, 40)), ...frames(30, () => rand(900, 200))],
    expect: false,
  },
  {
    name: "single loud click — must NOT fire (too brief)",
    levels: [...frames(55, () => rand(70, 40)), 2400, 2500, ...frames(30, () => rand(70, 40))],
    expect: false,
  },
  {
    // Nothing may fire during the settling window, however loud.
    name: "loud onset inside the block window — must NOT fire",
    levels: frames(40, () => 3000),
    expect: false,
  },
  {
    // Regression: a ~5s gap between sentences (a slow tool call, a longer
    // breath) let the old fast decay (~4s half-life) forget how loud Echo
    // had been, so returning to that SAME, ordinary volume afterwards looked
    // like a new, louder voice and fired mid-reply. No pause/resume event
    // needed — this is pure decay during a quiet stretch while still
    // logically "speaking" (the player between sentences, or a breath).
    name: "quiet gap between sentences, then the SAME volume resumes — must NOT self-trigger",
    levels: [...frames(60, () => 650), ...frames(150, () => rand(50, 30)), ...frames(30, () => 650)],
    expect: false,
  },
];

let pass = 0;
let fail = 0;

console.log("\nBarge-in detection\n");
for (const c of cases) {
  // Repeat: the levels are randomised, so a flaky rule shows up as an
  // intermittent failure rather than passing once by luck.
  let fired = 0;
  const RUNS = 40;
  for (let r = 0; r < RUNS; r++) if (simulate(c.levels).fired) fired++;

  const consistent = c.expect ? fired === RUNS : fired === 0;
  if (consistent) {
    pass++;
    console.log(`  ✓ ${c.name}`);
  } else {
    fail++;
    console.log(`  ✗ ${c.name}\n      fired ${fired}/${RUNS}, expected ${c.expect ? RUNS : 0}`);
  }
}

console.log("\nSame-reply resume: real interruptions are caught, not just false ones prevented");
{
  // Sentence one plays normally; at frame 60 a natural sentence-boundary
  // pause/resume happens, sentence two resumes at the same ordinary volume
  // for a while — then, 20 frames (~640ms) into it, the user genuinely
  // starts talking over it. That moment falls inside the OLD full 1.5s
  // settle window (which unconditionally folds whatever is happening into
  // the tracked peak, loud or not — the same known limit the "inside the
  // block window" case above documents), so old settling ends only once the
  // interruption has already been learned as if it were Echo's own voice,
  // and it never catches it at all. The new, short settle has already
  // closed by then, so it catches the interruption normally.
  const levels = [...frames(60, () => 650), ...frames(20, () => 650), ...frames(60, () => 3000)];
  const oldWay = simulateWithGap(levels, 60, true);
  const newWay = simulateWithGap(levels, 60, false);
  if (!oldWay.fired && newWay.fired) {
    pass++;
    console.log(`  ✓ the shorter settle catches a real interruption the full settle misses entirely (new fired at frame ${newWay.atFrame})`);
  } else {
    fail++;
    console.log(`  ✗ expected old to miss it and new to catch it — old fired=${oldWay.fired}, new fired=${newWay.fired}`);
  }

  // And the ordinary case — resuming at the SAME volume as before — must
  // still not fire under the new, shorter settle either.
  const ordinary = simulateWithGap([...frames(60, () => 650), ...frames(60, () => 650)], 60, false);
  if (!ordinary.fired) {
    pass++;
    console.log("  ✓ resuming at the same volume still does not self-trigger with the shorter settle");
  } else {
    fail++;
    console.log("  ✗ resuming at the same volume self-triggered with the shorter settle");
  }
}

console.log(`\n${pass}/${pass + fail} barge-in cases passed\n`);
process.exit(fail ? 1 : 0);
