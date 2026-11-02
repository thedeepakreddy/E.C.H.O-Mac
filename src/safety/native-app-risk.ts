import type {RiskAssessment} from './risk.js';
import type {LcuAction,LcuResult} from '../tools/lcu-session.js';
import {nativeWindow} from '../tools/app-verification.js';
import {isCalculatorReference} from '../tools/gui-completion-policy.js';

const appNames:Record<string,string>={'com.apple.finder':'Finder','com.apple.calculator':'Calculator','com.apple.mail':'Mail','com.apple.mobilesms':'Messages','com.apple.safari':'Safari','com.google.chrome':'Google Chrome','com.apple.textedit':'TextEdit'};
const textOf=(result:LcuResult)=>result.content.filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
const confirm=(reason='Native input has no positively verified routine target.'):NativeAppRiskAssessment=>({tier:'high',decision:'confirm',reason});
const allow=(reason:string):NativeAppRiskAssessment=>({tier:'medium',decision:'allow',reason});
const deny=():NativeAppRiskAssessment=>({tier:'high',decision:'deny',reason:'Only the user may operate this permission or security control.'});
function referenceMatches(app:string,state:NativeAppObservation):boolean {
 const ref=app.trim().toLowerCase();
 return ref===state.nativeApp.name.toLowerCase()||!!state.nativeApp.bundleId&&ref===state.nativeApp.bundleId.toLowerCase()||!!state.nativeApp.path&&app===state.nativeApp.path||state.nativeApp.name==='Calculator'&&isCalculatorReference(app);
}

/** Must be constructed by the host from its current native observation, never
 * from model arguments. Missing native identity/focus is not inferred from text.
 */
export interface NativeAppObservation {
 observationId:string;
 nativeApp:{name:string;bundleId?:string;windowTitle:string;path?:string};
 result:LcuResult;
 focusedIndex?:number;
 protectedDialog?:boolean;
}
export interface NativeAppRiskAssessment extends RiskAssessment {
 decision:'allow'|'confirm'|'deny';
}

/** Identity is read from LCU appId metadata; focus is read from its native AX
 * focused-UI line. binding, if supplied, must be the host's actual getApp result.
 * Calculator alone may use an exact approved reference + native header fallback.
 */
export function createNativeAppObservation(app:string,result:LcuResult,observationId:string,binding?:LcuResult):NativeAppObservation|undefined {
 const window=nativeWindow(result);if(!window||!observationId)return undefined;
 const ids:string[]=[];let invalid=false;
 for(const value of [result,binding]){
  if(!value)continue;
  const meta=value._meta as {appId?:unknown;'codex/toolSurface'?:{app?:{kind?:unknown;appId?:unknown}}}|undefined;
  const native=meta?.['codex/toolSurface']?.app;
  if(native&&native.kind!=='appId')invalid=true;
  for(const id of [value.appId,meta?.appId,native?.appId])if(id!==undefined){if(typeof id!=='string'||!id.trim())invalid=true;else ids.push(id.toLowerCase());}
 }
 if(invalid||new Set(ids).size>1)return undefined;
 const bundleId=ids[0],expected=bundleId?appNames[bundleId]:undefined;
 if(expected&&expected!==window.app)return undefined;
 if(!bundleId&&!(window.app==='Calculator'&&isCalculatorReference(app)))return undefined;
 const focus=textOf(result).split('\n').filter(line=>line.startsWith('The focused UI element is '));
 const match=focus.length===1?focus[0].match(/^The focused UI element is (\d+) /):undefined;
 const state:NativeAppObservation={observationId,nativeApp:{name:window.app,bundleId,windowTitle:window.title},result,focusedIndex:match?Number(match[1]):undefined};
 return referenceMatches(app,state)?state:undefined;
}

/** Pure classification only. Does not grant OS/runtime permissions or execute
 * input. The session must still match this observation immediately before input.
 */
