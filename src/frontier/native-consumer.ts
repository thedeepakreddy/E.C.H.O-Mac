import {z} from 'zod';
import {currentAgentRunContext} from '../agent-replay/context.js';
import {currentInvocation} from '../memory/invocation.js';
import {taskCoordinator} from '../memory/task-state.js';
import type {ToolStatus} from '../memory/tool-result.js';
import type {ToolDef,ToolOutput} from '../tools/registry.js';
import type {LcuResult} from '../tools/lcu-session.js';
import {LCU_TOOLS} from '../tools/registry/lcu.js';
import {echoAppAction,frontmostApp} from '../tools/computer-actions.js';
import {createNativeAppObservation} from '../safety/native-app-risk.js';
import {runGated} from '../safety/gate.js';

export interface NativeNode {index:number;description:string;label:string;role:string}
export interface NativeSnapshot {observationId:string;result:LcuResult;nodes:NativeNode[];window:{title:string;app:string}}
export class NativeConsumerError extends Error {
  constructor(message:string,readonly status:ToolStatus='partial'){super(message);}
}
export function consumerStatus(error:unknown,progress=0):ToolStatus {
  const status=error instanceof NativeConsumerError?error.status:'failed';
  return status==='uncertain'?status:progress?'partial':status;
}
export const failureNote=(error:unknown)=>String((error as Error)?.message??error);
const textOf=(result:LcuResult)=>result.content.filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
const normal=(text:string)=>text.trim().toLowerCase().replace(/\s+/g,' ');
/** Indices are parsed ONLY from an original native LCU response, never AX/OCR. */
function nativeNodes(result:LcuResult):NativeNode[] {
  const nodes=textOf(result).split('\n').flatMap(line=>{
    const row=line.match(/^\s*(\d+) (.+)$/);if(!row)return [];
    const description=row[2],role=description.match(/^(?:close button|text field|text area|scroll area|scroll bar|pop up button|menu button|menu item|standard window|button|link|checkbox|outline|collection|row|text)\b/)?.[0]??'';
    const named=description.match(/(?:Description|Title): (.*?)(?=, (?:ID|Help|Value|Secondary Actions):|$)/)?.[1];
    const label=named??(role==='close button'?'Close':role&&description.startsWith(role+' ')?description.slice(role.length+1):'');
    return [{index:Number(row[1]),description,role,label}];
  });
  if(nodes.some(node=>!Number.isSafeInteger(node.index))||new Set(nodes.map(node=>node.index)).size!==nodes.length)
    throw new NativeConsumerError('Native indices are ambiguous. No input was sent.');
  return nodes;
}
const originals=(output:ToolOutput):LcuResult[]=>{
  const results=(output.data as {originalComputerResults?:unknown}|undefined)?.originalComputerResults;
  return Array.isArray(results)?results.filter(result=>result&&Array.isArray(result.content)):[];
};

