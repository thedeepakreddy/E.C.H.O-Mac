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
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {checkModelStorage,entry,noDirectoryLinks,MiB} from './storage-budget.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "vendor", "piper");
const VOICES = join(DIR, "voices");
const UV = existsSync(join(homedir(), ".local", "bin", "uv")) ? join(homedir(), ".local", "bin", "uv") : "uv";

// Piper's Python runs on onnxruntime, whose telemetry thread can abort() it.
function run(cmd, args, env = { ...process.env, ORT_DISABLE_TELEMETRY: process.env.ORT_DISABLE_TELEMETRY ?? "1" }, cwd = DIR) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

export function piperPreflight(voices,{root=ROOT,statfs,installationBytes=2*1024*MiB}={}) {
  if(!Array.isArray(voices)||!voices.length||voices.length>4||new Set(voices).size>4)throw Error('Piper voice count is limited to four');
  if(voices.some(v=>typeof v!=='string'||v.length>128||! /^[a-z]{2,3}_[A-Z]{2}-[a-zA-Z0-9_]+-(?:x_low|low|medium|high)$/.test(v)))throw Error('Invalid Piper voice identifier (flags and paths are forbidden)');
  const dir=join(root,'vendor/piper'),voiceDir=join(dir,'voices');
  for(const path of [dir,voiceDir,join(dir,'.venv/bin')])noDirectoryLinks(path,root);
  checkModelStorage(dir,{incomingBytes:0,installationBytes,statfs});
  const installed=entry(voiceDir)?readdirSync(voiceDir).filter(f=>f.endsWith('.onnx')).map(f=>f.slice(0,-5)):[];
  if(new Set([...installed,...voices]).size>4)throw Error('Piper installed/requested voice count exceeds four; manually archive chosen voices first');
  const downloadVoices=[...new Set(voices)].filter(v=>{
    const model=entry(join(voiceDir,v+'.onnx')),config=entry(join(voiceDir,v+'.onnx.json'));
    if(model||config){
      if(!model?.isFile()||!config?.isFile()||!model.size||!config.size||config.size>MiB)throw Error('Existing Piper voice is incomplete or linked; manually archive it before retrying');
      try{const parsed=JSON.parse(readFileSync(join(voiceDir,v+'.onnx.json'),'utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();}catch{throw Error('Existing Piper voice configuration is invalid; manually archive it before retrying');}
      return false;
    }return true;
  });
  const report=checkModelStorage(dir,{incomingBytes:1024*MiB+downloadVoices.length*256*MiB,installationBytes,statfs});
  return {...report,downloadVoices};
}

export async function setup(voices,options={}) {
  // All validation and disk checks precede mkdir, process launch and downloads.
  const report=piperPreflight(voices,options),dir=join(options.root??ROOT,'vendor/piper'),voiceDir=join(dir,'voices'),py=join(dir,'.venv/bin/python');
  const launch=options.run??((cmd,args,env)=>run(cmd,args,env,dir));
  console.warn('[storage] Piper preflight estimates 1 GiB runtime/staging + 256 MiB/new voice. Upstream sizes are uncertain: no continuous download quota. Cached files receive presence/size/JSON checks, not model integrity verification. Existing voices are preserved.');
  mkdirSync(voiceDir, { recursive: true });
  if (!existsSync(py)) await launch(UV, ["venv", ".venv", "--python", "3.12"]);
  await launch(UV, ["pip", "install", "piper-tts"], { ...process.env, VIRTUAL_ENV: join(dir, ".venv") });
  if(report.downloadVoices.length)await launch(py, ["-m", "piper.download_voices", "--download-dir", voiceDir, ...report.downloadVoices]);
  console.log("\nPiper is ready. Installed voices:");
  list(voiceDir);
  return report;
}

function list(voiceDir = VOICES) {
  const names = existsSync(voiceDir) ? readdirSync(voiceDir).filter((f) => f.endsWith(".onnx")).map((f) => f.slice(0, -5)) : [];
  console.log(names.length ? names.map((n) => `  ${n}`).join("\n") : "  (none — run npm run piper:setup)");
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
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
}
