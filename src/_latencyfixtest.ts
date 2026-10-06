import assert from 'node:assert/strict';
import { GeminiTtsStream } from './voice/tts-stream.js';
import { quickReply } from './voice/quick-reply.js';
import { listen, parseHeard } from './voice/hearing.js';
import { DEFAULTS_FOR_TESTS } from './config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
for (const phrase of ['hello', 'Hi!', 'Hey Echo, hello.', 'Good morning', 'how are you']) {
  assert.ok(quickReply(phrase), `complete social utterance: ${phrase}`);
}
for (const command of ['hello and open my email', 'good morning, delete the files', 'hi can you check my inbox',
  'how are you going to fix this', 'hey send the message', 'hello world program', 'say hello to John',
  'no', 'yes', 'stop', 'thanks, undo that']) {
  assert.equal(quickReply(command), null, `real request remains with the selected brain: ${command}`);
}
console.log('PASS exact greeting route never swallows task, confirmation, or stop commands');
const scratch = mkdtempSync(join(tmpdir(), 'echo-hearing-latency-'));
const wav = join(scratch, 'fixture.wav');
writeFileSync(wav, Buffer.alloc(44));
const keyBefore = process.env.ECHO_HEARING_TEST_KEY;
process.env.ECHO_HEARING_TEST_KEY = 'offline';
const cfg = {...DEFAULTS_FOR_TESTS, gemini: {...DEFAULTS_FOR_TESTS.gemini, model: 'offline-hearing-test', apiKeyEnv: 'ECHO_HEARING_TEST_KEY'}};
try {
  let signal: AbortSignal | undefined;
  const beginning = performance.now();
  const result = await listen({path: wav, mimeType: 'audio/wav'} as any, cfg, '', {
    timeoutMs: 30,
    generate: async request => { signal = request.config.abortSignal; return new Promise(() => {}); },
  });
  assert.equal(result, null);
  assert.ok(performance.now() - beginning < 250, 'stalled hearing pass cannot hold the command indefinitely');
  assert.ok(signal?.aborted, 'timed-out request is cancelled');
  const transcript = "Don't send the email. Save it as a draft.";
  const heard = await listen({path: wav, mimeType: 'audio/wav'} as any, cfg, 'send the email', {
    generate: async request => {
      assert.equal(request.config.responseMimeType, 'application/json');
      return {candidates: [{content: {parts: [{text: JSON.stringify({transcript, tone: 'urgent'})}]}}]};
    },
  });
  assert.equal(heard?.transcript, transcript, 'accurate hearing preserves the negation instead of trusting the machine hint');
  assert.equal(parseHeard('{"transcript":"నమస్కారం","tone":"neutral"}')?.transcript, 'నమస్కారం');
  console.log('PASS hearing has a bounded deadline while preserving corrections, negations and original-language text');
} finally {
  if (keyBefore === undefined) delete process.env.ECHO_HEARING_TEST_KEY;
  else process.env.ECHO_HEARING_TEST_KEY = keyBefore;
  rmSync(scratch, {recursive: true, force: true});
}
const originalFetch = globalThis.fetch;
let finish!: () => void;
const finished = new Promise<void>(r => { finish = r; });
let completed = false;
const requests: string[] = [];
globalThis.fetch = (async (url: any) => {
  requests.push(String(url));
  const event = (values: number[]) => `data: ${JSON.stringify({candidates: [{content: {parts: [{inlineData: {mimeType: 'audio/L16;rate=24000', data: Buffer.from(values).toString('base64')}}]}}]})}\r\n\r\n`;
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({async start(c) {
    const first = event([1, 2, 3, 4]);
    c.enqueue(encoder.encode(first.slice(0, 17)));
    c.enqueue(encoder.encode(first.slice(17)));
    await finished;
    c.enqueue(encoder.encode(event([5, 6, 7, 8])));
    completed = true; c.close();
  }}), {headers: {'content-type': 'text/event-stream'}});
}) as any;
const voice = new GeminiTtsStream('test-key', 'Charon', 'gemini-3.1-flash-tts-preview');
const chunks: Buffer[] = [];
voice.on('audio', a => chunks.push(a.pcm));
voice.on('error', () => {});
try {
  await voice.open(); voice.speak('Hello, how can I help?', 0);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(chunks.length, 1, 'first audio must reach the player before the provider finishes generating the sentence');
  assert.equal(completed, false);
  assert.match(requests[0], /streamGenerateContent/);
  finish(); await voice.close();
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1,2,3,4,5,6,7,8]), 'all PCM chunks arrive once, in order');
  console.log('PASS Gemini audio reaches playback before the sentence finishes; split SSE frames preserve every sample');
} finally { finish(); voice.abort(); globalThis.fetch = originalFetch; }

// A provider refusal must release the sentence so SpeechStream can fall back.
try {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({error: {message: 'quota exhausted'}}), {status: 429});
  }) as any;
  const refused = new GeminiTtsStream('test-key', 'Charon', 'gemini-3.1-flash-tts-preview');
  const errors: string[] = [];
  const done: number[] = [];
  refused.on('error', e => errors.push(e));
  refused.on('sentenceDone', i => done.push(i));
  await refused.open(); refused.speak('Hello.', 0); await refused.close();
  assert.equal(calls, 1, 'quota errors are not retried in the voice adapter');
  assert.match(errors[0], /quota exhausted/);
  assert.deepEqual(done, [0], 'fallback is released exactly once');

  // Retain the existing non-streaming path for older configured voice models.
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.match(String(url), /:generateContent\?/);
    return new Response(JSON.stringify({candidates: [{content: {parts: [{inlineData: {
      data: Buffer.from([9,10,11,12]).toString('base64'), mimeType: 'audio/L16;rate=24000',
    }}]}}]}), {headers: {'content-type': 'application/json'}});
  }) as any;
  const older = new GeminiTtsStream('test-key', 'Charon', 'gemini-2.5-flash-preview-tts');
  const pcm: Buffer[] = [];
  older.on('audio', a => pcm.push(a.pcm));
  older.on('error', e => { throw new Error(e); });
  await older.open(); older.speak('Hello.', 0); await older.close();
  assert.deepEqual(Buffer.concat(pcm), Buffer.from([9,10,11,12]));

  let release!: () => void;
  let signal: AbortSignal | undefined;
  const held = new Promise<void>(r => { release = r; });
  globalThis.fetch = (async (_url: string | URL | Request, options?: RequestInit) => {
    signal = options?.signal as AbortSignal;
    await held;
    return new Response(JSON.stringify({candidates: [{content: {parts: [{inlineData: {
      data: Buffer.from([1,2,3,4]).toString('base64'),
    }}]}}]}));
  }) as any;
  const cancelled = new GeminiTtsStream('test-key', 'Charon', 'gemini-3.1-flash-tts-preview');
  let lateAudio = 0;
  cancelled.on('audio', () => lateAudio++);
  cancelled.on('error', () => {});
  await cancelled.open(); cancelled.speak('An interrupted reply.', 0);
  cancelled.abort(); release(); await cancelled.close();
  assert.ok(signal?.aborted, 'stop cancels the active provider request');
  assert.equal(lateAudio, 0, 'late provider audio cannot play after stop');
  console.log('PASS quota refusal releases fallback; older voices work; stop suppresses late audio');
} finally { globalThis.fetch = originalFetch; }
