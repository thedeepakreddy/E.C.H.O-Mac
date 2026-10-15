import type {LcuResult} from './lcu-session.js';
export type AppCondition={kind:'visible'}|{kind:'text';index:number;expected:string}|{kind:'window_closed';title:string};
/** One exact native window header, never a title inferred from body text/OCR. */
export function nativeWindow(result:LcuResult):{title:string;app:string}|undefined {
 if(result.isError)return undefined;
 const headers=result.content.filter(block=>block.type==='text').flatMap(block=>(block.text??'').split('\n')).filter(line=>line.startsWith('Window: '));
 if(headers.length!==1)return undefined;
 const header=headers[0].match(/^Window: (.+), App: (.+?)(?:\.)?$/);
 if(!header)return undefined;
 let title=header[1];
 if(title.startsWith('"')){if(!title.endsWith('"'))return undefined;title=title.slice(1,-1);}
 const app=header[2];
 return title.trim()&&app.trim()?{title,app}:undefined;
}
/** The supported macOS API has no all-window inventory. A changed front title
 * alone is therefore insufficient. Only Finder's native desktop fallback is
 * currently accepted after its exact Close receipt; other apps fail closed.
 */
export function finderDesktopAfterClose(result:LcuResult,original:{title:string;app:string}):boolean {
 const current=nativeWindow(result),text=result.content.filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
 return original.app==='Finder'&&original.title!=='Desktop'&&current?.app==='Finder'&&current.title==='Desktop'
  &&/^0 scroll area \(disabled\) desktop$/m.test(text)&&/^\s+\d+ container desktop$/m.test(text)
  &&!/^\s*\d+ (?:standard window|dialog|sheet|alert)\b/m.test(text);
}
export function calculatorExpression(result:LcuResult):string|undefined {
 const lines=result.content.filter(block=>block.type==='text').flatMap(block=>(block.text??'').split('\n'));
 const view=lines.findIndex(line=>/\bID: StandardResultView\b/.test(line));
 if(view<0)return undefined;
 const depth=lines[view].match(/^\s*/)?.[0].length??0;
 for(let i=view+1;i<lines.length;i++){
  if((lines[i].match(/^\s*/)?.[0].length??0)<=depth)break;
  const match=lines[i].match(/^\s*\d+ text (.*)$/);if(match)return match[1];
 }
 return undefined;
}
/** Compare an exact native text node, not a substring anywhere on the screen.
 * A Calculator digit button or history expression is never its result field. */
export function appConditionMatches(result:LcuResult,condition:AppCondition):boolean {
 // Window disappearance alone has no causal proof. The owning session must
 // also hold its trusted native close-button receipt and a fresh read-back.
 if(condition.kind==='window_closed')return false;
 const text=result.content.filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
 const native=nativeWindow(result);
 if(!native)return false;
 if(condition.kind==='visible')return true;
 const lines=text.split('\n');
 const hits=lines.map((line,index)=>({line,index,match:line.match(/^(\s*)(\d+) text (.*)$/)}))
  .filter(row=>row.match&&Number(row.match[2])===condition.index);
 if(hits.length!==1)return false;
 const hit=hits[0];
 const normalize=(value:string)=>value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim();
 if(normalize(hit.match![3])!==normalize(condition.expected))return false;
 if(/calculator/i.test(native.app)){
  let depth=hit.match![1].length;
  for(let n=hit.index-1;n>=0;n--){
   const ancestor=lines[n].match(/^(\s*)\d+ (.*)$/);
   if(!ancestor||ancestor[1].length>=depth)continue;
   if(/\bID: StandardInputView\b/.test(ancestor[2]))return true;
   depth=ancestor[1].length;
  }
  return false;
 }
 return true;
}