/** A workflow is not an approval. Every exact native action crosses runGated. */
export class NativeConsumer {
  private readonly owner=currentAgentRunContext();
  private readonly ownerKey=this.owner?JSON.stringify([this.owner.taskId,this.owner.identity.id,this.owner.recorder?.runId,this.owner.conversationId]):'';
  private outputs:ToolOutput[]=[];
  private binding?:LcuResult;
  private previousWindow?:{title:string;app:string};
  private app='';
  constructor(private readonly explicitApp?:string){}
  assertActive():void {
    const run=currentAgentRunContext();
    if(!run||run.identity.background||!run.taskId||!run.recorder?.runId)throw new NativeConsumerError('Native consumers require an actual foreground owner; no screen access or input was attempted.','denied');
    if(run.toolSignal?.aborted||run.loop?.hasExited||run.appQuestion)throw new NativeConsumerError('The task stopped or is waiting for an answer. No further input was sent.','cancelled');
    if(JSON.stringify([run.taskId,run.identity.id,run.recorder.runId,run.conversationId])!==this.ownerKey)throw new NativeConsumerError('The native consumer owner changed. No further input was sent.','cancelled');
    const invocation=currentInvocation();
    if(invocation)try{taskCoordinator.assertInvocation(invocation);}catch{throw new NativeConsumerError('The task no longer owns this action. No further input was sent.','cancelled');}
  }
  private async targetApp():Promise<string> {
    this.assertActive();
    if(!this.app){const app=this.explicitApp??await frontmostApp();this.assertActive();
      if(typeof app!=='string'||!app.trim()||app.length>512)throw new NativeConsumerError('No unambiguous app reference is available. Inspect an explicit app before continuing.');
      this.app=app.trim();
    }
    return this.app;
  }
  private async call(def:ToolDef,args:Record<string,unknown>):Promise<ToolOutput> {
    this.assertActive();
    let output:ToolOutput;
    try{output=await runGated(def,args,{workingDir:process.cwd()});}
    catch(error){throw new NativeConsumerError(failureNote(error),this.owner?.toolSignal?.aborted?'cancelled':'failed');}
    this.outputs.push(output);
    if(output.status!=='success')throw new NativeConsumerError(output.text??'Native operation did not complete.',output.status??'failed');
    // Preserve a completed native return even if Stop arrived in flight.
    // Every subsequent inspect/input/wait checks the owner again before dispatch.
    return output;
  }
  private snapshot(output:ToolOutput):NativeSnapshot {
    const data=output.data as {observationId?:unknown;toolData?:{observationId?:unknown}}|undefined;
    const id=data?.toolData?.observationId??data?.observationId,results=originals(output),result=results.at(-1);
    if(!result||typeof id!=='string'||!id)throw new NativeConsumerError('The original native observation or observationId is unavailable. No target was guessed.');
    this.binding??=results[0];
    const state=createNativeAppObservation(this.app,result,id,this.binding);
    if(!state)throw new NativeConsumerError('The original native app identity is unavailable or does not match the requested app.');
    return {observationId:id,result,nodes:nativeNodes(result),window:{title:state.nativeApp.windowTitle,app:state.nativeApp.name}};
  }
  async inspect():Promise<NativeSnapshot> {
    const app=await this.targetApp();
    const output=await this.call(LCU_TOOLS.find(tool=>tool.name==='inspect_app')!,{app});
    const snapshot=this.snapshot(output);
    if(this.previousWindow&&JSON.stringify(snapshot.window)!==JSON.stringify(this.previousWindow))throw new NativeConsumerError('The app window changed since the last confirmed observation. No input was sent.');
    this.previousWindow=snapshot.window;return snapshot;
  }
  unique(snapshot:NativeSnapshot,target:string,role?:string):NativeNode {
    const nativeRole=role?.replace(/^AX/,'').replace(/TextField/,'text field').replace(/TextArea/,'text area').toLowerCase();
    const matches=snapshot.nodes.filter(node=>normal(node.label)===normal(target)&&(!nativeRole||node.role===nativeRole));
    if(matches.length!==1||/\bdisabled\b/i.test(matches[0].description))throw new NativeConsumerError(`No unique enabled native control matches "${target}". No input was sent.`);
    return matches[0];
  }
  async input(name:string,snapshot:NativeSnapshot,args:Record<string,unknown>):Promise<ToolOutput> {
    this.assertActive();
    const tool=LCU_TOOLS.find(tool=>tool.name===name);
    if(!tool||tool.readOnly)throw new NativeConsumerError('Unsupported native input recipe.','failed');
    const output=await this.call(tool,{...args,app:this.app,observationId:snapshot.observationId});
    if(!((output.data as {inputCallsReturned?:number}|undefined)?.inputCallsReturned))throw new NativeConsumerError('No native input was confirmed. Inspect the returned state before continuing.');
    try{this.previousWindow=this.snapshot(output).window;}catch{
      // Do not infer a post-window. The next consumer step must inspect again;
      // inspect() re-proves native app identity and matches the last known window.
    }
    return output;
  }
  async open(app:string):Promise<void> {
    this.assertActive();this.app=app;this.binding=undefined;this.previousWindow=undefined;
    const output=await this.call({name:'open_app',description:'Launch the explicitly recorded app through guarded LCU.',schema:{name:z.string().min(1).max(512)},readOnly:false,
      handler:async args=>{const result=await echoAppAction(args.name,{kind:'launch'});return {status:'success',verification:'unverified',text:'LCU returned the app observation; launch is not task completion.',data:{observationId:result.observationId}};}
    },{name:app});
    this.previousWindow=this.snapshot(output).window;
  }
  async pause(ms:number):Promise<void> {
    this.assertActive();if(!Number.isFinite(ms)||ms<0||ms>60000)throw new NativeConsumerError('Invalid bounded workflow wait.','failed');
    const signal=this.owner?.toolSignal;
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new NativeConsumerError('The task was cancelled while waiting.','cancelled'));};
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });this.assertActive();
  }
  evidence():Pick<ToolOutput,'computerContent'|'data'> {
    return {computerContent:this.outputs.flatMap(output=>output.computerContent??[]),data:{originalComputerResults:this.outputs.flatMap(originals),
      inputCallsReturned:this.outputs.reduce((sum,output)=>sum+((output.data as {inputCallsReturned?:number}|undefined)?.inputCallsReturned??0),0)}};
  }
}
