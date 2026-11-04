import {currentAgentRunContext,type AgentRunContext} from '../agent-replay/context.js';
import {acquireDesktopTask,currentDesktopTask,releaseDesktopTask} from '../tasks/desktop-lane.js';
import {EchoLcuSession,type LcuClient,type LcuAction,type LcuResult} from './lcu-session.js';
import {retainComputerResult,retainComputerObservation} from './lcu-evidence.js';
import {createPointerExtension} from './lcu-pointer.js';
import {isCalculatorReference} from './gui-completion-policy.js';
import type {NativeAppRiskAssessment} from '../safety/native-app-risk.js';
type Surface={instructions:string;tools:unknown[]};
function ownerTaskKey(context:AgentRunContext):string{return JSON.stringify([context.taskId,context.identity.id,context.conversationId??context.taskId]);}
// Literal app references only; no persisted bindings or model-provided proof.
function canonicalAppReference(app:string):string {
 return isCalculatorReference(app)?'com.apple.calculator':app.trim();
}
/** One foreground owner, including cleanup. Shares the supervised desktop lane. */
export class EchoComputerControl {
 private active?:{runId:string;taskKey:string;session:EchoLcuSession;lane:string;borrowed:boolean;cleanupEvent?:'Stop'|'Interrupt'};
 // Only host-confirmed counts survive a turn boundary, for the last 20 owners'
 // task keys. All observations and verification proofs stay session-local.
 private readonly completedInputs=new Map<string,Map<string,number>>();
 private ending?:Promise<void>;
 private closing=false;
 private closePromise?:Promise<void>;
 get busy():boolean{return this.closing||!!this.active||!!this.ending;}
 inputRisk(app:string,action:LcuAction):NativeAppRiskAssessment|undefined {
  const context=this.context(),active=this.active;
  if(this.closing||this.ending||!active||active.cleanupEvent||!context||context.identity.background||context.toolSignal?.aborted||context.loop?.hasExited||active.runId!==context.recorder.runId||active.taskKey!==ownerTaskKey(context))return undefined;
  return active.session.inputRisk(app,action);
 }
 completionProof(runId:string){
  const active=this.active;
  if(!active||active.runId!==runId)return undefined;
  const context=this.context();
  if(context&&ownerTaskKey(context)!==active.taskKey)return undefined;
  const proof=active.session.completionProof;
  return proof?{...proof,inputCount:this.completedInputs.get(active.taskKey)?.get(canonicalAppReference(proof.app))??0}:undefined;
 }
 constructor(private readonly client:LcuClient,private readonly context:()=>AgentRunContext|null=currentAgentRunContext,private readonly deliver:(surface:Surface)=>Promise<void>,private readonly pointer=createPointerExtension()){}
 execute(app:string,action:LcuAction):Promise<LcuResult>{
  if(this.closing)return Promise.reject(Error('Echo computer control is closing or closed.'));
  const context=this.context();
  if(context?.identity.background)return Promise.reject(Error('Background office agents cannot control the desktop.'));
  if(!context?.recorder?.runId||!context.taskId)return Promise.reject(Error('Computer actions require an actual Echo foreground turn owner.'));
  if(context.toolSignal?.aborted)return Promise.reject(Error('Echo computer action was cancelled.'));
  if(context.loop?.hasExited)return Promise.reject(Error('The Echo task has stopped. No new computer input is permitted.'));
  const grants:Record<LcuAction['kind'],string[]>={launch:['open_app'],inspect:['inspect_app','open_app','screenshot','list_ui_elements'],verify:['verify_app_state'],move:['move_echo_cursor','move_mouse'],click:['click_in_app','click','click_ui_element','click_text'],type:['type_in_app','type_text'],press:['press_app_key','press_keys','lock_screen','undo_last'],scroll:['scroll_in_app','scroll'],drag:['drag_in_app','drag'],set:['set_app_value','set_value']};
  if(context.allowedTools&&!grants[action.kind].some(name=>context.allowedTools!.has(name)))return Promise.reject(Error('This foreground worker has no computer-action grant.'));
  const runId=context.recorder.runId;
  const taskKey=ownerTaskKey(context);
  if(this.ending||this.active?.cleanupEvent){
   const cleanup=this.ending??this.end(this.active!.runId,this.active!.cleanupEvent!);
   return cleanup.then(()=>{if(this.context()?.recorder?.runId!==runId)throw Error('Echo foreground owner changed while waiting for cleanup.');return this.execute(app,action);});
  }
  if(this.active&&this.active.runId!==runId)return Promise.reject(Error('Another Echo turn owns the desktop. Stop it and wait for cleanup.'));
  if(this.active&&this.active.taskKey!==taskKey)return Promise.reject(Error('Echo foreground task owner changed within the same turn.'));
  if(!this.active){
   const lane=context.identity.parentTaskId??context.taskId;
   const borrowed=currentDesktopTask()===lane;
   if(!acquireDesktopTask(lane))return Promise.reject(Error('Another supervised task owns the desktop.'));
   const shared:LcuClient={connect:()=>this.client.connect(),get instructions(){return client.instructions;},publicTools:()=>this.client.publicTools(),call:(...args)=>this.client.call(...args),turnEnded:owner=>this.client.turnEnded(owner),close:async()=>{}};
   const client=this.client;
   const session=new EchoLcuSession(shared,{sessionId:context.conversationId??context.taskId,turnId:runId,actorId:context.identity.id,background:false,signal:context.toolSignal},this.deliver,this.pointer,retainComputerResult);
   this.active={runId,taskKey,session,lane,borrowed};
  }
  const active=this.active,appKey=canonicalAppReference(app);
  const inputAction=action.kind!=='inspect'&&action.kind!=='verify'&&action.kind!=='launch';
  return active.session.execute(app,action).then(result=>{
   if(!this.closing&&inputAction&&result.inputDispatched===true&&!result.isError&&result.lcuActionStatus!=='observation_required'){
    const counts=this.completedInputs.get(active.taskKey)??new Map<string,number>();
    counts.set(appKey,(counts.get(appKey)??0)+1);
    this.completedInputs.delete(active.taskKey);this.completedInputs.set(active.taskKey,counts);
    while(this.completedInputs.size>20)this.completedInputs.delete(this.completedInputs.keys().next().value!);
   }
   retainComputerObservation(result);return result;
  });
 }
 end(runId:string,event:'Stop'|'Interrupt'):Promise<void>{
  if(!this.active||this.active.runId!==runId)return Promise.resolve();
  if(this.ending)return this.ending;
  const active=this.active;
  active.cleanupEvent??=event;
  const work=active.session.end(active.cleanupEvent).then(()=>{
   // Shutdown owns the lease until transport close also succeeds. Either
   // failure leaves this controller permanently closed with its lease fenced.
   if(this.closing)return;
   if(!active.borrowed)releaseDesktopTask(active.lane);
   if(this.active===active)this.active=undefined;
  });
  this.ending=work;
  void work.finally(()=>{if(this.ending===work)this.ending=undefined;}).catch(()=>{});
  return work;
 }
 close():Promise<void>{
  if(this.closePromise)return this.closePromise;
  this.closing=true;
  this.closePromise=(async()=>{
   const errors:Error[]=[];
   try{if(this.active)await this.end(this.active.runId,'Interrupt');}
   catch(cause){errors.push(new Error('Echo LCU native session cleanup failed.',{cause}));}
   this.completedInputs.clear();
   try{await this.client.close();}
   catch(cause){errors.push(new Error('Echo LCU transport close failed.',{cause}));}
   if(errors.length===1)throw errors[0];
   if(errors.length>1)throw new AggregateError(errors,'Echo LCU close failed: native session cleanup and transport close both failed.',{cause:errors[0].cause});
   const active=this.active;
   if(active&&!active.borrowed)releaseDesktopTask(active.lane);
   this.active=undefined;
  })();
  return this.closePromise;
 }
}
let control:EchoComputerControl|undefined;
export function installEchoComputerControl(value:EchoComputerControl):void {if(control)throw Error('Echo computer control already initialized.');control=value;}
export function executeEchoComputerAction(app:string,action:LcuAction):Promise<LcuResult>{
 if(!control)return Promise.reject(Error('Echo LCU computer control is unavailable. No legacy input was used.'));
 return control.execute(app,action);
}
export function endEchoComputerTurn(runId:string,event:'Stop'|'Interrupt'):Promise<void>{return control?.end(runId,event)??Promise.resolve();}
export function echoComputerControlBusy():boolean{return control?.busy??false;}
export function echoAppCompletionProof(runId:string){return control?.completionProof(runId);}
/** Model arguments identify a proposed action only. Risk authority comes from
 * the active owner's original native observation inside the session. */
