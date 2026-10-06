#!/usr/bin/env node
/**
 * One command for every test.
 *
 *   npm test                typecheck, then isolated offline tests
 *   npm run test:live        tests that call real remote services
 *   npm run test:device      tests that use audio, screen or local models
 *   npm test -- coding      offline tests whose name contains "coding"
 *
 * Tests are discovered from package.json: any script ending in "test", plus
 * "check" and "e2e". Declare real service/device dependencies in test-modes.mjs.
 * Each command owns a temporary data directory, process group and deadline.
 */
import {runTestCommand} from "./test-command.mjs";
import {LIVE_TESTS, DEVICE_TESTS, selectTests} from "./test-modes.mjs";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.env.ECHO_TEST_RUNNER) {
  console.error("test-all: already running inside the test runner — refusing to start again.");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--live") && args.includes("--device")) throw new Error("Choose --live or --device, not both.");
const mode = args.includes("--live") ? "live" : args.includes("--device") ? "device" : "offline";
const live = mode === "live";
const filters = args.filter((a) => !a.startsWith("--"));

const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
const tests = selectTests(scripts, mode, filters);
const cancelled = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => cancelled.abort());

async function run(cmd, cmdArgs) {
  const scratch = mkdtempSync(join(tmpdir(), "echo-test-run-"));
  const env = {...process.env, ECHO_TEST_RUNNER: "1", ECHO_DATA_ROOT: scratch,
    ECHO_MEMORY_ROOT: join(scratch, "memory", "os")};
  // A test may select its own cassette/log directory. An inherited override
  // would redirect fixture recordings away from the directory being asserted.
  for (const key of ['ECHO_LOG_DIR', 'ECHO_REPLAY_DIR', 'ECHO_REPLAY_RUN', 'ECHO_REPLAY_PROVIDER']) delete env[key];
  if (mode === 'offline') {
    env.ECHO_MCP = '0';
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(join(ROOT, 'scripts/test-network-guard.mjs'))}`;
  }
  try {return await runTestCommand(cmd, cmdArgs, {cwd: ROOT, env, signal: cancelled.signal});}
  finally {rmSync(scratch, {recursive: true, force: true});}
}

/** The last "N/M … passed" line a test prints, if it prints one. */
const tally = (out) => out.match(/^\s*(\d+\/\d+ .*passed.*)$/m)?.[1]?.trim() ?? "";

const failed = [];
let total = 0;
const t0 = Date.now();

if (mode === "offline" && !filters.length) {
  total++;
  process.stdout.write("typecheck".padEnd(20));
  const r = await run("npx", ["tsc", "--noEmit"]);
  console.log(r.code === 0 ? `ok      ${(r.ms / 1000).toFixed(1)}s` : "FAILED");
  if (r.code !== 0) failed.push({ name: "typecheck", out: r.out });
}

for (const name of tests) {
  if (cancelled.signal.aborted) break;
  total++;
  process.stdout.write(name.padEnd(24));
  const r = await run("npm", ["run", "-s", name]);
  console.log(`${r.code === 0 ? "ok    " : "FAILED"}  ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${tally(r.out)}${live ? `   (${LIVE_TESTS[name]})` : ""}`);
  if (r.code !== 0) failed.push({ name, out: r.out });
}

for (const f of failed) {
  console.log(`\n── ${f.name} ─────────────────────────────────────────\n${f.out.trim().split("\n").slice(-40).join("\n")}`);
}
console.log(`\n${total - failed.length}/${total} passed in ${Math.round((Date.now() - t0) / 1000)}s${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(", ")}` : ""}`);
if (mode === "offline" && !filters.length) console.log(`Not run (need keys, network or permissions): ${Object.keys({...LIVE_TESTS, ...DEVICE_TESTS}).join(", ")} — npm run test:live / npm run test:device`);
process.exit(failed.length || cancelled.signal.aborted ? 1 : 0);
