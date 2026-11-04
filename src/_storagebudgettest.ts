import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticLog, checkDiskReserve, checkDiagnosticWrite, StorageBudgetError } from './diagnostics/storage-budget.js';
import { VoiceLog } from './voice/voice-log.js';
import { Recorder } from './agent-replay/recorder.js';

// Every writable path is a fresh fixture; fixtures are deliberately retained.
const fixture = () => mkdtempSync(join(tmpdir(), 'echo-storage-budget-'));
const plenty = () => ({ bavail: 1000000, bsize: 1 });

test('diagnostic logging stops with one warning and preserves whole existing lines at the file cap', () => {
  const root = fixture(), file = join(root, 'voice.jsonl'), warnings: string[] = [];
  writeFileSync(file, 'existing\n');
  const log = new DiagnosticLog(root, file, { fileBytes: 16, directoryBytes: 100, diskReserveBytes: 10, statfs: plenty, warn: m => warnings.push(m) });
  assert.equal(log.append('hello\n'), true);
  assert.equal(log.append('overflow\n'), false);
  assert.equal(log.append('x'), false);
  assert.equal(readFileSync(file, 'utf8'), 'existing\nhello\n');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stopped.*manual.*archive/i);
  assert.equal(statSync(file).size, 15);
});

test('voice logs share the whole diagnostic directory cap and warn even in quiet mode', () => {
  const root = fixture(), runs = join(root, 'runs'), warnings: string[] = [];
  mkdirSync(runs); writeFileSync(join(runs, 'existing-user-evidence'), 'kept');
  const log = new VoiceLog();
  const path = log.init(root, { quiet: true, budget: { fileBytes: 1000, directoryBytes: 5, diskReserveBytes: 0, statfs: plenty, warn: m => warnings.push(m) } });
  assert.equal(path, null);
  log.event('note', { text: 'never appended after stop' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /directory-limit/);
  assert.equal(readFileSync(join(runs, 'existing-user-evidence'), 'utf8'), 'kept');
});

test('available disk reserve uses bavail and fails closed at the exact boundary or unknown space', () => {
  const root = fixture();
  checkDiskReserve(root, 10, { reserveBytes: 100, statfs: () => ({ bavail: 11n, bsize: 10n }) });
  assert.throws(() => checkDiskReserve(root, 11, { reserveBytes: 100, statfs: () => ({ bavail: 11, bsize: 10 }) }), /disk-reserve/);
  assert.throws(() => checkDiskReserve(root, 0, { statfs: () => { throw Error('statfs unavailable'); } }), /disk-space-unknown/);
});

test('replay event exhaustion warns once, refuses new evidence, and reserves both terminal events', () => {
  const root = fixture(), warnings: string[] = [];
  const rec = new Recorder(root, 'bounded', undefined, { eventCount: 2, eventBytes: 8192, terminalReserveBytes: 4096, terminalEventBytes: 1024, directoryBytes: 20000, diskReserveBytes: 0, statfs: plenty, warn: m => warnings.push(m) });
  rec.emit({ type: 'run.start' }); rec.emit({ type: 'tool.call', password: 'private-credential' });
  assert.throws(() => rec.emit({ type: 'tool.result', result: 'must not be silently dropped' }), StorageBudgetError);
  assert.throws(() => rec.emit({ type: 'llm.request' }), StorageBudgetError);
  rec.finish(true, 'completed', 1);
  const text = readFileSync(join(rec.dir, 'events.jsonl'), 'utf8');
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.type), ['run.start', 'tool.call', 'storage.budget', 'loop.exit', 'run.end']);
  assert.equal(events.at(-1).evidenceComplete, false);
  assert.equal(events.at(-2).reason, 'completed', 'storage loss must not invent a different task outcome');
  assert.match(events.at(-2).detail, /recording.*incomplete/i);
  assert.equal(warnings.length, 1);
  assert(!text.includes('private-credential'));
  assert(statSync(join(rec.dir, 'events.jsonl')).size <= 8192);
});

