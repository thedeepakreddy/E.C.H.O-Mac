import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {OfficeReportQueue} from './frontier/office-report.js';
// Exercise the actual host functions without booting Electron, speech or models.
const source=readFileSync('src/main.ts','utf8'),ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
const functions=['readOfficeLedger','officeVoiceIdle','makeOfficeReportQueue','officeQueue','cancelOfficeReports'];
const selected=functions.map(name=>ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name));
assert(selected.every(Boolean));
const listener=ast.statements.find(s=>ts.isExpressionStatement(s)&&s.getText(ast).startsWith('swarm.setTerminalListener('));assert(listener);
const declarations=`let officeReportQueue,officeReportReset=Promise.resolve(),officeReportGeneration=0,officeReportSpeaking,officeReportDeliveryBlocked=false;const officeLedgerPath=()=>'/fixture/office-report-delivery.json';`;
const code=ts.transpile(declarations+selected.map(s=>s!.getText(ast)).join('\n')+listener.getText(ast));
function fixture(){
 let contents='',terminal:(mission:any)=>void=()=>{},capture=true,scope:any={projectId:'one'},spoken=0,writeFails=false;
 const saved={taskId:'mission.test',ownerActorId:'mission:test',scope:{projectId:'one',echoBot:true},privateMode:false,result:{summary:'Saved result'}};
 const mission={id:'test',taskId:saved.taskId,retrySequence:0,status:'completed',scope:{echoBot:true},tasks:{research:{result:{summary:'Verified report'}}}};
 const runtime=vm.createContext({OfficeReportQueue,Symbol,Promise,JSON,shuttingDown:false,cfg:{voice:{ttsEnabled:true}},
  brainLifecycle:{isSwitching:false},voiceSession:{brainTurnActive:false,state:'sleeping'},listener:{isCapturing:false,capturingInterjection:false},
  confirmations:{isWaiting:false},expectAnswer:false,awaitingCommand:null,pendingInterjection:null,realtime:null,realtimeTurn:null,lastBrainStatus:'idle',
  echoIsSpeaking:()=>false,replyChannel:()=> 'local',captureAllowed:()=>capture,currentScope:()=>scope,
  existsSync:()=>!!contents,readFileSync:()=>contents,atomicWrite:(_path:string,next:string)=>{if(writeFails)throw Error('Fixture disk write failure');contents=next;},
  taskCoordinator:{get:(id:string)=>id===saved.taskId?saved:null},
  swarm:{getMission:()=>mission,setTerminalListener:(callback:typeof terminal)=>{terminal=callback;}},
  tts:{speakWithAcknowledgment:async()=>{assert.equal(JSON.parse(contents).entries[0].state,'claimed');spoken++;return {status:'completed'};}},
  publishControlUpdate(){},send(){},console});
 vm.runInContext(code,runtime);
 return {runtime,saved,mission,terminal:()=>terminal(mission),capture:(value:boolean)=>{capture=value;},scope:(value:unknown)=>{scope=value;},spoken:()=>spoken,ledger:()=>contents?JSON.parse(contents):undefined,setLedger:(next:unknown)=>{contents=JSON.stringify(next);},failWrite:()=>{writeFails=true;}};
}
for(const variant of ['normal','private','foreign-scope','superseded','stopped','legacy-nonoffice'] as const){
 const f=fixture();if(variant==='private')f.capture(false);
 f.terminal();if(variant==='stopped')vm.runInContext('cancelOfficeReports()',f.runtime);
 await new Promise<void>(resolve=>setImmediate(resolve));
 if(variant==='foreign-scope')f.scope({projectId:'another'});
 if(variant==='superseded')f.mission.taskId='mission.test.retry-1';
 if(variant==='legacy-nonoffice')f.mission.scope.echoBot=false;
 await vm.runInContext('(async()=>{await (await officeQueue()).drain();})()',f.runtime);
 assert.equal(f.spoken(),variant==='normal'?1:0,variant);
 if(variant==='normal')assert.equal(f.ledger().entries[0].state,'delivered');
 if(variant==='foreign-scope'){assert.equal(f.ledger().entries[0].state,'queued');f.scope({projectId:'one'});await vm.runInContext('(async()=>{await (await officeQueue()).drain();})()',f.runtime);assert.equal(f.spoken(),1,'Returning to scope resumes a never-started report');}
 if(variant==='private')assert.equal(f.ledger().entries[0].report.summary,'');
}
const origin=fixture();origin.mission.scope.echoBot=false;origin.terminal();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(origin.ledger(),undefined,'Nonoffice private-origin mission cannot authorize persistent voice');
const restarted=fixture();restarted.setLedger({version:1,revision:0,entries:[{key:JSON.stringify(['test','mission.test',0]),state:'queued',report:{source:'persisted_terminal_result',missionId:'test',taskId:'mission.test',retrySequence:0,status:'completed',summary:'Saved report before restart',scope:{projectId:'one'},privateMode:false}}]});vm.runInContext('cancelOfficeReports()',restarted.runtime);await vm.runInContext('(async()=>{await (await officeQueue()).drain();})()',restarted.runtime);assert.equal(restarted.spoken(),0);assert.equal(restarted.ledger().entries[0].state,'cancelled','Stop before first queue creation cancels persisted speech');
const busy=fixture();const busyCases:Array<[string,unknown]>=[['lastBrainStatus','thinking'],['expectAnswer',true],['pendingInterjection',{}]];for(const [field,value] of busyCases){
 const old=busy.runtime[field];busy.runtime[field]=value;assert.equal(vm.runInContext('officeVoiceIdle()',busy.runtime),false);busy.runtime[field]=old;
}
busy.runtime.realtime={active:true};assert.equal(vm.runInContext('officeVoiceIdle()',busy.runtime),true,'An idle connected Live socket is not active work');busy.runtime.realtimeTurn={turnId:'owned'};assert.equal(vm.runInContext('officeVoiceIdle()',busy.runtime),false,'Pending Live output owns the voice lane');
const diskFailure=fixture(),failedLedger=restarted.ledger();failedLedger.entries[0].state='queued';diskFailure.setLedger(failedLedger);diskFailure.failWrite();vm.runInContext('cancelOfficeReports()',diskFailure.runtime);await assert.rejects(vm.runInContext('officeQueue()',diskFailure.runtime),/blocked/i);assert.equal(vm.runInContext('officeVoiceIdle()',diskFailure.runtime),false);assert.equal(diskFailure.spoken(),0,'An unsaved Stop must fail closed');
console.log('PASS actual office host handoff: persisted claim, idle gate, privacy, scope, superseded identity and Stop race; no audio/device input');
