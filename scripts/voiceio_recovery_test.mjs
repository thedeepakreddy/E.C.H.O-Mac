/** Stop the real AVAudioEngine like a Bluetooth format change; it must resume. */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'echo-audio-recovery-'));
let proc;
const events = [];
try {
  // Inject only the fault trigger into a temporary build of the real helper.
  const source = readFileSync(join(root, 'native/voiceio.swift'), 'utf8');
  const marker = 'case "quit": exit(0)';
  if (!source.includes(marker)) throw new Error('native control seam missing');
  writeFileSync(join(dir, 'voiceio.swift'), source.replace(marker, `case "test-route-change":
                        engine.stop()
                        player.stop()
                        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)
                        event(["ev": "test_route_changed"])
                    ${marker}`));
  execFileSync('swiftc', ['-O', join(dir, 'voiceio.swift'), '-o', join(dir, 'voiceio')], {stdio: 'inherit'});
  proc = spawn(join(dir, 'voiceio'), [], {stdio: ['pipe', 'pipe', 'pipe']});
  let buf = Buffer.alloc(0);
  proc.stderr.on('data', d => process.stderr.write(d));
  proc.stdout.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(0);
      if (buf.length < len + 4) break;
      if (buf[4] === 0x20) events.push(JSON.parse(buf.subarray(5, len + 4)));
      buf = buf.subarray(len + 4);
    }
  });
  const send = (type, data) => { const h = Buffer.alloc(5); h.writeUInt32LE(data.length + 1); h[4] = type; proc.stdin.write(Buffer.concat([h, data])); };
  const control = cmd => send(2, Buffer.from(JSON.stringify({cmd})));
  const waitFor = async (predicate, ms = 4000) => {
    const end = Date.now() + ms;
    while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    if (!predicate()) throw new Error('audio engine failed to resume and drain after route change');
  };
  await waitFor(() => events.some(e => e.ev === 'ready'));
  // Quiet two-second tone, split just like the production player writes PCM.
  const pcm = Buffer.alloc(24000 * 2 * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(650 * Math.sin(i * 2 * Math.PI * 440 / 24000)), i * 2);
  for (let off = 0; off < pcm.length; off += 32768) send(1, pcm.subarray(off, off + 32768));
  await waitFor(() => events.some(e => e.ev === 'progress' && e.played_ms > 200));
  control('test-route-change');
  await waitFor(() => events.some(e => e.ev === 'test_route_changed'));
  const start = events.length;
  await waitFor(() => events.slice(start).some(e => e.ev === 'drained'));
  if (!events.slice(start).some(e => e.ev === 'progress')) throw new Error('no playback progress after recovery');
  // A stopped idle engine must also resume the next utterance. Its progress
  // clock starts from that utterance, not the previous playback's timestamp.
  control('test-route-change');
  await waitFor(() => events.filter(e => e.ev === 'test_route_changed').length === 2);
  const next = events.length;
  send(1, pcm.subarray(0, 24000));
  await waitFor(() => events.slice(next).some(e => e.ev === 'drained'));
  const progress = events.slice(next).filter(e => e.ev === 'progress');
  if (!progress.length || progress.some(e => e.played_ms > 800)) throw new Error('new utterance inherited an old playback clock');
  // A user stop really drops the audio; a later route change must not replay it.
  const stopped = events.length;
  send(1, pcm);
  await waitFor(() => events.slice(stopped).some(e => e.ev === 'progress'));
  control('stop');
  await waitFor(() => events.slice(stopped).some(e => e.ev === 'stopped'));
  const reset = events.length;
  control('test-route-change');
  await waitFor(() => events.slice(reset).some(e => e.ev === 'engine_resumed'));
  if (events.slice(reset).some(e => e.ev === 'engine_resumed' && e.pending !== 0)) throw new Error('cancelled audio retained for replay');
  console.log('PASS stopped engine resumes pending PCM and drains after a simulated Bluetooth route change');
  console.log('PASS idle restart, per-utterance progress, and user-stop cancellation');
} catch (error) { console.error('FAIL ' + error.message + ' events=' + JSON.stringify(events)); process.exitCode = 1; }
finally { proc?.kill('SIGTERM'); rmSync(dir, {recursive: true, force: true}); }
