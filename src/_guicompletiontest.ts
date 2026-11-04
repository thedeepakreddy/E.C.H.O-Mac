import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'echo-gui-completion-'));
process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.ECHO_MCP='0';
try{
 const {Brain}=await import('./brain/types.js');
 const {RecordingBrain}=await import('./agent-replay/runtime.js');
 const {currentLoop}=await import('./agent-replay/loop-log.js');
 const {taskCoordinator}=await import('./memory/task-state.js');
 const {TOOL_MAP}=await import('./tools/registry.js');
 const {runGated}=await import('./safety/gate.js');
 class Unverified extends Brain {
  send(){this.emit('textDelta',{text:'Two plus three equals 5.'});this.emit('text','I have launched Calculator. Two plus three equals 5.');currentLoop()!.exit('completed',{detail:'text-only reply'});this.emit('turnEnd');}
  interrupt(){} async stop(){}
 }
 const wrapped=new RecordingBrain(new Unverified(),'test',{}, {autoResume:false});
 const spoken:string[]=[];wrapped.on('text',text=>spoken.push(text));wrapped.on('textDelta',chunk=>spoken.push(chunk.text));
 const ended=new Promise<void>(resolve=>wrapped.once('turnEnd',resolve));wrapped.send('Open Calculator and calculate 2 plus 3.');await ended;
 assert(!spoken.some(text=>/equals 5|have launched/.test(text)),'Unverified completion must not reach speech, including streamed fragments');
 assert(spoken.some(text=>/not.*verified|could not verify|haven.t verified/i.test(text)),'Echo must explain the actual verification blocker');
 assert.notEqual(taskCoordinator.get(wrapped.currentTaskId!)!.status,'completed');await wrapped.stop();
 const privateBrain=new RecordingBrain(new Unverified(),'test',{}, {autoResume:false});const privateSpoken:string[]=[];
 privateBrain.on('text',text=>privateSpoken.push(text));
 const privateDone=new Promise<void>(resolve=>privateBrain.once('turnEnd',resolve));privateBrain.send('Open Calculator and calculate 2 plus 3.',undefined,{privateMode:true});await privateDone;
 assert(!privateSpoken.some(text=>/equals 5|have launched/.test(text)),'Privacy mode must not bypass completion verification');await privateBrain.stop();
 class Question extends Brain {
  async send(){const loop=currentLoop();await runGated(TOOL_MAP.get('ask_app_question')!,{subject:'mode'},{workingDir:root});loop?.exit('completed');this.emit('turnEnd');}
  interrupt(){} async stop(){}
 }
 const question=new RecordingBrain(new Question(),'test',{}, {autoResume:false});const questions:string[]=[];
 question.on('text',text=>questions.push(text));
 let questionDone=new Promise<void>(resolve=>question.once('turnEnd',resolve));question.send('Open Calculator and calculate 2 plus 3.');await questionDone;
 const questionTask=question.currentTaskId!;
 assert.equal(taskCoordinator.get(questionTask)!.status,'waiting','A clarification pauses instead of failing or completing');
 assert(questions.includes('Which mode should I use in the app?'),'A host-written question must remain audible');
 questionDone=new Promise<void>(resolve=>question.once('turnEnd',resolve));question.send('Basic mode');await questionDone;
 assert.equal(question.currentTaskId,questionTask,'The answer continues the original goal, not a new text-only task');
 const {pendingRecoveries}=await import('./agent-replay/runtime.js');
 assert(!pendingRecoveries().some(item=>item.taskId===questionTask),'A saved question never resumes autonomously');
 question.interrupt();assert.equal(taskCoordinator.get(questionTask)!.status,'cancelled','Stop cancels a paused task');
 await question.stop();
 const {EchoComputerControl,installEchoComputerControl,closeEchoComputerControl}=await import('./tools/lcu-control.js');
 const {echoAppAction}=await import('./tools/computer-actions.js');
 const {appConditionMatches,nativeWindow}=await import('./tools/app-verification.js');
 const native=(text:string)=>({content:[{type:'text',text}]});
 assert.deepEqual(nativeWindow(native('Window: "Downloads", App: Finder.\n0 standard window Downloads')),{title:'Downloads',app:'Finder'});
 assert.deepEqual(nativeWindow(native('Window: Desktop, App: Finder.')),{title:'Desktop',app:'Finder'});
 assert.equal(nativeWindow(native('Window: "Downloads", App: Finder.\nWindow: "Desktop", App: Finder.')),undefined,'Multiple native headers are ambiguous');
 assert.equal(nativeWindow(native('0 text Window: "Downloads", App: Finder.')),undefined,'Body text cannot manufacture a native window identity');
 assert.equal(nativeWindow(native('Window: "Downloads, App: Finder.')),undefined,'Malformed quoted titles fail closed');
 assert.equal(nativeWindow({...native('Window: "Downloads", App: Finder.'),isError:true}),undefined,'An error response cannot prove native window identity');
 assert.equal(appConditionMatches(native('Window: "Desktop", App: Finder.'),{kind:'window_closed',title:'Downloads'}),false,'A changed title without a trusted receipt cannot prove close');
 const verification=TOOL_MAP.get('verify_app_state')!;
 assert.equal(verification.schema.kind.safeParse('window_closed').success,true,'The flat provider schema exposes the close kind');
 assert.equal(verification.schema.windowTitle.safeParse('Downloads').success,true);
 assert.equal((await verification.handler({app:'Finder',observationId:'fixture',kind:'window_closed'})).status,'failed','Missing original title must fail before selecting any app');
 const state=(expression:string,value:string)=>({content:[{type:'text',text:`Window: "Calculator", App: Calculator.\n0 standard window Calculator\n\t1 container\n\t\t3 scroll area Description: Last Expression, ID: StandardResultView\n\t\t\t4 text ${expression}\n\t\t5 scroll area Description: Edit field, ID: StandardInputView\n\t\t\t6 text \u200e${value}\u200e\n\t\t7 button Description: 5, ID: Five`}]});
 assert.equal(appConditionMatches(state('2+3','5'),{kind:'text',index:7,expected:'5'}),false,'A digit button never verifies the result');
 assert.equal(appConditionMatches(state('5','999'),{kind:'text',index:4,expected:'5'}),false,'History is not the current result');
 assert.equal(appConditionMatches(state('2+3','5'),{kind:'text',index:6,expected:'5'}),true);
 async function runFixture(expression:string,value:string,options:{app?:string;request?:string;reply?:string;pause?:boolean}={}){
  const app=options.app??'Calculator',request=options.request??'Open Calculator and calculate 2 plus 3.';
  let observed=state('','0');let inputCalls=0;
  const client={connect:async()=>{},instructions:'fixture',publicTools:()=>[{name:'js'},{name:'js_reset'}],call:async(_name:string,args:{code:string})=>{
   if(args.code.includes('typeText')){inputCalls++;observed=state(expression,value);}return observed;
  },turnEnded:async()=>{},close:async()=>{}};
  installEchoComputerControl(new EchoComputerControl(client,undefined,async()=>{}));
  class Verified extends Brain {
   turns=0;
   async send(){
    const loop=currentLoop();this.turns++;
    let written=await echoAppAction(app,{kind:'inspect'});
    if(this.turns===1)written=await echoAppAction(app,{kind:'type',text:expression});
    await TOOL_MAP.get('verify_app_state')!.handler({app,observationId:written.observationId,kind:'text',index:6,expected:value});
    if(options.pause&&this.turns===1){await runGated(TOOL_MAP.get('ask_app_question')!,{subject:'mode'},{workingDir:root});this.emit('turnEnd');return;}
    const reply=options.reply??'I calculated 2 plus 3 in Calculator; the result is 5.';
    this.emit('textDelta',{text:reply});this.emit('text',reply);loop!.exit('completed');this.emit('turnEnd');
   }
   interrupt(){} async stop(){}
  }
  const brain=new RecordingBrain(new Verified(),'test',{}, {autoResume:false});const replies:string[]=[];
  brain.on('text',text=>replies.push(text));brain.on('textDelta',part=>replies.push(part.text));
  const done=new Promise<void>(resolve=>brain.once('turnEnd',resolve));brain.send(request);await done;
  if(options.pause){
   const taskId=brain.currentTaskId;assert.equal(taskCoordinator.get(taskId!)!.status,'waiting');
   const answered=new Promise<void>(resolve=>brain.once('turnEnd',resolve));brain.send('Basic mode');await answered;assert.equal(brain.currentTaskId,taskId);
  }
  const task=taskCoordinator.get(brain.currentTaskId!)!;await brain.stop();await closeEchoComputerControl();
  assert.equal(inputCalls,1);return {replies,task};
 }
 const correct=await runFixture('2+3','5');assert.equal(correct.task.status,'completed');assert.equal(correct.replies.length,1,'Verified final reply is delivered exactly once, not replayed as streamed plus whole text');assert.match(correct.replies[0],/shows 5 for 2\+3/);
 const wrong=await runFixture('9+9','18');assert.equal(wrong.task.status,'blocked');assert(!wrong.replies.some(text=>/result is 5/.test(text)),'Verification of another calculation cannot complete this goal');
 const falseNarration=await runFixture('2+3','5',{reply:'I calculated it; the result is 18.'});
 assert.equal(falseNarration.task.status,'completed');assert(!falseNarration.replies.some(text=>/result is 18/.test(text)),'Even after real verification, the reported value must come from the observed result, not conflicting provider narration');
 assert.equal((await runFixture('2+3','0,5')).task.status,'blocked','A decimal comma cannot turn 0.5 into 5');
 const large=await runFixture('1000000000000000+1','1000000000000000',{request:'Open Calculator and calculate 1000000000000000 plus 1.'});assert.equal(large.task.status,'blocked','Large integer errors cannot pass through a relative tolerance');
 assert.equal((await runFixture('2+3','5',{app:'/System/Applications/Calculator.app'})).task.status,'completed','The supported system app path is the same Calculator identity');
 const resumed=await runFixture('2+3','5',{pause:true});assert.equal(resumed.task.status,'completed','Fresh verification after answering must retain earlier completed input without duplicating it');assert.equal(resumed.replies.filter(text=>/shows 5/.test(text)).length,1);
 async function runCloseFixture(options:{kind?:'visible'|'window_closed';input?:boolean;afterTitle?:string;conditionTitle?:string;request?:string;afterApp?:string;reference?:string;modal?:boolean;coordinate?:boolean;button?:'left'|'right';count?:number;reply?:string}={}){
  let title='Downloads',appName='Finder',inputCalls=0;
  const observed=()=>({content:[{type:'text',text:`Window: "${title}", App: ${appName}.\n${title==='Desktop'?'0 scroll area (disabled) desktop\n\t1 container desktop':`0 standard window ${title}\n\t2 close button`}${options.modal&&inputCalls?'\n\t3 sheet Save changes?\n\t\t4 button Description: Save':''}`}]});
  const client={connect:async()=>{},instructions:'fixture',publicTools:()=>[{name:'js'},{name:'js_reset'}],call:async(_name:string,args:{code:string})=>{
   if(args.code.includes('.click(')){inputCalls++;title=options.afterTitle??'Desktop';appName=options.afterApp??'Finder';}
   return observed();
  },turnEnded:async()=>{},close:async()=>{}};
  installEchoComputerControl(new EchoComputerControl(client,undefined,async()=>{}));
  class CloseWindow extends Brain {
   async send(){
    const loop=currentLoop();
    const reference=options.reference??'Finder';
    let latest=await echoAppAction(reference,{kind:'inspect',screenshot:options.coordinate});
    if(options.input!==false)latest=await echoAppAction(reference,{kind:'click',target:options.coordinate?[10,10]:2,observationId:latest.observationId as string,button:options.button??'left',count:options.count??1});
    await TOOL_MAP.get('verify_app_state')!.handler({app:reference,observationId:latest.observationId,kind:options.kind??'window_closed',windowTitle:options.conditionTitle??'Downloads'});
    const reply=options.reply??'I closed the Downloads window.';
    this.emit('textDelta',{text:reply});this.emit('text',reply);loop!.exit('completed');this.emit('turnEnd');
   }
   interrupt(){} async stop(){}
  }
  const brain=new RecordingBrain(new CloseWindow(),'test',{}, {autoResume:false}),replies:string[]=[];
  brain.on('text',text=>replies.push(text));brain.on('textDelta',part=>replies.push(part.text));
  try{
   const done=new Promise<void>(resolve=>brain.once('turnEnd',resolve));brain.send(options.request??'Open Finder and close the Downloads window.');await done;
   return {replies,task:taskCoordinator.get(brain.currentTaskId!)!,inputCalls};
  }finally{await brain.stop();await closeEchoComputerControl();}
 }
 const visibleClose=await runCloseFixture({kind:'visible'});
 assert.equal(visibleClose.task.status,'blocked','App visibility cannot prove that a requested window closed');
 assert(!visibleClose.replies.some(text=>/I closed/.test(text)),'Unverified close narration, including streamed text, must be suppressed');
 const closed=await runCloseFixture();assert.equal(closed.task.status,'completed','A fresh native Downloads close followed by Finder Desktop can complete the exact close request');assert.equal(closed.inputCalls,1);
 assert.equal(closed.replies.length,1);assert.match(closed.replies[0],/Closed.*Downloads.*window/);
 assert.equal((await runCloseFixture({input:false})).task.status,'blocked','No input means no trusted close receipt');
 assert.equal((await runCloseFixture({afterTitle:'Downloads'})).task.status,'blocked','Click success without a changed native window does not prove close');
 assert.equal((await runCloseFixture({conditionTitle:'Documents'})).task.status,'blocked','The exact original title must match the trusted receipt');
 assert.equal((await runCloseFixture({request:'Open Finder and close the Documents window.'})).task.status,'blocked','A Downloads receipt cannot prove a request to close Documents');
 assert.equal((await runCloseFixture({request:'Open Finder and close the Downloads backup window.'})).task.status,'blocked','A title prefix is not the exact requested window');
 assert.equal((await runCloseFixture({request:'Open Finder and close the window named Documents.'})).task.status,'blocked','A named target must not be treated as a deictic window');
 assert.equal((await runCloseFixture({request:'Open Finder and close Documents, then open Downloads.'})).task.status,'blocked','A title mentioned outside the close instruction is not its requested target');
 assert.equal((await runCloseFixture({request:'Close the Downloads window in Finder.'})).task.status,'completed','A direct close request uses the same foreground completion boundary');
 assert.equal((await runCloseFixture({request:'Close this window in Finder.'})).task.status,'completed','Clear deictic window requests are bound to the original native title');
 assert.equal((await runCloseFixture({request:'Click the close button on the downloads folder which is on my screen.'})).task.status,'completed','The actual logged close-button request must match its original native window');
 assert.equal((await runCloseFixture({request:'Close Downloads then open Safari.'})).task.status,'blocked','Closing one window cannot prove a second requested operation');
 assert.equal((await runCloseFixture({afterTitle:'Save changes?',modal:true})).task.status,'blocked','A save dialog is not proof that the original window closed');
 assert.equal((await runCloseFixture({afterTitle:'Other document'})).task.status,'blocked','Another front window is not proof that the original window disappeared');
 assert.equal((await runCloseFixture({reference:'com.apple.finder'})).task.status,'completed','The intent must match the native app name, not a provider-selected bundle reference');
 assert.equal((await runCloseFixture({request:'Open Finder and close Finder.'})).task.status,'blocked','Closing an app is not proof of closing one named window');
 assert.equal((await runCloseFixture({afterApp:'TextEdit'})).task.status,'blocked','Another app becoming visible is not Finder close proof');
 assert.equal((await runCloseFixture({coordinate:true})).task.status,'blocked','Coordinate clicks cannot create a native close receipt');
 assert.equal((await runCloseFixture({button:'right'})).task.status,'blocked','A right click is not a native close operation');
 assert.equal((await runCloseFixture({count:2})).task.status,'blocked','A double click is not the bounded single close operation');
 const exaggerated=await runCloseFixture({reply:'I closed all Finder windows and quit Finder.'});
 assert.equal(exaggerated.task.status,'completed');assert(!exaggerated.replies.some(text=>/all Finder|quit Finder/.test(text)),'Speech may report only the verified window close');
 console.log('PASS unverified GUI completion refusal at the real wrapped-provider speech/task boundary');
}finally{rmSync(root,{recursive:true,force:true});}
