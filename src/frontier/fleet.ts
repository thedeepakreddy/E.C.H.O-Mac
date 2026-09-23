import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../tools/registry.js";
import { dataRoot } from "../memory/paths.js";

/**
 * The agent fleet: named, standing team members you dispatch a task to,
 * ported from Aira's "roster" concept onto Echo's own agent runtime
 * (frontier/swarm.ts already runs dependency-aware, budgeted agent tasks —
 * this is only the missing piece, a persistent identity with its own brief,
 * tools and tier, that swarm.ts's `profile` field already had a slot for and
 * nothing before now ever filled).
 *
 * Two things carried over deliberately from Aira's own design, because they
 * are the reason its editor is trustworthy rather than merely convenient:
 *
 *   The tool list a custom agent may hold comes from the registry's own
 *   `readOnly` flag, never a second hand-maintained list here that could drift
 *   and offer something the brain-construction boundary (brain/types.ts's
 *   `allowedTools`, enforced in every brain's constructor and, for Claude,
 *   ALSO in its canUseTool hook so the SDK's own Bash/Write/Edit cannot slip
 *   through) would then refuse. One list, one truth.
 *
 *   A built-in agent cannot be edited or removed, so a mistake in the roster
 *   can never leave the fleet without a working member.
 */

export type Tier = "fast" | "balanced" | "deep";

/** Which brain a tier actually runs on. Echo's own multi-provider answer to
 *  Aira's priced model tiers: free-and-local, the user's own default, or the
 *  strongest reasoner — a real axis here, not a billing category. */
export const TIER_PROVIDER: Record<Tier, "ollama" | null | "claude"> = {
  fast: "ollama",
  balanced: null, // null = whatever the user has as their default brain right now
  deep: "claude",
};

export interface FleetMember {
  id: string;
  name: string;
  description: string;
  /** Standing instructions — this agent's persona, sent with every task it runs. */
  brief: string;
  tier: Tier;
  /** Tool names this agent may use. Built-ins ignore this (see allowedToolsFor). */
  tools: string[];
  /** False for the six that ship with Echo; they cannot be edited or removed. */
  custom: boolean;
}

export type NewAgent = Omit<FleetMember, "custom">;

// Overridable the same way cognition/episodic.ts's store is, so tests never
// touch a real fleet.
function dir(): string {
  return process.env.JARVIS_FLEET_DIR?.trim() || dataRoot();
}
const FILE = () => join(dir(), "fleet.json");

/** At most this many of the user's own agents, matching Aira's bounded roster. */
export const MAX_CUSTOM = 6;

/**
 * Every read-only tool in the registry, computed fresh rather than hand-kept —
 * the actual security boundary lives in classify()/readOnly, and a second copy
 * here would only ever be able to disagree with it, never correct it.
 */
export function grantableTools(): string[] {
  return TOOLS.filter((t) => t.readOnly).map((t) => t.name);
}

/**
 * Six specialists, matching Aira's own cast and colour role so the ported
 * canvas UI has somewhere real to point its Lead/Research/Plan/Write/Review/
 * Analyse icons. Built-in agents are NOT tool-restricted — the fleet's tool
 * allowlist exists to bound what a USER can grant a new agent, not to limit
 * what Echo's own shipped specialists can do; they already go through the
 * same risk gate as every other tool call.
 */
