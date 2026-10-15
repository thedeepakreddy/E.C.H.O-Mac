import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Offline boundary fixtures only: real provider/wrapper/gate, fake Responses
// transport and injected SDK query. No LCU client or native input is installed.
const root=mkdtempSync(join(tmpdir(),'echo-gui-pause-race-'));
const originalFetch=globalThis.fetch;
const environment={ECHO_DATA_ROOT:root,ECHO_MEMORY_ROOT:join(root,'memory'),
 ECHO_MCP:'0',ECHO_LOG_QUIET:'1',ECHO_FULL_LOG:'1',GIT_SHA:'offline-pause-fixture'};
const previousEnvironment=new Map(Object.keys(environment).map(key=>[key,process.env[key]]));
Object.assign(process.env,environment);
let forbiddenFetches=0;
const denyFetch:typeof fetch=async()=>{forbiddenFetches++;throw Error('Network forbidden in GUI pause fixtures');};
globalThis.fetch=denyFetch;

function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
async function bounded<T>(promise:Promise<T>,label:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(Error(`Timed out: ${label}`)),3000);
 })]);}finally{clearTimeout(timer);}
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function sse(output:unknown[]):Response{
 return new Response(`data: ${JSON.stringify({type:'response.completed',response:{output}})}\n\n`,
  {headers:{'content-type':'text/event-stream'}});
}
const textResponse=()=>sse([{type:'message',role:'assistant',content:[{type:'output_text',text:'Offline reply; no native result was verified.'}]}]);

