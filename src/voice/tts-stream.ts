import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { JarvisConfig } from "../config.js";
import { withProsody } from "./prosody.js";
import { getAppPath } from "../utils/appPath.js";
import { jsonSse } from "../utils/json-sse.js";
import { VibeVoiceTtsStream, vibeVoiceSupportsText } from "./vibevoice.js";

/**
 * Streaming text-to-speech: sentences in, PCM out, as soon as each is ready.
 *
 * The file path (tts.ts) asked for the whole reply, waited for the whole audio
 * body (Sarvam: 1.5 s to the first byte, 1.9 s to the last), wrote a file and
 * spawned a player. These adapters keep one connection open per turn, send
 * each sentence the moment the chunker releases it, and hand back audio in
 * pieces to the persistent player — so the first sentence is playing while
 * the second is still being written by the model.
 *
 * Every adapter emits raw 16-bit PCM at `sampleRate`; the player does the rest.
 */

export interface TtsAudio {
  pcm: Buffer;
  sampleRate: number;
  /** Index of the sentence this audio belongs to, in the order spoken. */
  sentence: number;
}

export interface TtsStream extends EventEmitter {
  readonly name: string;
  readonly sampleRate: number;
  open(): Promise<void>;
  /** Speak one sentence; audio arrives via 'audio' events tagged with its index. */
  speak(text: string, sentence: number): void;
  /** No more sentences this turn; resolves once all audio has been emitted. */
  close(): Promise<void>;
  abort(): void;
}

/** Which Sarvam/ElevenLabs language the text is in, from its script. */
export function languageOf(text: string): "te-IN" | "hi-IN" | "en-IN" {
  if (/[ఀ-౿]/.test(text)) return "te-IN";
  if (/[ऀ-ॿ]/.test(text)) return "hi-IN";
  return "en-IN";
}

/** Mostly Latin letters? Piper's voices are English, so anything else needs another voice. */
export function isLatinText(text: string): boolean {
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (/[A-Za-z\u00C0-\u024F]/.test(ch)) latin++;
    else if (/\p{L}/u.test(ch)) other++;
  }
  return other <= latin;
}

/** Raw linear16 may or may not come wrapped in a WAV header; take the samples either way. */
function stripWav(buf: Buffer): Buffer {
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF") {
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "data") return buf.subarray(off + 8, off + 8 + size);
      off += 8 + size + (size % 2);
    }
  }
  return buf;
}

// ---- Sarvam bulbul:v3 over WebSocket --------------------------------------------

export class SarvamTtsStream extends EventEmitter implements TtsStream {
  readonly name = "sarvam-ws";
  readonly sampleRate = 24000;
  private ws: any = null;
  private open_ = false;
  private lang: string;
  private queue: Array<{ text: string; sentence: number }> = [];
  private current: number | null = null;
  private inflight = 0;
  private closing: (() => void) | null = null;
  private aborted = false;
  private openedAt = 0;

  constructor(private readonly cfg: JarvisConfig, private readonly apiKey: string, firstText = "") {
    super();
    this.lang = languageOf(firstText);
  }

