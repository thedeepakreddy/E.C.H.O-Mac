import assert from 'node:assert/strict';
import {EchoLcuSession} from './tools/lcu-session.js';
import {EchoComputerControl} from './tools/lcu-control.js';
import {withComputerEvidence,retainComputerResult,retainComputerObservation} from './tools/lcu-evidence.js';
import type {LcuClient,LcuResult} from './tools/lcu-session.js';
const owner={sessionId:'session',turnId:'run',actorId:'echo',background:false};
const state:LcuResult={content:[{type:'text',text:'Current controls'}]};
const base:LcuClient={connect:async()=>{},instructions:'original',publicTools:()=>[{name:'js'},{name:'js_reset'}],call:async()=>state,turnEnded:async()=>{},close:async()=>{}};
let started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve);let observedSignal:AbortSignal|undefined;
const waiting=new EchoLcuSession({...base,call:async(_name,_args,meta)=>{observedSignal=meta.signal;started();return new Promise((_resolve,reject)=>meta.signal?.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}},owner,async()=>{});
const pending=waiting.execute('Calculator',{kind:'inspect'}).catch(error=>error);
await entered;const ending=waiting.end('Interrupt');
assert.equal(observedSignal?.aborted,true,'Session end aborts pending approval even if its caller forgot to abort the owner signal');
await pending;await ending;

let initialize!:()=>void;const initialized=new Promise<void>(resolve=>initialize=resolve);let bound=0;
const preparing=new EchoLcuSession({...base,connect:async()=>initialized,call:async()=>{bound++;return state;}},owner,async()=>{});
const preparation=preparing.execute('Calculator',{kind:'inspect'}).catch(error=>error);
await Promise.resolve();const preparationEnd=preparing.end('Interrupt');initialize();await preparation;await preparationEnd;assert.equal(bound,0,'No app binding follows cancellation during initialization');

let visual='one';let clicks=0;
const canvas=new EchoLcuSession({...base,call:async(_name,args)=>{if(args.code.includes('.click('))clicks++;return {content:[{type:'text',text:'Canvas controls'},...(args.code.includes('Screenshot')?[{type:'image',data:visual,mimeType:'image/png'}]:[])]};}},owner,async()=>{});
const snapshot=await canvas.execute('Calculator',{kind:'inspect',screenshot:true});visual='two';
const changed=await canvas.execute('Calculator',{kind:'click',target:[20,30],observationId:snapshot.observationId as string});
assert.equal(changed.lcuActionStatus,'observation_required');assert.equal(clicks,0,'Changed pixels with identical AX text cannot be clicked');await canvas.end('Stop');

const uncertain=new EchoLcuSession({...base,call:async(_name,args)=>args.code.includes('pressKey')?{content:[{type:'text',text:'Read-back failed after input'}],isError:true}:state},owner,async()=>{},undefined,retainComputerResult);
await uncertain.execute('Calculator',{kind:'inspect'});
const unknown=await withComputerEvidence(async()=>{await uncertain.execute('Calculator',{kind:'press',key:'Return'});return {text:'Completed'};});
assert.equal(unknown.status,'uncertain','A failed call that may already have written is not an ordinary retryable failure');assert.equal(unknown.error?.retryable,false);await uncertain.end('Stop');

let compoundState='initial';
const compound=new EchoLcuSession({...base,call:async()=>({content:[{type:'text',text:compoundState}]})},owner,async()=>{},undefined,retainComputerResult);
await compound.execute('Calculator',{kind:'inspect'});
const partial=await withComputerEvidence(async()=>{
 retainComputerObservation(await compound.execute('Calculator',{kind:'press',key:'Down'}));
 compoundState='Window changed';retainComputerObservation(await compound.execute('Calculator',{kind:'press',key:'Down'}));
 throw Error('No input was sent by the final step');
});
assert.equal(partial.status,'uncertain','A compound call with earlier completed input must never claim no input happened or invite whole-call replay');assert.equal(partial.error?.retryable,false);assert.match(partial.text!,/already|earlier|completed/i);await compound.end('Stop');

const binding:LcuResult={content:[{type:'text',text:'Original app instructions'},{type:'image',data:'binding',mimeType:'image/png'}]};
const failure:LcuResult={content:[{type:'text',text:'Observation failed'}],isError:true};
let context:any={identity:{id:'echo',kind:'main'},taskId:'task-a',conversationId:'session',recorder:{runId:'run-a'}};
let failRead=true;let cleanupFails=false;let closeCount=0;
const client={...base,call:async(_name:string,args:any)=>args.code.includes('getApp(')?binding:failRead?failure:state,turnEnded:async()=>{if(cleanupFails)throw Error('cleanup pending');},close:async()=>{closeCount++;}};
const control=new EchoComputerControl(client,()=>context,async()=>{});
const failed=await withComputerEvidence(async()=>{await control.execute('Calculator',{kind:'inspect'});return {text:'Read'};});
assert.deepEqual(failed.computerContent,[...binding.content,...failure.content],'Earlier instructions/images survive a later failure');
await assert.rejects(control.execute('Calculator',{kind:'inspect'}),/cleanup|closed/i);
cleanupFails=true;await assert.rejects(control.end('run-a','Interrupt'),/cleanup/);
failRead=false;cleanupFails=false;context={...context,taskId:'task-b',recorder:{runId:'run-b'}};
await control.execute('Calculator',{kind:'inspect'});await control.end('run-b','Stop');

let finishClose!:()=>void;const closingClient=new Promise<void>(resolve=>finishClose=resolve);
const closingControl=new EchoComputerControl({...base,close:async()=>{closeCount++;await closingClient;}},()=>context,async()=>{});
const closed=closingControl.close();await assert.rejects(closingControl.execute('Calculator',{kind:'inspect'}),/clos/i);assert.equal(closingControl.busy,true);finishClose();await closed;

const failingClose=new EchoComputerControl({...client,call:async()=>state},()=>context,async()=>{});
await failingClose.execute('Calculator',{kind:'inspect'});cleanupFails=true;
const beforeClose=closeCount;await assert.rejects(failingClose.close(),/cleanup/);assert.equal(closeCount,beforeClose+1,'Transport is closed even when shutdown cleanup fails');
console.log('PASS session-owned abort, initialization fencing, visual freshness, ordered failure evidence, cleanup recovery and shutdown exclusion');
