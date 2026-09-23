/**
 * Keyless wake-word check, end to end.
 *
 * Synthesises speech with macOS `say`, runs it through the SAME whisper.cpp
 * pipeline Jarvis uses, and asserts the wake word is detected and stripped.
 * This exercises real audio -> real STT -> the matcher, not just the regex.
 *
 *   npm run waketest
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { transcribeLocal } from "./voice/stt.js";
import { matchWakeWord, isNameOnly } from "./voice/wakeword.js";
import { isHallucination } from "./voice/vocabulary.js";

const run = promisify(execFile);
// fileURLToPath decodes %20 etc; `.pathname` does not, which broke once the
// folder was renamed to "Echo Mac" (a path with a space).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cfg = loadConfig(ROOT);

interface Case {
  spoken: string;
  expectWake: boolean;
  expectCommand?: string; // substring the extracted command must contain
  nameOnly?: boolean;
}

// The wake word is "Echo" (renamed from Jarvis).
const CASES: Case[] = [
  { spoken: "Echo, what is on my screen?", expectWake: true, expectCommand: "screen" },
  { spoken: "Hey Echo, open Safari.", expectWake: true, expectCommand: "safari" },
  { spoken: "Echo", expectWake: true, nameOnly: true },
  { spoken: "What time is the meeting tomorrow?", expectWake: false },
  { spoken: "I was telling Sarah about the report.", expectWake: false },
  // Observed for real: silence-based endpointing runs preceding chatter into
  // the command, leaving the wake word mid-transcript.
  {
    spoken: "Good job, how are you doing? Echo, what is on my screen?",
    expectWake: true,
    expectCommand: "screen",
  },
];

/**
 * Mishearings this machine actually produced, checked against the matcher.
 *
 * These are TRANSCRIPTS, not things to say. Speaking them aloud and hoping
 * whisper mishears them back into the same shape compounds the distortion
 * instead of reproducing it — synthesising "Hage-arvis" came back as
 * "Figavus", which is nothing like the name and which nothing should match.
 * Feeding the observed text straight to the matcher tests the thing that
 * actually has to cope with it.
 */
