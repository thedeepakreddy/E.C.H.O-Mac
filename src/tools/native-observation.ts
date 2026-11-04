import type {LcuResult} from './lcu-session.js';

function nativeText(result:LcuResult):string {
 return result.content.filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
}
/** Re-ground only unique native window chrome, never arbitrary content buttons.
 * Live status-bar values can change without changing a Close target. Coordinates,
 * sheets, dialogs, shifted indices and another window still require observation.
 */
export function stableWindowChromeTarget(before:LcuResult,after:LcuResult,index:number):boolean {
 const old=nativeText(before),fresh=nativeText(after);
 const headers=(text:string)=>text.match(/^Window: [^\n]+, App: [^\n]+$/gm)??[];
 const a=headers(old),b=headers(fresh);
 if(a.length!==1||b.length!==1||a[0]!==b[0])return false;
 if(/^\s*\d+ (?:sheet|dialog|alert)\b/m.test(old+'\n'+fresh))return false;
 const target=(text:string)=>{
  const lines=text.split('\n'),hits=lines.map((line,i)=>({line,i,match:line.match(/^(\s*)(\d+) (.*)$/)})).filter(row=>row.match&&Number(row.match[2])===index);
  if(hits.length!==1)return undefined;
  const hit=hits[0],description=hit.match![3];
  if(!/^(?:close|minimize|full screen) button(?:$| (?:Help|Secondary Actions):)/.test(description))return undefined;
  if(lines.filter(line=>line.replace(/^\s*\d+ /,'')===description).length!==1)return undefined;
  const path=[hit.line];let depth=hit.match![1].length;
  for(let i=hit.i-1;i>=0;i--){const ancestor=lines[i].match(/^(\s*)\d+ (.*)$/);if(!ancestor||ancestor[1].length>=depth)continue;path.unshift(lines[i]);depth=ancestor[1].length;}
  if(!path.some(line=>/^\s*\d+ standard window\b/.test(line)))return undefined;
  return JSON.stringify(path);
 };
 const previous=target(old);return !!previous&&previous===target(fresh);
}
