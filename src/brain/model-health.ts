import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot } from "../memory/paths.js";

/**
 * What this API key has actually learned about each model.
 *
 * Two facts were being rediscovered on every single turn, at the cost of a
 * network round trip and a logged error each time:
 *
 *   1. Google retires models per key without warning. On this machine
 *      2.0-flash, 2.5-flash, 1.5-flash and 1.5-pro all answer 404 and have for
 *      weeks — yet they sat in the fallback ladder, so every exhausted turn
 *      paid four pointless calls before giving up. One evening's run logs held
 *      160 of those 404s.
 *   2. The free tier's quota is per model per day. A model that answers 429 at
 *      noon will answer 429 all afternoon, and Echo asked it again every turn:
 *      238 of them in the same logs.
 *
 * Both are now remembered on disk, so each failure is paid once instead of
 * forever. Nothing here changes which models Echo prefers — it only stops it
 * from asking questions it already knows the answer to.
 */

export type HealthReason = "not found" | "quota";

interface Note {
  /** Why the model was written off, when it 404s. */
  dead?: string;
  /** Epoch ms after which a quota-exhausted model is worth trying again. */
  until?: number;
  /** When this note was written, so a dead model can be re-probed eventually. */
  at: number;
}

/** A model written off as gone is re-probed after this, in case access returns. */
const DEAD_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** A per-minute rate limit clears in well under this; a daily one does not. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

class ModelHealth {
  private notes: Record<string, Note> | null = null;
  /** The path the cached notes were read from, so a changed data root reloads. */
  private loadedFrom: string | null = null;

  /**
   * Resolved per access rather than captured at construction.
   *
   * This is a module-level singleton, so a path fixed at import time could
   * never honour a data root set afterwards — and because `markExhausted`
   * WRITES, a test run was recording its stubbed failures into the real
   * ~/.jarvis/model-health.json and benching every live Gemini model for five
   * minutes. `dataRoot()` is the same seam the rest of the app already uses.
   */
  private get file(): string {
    return join(dataRoot(), "model-health.json");
  }

  private load(): Record<string, Note> {
    const file = this.file;
    if (this.notes && this.loadedFrom === file) return this.notes;
    try {
      this.notes = JSON.parse(readFileSync(file, "utf8")) as Record<string, Note>;
    } catch {
      this.notes = {};
    }
    this.loadedFrom = file;
    return this.notes!;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.notes ?? {}, null, 2));
    } catch {
      /* a health note is an optimisation, never a reason to fail a turn */
    }
  }

  /** True when this model is worth spending a request on right now. */
  usable(model: string): boolean {
    const note = this.load()[model];
    if (!note) return true;
    const now = Date.now();
    if (note.dead) return now - note.at > DEAD_RETRY_AFTER_MS;
    if (note.until) return now >= note.until;
    return true;
  }

  /** The given ladder, in order, without the models we know will fail, and without duplicates. */
  ladder(models: (string | undefined)[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of models) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (this.usable(m)) out.push(m);
    }
    return out;
  }

  /** This key cannot use this model at all — remember it rather than asking weekly. */
  markDead(model: string, detail: string): void {
    const notes = this.load();
    if (notes[model]?.dead) return;
    notes[model] = { dead: detail.slice(0, 200), at: Date.now() };
    this.save();
    console.warn(`[gemini] ${model} is not available to this key — dropping it from the ladder`);
  }

  /**
   * Out of quota. A daily cap holds until Google's reset (midnight Pacific), a
   * per-minute one clears in moments, and the error text says which it is.
   */
  markExhausted(model: string, detail: string): void {
    const daily = /per ?day|PerDay|GenerateRequestsPerDay/i.test(detail);
    const until = daily ? nextPacificMidnight() : Date.now() + RATE_LIMIT_COOLDOWN_MS;
    const notes = this.load();
    notes[model] = { until, at: Date.now() };
    this.save();
    const when = daily ? "its daily quota resets" : "the rate limit clears";
    console.warn(`[gemini] ${model} is out of quota — skipping it until ${when} (${new Date(until).toLocaleTimeString()})`);
  }

  /** Plain-language account of why nothing is usable, for the error the user sees. */
  explain(models: (string | undefined)[]): string {
    const notes = this.load();
    const now = Date.now();
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const m of models) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const note = notes[m];
      if (!note) continue;
      if (note.dead) parts.push(`${m}: not available to this key`);
      else if (note.until && note.until > now) parts.push(`${m}: out of quota until ${new Date(note.until).toLocaleTimeString()}`);
    }
    return parts.join("; ");
  }

  /** Testing seam. */
  reset(): void {
    this.notes = {};
    this.loadedFrom = this.file;
    this.save();
  }
}

/** Google's free-tier daily quotas reset at midnight Pacific. */
function nextPacificMidnight(): number {
  const now = new Date();
  const pacificNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offset = now.getTime() - pacificNow.getTime();
  const midnight = new Date(pacificNow);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() + offset;
}

export const modelHealth = new ModelHealth();