const HEARD: Case[] = [
  { spoken: "Eco, open Safari.", expectWake: true, expectCommand: "safari" },
  { spoken: "Ecko, what is on my screen?", expectWake: true, expectCommand: "screen" },
  { spoken: "Echo. Open Safari.", expectWake: true, expectCommand: "safari" },
  { spoken: "Hey echo, open mail.", expectWake: true, expectCommand: "mail" },

  // Other languages, as a MULTILINGUAL whisper actually transcribed them.
  // Echo is spoken to in Telugu and Hindi, and the always-on transcript check
  // is the only thing standing between that and being ignored: every check in
  // the matcher runs on [a-z], so a native-script transcript strips to nothing
  // and the utterance is silently discarded. These are real outputs measured
  // from `whisper-cli -m ggml-small.bin`, not invented spellings.
  //
  // `sttLanguage: "en"` on a multilingual model is deliberate — it ROMANISES,
  // which is what turns Telugu into "Eko" (matchable) instead of the literal
  // garbage `-l auto` returns for it.
  { spoken: "Eko. Eruju vatavaranam yela hundi?", expectWake: true, expectCommand: "vatavaranam" },
  { spoken: "Eko. M. Rus Havocetorast.", expectWake: true },
  { spoken: "Echo, wie ist das Wetter heute?", expectWake: true, expectCommand: "wetter" },
  { spoken: "Eko, bugün hava nasıl?", expectWake: true, expectCommand: "hava" },
  // Native script, when whisper writes it that way rather than romanising.
  { spoken: "ఎకో, ఈరోజు వాతావరణం ఎలా ఉంది?", expectWake: true },
  { spoken: "एको, मौसम कैसा है?", expectWake: true },
  { spoken: "Эхо, какая сегодня погода?", expectWake: true },
  // Perso-Arabic. Both kafs, because Persian writes ک (U+06A9) and Arabic
  // ك (U+0643) and transcripts mix them.
  { spoken: "اکو، امروز هوا چطور است؟", expectWake: true },
  { spoken: "اكو، امروز هوا چطور است؟", expectWake: true },
  { spoken: "اکو ام روز هورچه تو رست", expectWake: true },
  // ...and the near-misses in those scripts must STILL be ignored, or every
  // Hindi sentence starting "एक" and every Russian one starting "Это" becomes
  // a command.
  { spoken: "एक आदमी था", expectWake: false },
  { spoken: "Это хорошо получилось", expectWake: false },
  // The name must be the WHOLE word. These rewrites replace a substring, so an
  // unanchored pattern turns "اکوسیستم" (ecosystem) into "echo سیستم" — proven,
  // not theoretical — and every mention of ecosystems wakes Echo.
  { spoken: "اکوسیستم خیلی مهم است", expectWake: false },
  { spoken: "اکنون وقت است", expectWake: false },
  { spoken: "او به خانه رفت", expectWake: false },
  // And things that must still be ignored, so the fuzziness above has a limit.
  // (Note: "Echo" is a common English word, so a sentence that literally
  // contains it will wake — a known tradeoff of the name. These avoid it.)
  { spoken: "Just service the car tomorrow.", expectWake: false },
  { spoken: "The harvest is in.", expectWake: false },

  // Real captures from this machine (2026-09-22/23), whisper small, -l en.
  // "Hi Echo" loses its E to the greeting — every one of these was ignored and
  // the user had to repeat themselves.
  { spoken: "Hi, Ko. How are you doing?", expectWake: true, expectCommand: "how are you" },
  { spoken: "Hi, Code. How are you doing?", expectWake: true, expectCommand: "how are you" },
  { spoken: "Hi, Iko, how are you doing?", expectWake: true, expectCommand: "how are you" },
  { spoken: "Hi, Co. Can you speak to me in Farsi?", expectWake: true, expectCommand: "farsi" },
  { spoken: "Hi, go.", expectWake: true },
  { spoken: "Hi, Ko.", expectWake: true },
  // "I go" is the name only when it stands alone...
  { spoken: "I go.", expectWake: true },
  { spoken: "So, I go, what are you doing today?", expectWake: true, expectCommand: "what are you doing" },
  { spoken: "I'm doing great as well, I go.", expectWake: true },
  { spoken: "I go check how many times the diocese circled over me today.", expectWake: true, expectCommand: "check" },
  { spoken: "I go to the office every day.", expectWake: false },
  // ...and ordinary grammar otherwise. Each of these woke Echo before.
  { spoken: "So can I go and compile?", expectWake: false },
  { spoken: "Can I go and compile?", expectWake: false },
  { spoken: "Can I go?", expectWake: false },
  { spoken: "Yeah, so amazing, why we finish this code that I go back, for the chip maybe 15 minutes ago.", expectWake: false },
  { spoken: "So when I'm young at this age, if I go to a small baby, even those, their parents also worry.", expectWake: false },
  // Greeting words that are not the name must stay ignored.
  { spoken: "Okay, go to the next one.", expectWake: false },
  { spoken: "Hey, oh no.", expectWake: false },
  { spoken: "Hello, guys.", expectWake: false },
];

/** Speak text to a 16kHz mono WAV, the format whisper.cpp expects. */
async function synth(text: string): Promise<string> {
  const aiff = join(tmpdir(), `wake-${Date.now()}.aiff`);
  const wav = join(tmpdir(), `wake-${Date.now()}.wav`);
  await run("/usr/bin/say", ["-v", cfg.voice.ttsVoice, "-o", aiff, text]);
  await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  unlink(aiff).catch(() => {});
  return wav;
}

let pass = 0;
let fail = 0;

