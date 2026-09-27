#!/usr/bin/env node
/**
 * One command for every test.
 *
 *   npm test              typecheck, then every offline test (about 2 minutes)
 *   npm run test:live     only the tests that need real API keys, network or permissions
 *   npm test -- wake pip  only tests whose name contains one of these words
 *
 * Tests are discovered from package.json: any script ending in "test", plus
 * "check". A new test is picked up without editing this file. They run one at a
 * time on purpose — several start the shared whisper server, which reaps any
 * other whisper-server it finds.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Spend real API quota, reach the network, or need a permission prompt answered. */
const LIVE = {
  e2e: "sends a real request through the configured brain",
  safetytest: "asks the real brain to delete a canary file",
  livetest: "opens a real Gemini Live session",
  sttstreamtest: "streams audio to Sarvam's cloud speech-to-text",
  applestttest: "needs macOS Speech Recognition permission granted",
};

if (process.env.ECHO_TEST_RUNNER) {
  console.error("test-all: already running inside the test runner — refusing to start again.");
  process.exit(1);
}

const args = process.argv.slice(2);
const live = args.includes("--live");
const filters = args.filter((a) => !a.startsWith("--"));

const scripts = Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts);
const tests = scripts
  // "test" itself is this runner — including it would launch itself forever.
  .filter((s) => s !== "test" && !s.startsWith("test:"))
  .filter((s) => s.endsWith("test") || s === "check" || s === "e2e")
  .filter((s) => (live ? s in LIVE : !(s in LIVE)))
  .filter((s) => !filters.length || filters.some((f) => s.includes(f)));

function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ECHO_TEST_RUNNER: "1" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out, ms: Date.now() - t0 }));
    child.on("error", (err) => resolve({ code: 1, out: String(err), ms: Date.now() - t0 }));
  });
}

/** The last "N/M … passed" line a test prints, if it prints one. */
const tally = (out) => out.match(/^\s*(\d+\/\d+ .*passed.*)$/m)?.[1]?.trim() ?? "";

const failed = [];
const t0 = Date.now();

if (!live && !filters.length) {
  process.stdout.write("typecheck".padEnd(20));
  const r = await run("npx", ["tsc", "--noEmit"]);
  console.log(r.code === 0 ? `ok      ${(r.ms / 1000).toFixed(1)}s` : "FAILED");
  if (r.code !== 0) failed.push({ name: "typecheck", out: r.out });
}

for (const name of tests) {
  process.stdout.write(name.padEnd(20));
  const r = await run("npm", ["run", "-s", name]);
  console.log(`${r.code === 0 ? "ok    " : "FAILED"}  ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${tally(r.out)}${live ? `   (${LIVE[name]})` : ""}`);
  if (r.code !== 0) failed.push({ name, out: r.out });
}

for (const f of failed) {
  console.log(`\n── ${f.name} ─────────────────────────────────────────\n${f.out.trim().split("\n").slice(-40).join("\n")}`);
}
const total = tests.length + (!live && !filters.length ? 1 : 0);
console.log(`\n${total - failed.length}/${total} passed in ${Math.round((Date.now() - t0) / 1000)}s${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(", ")}` : ""}`);
if (!live && !filters.length) console.log(`Not run (need keys, network or permissions): ${Object.keys(LIVE).join(", ")} — npm run test:live`);
process.exit(failed.length ? 1 : 0);
