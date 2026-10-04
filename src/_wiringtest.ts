/**
 * Every tool is reachable, gated, and named honestly.   npm run wiringtest
 *
 * A tool can be broken in four ways that all LOOK like the model being stupid:
 *
 *   1. It is in the registry but the provider rejects its schema, so the whole
 *      request 400s and the turn dies with no explanation.
 *   2. It is named in a prompt but does not exist, so the model calls a tool
 *      that errors — or worse, gives up and says nothing.
 *   3. It exists but no brain offers it, so it is dead weight nobody can call.
 *   4. It returns nothing at all, which reads to the model as "that did not
 *      work" and is the shape of every silent stop this project has had.
 *
 * None of these are caught by typechecking, and none of them raise an error
 * anywhere near the thing that is actually wrong.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import ts from "typescript";
import { TOOLS, TOOL_MAP } from "./tools/registry.js";
import { JARVIS_PERSONA } from "./brain/types.js";
import { LOCAL_TOOL_NAMES, resolveToolName } from "./brain/localtools.js";
import { ROUTER_ALWAYS_INCLUDE } from "./brain/tool-router.js";
import { READ_ONLY, UI_ACTIONS, classify } from "./safety/risk.js";

let pass = 0;
const failures: string[] = [];
function ok(value: unknown, message: string): void {
  if (value) {
    pass++;
    console.log(`  ✓ ${message}`);
    return;
  }
  failures.push(message);
  console.log(`  ✗ ${message}`);
}

// ---- tool pruning reaches every brain --------------------------------------
//
// Gemini, OpenAI and Ollama prune per TURN, top-K by embedding similarity.
// Claude cannot: the SDK owns the session and its tool list is fixed when
// `query()` is called, so a per-turn list would mean tearing the conversation
// down every turn. It uses the SDK's DEFERRED LOADING instead — the long tail
// stays out of the prompt until tool search asks for it, which unlike top-K
// leaves nothing unreachable.
//
// The trap this pins: server-level `alwaysLoad` is OR'd with the per-tool flag,
// so leaving it `true` pins every tool in the prompt and silently undoes the
// whole thing while still typechecking.
{
  const claude = readFileSync(join(process.cwd(), "src", "brain", "claude.ts"), "utf8");
  console.log("\n  tool pruning is wired into every brain");
  for (const brain of ["gemini", "openai", "ollama"]) {
    const src = readFileSync(join(process.cwd(), "src", "brain", `${brain}.ts`), "utf8");
    ok(/toolPruning\?\.enabled/.test(src) && /selectToolNames/.test(src), `${brain} prunes per turn`);
  }
  ok(/toolPruning\?\.enabled/.test(claude), "claude reads the same config flag");
  ok(/alwaysLoad: core\.has\(t\.name\)/.test(claude), "claude marks only core tools as always-loaded");
  ok(/alwaysLoad: !pruning/.test(claude),
    "and drops the SERVER-level alwaysLoad, which is OR'd with the per-tool one and would undo it");
  ok(/searchHint/.test(claude), "deferred tools carry a search hint so tool search can find them");

  // The tools a first spoken command needs must never sit behind a search:
  // that costs a whole extra model round trip before Echo can even look.
  const core = new Set([...LOCAL_TOOL_NAMES, ...ROUTER_ALWAYS_INCLUDE]);
  for (const n of ["screenshot", "click_ui_element", "type_text", "open_app", "recall", "confirm_action"]) {
    ok(core.has(n), `${n} stays loaded`);
  }
  const loaded = TOOLS.filter((t) => core.has(t.name)).length;
  ok(loaded > 20 && loaded < TOOLS.length,
    `the always-loaded set is a real subset (${loaded} of ${TOOLS.length})`);
  ok([...core].every((n) => TOOLS.some((t) => t.name === n)), "core names are checked against the registry");
}

// ---- every brain gets every feature ----------------------------------------
//
// The recurring failure in this codebase is not a broken feature, it is a
// feature wired into ONE brain: the persona once loaded memories for Claude and
// Ollama but not Gemini, tool pruning skipped Claude entirely, and the
// struggle-aware reply style was Claude-only — so the same person got a
// measurably different Echo depending on which model happened to be answering.
//
// A table is the cheapest way to keep that honest. Add a row when a brain gains
// something the others should have too.
{
  console.log("\n  no feature belongs to only one brain");
  const brains = ["gemini", "claude", "openai", "ollama"];
  const src = Object.fromEntries(
    brains.map((b) => [b, readFileSync(join(process.cwd(), "src", "brain", `${b}.ts`), "utf8")])
  );
  const features: Array<[string, RegExp]> = [
    ["risk gate", /runGated\(/],
    ["shared persona + memory", /buildSystemPrompt\(/],
    ["tool pruning", /toolPruning\?\.enabled/],
    ["loop exit reasons", /loop\.exit|currentLoop\(\)|log\(\)\?\.exit/],
    ["token usage recorded", /recordLLM|input_tokens|promptTokens/],
    ["audio turns", /AudioTurn/],
    ["interrupt", /interrupt\(|AbortController|abortSignal/],
    ["memory invalidation", /takeInvalidation\(/],
    ["fleet allowedTools", /allowedTools/],
    ["struggle-aware style", /styleFor\(assess\(\)\)/],
    ["voice turn contract", /VOICE_TURN_CONTRACT/],
    // Ollama had none of this. The other three could read mail and search
    // GitHub through Composio; the offline one answered that no such tool
    // existed — the same account, a different Echo.
    //
    // Two legitimate routes, hence the alternation. Gemini, OpenAI and Ollama
    // drive the shared client themselves; the Claude brain hands the same
    // `mcp.json` entries to the Agent SDK, which owns the connection. Both
    // end at the same servers, and a row that demanded one mechanism would
    // be testing the plumbing rather than whether the tools arrive.
    ["outside tools (MCP)", /connectMcpServers\(|mcpServers:\s*\{/],
    // Gated through ONE adapter. Gemini and OpenAI each carried their own
    // copy, which had already drifted (one logged a failed audio playback,
    // the other swallowed it). Claude is the exception on purpose: the SDK
    // routes its MCP calls through `canUseTool`, which reaches the same
    // `decide()` the adapter does.
    ["one MCP→gate adapter", /mcpToolDef\(|canUseTool/],
    // Jev lives inside decide(), which only runGated and Claude's canUseTool
    // reach. A brain that ran a handler directly would skip the second
    // opinion without skipping anything visible.
    ["TypeSafe Jev (via the gate)", /runGated\(|decide\(/],
  ];
  for (const [name, re] of features) {
    // Local models use the shared compact persona and bounded memory packet;
    // demanding the much larger cloud prompt would undo the M2 resource fix.
    const missing = brains.filter((b) => name === 'shared persona + memory' && b === 'ollama'
      ? !(/LOCAL_PERSONA/.test(src[b]) && /this\.memory\.packet\(/.test(src[b]))
      : !re.test(src[b]));
    ok(missing.length === 0, missing.length ? `${name} is MISSING in ${missing.join(", ")}` : `${name} reaches every brain`);
  }
}

// ---- every brain is recognisable to the training recorder ------------------
//
// `learnSource` mapped claude/gemini/ollama and fell through to "unknown" for
// everything else — and `Source` has always allowed "openai". So a turn on the
// OpenAI brain was filed as unknown, and `learnModel` fell through ITS last
// line and recorded the Claude model name against it. Not a gap: wrong data,
// in a file whose whole purpose is to be trained on.
//
// The two lists are in different files, which is how they drifted, so this
// compares them directly.
{
  console.log("\n  the trajectory recorder knows every brain");
  const mainSrc = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
  const cfgSrc = readFileSync(join(process.cwd(), "src", "config.ts"), "utf8");

  // The brains config.ts allows, straight from its union.
  const union = /brain:\s*((?:"[a-z]+"\s*\|\s*)*"[a-z]+")\s*;/.exec(cfgSrc)?.[1] ?? "";
  const brains = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  ok(brains.length >= 4, `config allows ${brains.length} brains (${brains.join(", ")})`);

  const map = mainSrc.slice(mainSrc.indexOf("const BRAIN_SOURCES"));
  const mapped = map.slice(0, map.indexOf("};"));
  for (const b of brains) {
    ok(new RegExp(`\\b${b}:`).test(mapped), `${b} maps to a real source, not "unknown"`);
  }
  // And a model name for each, so none falls through to another brain's.
  const model = mainSrc.slice(mainSrc.indexOf("function learnModel"));
  const body = model.slice(0, model.indexOf("\n}"));
  for (const b of brains) {
    ok(new RegExp(`provider === "${b}"`).test(body) || b === "claude",
      `${b} records its own model name`);
  }
}

// ---- the spoken path is recorded too ---------------------------------------
//
// `recordStep` and `finishTurn` both return early without an active turn, so
// a path that never calls `beginLearnedTurn` contributes nothing and its
// `finishTurn("success")` labels a turn that was never opened. The realtime
// session did exactly that — and since language routing sends every
// non-English turn there, the Telugu and Hindi half of real usage was
// invisible to the dataset.
{
  console.log("\n  the spoken session is recorded like any other turn");
  const mainSrc = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
  const fn = mainSrc.slice(mainSrc.indexOf("async function dispatchToRealtime"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  ok(/beginLearnedTurn\(/.test(body), "it opens a recorded turn before streaming audio");
  // Ordering: a turn opened after the tools have run records none of them.
  ok(body.indexOf("beginLearnedTurn(") < body.indexOf("session.push"),
    "and opens it BEFORE the audio goes out, not after");
}

// ---- the voice path is a brain too -----------------------------------------
//
// Speech-to-speech is a fifth place that runs tools, and it is invisible in
// the table above because it is not in src/brain. It matters most for exactly
// the tools added last: non-English turns route to Gemini Live, so without
// this, "read my email" worked in English and answered "I have no such tool"
// in Telugu.
{
  console.log("\n  the realtime voice session reaches the same tools");
  const rt = readFileSync(join(process.cwd(), "src", "voice", "realtime.ts"), "utf8");
  ok(/connectMcpServers\(/.test(rt), "it connects the configured MCP servers");
  ok(/mcpToolDef\(/.test(rt), "and gates what they return through the shared adapter");
  ok(/runGated\(/.test(rt), "which means the same risk gate as every brain");
  // A Live session fixes its tool list in the setup message, so attaching
  // after the socket is open would silently offer nothing for the whole call.
  const open = rt.slice(rt.indexOf("private async open("));
  ok(open.indexOf("attachMcp()") < open.indexOf("this.opts.transport"),
    "and attaches them BEFORE the session opens, when the tool list is still changeable");
  ok(/allowedTools && !allowed/.test(rt) || /if \(allowed && !allowed\.has\(t\.name\)\) continue;/.test(rt),
    "a restricted session filters outside tools too, not just Echo's own");
}

// ---- only one Echo ---------------------------------------------------------
//
// A second instance boots its own microphone, brain and voice, and the two
// answer the same room — and each other. It looked like "two Echos speaking"
// for a long time before anyone traced it: the guard called `app.quit()`, which
// is ASYNCHRONOUS, from top-level module code with nowhere to return to, so the
// losing instance carried on booting. `before-quit` then preventDefault()s the
// quit for an async teardown, actively delaying the exit it had asked for.
{
  const main = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
  console.log("\n  only one instance ever runs");
  ok(/requestSingleInstanceLock\(\)/.test(main), "the single-instance lock is taken");
  ok(/if \(!isPrimaryInstance\) \{[\s\S]{0,200}?app\.exit\(/.test(main),
    "losing it calls app.exit (immediate), not app.quit (async, and blockable by before-quit)");
  ok(/app\.whenReady\(\)[\s\S]{0,200}?if \(!isPrimaryInstance(?: \|\| shuttingDown)?\) return;/.test(main),
    "and whenReady refuses to start a second assistant even if the exit is slow");
}

const names = new Set(TOOLS.map((t) => t.name));
console.log(`\nTool wiring — ${TOOLS.length} tools\n`);

console.log("  the registry itself");
{
  const dupes = TOOLS.map((t) => t.name).filter((n, i, all) => all.indexOf(n) !== i);
  ok(dupes.length === 0, `no duplicate tool names${dupes.length ? `: ${[...new Set(dupes)].join(", ")}` : ""}`);

  // Both providers accept [a-zA-Z0-9_-]{1,64}; Gemini additionally rejects a
  // leading digit. Staying inside the stricter set keeps one registry valid
  // for every brain.
  const badName = TOOLS.filter((t) => !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(t.name));
  ok(badName.length === 0, `every name is portable across providers${badName.length ? `: ${badName.map((t) => t.name).join(", ")}` : ""}`);

  const noDesc = TOOLS.filter((t) => !t.description?.trim() || t.description.trim().length < 20);
  ok(noDesc.length === 0, `every tool describes itself${noDesc.length ? `: ${noDesc.map((t) => t.name).join(", ")}` : ""}`);

  const noHandler = TOOLS.filter((t) => typeof t.handler !== "function");
  ok(noHandler.length === 0, `every tool has a handler${noHandler.length ? `: ${noHandler.map((t) => t.name).join(", ")}` : ""}`);

  // TOOL_MAP is how the Ollama loop dispatches. It was built halfway up the
  // file, above ten TOOLS.push() calls, so those ten were offered to the model
  // and then answered "No such tool" when called.
  const unmapped = TOOLS.filter((t) => !TOOL_MAP.has(t.name));
  ok(unmapped.length === 0,
    `every tool is dispatchable by name${unmapped.length ? `: ${unmapped.map((t) => t.name).join(", ")}` : ""}`);
  ok(TOOL_MAP.size === TOOLS.length, `the dispatch map covers the registry (${TOOL_MAP.size}/${TOOLS.length})`);
}

console.log("  provider schema conversion");
{
  const broken: string[] = [];
  const freeform: string[] = [];
  for (const tool of TOOLS) {
    try {
      const json: any = z.toJSONSchema(z.object(tool.schema), { io: "input" });
      for (const [field, node] of Object.entries<any>(json.properties ?? {})) {
        // An array with no item type is invalid for both providers.
        if (node?.type === "array" && !node.items) {
          broken.push(`${tool.name}.${field} (array with no item type)`);
        }
        // A z.record() becomes an OBJECT with no properties. Gemini's docs used
        // to require properties to be non-empty for OBJECT, and this is the
        // shape that 400s the WHOLE request — every tool with it, not just the
        // one. Checked against the run tapes rather than assumed: requests
        // carrying these declarations came back with responses and no errors,
        // so it is accepted today. Listed, not failed, so a future tightening
        // is visible here rather than as an unexplained dead turn.
        if (node?.type === "object" && !Object.keys(node.properties ?? {}).length) {
          freeform.push(`${tool.name}.${field}`);
        }
      }
    } catch (err: any) {
      broken.push(`${tool.name} (${err?.message ?? err})`);
    }
  }
  ok(broken.length === 0, `every schema converts to JSON Schema${broken.length ? `:\n      ${broken.join("\n      ")}` : ""}`);
  if (freeform.length) console.log(`      (free-form object params, accepted by Gemini today: ${freeform.join(", ")})`);
}

console.log("  prompts name tools that exist");
{
  // Anything in the persona shaped like a tool name. A prompt that promises a
  // tool the registry does not have is worse than not mentioning it: the model
  // calls it, gets an error it cannot act on, and often just stops.
  // Filenames and JSON keys are snake_case too; only tool-shaped words that are
  // not something else count.
  const NOT_TOOLS = new Set([
    "tool_calls", "long_term_memory", "e_c_h_o", "claude_code", "working_dir",
    "system_prompt", "api_key", "config_json", "shortcuts_json", "health_record",
    // The XML tag the memory packet arrives in, not a tool.
    "echo_context",
    // YouTube's own URL query parameter, from the "take the direct route"
    // section's example deep link — not a tool.
    "search_query",
  ]);
  const mentioned = [...new Set(JARVIS_PERSONA.match(/\b[a-z][a-z0-9]*(?:_+[a-z0-9]+)+\b/g) ?? [])]
    .filter((word) => !NOT_TOOLS.has(word));
  // An mcp__ name comes from a server in mcp.json, not the registry, so it
  // cannot be resolved here — but it MUST carry the prefix, because that is the
  // name the brain registers it under. The persona used to promise Telugu
  // speech through `sarvam_tools_tts_speak`; the real tool is
  // `mcp__sarvam__sarvam_tools_tts_speak`, and the bare name answers
  // "unknown tool".
  const ghosts = mentioned.filter((word) => !names.has(word) && !word.startsWith("mcp__"));
  ok(ghosts.length === 0, `the persona names only real tools${ghosts.length ? `: ${ghosts.join(", ")}` : ""}`);
  const external = mentioned.filter((word) => word.startsWith("mcp__"));
  console.log(`      (${mentioned.length - ghosts.length - external.length} registry tools + ${external.length} MCP tools named in the persona)`);
}

console.log("  every way in answers a pending permission question");
{
  // Check the exact entry-point bodies; behavioral races are also covered
  // by mainruntimetest. This wiring fault looks
  // exactly like the model being stupid: Echo asks "shall I send this?", the
  // answer arrives by a path that does not know a question is open, the answer
  // becomes a new command, the question times out as a refusal, and the model
  // asks again. Measured in a real session: three permission questions, every
  // typed answer lost. Pin all four entry points to the shared check.
  // The bundle runs from dist/, so reach back to the source tree.
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
  const bodyContains = (name: string, text: string) => ast.statements.some(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === name && node.body?.getText(ast).includes(text));
  ok(bodyContains('handleTypedInput', 'maybeAnswerConfirmation'), 'typing in the HUD routes an answer to the waiting question');
  ok(bodyContains('handleRemoteCommand', 'maybeAnswerConfirmation'), 'the phone remote and Telegram route an answer to the waiting question');
  const entryPoints: Array<[string, RegExp]> = [
    ["the voice path", /confirmations\.isWaiting/],
    // send-text delegates to handleTypedInput (shared with other typed-input
    // callers), so check the function that actually handles it — same style
    // as the Telegram entry below — rather than the registration call site,
    // which no longer has the check inline.
    // The phone and Telegram share one handler, so check that it asks, and
    // that both actually go through it.
    ["the phone remote", /setCommandHandler\(\(text: string\) => handleRemoteCommand\(text, "phone"\)\)/],
    ["Telegram", /function handleTelegramCommand[\s\S]{0,120}?handleRemoteCommand\(text, "telegram"\)/],
  ];
  for (const [what, pattern] of entryPoints) {
    ok(pattern.test(main), `${what} routes an answer to the waiting question`);
  }
  ok(/ipcMain\.on\("send-text"[\s\S]{0,100}?handleTypedInput/.test(main),
    "send-text is actually reachable to handleTypedInput, not just defined");
  ok(/function maybeAnswerConfirmation[\s\S]{0,900}?ConfirmationBroker\.readAnswer/.test(main),
    "and they all share one reader, so yes means the same thing everywhere");
}

console.log("  the local model's short list");
{
  const missing = LOCAL_TOOL_NAMES.filter((name) => !names.has(name));
  // Drift here is silent by design: toolsForLocalModel falls back to ALL tools,
  // which is the exact condition that makes a 3B model invent names.
  ok(missing.length === 0, `every shortlisted tool exists${missing.length ? `: ${missing.join(", ")}` : ""}`);

  const offered = TOOLS.filter((t) => LOCAL_TOOL_NAMES.includes(t.name));
  ok(offered.length >= 10, `the shortlist survives the fallback threshold (${offered.length} offered)`);
}

console.log("  the risk gate knows these tools");
{
  // The SDK's own built-ins (Read, Bash, Write…) are named here too and are not
  // in Echo's registry, so only Echo-shaped names are checked for drift.
  const gateNames = [...READ_ONLY, ...UI_ACTIONS].filter((name) => /^[a-z][a-z0-9_]*$/.test(name));
  const stale = gateNames.filter((name) => !names.has(name));
  ok(stale.length === 0, `no risk rule names a tool that no longer exists${stale.length ? `: ${stale.join(", ")}` : ""}`);

  // Every tool that can change something must classify as more than low, or it
  // reaches the handler without anyone being asked.
  const unclassified = TOOLS.filter((t) =>
    t.readOnly === false && classify(t.name, {}, { workingDir: "/tmp" }).tier === "low"
  );
  console.log(`      (${unclassified.length} mutating tools classify as low risk${unclassified.length ? `: ${unclassified.map((t) => t.name).join(", ")}` : ""})`);
}

console.log("  name resolution for small models");
{
  ok(resolveToolName("screenshot") === "screenshot", "an exact name resolves to itself");
  ok(resolveToolName("update_hand_gesture_params") === "toggle_hand_gestures",
    "the observed invented name still maps to the real tool");
  ok(resolveToolName("") === null, "an empty name resolves to nothing");
}

console.log(`\n${pass}/${pass + failures.length} wiring checks passed\n`);
if (failures.length) {
  console.error(`${failures.length} problem(s):\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
