/**
 * Regressions for the pre-release fixes (Sep 30 2026 audit).
 *
 *   npm run releasefixtest
 *
 * Offline. The Gemini brain runs with its model call stubbed out, so the loop,
 * the queue and the real risk gate are exercised without a network. Every file
 * it writes goes under a scratch data root.
 */
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "echo-releasefix-"));
process.env.ECHO_DATA_ROOT = scratch;
process.env.ECHO_MCP = "0";
process.env.ECHO_LOG = "0";

const { loadConfig, setActiveConfig, readUserConfig, writeUserConfig, userConfigPath } = await import("./config.js");
const { GeminiBrain } = await import("./brain/gemini.js");
const { normalizeToolOutput } = await import("./memory/tool-result.js");
const { classify } = await import("./safety/risk.js");
const { pruneRunLogs } = await import("./agent-replay/recovery.js");
const { TOOLS } = await import("./tools/registry.js");
const { JARVIS_PERSONA } = await import("./brain/types.js");
const { TurnQueue } = await import("./brain/turn-queue.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cfg = loadConfig(process.cwd());
cfg.agi.toolPruning.enabled = false; // no embedder in a unit test
cfg.agi.confidenceToDemo.enabled = false;
cfg.learning.enabled = false;
setActiveConfig(cfg);

type Call = { contents: any[] };
/** A Gemini brain whose model is a script: each call returns the next reply. */
function scriptedBrain(replies: Array<(call: Call) => any>) {
  const brain = new GeminiBrain(cfg, "test-key") as any;
  const calls: Call[] = [];
  brain.generateStreaming = async (request: any) => {
    const call = { contents: JSON.parse(JSON.stringify(request.contents)) };
    calls.push(call);
    const reply = replies[calls.length - 1]?.(call) ?? { text: "done" };
    const parts = reply.call ? [{ functionCall: reply.call }] : [{ text: reply.text }];
    return { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] };
  };
  let turnEnds = 0;
  brain.on("turnEnd", () => turnEnds++);
  return { brain, calls, turnEnds: () => turnEnds };
}
const lastUserText = (contents: any[]) =>
  (contents.filter((c) => c.role === "user").at(-1)?.parts ?? []).map((p: any) => p.text ?? "").join(" ");
/** Every model turn that calls a tool is followed directly by a user turn that starts with its response. */
const wellOrdered = (contents: any[]) =>
  contents.every((c, i) =>
    !(c.role === "model" && c.parts?.some((p: any) => p.functionCall)) ||
    Boolean(contents[i + 1]?.parts?.[0]?.functionResponse));

console.log("\nBrain turn queue (Gemini, stubbed model)\n");
{
  // Two messages before the loop has even started: one loop, both heard.
  const { brain, calls, turnEnds } = scriptedBrain([() => ({ text: "Both done." })]);
  brain.send("first thing");
  brain.send("second thing");
  await sleep(300);
  ok(calls.length === 1, `a second message during startup does not start a second loop (${calls.length} model call(s))`);
  ok(/first thing/.test(lastUserText(calls[0]?.contents ?? [])) && /second thing/.test(lastUserText(calls[0]?.contents ?? [])),
    "the first model call hears both messages");
  ok(turnEnds() === 1, "and the turn ends once");
}
{
  // A follow-up while a tool runs joins at the next step, after the tool's result.
  const { brain, calls } = scriptedBrain([
    () => ({ call: { name: "wait", args: { seconds: 0.4 } } }),
    () => ({ text: "Done, and noted." }),
  ]);
  brain.send("start the task");
  await sleep(150);
  brain.send("also this");
  await sleep(900);
  ok(calls.length === 2, `the follow-up is answered in the same loop (${calls.length} model calls)`);
  const second = calls[1]?.contents ?? [];
  ok(/also this/.test(lastUserText(second)), "the follow-up reaches the model at the next step");
  ok(wellOrdered(second), "every tool call is still followed directly by its result");
}
{
  // "Stop — now do this": the new command runs after the stopped loop unwinds.
  const { brain, calls, turnEnds } = scriptedBrain([
    () => ({ call: { name: "wait", args: { seconds: 0.4 } } }),
    () => ({ text: "On it." }),
  ]);
  brain.send("a long task");
  await sleep(150);
  brain.interrupt();
  brain.send("do this instead");
  await sleep(1000);
  ok(calls.length === 2, `the command given after a stop is not lost (${calls.length} model calls)`);
  ok(/do this instead/.test(lastUserText(calls[1]?.contents ?? [])), "the fresh loop answers the new command");
  ok(turnEnds() === 2, "the stopped turn and the new one each end");
}
{
  // What was queued before a stop belonged to the stopped task.
  const q = new TurnQueue<string>();
  q.push("old");
  q.clear();
  q.push("new");
  ok(q.takeForNextLoop().map((e) => e.item).join() === "new", "a stop clears only what was queued before it");
  q.push("a"); q.push("b", true); q.push("c");
  ok(q.takeForRunningLoop().join() === "a" && q.size === 2, "a follow-up asking for a fresh context waits for the next loop");
}

