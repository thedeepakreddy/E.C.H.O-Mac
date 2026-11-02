import type {TaskCoordinator,TaskState} from '../memory/task-state.js';
import type {MissionTaskState} from './swarm.js';

/** This selector cannot collide with coordinator call IDs (which exclude @). */
export const RETRY_EVIDENCE_CALL_ID='@retry-evidence';
const MANIFEST_LIMIT=24000;
const excerpt=(value:unknown,limit=512)=>{
 const original=typeof value==='string'?value:JSON.stringify(value??null);
 return {excerpt:original.slice(0,limit),totalChars:original.length};
};
/** Compare complete scopes, not only their project IDs, independent of key order. */
export function retryScopeKey(value:unknown):string {
 if(Array.isArray(value))return `[${value.map(retryScopeKey).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${retryScopeKey(v)}`).join(',')}}`;
 return JSON.stringify(value)??'null';
}
const sourceIdentity=(state:TaskState)=>({taskId:state.taskId,ownerActorId:state.ownerActorId,createdAt:state.createdAt,parentTaskId:state.parentTaskId,scope:state.scope});
export function retrySourceIdentityMatches(state:TaskState):boolean {
 return !!state.bindings.retryEvidenceOwner&&retryScopeKey(state.bindings.retryEvidenceOwner)===retryScopeKey(sourceIdentity(state))
  &&Object.values(state.calls).every(call=>call.actorId===state.ownerActorId);
}
function evidenceInventory(state:TaskState) {
 return {schemaVersion:1,taskId:state.taskId,goal:state.goal,progress:state.bindings.retryEvidenceProgress??null,
  calls:Object.values(state.calls).map(call=>({taskId:state.taskId,callId:call.callId,tool:call.tool,status:call.status,effect:call.effect,
   original:{sourceTaskId:state.taskId,callId:call.callId,offset:0,limit:6000}})),artifacts:state.artifacts,observations:Object.values(state.observations)};
}
/** Frozen saved inventory; late observations cannot shift character-page offsets. */
export function retryEvidenceOriginal(state:TaskState):string {
 return JSON.stringify(state.bindings.retryEvidenceInventory??evidenceInventory(state));
}
type PreviewPage={items:unknown[];totalItems:number;nextIndex:number|null};
const page=(totalItems:number):PreviewPage=>({items:[],totalItems,nextIndex:totalItems?0:null});
/** Owner-written progress only; never accept recovery context from the UI. */
export function savedAgentProgress(task:MissionTaskState,coordinator:TaskCoordinator) {
 const sources=[...new Set([...(task.retrySourceTaskIds??[]),...(task.taskId?[task.taskId]:[])])];
 const states=sources.map(id=>coordinator.get(id)).filter(s=>s!==null);
 if(states.length!==sources.length)throw Error('Saved tool history is unavailable. Review existing changes before starting a follow-up; Retry cannot safely continue this task.');
 const anchor=states.find(state=>state.taskId===task.taskId);
 if(states.length&&(!anchor||(task.actorId&&anchor.ownerActorId!==task.actorId)||states.some(state=>state.privateMode||retryScopeKey(state.scope)!==retryScopeKey(anchor.scope)
  ||Object.values(state.calls).some(call=>call.actorId!==state.ownerActorId)
  ||(state.bindings.retryEvidenceOwner&&!retrySourceIdentityMatches(state)))))throw Error('Saved retry evidence ownership, scope or privacy changed. Review it before continuing.');
 if(states.some(s=>Object.values(s.calls).some(c=>c.effect!=='observation'&&c.effect!=='internal'&&!['success','denied'].includes(c.status))))throw Error('An external action has an uncertain outcome. Review and verify it before continuing; Retry will not repeat it blindly.');
 const progress={lastProgress:task.draft,previousResult:task.result,appliedUpdates:task.updates?.filter(c=>c.operation==='update'&&c.status==='applied').map(c=>c.text)};
 // Host-only bindings pin the original owner and retain omitted progress for retrieval.
 for(const state of states)if(!state.bindings.retryEvidenceOwner)coordinator.bind(state.taskId,'retryEvidenceOwner',sourceIdentity(state));
 if(anchor)coordinator.bind(anchor.taskId,'retryEvidenceProgress',progress);
 for(const state of states)if(state.taskId===anchor?.taskId||!state.bindings.retryEvidenceInventory)
  coordinator.bind(state.taskId,'retryEvidenceInventory',evidenceInventory(coordinator.get(state.taskId)!));
 const manifest={schemaVersion:1,sourceTaskIds:sources,totalTasks:states.length,previousTaskId:task.taskId,
  lastProgress:excerpt(progress.lastProgress),previousResult:excerpt(progress.previousResult),appliedUpdates:excerpt(progress.appliedUpdates),
  paging:'Preview nextIndex counts items; read_tool_result original pointers use character offset. Paginate until nextOffset is null; concatenate before parsing JSON.',
  sources:states.map(state=>({taskId:state.taskId,ownerActorId:state.ownerActorId,goal:excerpt(state.goal,256),
   calls:page(Object.keys(state.calls).length),artifacts:page(state.artifacts.length),observations:page(Object.keys(state.observations).length),
   original:{sourceTaskId:state.taskId,callId:RETRY_EVIDENCE_CALL_ID,offset:0,limit:6000}}))};
 if(JSON.stringify(manifest).length>MANIFEST_LIMIT)throw Error('Retry evidence has too many source identifiers for a safe bounded manifest. Review the original task journals.');
 // Round-robin bounded previews keep every category represented. Never cut serialized JSON.
 const previews=states.flatMap((state,index)=>[
  {page:manifest.sources[index].calls,items:Object.values(state.calls).map(call=>({taskId:state.taskId,callId:call.callId,tool:excerpt(call.tool,128),status:call.status,effect:call.effect,result:excerpt(call.result,256)}))},
  {page:manifest.sources[index].artifacts,items:state.artifacts.map((artifact,index)=>({index,...excerpt(artifact,256)}))},
  {page:manifest.sources[index].observations,items:Object.values(state.observations).map(observation=>({id:observation.id,sourceCallId:observation.sourceCallId,...excerpt(observation.value,256)}))},
 ]);
 let added=true;
 while(added){added=false;for(const preview of previews){
  const index=preview.page.items.length;if(index>=preview.items.length)continue;
  preview.page.items.push(preview.items[index]);preview.page.nextIndex=index+1<preview.items.length?index+1:null;
  if(JSON.stringify(manifest).length>MANIFEST_LIMIT){preview.page.items.pop();preview.page.nextIndex=index;continue;}
  added=true;
 }}
 return {sources,context:JSON.stringify(manifest)};
}
