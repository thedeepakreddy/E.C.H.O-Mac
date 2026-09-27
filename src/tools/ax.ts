import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, parse } from "node:path";

/**
 * Accessibility-based targeting.
 *
 * Reads the macOS Accessibility tree via the compiled `native/axhelper` so the
 * model can act on "the Send button" instead of a screenshot guess. Works on
 * native apps and Safari; Chromium and some Electron apps expose nothing, in
 * which case callers fall back to the screenshot + coordinate path.
 */
export interface AxElement {
  i: number;
  role: string;
  label: string;
  value: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
  press: boolean; // supports AXPress (activate without moving the mouse)
}

export interface AxDump {
  app: string;
  pid: number;
  axAvailable: boolean;
  elements: AxElement[];
  error?: string;
}

/**
 * Find native/axhelper by walking up from this module until a directory
 * containing it appears. esbuild bundles ax.ts into files at different depths
 * (dist/main.js, dist/_axtest.js), so a fixed "../.." is wrong depending on the
 * entry point — walking up is robust to all of them.
 */
function locateHelper(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, "native", "axhelper");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return candidate; // last tried; helperAvailable() reports false
    dir = dirname(dir);
  }
}

const HELPER = locateHelper();

export function helperAvailable(): boolean {
  return existsSync(HELPER);
}

function runHelper(args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(HELPER, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout?.trim()) return resolve(stdout);
      reject(new Error(stderr?.trim() || err?.message || "axhelper produced no output"));
    });
  });
}

async function dumpUncached(all = false): Promise<AxDump> {
  if (!helperAvailable()) {
    return { app: "?", pid: 0, axAvailable: false, elements: [], error: "helper-not-built" };
  }
  try {
    const raw = await runHelper(all ? ["dump", "--all"] : ["dump"]);
    const parsed = JSON.parse(raw) as AxDump;
    parsed.elements ??= [];
    return parsed;
  } catch (err: any) {
    return { app: "?", pid: 0, axAvailable: false, elements: [], error: String(err?.message ?? err) };
  }
}

/**
 * AGI blueprint #10, scoped down from the original "guess arbitrary next tool
 * calls": the one read this codebase's own GUI tools always pay for at the
 * start of a task is this one, spawning the native helper and walking the
 * whole accessibility tree — and the turn that needs it starts as soon as the
 * user finishes speaking, well before the model's first tool call actually
 * arrives. Firing it early hides that whole round trip.
 *
 * Single-use and short-lived on purpose: a target-finding tool being wrong
 * about what is on screen RIGHT NOW is a correctness problem, not just a
 * latency one, so a warm dump is only ever handed to the FIRST real `dump()`
 * call within `WARM_TTL_MS` of the warm-up — long enough to plausibly still
 * be this turn's opening read, short enough that nothing meaningful has
 * usually happened on screen since. Every call after that takes a fresh
 * accessibility read, exactly as before this existed.
 */
const WARM_TTL_MS = 1200;
let warmed: { at: number; promise: Promise<AxDump> } | null = null;

export function warmDump(): void {
  if (warmed) return; // a warm-up already in flight; don't stack a second one
  const promise = dumpUncached(false);
  warmed = { at: Date.now(), promise };
  // Nobody may ever consume this (the TTL lapses, or the turn needed no GUI
  // tool) — an unhandled rejection from a speculative call must not surface.
  promise.catch(() => {});
}

export async function dump(all = false): Promise<AxDump> {
  if (!all && warmed && Date.now() - warmed.at < WARM_TTL_MS) {
    const p = warmed.promise;
    warmed = null; // single-use: the next call after this one reads fresh
    return p;
  }
  warmed = null; // stale, or an `all` read the warm-up never covers
  return dumpUncached(all);
}

