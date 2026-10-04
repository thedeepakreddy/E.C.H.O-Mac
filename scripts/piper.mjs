#!/usr/bin/env node
/**
 * Install Piper, Echo's offline neural voice (src/voice/tts-stream.ts).
 *
 *   npm run piper:setup [voice ...]   install Piper and voices (default: en_GB-alan-medium)
 *   npm run piper:voices              list the installed voices
 *
 * Voices are listed at https://huggingface.co/rhasspy/piper-voices — a name
 * looks like en_GB-alan-medium. Each "medium" voice is about 63 MB.
 * Pick one with "piperVoice" in ~/.jarvis/config.json, and set
 * "ttsEngine": "piper" to make it Echo's main voice. Once installed, Echo also
 * uses it whenever a cloud voice fails.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "vendor", "piper");
const VOICES = join(DIR, "voices");
const PY = join(DIR, ".venv", "bin", "python");
const UV = existsSync(join(homedir(), ".local", "bin", "uv")) ? join(homedir(), ".local", "bin", "uv") : "uv";

// Piper's Python runs on onnxruntime, whose telemetry thread can abort() it.
function run(cmd, args, env = { ...process.env, ORT_DISABLE_TELEMETRY: process.env.ORT_DISABLE_TELEMETRY ?? "1" }) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: DIR, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function setup(voices) {
  mkdirSync(VOICES, { recursive: true });
  if (!existsSync(PY)) await run(UV, ["venv", ".venv", "--python", "3.12"]);
  await run(UV, ["pip", "install", "--upgrade", "piper-tts"], { ...process.env, VIRTUAL_ENV: join(DIR, ".venv") });
  await run(PY, ["-m", "piper.download_voices", "--download-dir", VOICES, ...voices]);
  console.log("\nPiper is ready. Installed voices:");
  list();
}

function list() {
  const names = existsSync(VOICES) ? readdirSync(VOICES).filter((f) => f.endsWith(".onnx")).map((f) => f.slice(0, -5)) : [];
  console.log(names.length ? names.map((n) => `  ${n}`).join("\n") : "  (none — run npm run piper:setup)");
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "setup") await setup(rest.length ? rest : ["en_GB-alan-medium"]);
  else if (command === "voices") list();
  else {
    console.log("Usage: node scripts/piper.mjs setup [voice ...] | voices");
    process.exit(1);
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
