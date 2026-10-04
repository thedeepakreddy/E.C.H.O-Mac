import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { VibeVoiceTtsStream, vibeVoiceEndpoint, vibeVoiceSupportsText } from './voice/vibevoice.js';
import { createTtsStream, STREAMING_ENGINES } from './voice/tts-stream.js';
import { DEFAULTS_FOR_TESTS } from './config.js';

assert.equal(vibeVoiceEndpoint('http://127.0.0.1:3000').href, 'ws://127.0.0.1:3000/stream');
assert.equal(vibeVoiceEndpoint('https://voice.example/stream').protocol, 'wss:');
assert.throws(() => vibeVoiceEndpoint('file:///tmp/voice'));
assert.ok(vibeVoiceSupportsText('Hello, how can I help?'));
assert.equal(vibeVoiceSupportsText('Hello నమస్కారం'), false);
assert.equal(vibeVoiceSupportsText('नमस्ते'), false);
const cfg = {...DEFAULTS_FOR_TESTS, voice: {...DEFAULTS_FOR_TESTS.voice,
  ttsEngine: 'vibevoice' as const, ttsEnabled: true, ttsStreaming: true,
  vibeVoiceUrl: 'http://127.0.0.1:3000', vibeVoiceSpeaker: 'Carter'}};
for (const brain of ['claude','gemini','openai','openrouter','ollama'] as const) {
  assert.equal(createTtsStream({...cfg, brain}, 'Hello there.')?.name, 'vibevoice');
}
assert.ok(STREAMING_ENGINES.has('vibevoice'));
const keyName = cfg.gemini.apiKeyEnv;
const previous = process.env[keyName];
process.env[keyName] = 'offline-fixture';
assert.equal(createTtsStream(cfg, 'నమస్కారం')?.name, 'gemini-tts');
if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous;
console.log('PASS all five brains use the shared voice; unsupported scripts retain multilingual routing');

const server = new WebSocketServer({host: '127.0.0.1', port: 0});
await new Promise<void>(r => server.once('listening', r));
const port = (server.address() as {port: number}).port;
let release!: () => void;
const held = new Promise<void>(r => { release = r; });
let connected!: () => void;
const connection = new Promise<void>(r => { connected = r; });
const requests: string[] = [];
server.on('connection', (ws, request) => {
  const url = new URL(request.url!, 'http://127.0.0.1');
  assert.equal(url.pathname, '/stream');
  assert.equal(url.searchParams.get('voice'), 'Carter');
  const text = url.searchParams.get('text')!;
  requests.push(text);
  if (text === 'busy') {
    ws.send(JSON.stringify({type: 'log', event: 'backend_busy'}));
    ws.close(1013); return;
  }
  if (text === 'empty') { ws.close(1000); return; }
  if (text === 'stalled') return;
  if (text === 'cancel') { connected(); return; }
  ws.send(JSON.stringify({type: 'log', event: 'backend_request_received'}));
  // Force PCM samples to straddle transport chunks.
  ws.send(Buffer.from([1, 2, 3]));
  ws.send(Buffer.from([4]));
  if (text === 'first') void held.then(() => { ws.send(Buffer.from([5,6])); ws.close(1000); });
  else ws.close(1000);
});
const url = `http://127.0.0.1:${port}`;
try {
  const voice = new VibeVoiceTtsStream(url);
  const samples: Buffer[] = [], sentences: number[] = [];
  const errors: string[] = [];
  let first!: () => void;
  const firstAudio = new Promise<void>(r => { first = r; });
  voice.on('audio', a => { samples.push(a.pcm); first(); });
  voice.on('sentenceDone', s => sentences.push(s));
  voice.on('error', e => errors.push(e));
  await voice.open(); voice.speak('first', 0); voice.speak('second', 1);
  await firstAudio;
  assert.deepEqual(requests, ['first'], 'sentences cannot race the single-model server');
  assert.deepEqual(sentences, [], 'audio reaches playback before generation completes');
  release(); await voice.close();
  assert.deepEqual(Buffer.concat(samples), Buffer.from([1,2,3,4,5,6,1,2,3,4]));
  assert.deepEqual(sentences, [0,1]); assert.deepEqual(errors, []);
  console.log('PASS real WebSocket transport streams PCM early, preserves split samples and serialises sentences');

  for (const text of ['busy','empty','stalled']) {
    const stream = new VibeVoiceTtsStream(url, 'Carter', 80);
    const failures: string[] = [], completed: number[] = [];
    stream.on('error', e => failures.push(e));
    stream.on('sentenceDone', s => completed.push(s));
    await stream.open(); stream.speak(text, 0); await stream.close();
    assert.equal(failures.length, 1, `${text} releases fallback exactly once`);
    assert.deepEqual(completed, [0]);
  }
  const cancelled = new VibeVoiceTtsStream(url);
  let late = 0;
  cancelled.on('audio', () => late++); cancelled.on('error', () => {});
  await cancelled.open(); cancelled.speak('cancel', 0);
  await connection; cancelled.abort(); await cancelled.close();
  assert.equal(late, 0);
  console.log('PASS busy/empty/stalled servers release fallback; interruption closes the active request');
} finally {
  release(); for (const ws of server.clients) ws.terminate();
  await new Promise<void>(r => server.close(() => r()));
}
