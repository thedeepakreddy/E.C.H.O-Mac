import {join} from 'node:path';import {getAppPath} from '../utils/appPath.js';import {getSession,mutateSession} from './session.js';import {startProcess,readProcess,stopProcess} from './processes.js';import {detectRecipe} from './recipes.js';import type {BrowserWindow} from 'electron';
import {scrubSecrets} from '../safety/redact.js';
import {projectFingerprint} from './snapshot.js';
import {recordAcceptance} from './diagnostics.js';
interface Preview {projectId:string;processId:string;url:string;window?:BrowserWindow;console:string[];network:string[];}
const previews=new Map<string,Preview>();
export function localPreviewURL(value:string):string{const url=new URL(value);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new Error('Preview requires a loopback HTTP URL.');return url.href;}
export async function startProjectPreview(id:string,revision:number){
 const session=getSession(id);const existing=previews.get(id);if(existing&&(await readProcess(id,existing.processId)).status==='running')return {processId:existing.processId,url:existing.url,reused:true};
 // Recover only an owned, identity-checked server whose recorded output names
 // the saved loopback URL. Restarting Echo must not launch duplicate servers.
 for(const artifact of session.artifacts.filter(a=>a.kind==='local-preview').slice(-5).reverse()){
  let url:string;try{url=localPreviewURL(artifact.value);}catch{continue;}
  for(const processId of session.processIds.slice(-10).reverse()){
   try{const state=await readProcess(id,processId,0,12000);if(state.status!=='running'||!state.output.includes(url.replace(/\/$/,'')))continue;
    if(!(await fetch(url,{signal:AbortSignal.timeout(1000)})).ok)throw new Error('Owned preview server is not HTTP-ready. Inspect its process before restarting.');
    previews.set(id,{projectId:id,processId,url,console:[],network:[]});return {processId,url,reused:true,recovered:true};
   }catch(error:any){if(error.message.includes('not HTTP-ready'))throw error;if(error.message==='fetch failed'||error.name==='TimeoutError')throw new Error('Owned preview server is not HTTP-ready. Inspect its process before restarting.');}
  }
 }
 const recipe=await detectRecipe(id);if(recipe.missing.length)throw new Error(`Missing tools: ${recipe.missing.join(', ')}`);
 const command=recipe.kind==='static-web'?{program:process.execPath,args:[join(getAppPath(),'scripts','coding_web_server.mjs'),session.root],nodeMode:true}:recipe.commands.dev??recipe.commands.start;
 if(!command)throw new Error('No preview server recipe. Configure a dev/start script or use a static index.html.');
 const launched=await startProcess(id,revision,{...command,timeoutMs:0});let offset=0,logs='',url:string|undefined;
 for(let n=0;n<80;n++){const state=await readProcess(id,launched.process.id,offset,12000);logs+=state.output;offset=state.nextOffset;
 const ready=logs.match(/"echoPreviewReady":true,"url":"([^"]+)"/)?.[1]??logs.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+[^\s"<>]*/)?.[0];
 if(ready){url=localPreviewURL(ready);try{const response=await fetch(url,{signal:AbortSignal.timeout(1000)});if(response.ok)break;}catch{}url=undefined;}
 if(state.status!=='running')throw new Error(`Preview server ${state.status}, exit ${state.exitCode}: ${logs.slice(-2000)}`);await new Promise(r=>setTimeout(r,100));}
 if(!url){await stopProcess(id,launched.process.id);throw new Error('Preview did not become HTTP-ready within 8 seconds. Inspect its logs.');}
 previews.set(id,{projectId:id,processId:launched.process.id,url,console:[],network:[]});
 const current=getSession(id);await mutateSession(id,current.revision,s=>{s.phase='previewing';s.artifacts.push({kind:'local-preview',value:url!});});
 return {processId:launched.process.id,url,revision:getSession(id).revision,verification:'HTTP ready; browser flows still unverified'};
}
export async function showProjectPreview(id:string){const session=getSession(id);if(!previews.has(id))await startProjectPreview(id,session.revision);const preview=previews.get(id)!;if(preview.window&&!preview.window.isDestroyed()){preview.window.show();return {url:preview.url};}
 const {BrowserWindow}=await import('electron');const window=new BrowserWindow({title:`Echo Project Preview — ${getSession(id).name}`,width:1100,height:760,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,partition:`echo-preview-${id}`}});preview.window=window;
 const record=(items:string[],line:string)=>{items.push(line.slice(0,2000));if(items.length>100)items.shift();};
 window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));window.webContents.session.setPermissionCheckHandler(()=>false);window.webContents.session.on('will-download',event=>event.preventDefault());
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==new URL(preview.url).origin)event.preventDefault();});
 window.webContents.on('console-message',(_event,level,message)=>record(preview.console,`${level}: ${message}`));
 window.webContents.session.webRequest.onCompleted(details=>record(preview.network,`${details.statusCode} ${details.method} ${details.url}`));window.webContents.session.webRequest.onErrorOccurred(details=>record(preview.network,`${details.error} ${details.url}`));
 await window.loadURL(preview.url);return {url:preview.url,isolated:true};
}
export async function inspectProjectPreview(id:string){getSession(id);const preview=previews.get(id);if(!preview?.window||preview.window.isDestroyed())throw new Error('Show the project preview before browser inspection.');
 const dom=await preview.window.webContents.executeJavaScript(`({title:document.title,url:location.href,text:document.body?.innerText.slice(0,12000),links:Array.from(document.querySelectorAll('a')).slice(0,50).map(a=>({text:a.innerText,href:a.getAttribute('href')})),controls:Array.from(document.querySelectorAll('input,button,select,textarea')).slice(0,50).map(e=>({tag:e.tagName,id:e.id,name:e.name,type:e.type,text:e.innerText}))})`,true);
 return {projectId:id,revision:getSession(id).revision,contentRevision:getSession(id).contentRevision??0,dom,console:preview.console.map(scrubSecrets),network:preview.network.map(scrubSecrets),process:await readProcess(id,preview.processId),verification:'Observed browser state; evaluate each acceptance criterion explicitly.'};
}
export async function interactProjectPreview(id:string,selector:string,action:'click'|'fill',value=''){getSession(id);const preview=previews.get(id);if(!preview?.window||preview.window.isDestroyed())throw new Error('Show the project preview first.');
 const result=await preview.window.webContents.executeJavaScript(`(()=>{const matches=document.querySelectorAll(${JSON.stringify(selector)});if(matches.length!==1)throw new Error('Selector must match exactly one element.');const e=matches[0];if(${JSON.stringify(action)}==='fill'){if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement))throw new Error('Fill requires a form control.');const proto=e instanceof HTMLInputElement?HTMLInputElement.prototype:e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLSelectElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}else e.click();return {action:${JSON.stringify(action)},tag:e.tagName};})()`,true);return {result,projectId:id,contentRevision:getSession(id).contentRevision??0};}
