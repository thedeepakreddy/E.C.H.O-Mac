import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OfficeReportQueue,type OfficeTerminalReport,type OfficeReportLedger,type OfficeReportAdapters,type SpeechAcknowledgment} from './frontier/office-report.js';

// No Electron, provider, disk, network or audio dependencies. The same durable
// fake ledger is reused across queue instances to exercise restart boundaries.
function deferred<T>(){
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const report=(overrides:Partial<OfficeTerminalReport>={}):OfficeTerminalReport=>({
 source:'persisted_terminal_result',missionId:'mission-1',taskId:'task-1',retrySequence:0,
 status:'completed',summary:'The requested report is ready.',privateMode:false,
 scope:{principalId:'owner-1',projectId:'project-1'},...overrides,
});
function fixture(){
 let ledger:OfficeReportLedger={version:1,revision:0,entries:[]};
 let idle=true,failWrite=false;
 const spoken:Array<{text:string;signal:AbortSignal;key:string}>=[];
 const notifications:unknown[]=[];
 let speech:(...args:Parameters<OfficeReportAdapters['speak']>)=>Promise<SpeechAcknowledgment>=async()=>({status:'completed'});
 const adapters:OfficeReportAdapters={
  readLedger:async()=>structuredClone(ledger),
  writeLedger:async(next,expected)=>{
   if(failWrite)throw Error('fake persistence failure');
   if(ledger.revision!==expected)return false;
   ledger=structuredClone(next);return true;
  },
  isIdle:()=>idle,
  speak:async(text,delivery)=>{spoken.push({text,signal:delivery.signal,key:delivery.key});return speech(text,delivery);},
  notify:async entry=>{notifications.push(structuredClone(entry));},
 };
 return {adapters,spoken,notifications,ledger:()=>structuredClone(ledger),idle:(value:boolean)=>{idle=value;},
  failWrite:(value:boolean)=>{failWrite=value;},speech:(callback:typeof speech)=>{speech=callback;}};
}

await test('terminal report waits for idle and durable claim precedes actual completion ACK',async()=>{
 const f=fixture(),ack=deferred<SpeechAcknowledgment>();
 f.idle(false);f.speech(async()=>ack.promise);
 const q=new OfficeReportQueue(f.adapters);await q.enqueue(report());await q.drain();
 assert.equal(f.spoken.length,0);assert.equal(f.ledger().entries[0].state,'queued');
 f.idle(true);const draining=q.drain();await tick();
 assert.equal(f.spoken.length,1);assert.equal(f.ledger().entries[0].state,'claimed');
 ack.resolve({status:'completed'});await draining;
 assert.equal(f.ledger().entries[0].state,'delivered');
});

await test('wrong-scope report waits unclaimed without blocking eligible reports, then delivers on switch back',async()=>{
 const f=fixture();let project='project-2';
 f.adapters.canDeliver=value=>value.scope.projectId===project;
 const q=new OfficeReportQueue(f.adapters);
 await q.enqueue(report());
 await q.enqueue(report({taskId:'project-2-task',summary:'Project two report.',scope:{principalId:'owner-1',projectId:'project-2'}}));
 await q.drain();
 assert.equal(f.spoken.length,1);assert.match(f.spoken[0].text,/Project two report/);
 assert.equal(f.ledger().entries[0].state,'queued');assert.equal(f.ledger().entries[0].token,undefined);
 assert.equal(f.ledger().entries[1].state,'delivered');
 project='project-1';await q.drain();await q.drain();
 assert.equal(f.spoken.length,2);assert.match(f.spoken[1].text,/The requested report is ready/);
 assert.equal(f.ledger().entries[0].state,'delivered');
});

await test('scope lost during durable claim is requeued before audio, then delivered on switch back',async()=>{
 const f=fixture(),write=f.adapters.writeLedger;let project='project-1',switchDuringClaim=true;
 f.adapters.canDeliver=value=>value.scope.projectId===project;
 f.adapters.writeLedger=async(next,expected)=>{
  const written=await write(next,expected);
  if(written&&switchDuringClaim&&next.entries.some(entry=>entry.state==='claimed')){
   switchDuringClaim=false;project='project-2';
  }
  return written;
 };
 const q=new OfficeReportQueue(f.adapters);await q.enqueue(report());await q.drain();
 assert.equal(f.spoken.length,0,'Losing scope after claim must still prevent audio');
 assert.equal(f.ledger().entries[0].state,'queued');assert.equal(f.ledger().entries[0].token,undefined);
 project='project-1';await q.drain();await q.drain();
 assert.equal(f.spoken.length,1);assert.equal(f.ledger().entries[0].state,'delivered');
});

await test('attempt identity, not text, deduplicates duplicates and separates retries',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters);
 assert.equal(await q.enqueue(report()),true);
 assert.equal(await q.enqueue(report({summary:'Changed provider prose cannot create another delivery.'})),false);
 await q.enqueue(report({retrySequence:1}));await q.enqueue(report({missionId:'mission-2'}));
 await q.enqueue(report({taskId:'task-2'}));await Promise.all([q.drain(),q.drain()]);
 assert.equal(f.spoken.length,4);assert.equal(new Set(f.spoken.map(s=>s.key)).size,4);
 assert(f.spoken.every(s=>!s.text.includes('Changed provider prose')));
});

