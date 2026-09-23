/**
 * Dynamic tool pruning (AGI blueprint #9): the per-turn tool list a brain
 * actually sends, narrowed by relevance to what was asked.
 *
 *   npm run toolroutertest
 */
import { selectToolNames } from "./brain/tool-router.js";
import { TOOLS } from "./tools/registry.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nDynamic tool pruning\n");

// ---- degrade-to-everything conditions ------------------------------------------
ok((await selectToolNames("", 12)) === null, "empty text: no pruning");
ok((await selectToolNames("open safari", 0)) === null, "topK 0: no pruning");
ok((await selectToolNames("open safari", TOOLS.length + 10)) === null, "topK ≥ registry size: nothing to prune");

// ---- a real selection: relevant tools survive, unrelated ones don't -------------
const keep = await selectToolNames("open safari and check my email", 15);
ok(keep !== null, "a real request with a real topK produces a selection");
if (keep) {
  ok(keep.has("open_app"), `open_app is kept for "open safari" (kept: ${[...keep].join(", ")})`);
  // topK is on top of the always-included safety/memory tools, not shared with
  // them — an always-include list at or past topK must never crowd out every
  // relevant tool, which sharing one budget would do silently. Checked against
  // the registry size rather than a hardcoded always-include count, so this
  // does not need updating every time that list changes.
  ok(keep.size < TOOLS.length, `pruning still meaningfully shrinks the list (${keep.size} of ${TOOLS.length})`);
  ok(!keep.has("set_remote_password"), "an unrelated tool (set_remote_password) is pruned out");
}

// ---- the always-include allowlist survives even an unrelated request -----------
const keepSafety = await selectToolNames("what's the weather like", 15);
if (keepSafety) {
  ok(keepSafety.has("confirm_action"), "confirm_action is never pruned, however unrelated the request");
  ok(keepSafety.has("verify_task"), "verify_task is never pruned");
  ok(keepSafety.has("remember") && keepSafety.has("recall"), "remember/recall are never pruned");
}

// ---- a custom pool (Ollama's already-curated local-tool subset) is respected ----
const pool = [
  { name: "open_app", description: "Open a macOS application" },
  { name: "screenshot", description: "Capture the screen" },
  { name: "confirm_action", description: "Ask the user to approve something" },
  { name: "get_mouse_position", description: "Get the mouse position" },
  { name: "frontmost_app", description: "Get the frontmost app" },
];
const poolKeep = await selectToolNames("open safari", 3, undefined, pool);
if (poolKeep) {
  ok([...poolKeep].every((n) => pool.some((p) => p.name === n)), "a custom pool is never exceeded — nothing outside it is ever returned");
  ok(poolKeep.has("open_app"), "the relevant tool from the custom pool is kept");
} else {
  ok(false, `a custom pool smaller than its own topK still produced a selection (got null)`);
}
ok((await selectToolNames("open safari", 10, undefined, pool)) === null, "topK ≥ custom pool size: nothing to prune, even though it's far below the global topK");

console.log(`\n${pass}/${pass + fail} tool-pruning cases passed\n`);
process.exit(fail ? 1 : 0);
