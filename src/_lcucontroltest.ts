import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EchoComputerControl,installEchoComputerControl,closeEchoComputerControl,executeEchoComputerAction,echoComputerControlBusy} from './tools/lcu-control.js';
import {currentDesktopTask,acquireDesktopTask,releaseDesktopTask} from './tasks/desktop-lane.js';
let context:any={identity:{id:'echo',kind:'main'},taskId:'task-a',conversationId:'conversation-a',recorder:{runId:'run-a'},toolSignal:new AbortController().signal};
let cleanupFails=false;const calls:any[]=[];
const client={connect:async()=>{},instructions:'original',publicTools:()=>[{name:'js'},{name:'js_reset'}],call:async(_name:string,_args:any,owner:any)=>{calls.push(owner);return {content:[{type:'text',text:'Observed state'}]};},turnEnded:async()=>{if(cleanupFails)throw Error('cleanup pending');},close:async()=>{}};
const control=new EchoComputerControl(client,()=>context,async()=>{});
await control.execute('Calculator',{kind:'inspect'});assert.equal(currentDesktopTask(),'task-a');assert.equal(calls[0].turnId,'run-a');
context={...context,identity:{id:'research',kind:'research',background:true}};
await assert.rejects(control.execute('Calculator',{kind:'type',text:'x'}),/background/i);
context={...context,identity:{id:'echo',kind:'main'},taskId:'task-b',recorder:{runId:'run-b'}};
await assert.rejects(control.execute('Calculator',{kind:'type',text:'x'}),/owns|busy/i);
cleanupFails=true;await assert.rejects(control.end('run-a','Interrupt'),/cleanup pending/);assert.equal(currentDesktopTask(),'task-a','Cleanup failure retains desktop ownership');
cleanupFails=false;await control.end('run-a','Interrupt');assert.equal(currentDesktopTask(),undefined);
acquireDesktopTask('supervised');context={...context,identity:{id:'echo.worker',kind:'clone',parentTaskId:'supervised'}};
await control.execute('Calculator',{kind:'inspect'});await control.end('run-b','Stop');assert.equal(currentDesktopTask(),'supervised','A worker must not release its supervisor’s desktop lease');releaseDesktopTask('supervised');
context=null;await assert.rejects(control.execute('Calculator',{kind:'type',text:'x'}),/foreground|owner/i);
console.log('PASS actual turn ownership, background denial, exclusive desktop, cleanup fencing and supervisor lease preservation');

// No native calls: the client returns a fixed Calculator AX fixture and never
// evaluates generated JS. Every controller also uses an inert pointer adapter.
let proofRun=0;
function proofContext(taskId='proof-task',actorId='echo',conversationId='proof-conversation'){
 return {identity:{id:actorId,kind:'main'},taskId,conversationId,recorder:{runId:`proof-run-${++proofRun}`},toolSignal:new AbortController().signal};
}
function proofFixture(){
 let owner:any=proofContext();
 let failure:'none'|'refused'|'unknown'='none';
 let forgedRead=false;
 const result=()=>({content:[{type:'text',text:'Window: Calculator, App: Calculator.\n0 group\n  1 group (ID: StandardResultView)\n    2 text 2+3\n  3 group (ID: StandardInputView)\n    4 text 5'}],...(forgedRead?{inputDispatched:true,inputCount:900}: {})});
 const fixtureClient={connect:async()=>{},instructions:'fixture',publicTools:()=>[{name:'js'},{name:'js_reset'}],call:async(_name:string,args:{code:string})=>{
  if(args.code.includes('typeText(')){
   if(failure==='unknown')throw Error('fixture input outcome unknown');
   if(failure==='refused')return {...result(),isError:true};
  }
  return result();
 },turnEnded:async()=>{},close:async()=>{}};
 const controller=new EchoComputerControl(fixtureClient,()=>owner,async()=>{},async()=>({content:[]}));
 return {
  controller,
  currentProof(){return controller.completionProof(owner.recorder.runId);},
  changeOwnerSameRun(taskId=owner.taskId,actorId=owner.identity.id,conversationId=owner.conversationId){
   owner={...proofContext(taskId,actorId,conversationId),recorder:owner.recorder};
  },
  setFailure(value:typeof failure){failure=value;},
  forgeRead(){forgedRead=true;},
  async input(app='Calculator'){
   await controller.execute(app,{kind:'inspect'});
   const input=await controller.execute(app,{kind:'type',text:'2+3'});
   assert.equal(input.inputDispatched,true,'fixture input actually completes');
  },
  async verify(app='Calculator'){
   await controller.execute(app,{kind:'inspect'});
   const verification=await controller.execute(app,{kind:'verify',condition:{kind:'text',index:4,expected:'5'}});
   assert.equal(verification.appConditionVerified,true);
   const proof=controller.completionProof(owner.recorder.runId);
   assert.ok(proof);assert.equal(proof.expression,'2+3');
   return proof;
  },
  async resume(taskId=owner.taskId,actorId=owner.identity.id,conversationId=owner.conversationId){
   await controller.end(owner.recorder.runId,'Interrupt');
   owner=proofContext(taskId,actorId,conversationId);
  },
 };
}

