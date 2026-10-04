/**
 * Composio reaches every brain AND the voice.   npm run outsidetoolstest
 *
 * Needs the network: it connects the MCP servers in the real mcp.json, which
 * is the only way to answer the question that matters. A regex over the source
 * says the call is there; it cannot say the tools arrive, that a restricted
 * agent still cannot reach them, or that the voice session — which fixes its
 * tool list in its opening handshake — attached them in time.
 *
 * The gap this pins: the three cloud brains could read mail and search GitHub
 * through Composio, while Ollama and the speech-to-speech path could not. Since
 * non-English turns route to Gemini Live, "read my email" worked in English and
 * answered "I have no such tool" in Telugu — the same account, a different Echo.
 */
import { loadEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { loadMcpConfig, connectMcpServers } from "./brain/mcp.js";
import { RealtimeVoiceSession } from "./voice/realtime.js";
import { OllamaBrain } from "./brain/ollama.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

loadEnv(process.cwd());
const cfg = loadConfig(process.cwd());
console.log("\nOutside tools reach every path\n");

if (!Object.keys(loadMcpConfig()).length) {
  console.log("  no MCP servers configured — nothing to check\n");
  process.exit(0);
}

// What is actually out there, so the checks below compare against reality
// rather than against a name someone hoped existed.
const probe = await connectMcpServers({ timeout: 60_000 });
const outside = probe.tools.map((t) => t.name);
await probe.close();
console.log(`  ${outside.length} tools on the configured servers`);
const sample = outside.find((n) => /GMAIL|GITHUB|PERPLEX/i.test(n)) ?? outside[0];
ok(!!sample, `something recognisable to look for (${sample})`);

// ── the offline brain ─────────────────────────────────────────────────────

console.log("\n  the local Ollama brain");
{
  const brain = new OllamaBrain(cfg, "http://127.0.0.1:11434");
  // initMcp is private and runs at the top of a turn; reach the same result
  // the model would see without needing Ollama itself to be running.
  await (brain as any).initMcp();
  const names: string[] = (brain as any).tools.map((t: any) => t.function?.name ?? t.name);
  ok(names.includes(sample), `it can see ${sample}`, `${names.length} tools, none from outside`);
  ok((brain as any).mcpTools.size > 0, `${(brain as any).mcpTools.size} outside tools attached`);
  // The curated local list is still there — outside tools extend it, not replace it.
  ok(names.some((n) => !n.startsWith("mcp__")), "and Echo's own tools are still in the list");
}

console.log("\n  a restricted local agent still cannot reach them");
{
  const brain = new OllamaBrain(cfg, "http://127.0.0.1:11434", { allowedTools: new Set(["screenshot"]) });
  await (brain as any).initMcp();
  ok((brain as any).mcpTools.size === 0,
    "the fleet's allowedTools contract covers outside tools too",
    `${(brain as any).mcpTools.size} leaked through`);
}

// ── the voice ─────────────────────────────────────────────────────────────

console.log("\n  the speech-to-speech session");
{
  const sent: any[] = [];
  let drive: (m: any) => void = () => {};
  const session = new RealtimeVoiceSession(cfg, "test-key", {
    workingDir: process.cwd(),
    transport: async (h) => {
      drive = h.onmessage;
      queueMicrotask(h.onopen);
      return { sendToolResponse: (r: any) => sent.push(r), sendRealtimeInput: () => {}, sendClientContent: () => {}, close: () => {} };
    },
  });
  await session.connect();
  const decls: any[] = (session as any).declarations();
  const names = decls.map((d) => d.name);
  ok(names.includes(sample), `${sample} is offered to the model`, `${names.length} declarations, none from outside`);
  ok(names.some((n) => !n.startsWith("mcp__")), "alongside Echo's own tools");

  // And the call path: a read-only outside tool, run for real through the gate.
  const read = outside.find((n) => /_GET_|_LIST_|_SEARCH$/i.test(n) && names.includes(n));
  if (read) {
    console.log(`      calling ${read} from the voice session …`);
    drive({ toolCall: { functionCalls: [{ id: "v1", name: read, args: {} }] } });
    const deadline = Date.now() + 30_000;
    while (!sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const res = sent[0]?.functionResponses?.[0]?.response;
    ok(!!res, "the model got an answer back", JSON.stringify(sent).slice(0, 80));
    // Not asserting success: the tool may legitimately need arguments. What
    // must be true is that it REACHED the tool rather than bouncing off an
    // "unknown tool" — which is exactly what this path used to do.
    ok(!/unknown tool/i.test(JSON.stringify(res ?? {})),
      "and it was not rejected as an unknown tool", JSON.stringify(res).slice(0, 100));
  }
  session.close();
}

console.log(`\n${pass}/${pass + fail} outside-tool checks passed`);
console.log("A failure here means Echo can do something in one language or brain that it cannot do in another.\n");
process.exit(fail === 0 ? 0 : 1);