const BUILT_IN: FleetMember[] = [
  {
    id: "lead", name: "Lead", tier: "deep", custom: false, tools: [],
    description: "Reads every other agent's report and drafts the final answer.",
    brief:
      "You are Lead. You do not do original research or writing yourself — you read the reports the " +
      "other agents on this board produced (given to you as Dependency Results) and synthesise them into " +
      "one clear, direct answer to the user's actual question. Cite which agent a claim came from when it " +
      "matters. If the reports conflict, say so rather than picking one silently. If a report is missing or " +
      "failed, answer from what you have and note the gap.",
  },
  {
    id: "research", name: "Research", tier: "balanced", custom: false, tools: [],
    description: "Gathers facts, context, and prior art before anything is written.",
    brief:
      "You are Research. Find and verify the facts the task needs — search memory, the screen, the web, " +
      "and any tool that can confirm rather than guess. Report what you found, where it came from, and how " +
      "confident you are. Flag anything you could not verify instead of stating it as fact.",
  },
  {
    id: "plan", name: "Plan", tier: "balanced", custom: false, tools: [],
    description: "Breaks the goal into a concrete, ordered plan.",
    brief:
      "You are Plan. Turn the goal into a concrete, ordered sequence of steps with the real dependencies " +
      "between them made explicit. Call out risks and open decisions the user needs to make. Do not execute " +
      "the plan yourself — that is what the plan is for.",
  },
  {
    id: "write", name: "Write", tier: "balanced", custom: false, tools: [],
    description: "Drafts the actual content — prose, code, or a document.",
    brief:
      "You are Write. Produce the actual deliverable the task asks for, in a form ready to use as-is. " +
      "Prefer the plainest structure that serves the reader. State any assumption you had to make.",
  },
  {
    id: "review", name: "Review", tier: "deep", custom: false, tools: [],
    description: "Checks the work for mistakes, gaps, and things it should not claim.",
    brief:
      "You are Review. Read the work critically rather than politely: check the specific claims, find the " +
      "gaps, and say what should change before this ships. If it holds up, say exactly why rather than just " +
      "approving it.",
  },
  {
    id: "analyse", name: "Analyse", tier: "deep", custom: false, tools: [],
    description: "Digs into data, numbers, and evidence.",
    brief:
      "You are Analyse. Work the actual numbers and evidence rather than an impression of them — compute, " +
      "compare, and show your working. State the uncertainty in a figure, not just the figure.",
  },
];

interface FleetFile {
  version: 1;
  custom: FleetMember[];
}

function ensure(): void {
  if (!existsSync(dir())) mkdirSync(dir(), { recursive: true });
}

function loadCustom(): FleetMember[] {
  if (!existsSync(FILE())) return [];
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as FleetFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.custom)) return [];
    return parsed.custom;
  } catch {
    return [];
  }
}

function saveCustom(members: FleetMember[]): void {
  ensure();
  writeFileSync(FILE(), JSON.stringify({ version: 1, custom: members } satisfies FleetFile, null, 2));
}

/** Every agent, built-in first, in the shape the control panel renders. */
export function listFleet(): FleetMember[] {
  return [...BUILT_IN, ...loadCustom()];
}

export function getFleetMember(id: string): FleetMember | null {
  return listFleet().find((m) => m.id === id) ?? null;
}

const VALID_ID = /^[a-z][a-z0-9-]{0,23}$/;

/** Add or replace one of the user's own agents. Never touches a built-in id. */
export function addFleetMember(input: NewAgent): FleetMember {
  const id = (input.id || "").trim().toLowerCase();
  if (!VALID_ID.test(id)) throw new Error('Give the agent a short id: lowercase letters, digits, and "-" only, starting with a letter.');
  if (BUILT_IN.some((m) => m.id === id)) throw new Error(`"${id}" is one of Echo's own agents and cannot be replaced.`);
  const name = (input.name || "").trim().slice(0, 40);
  if (!name) throw new Error("Give the agent a name.");
  const brief = (input.brief || "").trim().slice(0, 4000);
  if (!brief) throw new Error("Give the agent its standing instructions — what it should do and how.");
  const tier: Tier = (["fast", "balanced", "deep"] as const).includes(input.tier) ? input.tier : "balanced";
  const grantable = new Set(grantableTools());
  const tools = [...new Set((input.tools ?? []).filter((t) => grantable.has(t)))];

  const custom = loadCustom();
  const existingIndex = custom.findIndex((m) => m.id === id);
  const member: FleetMember = { id, name, description: (input.description || "").trim().slice(0, 160), brief, tier, tools, custom: true };
  if (existingIndex < 0 && custom.length >= MAX_CUSTOM) {
    throw new Error(`You can have up to ${MAX_CUSTOM} of your own agents. Remove one first.`);
  }
  const next = existingIndex >= 0 ? custom.map((m, i) => (i === existingIndex ? member : m)) : [...custom, member];
  saveCustom(next);
  return member;
}

export function removeFleetMember(id: string): void {
  if (BUILT_IN.some((m) => m.id === id)) throw new Error(`"${id}" is one of Echo's own agents and cannot be removed.`);
  saveCustom(loadCustom().filter((m) => m.id !== id));
}

/**
 * What a spawned brain for this agent may use, for `BrainExecutionLimits.allowedTools`.
 * `null` for a built-in agent means no restriction at all.
 */
export function allowedToolsFor(member: FleetMember): Set<string> | null {
  if (!member.custom) return null;
  const grantable = new Set(grantableTools());
  return new Set(member.tools.filter((t) => grantable.has(t)));
}

export function _resetForTests(): void {
  try {
    saveCustom([]);
  } catch {
    /* ignore */
  }
}
