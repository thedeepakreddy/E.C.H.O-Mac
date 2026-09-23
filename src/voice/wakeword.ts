/**
 * Keyless wake-word detection over a transcript.
 *
 * Instead of a dedicated always-on keyword model (Porcupine needs an API key,
 * Vosk's Node bindings are stuck on the unmaintained ffi-napi, openWakeWord is
 * Python-first), we let whisper.cpp — already installed and used for commands —
 * transcribe each spoken utterance once and look for "Jarvis" at the front.
 * Whisper's cost is dominated by loading the model, so checking the transcript
 * we were producing anyway is effectively free, and nothing leaves the machine.
 *
 * Matching is deliberately forgiving. Whisper has no context to anchor on when
 * a name is the first thing said, so it produces things like "Javis", "Jervis",
 * or — observed in testing — "Hijavis" for "Hey Jarvis", with the greeting and
 * the name run together into a single token.
 */

const TARGET = "echo";

/** Spellings whisper actually emits for the name. */
const VARIANTS = new Set([
  "echo",
  "ecco",
  "ekko",
  "eko",
  "ecko",
  "eccho",
  "eco",
]);

const PREFIXES = ["hey", "okay", "ok", "hello", "yo", "hi"];

/**
 * Whole utterances whisper returns for a greeting and the name fused together,
 * where the name half is too mangled for any safe edit distance to reach.
 *
 * "Hey Echo" comes back as "Hayako": the name half is "ako", three edits from
 * "echo" on a four-letter word. Loosening `isName` far enough to catch it would
 * also catch "each", "ache" and "auto", so the distance rule stays exactly
 * where it is — these are EXACT matches on the whole token and widen nothing.
 * The same reasoning as the `i go` -> `echo` rewrite in matchWakeWord.
 *
 * Note this only matters on the always-on transcript path. When the acoustic
 * spotter fires it is trusted above ACOUSTIC_CERTAIN and whisper cannot veto it
 * (see voice/wake/index.ts) — but the transcript check also runs on its own
 * whenever the spotter does not fire, and there it decides alone.
 */
const FUSED_GREETING_AND_NAME = new Set([
  "hayako",
  "hayeko",
  "heyecho",
  "heyeko",
  "hiecho",
]);

/**
 * How the name comes back when the utterance was transcribed in Telugu script.
 *
 * Everything below this line works on [a-z] — `strip` throws the rest away — so
 * a Telugu transcript reduces to empty tokens and the name can never match. The
 * spellings are romanised back to "echo" before any of that runs. Sarvam
 * rendered "Echo" as ఎకో in testing; the others are the obvious near-misses.
 */
const SCRIPT_VARIANTS = new RegExp(
  [
    // Telugu: ఎకో / ఏకో / ఎఖో / ఎక్కో — Sarvam rendered "Echo" as ఎకో in testing.
    "[\u0C0E\u0C0F]\u0C15\u0C4B",
    "[\u0C0E\u0C0F]\u0C16\u0C4B",
    "[\u0C0E\u0C0F]\u0C15\u0C4D\u0C15\u0C4B",
    // Devanagari (Hindi): एको / एखो / एक्को. Measured — a multilingual whisper
    // transcribed spoken Hindi as "एको आज मौसम कैसा है" and the utterance was
    // thrown away, because every check below works on [a-z] and Devanagari
    // strips to nothing.
    "\u090F\u0915\u094B",
    "\u090F\u0916\u094B",
    "\u090F\u0915\u094D\u0915\u094B",
    // Cyrillic (Russian): Эхо / Эко / эхо / эко.
    "[\u042D\u044D][\u0445\u043A]\u043E",
    // Perso-Arabic: اکو / ایکو / ايكو / إيكو. Measured — whisper transcribed
    // spoken Persian as "اکو ام روز هورچه تو رست". Both kafs are listed because
    // Persian writes ک (U+06A9) and Arabic ك (U+0643), and transcripts mix them.
    "[\u0627\u0623\u0625\u0622][\u064A\u06CC]?[\u06A9\u0643]\u0648",
  ].join("|"),
  "g"
);

/**
 * The name has to be the WHOLE word, not the start of a longer one.
 *
 * These are substring rewrites — each match becomes " echo " — so an unanchored
 * pattern turns the Persian "اکوسیستم" (ecosystem) into "echo سیستم" and wakes
 * Echo on the word "ecosystem". The Latin path never had this problem because
 * `VARIANTS` is an exact-match Set; a rewrite needs the boundary spelled out.
 *
 * `\b` is useless here — it is defined on [A-Za-z0-9_], so every Telugu or
 * Persian letter counts as a boundary. Unicode letter lookarounds instead.
 */
const SCRIPT_VARIANTS_ANCHORED = new RegExp(`(?<!\\p{L})(?:${SCRIPT_VARIANTS.source})(?!\\p{L})`, "gu");

const strip = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** Levenshtein distance, capped work for the short strings we compare. */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99; // far too different to be the name
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Is this token the name, allowing for whisper's mishearings? */
function isName(token: string): boolean {
  const t = strip(token);
  if (!t) return false;
  if (VARIANTS.has(t)) return true;
  // Catch spellings not enumerated above without matching unrelated words.
  // Echo is short, so we only allow 1 typo.
  return t.length >= 3 && t.length <= 6 && distance(t, TARGET) <= 1;
}

