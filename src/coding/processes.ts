import {spawn, execFile, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {createHash,randomUUID} from 'node:crypto';
import {getAppPath} from '../utils/appPath.js';
import {atomicWrite} from '../memory/paths.js';
import {scrubSecrets} from '../safety/redact.js';
import {captureAllowed,deletionEpoch} from '../memory/capture-policy.js';
import {getSession,mutateSession,codingRoot,assertLive} from './session.js';
import {projectPath} from './workspace.js';
import {executionEnvironment} from '../system/process-env.js';
const exec=promisify(execFile);
export interface ProcessState {version:1;id:string;projectId:string;pid?:number;identity?:string;status:'running'|'exited'|'failed'|'cancelled'|'timeout'|'orphaned';program:string;args:string[];cwd:string;startedAt:string;exitCode?:number|null;signal?:string|null;output:string;offset:number;truncated:boolean;error?:string;privateMode:boolean;pty?:boolean;}
const live=new Map<string,{state:ProcessState;child:ChildProcessWithoutNullStreams;timer?:ReturnType<typeof setTimeout>}>();
const transient=new Map<string,ProcessState>();
function path(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid process ID.');return join(codingRoot(),'processes',`${id}.json`);}
function safeArgs(args:string[]){return args.map((arg,index)=>index>0&&/password|secret|token|api[-_]?key/i.test(args[index-1])?'[redacted]':scrubSecrets(arg));}
const recordingEpoch=new Map<string,number>();
function persist(state:ProcessState){if(state.privateMode||!captureAllowed())transient.set(state.id,structuredClone(state));else if(recordingEpoch.get(state.id)===undefined||recordingEpoch.get(state.id)===deletionEpoch())atomicWrite(path(state.id),JSON.stringify({...state,args:safeArgs(state.args),output:scrubSecrets(state.output)}));}
async function identity(pid:number):Promise<string|null>{try {const result=await exec('/bin/ps',['-p',String(pid),'-o','lstart=,command='],{timeout:2000});return result.stdout.trim()?createHash('sha256').update(result.stdout.trim()).digest('hex'):null;}catch{return null;}}
function groupSignal(pid:number,signal:NodeJS.Signals){if(pid<=1||pid===process.pid)throw new Error('Invalid owned process PID.');try{process.kill(process.platform==='win32'?pid:-pid,signal);}catch(error:any){if(error.code!=='ESRCH')throw error;}}
function output(state:ProcessState,text:string){state.output+=text;if(state.output.length>128000){const n=state.output.length-128000;state.output=state.output.slice(n);state.offset+=n;state.truncated=true;}}
export async function startProcess(projectId:string,revision:number,input:{program:string;args?:string[];cwd?:string;timeoutMs?:number;pty?:boolean;nodeMode?:boolean}) {
  if(!input.program||input.program.includes('\0'))throw new Error('Invalid executable.');
  // One build/process launch at a time is enough for the first M2 release.
  if([...live.values()].filter(item=>item.state.status==='running').length>=4)throw new Error('Managed process budget reached (4). Stop an owned process first.');
  for(const [id,entry] of live){if(live.size<=40)break;if(entry.state.status!=='running'){live.delete(id);transient.delete(id);recordingEpoch.delete(id);}}
  let launched:string|undefined;
  try {const result=await mutateSession(projectId,revision,async session=>{
    const cwd=await projectPath(session.root,input.cwd??'.');
    if([...live.values()].filter(item=>item.state.status==='running').length>=4)throw new Error('Managed process budget reached (4).');
    const id=randomUUID();
    launched=id;
    recordingEpoch.set(id,deletionEpoch());
    const env = executionEnvironment(input.nodeMode);
    // Echo's provider keys and authentication tokens are never inherited.
    if(input.pty && process.platform!=='darwin')throw new Error('Interactive PTY adapter currently supports macOS only.');
    const child=spawn(input.pty?'python3':input.program,input.pty?[join(getAppPath(),'scripts','coding_pty.py'),JSON.stringify([input.program,...(input.args??[])])]:input.args??[],{cwd,env,detached:process.platform!=='win32',stdio:'pipe'});
    const state:ProcessState={version:1,id,projectId,pid:child.pid,status:'running',program:input.program,args:input.args??[],cwd,startedAt:new Date().toISOString(),output:'',offset:0,truncated:false,privateMode:session.privateMode,pty:input.pty===true};
    const entry:{state:ProcessState;child:ChildProcessWithoutNullStreams;timer?:ReturnType<typeof setTimeout>}= {state,child};live.set(id,entry);
    let spoolTimer:ReturnType<typeof setTimeout>|undefined;
    const flush=()=>{if(spoolTimer)clearTimeout(spoolTimer);spoolTimer=undefined;try{persist(state);}catch(error){console.error('[coding] process recording failed:',error);}};
    const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const onData=(channel:'stdout'|'stderr',data:Buffer)=>{output(state,decoders[channel].write(data));if(!spoolTimer){spoolTimer=setTimeout(flush,250);spoolTimer.unref();}};
    child.stdout.on('data',data=>onData('stdout',data));child.stderr.on('data',data=>onData('stderr',data));
    child.on('error',error=>{state.status='failed';state.error=error.message;flush();});
    child.on('exit',(code,signal)=>{state.exitCode=code;state.signal=signal;if(entry.timer)clearTimeout(entry.timer);if(child.pid)try{groupSignal(child.pid,'SIGTERM');}catch{};});
    child.on('close',(code,signal)=>{output(state,decoders.stdout.end()+decoders.stderr.end());if(state.status==='running')state.status=code===0?'exited':'failed';state.exitCode=code;state.signal=signal;flush();});
    const timeout=input.timeoutMs??120000;
    if(timeout>0){entry.timer=setTimeout(()=>{void stopOwned(state,entry,'timeout').catch(error=>console.error('[coding] timeout cleanup failed:',error));},timeout);entry.timer.unref();}
    state.identity=child.pid?(await identity(child.pid)??undefined):undefined;
    persist(state);session.processIds.push(id);return structuredClone(state);
  });
  return {revision:result.session.revision,process:result.value};
  }catch(error){const entry=launched?live.get(launched):undefined;if(entry?.state.status==='running')await stopOwned(entry.state,entry,'cancelled');throw error;}
}
export async function readProcess(projectId:string,id:string,offset=0,limit=6000){
  getSession(projectId);
  let state=live.get(id)?.state??transient.get(id);
  if(!state){state=JSON.parse(readFileSync(path(id),'utf8'));if(state!.status==='running') {const actual=state!.pid?await identity(state!.pid):null;if(!state!.identity||actual!==state!.identity)state!.status='orphaned';}}
  if(state!.projectId!==projectId)throw new Error('Process belongs to another project.');
  const start=Math.max(offset,state!.offset),end=Math.min(state!.offset+state!.output.length,start+Math.min(limit,12000));
  return {...state!,args:safeArgs(state!.args),output:scrubSecrets(state!.output.slice(start-state!.offset,end-state!.offset)),readOffset:start,nextOffset:end,outputLost:offset<state!.offset};
}
export async function writeProcessInput(projectId:string,id:string,text:string){getSession(projectId);assertLive();const entry=live.get(id);if(!entry||entry.state.projectId!==projectId||entry.state.status!=='running')throw new Error('No live owned process accepts input.');if(text.length>16000)throw new Error('Input exceeds 16,000 characters.');entry.child.stdin.write(text);return {id,written:text.length};}
export async function stopProcess(projectId:string,id:string,reason:'cancelled'|'timeout'='cancelled'){
  getSession(projectId);const entry=live.get(id);const state=entry?.state??await readProcess(projectId,id);
  if(state.projectId!==projectId)throw new Error('Process belongs to another project.');
  return stopOwned(state,entry,reason);
}
async function stopOwned(state:ProcessState,entry:{child:ChildProcessWithoutNullStreams;timer?:ReturnType<typeof setTimeout>}|undefined,reason:'cancelled'|'timeout'){
  const id=state.id;
  if(state.status!=='running')return {id,status:state.status};
  if(!state.pid)throw new Error('Process has no PID.');
  if(!entry && (!state.identity || await identity(state.pid)!==state.identity))throw new Error('Saved PID ownership cannot be verified; refusing to signal it.');
  state.status=reason;if(entry?.timer)clearTimeout(entry.timer);
  groupSignal(state.pid,'SIGTERM');
  await new Promise(resolve=>setTimeout(resolve,300));
  if(entry ? entry.child.exitCode===null && entry.child.signalCode===null : await identity(state.pid)===state.identity)groupSignal(state.pid,'SIGKILL');
  persist(state);return {id,status:reason};
}
export async function stopAllCodingProcesses(){for(const entry of live.values())if(entry.state.status==='running')try{await stopOwned(entry.state,entry,'cancelled');}catch(error){console.error('[coding] shutdown cleanup failed:',error);}}
