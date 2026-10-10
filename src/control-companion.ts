import { memoryService, type MemoryService } from './memory/service.js';
import { scopeMatches } from './memory/policy.js';
import { forgetEverywhere } from './memory/deletion.js';
import { captureAllowed } from './memory/capture-policy.js';
import type { MemoryScope } from './memory/types.js';
import { scrubSecrets } from './safety/redact.js';

export interface CompanionWork {
  id: string; kind: 'task'|'project'|'mission'|'session'; title: string; status: string;
  updatedAt: number; revision: number; summary: string; privateMode: boolean;
  question?: {id:string;text:string;options:string[]}; taskId?:string; linkedTaskIds?:string[]; live?:boolean;
}
export interface CompanionApproval {id:string;question:string;expiresAt:number}
export const activeWork = (status:string) => ['running','working','queued','waiting','verifying','planning','clarifying','implementing','previewing','deploying','waiting-for-input','pending'].includes(status);
export const attentionWork = (status:string) => ['failed','blocked','partial','waiting','waiting-for-input'].includes(status);
const clip = (v:unknown,n=1000) => scrubSecrets(String(v??'')).slice(0,n);

/** Local owner view only. Parent/project rows replace linked worker tasks. */
export function companionProjection(input: {work:CompanionWork[]; approval:CompanionApproval|null; now?:number}) {
  const now=input.now??Date.now();
  const projectLinks=new Set(input.work.filter(w=>w.kind==='project').flatMap(w=>[w.taskId,...(w.linkedTaskIds??[])]).filter(Boolean));
  const linked=new Set(input.work.filter(w=>w.kind==='project'||w.kind==='mission').flatMap(w=>[w.taskId,...(w.linkedTaskIds??[])]).filter(Boolean));
  const work=input.work.filter(w=>w.kind!=='task'||!linked.has(w.id)).filter(w=>w.kind!=='mission'||!projectLinks.has(w.taskId??w.id)).filter(w=>activeWork(w.status)||now-w.updatedAt<7*86400_000)
    .sort((a,b)=>Number(activeWork(b.status))-Number(activeWork(a.status))||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)).slice(0,40)
    .map(w=>({...w,title:clip(w.title,300),summary:clip(w.summary),question:w.question?{...w.question,text:clip(w.question.text),options:w.question.options.map(x=>clip(x,200))}:undefined}));
  const approval=input.approval&&input.approval.expiresAt>now?{...input.approval,question:clip(input.approval.question)}:null;
  const needs=work.filter(w=>w.question||attentionWork(w.status)||w.live===false&&activeWork(w.status));
  const running=work.filter(w=>activeWork(w.status)&&!w.question&&w.live!==false);
  const next=approval?'An action is waiting for your decision.':needs.length?`Resolve ${needs[0].title}.`:running.length?`${running[0].title}: ${running[0].live===false?'inspect saved progress before continuing':running[0].status}.`:work.length?'Review your latest result or tell Echo what to do next.':'Tell Echo what you want to get done. Your real work will appear here.';
  return {checkedAt:now,approval,work,needs,now:running,next};
}
export function companionMemory(scope:MemoryScope,query='',store:MemoryService=memoryService) {
  if(typeof query!=='string'||query.length>500)throw new Error('Search using up to 500 characters.');
  const rows=store.list(scope,{includeInactive:true,query:query.trim()}).filter(m=>m.source.origin==='real'&&m.status!=='deleted'&&m.layer!=='tool'&&m.layer!=='working');
  return {scope,revision:store.revision(),total:rows.length,items:rows.slice(-100).reverse().map(m=>({id:m.id,revision:m.revision,summary:m.summary,kind:m.kind,layer:m.layer,status:m.status,source:m.source.kind,trust:m.source.trust,evidence:m.source.evidenceRefs.slice(0,8),createdAt:m.createdAt,observedAt:m.observedAt,confidence:m.confidence,privacy:m.privacy.modelAccess,scope:m.scope}))};
}
export function saveCompanionMemory(input:{id?:string;revision?:number;text?:string;kind?:string},scope:MemoryScope,store:MemoryService=memoryService) {
  if(!captureAllowed())throw new Error('This conversation is private. Save a note after ending private work.');
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000)throw new Error('Write a memory in up to 12,000 characters.');
  const previous=input.id?store.get(input.id):undefined;
  if(input.id&&(!previous||!scopeMatches(previous.scope,scope)||previous.status==='deleted'||['working','tool'].includes(previous.layer)))throw new Error('This memory is no longer available in this scope.');
  if(previous&&previous.revision!==input.revision)throw new Error('This memory changed. Refresh before correcting it.');
  const kinds=['note','preference','decision','commitment'];
  const memory=store.propose({...previous,layer:previous?.layer??'semantic',kind:previous?.kind??(kinds.includes(input.kind??'')?input.kind!:'note'),summary:input.text.trim(),scope:previous?.scope??scope,
    expectedRevision:previous?.revision,status:'active',embedding:undefined,observedAt:new Date().toISOString(),lastVerifiedAt:undefined,confidence:null,confidenceBasis:'Explicit user statement; not independently verified',
    source:{...previous?.source,kind:'user',origin:'real',trust:'user_asserted',modelOrToolVersion:undefined},privacy:previous?.privacy});
  if(!memory)throw new Error('Memory was not saved because capture is suppressed in this scope.');
  return memory;
}
export function forgetCompanionMemory(input:{id?:string;revision?:number},scope:MemoryScope) {
  const item=input.id?memoryService.get(input.id):undefined;
  if(!item||!scopeMatches(item.scope,scope))throw new Error('This memory is no longer available in this scope.');
  if(item.revision!==input.revision)throw new Error('This memory changed. Refresh before forgetting it.');
  return forgetEverywhere({ids:[item.id],scope});
}
/** Whole direct commands only: quoted examples, questions and negations cannot enable delivery. */
export function phoneUpdateIntent(text:string):'start'|'stop'|null {
  const t=text.toLowerCase().replace(/[’']/g,'').replace(/[.,!?]/g,'').replace(/\s+/g,' ').trim().replace(/^(?:echo |please )/,'');
  if(/^(?:stop sending (?:me )?updates to my phone|stop phone updates|dont send (?:me )?updates to my phone)$/.test(t))return 'stop';
  if(/^(?:send me updates (?:to|on) my phone|keep me updated on my phone|im leaving(?: send me updates (?:to|on) my phone)?|i am leaving(?: send me updates (?:to|on) my phone)?)$/.test(t))return 'start';
  return null;
}