/** Handles "hijavis" / "heyjarvis" — greeting and name fused into one token. */
function isMergedGreetingAndName(token: string): boolean {
  const t = strip(token);
  if (FUSED_GREETING_AND_NAME.has(t)) return true;
  if (PREFIXES.some((p) => t.startsWith(p) && t.length > p.length && isName(t.slice(p.length)))) return true;
  // When the two words fuse, whisper garbles the GREETING too — "hay" for
  // "hey" — and an exact prefix test throws the whole utterance away. One typo
  // is allowed in the greeting, but the name half must still match tightly, so
  // this cannot drag in unrelated words on its own.
  for (let cut = 2; cut <= 5 && cut < t.length; cut++) {
    if (!isName(t.slice(cut))) continue;
    if (PREFIXES.some((p) => distance(t.slice(0, cut), p) <= 1)) return true;
  }
  return false;
}

const isPrefix = (token: string) => PREFIXES.includes(strip(token));

/**
 * What whisper leaves of the name after a greeting. "Hi Echo" runs together
 * as "hi-e-ko" and the E is swallowed by the greeting: measured on this user's
 * real captures as "Hi, Ko." (6 times), "Hi, Code." (twice), "Hi, Iko", "Hi, Co."
 * and "Hi, go." — each one ignored, so they had to say it again. Only honoured
 * straight after hi/hey/hello, where these are not ordinary words.
 */
const GREETED_NAME = new Set(["ko", "co", "go", "iko", "ico", "igo", "koh", "coh", "code", "aiko", "eiko"]);
const NAME_GREETINGS = new Set(["hi", "hey", "hello"]);

/**
 * Whisper also hears "Echo" as "I go" — right when it stands alone ("I go.",
 * "…as well, I go.", "So, I go, what…"), wrong inside a sentence, where it woke
 * Echo on "can I go and compile?" and "if I go to…". So only a free-standing
 * "I go" (punctuation or the end after it, no auxiliary before it) is the name.
 */
const I_GO = /(^|[^\p{L}'])(\p{L}+[,\s]+)?i go(?=\s*(?:[,.!?;:]|$))/giu;
const NOT_A_NAME_BEFORE = new Set([
  "can", "could", "shall", "should", "will", "would", "may", "might", "must", "do", "did", "does",
  "if", "when", "then", "that", "and", "before", "after", "until", "let", "where", "why", "how",
]);
/** At the very start of an utterance, "I go" before a command word is the name: "I go check…". */
const I_GO_COMMAND = /^\s*i go(?=\s+(?:check|open|tell|show|what|how|play|search|find|set|turn|call|read|close|start|stop|please)\b)/i;

function normaliseIGo(text: string): string {
  text = text.replace(I_GO_COMMAND, "echo");
  return text.replace(I_GO, (whole, lead: string, prev: string | undefined) => {
    const word = (prev ?? "").replace(/[,\s]+$/, "").toLowerCase();
    if (word && NOT_A_NAME_BEFORE.has(word)) return whole;
    return `${lead}${prev ?? ""}echo`;
  });
}

export interface WakeMatch {
  /** Did the utterance start with the wake word? */
  matched: boolean;
  /** The command with the wake word stripped ("" if they only said the name). */
  command: string;
}

/**
 * Test a transcript for the wake word and return whatever followed it.
 *
 * Scans the whole utterance rather than only its first word. Silence-based
 * endpointing does not segment on sentence boundaries, so in practice the name
 * frequently lands mid-transcript — an observed capture read
 * "Good job is how are you doing? Jarvis what is on", where an opening-token
 * check threw away a perfectly good command.
 *
 * Everything after the FIRST occurrence becomes the command, so
 * "Jarvis, tell me about Jarvis" keeps its full instruction. The cost is that
 * mentioning the name to another person can trigger a command; recall matters
 * more here, since a missed command reads as Jarvis being broken.
 */
export function matchWakeWord(transcript: string): WakeMatch {
  // Whisper annotates non-speech as [BLANK_AUDIO], (wind blowing), *sighs*.
  let text = (transcript ?? "").replace(/\[.*?\]|\(.*?\)|\*.*?\*/g, " ").trim();
  
  // Normalize Whisper mishearings that span multiple tokens
  text = normaliseIGo(text);

  // Romanise the name out of a non-Latin transcript so the matching below sees
  // it. Only the name is rewritten — the command keeps its original script.
  text = text.replace(SCRIPT_VARIANTS_ANCHORED, " echo ").replace(/\s+/g, " ").trim();
  
  if (!text) return { matched: false, command: "" };

  const tokens = text.split(/\s+/);

  /**
   * Does this token contain the name once inner punctuation is split off?
   *
   * Whisper hyphenates mishearings — an observed capture rendered "Hey Jarvis"
   * as "Hage-arvis", a single 9-character token that no whole-word check could
   * match, even though its second half is one edit from "jarvis".
   */
  const containsName = (token: string): boolean => {
    if (isName(token) || isMergedGreetingAndName(token)) return true;
    const parts = token.split(/[^A-Za-z]+/).filter((p) => p.length > 2);
    if (parts.length < 2) return false;
    return parts.some((p) => isName(p) || isMergedGreetingAndName(p));
  };

  for (let i = 0; i < tokens.length; i++) {
    let consumed = 0;
    if (containsName(tokens[i])) {
      consumed = 1;
    } else if (isPrefix(tokens[i]) && tokens[i + 1] && containsName(tokens[i + 1])) {
      consumed = 2;
    } else if (NAME_GREETINGS.has(strip(tokens[i])) && tokens[i + 1] && GREETED_NAME.has(strip(tokens[i + 1]))) {
      consumed = 2;
    }
    if (!consumed) continue;

    // Drop punctuation that trailed the name ("Jarvis, open…" -> "open…").
    const command = tokens
      .slice(i + consumed)
      .join(" ")
      .replace(/^[\s\p{P}]+/u, "")
      .trim();
    return { matched: true, command };
  }

  return { matched: false, command: "" };
}

/** True when they said the name and nothing else. */
export function isNameOnly(command: string): boolean {
  return command.replace(/[\s\p{P}]/gu, "").length === 0;
}