export function echoNativeInputRisk(tool:string,input:Record<string,unknown>):NativeAppRiskAssessment|undefined {
 if(typeof input.app!=='string'||typeof input.observationId!=='string')return undefined;
 const observationId=input.observationId;
 let action:LcuAction;
 switch(tool){
  case 'click_in_app':action={kind:'click',observationId,target:input.target as number|[number,number],button:input.button as 'left'|'right'|'middle'|undefined,count:input.count as number|undefined};break;
  case 'press_app_key':action={kind:'press',observationId,key:input.key as string};break;
  case 'type_in_app':action={kind:'type',observationId,text:input.text as string};break;
  case 'set_app_value':action={kind:'set',observationId,index:input.index as number,value:input.value as string};break;
  case 'scroll_in_app':action={kind:'scroll',observationId,target:input.target as number|[number,number],direction:input.direction as 'up'|'down'|'left'|'right',pages:input.pages as number};break;
  case 'drag_in_app':action={kind:'drag',observationId,from:input.from as [number,number],to:input.to as [number,number]};break;
  case 'move_echo_cursor':action={kind:'move',observationId,to:input.to as [number,number]};break;
  default:return undefined;
 }
 return control?.inputRisk(input.app,action);
}
export async function closeEchoComputerControl():Promise<void>{await control?.close();control=undefined;}