test('diagnostic writers share cached accounting without rescanning history for each event', () => {
  const root = fixture(), options = { fileBytes: 100, directoryBytes: 14, diskReserveBytes: 0, statfs: plenty, scanEntries: 4 };
  const warnings: string[] = [];
  const first = new DiagnosticLog(root, join(root, 'a'), { ...options, warn: m => warnings.push(m) });
  assert(first.append('123456'));
  // An unrelated external directory appears after the bounded initial inventory.
  // A hot-path rescan would hit the 4-entry scan limit instead of accepting this.
  const history = join(root, 'external-history'); mkdirSync(history);
  for (let i = 0; i < 10; i++) writeFileSync(join(history, String(i)), '');
  const second = new DiagnosticLog(root, join(root, 'b'), { ...options, warn: m => warnings.push(m) });
  assert(second.append('abcdef'));
  assert(first.append('xy'));
  assert.equal(second.append('!'), false, 'writes from both sinks count against one directory cap');
  assert.match(warnings[0], /directory-limit/);
  const recheck = new DiagnosticLog(root, join(root, 'c'), { ...options, recheckMs: 0, warn: m => warnings.push(m) });
  assert.equal(recheck.append(''), false, 'periodic recheck fails closed when inventory exceeds its work bound');
  assert.match(warnings[1], /scan-limit/);
});

test('broken file links and directory links cannot redirect a diagnostic write or recorder mkdir', () => {
  const root = fixture(), outside = fixture(), target = join(outside, 'not-created'), warnings: string[] = [];
  symlinkSync(target, join(root, 'broken-log'));
  const log = new DiagnosticLog(root, join(root, 'broken-log'), { diskReserveBytes: 0, statfs: plenty, warn: m => warnings.push(m) });
  assert.equal(log.append('must not escape'), false);
  assert(!existsSync(target));
  symlinkSync(outside, join(root, 'run-link'));
  assert.throws(() => new Recorder(root, 'run-link'), /unsafe-path/);
  assert(!existsSync(join(outside, 'blobs')), 'validation precedes mkdir');
  symlinkSync(join(outside, 'missing-directory'), join(root, 'broken-directory'));
  assert.throws(() => new Recorder(root, 'broken-directory'), /unsafe-path/);
  assert(!existsSync(join(outside, 'missing-directory')));
});

test('replay blobs deduplicate redacted bytes, stop at the run byte cap, and leave no success-shaped missing reference', () => {
  const root=fixture(), warnings:string[]=[];
  const rec=new Recorder(root,'blobs',undefined,{blobBytes:12,singleBlobBytes:12,diskReserveBytes:0,statfs:plenty,warn:m=>warnings.push(m)});
  const ref=rec.blob('abcd');assert.equal(rec.blob('abcd'),ref);
  assert.equal(readdirSync(join(rec.dir,'blobs')).length,1);
  rec.blob('efgh');assert.throws(()=>rec.blob('ijkl'),StorageBudgetError);
  rec.finish(false,'tool_error',1);
  assert.equal(readdirSync(join(rec.dir,'blobs')).length,2);
  assert.equal(warnings.length,1);
  assert.equal(JSON.parse(readFileSync(join(rec.dir,'events.jsonl'),'utf8').trim().split('\n').at(-1)!).evidenceComplete,false);
});