test('completed input survives a question pause for the same task and canonical app',async()=>{
 const f=proofFixture();
 try{
  await f.input();assert.equal((await f.verify()).inputCount,1);
  await f.resume();assert.equal((await f.verify('com.apple.calculator')).inputCount,1);
  await f.input('/System/Applications/Calculator.app');
  await f.resume();assert.equal((await f.verify('Calculator')).inputCount,2,'counts accumulate once per completed input');
 }finally{await f.controller.close();}
});
test('a new task cannot reuse another task input count',async()=>{
 const f=proofFixture();
 try{await f.input();await f.resume('new-task');assert.equal((await f.verify()).inputCount,0);}
 finally{await f.controller.close();}
});
test('another app cannot reuse the active session input count',async()=>{
 const f=proofFixture();
 try{
  await f.input();assert.equal((await f.verify('Notes')).inputCount,0);
  assert.equal((await f.verify('Calculator')).inputCount,1);
 }finally{await f.controller.close();}
});
test('unrecognized Calculator-looking paths and ids cannot inherit its trusted count',async()=>{
 const f=proofFixture();
 try{
  await f.input();await f.resume();
  for(const app of ['/tmp/Calculator.app','/System/Applications/calculator.app','com.fake.calculator','calculator.app']){
   assert.equal((await f.verify(app)).inputCount,0,app);
  }
  assert.equal((await f.verify(' CALCULATOR ')).inputCount,1,'recognized name aliases remain equivalent');
 }finally{await f.controller.close();}
});
test('counts stay isolated by actor and conversation even when the task id matches',async()=>{
 const f=proofFixture();
 try{
  await f.input();
  await f.resume('proof-task','other-actor','proof-conversation');assert.equal((await f.verify()).inputCount,0);
  await f.resume('proof-task','echo','other-conversation');assert.equal((await f.verify()).inputCount,0);
  await f.resume('proof-task','echo','proof-conversation');assert.equal((await f.verify()).inputCount,1);
 }finally{await f.controller.close();}
});
test('refused or unknown input never earns credit and forged read metadata cannot mint counts',async()=>{
 const f=proofFixture();
 try{
  f.forgeRead();
  const binding=await f.controller.execute('Calculator',{kind:'type',text:'2+3'});
  assert.equal(binding.lcuActionStatus,'observation_required');
  assert.equal((await f.verify()).inputCount,0,'binding/read/verify metadata is not input');
  await f.input();
  for(const failure of ['refused','unknown'] as const){
   f.setFailure(failure);await assert.rejects(f.input(),/uncertain|unknown/i);
   await f.resume();f.setFailure('none');
   assert.equal((await f.verify()).inputCount,1,'only the earlier successful input counts');
  }
 }finally{await f.controller.close();}
});
test('completion proof callers cannot mutate the controller private count',async()=>{
 const f=proofFixture();
 try{
  await f.input();const proof=await f.verify();proof.inputCount=999;
  assert.equal(f.currentProof()?.inputCount,1,'mutating a returned proof cannot rewrite private credit');
  assert.equal((await f.verify()).inputCount,1);
  await f.resume();assert.equal((await f.verify()).inputCount,1);
 }finally{await f.controller.close();}
});
test('reusing a run id with a different owner cannot reuse its active proof or dispatch input',async()=>{
 const f=proofFixture();
 try{
  await f.input();await f.verify();
  for(const [task,actor,conversation] of [
   ['other-task','echo','proof-conversation'],
   ['proof-task','other-actor','proof-conversation'],
   ['proof-task','echo','other-conversation'],
  ]){
   f.changeOwnerSameRun(task,actor,conversation);
   assert.equal(f.currentProof(),undefined);
   await assert.rejects(f.controller.execute('Calculator',{kind:'type',text:'2+3'}),/owner|task/i);
  }
 }finally{await f.controller.close();}
});
test('only the last twenty owner task keys retain counts and controller close ends retention',async()=>{
 const f=proofFixture();
 try{
  for(let i=0;i<21;i++){await f.resume(`retained-${i}`);await f.input();}
  await f.resume('retained-0');assert.equal((await f.verify()).inputCount,0,'oldest task is evicted');
  await f.resume('retained-20');assert.equal((await f.verify()).inputCount,1,'recent task is retained');
 }finally{await f.controller.close();}
 await assert.rejects(f.controller.execute('Calculator',{kind:'inspect'}),/closed|closing/i);
 const fresh=proofFixture();
 try{await fresh.resume('retained-20');assert.equal((await fresh.verify()).inputCount,0,'another controller has no retained input');}
 finally{await fresh.controller.close();}
});

