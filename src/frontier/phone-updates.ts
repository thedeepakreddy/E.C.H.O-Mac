import {readFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {atomicWrite} from '../memory/paths.js';
import {scrubSecrets} from '../safety/redact.js';
import {activeWork, type CompanionWork} from '../control-companion.js';
export interface PhoneUpdate {id:string;sessionId:string;generation:number;devices:string[];at:number;title:string;body:string;kind:'handoff'|'progress'|'needs-you'|'finished';expiresAt:number}
export interface UpdateInventory {generation:number;devices:string[];pushDevices:number}
interface State {version:1;sessionId:string;expiresAt:number;generation:number;devices:string[];seen:Record<string,string>;queue:PhoneUpdate[];lastDeliveredAt:number|null;message:string}
const empty=():State=>({version:1,sessionId:'',expiresAt:0,generation:0,devices:[],seen:{},queue:[],lastDeliveredAt:null,message:'Phone updates are off.'});
const signature=(w:CompanionWork)=>`${w.status}:${w.question?.id??''}:${activeWork(w.status)&&w.live===false?'saved':'live'}`;
const meaningful=(w:CompanionWork)=>!!w.question||activeWork(w.status)&&w.live===false||['waiting','waiting-for-input','blocked','failed','partial','completed','done','cancelled','stopped','verifying','deploying','previewing'].includes(w.status);
/** Durable outbox. Retries carry the same event ID; relay deduplicates per installation. */
export class PhoneUpdates {
 private state:State|null=null; private sending=false;
 constructor(private file:()=>string,private now=Date.now){}
 private load(){if(!this.state){let s=empty();try{if(existsSync(this.file())){const v=JSON.parse(readFileSync(this.file(),'utf8'));if(v.version===1&&Array.isArray(v.queue)&&Array.isArray(v.devices)&&v.seen&&typeof v.expiresAt==='number')s=v;}}catch{}this.state=s;}return this.state;}
 private save(){atomicWrite(this.file(),JSON.stringify(this.load()));}
 snapshot():{active:boolean;expiresAt:number|null;queued:number;lastDeliveredAt:number|null;message:string}{const s=this.load();if(s.expiresAt&&s.expiresAt<=this.now())this.stop('Phone updates ended after 24 hours.');return {active:s.expiresAt>this.now(),expiresAt:s.expiresAt||null,queued:s.queue.length,lastDeliveredAt:s.lastDeliveredAt,message:s.message};}
 begin(inventory:UpdateInventory,work:CompanionWork[]){
  if(!Number.isInteger(inventory.generation)||!inventory.devices.length)throw new Error('Open Echo Phone and connect to this Mac first, then try again.');
  if(this.snapshot().active)return this.snapshot();
  const s=this.state={...empty(),sessionId:randomUUID(),generation:inventory.generation,devices:[...new Set(inventory.devices)],expiresAt:this.now()+24*3600_000};
  for(const w of work.filter(w=>!w.privateMode))s.seen[w.id]=signature(w);
  const active=work.filter(w=>!w.privateMode&&activeWork(w.status));
  s.message=inventory.pushDevices?'Updates are queued for your connected phone.':'Updates will appear in Phone Missions. Enable notifications there for alerts while Echo is closed.';
  this.enqueue('handoff','Echo is keeping you updated',active.length?active.slice(0,3).map(w=>`${w.title}: ${w.status}`).join('\n'):'I’ll send a message when work finishes or needs you. Your Mac must stay awake with Echo running.');
  this.save();return this.snapshot();
 }
 private enqueue(kind:PhoneUpdate['kind'],title:string,body:string){const s=this.load();s.queue.push({id:randomUUID(),sessionId:s.sessionId,generation:s.generation,devices:s.devices,at:this.now(),expiresAt:s.expiresAt,kind,title:scrubSecrets(title).slice(0,100),body:scrubSecrets(body).slice(0,1000)});s.queue=s.queue.slice(-50);}
 observe(work:CompanionWork[],approval?:{id:string;question:string}|null){
  if(!this.snapshot().active)return;const s=this.load();let dirty=false;
  for(const w of work){if(w.privateMode)continue;const sig=signature(w),old=s.seen[w.id];if(old===sig)continue;s.seen[w.id]=sig;dirty=true;
   if(meaningful(w)&&(old!==undefined||activeWork(w.status)||w.updatedAt>=s.expiresAt-24*3600_000)){const needs=!!w.question||activeWork(w.status)&&w.live===false||['waiting','waiting-for-input','failed','blocked','partial'].includes(w.status);this.enqueue(needs?'needs-you':activeWork(w.status)?'progress':'finished',needs?'Echo needs you':activeWork(w.status)?'Echo made progress':'Echo finished a task',`${w.title}: ${w.live===false&&activeWork(w.status)?'saved progress; inspect before resuming':w.status}${w.question?`\n${w.question.text}`:w.summary?`\n${w.summary}`:''}`);}
  }
  if(approval&&s.seen['approval']!==approval.id){s.seen['approval']=approval.id;dirty=true;this.enqueue('needs-you','An action needs your decision',approval.question);}
  if(Object.keys(s.seen).length>500)s.seen=Object.fromEntries(Object.entries(s.seen).slice(-500));
  if(dirty)this.save();
 }
 reconcile(inventory:UpdateInventory){const s=this.load();if(this.snapshot().active&&inventory.generation!==s.generation)return this.stop('Mac phone sessions changed. Reconnect your phone and start updates again.');return this.snapshot();}
 stop(message='Phone updates are off.'){const s=this.load();s.expiresAt=0;s.queue=[];s.message=message;this.save();return this.snapshot();}
 async flush(send:(event:PhoneUpdate)=>Promise<{ok:boolean;pending?:boolean;recipients?:number;pushes?:number}|null>){
  if(this.sending||!this.snapshot().active)return;this.sending=true;
  try{const s=this.load(),session=s.sessionId;for(const event of [...s.queue].slice(0,5)){
    if(s.sessionId!==session||!this.snapshot().active)break;
    const result=await send(event);if(s.sessionId!==session||!this.snapshot().active)break;
    if(!result?.ok||result.pending){s.message='Delivery is pending. Echo will retry while this Mac is online.';this.save();break;}
    if(!result.recipients){s.message='No connected phone received this update. Open Echo Phone and reconnect to your Mac.';this.save();break;}
    s.queue=s.queue.filter(e=>e.id!==event.id);s.lastDeliveredAt=this.now();s.message=result.pushes?'Delivered to Phone Missions and phone notifications.':'Delivered to Phone Missions. Enable notifications there for alerts.';this.save();
  }}finally{this.sending=false;}
 }
}
