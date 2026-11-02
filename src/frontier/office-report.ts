import {randomUUID} from 'node:crypto';
import type {MemoryScope} from '../memory/types.js';

export type OfficeTerminalStatus='completed'|'partial'|'blocked'|'failed'|'cancelled';
/** Host-only input, constructed from the committed mission/task Result. This
 * module is not an LLM tool and cannot authenticate a caller's source label. */
export interface OfficeTerminalReport {
 source:'persisted_terminal_result';
 missionId:string;
 taskId:string;
 retrySequence:number;
 status:OfficeTerminalStatus;
 summary:string;
 privateMode:boolean;
 scope:MemoryScope;
}
export type OfficeDeliveryState='queued'|'claimed'|'delivered'|'failed'|'interrupted'|'cancelled'|'private_skipped';
export interface OfficeReportEntry {
 key:string;
 report:OfficeTerminalReport;
 state:OfficeDeliveryState;
 token?:string;
 note?:string;
}
export interface OfficeReportLedger {version:1;revision:number;entries:OfficeReportEntry[]}
export interface SpeechAcknowledgment {status:'completed'|'interrupted'|'failed'}
export interface OfficeReportAdapters {
 readLedger():Promise<OfficeReportLedger>;
 /** Atomic compare-and-write; resolve true only after durable persistence.
  * No pruning of terminal identity tombstones while they can be redelivered. */
 writeLedger(next:OfficeReportLedger,expectedRevision:number):Promise<boolean>;
 /** Must include foreground speech, listening, and any reserved voice slot. */
 isIdle():boolean;
 /** Optional synchronous host eligibility (scope/authority). False defers the
  * report without consuming it; omitted preserves existing delivery behavior.
  * Called before claiming and again before any audio starts. */
 canDeliver?(report:OfficeTerminalReport):boolean;
 /** Resolve completed only on playback completion, not synthesis/queueing.
  * Honor signal and recheck/reserve the host's idle slot before starting audio. */
 speak(text:string,delivery:{key:string;signal:AbortSignal;scope:MemoryScope}):Promise<SpeechAcknowledgment>;
 /** Best-effort UI/cloud notification; ledger is authoritative, no speech. */
 notify(entry:OfficeReportEntry):void|Promise<void>;
}
const terminal=new Set<OfficeTerminalStatus>(['completed','partial','blocked','failed','cancelled']);
const deliveryStates=new Set<OfficeDeliveryState>(['queued','claimed','delivered','failed','interrupted','cancelled','private_skipped']);
const unknownSound='Speech was claimed but completion was not acknowledged; delivery is unknown and will not be replayed.';
function identity(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f]/.test(value);}
function snapshot(input:OfficeTerminalReport):OfficeTerminalReport {
 if(!input||input.source!=='persisted_terminal_result'||!identity(input.missionId)||!identity(input.taskId)
  ||!Number.isSafeInteger(input.retrySequence)||input.retrySequence<0||!terminal.has(input.status)
  ||typeof input.privateMode!=='boolean'||typeof input.summary!=='string'
  ||!input.privateMode&&(!input.summary.trim()||input.summary.length>4000)
  ||!input.scope||typeof input.scope!=='object'||Array.isArray(input.scope))throw Error('Invalid persisted terminal office report.');
 const scope:MemoryScope={};
 for(const field of ['principalId','workspaceId','projectId','taskId'] as const){
  const value=input.scope[field];if(value===undefined)continue;
  if(!identity(value))throw Error('Invalid office report scope.');scope[field]=value;
 }
 for(const field of ['resourceIds','allowedActors'] as const){
  const value=input.scope[field];if(value===undefined)continue;
  if(!Array.isArray(value)||value.length>100||!value.every(identity))throw Error('Invalid office report scope.');scope[field]=[...value];
 }
 return {source:input.source,missionId:input.missionId,taskId:input.taskId,retrySequence:input.retrySequence,
  status:input.status,summary:input.privateMode?'':input.summary,privateMode:input.privateMode,scope};
}
function keyOf(report:OfficeTerminalReport):string{return JSON.stringify([report.missionId,report.taskId,report.retrySequence]);}