console.log("\nTool results\n");
ok(normalizeToolOutput("Wi-Fi turned on." as any).text === "Wi-Fi turned on.", "a bare string keeps its text");
ok(normalizeToolOutput("Failed: no Wi-Fi" as any).status === "failed", "and a failure in it still reads as a failure");
{
  const settings = TOOLS.find((t) => t.name === "control_mac_setting")!;
  const out: any = await settings.handler({ setting: "volume" });
  ok(typeof out === "object" && /value from 0 to 100/.test(out.text) && out.status === "failed",
    "control_mac_setting returns { text, status } — here, what was missing");
}

console.log("\nRisk ratings\n");
const tier = (tool: string, input: Record<string, unknown> = {}) => classify(tool, input, { workingDir: scratch }).tier;
ok(tier("clear_translation") === "low", "hiding the translation overlay needs no question");
ok(tier("run_agent_mission", { goal: "x" }) === "high", "a mission of autonomous agents is asked about, like spawning one");
ok(tier("control_mac_setting", { setting: "sleep" }) === "high", "sleeping the Mac is asked about");
ok(tier("control_mac_setting", { setting: "wifi", action: "off" }) === "high", "turning Wi-Fi off is asked about");
ok(tier("control_mac_setting", { setting: "wifi" }) === "high", "toggling Wi-Fi is asked about");
ok(tier("control_mac_setting", { setting: "wifi", action: "on" }) === "medium", "turning Wi-Fi on is not");
ok(tier("control_mac_setting", { setting: "volume", value: 30 }) === "medium", "changing the volume is not");
ok(tier("Bash", { command: "open -a 'Google Chrome' https://mail.google.com/mail/u/1/" }) !== "high", "opening Gmail is not 'sending an email'");
ok(tier("Bash", { command: "echo hi | mail -s test someone@example.com" }) === "high", "piping into mail still is");

console.log("\nRemoved and rewritten\n");
const names = new Set(TOOLS.map((t) => t.name));
for (const gone of ["rewind_time", "pull_from_phone", "create_jarvis_tool"]) ok(!names.has(gone), `${gone} is no longer offered to the model`);
ok(!/create_jarvis_tool|registry\.ts/.test(JARVIS_PERSONA), "the prompt no longer tells the model to edit its own code");
ok(!/respond EXACTLY/.test(JARVIS_PERSONA), "the prompt has one creator answer, not two");
ok(!/in Chrome/.test(JARVIS_PERSONA), "the email steps no longer assume Chrome");
ok(/run_terminal_command/.test(JARVIS_PERSONA) && /Bash/.test(JARVIS_PERSONA), "the prompt names the shell tools of every brain");
ok(!/do not need to ask permission to click Send/.test(JARVIS_PERSONA), "the prompt no longer contradicts itself about confirming Send");

console.log("\nUser config\n");
writeUserConfig({ ...readUserConfig("/nonexistent"), hud: { skin: "mark50" } });
ok(userConfigPath().startsWith(scratch) && readUserConfig("/nonexistent").hud?.skin === "mark50", "settings are written to the user's data folder and read back");

console.log("\nRun log pruning\n");
{
  const root = join(scratch, "runs");
  const day = 86_400_000;
  const make = (name: string, ageDays: number, status?: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (status) writeFileSync(join(dir, "checkpoint.json"), JSON.stringify({ version: 1, status, taskId: name, actor: { name: "Echo" }, runDirs: [dir] }));
    const t = (Date.now() - ageDays * day) / 1000;
    utimesSync(dir, t, t);
  };
  make("old-done", 30, "completed");
  make("old-pending", 30, "pending");
  make("fresh", 1, "completed");
  const removed = await pruneRunLogs(root, { keepDays: 14, keepRuns: 200 });
  ok(removed === 1 && !existsSync(join(root, "old-done")), "an old finished run is removed");
  ok(existsSync(join(root, "old-pending")), "an old run that can still be resumed is kept");
  ok(existsSync(join(root, "fresh")), "a recent run is kept");
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} release-fix cases passed\n`);
process.exit(fail ? 1 : 0);
