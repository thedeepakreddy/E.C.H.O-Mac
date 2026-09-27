/**
 * Something was heard while Echo was still speaking. What is it, and does the
 * reply have to stop?
 *
 * Echo used to treat every barge-in the same way: cut the voice off mid-word,
 * throw the rest of the answer away, and start listening. Two things were wrong
 * with that. A door closing or a laugh ended a perfectly good reply that was
 * never finished or seen. And even a REAL interruption lost the rest of the
 * answer, when the natural thing is to hear the person out, finish the
 * sentence, and then deal with what they said.
 *
 * So an interjection is now recorded WHILE Echo keeps talking, and this module
 * decides what it was. That only works if we can tell the user's words from
 * Echo's own, because without hardware echo cancellation (which does not work
 * on this machine) the recording contains both — see `stripEchoWords`.
 */

/** What to do about something heard mid-reply. */
export type InterjectionVerdict =
  /** Halt the reply now: the user asked for silence. */
  | "stop"
  /** Nothing said, or only Echo's own voice coming back. Keep talking. */
  | "noise"
  /** A real thing to answer, once the current reply has finished. */
  | "command";

/**
 * How many words in a row have to match Echo's own script before that run is
 * treated as leakage rather than coincidence.
 *
 * Three is deliberately conservative. Deleting a run the USER said is the
 * expensive mistake — it corrupts the command Echo acts on — while leaving a
 * stray word or two of Echo's own in the transcript costs nothing, because the
 * model reads around it. Two-word runs ("it is", "do you") collide with
 * ordinary speech constantly; three-word runs essentially do not.
 */
const MIN_ECHO_RUN = 3;

/**
 * The whole utterance is an instruction to stop, not something for the brain.
 *
 * Anchored end to end on purpose: this must match "stop", "okay Echo, stop
 * that", "never mind" — and must NOT match "don't stop the music" or "wait
 * until the build finishes", which are things to DO, not orders to shut up.
 *
 * It lives here rather than in main.ts because the barge-in path needs exactly
 * the same judgement, and two lists of stop words would drift apart the way
 * the risk gate's `rm`-but-not-`unlink` list once did.
 */
export function isStopIntent(command: string): boolean {
  return /^(?:(?:hey|ok|okay)\s+)?(?:echo[,!.]?\s*)?(?:stop|cancel|never\s*mind|shut up|be quiet|quiet|enough|hold on|hang on|wait)(?:\s+(?:it|that|please|echo))?[.!]?$/i.test(command.trim());
}

/**
 * Asking for silence in one of the other languages Echo answers in.
 *
 * Kept short and unambiguous. The asymmetry matters: a wrong "stop" cuts a
 * reply off mid-word, which is the exact bug this whole change exists to fix,
 * while a missed "stop" only means Echo finishes its sentence first — so
 * anything debatable is left out. Native script and the spellings whisper
 * produces under `-l en`, which is how Echo transcribes these languages (see
 * the wake matcher, which faces the same problem).
 */
const STOP_PHRASES = [
  "ఆపు", "ఆగు", "aapu", "aagu",              // Telugu
  "रुको", "रुक", "ruko",                // Hindi
  "shush", "hush", "silence", "stop stop",   // English, outside the regex above
];

/** The most words an utterance can have and still be read as a bare stop command. */
const STOP_MAX_WORDS = 4;

/**
 * Lowercase word tokens, punctuation discarded.
 *
 * `\p{M}` is not optional here. Telugu, Devanagari and Perso-Arabic write
 * vowels as combining marks, which are marks and not letters: dropping them
 * turns "ఆపు" (stop) into "ఆప", so it matched nothing in the stop list and a
 * Telugu "stop" was filed as noise.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Remove Echo's own voice from a transcript of the room.
 *
 * Without echo cancellation the microphone hears Echo through the speakers, so
 * a recording made mid-reply holds both voices. Barge-in only fires when the
 * user is well above Echo's own level, so the user dominates — but the ~770ms
 * of pre-roll kept so the first syllable is not clipped is mostly Echo alone,
 * and whisper duly transcribes it.
 *
 * Echo knows exactly what it was saying, so this is subtraction rather than
 * signal processing: any run of `MIN_ECHO_RUN` or more words that appears
 * verbatim in Echo's own script is leakage and comes out. What remains is the
 * user. If nothing remains, nobody actually said anything — the "interruption"
 * was Echo hearing itself, and the caller can keep talking.
 */
export function stripEchoWords(heard: string, echoSaid: string): string {
  const mine = words(echoSaid);
  if (!mine.length) return heard.trim();
  // Padded so a run only matches on whole-word boundaries.
  const script = ` ${mine.join(" ")} `;

  // Tokenise the transcript but keep each word's original spelling, so what
  // survives reads the way the user said it rather than flattened to lowercase.
  const heardTokens = [...heard.matchAll(/[\p{L}\p{N}\p{M}']+/gu)].map((m) => m[0]);
  const lower = heardTokens.map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, ""));

  const kept: string[] = [];
  let i = 0;
  while (i < heardTokens.length) {
    // The longest run starting here that Echo also said. Extending forward is
    // enough: a run of n+1 can only match if the run of n did.
    let run = 0;
    for (let n = MIN_ECHO_RUN; i + n <= heardTokens.length; n++) {
      if (!script.includes(` ${lower.slice(i, i + n).join(" ")} `)) break;
      run = n;
    }
    if (run >= MIN_ECHO_RUN) {
      i += run;
      continue;
    }
    kept.push(heardTokens[i]);
    i++;
  }
  return kept.join(" ");
}

/**
 * What the user actually did by speaking over Echo.
 *
 * Expects text that has already been through `stripEchoWords`, so "nothing
 * left" genuinely means nothing was said.
 */
export function classifyInterjection(text: string): InterjectionVerdict {
  const w = words(text);
  if (!w.length) return "noise";
  // A single stray syllable is a cough or a clipped consonant, not an
  // instruction. Two or more real words, or one word that is a stop command.
  const joined = w.join(" ");
  if (isStopIntent(joined)) return "stop";
  if (w.length <= STOP_MAX_WORDS && STOP_PHRASES.some((p) => matches(joined, p))) return "stop";
  // A single stray letter is a clipped consonant, not an instruction. Counted
  // in code points rather than characters so a one-syllable word in Telugu or
  // Devanagari — a base letter plus its vowel mark — is not mistaken for one.
  if (w.length === 1 && [...joined.replace(/\p{M}/gu, "")].length <= 2) return "noise";
  return "command";
}

/** `phrase` present in `text` as whole words. */
function matches(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}
