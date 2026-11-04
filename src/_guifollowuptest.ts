import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Only fake providers and the real recording boundary run here. No LCU client,
// input driver, live provider, or external store is installed.
const root=mkdtempSync(join(tmpdir(),'echo-gui-followup-'));
const originalFetch=globalThis.fetch;
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('Network forbidden in GUI follow-up fixtures');};
process.env.ECHO_DATA_ROOT=root;
process.env.ECHO_MEMORY_ROOT=join(root,'memory');
process.env.ECHO_MCP='0';
process.env.ECHO_LOG_QUIET='1';

try{
 const {Brain}=await import('./brain/types.js');
 const {RecordingBrain}=await import('./agent-replay/runtime.js');
 const {currentLoop}=await import('./agent-replay/loop-log.js');
 const {taskCoordinator}=await import('./memory/task-state.js');
 const {TOOL_MAP}=await import('./tools/registry.js');
 const {runGated}=await import('./safety/gate.js');
 const {ClaudeBrain}=await import('./brain/claude.js');
 const {DEFAULTS_FOR_TESTS}=await import('./config.js');
 const {currentAgentRunContext}=await import('./agent-replay/context.js');
 const calculation='Open Calculator and calculate 2 plus 3.';
 const claim='I launched Calculator; the result is 5.';
 const falseQuestion='Would you like me to save the result of 5 that I calculated in Calculator?';

 class FakeBrain extends Brain {
  sent:string[]=[];
  send(text:string){this.sent.push(text);}
  interrupt(){}
  async stop(){}
  finish(text:string,loop=currentLoop()){
   this.emit('textDelta',{text});
   this.emit('textDone',{text});
   this.emit('text',text);
   loop?.exit('completed',{detail:'offline fake provider completed its response'});
   this.emit('turnEnd');
  }
 }
 function speechFrom(brain:InstanceType<typeof RecordingBrain>):string[]{
  const speech:string[]=[];
  brain.on('text',text=>speech.push(text));
  brain.on('textDelta',part=>speech.push(part.text));
  brain.on('textDone',part=>speech.push(part.text));
  return speech;
 }
 async function turn(brain:InstanceType<typeof RecordingBrain>,send:()=>void):Promise<void>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  let ended!:()=>void;
  const completion=new Promise<void>((resolve,reject)=>{
   ended=resolve;
   brain.once('turnEnd',ended);
   timer=setTimeout(()=>reject(Error('Offline GUI fixture did not end its turn')),3000);
  });
  try{send();await completion;}
  finally{clearTimeout(timer);brain.off('turnEnd',ended);}
 }

 for(const blocked of ['question','owner-aborted','sdk-aborted','closed-loop','abort-during-gate'])await test(`Claude SDK gate refuses ${blocked} without executing the built-in tool`,async()=>{
  const sdk=new ClaudeBrain(structuredClone(DEFAULTS_FOR_TESTS)) as any;
  let outcome:any,error:unknown;
  class SDKGate extends FakeBrain {
   async send(){
    try{
     const context=currentAgentRunContext()!,signal=new AbortController();
     if(blocked==='question')context.appQuestion='What value should I enter in the app?';
     if(blocked==='owner-aborted'){const owner=new AbortController();owner.abort();context.toolSignal=owner.signal;}
     if(blocked==='sdk-aborted')signal.abort();
     if(blocked==='closed-loop')context.loop.exit('completed');
     if(blocked==='abort-during-gate')sdk.once('risk',()=>signal.abort());
     outcome=await sdk.gate('Read',{file_path:'/fixture-not-read'},{signal:signal.signal});
    }catch(cause){error=cause;}
    this.finish('The SDK policy fixture finished.');
   }
  }
  const brain=new RecordingBrain(new SDKGate(),'test',{}, {autoResume:false});
  try{await turn(brain,()=>brain.send('Explain a concept.'));assert.equal(error,undefined);assert.equal(outcome?.behavior,'deny','SDK built-ins must respect the same pause/cancellation boundary');}
  finally{await brain.stop();await sdk.stop();}
 });

 await test('an active non-GUI turn followed by Calculator cannot speak or complete without native proof',async()=>{
  class Followup extends FakeBrain {
   send(text:string){super.send(text);if(this.sent.length===2)this.finish(claim);}
  }
  const provider=new Followup();
  const brain=new RecordingBrain(provider,'test',{}, {autoResume:false});
  const speech=speechFrom(brain);
  try{
   await turn(brain,()=>{
    brain.send('Tell me a short story');
    assert.equal(taskCoordinator.get(brain.currentTaskId!)!.status,'running','The first turn is still active when the app request arrives');
    brain.send(calculation);
   });
   assert.deepEqual(provider.sent,['Tell me a short story',calculation]);
   assert(!speech.some(text=>text.includes('I launched Calculator')||text.includes('the result is 5')),'Unverified Calculator success must not escape through streamed or whole speech');
   assert.notEqual(taskCoordinator.get(brain.currentTaskId!)!.status,'completed','The app follow-up must not become a text-only completed task');
  }finally{await brain.stop();}
 });

 await test('a direct false completion claim phrased as a question cannot reach speech without native proof',async()=>{
  class FalseQuestion extends FakeBrain {
   send(text:string){super.send(text);this.finish(falseQuestion);}
  }
  const brain=new RecordingBrain(new FalseQuestion(),'test',{}, {autoResume:false});
  const speech=speechFrom(brain);
  try{
   await turn(brain,()=>brain.send(calculation));
   assert(!speech.some(text=>text.includes('the result of 5')||text.includes('I calculated in Calculator')),'A question prefix cannot exempt an unverified past-tense completion claim');
   assert.equal(taskCoordinator.get(brain.currentTaskId!)!.status,'blocked','Provider prose alone cannot create a clarification pause or verified completion');
  }finally{await brain.stop();}
 });

 for(const [subject,hostQuestion] of [
  ['mode','Which mode should I use in the app?'],
  ['input','What value should I enter in the app?'],
 ] as const) await test(`gated ask_app_question(${subject}) pauses a decimal app goal with host-written speech`,async()=>{
  // The decimal expression belongs to the original user goal. The fake model
  // supplies only a subject; the host owns the question and the waiting state.
  const ask=TOOL_MAP.get('ask_app_question');
  assert(ask,'Register ask_app_question to implement explicit GUI clarification');
  class DecimalQuestion extends FakeBrain {
   failure?:unknown;
   pending?:Promise<void>;
   send(text:string){
    super.send(text);
    const loop=currentLoop();
    this.pending=(async()=>{
     const out=await runGated(ask!,{subject},{workingDir:root});
     assert.equal(out.status,'success','The foreground clarification must pass the real tool gate');
     this.finish('Fixture provider yielded to the host clarification.',loop);
    })().catch(error=>{this.failure=error;this.finish('The fixture clarification tool failed.',loop);});
   }
  }
  const provider=new DecimalQuestion();
  const brain=new RecordingBrain(provider,'test',{}, {autoResume:false});
  const speech=speechFrom(brain);
  try{
   await turn(brain,()=>brain.send('Open Calculator and calculate 2.5 plus 3.5.'));
   await provider.pending;
   assert.equal(provider.failure,undefined,'The explicit clarification tool must execute in the owning fake provider context');
   assert.equal(taskCoordinator.get(brain.currentTaskId!)!.status,'waiting','Decimal punctuation must not turn a genuine clarification into blocked or completed work');
   assert(speech.includes(hostQuestion),'The host-written clarification must remain audible');
   assert(Object.values(taskCoordinator.get(brain.currentTaskId!)!.calls).some(call=>call.tool==='ask_app_question'&&call.status==='success'),'The successful question invocation must be durably recorded before pausing');
   assert.equal(provider.sent.length,1,'No further fake model turn starts while the question awaits an answer');
  }finally{await brain.stop();}
 });
 assert.equal(networkAttempts,0,'The fixtures must not attempt network access');
}finally{
 globalThis.fetch=originalFetch;
 rmSync(root,{recursive:true,force:true});
}
