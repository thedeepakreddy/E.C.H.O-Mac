import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'echo-coding-process-'));process.env.ECHO_DATA_ROOT=join(root,'data');process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.OPENAI_API_KEY='must-not-inherit';
const {openProject,getSession}=await import('./coding/session.js');const {startProcess,readProcess,writeProcessInput,stopProcess,stopAllCodingProcesses}=await import('./coding/processes.js');
const wait=async(id:string,check:(value:any)=>boolean)=>{for(let n=0;n<100;n++){const value=await readProcess(project.id,id);if(check(value))return value;await new Promise(r=>setTimeout(r,30));}throw new Error('Process fixture timeout');};
const project=await openProject({path:join(root,'project'),create:true});
try {
 const started=await startProcess(project.id,0,{program:process.execPath,args:['-e','console.log("ready", process.env.OPENAI_API_KEY); process.stdin.on("data", b=>{console.log(b.toString());process.exit(0)});'],timeoutMs:3000});
 assert.match((await wait(started.process.id,v=>v.output.includes('ready'))).output,/undefined/);
 await writeProcessInput(project.id,started.process.id,'hello\n');
 assert.equal((await wait(started.process.id,v=>v.status==='exited')).exitCode,0);
 const large=await startProcess(project.id,1,{program:process.execPath,args:['-e','console.log("x".repeat(200000));'],timeoutMs:3000});
 const data=await wait(large.process.id,v=>v.status==='exited');assert(data.output.length<=12000);assert(data.truncated);assert(data.outputLost);
 const server=await startProcess(project.id,2,{program:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:0});
 await stopProcess(project.id,server.process.id);assert.equal((await readProcess(project.id,server.process.id)).status,'cancelled');
 const timed=await startProcess(project.id,3,{program:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:100});
 assert.equal((await wait(timed.process.id,v=>v.status==='timeout')).status,'timeout');
 console.log('PASS streaming handles, stdin, real exit status, output bounds, provider-env isolation, cancellation and timeout teardown');
} finally {await stopAllCodingProcesses();await rm(root,{recursive:true,force:true});}
