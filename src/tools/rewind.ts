import { join } from "node:path";
import { getAppPath } from "../utils/appPath.js";
import { ocr } from "./vision.js";
import { append, prune, usage, migrateLegacy, loadRange, RETENTION_DAYS } from "../frontier/history.js";
import { observeText } from "../frontier/struggle.js";
import { scrubSecrets } from "../safety/redact.js";
import { captureAllowed, deletionEpoch } from "../memory/capture-policy.js";

let rewindInterval: NodeJS.Timeout | null = null;
let pruneInterval: NodeJS.Timeout | null = null;
let rewindGeneration = 0;

/**
 * Discard text the recogniser was not sure about.
 *
 * This log is what "what was I looking at earlier?" searches, so a wrong word is
 * worse than a missing one — you cannot match text that was never spelled right,
 * and garbled runs poison the embeddings that semantic search relies on.
 */
const MIN_CONFIDENCE = 0.6;

/** How often to check for history that has aged out. */
const PRUNE_EVERY_MS = 6 * 3600_000;

/**
 * Delete history older than the retention window.
 *
 * Runs on a timer rather than on every capture: pruning is a directory scan,
 * and doing it 2,880 times a day to delete something once would be absurd. Six
 * hours means the window is never more than a few hours stale, which is well
 * inside the tolerance of a limit measured in months.
 */
export function pruneHistory(now = Date.now()) {
  try {
    const res = prune(getAppPath(), RETENTION_DAYS, now);
    if (res.removedDays.length) {
      const mb = (res.freedBytes / 1_048_576).toFixed(1);
      console.log(
        `[jarvis] screen history: dropped ${res.removedDays.length} day(s) past ${RETENTION_DAYS} days, freed ${mb} MB`
      );
    }
  } catch (e) {
    console.error("[jarvis] pruning screen history failed:", e);
  }
}

export function startRewind(options: {
  intervalSeconds?: number;
  canCapture?: () => boolean;
  readScreen?: typeof ocr;
} = {}) {
  if (rewindInterval) return;
  const generation = ++rewindGeneration;
  const seconds = options.intervalSeconds ?? 120;
  const delay = Number.isFinite(seconds) ? Math.max(30, seconds) * 1000 : 120000;

  // Fold any pre-existing single-file history into per-day files before the
  // first capture, so nothing is appending to a file that is being split.
  try {
    const moved = migrateLegacy(getAppPath());
    if (moved.migrated) {
      console.log(`[jarvis] screen history: moved ${moved.migrated} entries into ${moved.days.length} daily files`);
    }
  } catch (e) {
    console.error("[jarvis] migrating screen history failed:", e);
  }

  pruneHistory();
  pruneInterval = setInterval(() => pruneHistory(), PRUNE_EVERY_MS);

  // Schedule after completion so slow OCR cannot spawn overlapping helpers.
  const capture = async () => {
    try {
      if (generation !== rewindGeneration || !captureAllowed() || options.canCapture?.() === false) return;
      const epoch = deletionEpoch();
      const result = await (options.readScreen ?? ocr)("accurate");
      if (generation !== rewindGeneration || !captureAllowed() || deletionEpoch() !== epoch || options.canCapture?.() === false) return;
      if (!result?.lines?.length) return;

      const raw = result.lines
        .filter((l) => (l.confidence ?? 1) >= MIN_CONFIDENCE)
        .map((l) => l.text)
        .join(" ")
        .trim();

      // Never let a password, API key or card number reach the screen-history
      // log — it lives for months and feeds long-term memory. Scrub before it
      // is ever written.
      const text = scrubSecrets(raw);

      // A screen of only low-confidence noise is not worth a row.
      if (text.length < 12) return;

      append(getAppPath(), { timestamp: Date.now(), text });

      // The same capture tells us whether the same problem keeps reappearing.
      // Free here: the screen has already been read and the text is in hand.
      try {
        observeText(text);
      } catch {
        /* noticing a mood must never break the recording */
      }
    } catch (e) {
      console.error("[jarvis] Rewind capture failed:", e);
    } finally {
      if (generation === rewindGeneration) rewindInterval = setTimeout(capture, delay);
    }
  };
  rewindInterval = setTimeout(capture, delay);
}

export function stopRewind() {
  rewindGeneration++;
  if (rewindInterval) clearTimeout(rewindInterval);
  if (pruneInterval) clearInterval(pruneInterval);
  rewindInterval = null;
  pruneInterval = null;
}

/** How much history there is, in words rather than bytes. */
export function describeHistory(): string {
  const u = usage(getAppPath());
  if (!u.days) return "I haven't recorded any screen history yet.";
  const mb = (u.bytes / 1_048_576).toFixed(1);
  return `I'm holding ${u.days} day${u.days === 1 ? "" : "s"} of screen history (${mb} MB), back to ${u.oldest}. Anything older than ${RETENTION_DAYS} days is deleted automatically.`;
}

export function searchRewind(query: string): string[] {
  // Guard a missing query: it used to throw TypeError on undefined.toLowerCase(),
  // which the caller swallowed into a misleading "no matches found".
  if (!query || typeof query !== "string") return [];

  try {
    const rows = loadRange(getAppPath());
    const results: string[] = [];
    const q = query.toLowerCase();

    // Search backwards (most recent first)
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].text.toLowerCase().includes(q)) {
        const date = new Date(rows[i].timestamp);
        results.push(`[${date.toLocaleString()}] ${rows[i].text}`);
        if (results.length >= 10) break; // Return max 10 results
      }
    }
    return results;
  } catch (e) {
    console.error("[jarvis] Search rewind failed:", e);
    return [];
  }
}
