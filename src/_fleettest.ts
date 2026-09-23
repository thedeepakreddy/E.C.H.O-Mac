/**
 * The agent fleet roster (frontier/fleet.ts): six built-ins that cannot be
 * touched, a bounded custom roster, and a tool allowlist that can only ever
 * be a subset of the registry's own readOnly tools.
 *
 *   npm run fleettest
 *
 * Self-isolating: points JARVIS_FLEET_DIR at a scratch directory before
 * fleet.ts is ever imported, so this never touches a real fleet.json however
 * it is invoked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "echo-fleettest-"));
process.env.JARVIS_FLEET_DIR = scratch;

const { listFleet, addFleetMember, removeFleetMember, allowedToolsFor, grantableTools, getFleetMember, MAX_CUSTOM, _resetForTests } = await import("./frontier/fleet.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nAgent fleet\n");
_resetForTests();

const builtIns = listFleet();
ok(builtIns.length === 6, `six built-in agents (got ${builtIns.length})`);
ok(builtIns.every((m) => !m.custom), "every built-in is marked non-custom");
ok(["lead", "research", "plan", "write", "review", "analyse"].every((id) => builtIns.some((m) => m.id === id)), "the expected six ids are present");
ok(allowedToolsFor(builtIns[0]) === null, "a built-in agent has no tool restriction at all");

// ---- adding a custom agent -----------------------------------------------------
const grantable = grantableTools();
ok(grantable.length > 0, `there are grantable (read-only) tools to offer (${grantable.length})`);

const added = addFleetMember({ id: "tax", name: "Tax", description: "Answers about filings.", brief: "You answer tax questions.", tier: "balanced", tools: [grantable[0], "run_terminal_command"] });
ok(added.tools.includes(grantable[0]) && !added.tools.includes("run_terminal_command"), "a non-read-only tool is silently dropped from what's granted, never a write tool");
ok(listFleet().length === 7, "the roster now has seven agents");
const allowed = allowedToolsFor(added);
ok(!!allowed && allowed.has(grantable[0]) && !allowed.has("run_terminal_command"), "the custom agent's allowlist matches exactly what was granted");

// ---- re-adding the same id updates rather than duplicates ------------------------
addFleetMember({ id: "tax", name: "Tax Agent", description: "d", brief: "b", tier: "fast", tools: [] });
ok(listFleet().length === 7, "saving the same id again replaces it rather than adding a second one");
ok(getFleetMember("tax")?.name === "Tax Agent", "the replacement took effect");

// ---- built-ins are protected ----------------------------------------------------
let threwOnBuiltinAdd = false;
try { addFleetMember({ id: "lead", name: "x", description: "", brief: "b", tier: "balanced", tools: [] }); }
catch { threwOnBuiltinAdd = true; }
ok(threwOnBuiltinAdd, "cannot overwrite a built-in agent by id");

let threwOnBuiltinRemove = false;
try { removeFleetMember("research"); }
catch { threwOnBuiltinRemove = true; }
ok(threwOnBuiltinRemove, "cannot remove a built-in agent");
ok(listFleet().some((m) => m.id === "research"), "research is still there after the refused removal");

// ---- validation ------------------------------------------------------------------
let threwOnBadId = false;
try { addFleetMember({ id: "Not A Slug!", name: "x", description: "", brief: "b", tier: "balanced", tools: [] }); }
catch { threwOnBadId = true; }
ok(threwOnBadId, "an id that isn't a plain lowercase slug is refused");

let threwOnNoBrief = false;
try { addFleetMember({ id: "blank", name: "x", description: "", brief: "", tier: "balanced", tools: [] }); }
catch { threwOnNoBrief = true; }
ok(threwOnNoBrief, "an agent with no standing instructions is refused");

// ---- the custom cap ---------------------------------------------------------------
removeFleetMember("tax");
for (let i = 0; i < MAX_CUSTOM; i++) addFleetMember({ id: `agent-${i}`, name: `Agent ${i}`, description: "", brief: "b", tier: "balanced", tools: [] });
ok(listFleet().filter((m) => m.custom).length === MAX_CUSTOM, `exactly ${MAX_CUSTOM} custom agents after filling the cap`);
let threwAtCap = false;
try { addFleetMember({ id: "one-too-many", name: "x", description: "", brief: "b", tier: "balanced", tools: [] }); }
catch { threwAtCap = true; }
ok(threwAtCap, "adding past the cap is refused");
// Updating an EXISTING one at the cap must still work.
addFleetMember({ id: "agent-0", name: "Renamed", description: "", brief: "b", tier: "balanced", tools: [] });
ok(getFleetMember("agent-0")?.name === "Renamed", "updating an existing agent still works right at the cap");

// ---- removal ------------------------------------------------------------------------
removeFleetMember("agent-0");
ok(!getFleetMember("agent-0"), "removal actually removes it");
ok(listFleet().filter((m) => m.custom).length === MAX_CUSTOM - 1, "the count drops accordingly");

// ---- every swarm entry point builds brains through this factory ------------------------
// The voice tools once built clones with plain createBrain: a custom agent got its
// persona but ran on the default brain with every tool, write tools included.
const { makeFleetBrain } = await import("./frontier/fleet-brain.js");
addFleetMember({ id: "reader", name: "Reader", description: "", brief: "b", tier: "fast", tools: [grantable[0]] });
const built: Array<{ brain: string; allowed?: ReadonlySet<string> }> = [];
const fakeCreate = ((cfg: any, opts: any) => {
  built.push({ brain: cfg.brain, allowed: opts?.limits?.allowedTools });
  return { brain: {}, provider: cfg.brain };
}) as any;
const make = makeFleetBrain({ brain: "gemini" } as any, fakeCreate);
const budget = { timeoutMs: 1000, maxIterations: 5, maxRecoveryAttempts: 0 };
const identity = { id: "t", name: "T", kind: "clone" } as any;
make(identity, { profile: "reader", budget } as any);
ok(built[0].brain === "ollama", `a fast-tier custom agent runs on ollama (got ${built[0].brain})`);
ok(!!built[0].allowed && built[0].allowed.size === 1 && built[0].allowed.has(grantable[0]), "its tool grants arrive as a hard allowedTools limit");
make(identity, { profile: "review", budget } as any);
ok(built[1].brain === "claude" && built[1].allowed === undefined, "a deep-tier built-in runs on claude with no tool limit");
make(identity, { budget } as any);
ok(built[2].brain === "gemini" && built[2].allowed === undefined, "a task with no profile keeps the default brain and every tool");
removeFleetMember("reader");

_resetForTests();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} fleet cases passed\n`);
process.exit(fail ? 1 : 0);
