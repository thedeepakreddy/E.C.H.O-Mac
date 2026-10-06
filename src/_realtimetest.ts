/**
 * The realtime voice cannot act without the gate.   npm run realtimetest
 *
 * A speech-to-speech session decides for itself which tool to call, straight
 * from audio — no text loop in between. That is exactly what makes it fast, and
 * exactly what makes it dangerous: if it executed tools on its own it would be
 * a second, unguarded door into the same 140 tools, and every confirmation
 * Echo has ever asked for would be optional. Every brain routes execution
 * through the one choke point in safety/gate.ts; this one has to as well.
 *
 * So these are the properties worth a test, and none of them are about audio:
 *
 *   - a call is EXECUTED through runGated, not around it;
 *   - a high-risk call the user denies does NOT run, and the model is told;
 *   - a tool outside the session's allowlist never reaches the gate at all;
 *   - every call gets a response, including the failures — a dropped response
 *     leaves the session waiting forever and the user hearing nothing, which
 *     is the silent stop this project has already fixed twice in the text loop.
 */
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const contextTestRoot = mkdtempSync(join(tmpdir(), "echo-realtime-test-"));
process.env.ECHO_MEMORY_ROOT = join(contextTestRoot, "os");
process.env.ECHO_DATA_ROOT = contextTestRoot;
process.on("exit", () => rmSync(contextTestRoot, { recursive: true, force: true }));

process.env.ECHO_LOG_QUIET = "1";

const { RealtimeVoiceSession } = await import("./voice/realtime.js");
const { TOOL_MAP } = await import("./tools/registry.js");
const { confirmations } = await import("./safety/confirm.js");
const { DEFAULTS_FOR_TESTS } = await import("./config.js");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

// Two fake tools so nothing real is touched: one harmless, one the risk
// classifier is guaranteed to rate high (it runs a shell command).
let harmlessRan = 0;
let destructiveRan = 0;
// NOTE: the field is `handler`, not `run`. Getting that wrong leaves the REAL
// handler in place — the first draft of this test had a "Bash" stub that would
// genuinely have run `rm -rf ~/Documents` had the gate allowed it, and only the
// denial it was testing for saved it. Override `handler`, and assert below that
// the override is actually in force.
TOOL_MAP.set("_rt_harmless", {
  name: "_rt_harmless",
  description: "test only",
  schema: {},
  readOnly: true,
  handler: async () => { harmlessRan++; return { text: "did nothing", status: "ok" }; },
} as any);
TOOL_MAP.set("run_terminal_command", {
  ...(TOOL_MAP.get("run_terminal_command") as any),
  handler: async () => { destructiveRan++; return { text: "ran (stub — nothing executed)", status: "ok" }; },
} as any);

// Prove the stub really replaced the real shell handler before anything below
// asks the gate to deny a destructive command. If this fails, the rest of this
// file is executing real commands.
{
  const bash: any = TOOL_MAP.get("run_terminal_command");
  const probe = await bash.handler({ command: "echo __stub_probe__" });
  ok(destructiveRan === 1 && /stub/.test(String(probe.text)), "the Bash handler is a stub, not the real shell");
  destructiveRan = 0;
}

const cfg: any = {
  ...DEFAULTS_FOR_TESTS,
  control: { ...(DEFAULTS_FOR_TESTS as any).control, workingDir: process.cwd() },
  voice: { ...(DEFAULTS_FOR_TESTS as any).voice, realtime: { enabled: true } },
};

/** A fake Live session: captures what Echo sends back to the model. */
function makeSession() {
  const sent: any[] = [];
  let drive: (m: any) => void = () => {};
  const session = new RealtimeVoiceSession(cfg, "test-key", {
    workingDir: process.cwd(),
    transport: async (h) => {
      drive = h.onmessage;
      queueMicrotask(h.onopen);
      return {
        sendToolResponse: (r: any) => sent.push(r),
        sendRealtimeInput: () => {},
        sendClientContent: () => {},
        close: () => {},
      };
    },
  });
  return { session, sent, drive: (m: any) => drive(m) };
}

/** Wait until `cond` holds, so a test never races the async tool path. */
async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

console.log("\nRealtime voice — tools still go through the gate\n");

console.log("  a harmless call is executed and answered");
{
  const { session, sent, drive } = makeSession();
  await session.connect();
  const seen: string[] = [];
  session.on("tool", (n: string) => seen.push(n));
  drive({ toolCall: { functionCalls: [{ id: "c1", name: "_rt_harmless", args: {} }] } });
  await until(() => sent.length > 0);
  ok(harmlessRan === 1, `the tool actually ran (ran ${harmlessRan}x)`);
  ok(seen.includes("_rt_harmless"), "a 'tool' event was emitted for the HUD");
  ok(sent.length === 1, "exactly one tool response was sent back");
  ok(sent[0]?.functionResponses?.[0]?.response?.status === "success", `and it carried the result (status ${sent[0]?.functionResponses?.[0]?.response?.status})`);
  session.close();
}