test('oversized secret fields are redacted before any spill and oversized terminal detail is explicitly labelled',()=>{
  const root=fixture(),rec=new Recorder(root,'redaction',undefined,{diskReserveBytes:0,statfs:plenty,warn:()=>{}});
  rec.emit({type:'tool.call',password:{value:'PRIVATE-PAYLOAD'.repeat(3000)}});
  const files=readdirSync(join(rec.dir,'blobs'));
  assert.equal(files.length,0,'a redacted field must not spill a plaintext secret blob');
  rec.finish(true,'completed',1,'large detail'.repeat(10000));
  const events=readFileSync(join(rec.dir,'events.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert(events.some(e=>e.terminalPayloadOmitted===true));
  assert.equal(events.at(-1).evidenceComplete,false);
});

test('an active replay reserves terminal capacity against a simultaneous voice writer in the same store',()=>{
  const root=fixture(),options={directoryBytes:10000,diskReserveBytes:0,statfs:plenty,warn:()=>{}};
  const rec=new Recorder(root,'active',undefined,{...options,eventBytes:8192,terminalReserveBytes:4096,terminalEventBytes:1024});
  rec.emit({type:'run.start'});
  const voice=new DiagnosticLog(root,join(root,'voice.jsonl'),{...options,fileBytes:9000});
  assert.equal(voice.append('x'.repeat(7000)),false,'another diagnostic writer cannot consume the terminal reservation');
  rec.finish(true,'completed',0);
  const events=readFileSync(join(rec.dir,'events.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert.deepEqual(events.slice(-2).map(e=>e.type),['loop.exit','run.end']);
});

test('a looser writer cannot bypass an active replay owner directory cap or disk reserve',()=>{
  const root=fixture(),rec=new Recorder(root,'strict',undefined,{directoryBytes:6000,diskReserveBytes:1000,statfs:plenty,warn:()=>{},eventBytes:8192,terminalReserveBytes:4096,terminalEventBytes:1024});
  rec.emit({type:'run.start'});
  const loose=new DiagnosticLog(root,join(root,'loose.jsonl'),{fileBytes:10000,directoryBytes:100000,diskReserveBytes:0,statfs:plenty,warn:()=>{}});
  assert.equal(loose.append('x'.repeat(5904)),false,'the strictest active owner directory policy applies to every writer');
  const lowDisk=new DiagnosticLog(root,join(root,'disk.jsonl'),{directoryBytes:100000,diskReserveBytes:0,statfs:()=>({bavail:4097,bsize:1}),warn:()=>{}});
  assert.equal(lowDisk.append('x'),false,'the largest active owner disk reserve applies to every writer');
  rec.finish(true,'completed',0);
  const after=new DiagnosticLog(root,join(root,'after.jsonl'),{fileBytes:10000,directoryBytes:100000,diskReserveBytes:0,statfs:plenty,warn:()=>{}});
  assert(after.append('x'.repeat(5904)),'closing the owner releases its reservation and stricter policy');
});

test('bounded inventory errors distinguish entry and time limits with measured scan progress',()=>{
  const root=fixture();writeFileSync(join(root,'history'),'preserved');
  assert.throws(()=>checkDiagnosticWrite(root,join(root,'probe'),0,{scanEntries:1,scanMs:1000,statfs:plenty,diskReserveBytes:0}),error=>{
    assert(error instanceof StorageBudgetError);assert.equal(error.scan?.reason,'entries');assert.equal(error.scan?.entries,2);assert.equal(error.scan?.maxEntries,1);return true;
  });
  const other=fixture();
  assert.throws(()=>checkDiagnosticWrite(other,join(other,'probe'),0,{scanMs:0,statfs:plenty,diskReserveBytes:0}),error=>{
    assert(error instanceof StorageBudgetError);assert.equal(error.scan?.reason,'time');assert.equal(error.scan?.maxMs,0);assert((error.scan?.elapsedMs??-1)>=0);return true;
  });
});

test('recorder preserves existing readable and Unicode basename run identities while rejecting traversal',()=>{
  const root=fixture();
  for(const id of ['Offline worker--fixture-id','Δοκιμή 研究--fixture-id','.worker--fixture-id','..worker--fixture-id','_worker--fixture-id','agent:review--fixture-id']){
    const rec=new Recorder(root,id,undefined,{diskReserveBytes:0,statfs:plenty});
    assert.equal(rec.dir,join(root,id));assert.equal(rec.runId,id);
    assert.equal(rec.emit({type:'run.start'}).runId,id);
    rec.finish(true,'completed',0);
    assert.equal(JSON.parse(readFileSync(join(root,id,'events.jsonl'),'utf8').split('\n')[0]).runId,id);
  }
  for(const id of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'a\0b'])assert.throws(()=>new Recorder(root,id),/unsafe-run-path/);
  assert.equal(readdirSync(root).length,6);
});
