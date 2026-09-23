#!/usr/bin/env node
/**
 * Install the self-hosted services Echo reads from (src/tools/selfhosted.ts).
 *
 *   npm run selfhosted:setup [searxng|glances]   install one, or both
 *   npm run selfhosted:status                   which ones are answering
 *
 * Nothing needs starting by hand: the first web_search or system_sitrep that
 * finds its service down starts it in the background, bound to 127.0.0.1.
 * Every command is printed before it runs.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEARX_DIR = join(ROOT, "vendor", "searxng");
const SEARX_SETTINGS = join(homedir(), ".jarvis", "searxng", "settings.yml");
const UV = existsSync(join(homedir(), ".local", "bin", "uv")) ? join(homedir(), ".local", "bin", "uv") : "uv";

const SERVICES = {
  searxng: { url: process.env.SEARXNG_URL || "http://127.0.0.1:8888", health: "/healthz" },
  glances: { url: process.env.GLANCES_URL || "http://127.0.0.1:61208", health: "/api/4/status" },
};

function run(cmd, args, cwd = ROOT, env = process.env) {
  console.log(`\n$ ${cmd} ${args.join(" ")}${cwd === ROOT ? "" : `   (in ${cwd})`}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function setupGlances() {
  await run(UV, ["tool", "install", "--upgrade", "glances[web]"]);
  console.log("\nGlances installed. Echo starts it on 127.0.0.1:61208 the first time you ask for a sitrep.");
}

async function setupSearxng() {
  if (existsSync(SEARX_DIR)) await run("git", ["pull", "--ff-only"], SEARX_DIR);
  else await run("git", ["clone", "--depth", "1", "https://github.com/searxng/searxng.git", SEARX_DIR]);
  const venv = { ...process.env, VIRTUAL_ENV: join(SEARX_DIR, ".venv") };
  if (!existsSync(join(SEARX_DIR, ".venv"))) await run(UV, ["venv", ".venv", "--python", "3.12"], SEARX_DIR);
  await run(UV, ["pip", "install", "-r", "requirements.txt", "-r", "requirements-server.txt", "setuptools", "wheel"], SEARX_DIR, venv);
  await run(UV, ["pip", "install", "--no-build-isolation", "-e", "."], SEARX_DIR, venv);

  if (!existsSync(SEARX_SETTINGS)) {
    mkdirSync(dirname(SEARX_SETTINGS), { recursive: true });
    // JSON output is off in SearXNG's defaults; Echo reads nothing else. The
    // limiter needs a Valkey server and only matters for a public instance.
    writeFileSync(SEARX_SETTINGS, [
      "use_default_settings: true",
      "general:",
      '  instance_name: "Echo private search"',
      "server:",
      '  bind_address: "127.0.0.1"',
      "  port: 8888",
      `  secret_key: "${randomBytes(32).toString("hex")}"`,
      "  limiter: false",
      "  image_proxy: false",
      "search:",
      "  safe_search: 0",
      "  formats:",
      "    - html",
      "    - json",
      "",
    ].join("\n"));
    chmodSync(SEARX_SETTINGS, 0o600);
    console.log(`\nWrote ${SEARX_SETTINGS}`);
  } else {
    console.log(`\nKeeping your existing ${SEARX_SETTINGS}`);
  }
  console.log("SearXNG installed. Echo starts it on 127.0.0.1:8888 the first time it searches the web.");
}

async function status() {
  for (const [name, { url, health }] of Object.entries(SERVICES)) {
    const up = await fetch(url + health, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    console.log(`${up ? "✓" : "·"} ${name.padEnd(10)} ${url}${up ? "" : "   (not answering)"}`);
  }
}

const [command, which] = process.argv.slice(2);
try {
  if (command === "setup") {
    if (!which || which === "searxng") await setupSearxng();
    if (!which || which === "glances") await setupGlances();
    if (which && !["searxng", "glances"].includes(which)) throw new Error(`Unknown service "${which}".`);
  } else if (command === "status") {
    await status();
  } else {
    console.log("Usage: node scripts/selfhosted.mjs setup [searxng|glances] | status");
    process.exit(1);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
