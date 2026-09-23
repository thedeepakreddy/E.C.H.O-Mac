import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disableOrtTelemetry } from "../utils/ortEnv.js";

/**
 * One local sentence embedder, shared by everything that needs "how similar
 * are these two pieces of text" — the reflex cache's semantic match, episodic
 * memory's `retrieve()` (which has always accepted an `embedding` option;
 * nothing in production ever supplied one), the tool-pruning router, and
 * speculative execution's next-tool guess. One model, one place it is loaded,
 * so nothing downloads or holds a second copy of it.
 *
 * all-MiniLM-L6-v2, quantized, via onnxruntime-node — already a dependency
 * for the wake-word and VAD work. 384-dim, mean-pooled, L2-normalised: the
 * standard sentence-transformers recipe for this model. A hand-written
 * WordPiece tokenizer reads the model's own `tokenizer.json` rather than
 * approximating it, because a wrong tokenizer produces confident, silently
 * wrong embeddings — the failure mode is not an error, it is bad rankings
 * nobody notices until a reflex fires on the wrong command.
 *
 * Never required. Every caller here degrades to its non-semantic fallback
 * (exact match, lexical overlap, the full tool list) when the model or
 * `onnxruntime-node` is unavailable — this must never be why a turn fails.
 */

const MAX_TOKENS = 64;
const DIM = 384;

interface WordPiece {
  vocab: Map<string, number>;
  unkId: number;
  clsId: number;
  sepId: number;
  padId: number;
  continuingPrefix: string;
}

function loadTokenizer(dir: string): WordPiece | null {
  const path = join(dir, "tokenizer.json");
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const vocabObj: Record<string, number> = j.model?.vocab ?? {};
    const vocab = new Map(Object.entries(vocabObj));
    const unk = j.model?.unk_token ?? "[UNK]";
    return {
      vocab,
      unkId: vocab.get(unk) ?? 100,
      clsId: vocab.get("[CLS]") ?? 101,
      sepId: vocab.get("[SEP]") ?? 102,
      padId: vocab.get("[PAD]") ?? 0,
      continuingPrefix: j.model?.continuing_subword_prefix ?? "##",
    };
  } catch (err) {
    console.error("[embed] tokenizer.json unreadable:", (err as any)?.message ?? err);
    return null;
  }
}

/** Strip combining diacritics after NFD decomposition — BertNormalizer's strip_accents. */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** BertPreTokenizer: split on whitespace, and split punctuation off into its own tokens. */
function isPunct(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}
/** Give CJK ideographs their own token, per handle_chinese_chars. */
function isCjk(c: number): boolean {
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
}

function basicTokenize(text: string): string[] {
  let cleaned = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 0 || c === 0xfffd || (c < 32 && ch !== "\t" && ch !== "\n")) continue; // control chars
    cleaned += /\s/.test(ch) ? " " : isCjk(c) ? ` ${ch} ` : ch;
  }
  const words: string[] = [];
  for (const word of cleaned.trim().split(/\s+/).filter(Boolean)) {
    let cur = "";
    for (const ch of word) {
      if (isPunct(ch)) {
        if (cur) words.push(cur);
        words.push(ch);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur) words.push(cur);
  }
  return words;
}

/** Greedy longest-match-first WordPiece for one already-lowercased, accent-stripped word. */
function wordPiece(word: string, wp: WordPiece): number[] {
  if (word.length > 100) return [wp.unkId];
  const out: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let matched: number | null = null;
    while (end > start) {
      const piece = (start > 0 ? wp.continuingPrefix : "") + word.slice(start, end);
      const id = wp.vocab.get(piece);
      if (id !== undefined) {
        matched = id;
        break;
      }
      end--;
    }
    if (matched === null) return [wp.unkId];
    out.push(matched);
    start = end;
  }
  return out;
}