await test('private summaries are neither spoken nor copied to ledger/notifications',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters),secret='PRIVATE MAIL CONTENT';
 await q.enqueue(report({summary:secret,privateMode:true}));await q.drain();
 assert.equal(f.spoken.length,0);assert.equal(f.ledger().entries[0].state,'private_skipped');
 assert(!JSON.stringify(f.ledger()).includes(secret));assert(!JSON.stringify(f.notifications).includes(secret));
});

await test('untrusted prose, nonterminal status and invalid attempt identities are rejected',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters);
 for(const invalid of [{source:'provider_prose'},{status:'working'},{retrySequence:-1},{privateMode:undefined},{missionId:''}]){
  await assert.rejects(()=>q.enqueue({...report(),...invalid} as OfficeTerminalReport));
 }
 assert.equal(f.ledger().entries.length,0);assert.equal(f.spoken.length,0);
});

await test('failed or blocked task status is narrated honestly rather than as completion',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters);
 await q.enqueue(report({status:'failed',summary:'The check failed.'}));
 await q.enqueue(report({taskId:'blocked-task',status:'blocked',summary:'Needs a decision.'}));await q.drain();
 assert.match(f.spoken[0].text,/failed/i);assert.match(f.spoken[1].text,/blocked/i);
 assert(f.ledger().entries.every(e=>e.state==='delivered'),'Speech delivery is separate from task completion');
});

await test('Stop cancels durable queued reports, including after restart',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters);f.idle(false);
 await q.enqueue(report());await q.enqueue(report({taskId:'task-2'}));await q.stop();
 f.idle(true);await q.drain();await new OfficeReportQueue(f.adapters).drain();
 assert.equal(f.spoken.length,0);assert(f.ledger().entries.every(e=>e.state==='cancelled'));
});

await test('Stop aborts in-flight token; late completion cannot mark delivered or replay',async()=>{
 const f=fixture(),ack=deferred<SpeechAcknowledgment>();f.speech(async()=>ack.promise);
 const q=new OfficeReportQueue(f.adapters);await q.enqueue(report());const draining=q.drain();await tick();
 assert.equal(f.spoken.length,1);await q.stop();await draining;
 assert.equal(f.spoken[0].signal.aborted,true);assert.equal(f.ledger().entries[0].state,'interrupted');
 ack.resolve({status:'completed'});await tick();await new OfficeReportQueue(f.adapters).drain();
 assert.equal(f.spoken.length,1);assert.equal(f.ledger().entries[0].state,'interrupted');
});

await test('restart recovers a claimed unknown sound as interrupted, never reannounces it',async()=>{
 const f=fixture(),ack=deferred<SpeechAcknowledgment>();f.speech(async()=>ack.promise);
 const old=new OfficeReportQueue(f.adapters);await old.enqueue(report());const draining=old.drain();await tick();
 await new OfficeReportQueue(f.adapters).drain();
 assert.equal(f.spoken.length,1);assert.equal(f.ledger().entries[0].state,'interrupted');
 assert.match(f.ledger().entries[0].note??'',/not.*acknowledged|unknown/i);
 ack.resolve({status:'completed'});await draining;
 assert.equal(f.ledger().entries[0].state,'interrupted','Old ACK cannot overwrite recovered ownership');
});

await test('speech failure/interruption and missing actual ACK are not delivery completion',async()=>{
 for(const outcome of ['reject','interrupted','missing'] as const){
  const f=fixture(),q=new OfficeReportQueue(f.adapters);
  f.speech(async()=>{if(outcome==='reject')throw Error('fake TTS failure');if(outcome==='missing')return undefined as unknown as SpeechAcknowledgment;return {status:'interrupted'};});
  await q.enqueue(report());await q.drain();await new OfficeReportQueue(f.adapters).drain();
  assert.equal(f.spoken.length,1);assert.equal(f.ledger().entries[0].state,outcome==='interrupted'?'interrupted':'failed');
 }
});

await test('idle lost while persisting claim defers speech without interrupting foreground',async()=>{
 const f=fixture(),baseWrite=f.adapters.writeLedger;
 f.adapters.writeLedger=async(next,expected)=>{const written=await baseWrite(next,expected);if(next.entries.some(e=>e.state==='claimed'))f.idle(false);return written;};
 const q=new OfficeReportQueue(f.adapters);await q.enqueue(report());await q.drain();
 assert.equal(f.spoken.length,0);assert.equal(f.ledger().entries[0].state,'queued');
 f.adapters.writeLedger=baseWrite;f.idle(true);await q.drain();assert.equal(f.spoken.length,1);
});

