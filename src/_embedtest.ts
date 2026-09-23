/**
 * The shared local embedder: real inference, checked against known
 * similar/dissimilar sentence pairs, not just "it returns a vector".
 *
 *   npm run embedtest
 */
import { fileURLToPath } from "node:url";
import { embedder } from "./cognition/embeddings.js";
import { cosine } from "./cognition/episodic.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nLocal embedder (all-MiniLM-L6-v2)\n");
const e = embedder(ROOT);
ok(e.available(), "model files are present");

const sim = async (a: string, b: string) => {
  const va = await e.embed(a);
  const vb = await e.embed(b);
  if (!va || !vb) return -1;
  return cosine(Array.from(va), Array.from(vb));
};

const pairs: Array<[string, string, string]> = [
  ["open safari", "open Safari please", "near-identical phrasing"],
  ["open safari", "launch the browser", "paraphrase, same intent"],
  ["what's on my screen", "tell me what you see on the display", "paraphrase, same intent"],
  ["turn off the lights", "dim the lights", "related but not identical"],
];
const unrelated: Array<[string, string]> = [
  ["open safari", "what time is the meeting tomorrow"],
  ["turn off the lights", "list the interactive controls on screen"],
  ["send the email to priya", "roll back to the last git commit"],
];

const results: number[] = [];
for (const [a, b, label] of pairs) {
  const s = await sim(a, b);
  results.push(s);
  ok(s > 0.55, `"${a}" ~ "${b}" (${label}): cosine ${s.toFixed(3)} > 0.55`);
}
const unrelatedScores: number[] = [];
for (const [a, b] of unrelated) {
  const s = await sim(a, b);
  unrelatedScores.push(s);
  ok(s < 0.5, `"${a}" vs "${b}" (unrelated): cosine ${s.toFixed(3)} < 0.5`);
}
ok(Math.min(...results) > Math.max(...unrelatedScores), "every related pair scores above every unrelated pair");

// Identity and determinism.
const v1 = await e.embed("open safari");
const v2 = await e.embed("open safari");
ok(!!v1 && !!v2 && cosine(Array.from(v1!), Array.from(v2!)) > 0.9999, "embedding the same text twice gives the same vector");
ok(v1!.length === 384, `384-dim vector (got ${v1!.length})`);

console.log(`\n${pass}/${pass + fail} embedder cases passed\n`);
process.exit(fail ? 1 : 0);