/** One live host queue per ledger/voice lane. A replacement reconciles claimed
 * sound as unknown, never replaying it. Only queued, unclaimed work resumes.
 * Stop is permanent for this instance; its promise confirms durable cancellation. */
export class OfficeReportQueue {
 private tail:Promise<void>=Promise.resolve();
 private initialized?:Promise<void>;
 private draining?:Promise<void>;
 private stopped=false;
 private readonly withheld=new Set<string>();
 private active?:{key:string;controller:AbortController};
 constructor(private readonly adapters:OfficeReportAdapters){}

 private notify(entries:OfficeReportEntry[]):void {
  for(const entry of entries){
   try{void Promise.resolve(this.adapters.notify(structuredClone(entry))).catch(()=>{});}catch{/* UI failure cannot replay sound. */}
  }
 }
 private edit<T>(change:(ledger:OfficeReportLedger)=>{value:T;changed:OfficeReportEntry[]}):Promise<T>{
  const work=this.tail.then(async()=>{
   for(let attempt=0;attempt<3;attempt++){
    const stored=await this.adapters.readLedger();
    if(stored?.version!==1||!Number.isSafeInteger(stored.revision)||stored.revision<0||!Array.isArray(stored.entries))throw Error('Invalid office report ledger.');
    const ledger=structuredClone(stored),keys=new Set<string>();
    for(const entry of ledger.entries){
     entry.report=snapshot(entry.report);
     if(entry.key!==keyOf(entry.report)||keys.has(entry.key)||!deliveryStates.has(entry.state)
      ||entry.state==='claimed'&&!identity(entry.token))throw Error('Invalid office report ledger entry.');
     keys.add(entry.key);
    }
    const result=change(ledger);
    if(!result.changed.length)return result.value;
    ledger.revision=stored.revision+1;
    if(!await this.adapters.writeLedger(ledger,stored.revision))continue;
    this.notify(result.changed);return result.value;
   }
   throw Error('Office report ledger changed concurrently; no new speech was started.');
  });
  this.tail=work.then(()=>{},()=>{});return work;
 }
 private initialize():Promise<void>{
  return this.initialized??=(this.edit(ledger=>{
   const changed:OfficeReportEntry[]=[];
   for(const entry of ledger.entries){
    if(entry.state==='claimed'){
     entry.state='interrupted';delete entry.token;entry.note=unknownSound;changed.push(entry);
    }else if(entry.state==='queued'&&entry.report.privateMode){
     entry.state='private_skipped';entry.note='Private report content was not spoken.';changed.push(entry);
    }
   }
   return {value:undefined,changed};
  }));
 }
 /** True means a new terminal identity was durably recorded, not spoken. */
 async enqueue(input:OfficeTerminalReport):Promise<boolean>{
  const report=snapshot(input),key=keyOf(report);
  if(report.privateMode){
   this.withheld.add(key);
   if(this.active?.key===key)this.active.controller.abort();
  }
  await this.initialize();
  return this.edit(ledger=>{
   const existing=ledger.entries.find(entry=>entry.key===key);
   if(existing){
    // A later privacy restriction wins over deduplication, but never changes
    // an already committed result into new provider prose or replays sound.
    if(report.privateMode&&!existing.report.privateMode){
     if(this.active?.key===key)this.active.controller.abort();
     existing.report.privateMode=true;existing.report.summary='';
     if(existing.state==='queued')existing.state='private_skipped';
     else if(existing.state==='claimed'){existing.state='interrupted';delete existing.token;}
     existing.note='Stored summary withheld after a privacy restriction; no new speech will be started.';
     return {value:false,changed:[existing]};
    }
    return {value:false,changed:[]};
   }
   const state=this.stopped?'cancelled':report.privateMode?'private_skipped':'queued';
   const entry:OfficeReportEntry={key,report,state};
   if(state==='cancelled')entry.note='Stopped before report speech.';
   if(state==='private_skipped')entry.note='Private report content was not spoken.';
   ledger.entries.push(entry);return {value:true,changed:[entry]};
  });
 }
 drain():Promise<void>{
  if(this.draining)return this.draining;
  const work=this.runDrain();
  this.draining=work;
  void work.finally(()=>{if(this.draining===work)this.draining=undefined;}).catch(()=>{});
  return work;
 }
 private async runDrain():Promise<void>{
  await this.initialize();
  while(!this.stopped&&this.adapters.isIdle()){
   const claimed=await this.edit(ledger=>{
    if(this.stopped||!this.adapters.isIdle())return {value:undefined,changed:[]};
    const entry=ledger.entries.find(item=>item.state==='queued'&&!item.report.privateMode&&!this.withheld.has(item.key)
     &&(!this.adapters.canDeliver||this.adapters.canDeliver(item.report)===true));
    if(!entry)return {value:undefined,changed:[]};
    entry.state='claimed';entry.token=randomUUID();entry.note='Awaiting actual speech completion acknowledgment.';
    return {value:structuredClone(entry),changed:[entry]};
   });
   if(!claimed)return;
   if(!this.stopped&&(!this.adapters.isIdle()
    ||this.adapters.canDeliver&&this.adapters.canDeliver(claimed.report)!==true)){
    await this.edit(ledger=>{
     const entry=ledger.entries.find(item=>item.key===claimed.key&&item.token===claimed.token&&item.state==='claimed');
     if(!entry)return {value:undefined,changed:[]};
     entry.state=this.stopped?'cancelled':'queued';delete entry.token;
     entry.note=this.stopped?'Stopped before report speech.':'Delivery became ineligible before any speech began.';
     return {value:undefined,changed:[entry]};
    });return;
   }
   const controller=new AbortController();this.active={key:claimed.key,controller};
   let outcome:SpeechAcknowledgment={status:'interrupted'};
   let onAbort=()=>{};
   try{
    if(this.stopped||this.withheld.has(claimed.key))controller.abort();
    else{
     const aborted=new Promise<SpeechAcknowledgment>(resolve=>{
      onAbort=()=>resolve({status:'interrupted'});controller.signal.addEventListener('abort',onAbort,{once:true});
     });
     const text=`Office mission ${claimed.report.status}. ${claimed.report.summary}`;
     try{
      outcome=await Promise.race([this.adapters.speak(text,{key:claimed.key,signal:controller.signal,
       scope:structuredClone(claimed.report.scope)}),aborted]);
     }catch{outcome={status:'failed'};}
    }
   }finally{
    controller.signal.removeEventListener('abort',onAbort);
    if(this.active?.controller===controller)this.active=undefined;
   }
   await this.edit(ledger=>{
    const entry=ledger.entries.find(item=>item.key===claimed.key&&item.token===claimed.token&&item.state==='claimed');
    if(!entry)return {value:undefined,changed:[]};
    entry.state=this.stopped||controller.signal.aborted||outcome?.status==='interrupted'?'interrupted'
     :outcome?.status==='completed'?'delivered':'failed';
    delete entry.token;
    entry.note=entry.state==='delivered'?'Speech playback completion acknowledged.'
     :entry.state==='interrupted'?unknownSound:'Speech failed or lacked a completion acknowledgment; it will not be replayed.';
    return {value:undefined,changed:[entry]};
   });
  }
 }
 async stop():Promise<void>{
  this.stopped=true;this.active?.controller.abort();
  await this.initialize();
  await this.edit(ledger=>{
   const changed:OfficeReportEntry[]=[];
   for(const entry of ledger.entries){
    if(entry.state!=='queued'&&entry.state!=='claimed')continue;
    entry.state=entry.state==='claimed'?'interrupted':'cancelled';delete entry.token;
    entry.note=entry.state==='interrupted'?unknownSound:'Stopped before report speech.';changed.push(entry);
   }
   return {value:undefined,changed};
  });
 }
}
