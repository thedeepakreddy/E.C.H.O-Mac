import {currentAgentRunContext} from '../agent-replay/context.js';
import {randomUUID,createHash} from 'node:crypto';
import {appConditionMatches,calculatorExpression,nativeWindow,finderDesktopAfterClose,type AppCondition} from './app-verification.js';
import {stableWindowChromeTarget} from './native-observation.js';
import {createNativeAppObservation,nativeAppInputRisk,type NativeAppRiskAssessment} from '../safety/native-app-risk.js';
import {launchEchoApp} from './app-launch.js';
import {run} from './shell.js';

export interface LcuResult {content:Array<{type:string;text?:string;[key:string]:unknown}>;isError?:boolean;[key:string]:unknown}
export interface LcuClient {
 connect():Promise<unknown>;
 readonly instructions:string;
 publicTools():unknown[];
 call(name:string,args:{code:string},owner:LcuOwner):Promise<LcuResult>;
 turnEnded(owner:LcuOwner&{event:'Stop'|'Interrupt'}):Promise<unknown>;
 close():Promise<void>;
}
export interface LcuOwner {sessionId:string;turnId:string;actorId:string;background:boolean;signal?:AbortSignal}
export class LcuRuntimeError extends Error {constructor(readonly result:LcuResult){super('LCU runtime refused or failed this operation: '+result.content.filter(c=>c.type==='text').map(c=>c.text??'').join('\n').slice(0,1200));}}
export class LcuInputUncertainError extends Error {constructor(cause:unknown){super('LCU input outcome is uncertain; resolve the observed state before retrying. '+String((cause as Error)?.message??cause),{cause});}}
type Point=[number,number];
export type LcuAction = ({kind:'launch'}|{kind:'inspect';screenshot?:boolean}|{kind:'verify';condition:AppCondition}|{kind:'move';to:Point}|{kind:'click';target:number|Point;button?:'left'|'right'|'middle';count?:number}|{kind:'drag';from:Point;to:Point}|{kind:'scroll';target:number|Point;direction:'up'|'down'|'left'|'right';pages:number}|{kind:'type';text:string}|{kind:'press';key:string}|{kind:'set';index:number;value:string})&{observationId?:string};
const protectedApps=new Set(['echo','echo mac','chatgpt','codex','terminal','iterm','iterm2','electron','com.electron.electron','com.echo.mac','com.echo.app','com.openai.codex','com.apple.terminal','com.googlecode.iterm2']);
export function protectLcuApps(apps:string[]):void{for(const app of apps)if(app.trim())protectedApps.add(app.trim().toLowerCase().replace(/^.*\//,'').replace(/\.app$/,''));}
const json=JSON.stringify;
function coordinateAction(action:LcuAction):boolean{return action.kind==='drag'||(action.kind==='click'||action.kind==='scroll')&&Array.isArray(action.target);}
function visualFingerprint(result:LcuResult):string|undefined {
 const images=result.content.filter(block=>block.type==='image'&&typeof block.data==='string').map(block=>({data:block.data,mimeType:block.mimeType}));
 return images.length?createHash('sha256').update(JSON.stringify(images)).digest('hex'):undefined;
}
function nativeIdentity(result:LcuResult):string {
 const meta=result._meta as {appId?:unknown;'codex/toolSurface'?:{app?:unknown}}|undefined;
 return JSON.stringify([result.appId??null,meta?.appId??null,meta?.['codex/toolSurface']?.app??null]);
}
function pointOrIndex(value:number|Point):void {
 if(typeof value==='number'){if(Number.isSafeInteger(value)&&value>=0)return;}
 else if(Array.isArray(value)&&value.length===2&&value.every(n=>typeof n==='number'&&Number.isFinite(n)))return;
 throw Error('Invalid LCU target: use a fresh native element index or finite coordinate pair.');
}
function actionCode(action:LcuAction):string {
 switch(action.kind){
  case 'launch':return '';
  case 'inspect':return 'await echoLcuApp.getAXState({disableDiffing:true});';
  case 'verify':{
   if(!action.condition||!['visible','text','window_closed'].includes(action.condition.kind))throw Error('Unsupported app verification condition.');
   if(action.condition.kind==='text'&&(!Number.isSafeInteger(action.condition.index)||action.condition.index<0||typeof action.condition.expected!=='string'||!action.condition.expected.trim()||action.condition.expected.length>8000))throw Error('App text verification requires a native index and nonempty exact expected value.');
   if(action.condition.kind==='window_closed'&&(typeof action.condition.title!=='string'||!action.condition.title.trim()||action.condition.title.length>8000))throw Error('Window closure verification requires its exact original native title.');
   return '';
  }
  case 'move':pointOrIndex(action.to);if(!Array.isArray(action.to))throw Error('Pointer movement needs coordinate pairs.');return '';
  case 'click':{
   pointOrIndex(action.target);
   if(action.button!==undefined&&!['left','right','middle'].includes(action.button))throw Error('Invalid LCU mouse button.');
   if(action.count!==undefined&&(!Number.isSafeInteger(action.count)||action.count<1||action.count>2))throw Error('Invalid LCU click count.');
   return `await echoLcuApp.click(${json(action.target)},${json({mouseButton:action.button,clickCount:action.count})});`;
  }
  case 'drag':pointOrIndex(action.from);pointOrIndex(action.to);if(!Array.isArray(action.from)||!Array.isArray(action.to))throw Error('Drag needs coordinate pairs.');return `await echoLcuApp.drag(${json(action.from)},${json(action.to)});`;
  case 'scroll':pointOrIndex(action.target);if(!['up','down','left','right'].includes(action.direction)||!Number.isFinite(action.pages)||action.pages<=0||action.pages>20)throw Error('Invalid LCU scroll.');return `await echoLcuApp.scroll(${json(action.target)},${json(action.direction)},${json(action.pages)});`;
  case 'type':if(typeof action.text!=='string'||action.text.length>12000)throw Error('Invalid LCU text.');return `await echoLcuApp.typeText(${json(action.text)});`;
  case 'press':if(typeof action.key!=='string'||!action.key.trim()||action.key.length>128)throw Error('Invalid LCU key chord.');return `await echoLcuApp.pressKey(${json(action.key)});`;
  case 'set':pointOrIndex(action.index);if(typeof action.index!=='number'||typeof action.value!=='string'||action.value.length>12000)throw Error('Invalid LCU field value.');return `await echoLcuApp.setValue(${json(action.index)},${json(action.value)});`;
  default:throw Error('This action is unsupported by the current LCU Mac API. No legacy input or simulated click was used.');
 }
}

/** Typed Echo-only recipes, not a model-visible JavaScript escape hatch.
 * Source: https://github.com/amontlabs/lcu/blob/main/docs/ADAPTERS.md#shared-client-contract
 * App methods are checked against the installed @oai/cua App declaration.
 */
export class EchoLcuSession {
 private ready?:Promise<void>;
 private queue:Promise<unknown>=Promise.resolve();
 private target?:string;
 private binding?:LcuResult;
 private observation?:{id:string;text:string;visual?:string;result:LcuResult};
 private state:'active'|'cleanup'|'closed'='active';
 private readonly owner:LcuOwner;
 private readonly cancellation=new AbortController();
 private ending?:Promise<void>;
 private ranCall=false;
 private inputCount=0;
 private closeReceipt?:{title:string;app:string};
 private proof?:{kind:'visible'|'text'|'pointer'|'window_closed';app:string;nativeAppName?:string;condition?:AppCondition;expression?:string;observationId:string;inputCount:number;at:number};
 get completionProof(){const proof=this.proof;if(!proof)return undefined;return this.state==='active'&&!this.owner.signal?.aborted&&proof.observationId===this.observation?.id&&Date.now()-proof.at<120000?proof:undefined;}
 inputRisk(app:string,action:LcuAction):NativeAppRiskAssessment|undefined {
  const observed=this.observation;
  if(this.state!=='active'||this.owner.signal?.aborted||this.target!==app||!observed||observed.id!==action.observationId)return undefined;
  return nativeAppInputRisk(app,action,createNativeAppObservation(app,observed.result,observed.id,this.binding));
 }
 constructor(private readonly client:LcuClient,owner:LcuOwner,private readonly deliver:(surface:{instructions:string;tools:unknown[]})=>Promise<void>,private readonly pointerMove?:(app:string,to:Point,signal?:AbortSignal)=>Promise<LcuResult>,private readonly originalResult:(result:LcuResult)=>void=()=>{},private readonly launch:typeof run=run){
  if(!owner.sessionId||!owner.turnId||!owner.actorId||owner.background)throw Error('LCU requires an actual Echo foreground owner.');
  this.owner=Object.freeze({...owner,signal:owner.signal?AbortSignal.any([owner.signal,this.cancellation.signal]):this.cancellation.signal});
 }
 execute(app:string,action:LcuAction,owner:LcuOwner=this.owner):Promise<LcuResult>{
  if(owner.background||currentAgentRunContext()?.identity.background)return Promise.reject(Error('Background office agents cannot use LCU.'));
  if(owner.actorId!==this.owner.actorId||owner.turnId!==this.owner.turnId||owner.sessionId!==this.owner.sessionId)return Promise.reject(Error('LCU owner or turn changed.'));
  if(this.state!=='active')return Promise.reject(Error('LCU session is closed or awaiting cleanup.'));
  if(this.owner.signal?.aborted)return Promise.reject(Error('Echo computer action was cancelled.'));
  if(typeof app!=='string'||!app.trim()||app.length>512||protectedApps.has(app.trim().toLowerCase().replace(/^.*\//,'').replace(/\.app$/,'')))return Promise.reject(Error('The Echo host, approval UI or a protected app cannot be controlled.'));
  let code:string;try{code=actionCode(action);if(action.kind==='move'&&!this.pointerMove)throw Error('Free movement requires the guarded Echo pointer extension; it is unsupported by LCU alone.');}catch(error){return Promise.reject(error);}
  const work=this.queue.then(async()=>{
   this.assertActive();
   this.proof=undefined;
   if(action.observationId&&action.observationId!==this.observation?.id)throw Error('Stale LCU observation. Inspect the app and use its new observationId.');
   let inputDispatched=false;
   try{
   this.ready??=(async()=>{await this.client.connect();const tools=this.client.publicTools();if(tools.length!==2||(tools as Array<{name?:string}>).some(t=>!['js','js_reset'].includes(t.name??'')))throw Error('LCU public tool surface changed.');await this.deliver({instructions:this.client.instructions,tools});})();
   await this.ready;
   this.assertActive();
   let binding:LcuResult|undefined;
   if(action.kind==='launch'||this.target!==app){
    const select=()=>this.call(`var echoLcuApp = await cua.getApp(${json(app)});`);
    binding=action.kind==='launch'?await launchEchoApp(app,async(bin,args)=>{this.assertActive();const result=await this.launch(bin,args);this.assertActive();return result;},select):await select();
    this.binding=binding;this.target=app;this.observation=undefined;this.closeReceipt=undefined;
   }
   this.assertActive();
   const needsVisual=coordinateAction(action);
   const observe=needsVisual||action.kind==='inspect'&&action.screenshot?'await echoLcuApp.getAXStateAndScreenshot({disableDiffing:true});':'await echoLcuApp.getAXState({disableDiffing:true});';
   const fresh=await this.call(observe);
   const text=JSON.stringify(fresh.content.filter(block=>block.type==='text'));
   const visual=visualFingerprint(fresh);
   const previous=this.observation;
   const stableChrome=previous&&action.kind==='click'&&typeof action.target==='number'&&stableWindowChromeTarget(previous.result,fresh,action.target);
   const identityChanged=previous&&nativeIdentity(previous.result)!==nativeIdentity(fresh);
   const routineChanged=previous&&this.inputRisk(app,action)?.decision==='allow'&&nativeAppInputRisk(app,action,createNativeAppObservation(app,fresh,previous.id,this.binding)).decision!=='allow';
   if(action.kind==='inspect'||action.kind==='launch'||binding||!previous||identityChanged||routineChanged||previous.text!==text&&!stableChrome||needsVisual&&(!previous.visual||!visual||previous.visual!==visual)){
    this.observation={id:randomUUID(),text,visual,result:fresh};
    const result=binding?{...fresh,content:[...binding.content,...fresh.content],lcuResults:[binding,fresh]}:fresh;
    return {...result,observationId:this.observation.id,...(action.kind!=='inspect'&&action.kind!=='launch'?{lcuActionStatus:'observation_required'}:{})};
   }
   this.assertActive();
   // Read-back is evidence for the next decision, not proof of the user's goal.
   if(action.kind==='verify'){
    const window=nativeWindow(fresh);
    const verified=action.condition.kind==='window_closed'
     ?!!this.closeReceipt&&this.closeReceipt.title===action.condition.title&&finderDesktopAfterClose(fresh,this.closeReceipt)
     :appConditionMatches(fresh,action.condition);
    if(verified)this.proof={kind:action.condition.kind,app,nativeAppName:window?.app,condition:action.condition,expression:calculatorExpression(fresh),observationId:previous.id,inputCount:this.inputCount,at:Date.now()};
    return {...fresh,observationId:previous.id,appConditionVerified:verified};
   }
   const script=`${code}\n${observe}`;
    this.closeReceipt=undefined;
    const beforeWindow=nativeWindow(fresh);
    const closeTarget=action.kind==='click'&&typeof action.target==='number'&&(!action.button||action.button==='left')&&(!action.count||action.count===1)&&stableWindowChromeTarget(fresh,fresh,action.target)&&fresh.content.some(block=>block.type==='text'&&new RegExp(`^\\s*${action.target} close button(?:$| )`,'m').test(block.text??''));
    let result:LcuResult;
    if(action.kind==='move'){inputDispatched=true;result=await this.pointerMove!(app,action.to,this.owner.signal);this.originalResult(result);}
    else result=await this.call(script,()=>{inputDispatched=true;});
    this.inputCount++;
    if(closeTarget&&beforeWindow)this.closeReceipt=beforeWindow;
    this.observation={id:randomUUID(),text:action.kind==='move'?text:JSON.stringify(result.content.filter(block=>block.type==='text')),visual:action.kind==='move'?visual:visualFingerprint(result),result:action.kind==='move'?fresh:result};
    if(action.kind==='move')this.proof={kind:'pointer',app,observationId:this.observation.id,inputCount:this.inputCount,at:Date.now()};
    return {...result,observationId:this.observation.id,inputDispatched:true};
   }catch(error){this.target=undefined;this.observation=undefined;this.closeReceipt=undefined;this.state='cleanup';throw inputDispatched?new LcuInputUncertainError(error):error;}
  });
  this.queue=work.catch(()=>{});return work;
 }
 private async call(code:string,onDispatch?:()=>void):Promise<LcuResult>{
  this.assertActive();this.ranCall=true;
  onDispatch?.();
  const result=await this.client.call('js',{code},this.owner);
  if(!result||!Array.isArray(result.content))throw Error('LCU runtime returned an invalid result.');
  this.originalResult(result);
  if(result.isError)throw new LcuRuntimeError(result);
  return result; // Preserve original content, images and metadata unchanged.
 }
 private assertActive():void {
  if(this.state!=='active')throw Error('LCU session is closed or awaiting cleanup.');
  if(this.owner.signal?.aborted)throw Error('Echo computer action was cancelled.');
 }
 end(event:'Stop'|'Interrupt'):Promise<void>{
  if(this.state==='closed')return Promise.resolve();
  if(this.ending)return this.ending;
  this.state='cleanup';this.cancellation.abort();
  const work=(async()=>{
   await this.queue;
   if(this.ranCall)await this.client.turnEnded({...this.owner,event});
   await this.client.close();this.target=undefined;this.observation=undefined;this.state='closed';
  })();
  this.ending=work;void work.finally(()=>{if(this.ending===work)this.ending=undefined;}).catch(()=>{});return work;
 }
}
