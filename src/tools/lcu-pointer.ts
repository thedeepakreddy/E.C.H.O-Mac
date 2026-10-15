import {execFile} from 'node:child_process';
import {join} from 'node:path';
import {getAppPath} from '../utils/appPath.js';
import type {LcuResult} from './lcu-session.js';
type Runner=(args:string[],signal?:AbortSignal)=>Promise<{stdout:string;stderr:string;code:number}>;
const nativeRun:Runner=(args,signal)=>new Promise((resolve,reject)=>{
 execFile(join(getAppPath(),'native','echo-pointer'),args,{signal,timeout:5000},(error,stdout,stderr)=>{
  if(signal?.aborted)return reject(Error('Echo pointer movement was cancelled; reinspect before any retry.'));
  resolve({stdout,stderr,code:error?1:0});
 });
});
/** Called only inside the serialized, approved Echo LCU session. */
export function createPointerExtension(run:Runner=nativeRun){
 return async(app:string,to:[number,number],signal?:AbortSignal):Promise<LcuResult>=>{
  if(signal?.aborted)throw Error('Echo pointer movement was cancelled.');
  if(to.length!==2||!to.every(Number.isFinite))throw Error('Pointer coordinates must be finite.');
  const result=await run(['move',String(to[0]),String(to[1]),app],signal);
  let observed:{ok?:boolean;x?:number;y?:number;error?:string};
  try{observed=JSON.parse(result.stdout);}catch{throw Error('Echo pointer extension returned no verifiable position.');}
  if(result.code!==0||!observed.ok)throw Error(observed.error||result.stderr||'Echo pointer extension refused movement.');
  if(!Number.isFinite(observed.x)||!Number.isFinite(observed.y)||Math.abs(observed.x!-to[0])>1||Math.abs(observed.y!-to[1])>1)throw Error('Could not verify the pointer reached its destination.');
  return {content:[{type:'text',text:`Echo pointer extension moved to ${observed.x},${observed.y} (verified read-back; no click or key sent).`}],pointer:{x:observed.x,y:observed.y}};
 };
}
