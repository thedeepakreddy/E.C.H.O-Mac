/** Offline regression: exercise real Ollama requests without loading a model. */
import assert from "node:assert/strict";
import { DEFAULTS_FOR_TESTS } from "./config.js";
import { OllamaBrain } from "./brain/ollama.js";
import { localContextBudget } from "./brain/local-budget.js";
import { BoundedWork } from "./utils/bounded-work.js";
import { contextTokens } from "./memory/conversation.js";
import { fitLocalTools } from "./brain/localtools.js";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRewind, stopRewind } from "./tools/rewind.js";
import { setPrivateTask } from "./memory/capture-policy.js";

const originalFetch = globalThis.fetch;
const requests: any[] = [];
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).endsWith("/api/show")) return Response.json({ model_info: { "llama.context_length": 131072 } });
  requests.push(JSON.parse(init.body));
  return new Response('{"message":{"content":"hello"},"done":true}\n');
}) as typeof fetch;
const cfg = structuredClone(DEFAULTS_FOR_TESTS);
cfg.brain = "ollama";
const brain = new OllamaBrain(cfg) as any;
const realistic = new OllamaBrain(cfg) as any;
// A minimal request isolates context allocation from unrelated tool budgets.
brain.tools = [];
brain.messages = [{ role: "user", content: "hello" }];
try {
  await brain.chat();
  assert.ok(requests[0].options.num_ctx <= 8192, `local model requested ${requests[0].options.num_ctx} tokens instead of a bounded context`);
  console.log("PASS local context stays bounded despite a model advertising 131072 tokens");
  assert.equal(requests[0].keep_alive, "60s");
  assert.equal(requests[0].options.num_thread, 2);
  assert.equal(localContextBudget(cfg, 131072, 8 * 1024 ** 3), 8192);
  assert.equal(localContextBudget(cfg, 131072, 32 * 1024 ** 3), 16384);
  assert.equal(localContextBudget({ ...cfg, context: { ...cfg.context!, providerLimits: { ollama: 4096 } } }, 131072), 4096);
  assert.equal(localContextBudget(cfg, 4096), 4096);
  console.log("PASS hardware, user, and installed-model limits all constrain allocation");

  // Ensure a bounded context still accommodates Echo's real prompt and tools.
  realistic.messages.push({ role: "user", content: "hello" });
  console.log("Local prompt/tool token estimates:", contextTokens(realistic.messages), contextTokens(realistic.tools));
  await realistic.chat();
  assert.ok(contextTokens(requests[1].messages) + contextTokens(requests[1].tools) < 8192);
  const fitted = fitLocalTools(realistic.tools, "open phone remote and set remote password", 3500);
  assert.ok(contextTokens(fitted) <= 3500);
  for (const name of ["inspect_task", "verify_task", "forget", "open_phone_remote", "set_remote_password"]) {
    assert.ok(fitted.some((t: any) => t.function.name === name), `${name} survives budget fitting`);
  }
  console.log("PASS real Echo prompt and curated tools fit the local request budget");

  let signal: AbortSignal | undefined;
  let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  globalThis.fetch = (async (_url: any, init: any) => new Promise((_resolve, reject) => {
    signal = init.signal;
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    entered();
  })) as typeof fetch;
  const request = brain.chat();
  const rejected = assert.rejects(request, { name: "AbortError" });
  await ready;
  brain.interrupt();
  await rejected;
  assert.ok(signal!.aborted);
  assert.equal(brain.requestController, null);
  console.log("PASS interrupt aborts a stalled inference request and releases its controller");
} finally {
  await brain.stop();
  await realistic.stop();
  globalThis.fetch = originalFetch;
}

const queue = new BoundedWork(2);
let release!: () => void;
let concurrent = 0, peak = 0;
const job = (wait = false) => queue.run(async () => {
  peak = Math.max(peak, ++concurrent);
  if (wait) await new Promise<void>(r => { release = r; });
  concurrent--;
  return "done";
});
const first = job(true), second = job(), third = job();
await assert.rejects(job(), /busy/);
await new Promise(r => setImmediate(r));
release();
assert.deepEqual(await Promise.all([first, second, third]), ["done", "done", "done"]);
assert.equal(peak, 1);
await assert.rejects(queue.run(async () => { throw new Error("worker failed"); }), /worker failed/);
assert.equal(await job(), "done");
console.log("PASS speech jobs serialize, reject excess backlog, and recover after failures");

// Drive the actual capture timer without waiting minutes or recording a screen.
const cwd = process.cwd(), scratch = mkdtempSync(join(tmpdir(), "echo-rewind-perf-"));
const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
let scheduled: Array<{ callback: () => Promise<void>; delay: number }> = [];
globalThis.setTimeout = ((callback: any, delay: any) => {
  const handle = { callback, delay };
  scheduled.push(handle);
  return handle;
}) as any;
globalThis.clearTimeout = ((handle: any) => { scheduled = scheduled.filter(t => t !== handle); }) as any;
process.chdir(scratch);
try {
  let finish!: (value: any) => void;
  let reads = 0;
  const screen = () => { reads++; return new Promise<any>(r => { finish = r; }); };
  startRewind({ readScreen: screen });
  assert.equal(scheduled[0].delay, 120000);
  const capture = scheduled.shift()!.callback();
  assert.equal(reads, 1);
  assert.equal(scheduled.length, 0, "no new timer while OCR is still running");
  stopRewind();
  finish({ lines: [{ text: "A captured line long enough to record", confidence: 1 }] });
  await capture;
  assert.equal(scheduled.length, 0, "stopped OCR cannot resurrect its timer");
  assert.ok(!existsSync(join(scratch, "rewind")), "stopped capture cannot write late history");

  setPrivateTask("perf-private", true);
  startRewind({ readScreen: screen });
  await scheduled.shift()!.callback();
  assert.equal(reads, 1, "private tasks never trigger OCR");
  assert.equal(scheduled.length, 1);
  stopRewind();
  setPrivateTask("perf-private", false);

  startRewind({ readScreen: screen });
  const inFlight = scheduled.shift()!.callback();
  setPrivateTask("perf-private", true);
  finish({ lines: [{ text: "Private mode changed during this capture", confidence: 1 }] });
  await inFlight;
  assert.ok(!existsSync(join(scratch, "rewind")), "privacy changes discard in-flight OCR");
  stopRewind();
  console.log("PASS rewind waits for OCR, stays stopped, and respects private tasks");
} finally {
  stopRewind();
  setPrivateTask("perf-private", false);
  globalThis.setTimeout = originalTimeout;
  globalThis.clearTimeout = originalClear;
  process.chdir(cwd);
  rmSync(scratch, { recursive: true, force: true });
}