function encode(text: string, wp: WordPiece): { ids: number[]; mask: number[]; types: number[] } {
  const normalized = stripAccents(text.toLowerCase());
  const ids: number[] = [wp.clsId];
  for (const word of basicTokenize(normalized)) {
    for (const id of wordPiece(word, wp)) {
      if (ids.length >= MAX_TOKENS - 1) break;
      ids.push(id);
    }
    if (ids.length >= MAX_TOKENS - 1) break;
  }
  ids.push(wp.sepId);
  const mask = ids.map(() => 1);
  while (ids.length < MAX_TOKENS) {
    ids.push(wp.padId);
    mask.push(0);
  }
  return { ids, mask, types: ids.map(() => 0) };
}

class Embedder {
  private ready: Promise<{ session: any; wp: WordPiece; ort: any } | null> | null = null;

  private async load(): Promise<{ session: any; wp: WordPiece; ort: any } | null> {
    const dir = this.modelDir;
    const modelPath = join(dir, "model_quantized.onnx");
    if (!existsSync(modelPath)) return null;
    const wp = loadTokenizer(dir);
    if (!wp) return null;
    let ort: any;
    try {
      disableOrtTelemetry(); // must precede the native load — see utils/ortEnv.ts
      ort = await import("onnxruntime-node");
    } catch {
      return null;
    }
    try {
      const session = await ort.InferenceSession.create(modelPath, {
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        logSeverityLevel: 3,
      });
      return { session, wp, ort };
    } catch (err) {
      console.error("[embed] model failed to load:", (err as any)?.message ?? err);
      return null;
    }
  }

  constructor(private modelDir: string) {}

  private cache = new Map<string, Float32Array>();

  /** Embed one string. Null when the model is unavailable — callers must fall back. */
  async embed(text: string): Promise<Float32Array | null> {
    const clean = (text ?? "").trim();
    if (!clean) return null;
    const cached = this.cache.get(clean);
    if (cached) return cached;
    if (!this.ready) this.ready = this.load();
    const loaded = await this.ready;
    if (!loaded) return null;
    const { session, wp, ort } = loaded;
    const { ids, mask, types } = encode(clean, wp);
    try {
      const out = await session.run({
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, MAX_TOKENS]),
        attention_mask: new ort.Tensor("int64", BigInt64Array.from(mask.map(BigInt)), [1, MAX_TOKENS]),
        token_type_ids: new ort.Tensor("int64", BigInt64Array.from(types.map(BigInt)), [1, MAX_TOKENS]),
      });
      const hidden: Float32Array = out.last_hidden_state.data;
      // Mean pool over real (non-padding) tokens, then L2-normalise — the
      // recipe all-MiniLM-L6-v2 was trained and evaluated with.
      const vec = new Float32Array(DIM);
      let real = 0;
      for (let t = 0; t < MAX_TOKENS; t++) {
        if (!mask[t]) continue;
        real++;
        const base = t * DIM;
        for (let d = 0; d < DIM; d++) vec[d] += hidden[base + d];
      }
      if (real === 0) return null;
      let norm = 0;
      for (let d = 0; d < DIM; d++) {
        vec[d] /= real;
        norm += vec[d] * vec[d];
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < DIM; d++) vec[d] /= norm;
      if (this.cache.size > 500) this.cache.clear(); // small strings only (tool names, short commands)
      this.cache.set(clean, vec);
      return vec;
    } catch (err) {
      console.error("[embed] inference failed:", (err as any)?.message ?? err);
      return null;
    }
  }

  /** Whether the model is present on disk, without loading it. */
  available(): boolean {
    return existsSync(join(this.modelDir, "model_quantized.onnx")) && existsSync(join(this.modelDir, "tokenizer.json"));
  }
}

let instance: Embedder | null = null;

/** The shared embedder, created once against the given app root. */
export function embedder(appRoot: string): Embedder {
  if (!instance) instance = new Embedder(join(appRoot, "models", "embed"));
  return instance;
}

/** For tests: replace the singleton (e.g. with one pointed at a fixture, or force it unavailable). */
export function _setEmbedderForTests(e: Embedder | null): void {
  instance = e;
}

export { Embedder, encode as _encodeForTests, DIM as EMBED_DIM };