try{
 const {RecordingBrain}=await import('./agent-replay/runtime.js');
 const {OpenAIBrain}=await import('./brain/openai.js');
 const {ClaudeBrain}=await import('./brain/claude.js');
 const {Brain}=await import('./brain/types.js');
 const {DEFAULTS_FOR_TESTS}=await import('./config.js');
 const {currentAgentRunContext,runInAgentContext}=await import('./agent-replay/context.js');
 const {taskCoordinator}=await import('./memory/task-state.js');
 const {TOOL_MAP}=await import('./tools/registry.js');
 const {runGated}=await import('./safety/gate.js');
 const calculation='Open Calculator and calculate 2 plus 3.';
 const question='Which mode should I use in the app?';
 const grants=new Set(['ask_app_question']);
 const failures:string[]=[];

 async function openAIRace(delayedAck:boolean){
  const ack=deferred<void>(),oldDrained=deferred<void>(),secondRequested=deferred<void>();
  const secondResponse=deferred<Response>(),secondDrained=deferred<void>();
  const requests:any[]=[];
  const signals:Array<AbortSignal|undefined>=[];
  const errors:string[]=[];
  let providerEnds=0,asked=0,originalTask:string|undefined;
  const endpoint={url:'https://offline.invalid/responses',label:'offline-pause-fixture'};
  class DelayedAckOpenAI extends OpenAIBrain{
   // Hold only the interrupt acknowledgment; the real Responses loop still
   // drains normally, so resuming before this promise settles is a real bug.
   pauseForInput():Promise<void>{this.interrupt();return ack.promise;}
  }
  const cfg=structuredClone(DEFAULTS_FOR_TESTS);
  cfg.control.workingDir=root;
  const provider=delayedAck
   ?new DelayedAckOpenAI(cfg,{via:'apiKey',key:'offline-fixture'},{allowedTools:grants},endpoint)
   :new OpenAIBrain(cfg,{via:'apiKey',key:'offline-fixture'},{allowedTools:grants},endpoint);
  const brain=new RecordingBrain(provider,'test',{}, {autoResume:false});
  brain.on('error',error=>errors.push(String(error)));
  provider.on('turnEnd',()=>{
   providerEnds++;
   if(providerEnds===1)oldDrained.resolve(undefined);
   else secondDrained.resolve(undefined);
  });
  brain.on('text',text=>{
   if(text!==question)return;
   asked++;originalTask=brain.currentTaskId;
   // Cover both the original microtask repro and reentrant host speech. The
   // latter must not abort the successor's controller or discard its answer.
   if(delayedAck)brain.send('Basic mode');
   else queueMicrotask(()=>brain.send('Basic mode'));
  });
  globalThis.fetch=(async(input,init)=>{
   if(String(input)!==endpoint.url)return denyFetch(input,init);
   const request=JSON.parse(String(init?.body));requests.push(request);
   signals.push(currentAgentRunContext()?.toolSignal);
   if(requests.length===1)return sse([{type:'function_call',name:'ask_app_question',
    call_id:'offline-pause-question',arguments:'{"subject":"mode"}'}]);
   if(requests.length===2){secondRequested.resolve(undefined);return secondResponse.promise;}
   throw Error('Unexpected extra fake Responses request');
  }) as typeof fetch;
  try{
   brain.send(calculation);
   await bounded(oldDrained.promise,'original OpenAI provider drain');
   if(delayedAck){
    await tick();
    assert.equal(requests.length,1,'A synchronous answer must remain queued until interrupt acknowledgment');
    assert.equal(taskCoordinator.get(originalTask!)!.status,'waiting');
    ack.resolve(undefined);
   }
   await bounded(secondRequested.promise,'resumed fake Responses request');
   assert.equal(asked,1,'The host asks once');
   assert.equal(brain.currentTaskId,originalTask,'An answer resumes the same goal/task');
   assert.equal(taskCoordinator.get(originalTask!)!.status,'running',
    'The original turnEnd must not terminate the resumed task while its response is pending');
   assert.equal(signals[0]?.aborted,true,'Pause cancels the original invocation signal');
   assert.equal(signals[1]?.aborted,false,'Pause must not cancel the successor invocation signal');
   assert.match(JSON.stringify(requests[1].input),/Basic mode/,'The answer reaches the resumed request');
   assert.match(JSON.stringify(requests[1].input),/Open Calculator and calculate 2 plus 3/,'The original app goal is retained');
   assert.deepEqual(errors,[],'An old completion cannot surface a failure for the successor');
   secondResponse.resolve(textResponse());
   await bounded(secondDrained.promise,'resumed OpenAI provider drain');
   await tick();
   assert.equal(requests.length,2,'No duplicate model continuation');
   assert.notEqual(taskCoordinator.get(originalTask!)!.status,'completed','Text-only continuation is still not native proof');
  }finally{
   ack.resolve(undefined);secondResponse.resolve(textResponse());
   await tick();await brain.stop();
   if(requests.length>1)await bounded(secondDrained.promise,'OpenAI fixture cleanup');
   globalThis.fetch=denyFetch;
  }
 }

 async function sdkPauseRejection(){
  const cfg=structuredClone(DEFAULTS_FOR_TESTS);cfg.control.workingDir=root;
  const provider=new ClaudeBrain(cfg,{allowedTools:grants});
  const sdk=provider as any;
  const ack=deferred<void>(),drained=deferred<void>();
  const rejection=Error('offline SDK interrupt receipt failure');
  const escaped:unknown[]=[],errors:string[]=[],sent:string[]=[];
  let interruptCalls=0,closeCalls=0,pending:Promise<void>|undefined;
  const query={
   interrupt:()=>{interruptCalls++;return interruptCalls===1?ack.promise:Promise.resolve(undefined);},
   close:()=>{closeCalls++;},
  };
  sdk.q=query;sdk.started=true;
  // Never enter query(), start(), or consume(). Only the real Claude pause /
  // interrupt implementation touches this injected query.
  provider.start=()=>{throw Error('Live SDK query forbidden in pause fixture');};
  provider.send=(text:string)=>{
   sent.push(text);
   if(sent.length!==1)return;
   const context=currentAgentRunContext()!;
   pending=(async()=>{
    const out=await runGated(TOOL_MAP.get('ask_app_question')!,{subject:'mode'},{workingDir:root});
    assert.equal(out.status,'success','The real gate commits the clarification');
    context.loop.exit('completed');
    provider.emit('turnEnd');drained.resolve(undefined);
   })();
   void pending.catch(error=>drained.reject(error));
  };
  const brain=new RecordingBrain(provider,'test',{}, {autoResume:false});
  const onRejection=(reason:unknown)=>escaped.push(reason);
  process.on('unhandledRejection',onRejection);
  brain.on('error',error=>errors.push(String(error)));
  brain.on('text',text=>{if(text===question)queueMicrotask(()=>brain.send('Basic mode'));});
  try{
   brain.send(calculation);
   await bounded(drained.promise,'fake SDK old turn drain');
   ack.reject(rejection);
   await tick();await tick();
   // Even after the old turnEnd, failed interruption must not release either
   // the queued answer or a later send into the unconfirmed provider session.
   brain.send('Use Basic mode, please');
   await tick();
   assert.deepEqual({
    sends:sent.length,
    sdkInterruptAttempted:interruptCalls>0,
    unhandledRejections:escaped.length,
    hostErrorVisible:errors.some(error=>/\b(?:pause|interrupt|interruption|shutdown)\b/i.test(error.replaceAll(root,''))),
    queryRetired:closeCalls>0||sdk.q!==query,
    resumedOrCompleted:['running','completed'].includes(taskCoordinator.get(brain.currentTaskId!)!.status),
   },{sends:1,sdkInterruptAttempted:true,unhandledRejections:0,
    hostErrorVisible:true,queryRetired:true,resumedOrCompleted:false},
   'Rejected SDK acknowledgment must retire the query, visibly fail closed, and never resume queued input');
  }finally{
   // Make cleanup harmless even on RED, without hiding the first rejection.
   ack.resolve(undefined);sdk.q=null;
   await brain.stop();await pending;
   await tick();process.off('unhandledRejection',onRejection);
  }
 }

 async function drainTimeoutSurvivesStop(){
  let originalContext:ReturnType<typeof currentAgentRunContext>,pending:Promise<unknown>|undefined;
  class SlowDrain extends Brain{
   sent:string[]=[];
   send(text:string){
    this.sent.push(text);
    if(this.sent.length!==1)return;
    originalContext=currentAgentRunContext();
    pending=runGated(TOOL_MAP.get('ask_app_question')!,{subject:'mode'},{workingDir:root});
   }
   interrupt(){} // Best effort deliberately does not drain the old provider.
   async pauseForInput(){} // ACK succeeds, but turnEnd remains outstanding.
   async stop(){}
  }
  const provider=new SlowDrain();
  const brain=new RecordingBrain(provider,'test',{}, {autoResume:false});
  brain.on('error',()=>{});
  try{
   brain.send(calculation);
   await bounded(pending!,'slow-drain clarification');await tick();
   const originalTask=brain.currentTaskId!;
   const pause=(brain as any).appPause;
   assert.equal(pause.ack,true,'Only the already-ACKed, not-drained timeout path is under test');
   assert.equal(pause.drained,false);
   brain.send('Basic mode');
   // Invoke the actual 15-second timer callback without wall-clock waiting.
   (brain as any).failAppPause(pause);
   assert.equal(taskCoordinator.get(originalTask)!.status,'blocked');
   brain.interrupt();
   const recovery=structuredClone((brain as any).checkpoint);
   recovery.status='running';recovery.restartable=true;recovery.recoveryAttempts=0;
   assert.equal(brain.recoverFromCheckpoint(recovery),false,'Checkpoint recovery must respect the same unconfirmed-provider fence');
   brain.send('Open Calculator and calculate 4 plus 5.');
   await tick();
   const afterSend={taskId:brain.currentTaskId,status:taskCoordinator.get(brain.currentTaskId!)!.status};
   // Deliver the original provider's late terminal event from its original
   // async owner. Stop is not confirmation that this provider has drained.
   runInAgentContext(originalContext!,()=>provider.emit('turnEnd'));
   await tick();
   assert.deepEqual({
    providerSends:provider.sent.length,
    afterSend,
    afterLateEnd:{taskId:brain.currentTaskId,status:taskCoordinator.get(brain.currentTaskId!)!.status},
   },{providerSends:1,
    afterSend:{taskId:originalTask,status:'blocked'},
    afterLateEnd:{taskId:originalTask,status:'blocked'}},
   'Drain timeout remains fenced after Stop; neither a new task nor late-event exhaustion may occur before provider replacement');
  }finally{await brain.stop();await pending;}
 }

 for(const [name,run] of [
  ['actual OpenAI immediate answer cannot inherit old turnEnd',()=>openAIRace(false)],
  ['synchronous answer waits for old drain AND interrupt acknowledgment',()=>openAIRace(true)],
  ['real Claude pause rejects injected SDK interruption fail-closed',sdkPauseRejection],
  ['drain timeout survives Stop and fences new sends plus late old turnEnd',drainTimeoutSurvivesStop],
 ] as const){
  try{await run();console.log(`PASS ${name}`);}
  catch(error){failures.push(`${name}: ${(error as Error).message}`);console.error(`FAIL ${name}:`,error);}
 }
 assert.equal(forbiddenFetches,0,'No fixture may attempt an unfaked network request');
 assert.deepEqual(failures,[],'GUI pause race regression fixtures');
 console.log('4/4 GUI pause race fixture groups passed; fake SSE/query, no device input');
}finally{
 globalThis.fetch=originalFetch;
 for(const [key,value] of previousEnvironment){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 rmSync(root,{recursive:true,force:true});
}