await test('failed durable claim prevents TTS entirely',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters);await q.enqueue(report());f.failWrite(true);
 await assert.rejects(()=>q.drain());assert.equal(f.spoken.length,0);
});

await test('concurrent enqueues preserve both identities and Stop during storage cancels pending enqueue',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters);
 await Promise.all([q.enqueue(report()),q.enqueue(report({taskId:'task-2'}))]);
 const stopping=q.stop();const enqueuing=q.enqueue(report({taskId:'task-3'}));await Promise.all([stopping,enqueuing]);
 await new OfficeReportQueue(f.adapters).drain();assert.equal(f.spoken.length,0);
 assert.equal(f.ledger().entries.length,3);assert(f.ledger().entries.every(e=>e.state==='cancelled'));
});

await test('caller mutation cannot change queued identity, scope or trusted summary',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters),input=report();
 const enqueued=q.enqueue(input);input.summary='MUTATED';input.scope.principalId='another-owner';await enqueued;await q.drain();
 assert(!f.spoken[0].text.includes('MUTATED'));assert.equal(f.ledger().entries[0].report.scope.principalId,'owner-1');
});

await test('Stop while claim write is outstanding prevents audio after persistence resolves',async()=>{
 const f=fixture(),entered=deferred<void>(),release=deferred<void>(),write=f.adapters.writeLedger;
 f.adapters.writeLedger=async(next,expected)=>{
  if(next.entries.some(e=>e.state==='claimed')){entered.resolve(undefined);await release.promise;}
  return write(next,expected);
 };
 const q=new OfficeReportQueue(f.adapters);await q.enqueue(report());const draining=q.drain();await entered.promise;
 const stopping=q.stop();release.resolve(undefined);await Promise.all([stopping,draining]);
 assert.equal(f.spoken.length,0);assert.equal(f.ledger().entries[0].state,'interrupted');
});

await test('CAS failure is bounded and never starts an unclaimed sound',async()=>{
 const f=fixture(),q=new OfficeReportQueue(f.adapters);await q.enqueue(report());let attempts=0;
 f.adapters.writeLedger=async()=>{attempts++;return false;};
 await assert.rejects(()=>q.drain(),/changed concurrently/);assert.equal(attempts,3);assert.equal(f.spoken.length,0);
});

await test('notification failure cannot turn acknowledged speech into a replay',async()=>{
 const f=fixture();f.adapters.notify=async()=>{throw Error('fake UI failure');};
 const q=new OfficeReportQueue(f.adapters);await q.enqueue(report());await q.drain();await tick();
 const restart=new OfficeReportQueue(f.adapters);assert.equal(await restart.enqueue(report()),false);await restart.drain();
 assert.equal(f.spoken.length,1);assert.equal(f.ledger().entries[0].state,'delivered');
});

await test('a duplicate persisted result becoming private suppresses queued or in-flight delivery',async()=>{
 for(const started of [false,true]){
  const f=fixture(),ack=deferred<SpeechAcknowledgment>(),q=new OfficeReportQueue(f.adapters);
  f.speech(async()=>ack.promise);await q.enqueue(report());
  const draining=started?q.drain():Promise.resolve();if(started)await tick();
  assert.equal(await q.enqueue(report({privateMode:true,summary:'PRIVATE UPDATE'})),false);
  ack.resolve({status:'completed'});await draining;await q.drain();
  assert.equal(f.spoken.length,started?1:0);assert.equal(f.ledger().entries[0].report.summary,'');
  assert.equal(f.ledger().entries[0].state,started?'interrupted':'private_skipped');
  if(started)assert.equal(f.spoken[0].signal.aborted,true);
 }
});

await test('private update during a pending claim write fences audio before privacy write completes',async()=>{
 const f=fixture(),entered=deferred<void>(),release=deferred<void>(),write=f.adapters.writeLedger;
 f.adapters.writeLedger=async(next,expected)=>{
  if(next.entries.some(e=>e.state==='claimed')){entered.resolve(undefined);await release.promise;}
  return write(next,expected);
 };
 const q=new OfficeReportQueue(f.adapters);await q.enqueue(report());const draining=q.drain();await entered.promise;
 const privateUpdate=q.enqueue(report({privateMode:true,summary:'PRIVATE NOW'}));
 release.resolve(undefined);await Promise.all([privateUpdate,draining]);
 assert.equal(f.spoken.length,0,'A known privacy restriction must fence speech synchronously, not wait behind the claim write');
 assert.equal(f.ledger().entries[0].report.summary,'');
});
