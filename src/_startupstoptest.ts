import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// Exercise the real main callback without booting Electron or accessing a device.
const source=readFileSync('src/main.ts','utf8');
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
const callback=ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='stopEverything');
assert(callback);
const code=ts.transpile(callback.getText(ast));
for(const ready of [false,true]){
 let stopped=0,interrupted=0,reportsStopped=0;
 const runtime=vm.createContext({inputRevision:0,pendingInterjection:null,speech:undefined,
  voiceSession:{cancel(){}},abortSttStreams(){},tts:ready?{stop(){stopped++;}}:undefined,
  brain:ready?{noteInterrupted(){},interrupt(){interrupted++;}}:undefined,
  voiceLog:{event(){}},supervisor:{cancelOwned:async()=>{}},cancelOfficeReports(){reportsStopped++;},stopRealtimeVoice(){},endConversation(){},
  awaitingCommand:null,expectAnswer:false,setStatus(){},finishTurn(){},endAutoReflex(){},
  controlTelemetry:{stopMainTasks(){}},send(){},console});
 vm.runInContext(code,runtime);
 assert.doesNotThrow(()=>vm.runInContext("stopEverything('Phone Stop')",runtime),'Stop remains usable before brain and voice initialization');
 assert.equal(stopped,ready?1:0);assert.equal(interrupted,ready?1:0);
 assert.equal(reportsStopped,1,'Stop fences office report audio even before voice initialization');
 assert.equal(runtime.inputRevision,1,'Pending input is fenced even during initialization');
}
console.log('PASS startup Stop fencing and initialized speech/brain cancellation; no native input');
