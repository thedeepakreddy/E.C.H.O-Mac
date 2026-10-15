import {z} from 'zod';
import type {ToolDef,ToolOutput} from '../registry.js';
import {echoAppAction} from '../computer-actions.js';
import type {LcuAction} from '../lcu-session.js';
const app=z.string().min(1).max(512).describe('Exact approved app name, bundle ID or path. Echo, approval UI and Terminal cannot be targeted.');
const point=z.array(z.number().finite()).length(2);
const target=z.union([z.number().int().nonnegative(),point]);
const observationId=z.string().min(1).describe('The observationId from the latest inspect_app or app action. Never reuse a stale element index or screenshot.');
async function execute(app:string,action:LcuAction):Promise<ToolOutput>{
 const result=await echoAppAction(app,action);
 return {text:result.lcuActionStatus==='observation_required'?'No input sent: the app was newly selected or its state changed. Read the original app state below, then choose a fresh target.':'LCU returned the original app observation. This is not proof that the user’s goal is complete.',
  status:result.lcuActionStatus==='observation_required'?'partial':'success',verification:'unverified',data:{observationId:result.observationId}};
}
export const LCU_TOOLS:ToolDef[]=[
 {name:'ask_app_question',description:'Pause the foreground app task for a blocking clarification, before continuing any actions. Choose the missing subject; Echo asks a host-written question rather than speaking unverified action claims. No desktop input is sent. Use only when the user must choose the app, mode, target or input value.',schema:{subject:z.enum(['app','mode','target','input'])},readOnly:true,handler:async a=>{
  const {currentAgentRunContext}=await import('../../agent-replay/context.js');
  const run=currentAgentRunContext();
  if(run?.identity.kind!=='main'||run.identity.background||!run.onAppQuestion||run.loop.hasExited)return {status:'denied',text:'No active foreground app task can ask this question.'};
  const questions:Record<string,string>={app:'Which app should I use?',mode:'Which mode should I use in the app?',target:'Which item in the app should I act on?',input:'What value should I enter in the app?'};
  const question=questions[a.subject];if(!question)return {status:'failed',text:'Choose a supported clarification subject.'};
  run.appQuestion=question;
  return {status:'success',verification:'unverified',text:'The task is paused for a user answer. No further actions may run until the answer arrives.'};
 }},
 {name:'verify_app_state',description:'Verify the final approved app state before claiming a GUI task complete. Use kind:visible only for opening an app; for changed output use kind:text with index and expected from the requested goal. For the supported Finder close check, inspect its exact original title, click its native close button once with the left button, then verify kind:window_closed with windowTitle equal to that original title and the latest observationId. The host requires a confirmed close click and Finder’s exact native Desktop fallback with no window/modal remaining in that observation. Another front title or Save dialog is insufficient. Other app closures and remaining Finder windows are not supported by this bounded proof; report unverified instead of switching to visible. Coordinates are not close proof. Calculator verification must target its current result text under StandardInputView, never a digit button or history. A changed state returns observation_required; use its fresh target. No input is sent.',schema:{app,observationId,kind:z.enum(['visible','text','window_closed']),index:z.number().int().nonnegative().optional().describe('Required for text: exact current native static-text index'),expected:z.string().min(1).max(8000).optional().describe('Required for text: exact expected value from the requested goal'),windowTitle:z.string().min(1).max(8000).optional().describe('Required for window_closed: the exact original native window title observed BEFORE the confirmed native close-button click, not the title now visible')},readOnly:true,handler:async a=>{
  if(a.kind==='window_closed'&&(typeof a.windowTitle!=='string'||!a.windowTitle.trim()))return {status:'failed',verification:'unverified',text:'Window close verification requires the exact original native windowTitle; app visibility is not close proof.'};
  const condition=a.kind==='visible'?{kind:'visible' as const}:a.kind==='window_closed'?{kind:'window_closed' as const,title:a.windowTitle}:{kind:'text' as const,index:a.index,expected:a.expected};
  const result=await echoAppAction(a.app,{kind:'verify',condition,observationId:a.observationId});
  if(result.lcuActionStatus==='observation_required')return {text:'App changed; no postcondition is verified. Read its new state and verify the exact target again.',status:'partial',verification:'unverified',data:{observationId:result.observationId}};
  if(!result.appConditionVerified)return {text:'The requested app postcondition does not match the current native state. The task is not verified.',status:'failed',verification:'unverified',data:{observationId:result.observationId}};
  const {currentAgentRunContext}=await import('../../agent-replay/context.js');
  const {taskCoordinator}=await import('../../memory/task-state.js');
  const owner=currentAgentRunContext();
  if(owner?.taskId)taskCoordinator.recordVerification(owner.taskId,[`app:${owner.recorder.runId}:${result.observationId}`]);
  return {text:'The exact native app postcondition was observed and verified. Do not substitute this for other requested requirements.',status:'success',verification:'verified',data:{observationId:result.observationId}};
 }},
 {name:'inspect_app',description:'Inspect/select an approved Mac app through LCU. Returns original app instructions, fresh accessibility indices and an observationId. Set screenshot:true for the original app-window image when AX is insufficient. Always do this BEFORE acting. Indices and coordinates belong to this app window, never to a full-desktop screenshot. Office agents cannot use this tool.',schema:{app,screenshot:z.boolean().optional()},readOnly:true,handler:a=>execute(a.app,{kind:'inspect',screenshot:a.screenshot})},
 {name:'click_in_app',description:'Click an observed native LCU element index or app-window coordinate. Requires the latest observationId. Never guess a global desktop point or click an approval dialog.',schema:{app,observationId,target,button:z.enum(['left','right','middle']).optional(),count:z.number().int().min(1).max(2).optional()},readOnly:false,handler:a=>execute(a.app,{kind:'click',observationId:a.observationId,target:a.target,button:a.button,count:a.count})},
 {name:'type_in_app',description:'Type literal text into the focused field of the inspected app through LCU. No implicit Return, clipboard paste or sending. Verify the actual result afterward.',schema:{app,observationId,text:z.string().max(12000)},readOnly:false,handler:a=>execute(a.app,{kind:'type',observationId:a.observationId,text:a.text})},
 {name:'press_app_key',description:'Press an LCU xdotool-style key chord in the inspected app (for example super+c, Return, Up or Tab). This is the only autonomous keyboard path; no AppleScript or legacy key injection.',schema:{app,observationId,key:z.string().min(1).max(128)},readOnly:false,handler:a=>execute(a.app,{kind:'press',observationId:a.observationId,key:a.key})},
 {name:'scroll_in_app',description:'Scroll an observed LCU element or app-window coordinate by pages, not pixels or simulated Page Down keys.',schema:{app,observationId,target,direction:z.enum(['up','down','left','right']),pages:z.number().positive().max(20)},readOnly:false,handler:a=>execute(a.app,{kind:'scroll',observationId:a.observationId,target:a.target,direction:a.direction,pages:a.pages})},
 {name:'drag_in_app',description:'Drag between two observed coordinates in the same approved app window through LCU. Not global-desktop coordinates.',schema:{app,observationId,from:point,to:point},readOnly:false,handler:a=>execute(a.app,{kind:'drag',observationId:a.observationId,from:a.from,to:a.to})},
 {name:'set_app_value',description:'Set a fresh native editable element index to an exact value through LCU. Does not send an extra Return or submit a form.',schema:{app,observationId,index:z.number().int().nonnegative(),value:z.string().max(12000)},readOnly:false,handler:a=>execute(a.app,{kind:'set',observationId:a.observationId,index:a.index,value:a.value})},
 {name:'move_echo_cursor',description:'Free cursor movement in global desktop points through Echo’s guarded pointer-only extension, not an LCU click or drag. Requires an approved inspected app still frontmost; respects desktop ownership, Stop and verified cursor read-back.',schema:{app,observationId,to:point},readOnly:false,handler:a=>execute(a.app,{kind:'move',observationId:a.observationId,to:a.to})},
];
/** Old cassettes retain their names/schemas, but never masquerade as live input. */
export function lcuCompatibleScreenTools(tools:ToolDef[]):ToolDef[]{
 const replacements:Record<string,string>={click:'click_in_app',click_ui_element:'click_in_app',click_text:'click_in_app',background_click:'click_in_app',drag:'drag_in_app',scroll:'scroll_in_app',set_value:'set_app_value'};
 const diagnostics:Record<string,string>={
  screenshot:'Capture a display for read-only desktop diagnostics. Its global coordinates are not LCU app-window input targets. Before any autonomous input use inspect_app; request screenshot:true there when native text is insufficient.',
  list_ui_elements:'Read legacy desktop accessibility labels for diagnostics only. These paths and centre coordinates are not LCU indices. Use inspect_app for fresh app controls and an observationId before any input.',
  read_screen_text:'Read desktop OCR text for diagnostics only. OCR coordinates are not approved LCU app-window targets. Use inspect_app before input, with screenshot:true if native text is insufficient.',
 };
 return tools.map(tool=>diagnostics[tool.name]?{...tool,description:diagnostics[tool.name]}:replacements[tool.name]?{...tool,
  description:`Retired pre-LCU input endpoint. It cannot operate user apps. Use inspect_app, then ${replacements[tool.name]} with the latest observationId and native indices/app-window coordinates. Legacy desktop coordinates and AX paths are not reusable.`,
  handler:async()=>({text:`${tool.name} is retired; no input was sent. Use inspect_app and ${replacements[tool.name]} with a fresh LCU target.`,status:'denied',verification:'unverified',error:{category:'retired_input',message:'Legacy input must be re-observed through LCU',retryable:false}})
 }:tool);
}
