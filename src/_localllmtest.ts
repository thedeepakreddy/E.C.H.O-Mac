/**
 * The background helpers' one call to the local model.
 *
 *   npm run localllmtest
 *
 * Ghost mode, shadow mode and the auto-debugger used to each hardcode
 * `http://localhost:11434` and `llama3.2:3b`, so on any machine configured with
 * a different local model they were switched on and silently did nothing. These
 * checks pin the shared call to the configured host and model, and to returning
 * null — never an error body, never a throw — when there is nothing usable.
 */
import assert from "node:assert/strict";

const { setActiveConfig, DEFAULTS_FOR_TESTS } = await import("./config.js");
const cfg = structuredClone(DEFAULTS_FOR_TESTS);
cfg.ollama = { host: "http://ollama.fixture:9999/", model: "custom-model:7b" };
setActiveConfig(cfg);
const { localGenerate, localModel } = await import("./tools/local-llm.js");

let pass = 0;
const ok = (label: string) => { pass++; console.log(`  ✓ ${label}`); };
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const warnings: string[] = [];
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

try {
  assert.deepEqual(localModel(), { host: "http://ollama.fixture:9999", model: "custom-model:7b" });
  ok("the configured host and model are used, with the trailing slash removed");

  const seen: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input: any, init: any) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ response: "  Looks like a missing import.  " }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await localGenerate("what broke?"), "Looks like a missing import.");
  assert.equal(seen[0].url, "http://ollama.fixture:9999/api/generate");
  assert.equal(seen[0].body.model, "custom-model:7b");
  assert.equal(seen[0].body.stream, false);
  ok("a reply is requested from that host and model, and returned trimmed");

  // What Ollama actually answers when the model is not installed.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "model 'custom-model:7b' not found" }), { status: 404 })) as typeof fetch;
  assert.equal(await localGenerate("x"), null);
  assert.equal(await localGenerate("x"), null);
  assert.equal(warnings.filter((line) => line.includes("answered 404")).length, 1);
  ok("a missing model yields null, and is reported once rather than on every tick");

  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "overloaded" }), { status: 200 })) as typeof fetch;
  assert.equal(await localGenerate("x"), null);
  ok("a 200 with no response text is not spoken as an answer");

  globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
  assert.equal(await localGenerate("x"), null);
  ok("a server that is not running yields null instead of throwing");

  globalThis.fetch = ((_input: any, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
  })) as typeof fetch;
  const started = Date.now();
  // AbortSignal.timeout is unref'd; in this bare process nothing else holds the
  // event loop open while the request hangs, which the running app always does.
  const keepAlive = setTimeout(() => {}, 5000);
  try { assert.equal(await localGenerate("x", 40), null); }
  finally { clearTimeout(keepAlive); }
  assert.ok(Date.now() - started < 2000);
  ok("a server that never answers is abandoned at the deadline");

  // The defaults the Ollama brain itself uses, when nothing is configured.
  cfg.ollama = { host: "", model: "" };
  assert.deepEqual(localModel(), { host: "http://localhost:11434", model: "llama3.2:3b" });
  ok("an empty configuration falls back to the Ollama defaults");
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
}

console.log(`\n${pass}/${pass} local-model helper checks passed`);
