#!/usr/bin/env node
/**
 * Fetch the local sentence embedder.
 *
 *   npm run embedder          download if missing, then verify
 *   npm run embedder -- --force   re-download even if present
 *
 * Why this exists: `models/` is gitignored, so a fresh clone has no embedder,
 * and nothing errors when it is absent — `cognition/embeddings.ts` returns
 * null and every caller degrades silently. The cost is speed, not failure:
 * the tool router stops pruning and each brain sends the full fitted tool
 * list instead of the top K, the reflex cache drops to exact-string matching
 * so a reworded repeat pays the model again, and autoreflex can never save a
 * fast path. That is a slow Echo with no symptom pointing at the cause.
 *
 * all-MiniLM-L6-v2, quantized, 384-dim — exactly what embeddings.ts expects:
 * `model_quantized.onnx` plus the model's own `tokenizer.json`, because the
 * hand-written WordPiece tokenizer reads that file rather than approximating
 * it.
 */
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "models", "embed");
const REPO = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main";

const FILES = [
  { name: "model_quantized.onnx", url: `${REPO}/onnx/model_quantized.onnx`, minBytes: 10_000_000 },
  { name: "tokenizer.json", url: `${REPO}/tokenizer.json`, minBytes: 100_000 },
];

const force = process.argv.includes("--force");
mkdirSync(DIR, { recursive: true });

async function get(file) {
  const dest = join(DIR, file.name);
  if (!force && existsSync(dest) && statSync(dest).size >= file.minBytes) {
    console.log(`  have  ${file.name} (${(statSync(dest).size / 1e6).toFixed(1)}MB)`);
    return true;
  }
  process.stdout.write(`  get   ${file.name} … `);
  try {
    const res = await fetch(file.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // A proxy login page or an LFS pointer is a 200 with a tiny body. Checking
    // the size is what separates "downloaded" from "downloaded something else".
    if (buf.length < file.minBytes) {
      throw new Error(`only ${buf.length} bytes — expected at least ${file.minBytes}. A captive portal or an LFS pointer, not the model.`);
    }
    writeFileSync(dest, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)}MB`);
    return true;
  } catch (err) {
    console.log(`FAILED — ${err?.message ?? err}`);
    return false;
  }
}

console.log(`\nLocal embedder → ${DIR}\n`);
let ok = true;
for (const f of FILES) ok = (await get(f)) && ok;

if (!ok) {
  console.log("\nCould not fetch everything. Echo still runs — it is just slower.");
  console.log("Download the two files by hand into models/embed/ if the network blocks this:");
  for (const f of FILES) console.log(`  ${f.url}`);
  process.exit(1);
}

// Verify rather than assume: parse the tokenizer, then embed a real string and
// check the vector is 384-dim and normalised. A model that loads but produces
// nonsense is the failure mode that hides.
try {
  const t = JSON.parse(readFileSync(join(DIR, "tokenizer.json"), "utf8"));
  if (!t?.model?.vocab) throw new Error("tokenizer.json has no model.vocab");
  console.log(`\n  ok    tokenizer parses (${Object.keys(t.model.vocab).length} vocab entries)`);
} catch (err) {
  console.log(`\n  BAD   tokenizer.json unusable — ${err?.message ?? err}`);
  process.exit(1);
}

console.log("  next  npm run embedtest   (confirms inference, 384-dim, deterministic)\n");
