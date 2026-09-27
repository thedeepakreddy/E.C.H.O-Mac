import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Step } from "./demonstrate.js";
import { embedder } from "../cognition/embeddings.js";
import { cosine } from "../cognition/episodic.js";
import { getAppPath } from "../utils/appPath.js";
import { dataRoot } from "../memory/paths.js";

const REFLEX_DIR = join(dataRoot(), "reflex");
const REFLEX_FILE = join(REFLEX_DIR, "cache.json");

export interface ReflexEntry {
  query: string;
  steps: Step[];
  createdAt: number;
  successes: number;
  /** The query's embedding at save time, for semantic matching. Optional: an
   *  older cache file, or one saved while the embedder was unavailable, has
   *  none — it still matches on the exact-normalized path below. */
  embedding?: number[];
}

/** A cosine below this is not "the same request", however forgiving the match. */
const SEMANTIC_THRESHOLD = 0.72;

function ensure() {
  if (!existsSync(REFLEX_DIR)) mkdirSync(REFLEX_DIR, { recursive: true });
}

export function loadCache(): Record<string, ReflexEntry> {
  if (!existsSync(REFLEX_FILE)) return {};
  try {
    return JSON.parse(readFileSync(REFLEX_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveCache(cache: Record<string, ReflexEntry>) {
  ensure();
  writeFileSync(REFLEX_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Normalise a query so that "open youtube" and "open  youtube!" match.
 */
function norm(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface ReflexMatch extends ReflexEntry {
  /** "exact" for the original normalized-string path; "semantic" when only the meaning matched. */
  matchKind: "exact" | "semantic";
  /** Cosine similarity, for semantic matches only. */
  similarity?: number;
}

/**
 * Searches the reflex cache for a match: an exact (normalized) string first,
 * then — the AGI-blueprint "local semantic reflex" — the closest entry by
 * meaning, using the same embedder episodic memory's `retrieve()` was always
 * built to accept but nothing ever supplied. "Open Safari" and "launch the
 * browser" are the same request; a normalized-string cache could never see
 * that, so it never fired unless you happened to phrase it identically twice.
 *
 * Synchronous callers keep working via `matchReflex`; semantic matching needs
 * the embedder, which is async, so it lives in `matchReflexSemantic`. Nothing
 * here is required — a missing model degrades to exact-match only, silently.
 */
export function matchReflex(query: string): ReflexEntry | null {
  const cache = loadCache();
  const nq = norm(query);
  for (const key in cache) {
    if (norm(key) === nq) return cache[key];
  }
  return null;
}

/** Exact match first; if that misses, the closest reflex by meaning, above threshold. */
export async function matchReflexSemantic(query: string, appRoot = getAppPath()): Promise<ReflexMatch | null> {
  const exact = matchReflex(query);
  if (exact) return { ...exact, matchKind: "exact" };

  const emb = embedder(appRoot);
  if (!emb.available()) return null;
  const qv = await emb.embed(query);
  if (!qv) return null;

  const cache = loadCache();
  let best: { key: string; entry: ReflexEntry; sim: number } | null = null;
  for (const key in cache) {
    const entry = cache[key];
    if (!entry.embedding?.length) continue;
    const sim = cosine(Array.from(qv), entry.embedding);
    if (sim >= SEMANTIC_THRESHOLD && (!best || sim > best.sim)) best = { key, entry, sim };
  }
  return best ? { ...best.entry, matchKind: "semantic", similarity: best.sim } : null;
}

/**
 * Saves a successful workflow into the reflex cache so it can be executed
 * instantly next time — by exact phrasing immediately, and by meaning once an
 * embedding is available (best-effort; a save never waits long for it).
 */
export async function saveReflex(query: string, steps: Step[], appRoot = getAppPath()): Promise<void> {
  const cache = loadCache();
  const nq = norm(query);
  const existingKey = Object.keys(cache).find((k) => norm(k) === nq);

  let embedding: number[] | undefined;
  try {
    const emb = embedder(appRoot);
    if (emb.available()) {
      const v = await Promise.race([
        emb.embed(query),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (v) embedding = Array.from(v);
    }
  } catch {
    /* the reflex is still worth saving without an embedding */
  }

  if (existingKey) {
    cache[existingKey].steps = steps; // overwrite with newest optimal path
    cache[existingKey].successes += 1;
    cache[existingKey].createdAt = Date.now();
    if (embedding) cache[existingKey].embedding = embedding;
  } else {
    cache[query] = { query, steps, createdAt: Date.now(), successes: 1, embedding };
  }
  saveCache(cache);
}