/** Activate an element directly through the API (no mouse). Returns its label. */
export async function press(pid: number, path: string): Promise<{ ok: boolean; label?: string; error?: string }> {
  try {
    const raw = await runHelper(["press", "--pid", String(pid), "--path", path]);
    return JSON.parse(raw);
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ---- matching ------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Rank elements against a spoken description ("the send button", "search
 * field"). Scores exact and substring label hits, with a nudge from any role
 * word in the query, so "submit button" prefers an actual AXButton.
 */
/** Shared by `rank` and `rankScored` so the two can never drift apart. */
function scoreElements(elements: AxElement[], query: string): Array<{ e: AxElement; score: number }> {
  const q = norm(query);
  const qWords = q.split(" ").filter((w) => w.length > 1 && !STOP.has(w));

  const roleHint = ROLE_WORDS.find((r) => q.includes(r.word));

  return elements
    .map((e) => {
      const label = norm(e.label);
      const value = norm(e.value);

      // A textual match is REQUIRED to qualify. Structural signals (role, press)
      // only break ties among things that already matched by words — otherwise
      // every pressable control scores above zero and an unrelated request like
      // "launch the rockets" matches the whole window.
      let textScore = 0;
      if (label && label === q) textScore += 100;
      if (label && (q.includes(label) || label.includes(q))) textScore += 40;
      for (const w of qWords) {
        if (label.split(" ").includes(w)) textScore += 12;
        else if (label.includes(w)) textScore += 6;
        if (value.includes(w)) textScore += 3;
      }
      if (textScore === 0) return { e, score: 0 };

      let score = textScore;
      if (roleHint && e.role === roleHint.role) score += 8;
      if (!e.enabled) score -= 5;
      if (e.press) score += 2; // prefer things we can activate cleanly

      return { e, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function rank(elements: AxElement[], query: string): AxElement[] {
  return scoreElements(elements, query).map((r) => r.e);
}

/**
 * Same ranking as `rank`, with the score kept — the free confidence signal
 * behind the AGI-blueprint "critic": `rank` was already computing exactly how
 * well the top match fits before this, and discarding it. A click whose top
 * score barely clears zero, or whose next candidate is nearly as good, is
 * precisely a guess that a screenshot would later reveal as wrong — worth
 * catching before it reaches the OS, not after.
 */
export function rankScored(elements: AxElement[], query: string): Array<{ element: AxElement; score: number }> {
  return scoreElements(elements, query).map(({ e, score }) => ({ element: e, score }));
}

export interface CriticVerdict {
  ok: boolean;
  /** Present only when ok is false. */
  reason?: "weak" | "ambiguous";
}

/**
 * The critic's decision from `rankScored`'s output alone — exported so it can
 * be tested against fabricated scores, without a real accessibility tree.
 * See `rankScored`'s doc comment for what the two reasons mean.
 */
export function criticVerdict(scored: Array<{ element: AxElement; score: number }>): CriticVerdict {
  if (!scored.length) return { ok: true }; // nothing to be confident or unsure about; the caller already handles "no matches"
  const [top, second] = scored;
  if (top.score < 20) return { ok: false, reason: "weak" };
  if (second && second.score >= top.score * 0.85 && top.score < 90) return { ok: false, reason: "ambiguous" };
  return { ok: true };
}

const STOP = new Set(["the", "a", "an", "on", "in", "click", "press", "button", "field", "my", "please", "that", "this"]);

const ROLE_WORDS = [
  { word: "button", role: "AXButton" },
  { word: "checkbox", role: "AXCheckBox" },
  { word: "link", role: "AXLink" },
  { word: "tab", role: "AXTab" },
  { word: "field", role: "AXTextField" },
  { word: "search", role: "AXSearchField" },
  { word: "menu", role: "AXMenuItem" },
  { word: "dropdown", role: "AXPopUpButton" },
  { word: "slider", role: "AXSlider" },
];

/** Compact, model-friendly rendering of a dump. */
export function summarize(dump: AxDump, limit = 60): string {
  if (!dump.axAvailable || !dump.elements.length) {
    return `No accessibility data for ${dump.app}. Use a screenshot and click by coordinates instead.`;
  }
  const rows = dump.elements
    .slice(0, limit)
    .map((e) => {
      const role = e.role.replace(/^AX/, "");
      const val = e.value && e.value !== e.label ? ` = "${e.value.slice(0, 24)}"` : "";
      const off = e.enabled ? "" : " (disabled)";
      return `#${e.i} ${role} "${e.label.slice(0, 40)}"${val}${off} @${e.x + Math.round(e.w / 2)},${e.y + Math.round(e.h / 2)}`;
    })
    .join("\n");
  const more = dump.elements.length > limit ? `\n… and ${dump.elements.length - limit} more` : "";
  return `${dump.app} — ${dump.elements.length} elements:\n${rows}${more}`;
}