console.log("\n  a DENIED high-risk call never runs, and the model is told");
{
  const before = destructiveRan;
  // Answer every confirmation with "no", the way a user refusing would.
  const deny = ({ id }: { id: string }) => confirmations.settle(id, false, "test");
  confirmations.on("ask", deny);
  const { session, sent, drive } = makeSession();
  await session.connect();
  drive({ toolCall: { functionCalls: [{ id: "c2", name: "run_terminal_command", args: { command: "rm -rf ~/Documents" } }] } });
  await until(() => sent.length > 0, 8000);
  ok(destructiveRan === before, `the destructive tool did NOT run (ran ${destructiveRan - before}x)`);
  ok(sent.length === 1, "the model still got a response rather than waiting forever");
  const r = sent[0]?.functionResponses?.[0]?.response;
  ok(r?.status === "denied" || /denied|refus|not allowed/i.test(String(r?.result ?? r?.error ?? "")),
    `and the response says it was refused`, JSON.stringify(r).slice(0, 90));
  confirmations.off("ask", deny);
  session.close();
}

console.log("\n  a tool outside the session's allowlist never reaches the gate");
{
  const before = harmlessRan;
  const sent: any[] = [];
  let drive: (m: any) => void = () => {};
  const session = new RealtimeVoiceSession(cfg, "k", {
    workingDir: process.cwd(),
    allowedTools: new Set(["something_else"]),
    transport: async (h) => { drive = h.onmessage; return { sendToolResponse: (r: any) => sent.push(r), sendRealtimeInput: () => {}, sendClientContent: () => {}, close: () => {} }; },
  });
  await session.connect();
  drive({ toolCall: { functionCalls: [{ id: "c3", name: "_rt_harmless", args: {} }] } });
  await until(() => sent.length > 0);
  ok(harmlessRan === before, "the tool did not run");
  ok(sent[0]?.functionResponses?.[0]?.response?.status === "denied", "it was refused as unavailable");
  session.close();
}

console.log("\n  an unknown tool is answered, not dropped");
{
  const { session, sent, drive } = makeSession();
  await session.connect();
  drive({ toolCall: { functionCalls: [{ id: "c4", name: "no_such_tool", args: {} }] } });
  await until(() => sent.length > 0);
  ok(sent.length === 1, "a response was still sent");
  ok(/unknown tool/.test(String(sent[0]?.functionResponses?.[0]?.response?.error ?? "")), "naming it as unknown");
  session.close();
}

console.log("\n  several calls in one turn are all answered together");
{
  const { session, sent, drive } = makeSession();
  await session.connect();
  drive({ toolCall: { functionCalls: [
    { id: "a", name: "_rt_harmless", args: {} },
    { id: "b", name: "no_such_tool", args: {} },
  ] } });
  await until(() => sent.length > 0);
  ok(sent[0]?.functionResponses?.length === 2, `both calls answered (got ${sent[0]?.functionResponses?.length})`);
  session.close();
}

console.log("\n  the audio and transcript events the rest of Echo listens for");
{
  const { session, drive } = makeSession();
  await session.connect();
  const got: string[] = [];
  for (const e of ["audio", "heard", "said", "interrupted", "turnComplete"]) session.on(e, () => got.push(e));
  drive({ serverContent: {
    inputTranscription: { text: "what is on my screen" },
    outputTranscription: { text: "Your editor is open." },
    modelTurn: { parts: [{ inlineData: { data: Buffer.from([1, 2, 3, 4]).toString("base64") } }] },
  } });
  drive({ serverContent: { interrupted: true } });
  drive({ serverContent: { turnComplete: true } });
  ok(got.includes("heard"), "'heard' carries the input transcript");
  ok(got.includes("said"), "'said' carries the output transcript");
  ok(got.includes("audio"), "'audio' carries the spoken PCM");
  ok(got.includes("interrupted"), "'interrupted' fires on barge-in");
  ok(got.includes("turnComplete"), "'turnComplete' ends the turn");
  session.close();
}

console.log("\n  and a closed session cannot still act");
{
  const { session, sent, drive } = makeSession();
  await session.connect();
  session.close();
  ok(!session.active, "the session reports itself closed");
  drive({ toolCall: { functionCalls: [{ id: "c5", name: "_rt_harmless", args: {} }] } });
  await new Promise((r) => setTimeout(r, 300));
  ok(sent.length === 0, "nothing is sent to a closed session");
}

console.log(`\n${pass}/${pass + fail} realtime cases passed`);
console.log("A failure here means the voice can act without the risk gate.\n");
process.exit(fail === 0 ? 0 : 1);
