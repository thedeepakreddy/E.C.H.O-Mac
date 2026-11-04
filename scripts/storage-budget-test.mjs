import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {piperPreflight, setup} from './piper.mjs';
import {checkModelStorage,installationUsage} from './storage-budget.mjs';

test('Piper preflight rejects flags, excessive installed/requested voices and low or unknown free space before launching anything', async () => {
  const root=mkdtempSync(join(tmpdir(),'echo-piper-budget-')), voices=join(root,'vendor/piper/voices');
  mkdirSync(voices,{recursive:true});
  const options={root,statfs:()=>({bavail:10000000000,bsize:1})};
  assert.throws(()=>piperPreflight(['--help'],options),/voice identifier/);
  assert.throws(()=>piperPreflight(['en_GB-a-medium','en_GB-b-medium','en_GB-c-medium','en_GB-d-medium','en_GB-e-medium'],options),/voice count/);
  writeFileSync(join(voices,'en_GB-a-medium.onnx'),'existing');writeFileSync(join(voices,'en_GB-a-medium.onnx.json'),'{}');
  assert.deepEqual(piperPreflight(['en_GB-a-medium'],options).downloadVoices,[]);
  assert.throws(()=>piperPreflight(['en_GB-b-medium','en_GB-c-medium','en_GB-d-medium','en_GB-e-medium'],options),/voice count/);
  let launched=0;
  await assert.rejects(setup(['en_GB-b-medium'],{...options,statfs:()=>({bavail:1,bsize:1}),run:async()=>{launched++;}}),/disk-reserve/);
  assert.equal(launched,0);
  assert.throws(()=>piperPreflight(['en_GB-b-medium'],{...options,statfs:()=>{throw Error('no stats');}}),/disk-space-unknown/);
  assert.throws(()=>piperPreflight(['en_GB-b-medium'],{...options,installationBytes:1}),/installation budget/);
});

test('cached Piper setup lists only the supplied fixture and never launches a voice download',async()=>{
  const root=mkdtempSync(join(tmpdir(),'echo-piper-cached-')),voices=join(root,'vendor/piper/voices'),commands=[];
  mkdirSync(voices,{recursive:true});
  writeFileSync(join(voices,'en_GB-alan-medium.onnx'),'fixture-not-verified-weights');
  writeFileSync(join(voices,'en_GB-alan-medium.onnx.json'),'{}');
  const report=await setup(['en_GB-alan-medium'],{root,statfs:()=>({bavail:10000000000,bsize:1}),run:async(_cmd,args)=>{commands.push(args);}});
  assert.deepEqual(report.downloadVoices,[]);
  assert(!commands.some(args=>args.includes('piper.download_voices')));
  writeFileSync(join(voices,'en_GB-alan-medium.onnx'),'');
  assert.throws(()=>piperPreflight(['en_GB-alan-medium'],{root,statfs:()=>({bavail:10000000000,bsize:1})}),/incomplete/);
});

test('model inventories count symlinks without following them and preserve the exact available-space reserve',()=>{
  const root=mkdtempSync(join(tmpdir(),'echo-model-usage-')),outside=mkdtempSync(join(tmpdir(),'echo-model-outside-'));
  writeFileSync(join(outside,'large'),Buffer.alloc(100000));symlinkSync(outside,join(root,'unrelated-link'));
  assert(installationUsage(root)<1000);
  checkModelStorage(root,{incomingBytes:10,installationBytes:1000,reserveBytes:100,statfs:()=>({bavail:110,bsize:1})});
  assert.throws(()=>checkModelStorage(root,{incomingBytes:11,installationBytes:1000,reserveBytes:100,statfs:()=>({bavail:110,bsize:1})}),/disk-reserve/);
});

test('Piper refuses existing model/venv directory symlinks before any mkdir or launch',async()=>{
  const root=mkdtempSync(join(tmpdir(),'echo-piper-link-')), outside=mkdtempSync(join(tmpdir(),'echo-piper-outside-'));
  mkdirSync(join(root,'vendor/piper'),{recursive:true});
  symlinkSync(join(outside,'not-created'),join(root,'vendor/piper/voices'));
  let launched=0;
  await assert.rejects(setup(['en_GB-alan-medium'],{root,run:async()=>{launched++;}}),/unsafe-path/);
  assert.equal(launched,0);assert(!existsSync(join(outside,'not-created')));
});