  async open(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const url = "wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true";
    this.openedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sarvam tts: connect timed out")), 3000);
      this.ws = new WebSocket(url, { headers: { "Api-Subscription-Key": this.apiKey } });
      this.ws.on("open", () => {
        clearTimeout(timer);
        this.open_ = true;
        this.send({
          type: "config",
          data: {
            target_language_code: this.lang,
            speaker: this.cfg.voice.sarvamSpeaker || "aditya",
            pace: this.cfg.voice.sarvamPace ?? 1,
            output_audio_codec: "linear16",
            speech_sample_rate: String(this.sampleRate),
            model: "bulbul:v3",
          },
        });
        resolve();
        this.pump();
      });
      this.ws.on("message", (d: Buffer) => this.onMessage(d));
      this.ws.on("error", (err: any) => {
        clearTimeout(timer);
        this.emit("error", String(err?.message ?? err));
        if (!this.open_) reject(err);
        this.finish();
      });
      this.ws.on("close", () => {
        this.open_ = false;
        this.finish();
      });
    });
  }

  private send(obj: unknown): void {
    if (!this.open_ || !this.ws) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err: any) {
      this.emit("error", String(err?.message ?? err));
    }
  }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    this.queue.push({ text, sentence });
    this.pump();
  }

  /** One sentence at a time, so each audio message maps to a known sentence. */
  private pump(): void {
    if (!this.open_ || this.current !== null || !this.queue.length) return;
    const next = this.queue.shift()!;
    this.current = next.sentence;
    this.inflight++;
    this.send({ type: "text", data: { text: next.text } });
    this.send({ type: "flush" });
  }

  private onMessage(data: Buffer): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    const type = String(msg.type ?? "");
    if (type === "audio") {
      const b64 = msg.data?.audio ?? msg.audio;
      if (typeof b64 === "string" && b64.length) {
        this.emit("audio", { pcm: stripWav(Buffer.from(b64, "base64")), sampleRate: this.sampleRate, sentence: this.current ?? 0 } satisfies TtsAudio);
      }
    } else if (type === "event") {
      const ev = String(msg.data?.event_type ?? msg.event_type ?? "");
      if (ev === "final") {
        this.inflight = Math.max(0, this.inflight - 1);
        this.emit("sentenceDone", this.current);
        this.current = null;
        if (this.queue.length) this.pump();
        else if (this.closing) this.finish();
      }
    } else if (type === "error") {
      this.emit("error", String(msg.data?.message ?? msg.message ?? "tts error"));
      this.inflight = Math.max(0, this.inflight - 1);
      this.current = null;
      if (this.queue.length) this.pump();
      else if (this.closing) this.finish();
    }
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.open_ || (this.current === null && !this.queue.length)) {
        this.finish();
        resolve();
        return;
      }
      this.closing = resolve;
      // A stream that never sends its final must not hold the turn open.
      setTimeout(() => this.finish(), 15000);
    });
  }

  private finish(): void {
    const c = this.closing;
    this.closing = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.open_ = false;
    if (c) c();
    this.emit("closed");
  }

  abort(): void {
    this.aborted = true;
    this.queue = [];
    this.finish();
  }

  get elapsed(): number {
    return Math.round(performance.now() - this.openedAt);
  }
}

// ---- ElevenLabs stream-input over WebSocket -------------------------------------

export class ElevenLabsTtsStream extends EventEmitter implements TtsStream {
  readonly name = "elevenlabs-ws";
  readonly sampleRate = 24000;
  private ws: any = null;
  private open_ = false;
  private sentence = 0;
  private closing: (() => void) | null = null;
  private aborted = false;

  constructor(private readonly voiceId: string, private readonly apiKey: string, private readonly model = "eleven_flash_v2_5") {
    super();
  }

