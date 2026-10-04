/** Bound silence, cancel the underlying request, and reject even if an SDK ignores abort. */
export class StreamStalledError extends Error {readonly code='ECHO_STREAM_STALLED';constructor(ms:number){super(`Model stream made no progress for ${ms}ms`);this.name='StreamStalledError';}}
export async function streamStep<T>(action:()=>Promise<T>,controller:AbortController,timeoutMs:number,parent?:AbortSignal):Promise<T>{
 const signal=parent?AbortSignal.any([parent,controller.signal]):controller.signal;
 if(signal.aborted)throw signal.reason??new Error('Request aborted');
 let timer:ReturnType<typeof setTimeout>|undefined;
 let onAbort:(()=>void)|undefined;
 const timeout=new Promise<never>((_,reject)=>{
  if(timeoutMs>0)timer=setTimeout(()=>{const error=new StreamStalledError(timeoutMs);controller.abort(error);reject(error);},timeoutMs);
  onAbort=()=>{const error=signal.reason??new Error('Request aborted');controller.abort(error);reject(error);};signal.addEventListener('abort',onAbort,{once:true});
 });
 try{return await Promise.race([Promise.resolve().then(action),timeout]);}finally{if(timer)clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
}
export function streamSilenceMs():number {const value=Number(process.env.ECHO_GEMINI_STREAM_SILENCE_MS);return Number.isFinite(value)&&value>0?Math.floor(value):30000;}
