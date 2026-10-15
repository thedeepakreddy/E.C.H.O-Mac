import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentRunContext} from './agent-replay/context.js';
import type {ToolDef} from './tools/registry.js';

// Real wrapper/coordinator/gate; the provider and all handlers are offline fakes.
const root=mkdtempSync(join(tmpdir(),'echo-agent-wrapper-'));
const environment={ECHO_DATA_ROOT:root,ECHO_MEMORY_ROOT:join(root,'memory'),
 ECHO_MCP:'0',ECHO_LOG_QUIET:'1',ECHO_FULL_LOG:'1',GIT_SHA:'offline-wrapper-fixture'};
const previous=new Map(Object.keys(environment).map(key=>[key,process.env[key]]));
Object.assign(process.env,environment);
const originalFetch=globalThis.fetch;
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('Network forbidden in wrapper fixture');};

try{
 const {DEFAULTS_FOR_TESTS,setActiveConfig}=await import('./config.js');
 const config=structuredClone(DEFAULTS_FOR_TESTS);config.control.workingDir=root;
 setActiveConfig(config);
 const {Brain}=await import('./brain/types.js');
 const {RecordingBrain}=await import('./agent-replay/runtime.js');
 const {currentAgentRunContext,runInAgentContext}=await import('./agent-replay/context.js');
 const {runGated}=await import('./safety/gate.js');
 const {confirmations}=await import('./safety/confirm.js');
 const {taskCoordinator}=await import('./memory/task-state.js');
 const {readRecoveryCheckpoint}=await import('./agent-replay/recovery.js');

 class FakeProvider extends Brain{
  readonly supportsTaskUpdates:boolean;
  contexts:AgentRunContext[]=[];
  queued:Array<{text:string;applied:()=>void;context:AgentRunContext|null}>=[];
  consumed:string[]=[];
  accepts=true;
  constructor(supported=true){super();this.supportsTaskUpdates=supported;}
  send(){this.contexts.push(currentAgentRunContext()!);}
  queueTaskUpdate(text:string,applied:()=>void){
   this.queued.push({text,applied,context:currentAgentRunContext()});
   if(this.accepts)this.taskUpdates.push({text,applied});return this.accepts;
  }
  consume(index=0){const entry=this.queued[index];runInAgentContext(entry.context!,entry.applied);}
  consumeBoundary(){runInAgentContext(this.contexts.at(-1)!,()=>{
   for(const update of this.takeTaskUpdates()){this.consumed.push(update.text);update.applied();}
  });}
  interrupt(){}
  async stop(){}
  finish(){const context=this.contexts.at(-1)!;runInAgentContext(context,()=>{
   context.loop.exit('completed');this.emit('turnEnd');
  });}
 }
 function fixture(supported=true,allowedTools?:ReadonlySet<string>){
  const provider=new FakeProvider(supported);
  const wrapper=new RecordingBrain(provider,'test',{}, {autoResume:false,
   identity:{id:randomUUID(),name:'Offline worker',kind:'clone'},limits:{allowedTools}});
  const start=()=>wrapper.send('Explain an offline fixture.',undefined,{taskId:randomUUID()});
  return {provider,wrapper,start};
 }

 await test('task update capability and provider-consumption ACK survive the wrapper',async()=>{
  const {provider,wrapper,start}=fixture();let applied=0;
  try{
   assert.equal(wrapper.supportsTaskUpdates,true);
   assert.equal(wrapper.queueTaskUpdate('Before a run',()=>applied++),false);
   assert.equal(provider.queued.length,0);
   start();
   assert.equal(wrapper.queueTaskUpdate('Use primary sources',()=>applied++),true);
   assert.equal(provider.queued[0].text,'Use primary sources');
   assert.equal(provider.queued[0].context,provider.contexts[0]);
   assert.equal(applied,0,'Enqueue is not consumption');
   provider.consume();provider.consume();
   assert.equal(applied,1,'Actual consumption acknowledges exactly once');
   assert.deepEqual(readRecoveryCheckpoint(provider.contexts[0].recorder.dir)?.followUpPrompts,
    ['Use primary sources'],'Consumed instructions survive recovery');
  }finally{await wrapper.stop();}
 });

 await test('unsupported or refusing providers never acknowledge an update',async()=>{
  for(const supported of [false,true]){
   const {provider,wrapper,start}=fixture(supported);let applied=0;
   try{
    start();provider.accepts=false;
    assert.equal(wrapper.supportsTaskUpdates,supported);
    assert.equal(wrapper.queueTaskUpdate('Rejected instruction',()=>applied++),false);
    if(provider.queued.length)provider.consume();
    assert.equal(provider.queued.length,supported?1:0);
    assert.equal(applied,0);
   }finally{await wrapper.stop();}
  }
 });

 await test('synchronous consumption ACK waits for the provider acceptance receipt',async()=>{
  for(const accepts of [true,false]){
   const {provider,wrapper,start}=fixture();let applied=0;
   provider.queueTaskUpdate=(_text,consume)=>{consume();assert.equal(applied,0);return accepts;};
   try{start();assert.equal(wrapper.queueTaskUpdate('Inline consumption',()=>applied++),accepts);
    assert.equal(applied,accepts?1:0);
   }finally{await wrapper.stop();}
  }
 });

 await test('consumed GUI task updates retain the existing stream/completion proof guard',async()=>{
  const provider=new FakeProvider();
  const wrapper=new RecordingBrain(provider,'test',{}, {autoResume:false,
   identity:{id:randomUUID(),name:'Offline Echo',kind:'main'}});
  const speech:string[]=[];
  wrapper.on('text',text=>speech.push(text));wrapper.on('textDelta',part=>speech.push(part.text));
  try{
   wrapper.send('Explain an offline concept.',undefined,{taskId:randomUUID()});
   assert.equal(wrapper.queueTaskUpdate('Open Calculator and calculate 2 plus 3.',()=>{}),true);
   provider.consume();
   runInAgentContext(provider.contexts[0],()=>{
    provider.emit('textDelta',{text:'I launched Calculator; the result is 5.'});
    provider.emit('text','I launched Calculator; the result is 5.');provider.finish();
   });
   assert(!speech.some(text=>text.includes('I launched Calculator')||text.includes('the result is 5')));
   assert.notEqual(taskCoordinator.get(provider.contexts[0].taskId)!.status,'completed');
  }finally{await wrapper.stop();}
 });

 for(const fence of ['interrupt','stop','successor','foreign-owner'] as const)
  await test(`queued updates and late ACKs are fenced by ${fence}`,async()=>{
   const {provider,wrapper,start}=fixture();const other=fixture();let applied=0;
   try{
    start();
    assert.equal(wrapper.queueTaskUpdate('Old instruction',()=>applied++),true);
    if(fence==='interrupt')wrapper.interrupt();
    if(fence==='stop')await wrapper.stop();
    if(fence==='successor'){provider.finish();start();}
    if(fence==='foreign-owner'){
     other.start();
     runInAgentContext(other.provider.contexts[0],()=>{
      assert.equal(wrapper.queueTaskUpdate('Wrong owner',()=>applied++),false);
      provider.queued[0].applied();
     });
    }else{
     assert.equal(wrapper.queueTaskUpdate('After fence',()=>applied++),fence==='successor');
     provider.consume();
    }
    assert.equal(applied,0,'An obsolete/foreign callback cannot grant applied authority');
   }finally{await wrapper.stop();await other.wrapper.stop();}
  });

 for(const fence of ['interrupt','stop','successor','generation'] as const)
  await test(`provider-boundary consumption drops instructions fenced by ${fence}`,async()=>{
   const {provider,wrapper,start}=fixture();let applied=0;
   try{
    start();assert.equal(wrapper.queueTaskUpdate('Obsolete instruction',()=>applied++),true);
    if(fence==='interrupt')wrapper.interrupt();
    if(fence==='stop')await wrapper.stop();
    if(fence==='successor')provider.finish();
    if(fence==='generation')taskCoordinator.cancel(provider.contexts[0].taskId);
    else start();
    provider.consumeBoundary();
    assert.deepEqual(provider.consumed,[],'A late instruction must not reach a different model run');
    assert.equal(applied,0);
    if(fence!=='generation'){
     assert.equal(wrapper.queueTaskUpdate('Current instruction',()=>applied++),true);
     provider.consumeBoundary();assert.deepEqual(provider.consumed,['Current instruction']);
     assert.equal(applied,1,'A valid successor update still reaches the model boundary');
    }
   }finally{await wrapper.stop();}
  });

 function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};
 }
 function telemetry(wrapper:InstanceType<typeof RecordingBrain>){
  const starts:any[]=[],ends:any[]=[];
  wrapper.on('tool',info=>starts.push(info));wrapper.on('toolEnd',info=>ends.push(info));
  return {starts,ends};
 }
 function gated(provider:FakeProvider,def:ToolDef,args:Record<string,unknown>={}){
  return runInAgentContext(provider.contexts.at(-1)!,()=>runGated(def,args,
   {workingDir:root,emit:(event,payload)=>provider.emit(event,payload)}));
 }
 function identity(context:AgentRunContext,callId:string){return {
  taskId:context.taskId,actorId:context.identity.id,runId:context.recorder.runId,callId,
 };}
 function assertPair(context:AgentRunContext,start:any,end:any){
  assert.equal(typeof start.callId,'string','An actual call must have a stable ID');
  assert.ok(start.callId);
  for(const field of ['taskId','actorId','runId','callId']){
   assert.equal(start[field],identity(context,start.callId)[field as keyof ReturnType<typeof identity>]);
   assert.equal(end[field],start[field],`${field} must survive the same call's end`);
  }
  assert.equal(end.name,start.name);
 }

 await test('wrapper stamps actual emitting context and forwards toolEnd',async()=>{
  const own=fixture(),other=fixture();const {starts,ends}=telemetry(own.wrapper);
  try{
   own.start();other.start();const context=own.provider.contexts[0];
   const forged={name:'fixture_read',summary:'Fake provider event',taskId:'forged',
    actorId:'forged',runId:'forged',callId:'provider-call'};
   runInAgentContext(context,()=>{
    own.provider.emit('tool',forged);own.provider.emit('toolEnd',forged);
   });
   assert.equal(starts.length,1);assert.equal(ends.length,1);
   assertPair(context,starts[0],ends[0]);
   runInAgentContext(other.provider.contexts[0],()=>own.provider.emit('tool',forged));
   assert.equal(starts.length,1,'Another worker context cannot impersonate this wrapper');
  }finally{await own.wrapper.stop();await other.wrapper.stop();}
 });

 for(const approved of [false,true])await test(`gate activity waits for confirmation (${approved?'approval':'denial'})`,async()=>{
  const {provider,wrapper,start}=fixture();const {starts,ends}=telemetry(wrapper);
  const asked=deferred<{id:string}>(),entered=deferred<void>(),release=deferred<void>();
  const ask=(request:{id:string})=>asked.resolve(request);
  let handlers=0;
  const def:ToolDef={name:'fixture_send_message',description:'Fake only',schema:{},readOnly:false,
   handler:async()=>{
    handlers++;assert.equal(starts.length,1,'Start immediately precedes the actual handler');
    const invocationCalls=Object.values(taskCoordinator.get(provider.contexts[0].taskId)!.calls);
    assert.equal(starts[0].callId,invocationCalls.at(-1)!.callId);
    entered.resolve();await release.promise;return {text:'Fake sent',status:'success'};
   }};
  let pending:ReturnType<typeof gated>|undefined;
  confirmations.on('ask',ask);
  try{
   start();pending=gated(provider,def,{request:randomUUID()});
   const request=await asked.promise;
   assert.equal(starts.length,0,'A pending confirmation is not tool execution');
   assert.equal(handlers,0);assert.equal(ends.length,0);
   confirmations.settle(request.id,approved,'offline fixture');
   if(approved){await entered.promise;assert.equal(ends.length,0);release.resolve();}
   const out=await pending;
   assert.equal(out.status,approved?'success':'denied');
   assert.equal(handlers,approved?1:0);
   assert.equal(starts.length,approved?1:0);
   if(approved){assert.equal(ends.length,1);assertPair(provider.contexts[0],starts[0],ends[0]);}
  }finally{
   confirmations.off('ask',ask);confirmations.settle(null,false,'fixture cleanup');
   release.resolve();if(pending)await pending;await wrapper.stop();
  }
 });

 await test('invalid arguments and ungranted calls never advertise active execution',async()=>{
  const {provider,wrapper,start}=fixture(true,new Set(['fixture_read']));
  const {starts}=telemetry(wrapper);let handlers=0;
  const def:ToolDef={name:'fixture_read',description:'Fake only',schema:{},readOnly:true,
   validateInput:()=> 'Deliberate fixture rejection',handler:async()=>{handlers++;return {text:'fake'};}};
  try{
   start();assert.equal((await gated(provider,def)).status,'failed');
   assert.equal((await gated(provider,{...def,name:'fixture_other'})).status,'denied');
   assert.equal(handlers,0);assert.deepEqual(starts,[]);
  }finally{await wrapper.stop();}
 });

 await test('parallel identical tool names retain distinct paired call identities',async()=>{
  const {provider,wrapper,start}=fixture();const {starts,ends}=telemetry(wrapper);
  const entered=[deferred<void>(),deferred<void>()],release=[deferred<void>(),deferred<void>()];
  const def:ToolDef={name:'fixture_get_item',description:'Fake only',schema:{},readOnly:true,
   handler:async(args)=>{entered[args.index].resolve();await release[args.index].promise;return {text:`Fake ${args.index}`};}};
  let first:ReturnType<typeof gated>|undefined,second:ReturnType<typeof gated>|undefined;
  try{
   start();first=gated(provider,def,{index:0});second=gated(provider,def,{index:1});
   await Promise.all(entered.map(item=>item.promise));
   assert.equal(starts.length,2);assert.notEqual(starts[0].callId,starts[1].callId);
   assert.equal(ends.length,0);
   release[1].resolve();await second;release[0].resolve();await first;
   assert.equal(ends.length,2);
   for(const end of ends)assertPair(provider.contexts[0],starts.find(item=>item.callId===end.callId),end);
  }finally{for(const item of release)item.resolve();await Promise.all([first,second]);await wrapper.stop();}
 });

 await test('saved observations are reused without emitting a second execution start',async()=>{
  const {provider,wrapper,start}=fixture();const {starts,ends}=telemetry(wrapper);let handlers=0;
  const def:ToolDef={name:'fixture_get_cached',description:'Fake only',schema:{},readOnly:true,
   handler:async()=>{handlers++;return {text:'Fake observation'};}};
  try{
   start();assert.equal((await gated(provider,def)).status,'success');
   assert.equal((await gated(provider,def)).status,'success');
   assert.equal(handlers,1);assert.equal(starts.length,1);
   assertPair(provider.contexts[0],starts[0],ends.find(item=>item.callId===starts[0].callId));
  }finally{await wrapper.stop();}
 });

 await test('handler failure still closes the same actual execution',async()=>{
  const {provider,wrapper,start}=fixture();const {starts,ends}=telemetry(wrapper);
  const def:ToolDef={name:'fixture_get_failure',description:'Fake only',schema:{},readOnly:true,
   handler:async()=>{throw Error('Offline handler failed');}};
  try{
   start();assert.equal((await gated(provider,def)).status,'failed');
   assert.equal(starts.length,1);assert.equal(ends.length,1);
   assertPair(provider.contexts[0],starts[0],ends[0]);
  }finally{await wrapper.stop();}
 });

 await test('approval cannot revive an interrupted run or start its handler',async()=>{
  const {provider,wrapper,start}=fixture();const {starts}=telemetry(wrapper);
  const asked=deferred<{id:string}>();let handlers=0;
  const def:ToolDef={name:'fixture_send_cancelled',description:'Fake only',schema:{},readOnly:false,
   handler:async()=>{handlers++;return {text:'Must not dispatch'};}};
  const ask=(request:{id:string})=>asked.resolve(request);
  let pending:ReturnType<typeof gated>|undefined;
  confirmations.on('ask',ask);
  try{
   start();pending=gated(provider,def);const request=await asked.promise;
   wrapper.interrupt();confirmations.settle(request.id,true,'late offline approval');
   const out=await pending;assert.notEqual(out.status,'success');
   assert.equal(handlers,0);assert.deepEqual(starts,[]);
  }finally{confirmations.off('ask',ask);confirmations.settle(null,false);if(pending)await pending;await wrapper.stop();}
 });

 await test('a resource-denied call never claims handler activity',async()=>{
  const own=fixture(),other=fixture();const ownEvents=telemetry(own.wrapper),otherEvents=telemetry(other.wrapper);
  const entered=deferred<void>(),release=deferred<void>();let handlers=0;
  // The real lease uses file:<absolute-path>; this fake never writes it.
  const def:ToolDef={name:'write_local_file',description:'Fake only',schema:{},readOnly:false,
   handler:async()=>{handlers++;entered.resolve();await release.promise;return {text:'Fake write'};}};
  let pending:ReturnType<typeof gated>|undefined;
  try{
   own.start();other.start();const args={path:join(root,'lease-fixture'),content:'Fake only'};
   pending=gated(own.provider,def,args);await entered.promise;
   assert.equal((await gated(other.provider,def,args)).status,'denied');
   assert.equal(handlers,1);assert.deepEqual(otherEvents.starts,[]);
   release.resolve();await pending;
   assertPair(own.provider.contexts[0],ownEvents.starts[0],ownEvents.ends[0]);
  }finally{release.resolve();if(pending)await pending;await own.wrapper.stop();await other.wrapper.stop();}
 });

 await test('an old handler end retains its old run after successor handoff',async()=>{
  const {provider,wrapper,start}=fixture();const {starts,ends}=telemetry(wrapper);
  const entered=deferred<void>(),release=deferred<void>();
  const def:ToolDef={name:'fixture_get_draining',description:'Fake only',schema:{},readOnly:true,
   handler:async()=>{entered.resolve();await release.promise;return {text:'Old fake result'};}};
  let pending:ReturnType<typeof gated>|undefined;
  try{
   start();const old=provider.contexts[0];pending=gated(provider,def);await entered.promise;
   wrapper.interrupt();start();assert.notEqual(provider.contexts[1].recorder.runId,old.recorder.runId);
   release.resolve();await pending;
   assert.equal(starts.length,1);assert.equal(ends.length,1);assertPair(old,starts[0],ends[0]);
  }finally{release.resolve();if(pending)await pending;await wrapper.stop();}
 });

 await test('a context-free real gate still pairs unique execution IDs',async()=>{
  const events:Array<{event:string;info:any}>=[];
  const def:ToolDef={name:'fixture_get_unowned',description:'Fake only',schema:{},readOnly:true,
   handler:async()=>({text:'Offline standalone result'})};
  const out=await runGated(def,{}, {workingDir:root,emit:(event,info)=>events.push({event,info})});
  assert.equal(out.status,'success');
  const begin=events.find(item=>item.event==='tool')!.info,end=events.find(item=>item.event==='toolEnd')!.info;
  assert.equal(typeof begin.callId,'string');assert.equal(end.callId,begin.callId);
 });

 assert.equal(networkAttempts,0);
}finally{
 globalThis.fetch=originalFetch;
 for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 rmSync(root,{recursive:true,force:true});
}
