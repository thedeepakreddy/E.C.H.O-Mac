import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {EchoComputerControl,installEchoComputerControl} from './lcu-control.js';
import {setLcuModelSurface} from './lcu-guidance.js';
import {protectLcuApps,type LcuClient} from './lcu-session.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(import.meta.url);
const CLIENT_SHA256='ca17e00b20939c779c75821e217891b3a2c3a7c9173eacf5807b685f975a1479';
/** Uses the verified, local v0.11.2 shared client, never copied OpenAI runtime code.
 * Source: https://github.com/amontlabs/lcu/blob/v0.11.2/docs/ADAPTERS.md#shared-client-contract
 */
export async function prepareEchoLcuRuntime():Promise<void>{
 const root=join(homedir(),'.local','share','echo-lcu','current');
 const adapterPath=join(root,'adapters','client.mjs');
 const hash=createHash('sha256').update(await readFile(adapterPath)).digest('hex');
 if(hash!==CLIENT_SHA256)throw Error('Echo LCU shared client does not match the reviewed v0.11.2 release.');
 const adapter=await import(pathToFileURL(adapterPath).href);
 const {dialog,app,BrowserWindow}=require('electron');
 const bundle=app.getPath('exe').split('/Contents/MacOS/')[0];
 const bundleId=await promisify(execFile)('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',join(bundle,'Contents','Info.plist')]).then(r=>r.stdout.trim()).catch(()=> '');
 protectLcuApps([app.getName(),bundle,bundleId]);
 const client:LcuClient=adapter.createCuaClient({command:[join(root,'bin','lcu')],adapter:'echo',onElicitation:async(params:unknown,{signal}:{signal:AbortSignal})=>{
  const request=adapter.nativeAppApprovalOptions(params);
  if(!request||signal.aborted)return {action:'cancel'}; // No browser/audio scope is implicitly granted.
  const parent=BrowserWindow.getFocusedWindow()??BrowserWindow.getAllWindows().find((w:any)=>!w.isDestroyed());
  if(!parent)return {action:'cancel'};
  const choices=[{value:'cancel',label:'Cancel'},...request.choices];
  const result=await dialog.showMessageBox(parent,{type:'question',title:'Echo · App permission',message:request.message,signal,
   detail:`Target: ${request.resource}\nOnly you can grant this runtime permission. Stop cancels pending input.`,
   buttons:choices.map(c=>c.label),defaultId:0,cancelId:0,noLink:true});
  if(signal.aborted)return {action:'cancel'};
  return adapter.nativeAppApprovalResponse(params,choices[result.response]?.value??'cancel');
 }});
 try{
  await client.connect();
  const instructions=client.instructions,tools=client.publicTools();
  setLcuModelSurface(instructions,tools);
  installEchoComputerControl(new EchoComputerControl(client,undefined,async surface=>{
   if(surface.instructions!==instructions||JSON.stringify(surface.tools)!==JSON.stringify(tools))throw Error('LCU runtime instructions changed; reconnect before acting.');
  }));
 }catch(error){await client.close().catch(()=>{});throw error;}
}