export async function stopProjectPreview(id:string){getSession(id);const preview=previews.get(id);if(!preview)return {stopped:false};const result=await stopProcess(id,preview.processId);preview.window?.close();previews.delete(id);return result;}
/** Record only a real DOM assertion against unchanged source. */
export async function assertProjectPreview(id:string,revision:number,selector:string,expected:string,criterion?:string){
 const session=getSession(id);if(session.revision!==revision)throw new Error('Project revision conflict.');
 const preview=previews.get(id);if(!preview?.window||preview.window.isDestroyed())throw new Error('Show the project preview first.');
 const before=await projectFingerprint(id);
 const observed:string=await preview.window.webContents.executeJavaScript(`(()=>{const nodes=document.querySelectorAll(${JSON.stringify(selector)});if(nodes.length!==1)throw new Error('Selector must match exactly one element.');const e=nodes[0];return (e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement?e.value:e.textContent).trim().slice(0,12000);})()`,true);
 if(observed!==expected)throw new Error(`Preview assertion failed: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}.`);
 if((await projectFingerprint(id)).hash!==before.hash)throw new Error('Source changed during browser assertion.');
 const evidence=JSON.stringify({kind:'observed-dom-assertion',url:preview.url,selector,expected,observed});
 if(criterion)await recordAcceptance(id,revision,criterion,evidence,before.hash);
 return {projectId:id,revision:getSession(id).revision,selector,expected,observed,passed:true,evidence,verification:'Observed assertion passed; other acceptance criteria still need evidence.'};
}
export function closeProjectPreviews(){for(const preview of previews.values())preview.window?.close();previews.clear();}
