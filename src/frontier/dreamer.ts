import { loadConfig, activeConfig } from "../config.js";
import { createBrain, Brain } from "../brain/index.js";
import { presenceMonitor } from "./presence.js";
import { dump as axDump } from "../tools/ax.js";
import { record, allFacts, promoteFact, type SemanticFact } from "../cognition/episodic.js";

/**
 * Practises quietly while you are away, so common paths are already learned.
 *
 * The idea is sound — rehearse navigation when nobody is waiting — but an agent
 * that drives the mouse unattended needs tight limits, and the first version had
 * none. Three rules now hold:
 *
 *   1. Look, never act. The original task list included "add a book to the cart"
 *      on Amazon, which would have put real items in a real basket while its
 *      owner was away. Nothing here may buy, send, submit, or sign in.
 *   2. Only when genuinely away. Idle is not absent — you might be reading.
 *      Watching it fight you for the cursor is worse than no rehearsal at all.
 *   3. Always clean up. Each dream previously left its brain session running, so
 *      every idle period leaked another agent.
 *
 * Off by default: it costs tokens and moves the mouse, which should be a choice.
 */

let idleTimer: NodeJS.Timeout | null = null;
let dreaming = false;
let enabled = false;
/**
 * The rehearsal currently in flight.
 *
 * Held at module scope so returning to your desk can actually stop it. Keeping
 * the handle inside startDreaming() meant "standing down" only flipped a flag
 * while the agent carried on driving the mouse.
 */
let activeBrain: Brain | null = null;
let activeDeadline: NodeJS.Timeout | null = null;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** A dream that has not finished by now is stuck; stop it. */
const MAX_DREAM_MS = 3 * 60 * 1000;

/**
 * Read-only rehearsals on pages with nothing to buy or send.
 * Anything transactional is deliberately absent.
 */
const DREAM_TASKS = [
  "Open Wikipedia's main page and read the featured article heading. Click nothing else.",
  "Open System Settings and note which panes exist. Change nothing.",
  "Open Finder and note the folders in the sidebar. Open nothing.",
  "Open github.com/trending and read the top three repository names. Do not sign in.",
];

