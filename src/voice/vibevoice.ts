import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { TtsStream, TtsAudio } from './tts-stream.js';

/** The official demo sends PCM16/24kHz on /stream, one text per socket. */
export function vibeVoiceEndpoint(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('VibeVoice needs an HTTP or WebSocket server address');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  if (url.pathname === '/' || !url.pathname) url.pathname = '/stream';
  url.hash = '';
  return url;
}

// The released real-time voices primarily support English. Route other scripts
// through Echo's existing multilingual voice rather than mispronouncing them.
export const vibeVoiceSupportsText = (text: string): boolean => !/[^\p{Script=Latin}\P{L}]/u.test(text);

export class VibeVoiceTtsStream extends EventEmitter implements TtsStream {
  readonly name = 'vibevoice';
  readonly sampleRate = 24000;
  private queue: Array<{text: string; sentence: number}> = [];
  private running = false;
  private aborted = false;
  private socket: WebSocket | null = null;
  private cancelActive: (() => void) | null = null;
  private closing: (() => void) | null = null;

  constructor(private readonly endpoint: string, private readonly speaker = 'Carter',
    private readonly firstAudioTimeoutMs = 8000) { super(); }

  async open(): Promise<void> { vibeVoiceEndpoint(this.endpoint); }

  speak(text: string, sentence: number): void {
    if (this.aborted) return;
    this.queue.push({text, sentence});
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.aborted) {
        const {text, sentence} = this.queue.shift()!;
        try { await this.generate(text, sentence); }
        catch (err: any) {
          if (!this.aborted) this.emit('error', `VibeVoice: ${String(err?.message ?? err).slice(0, 160)}`);
          this.queue = []; // SpeechStream replays the owed sentences on fallback.
        }
        if (!this.aborted) this.emit('sentenceDone', sentence);
      }
    } finally {
      this.running = false;
      const done = this.closing; this.closing = null; done?.();
    }
  }

  private generate(text: string, sentence: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = vibeVoiceEndpoint(this.endpoint);
      url.searchParams.set('text', text);
      url.searchParams.set('voice', this.speaker);
      const ws = new WebSocket(url, {handshakeTimeout: 3000, maxPayload: 2 * 1024 * 1024});
      this.socket = ws;
      let finished = false, audio = false;
      let tail = Buffer.alloc(0);
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(first); clearTimeout(total);
        this.cancelActive = null; this.socket = null;
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        error ? reject(error) : resolve();
      };
      const first = setTimeout(() => finish(new Error('no audio within the response deadline')), this.firstAudioTimeoutMs);
      const total = setTimeout(() => finish(new Error('speech generation timed out')), 30000);
      this.cancelActive = () => finish();
      ws.on('message', (data: WebSocket.RawData, binary: boolean) => {
        if (finished || this.aborted) return;
        if (!binary) {
          try {
            const log = JSON.parse(data.toString());
            if (log.event === 'backend_busy') finish(new Error('server is busy'));
            if (log.event === 'backend_error') finish(new Error('server failed to generate speech'));
          } catch { /* Diagnostic frames are not audio. */ }
          return;
        }
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const joined = tail.length ? Buffer.concat([tail, bytes]) : bytes;
        const length = joined.length - joined.length % 2;
        tail = Buffer.from(joined.subarray(length));
        if (!length) return;
        audio = true; clearTimeout(first);
        this.emit('audio', {pcm: Buffer.from(joined.subarray(0, length)), sampleRate: this.sampleRate, sentence} satisfies TtsAudio);
      });
      ws.on('error', () => finish(new Error('cannot connect to the configured server')));
      ws.on('close', code => finish(this.aborted ? undefined :
        code !== 1000 ? new Error(`server closed unexpectedly (${code})`) :
        !audio ? new Error('server returned no audio') :
        tail.length ? new Error('server returned incomplete PCM') : undefined));
    });
  }

  close(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise(resolve => { this.closing = resolve; });
  }

  abort(): void {
    this.aborted = true; this.queue = [];
    this.cancelActive?.();
    const done = this.closing; this.closing = null; done?.();
  }
}