export function nativeAppInputRisk(app:string,action:LcuAction,state:NativeAppObservation|undefined):NativeAppRiskAssessment {
 if(!state||action.observationId!==state.observationId||!referenceMatches(app,state))return confirm();
 const native=nativeWindow(state.result),text=textOf(state.result);
 if(!native||native.app!==state.nativeApp.name||native.title!==state.nativeApp.windowTitle)return confirm();
 if(state.protectedDialog||/^(?:Echo|Echo Mac|Codex|ChatGPT)$/i.test(native.app)||/^\s*\d+ (?:dialog|sheet|alert)\b[^\n]*\b(?:permission|accessibility|security|allow|authorization|authentication)\b/im.test(text)||/\b(?:permission|authorization|accessibility access|security access)\b/i.test(native.title))return deny();
 if(/^\s*\d+ (?:dialog|sheet|alert)\b/m.test(text))return confirm('act on a modal dialog that may commit a change');
 const bundle=state.nativeApp.bundleId?.toLowerCase();
 if(bundle&&appNames[bundle]!==native.app||!bundle&&native.app!=='Calculator')return confirm();
 const rows=text.split('\n').map((line,i)=>({line,i,match:line.match(/^(\s*)(\d+) (.*)$/)}));
 const node=(index:unknown)=>{const matches=rows.filter(row=>row.match&&Number(row.match[2])===index);return Number.isSafeInteger(index)&&matches.length===1?matches[0]:undefined;};
 const ancestors=(row:NonNullable<ReturnType<typeof node>>)=>{
  const path:string[]=[];let depth=row.match![1].length;
  for(let i=row.i-1;i>=0;i--){const p=rows[i];if(!p.match||p.match[1].length>=depth)continue;path.push(p.match[3]);depth=p.match[1].length;}
  return path;
 };
 const risky=/\b(?:send|pay|payment|payments|purchase|buy|checkout|subscribe|delete|erase|trash|discard|publish|post|share|authorize|allow|sign in|log in|sign out|log out|transfer|place (?:your )?order)\b/i;
 const focused=node(state.focusedIndex);
 if(action.kind==='press'){
  if(typeof action.key!=='string')return confirm();
  if(native.app==='Calculator'&&/^(?:[0-9+*/=.-]|Return|KP_Enter|Escape|BackSpace|Delete)$/i.test(action.key))return allow('use an observed Calculator key');
  if(focused&&!/disabled/.test(focused.match![3])&&/^(?:Tab|shift\+Tab|Escape)$/i.test(action.key))return allow('navigate native focus without submitting');
  return confirm(`press a key chord in ${native.app} — it may send, pay or delete`);
 }
 if(action.kind==='type'||action.kind==='set'){
  const value=action.kind==='type'?action.text:action.value;
  if(typeof value!=='string'||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value))return confirm('enter text containing a submission-capable control character');
  if(native.app==='Calculator'&&action.kind==='type'&&/^[0-9+*/(). -]+$/.test(value))return allow('enter a Calculator expression without submitting');
  const target=action.kind==='set'?node(action.index):focused;
  if(!target||!focused||target!==focused||/disabled/.test(target.match![3])||!/^text (?:field|area)\b/.test(target.match![3]))return confirm();
  if(native.app==='Mail'&&/\b(?:To|Subject|Message Body|Cc|Bcc)\b/i.test(target.match![3])||native.app==='Messages'&&/\bMessage\b/i.test(target.match![3])||native.app==='TextEdit')return allow('edit a native draft without sending');
  return confirm();
 }
 if(action.kind==='move')return allow('move the guarded cursor without clicking');
 if(action.kind==='scroll'){
  const target=node(action.target);return target&&/^(?:scroll area|scroll bar|outline|collection)\b/.test(target.match![3])?allow('scroll an observed native view'):confirm();
 }
 if(action.kind!=='click'||typeof action.target!=='number'||action.button&&action.button!=='left'||action.count&&action.count!==1)return confirm();
 const target=node(action.target);if(!target||/\bdisabled\b/.test(target.match![3]))return confirm();
 const description=target.match![3],path=ancestors(target);
 if(risky.test(description))return confirm(`activate an irreversible control in ${native.app}`);
 if(path.some(value=>/^(?:web area|dialog|sheet|alert)\b/.test(value)))return confirm();
 if(/^(?:close|minimize|full screen) button\b/.test(description))return allow('operate native window chrome');
 if(native.app==='Calculator'&&/^button\b/.test(description)&&/\bDescription: (?:[0-9+*/=.-]|Add|Subtract|Multiply|Divide|Clear|All Clear|Equals|Decimal|Percent|Change Sign)(?:,|$)/i.test(description))return allow('activate an observed Calculator control');
 if(native.app==='Finder'&&(/^(?:checkbox|menu button|pop up button|tab)\b/.test(description)&&/\b(?:View|Show Sidebar|Documents|icon view|Group)\b/i.test(description)||/^button\b.*\bDescription: (?:Back|Forward|Search|Close)(?:,|$)/i.test(description)))return allow('navigate an observed Finder control');
 if(native.app==='Mail'&&/^button\b.*\bDescription: (?:Reply|Reply All|Forward|Save Draft)(?:,|$)/i.test(description))return allow('open or save a mail draft without sending');
 if(['Safari','Google Chrome'].includes(native.app)&&path.some(value=>/^toolbar\b/.test(value))&&/^button\b.*\bDescription: (?:Back|Forward|Search|Reload)(?:,|$)/i.test(description))return allow('navigate a native browser toolbar');
 return confirm();
}
