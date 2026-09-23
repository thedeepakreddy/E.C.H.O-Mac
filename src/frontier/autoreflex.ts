import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embedder } from "../cognition/embeddings.js";
import { cosine } from "../cognition/episodic.js";
import { getAppPath } from "../utils/appPath.js";
import * as demo from "./demonstrate.js";
import { matchReflexSemantic, saveReflex } from "./reflex.js";
import { confirmations } from "../safety/confirm.js";
import { dataRoot } from "../memory/paths.js";

/**
 * AGI-blueprint #2 (self-improving / "autonomous CI/CD") and #3 (procedural
 * memory), built out of what already exists rather than a new execution path:
 *
 *   reflex.ts already had a `saveReflex` nothing ever called, and
 *   demonstrate.ts already had a step recorder nothing ever fed (see the two
 *   fixes in reflex.ts and registry.ts alongside this file) — a workflow the
 *   user demonstrates by hand, and a fast-path cache Echo could save its own
 *   successful runs into, but no bridge between "I just did this GUI task
 *   successfully" and "save it".
 *
 * This is that bridge, and nothing more: no code generation, no sandbox, no
 * new tool, no write the model or the user did not approve. The one new
 * capability is noticing "I have done something like this before" — which
 * needs a notion of what "like" means for a spoken or typed request, hence
 * the shared embedder — and asking before keeping the fast path, exactly like
 * a user teaching a workflow by hand asks nothing because they are watching.
 *
 * Recording only ever produces a saved reflex on an explicit yes; a failed or
 * declined attempt is discarded, never silently kept for next time.
 */

const DIR = join(dataRoot(), "reflex");
const CANDIDATES_FILE = join(DIR, "candidates.json");
const MAX_CANDIDATES = 40;
/** How similar a request has to be to something seen before to count as "again". */
const RECUR_THRESHOLD = 0.78;
/** Only turns with at least this many GUI steps are worth remembering — a
 *  one-click "open Safari" is barely faster to replay than to just do. */
const MIN_STEPS_TO_OFFER = 2;

interface Candidate {
  text: string;
  embedding: number[];
  at: number;
}

function ensure(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function loadCandidates(): Candidate[] {
  if (!existsSync(CANDIDATES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CANDIDATES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveCandidates(list: Candidate[]): void {
  ensure();
  writeFileSync(CANDIDATES_FILE, JSON.stringify(list.slice(-MAX_CANDIDATES)));
}

export interface TurnCapture {
  /** True when this turn's GUI actions are being recorded (finish it in endTurn). */
  capturing: boolean;
}

/**
 * Called as a command is dispatched to the brain. Looks for a past successful
 * command similar enough to be "the same ask again"; if this is at least the
 * second time AND nothing is already recording (never steal the user's own
 * `learn_workflow` session), starts capturing this turn's steps.
 */
export async function beginTurn(command: string, cfg: { enabled: boolean }, appRoot = getAppPath()): Promise<TurnCapture> {
  if (!cfg.enabled || demo.isRecording()) return { capturing: false };
  const text = command.trim();
  if (text.length < 4) return { capturing: false };

  const emb = embedder(appRoot);
  if (!emb.available()) return { capturing: false };
  const v = await emb.embed(text);
  if (!v) return { capturing: false };

  // Already have a fast path for this? Nothing to learn.
  const already = await matchReflexSemantic(text, appRoot).catch(() => null);
  if (already) return { capturing: false };

  const seenBefore = loadCandidates().some((c) => cosine(Array.from(v), c.embedding) >= RECUR_THRESHOLD);

  // Remember this ask regardless, so the NEXT similar one recognises it.
  const list = loadCandidates();
  list.push({ text, embedding: Array.from(v), at: Date.now() });
  saveCandidates(list);

  if (!seenBefore) return { capturing: false };
  demo.startRecording(text);
  return { capturing: true };
}

/**
 * Called when the turn ends. If it was being captured and finished cleanly
 * with real GUI steps, ask before keeping it — never save on a failure, a
 * denial, or silently.
 */
export async function endTurn(command: string, capture: TurnCapture, success: boolean, appRoot = getAppPath()): Promise<void> {
  if (!capture.capturing) return;
  const recorded = demo.peekRecording();
  demo.cancelRecording(); // always clear demonstrate.ts's slot — this never writes to the workflow library

  if (!success || !recorded || recorded.steps.length < MIN_STEPS_TO_OFFER) return;

  const approved = await confirmations
    .request(`I noticed you've asked for this before. Want me to remember the fast path so it's instant next time?`)
    .catch(() => false);
  if (!approved) return;
  await saveReflex(command, recorded.steps, appRoot).catch((err) =>
    console.error("[autoreflex] could not save the reflex:", (err as any)?.message ?? err)
  );
}

/** For tests: clear the candidate log. */
export function _resetForTests(): void {
  try {
    saveCandidates([]);
  } catch {
    /* ignore */
  }
}