  async open(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?model_id=${this.model}&output_format=pcm_24000`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("elevenlabs tts: connect timed out")), 3000);
      this.ws = new WebSocket(url, { headers: { "xi-api-key": this.apiKey } });
      this.ws.on("open", () => {
        clearTimeout(timer);
        this.open_ = true;
        // Shorter chunk schedule: latency over perfect prosody, this is a conversation.
        this.send({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 }, generation_config: { chunk_length_schedule: [50, 90, 120, 150] } });
        resolve();
      });
      this.ws.on("message", (d: Buffer) => this.onMessage(d));
      this.ws.on("error", (err: any) => {
        clearTimeout(timer);
        this.emit("error", String(err?.message ?? err));
        if (!this.open_) reject(err);
        this.finish();
      });
      this.ws.on("close", () => {
        this.open_ = false;
        this.finish();
      });
    });
  }

  private send(obj: unknown): void {
    if (!this.open_ || !this.ws) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err: any) {
      this.emit("error", String(err?.message ?? err));
    }
  }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    this.sentence = sentence;
    this.send({ text: text.endsWith(" ") ? text : text + " ", flush: true });
  }

  private onMessage(data: Buffer): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg.audio === "string" && msg.audio.length) {
      this.emit("audio", { pcm: Buffer.from(msg.audio, "base64"), sampleRate: this.sampleRate, sentence: this.sentence } satisfies TtsAudio);
    }
    if (msg.isFinal) this.finish();
    if (msg.error) this.emit("error", String(msg.message ?? msg.error));
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.open_) return resolve();
      this.closing = resolve;
      this.send({ text: "" }); // end of input → the server sends isFinal
      setTimeout(() => this.finish(), 15000);
    });
  }

  private finish(): void {
    const c = this.closing;
    this.closing = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.open_ = false;
    if (c) c();
    this.emit("closed");
  }

  abort(): void {
    this.aborted = true;
    this.finish();
  }
}

// ---- Piper, a local neural voice ------------------------------------------------

export const DEFAULT_PIPER_VOICE = "en_GB-alan-medium";

export interface PiperPaths {
  python: string;
  worker: string;
  model: string;
  sampleRate: number;
}

/** Where the Piper install and the chosen voice live, or null if either is missing. */
export function piperPaths(voice = DEFAULT_PIPER_VOICE, root = getAppPath()): PiperPaths | null {
  const name = voice.replace(/[^a-zA-Z0-9_.-]/g, "");
  const python = join(root, "vendor", "piper", ".venv", "bin", "python");
  const worker = join(root, "scripts", "piper_worker.py");
  const model = join(root, "vendor", "piper", "voices", `${name}.onnx`);
  if (!name || ![python, worker, model, `${model}.json`].every(existsSync)) return null;
  try {
    const rate = Number(JSON.parse(readFileSync(`${model}.json`, "utf8"))?.audio?.sample_rate);
    return { python, worker, model, sampleRate: rate > 0 ? rate : 22050 };
  } catch {
    return null;
  }
}

const PIPER_READY = 0xffffffff;

/**
 * One long-lived Piper process per voice, shared by every turn: loading a voice
 * takes ~0.75 s, a sentence after that ~50-150 ms to first audio. Sentences go
 * through it one at a time, so cancelling a turn wastes at most the sentence
 * already being synthesised.
 */
export class PiperWorker {
  private static workers = new Map<string, PiperWorker>();

  static stopAll(): void {
    const owned = [...PiperWorker.workers.values()];
    PiperWorker.workers.clear();
    for (const worker of owned) worker.stop();
  }

  static for(paths: PiperPaths): PiperWorker {
    let w = PiperWorker.workers.get(paths.model);
    if (!w || w.dead) {
      w = new PiperWorker(paths);
      PiperWorker.workers.set(paths.model, w);
    }
    return w;
  }

  readonly ready: Promise<void>;
  private child: ReturnType<typeof spawn>;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private queue: Array<{ id: number; text: string }> = [];
  private inflight: number | null = null;
  private handlers = new Map<number, { audio: (pcm: Buffer) => void; done: (err?: string) => void }>();
  private dead = false;

  private constructor(paths: PiperPaths) {
    // Piper runs on onnxruntime, whose Python build carries the same Microsoft
    // telemetry thread that SIGABRT-ed Electron (see utils/ortEnv.ts). Off
    // explicitly here: the Node-side switch is set lazily, so a worker started
    // before any model loaded inherited nothing — and crashed the same way.
    this.child = spawn(paths.python, [paths.worker, paths.model], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ORT_DISABLE_TELEMETRY: process.env.ORT_DISABLE_TELEMETRY ?? "1" },
    });
    let markReady!: () => void;
    let markFailed!: (err: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markFailed = reject;
    });
    const timer = setTimeout(() => markFailed(new Error("piper did not load its voice within 20s")), 20_000);
    this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    this.ready.catch(() => {});
    this.child.stdout!.on("data", (d: Buffer) => this.onData(d, markReady));
    this.child.stderr!.on("data", (d: Buffer) => console.log(`[piper] ${String(d).trim()}`));
    const die = (why: string) => {
      if (this.dead) return;
      this.dead = true;
      markFailed(new Error(why));
      for (const h of this.handlers.values()) h.done(why);
      this.handlers.clear();
      this.queue = [];
    };
    this.child.on("error", (err) => die(`piper failed to start: ${err.message}`));
    this.child.on("exit", (code) => die(`piper exited (${code})`));
  }

  /** Speak one text; audio arrives in pieces, then `done` once. Returns an id for cancel(). */
  request(text: string, audio: (pcm: Buffer) => void, done: (err?: string) => void): number {
    const id = this.nextId++;
    if (this.nextId >= PIPER_READY) this.nextId = 1;
    if (this.dead) {
      done("piper is not running");
      return id;
    }
    this.handlers.set(id, { audio, done });
    this.queue.push({ id, text });
    this.pump();
    return id;
  }

  /** Drop a request: unsent ones never go out, the one in flight is ignored as it finishes. */
  cancel(id: number): void {
    this.queue = this.queue.filter((q) => q.id !== id);
    this.handlers.delete(id);
  }

  private pump(): void {
    if (this.inflight !== null || !this.queue.length || this.dead) return;
    const next = this.queue.shift()!;
    this.inflight = next.id;
    this.child.stdin!.write(JSON.stringify({ id: next.id, text: next.text }) + "\n");
  }

  private onData(d: Buffer, markReady: () => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 8) {
      const id = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) break;
      const pcm = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      if (id === PIPER_READY) {
        markReady();
        continue;
      }
      const h = this.handlers.get(id);
      if (len > 0) {
        h?.audio(Buffer.from(pcm));
        continue;
      }
      this.handlers.delete(id);
      if (this.inflight === id) this.inflight = null;
      h?.done();
      this.pump();
    }
  }

  stop(): void {
    this.child.kill("SIGTERM");
  }
}

export class PiperTtsStream extends EventEmitter implements TtsStream {
  readonly name = "piper";
  readonly sampleRate: number;
  private worker: PiperWorker;
  private outstanding = new Map<number, number>();
  private closing: (() => void) | null = null;
  private aborted = false;

  constructor(paths: PiperPaths) {
    super();
    this.sampleRate = paths.sampleRate;
    this.worker = PiperWorker.for(paths);
  }

  open(): Promise<void> {
    return this.worker.ready;
  }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    const id = this.worker.request(
      text,
      (pcm) => {
        if (!this.aborted) this.emit("audio", { pcm, sampleRate: this.sampleRate, sentence } satisfies TtsAudio);
      },
      (err) => {
        this.outstanding.delete(sentence);
        if (this.aborted) return;
        if (err) this.emit("error", err);
        this.emit("sentenceDone", sentence);
        if (!this.outstanding.size && this.closing) {
          const c = this.closing;
          this.closing = null;
          c();
        }
      }
    );
    this.outstanding.set(sentence, id);
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.outstanding.size) return resolve();
      this.closing = resolve;
    });
  }

  abort(): void {
    this.aborted = true;
    for (const id of this.outstanding.values()) this.worker.cancel(id);
    this.outstanding.clear();
    const c = this.closing;
    this.closing = null;
    if (c) c();
  }
}

/**
 * The voice to use when the configured one cannot speak: Piper if it is
 * installed (a real voice, fully offline), otherwise macOS `say`.
 */
/**
 * Engines that have a real streaming implementation below.
 *
 * Kept next to the switch it mirrors, because it was a separate hardcoded
 * list in main.ts and it drifted: `gemini` and `piper` both have a stream
 * here, and neither was in it. With `ttsEngine: "gemini"` the streaming path
 * was therefore never built at all — the log said "streaming speech: off
 * (file path)" — and every reply fell back to the non-streaming `tts.ts`,
 * which has no gemini branch either and lands on Piper. Piper is English
 * only, so a Telugu reply came out in an English voice.
 */
export const STREAMING_ENGINES = new Set(["sarvam", "elevenlabs", "gemini", "mac", "piper", "vibevoice"]);

export function offlineTtsStream(cfg: JarvisConfig): TtsStream {
  const paths = piperPaths(cfg.voice.piperVoice);
  return paths ? new PiperTtsStream(paths) : new SayTtsStream(cfg.voice.ttsVoice);
}

/** Engines that run on this machine, so there is nothing further to fall back to. */
export const OFFLINE_STREAMS = new Set(["piper", "say"]);

// ---- macOS `say`, rendered to PCM ---------------------------------------------

/**
 * The offline fallback. `say` renders a sentence to a PCM file in roughly real
 * time, so the first sentence of a reply is playing about a second after the
 * model finishes it — no better than spawning `say` directly, but every
 * sentence then flows through the same player, with the same instant stop.
 */
export class SayTtsStream extends EventEmitter implements TtsStream {
  readonly name = "say";
  readonly sampleRate = 24000;
  private queue: Array<{ text: string; sentence: number }> = [];
  private running = false;
  private aborted = false;
  private closing: (() => void) | null = null;
  private child: ReturnType<typeof spawn> | null = null;

  constructor(private readonly voice: string) {
    super();
  }

  async open(): Promise<void> {
    /* nothing to open */
  }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    this.queue.push({ text, sentence });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.aborted) {
        const { text, sentence } = this.queue.shift()!;
        const out = join(tmpdir(), `echo-say-${process.pid}-${Date.now()}.wav`);
        await new Promise<void>((resolve) => {
          this.child = spawn("/usr/bin/say", ["-v", this.voice, "-o", out, `--data-format=LEI16@${this.sampleRate}`, withProsody(text)]);
          this.child.on("exit", () => resolve());
          this.child.on("error", () => resolve());
        });
        this.child = null;
        if (this.aborted) break;
        try {
          const pcm = stripWav(readFileSync(out));
          this.emit("audio", { pcm, sampleRate: this.sampleRate, sentence } satisfies TtsAudio);
          this.emit("sentenceDone", sentence);
        } catch {
          /* say failed; skip the sentence */
        } finally {
          try {
            unlinkSync(out);
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      this.running = false;
      if (this.closing && !this.queue.length) {
        const c = this.closing;
        this.closing = null;
        c();
      }
    }
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.running && !this.queue.length) return resolve();
      this.closing = resolve;
    });
  }

  abort(): void {
    this.aborted = true;
    this.queue = [];
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const c = this.closing;
    this.closing = null;
    if (c) c();
  }
}

/**
 * Gemini's voice, usable by ANY brain.
 *
 * The realtime path (voice/realtime.ts) gives Echo this voice, but it does so by
 * running the whole turn on Gemini Live — hearing, thinking and speaking — which
 * means it also REPLACES whichever brain is configured. That is the right trade
 * when Gemini is the brain, and the wrong one when the user picked Claude and
 * wants Claude's reasoning.
 *
 * This is the other half: a plain text-to-speech engine on the same prebuilt
 * voices, so Claude, OpenAI or a local model can think and still speak in
 * Echo's voice. Measured ~2s for a short sentence, ~4.5s for a long one, and
 * the pipeline speaks sentence by sentence, so all but the first overlap with
 * the previous sentence playing.
 *
 * Returns 24 kHz mono PCM16 — the same format the player already takes from the
 * realtime path, so nothing downstream changes.
 */
export class GeminiTtsStream extends EventEmitter implements TtsStream {
  readonly name = "gemini-tts";
  readonly sampleRate = 24000;
  private queue: Array<{ text: string; sentence: number }> = [];
  private running = false;
  private aborted = false;
  private closing: (() => void) | null = null;
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly apiKey: string,
    private readonly voiceName: string,
    private readonly model: string
  ) {
    super();
  }

  async open(): Promise<void> {
    /* stateless REST; nothing to open */
  }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    this.queue.push({ text, sentence });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.aborted) {
        const { text, sentence } = this.queue.shift()!;
        const ac = new AbortController();
        this.controllers.add(ac);
        const timeout = setTimeout(() => ac.abort(), 20_000);
        try {
          // Gemini 3.1+ can emit PCM while synthesising. Waiting for res.json()
          // made the nominal streaming adapter wait for the entire sentence.
          const streaming = /^gemini-(?:3\.[1-9]|[4-9])/.test(this.model);
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:${streaming ? 'streamGenerateContent?alt=sse&' : 'generateContent?'}key=${this.apiKey}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              signal: ac.signal,
              body: JSON.stringify({
                contents: [{ parts: [{ text: withProsody(text) }] }],
                generationConfig: {
                  responseModalities: ["AUDIO"],
                  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } } },
                },
              }),
            }
          );
          let emitted = false;
          const audio = (body: any) => {
            if (body?.error) throw new Error(String(body.error.message ?? 'audio generation failed'));
            for (const part of body?.candidates?.[0]?.content?.parts ?? []) {
              const inline = part.inlineData;
              if (!inline?.data || this.aborted) continue;
              const rate = Number(/rate=(\d+)/i.exec(inline.mimeType ?? '')?.[1]) || this.sampleRate;
              const pcm = stripWav(Buffer.from(inline.data, 'base64'));
              if (!pcm.length) continue;
              emitted = true;
              this.emit('audio', {pcm, sampleRate: rate, sentence} satisfies TtsAudio);
            }
          };
          if (res.ok === false) {
            const body: any = await res.json();
            throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
          }
          if (res.headers?.get('content-type')?.includes('text/event-stream')) {
            for await (const body of jsonSse(res)) { if (this.aborted) break; audio(body); }
          } else {
            audio(await res.json());
          }
          if (!emitted && !this.aborted) {
            // Never silently drop a sentence: a turn that half-speaks reads as
            // Echo breaking off mid-thought.
            this.emit("error", `gemini tts: no audio (HTTP ${res.status})`);
            this.emit("sentenceDone", sentence);
            continue;
          }
          if (this.aborted) break;
          this.emit("sentenceDone", sentence);
        } catch (err: any) {
          if (!this.aborted) this.emit("error", `gemini tts: ${String(err?.message ?? err).slice(0, 120)}`);
          this.emit("sentenceDone", sentence);
        } finally {
          clearTimeout(timeout);
          this.controllers.delete(ac);
        }
      }
    } finally {
      this.running = false;
      if (this.closing && !this.queue.length) {
        const c = this.closing;
        this.closing = null;
        c();
      }
    }
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.running && !this.queue.length) return resolve();
      this.closing = resolve;
    });
  }

  abort(): void {
    this.aborted = true;
    this.queue = [];
    for (const ac of this.controllers) { try { ac.abort(); } catch { /* ignore */ } }
    this.controllers.clear();
    const c = this.closing;
    this.closing = null;
    if (c) c();
  }
}

/** The stream for the configured engine, or null when that engine cannot stream. */
export function createTtsStream(cfg: JarvisConfig, firstText: string): TtsStream | null {
  if (cfg.voice.ttsStreaming === false || !cfg.voice.ttsEnabled) return null;
  switch (cfg.voice.ttsEngine) {
    case "vibevoice": {
      if (!vibeVoiceSupportsText(firstText)) {
        const key = process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"];
        return key ? new GeminiTtsStream(key, cfg.voice.realtime?.voice ?? "Charon",
          cfg.voice.geminiTtsModel ?? "gemini-3.1-flash-tts-preview") : offlineTtsStream(cfg);
      }
      return new VibeVoiceTtsStream(cfg.voice.vibeVoiceUrl ?? '', cfg.voice.vibeVoiceSpeaker ?? 'Carter');
    }
    case "sarvam": {
      const key = process.env.SARVAM_API_KEY;
      return key ? new SarvamTtsStream(cfg, key, firstText) : offlineTtsStream(cfg);
    }
    case "elevenlabs": {
      const key = process.env.ELEVENLABS_API_KEY;
      return key && cfg.voice.elevenLabsVoiceId ? new ElevenLabsTtsStream(cfg.voice.elevenLabsVoiceId, key) : offlineTtsStream(cfg);
    }
    case "gemini": {
      const key = process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"];
      return key
        ? new GeminiTtsStream(
            key,
            cfg.voice.realtime?.voice ?? "Kore",
            cfg.voice.geminiTtsModel ?? "gemini-3.1-flash-tts-preview"
          )
        : offlineTtsStream(cfg);
    }
    case "mac":
      return new SayTtsStream(cfg.voice.ttsVoice);
    case "piper": {
      // Piper speaks English only; Telugu, Hindi and other scripts go to
      // Gemini's voice — the same one Gemini Live answers in.
      const key = process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"];
      if (!isLatinText(firstText) && key) {
        return new GeminiTtsStream(key, cfg.voice.realtime?.voice ?? "Charon", cfg.voice.geminiTtsModel ?? "gemini-3.1-flash-tts-preview");
      }
      return offlineTtsStream(cfg);
    }
    default:
      return null; // fakeyou keeps the file path
  }
}
