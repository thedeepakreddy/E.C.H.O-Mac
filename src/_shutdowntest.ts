import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VoiceIoPlayer} from './voice/player.js';
import {gracefulShutdown,shutdownStep} from './shutdown.js';
let release!:()=>void;let cleanups=0;let exits=0;
const messages:string[]=[];
const quit=gracefulShutdown(async()=>{cleanups++;await new Promise<void>(resolve=>{release=resolve;});},()=>{exits++;},m=>messages.push(m));
const first=quit('control panel');assert.equal(quit('SIGTERM'),first);await Promise.resolve();assert.equal(cleanups,1);assert.equal(exits,0);release();await first;await quit('repeated quit');assert.equal(exits,1);assert(messages.at(-1)?.includes('cleanup complete'));
const reports:string[]=[];const stopped:string[]=[];
assert.equal(await shutdownStep('throws',()=>{throw Error('fixture');},20,m=>reports.push(m)),false);
assert.equal(await shutdownStep('hangs',()=>new Promise(()=>{}),20,m=>reports.push(m)),false);
assert.equal(await shutdownStep('remaining helper',()=>{stopped.push('helper');},20),true);assert.deepEqual(stopped,['helper']);assert.equal(reports.length,2);
console.log('PASS one cleanup/exit across repeated requests, exit waits for cleanup, failed/hung service does not block other resources');
for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const){
 const code=`const gracefulShutdown=${gracefulShutdown.toString()};let releases=0;const quit=gracefulShutdown(async()=>{console.log('cleanup-start');await new Promise(r=>setTimeout(r,30));releases++;console.log('cleanup-end:'+releases);},()=>process.exit(0));for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>void quit(signal));setInterval(()=>{},1000);console.log('ready');`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let output='';let errors='';let sent=false;
 child.stdout.on('data',d=>{output+=d;if(!sent&&output.includes('ready')){sent=true;child.kill(signal);child.kill(signal);}});child.stderr.on('data',d=>errors+=d);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const result=await Promise.race([new Promise<number|null>((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`${signal} did not exit`)),3000);})]);assert.equal(result,0,errors);assert.equal(output.match(/cleanup-start/g)?.length,1);assert.match(output,/cleanup-end:1/);assert.match(output,/shutdown cleanup complete/);}
 finally{if(timer)clearTimeout(timer);if(child.exitCode===null)child.kill('SIGTERM');}
 console.log(`PASS real child ${signal} performs cleanup and exits normally, including a repeated signal`);
}

const audioRoot=await mkdtemp(join(tmpdir(),'echo-audio-shutdown-'));
try{
 const fixture=join(audioRoot,'helper');
 await writeFile(fixture,`#!/usr/bin/env python3\nimport os, struct, time\nos.close(0)\nbody=b'{"ev":"ready"}'\nos.write(1, struct.pack('<I', len(body)+1)+bytes([0x20])+body)\ntime.sleep(10)\n`,{mode:0o700});
 const player=new VoiceIoPlayer(fixture,false) as any;player.on('error',()=>{});await player.start();
 const child=player.proc;const exited=new Promise<void>(resolve=>child.once('exit',resolve));
 assert(child.stdin.listenerCount('error')>0,'production audio pipe must handle errors before any caller attaches');
 let actualBrokenPipe=false;child.stdin.on('error',(error:NodeJS.ErrnoException)=>{if(error.code==='EPIPE')actualBrokenPipe=true;});
 player.stop();await new Promise(resolve=>setTimeout(resolve,80));assert(actualBrokenPipe,'real closed helper pipe produced EPIPE without crashing');
 assert.doesNotThrow(()=>child.stdin.emit('error',Object.assign(new Error('pipe already closed'),{code:'EPIPE'})));
 let restarted=0;player.launch=async()=>{restarted++;};player.recover();assert(player.recoveryTimer);player.dispose();await exited;await new Promise(resolve=>setTimeout(resolve,200));assert.equal(restarted,0);
 console.log('PASS closed audio pipe during shutdown is handled and disposed player cannot restart its helper');
}finally{await rm(audioRoot,{recursive:true,force:true});}