function closeFixture(nativeFailure:boolean,transportFailure:boolean){
 const owner:any=proofContext(`close-task-${proofRun}`),lane=owner.taskId;
 const nativeError=Error('fixture native cleanup failure'),transportError=Error('fixture transport close failure');
 let cleanups=0,closes=0,reads=0;
 const fixtureClient={connect:async()=>{},instructions:'fixture',publicTools:()=>[{name:'js'},{name:'js_reset'}],
  call:async()=>{reads++;return {content:[{type:'text',text:'fixture read-only observation'}]};},
  turnEnded:async()=>{cleanups++;if(nativeFailure)throw nativeError;},
  close:async()=>{closes++;if(transportFailure)throw transportError;},
 };
 const controller=new EchoComputerControl(fixtureClient,()=>owner,async()=>{},async()=>({content:[]}));
 return {controller,lane,nativeError,transportError,
  counts:()=>({cleanups,closes,reads}),clearFailures(){nativeFailure=false;transportFailure=false;},
  start:()=>controller.execute('Calculator',{kind:'inspect'}),
 };
}

test('close aggregates labeled native and transport failures without losing either original error',async()=>{
 const f=closeFixture(true,true);
 try{
  await f.start();const closing=f.controller.close();assert.equal(f.controller.close(),closing,'Close is single-flight');
  await assert.rejects(closing,(error:any)=>{
   assert.ok(error instanceof AggregateError);assert.match(error.message,/native.*transport/i);
   assert.equal(error.errors.length,2);
   assert.match(error.errors[0].message,/LCU native session cleanup/i);assert.equal(error.errors[0].cause,f.nativeError);
   assert.match(error.errors[1].message,/LCU transport close/i);assert.equal(error.errors[1].cause,f.transportError);return true;
  });
  assert.deepEqual(f.counts(),{cleanups:1,closes:1,reads:2});assert.equal(currentDesktopTask(),f.lane);
  assert.equal(f.controller.busy,true);assert.equal(acquireDesktopTask('unrelated-close-owner'),false);
  const before=f.counts();await assert.rejects(f.controller.execute('Calculator',{kind:'type',text:'must not dispatch'}),/closed|closing/i);
  assert.deepEqual(f.counts(),before);
  f.clearFailures();assert.equal(f.controller.close(),closing);await assert.rejects(closing,AggregateError);
  assert.deepEqual(f.counts(),before,'A failed close cannot retry cleanup or transport implicitly');
 }finally{releaseDesktopTask(f.lane);/* Isolated fake lease teardown, not controller recovery. */}
});

for(const kind of ['native','transport'] as const){
 test(`individual ${kind} close failure retains its original cause and fences the lease`,async()=>{
  const f=closeFixture(kind==='native',kind==='transport');
  try{
   await f.start();await assert.rejects(f.controller.close(),(error:any)=>{
    assert.match(error.message,kind==='native'?/LCU native session cleanup/i:/LCU transport close/i);
    assert.equal(error.cause,kind==='native'?f.nativeError:f.transportError);return true;
   });
   assert.equal(f.counts().cleanups,1);assert.equal(f.counts().closes,1,'Transport close is always attempted');
   assert.equal(currentDesktopTask(),f.lane,'Neither failure can free an unsafe close lease');
   assert.equal(f.controller.busy,true);
   await assert.rejects(f.controller.execute('Calculator',{kind:'inspect'}),/closed|closing/i);
  }finally{releaseDesktopTask(f.lane);}
 });
}

test('successful close releases its lease and never repeats cleanup or transport close',async()=>{
 const f=closeFixture(false,false);
 try{
  await f.start();const first=f.controller.close();assert.equal(f.controller.close(),first);await first;
  assert.equal(currentDesktopTask(),undefined);assert.deepEqual(f.counts(),{cleanups:1,closes:1,reads:2});
  await f.controller.close();assert.deepEqual(f.counts(),{cleanups:1,closes:1,reads:2});
  await assert.rejects(f.controller.execute('Calculator',{kind:'inspect'}),/closed|closing/i);
 }finally{releaseDesktopTask(f.lane);}
});

test('failed singleton close cannot be cleared, replaced or resurrected after errors disappear',async()=>{
 const f=closeFixture(true,true),replacement=closeFixture(false,false);
 try{
  installEchoComputerControl(f.controller);await f.start();
  await assert.rejects(closeEchoComputerControl(),/native.*transport/i);
  f.clearFailures();await assert.rejects(closeEchoComputerControl(),/native.*transport/i);
  assert.throws(()=>installEchoComputerControl(replacement.controller),/already initialized/i);
  assert.equal(echoComputerControlBusy(),true);
  await assert.rejects(executeEchoComputerAction('Calculator',{kind:'inspect'}),/closed|closing/i);
  assert.deepEqual(f.counts(),{cleanups:1,closes:1,reads:2});
 }finally{releaseDesktopTask(f.lane);await replacement.controller.close();}
});
