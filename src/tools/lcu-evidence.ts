import {AsyncLocalStorage} from 'node:async_hooks';
import type {LcuResult} from './lcu-session.js';
import {LcuInputUncertainError} from './lcu-session.js';
import type {ToolOutput} from './registry.js';
interface Evidence {results:LcuResult[];inputCallsReturned:number;observation?:{observationId:unknown;lcuActionStatus:unknown}}
const evidence=new AsyncLocalStorage<Evidence>();
export function retainComputerResult(result:LcuResult):void {evidence.getStore()?.results.push(result);}
export function retainComputerObservation(result:LcuResult):void {const store=evidence.getStore();if(store){store.observation={observationId:result.observationId,lcuActionStatus:result.lcuActionStatus};if(result.inputDispatched===true)store.inputCallsReturned++;}}
/** Each tool has its own result buffer; concurrent reads cannot cross-write it. */
export async function withComputerEvidence(action:()=>Promise<ToolOutput>):Promise<ToolOutput>{
 const store:Evidence={results:[],inputCallsReturned:0};const results=store.results;
 return evidence.run(store,async()=>{
  let output:ToolOutput;
  try{output=await action();}catch(error){
   const uncertain=error instanceof LcuInputUncertainError||store.inputCallsReturned>0;
   if(!results.length&&!uncertain)throw error;
   const observationRequired=store.observation?.lcuActionStatus==='observation_required';
   const message=(store.inputCallsReturned>0?'Earlier input calls already completed; do not retry this whole operation. ':'')+String((error as Error).message??error);
   output={text:message,status:uncertain?'uncertain':observationRequired?'partial':'failed',verification:'unverified',...(observationRequired&&!uncertain?{}:{error:{category:uncertain?'unknown_native_effect':'computer_control',message,retryable:false}})};
  }
  if(!results.length)return output;
  const last=results.at(-1)!;
  return {...output,computerContent:results.flatMap(r=>r.content),data:{toolData:output.data??store.observation??{observationId:last.observationId,lcuActionStatus:last.lcuActionStatus},inputCallsReturned:store.inputCallsReturned,originalComputerResults:results}};
 });
}
export interface ComputerImageEntry {image:{data:string;mimeType:string};blockPosition:number;latest?:boolean}
export function computerImageEntries(out:ToolOutput):ComputerImageEntry[]{
 const images:ComputerImageEntry[]=out.image?[{image:{data:out.image.data,mimeType:out.image.mimeType},blockPosition:-1}]:[];
 const candidate=(out.data as {originalComputerResults?:unknown}|undefined)?.originalComputerResults;
 const originals:LcuResult[]=Array.isArray(candidate)?candidate.filter(result=>result&&Array.isArray(result.content)):[];
 let end=0;const ends=originals.map(result=>end+=result.content.length);
 (out.computerContent??[]).forEach((block,index)=>{
  if(block.type!=='image'||typeof block.data!=='string'||typeof block.mimeType!=='string')return;
  const resultIndex=ends.findIndex(end=>index<end);
  images.push({image:{data:block.data,mimeType:block.mimeType},blockPosition:index,latest:resultIndex<0?undefined:resultIndex===originals.length-1&&!originals[resultIndex].isError&&!['failed','uncertain','cancelled','timeout','denied'].includes(out.status??'')});
 });
 return images;
}
export function computerImages(out:ToolOutput):Array<{data:string;mimeType:string}>{return computerImageEntries(out).map(entry=>entry.image);}
export function computerImageLabel(entry:ComputerImageEntry,out:ToolOutput,providerCallId?:string):string {
 const observation=(out.data as {toolData?:{observationId?:string}}|undefined)?.toolData?.observationId;
 return `Image block ${entry.blockPosition} from tool call ${providerCallId??out.callId??'unknown'}${out.callId?` (host ${out.callId})`:''}${observation?`; observation ${observation}`:''}. ${entry.latest===true?'Latest returned observation.':entry.latest===false?'Earlier state in this call; do not use it for current coordinates.':'State provenance unavailable; inspect before using coordinates.'}`;
}