export function setDreamingEnabled(on: boolean) {
  enabled = on;
  if (!on && idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

export function isDreaming(): boolean {
  return dreaming;
}

export function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  // Curiosity and dream-compression are independent of rehearsal ("dreaming")
  // being on — each has its own switch — so the idle timer has to run for any
  // one of the three, not only when GUI rehearsal is enabled.
  const cfg = activeConfig();
  if (!enabled && !cfg.agi.curiosity.enabled && !cfg.agi.dreamCompression.enabled) return;
  idleTimer = setTimeout(startDreaming, IDLE_TIMEOUT_MS);
}

// ---- curiosity (AGI blueprint #7) ------------------------------------------
//
// Deliberately NOT another rehearsal task for the brain above to attempt: that
// path's only guardrail is the model choosing to obey "look only" in its own
// instructions. This one is safe by construction instead — a direct
// accessibility read, structurally unable to click, type, or submit anything,
// because it never calls act.click / ax.press / act.typeText at all. It only
// ever runs when `agi.curiosity.enabled` is explicitly turned on, off by
// default like every other background watcher here.

const cataloguedApps = new Map<string, number>();
const RECATALOGUE_MS = 24 * 60 * 60 * 1000; // an app's controls rarely change; don't re-log it daily

/** Read the frontmost app's controls and remember them as a low-importance fact — never clicks anything. */
async function curiosityTick(): Promise<void> {
  try {
    const d = await axDump();
    if (!d.axAvailable || !d.elements.length || !d.app) return;
    const last = cataloguedApps.get(d.app) ?? 0;
    if (Date.now() - last < RECATALOGUE_MS) return;
    cataloguedApps.set(d.app, Date.now());

    const labels = [...new Set(d.elements.map((e) => e.label).filter(Boolean))].slice(0, 24);
    if (labels.length < 3) return; // too little to be worth remembering
    record({
      kind: "observation",
      text: `${d.app} exposes these controls: ${labels.join(", ")}.`,
    });
    console.log(`[dreamer] curiosity: catalogued ${labels.length} control(s) in ${d.app}`);
  } catch (err) {
    // Best-effort, and silent by design — a missed catalogue entry is nothing,
    // unlike every other failure mode in this file which drives real input.
    console.error("[dreamer] curiosity tick failed:", (err as any)?.message ?? err);
  }
}

// ---- self-compressing context (AGI blueprint #6) ---------------------------
//
// cognition/episodic.ts's own doc comment on `consolidate()` names exactly
// this gap: its promotion rule is lexical, so "prefers Brave" and "prefers
// Firefox" never become "avoids Chrome" on their own. Once a day, while idle,
// a free local model is asked to find that kind of connection across facts
// consolidation already promoted — read-only over the fact store, and its
// only write is `promoteFact`, which never touches an existing fact.

const COMPRESS_EVERY_MS = 24 * 60 * 60 * 1000;
let lastCompressedAt = 0;

const COMPRESS_PROMPT = `You are compressing a list of facts an assistant has learned about its user into higher-level generalisations. Only state something that is a genuine inference connecting two or more of the facts below — never repeat a fact verbatim, and never invent something the facts don't support.

Reply with ONLY a JSON array of up to 3 short strings (each under 120 characters), or [] if nothing new can be inferred. No commentary, no code fence.

Facts:
`;

/** For tests: force the next maybeCompress call to run regardless of the 24h throttle. */
export function _resetCompressionThrottleForTests(): void {
  lastCompressedAt = 0;
}

export async function maybeCompress(cfg: ReturnType<typeof activeConfig>): Promise<void> {
  if (!cfg.agi.dreamCompression.enabled) return;
  if (Date.now() - lastCompressedAt < COMPRESS_EVERY_MS) return;
  lastCompressedAt = Date.now();

  const facts = allFacts().filter((f) => f.confidence >= 0.35);
  if (facts.length < 4) return; // not enough raw material to generalise across

  const known = new Set(facts.map((f) => f.text.toLowerCase()));
  const list = facts.slice(0, 40).map((f) => `- (${f.kind}) ${f.text}`).join("\n");
  try {
    const host = (cfg.ollama.host || "http://localhost:11434").replace(/\/$/, "");
    const res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.ollama.model, prompt: COMPRESS_PROMPT + list, stream: false }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return;
    const j: any = await res.json();
    const raw = String(j?.response ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
    const inferred = JSON.parse(raw);
    if (!Array.isArray(inferred)) return;

    const sourceIds = facts.slice(0, 40).map((f) => f.id);
    let added = 0;
    for (const text of inferred) {
      if (typeof text !== "string" || !text.trim() || known.has(text.trim().toLowerCase())) continue;
      promoteFact(text.trim(), "rule", sourceIds);
      added++;
      if (added >= 3) break;
    }
    if (added) console.log(`[dreamer] compression: inferred ${added} new fact(s) from ${facts.length} existing`);
  } catch (err) {
    // The local model being unavailable or slow must never be louder than a
    // log line — this is a nice-to-have running in the background, unasked.
    console.error("[dreamer] compression pass failed:", (err as any)?.message ?? err);
  }
}

async function startDreaming() {
  const cfg = activeConfig();
  if (cfg.agi.curiosity.enabled && presenceMonitor.isAway?.()) void curiosityTick();
  void maybeCompress(cfg);

  if (dreaming) return; // a rehearsal is already running; curiosity/compression above still ran on their own schedule
  if (!enabled) {
    // Rehearsal itself is off, but curiosity/compression might not be — keep
    // the idle timer alive for their sake (resetIdleTimer already checks both).
    resetIdleTimer();
    return;
  }

  // Idle is not absent. Only rehearse when presence says nobody is there; if it
  // cannot tell, err toward doing nothing.
  if (!presenceMonitor.isAway?.()) {
    resetIdleTimer();
    return;
  }

  dreaming = true;
  const task = DREAM_TASKS[Math.floor(Math.random() * DREAM_TASKS.length)];
  console.log(`[dreamer] you seem away — rehearsing: ${task.slice(0, 58)}…`);

  // A hard ceiling, so a stuck rehearsal cannot hold the mouse indefinitely.
  activeDeadline = setTimeout(() => {
    console.log("[dreamer] taking too long — stopping");
    void endDream();
  }, MAX_DREAM_MS);

  try {
    const cfg = loadConfig(process.cwd());
    activeBrain = createBrain(cfg, {
      identity: { id: "echo-rehearsal", name: "Echo Rehearsal", kind: "rehearsal" },
      autoResume: false,
    }).brain;
    activeBrain.on("text", (t: string) => console.log(`[dreamer] ${t.slice(0, 100)}`));
    activeBrain.on("turnEnd", () => void endDream());
    activeBrain.on("error", () => void endDream());

    activeBrain.send(
      `You are rehearsing while the user is away from their desk, to learn where things are.\n\n` +
        `Task: ${task}\n\n` +
        `Strict limits: LOOK ONLY. Do not buy, add anything to a cart, send, post, submit, ` +
        `sign in, delete, or change any setting, and do not type into any field. If the task ` +
        `appears to need any of that, stop and say so instead. Keep it under ten steps.`
    );
  } catch (err) {
    console.error("[dreamer] could not start:", (err as any)?.message ?? err);
    void endDream();
  }
}

/** Tear the rehearsal down and go back to waiting. Safe to call repeatedly. */
async function endDream() {
  if (activeDeadline) {
    clearTimeout(activeDeadline);
    activeDeadline = null;
  }
  const brain = activeBrain;
  activeBrain = null;
  dreaming = false;
  if (brain) {
    try {
      // Interrupt first: stop() alone lets an in-flight turn keep acting.
      brain.interrupt();
      await brain.stop();
    } catch {
      /* nothing useful to do if teardown fails */
    }
  }
  resetIdleTimer();
}

/** Called when the user returns, so a rehearsal never fights them for the cursor. */
export function stopDreamingNow() {
  if (!dreaming) return;
  console.log("[dreamer] you're back — standing down");
  // Actually tear the agent down. Flipping the flag alone left it driving the
  // mouse while the user was trying to use their machine.
  void endDream();
}
