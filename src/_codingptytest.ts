import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'echo-coding-pty-'));process.env.ECHO_DATA_ROOT=join(root,'data');process.env.ECHO_MEMORY_ROOT=join(root,'memory');
const {openProject}=await import('./coding/session.js');const {startProcess,readProcess,writeProcessInput,stopAllCodingProcesses}=await import('./coding/processes.js');
try {
 if(process.platform==='darwin'){
 const project=await openProject({path:join(root,'project'),create:true});
 const started=await startProcess(project.id,0,{program:process.execPath,args:['-e','console.log("TTY",process.stdin.isTTY);process.stdin.once("data",()=>process.exit(0));'],pty:true,timeoutMs:5000});
 let found=false;for(let n=0;n<100;n++){const r=await readProcess(project.id,started.process.id);if(r.output.includes('TTY true')){found=true;break;}await new Promise(r=>setTimeout(r,30));}
 assert(found,JSON.stringify(await readProcess(project.id,started.process.id)));await writeProcessInput(project.id,started.process.id,'done\n');
 console.log('PASS macOS interactive PTY is a real terminal with managed stdin');
 }
} finally {await stopAllCodingProcesses();await rm(root,{recursive:true,force:true});}