console.log("\nKeyless wake word — say() -> whisper.cpp -> matcher\n");

for (const c of CASES) {
  let wav = "";
  try {
    wav = await synth(c.spoken);
    const transcript = await transcribeLocal(wav, cfg); // the wake pass is always local, whatever sttProvider says
    const { matched, command } = matchWakeWord(transcript);

    const problems: string[] = [];
    if (matched !== c.expectWake) {
      problems.push(`expected wake=${c.expectWake}, got ${matched}`);
    }
    if (c.expectCommand && !command.toLowerCase().includes(c.expectCommand)) {
      problems.push(`command should contain "${c.expectCommand}"`);
    }
    if (c.nameOnly && !isNameOnly(command)) {
      problems.push(`expected name-only, got "${command}"`);
    }

    if (problems.length) {
      fail++;
      console.log(`  ✗ "${c.spoken}"`);
      console.log(`      heard: ${JSON.stringify(transcript.trim())}`);
      console.log(`      ${problems.join("; ")}`);
    } else {
      pass++;
      const shown = matched ? (isNameOnly(command) ? "(name only)" : command) : "ignored";
      console.log(`  ✓ "${c.spoken}"  ->  ${shown}`);
    }
  } catch (err: any) {
    fail++;
    console.log(`  ✗ "${c.spoken}" — ${err?.message ?? err}`);
  } finally {
    if (wav) unlink(wav).catch(() => {});
  }
}

console.log("\n  a transcript in another script is speech, not noise\n");
{
  // The noise filter stripped everything outside [a-z] and then demanded a
  // vowel, so EVERY non-Latin transcript reduced to "" and was discarded before
  // the brain ever saw it. Echo went silent on Telugu and looked deaf.
  const cases: Array<[string, boolean, string]> = [
    ["ఈరోజు వాతావరణం ఎలా ఉంది?", false, "Telugu"],
    ["मौसम कैसा है?", false, "Hindi"],
    ["какая сегодня погода?", false, "Russian"],
    ["امروز هوا چطور است؟", false, "Persian"],
    ["open safari", false, "English"],
    // ...but whisper's own failure output is repeated LATIN letters, and that
    // really is noise, so the vowel rule still has to catch it.
    ["Ḥ Ḥ Ḥ Ḥ Ḥ", true, "whisper garbage"],
    ["[BLANK_AUDIO]", true, "silence marker"],
    ["Thanks for watching", true, "classic hallucination"],
    ["♪♪", true, "music"],
    ["This is Echo's Nouveau.", true, "whisper's own name hallucination"],
  ];
  for (const [text, noise, label] of cases) {
    if (isHallucination(text) === noise) {
      pass++;
      console.log(`  ✓ ${label.padEnd(22)} ${noise ? "ignored as noise" : "kept as speech"}`);
    } else {
      fail++;
      console.log(`  ✗ ${label.padEnd(22)} expected ${noise ? "noise" : "speech"}, got the opposite — ${JSON.stringify(text).slice(0, 34)}`);
    }
  }
}

console.log("\n  observed transcripts, straight to the matcher\n");

for (const c of HEARD) {
  const { matched, command } = matchWakeWord(c.spoken);
  const problems: string[] = [];
  if (matched !== c.expectWake) problems.push(`expected wake=${c.expectWake}, got ${matched}`);
  if (c.expectCommand && !command.toLowerCase().includes(c.expectCommand)) {
    problems.push(`command should contain "${c.expectCommand}"`);
  }
  if (problems.length) {
    fail++;
    console.log(`  ✗ ${JSON.stringify(c.spoken)} — ${problems.join("; ")}`);
  } else {
    pass++;
    console.log(`  ✓ ${JSON.stringify(c.spoken)}  ->  ${matched ? command || "(name only)" : "ignored"}`);
  }
}

console.log(`\n${pass}/${pass + fail} wake-word cases passed\n`);
process.exit(fail ? 1 : 0);
