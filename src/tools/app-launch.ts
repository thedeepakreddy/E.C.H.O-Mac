import type {LcuResult} from './lcu-session.js';
import type {RunResult} from './shell.js';
const bundleReference=/^(?:[A-Za-z0-9-]+\.){2,}[A-Za-z0-9-]+$/;
export async function resolveLaunchTarget(reference:string,resolveName:(name:string)=>Promise<string|null>):Promise<string|null> {
 const target=reference.trim();
 if(bundleReference.test(target)||target.startsWith('/')&&target.endsWith('.app'))return target;
 return resolveName(target);
}
/** Platform launch is not mouse/keyboard injection. Native observation/access
 * still happens before any autonomous input and before claiming launch verified.
 */
export async function launchEchoApp(target:string,launch:(bin:string,args:string[])=>Promise<RunResult>,inspect:(app:string)=>Promise<LcuResult>):Promise<LcuResult> {
 const bundle=bundleReference.test(target);
 const opened=await launch('/usr/bin/open',[bundle?'-b':'-a',target]);
 if(opened.code!==0)throw Error('App could not be brought forward: '+opened.stderr);
 return inspect(target);
}
