import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, parse } from "node:path";
import type { Display } from "./displays.js";

/**
 * Local, on-device screen understanding via the compiled visionhelper.
 *
 * OCR reads the screen's text without an image ever reaching the model — fast
 * enough to poll, free of token cost, and it returns clickable coordinates for
 * text, which is how Jarvis can act inside apps that expose no accessibility
 * tree (Chrome, Brave). Presence reports whether someone is at the camera.
 */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number; // centre — click here
  cy: number;
  /** Which display this text was found on. */
  display?: number;
  confidence: number;
}
export interface OcrResult {
  width: number;
  height: number;
  lines: OcrLine[];
  /** Which display was read, and where it sits in the global coordinate space. */
  display?: number;
  originX?: number;
  originY?: number;
  primary?: boolean;
  error?: string;
}
export interface Presence {
  present: boolean;
  faces: number;
  prominence: number; // 0..1, how much of the frame the nearest face fills
  /** Mean luminance 0..1, so "nobody there" can be told from "too dark to see". */
  brightness?: number;
  dark?: boolean;
  framesExamined?: number;
  error?: string;
}

function locate(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, "native", "visionhelper");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return candidate;
    dir = dirname(dir);
  }
}
const HELPER = locate();

export function visionAvailable(): boolean {
  return existsSync(HELPER);
}

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(HELPER, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout?.trim()) return resolve(stdout);
      reject(new Error(stderr?.trim() || err?.message || "visionhelper produced no output"));
    });
  });
}

/**
 * Every attached display, in the coordinate space the mouse uses.
 *
 * Electron's own `screen.getAllDisplays()` would do for the main process, but
 * the helper is the single source of truth here so tools, tests and the
 * capture path all agree about which display is index 1.
 */
export async function displays(): Promise<Display[]> {
  if (!visionAvailable()) return [];
  try {
    const parsed = JSON.parse(await run(["displays"], 8000)) as { displays?: Display[] };
    return parsed.displays ?? [];
  } catch {
    return [];
  }
}

/**
 * accurate mode reads more reliably; fast mode is for polling.
 *
 * `display` selects which screen to read. Coordinates come back GLOBAL — the
 * display's own offset is already applied — so a centre can be clicked
 * directly whichever monitor the text was on.
 */
export async function ocr(
  mode: "fast" | "accurate" = "accurate",
  display = 0
): Promise<OcrResult> {
  if (!visionAvailable()) return { width: 0, height: 0, lines: [], error: "helper-not-built" };
  try {
    const args = ["ocr"];
    if (mode === "fast") args.push("--fast");
    if (display) args.push("--display", String(display));
    const raw = await run(args, 15000);
    const parsed = JSON.parse(raw) as OcrResult;
    parsed.lines ??= [];
    return parsed;
  } catch (err: any) {
    return { width: 0, height: 0, lines: [], error: String(err?.message ?? err) };
  }
}

/**
 * Read every display and merge the results.
 *
 * Screens are read in sequence rather than in parallel: ScreenCaptureKit
 * contends with itself, and accurate OCR is already 1-3 seconds of CPU per
 * display. Because every coordinate is global, the merged list needs no
 * further translation — a line from the second monitor is clickable as-is.
 */
export async function ocrAll(mode: "fast" | "accurate" = "accurate"): Promise<OcrResult> {
  const list = await displays();
  if (list.length <= 1) return ocr(mode, 0);

  const merged: OcrResult = { width: 0, height: 0, lines: [] };
  for (const d of list) {
    const r = await ocr(mode, d.index);
    if (r.error) continue;
    merged.lines.push(...r.lines);
    merged.width = Math.max(merged.width, (r.originX ?? 0) + r.width);
    merged.height = Math.max(merged.height, (r.originY ?? 0) + r.height);
  }
  if (!merged.lines.length) merged.error = "no-text-found";
  return merged;
}

export async function presence(): Promise<Presence> {
  if (!visionAvailable()) return { present: false, faces: 0, prominence: 0, error: "helper-not-built" };
  try {
    return JSON.parse(await run(["presence", "--timeout", "6"], 15000));
  } catch (err: any) {
    return { present: false, faces: 0, prominence: 0, error: String(err?.message ?? err) };
  }
}

/** Compact, model-friendly rendering: text with the point to click each run. */
export function summarizeOcr(r: OcrResult, limit = 80): string {
  if (r.error) return `Could not read the screen (${r.error}).`;
  if (!r.lines.length) return "No text detected on screen.";
  const rows = r.lines
    .slice(0, limit)
    .map((l) => `"${l.text}" @${l.cx},${l.cy}`)
    .join("\n");
  const more = r.lines.length > limit ? `\n… ${r.lines.length - limit} more` : "";
  return `Screen text (${r.lines.length} runs, click coordinates given):\n${rows}${more}`;
}

export interface RankedTextMatch {
  line: OcrLine;
  score: number;
}

const normalizeText = (value: string): string =>
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Rank clickable OCR text without turning a vague overlap into a click.
 * Exact visible labels win decisively over paragraphs or longer labels that
 * merely contain the same word. Keeping every equally good result lets the
 * caller stop on repeated labels rather than guessing by scan order.
 */
export function rankText(r: OcrResult, query: string): RankedTextMatch[] {
  const q = normalizeText(query);
  if (!q) return [];
  const qWords = q.split(" ");

  return r.lines
    .map((line): RankedTextMatch => {
      const label = normalizeText(line.text);
      if (!label) return { line, score: 0 };
      if (label === q) return { line, score: 100 };
      if (label.includes(q)) return { line, score: 50 };

      const labelWords = new Set(label.split(" "));
      const shared = qWords.filter((word) => labelWords.has(word)).length;
      // Every requested word must be present. A partial phrase is not enough
      // evidence to move the user's pointer or press a control.
      return { line, score: shared === qWords.length ? 20 + shared : 0 };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      b.line.confidence - a.line.confidence ||
      a.line.text.length - b.line.text.length
    );
}

/** Two near-equal OCR hits mean the words alone do not identify one control. */
export function textMatchIsAmbiguous(matches: RankedTextMatch[]): boolean {
  return matches.length > 1 && matches[1].score >= matches[0].score * 0.9;
}

/** Best clickable text match for workflow replay and other non-interactive callers. */
export function findText(r: OcrResult, query: string): OcrLine | null {
  return rankText(r, query)[0]?.line ?? null;
}
