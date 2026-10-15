import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtempSync,symlinkSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const root=mkdtempSync(join(tmpdir(),'echo-storage-admission-'));
Object.assign(process.env,{ECHO_DATA_ROOT:root,ECHO_MEMORY_ROOT:join(root,'memory'),ECHO_MCP:'0',ECHO_LOG_QUIET:'1'});
const badLogRoot=join(root,'broken-log-link');symlinkSync(join(root,'uncreated-outside'),badLogRoot);process.env.ECHO_LOG_DIR=badLogRoot;
try{
 const {Brain}=await import('./brain/types.js');const {RecordingBrain}=await import('./agent-replay/runtime.js');
 const {taskCoordinator}=await import('./memory/task-state.js');
 const {memoryService}=await import('./memory/service.js');
 class Provider extends Brain{calls=0;send(){this.calls++;this.emit('turnEnd');}interrupt(){}async stop(){}}
 for(const prior of ['new','completed','foreign'] as const){
  const taskId=randomUUID(),provider=new Provider(),brain=new RecordingBrain(provider,'fixture',{}, {autoResume:false});
  if(prior!=='new'){
   taskCoordinator.create({taskId,ownerActorId:prior==='foreign'?'another-owner':'echo',goal:'Existing saved work'});
   if(prior==='completed')taskCoordinator.finish(taskId,{status:'completed',verificationRefs:[`response:${taskId}`],summary:'Already finished'});
  }
  const errors:string[]=[];brain.on('error',message=>errors.push(String(message)));
  const ended=new Promise<void>(resolve=>brain.once('turnEnd',resolve));brain.send('Inert admission fixture',undefined,{taskId});await ended;
  assert.equal(provider.calls,0);assert.equal(errors.length,1);
  const state=taskCoordinator.get(taskId)!;
  if(prior==='new'){assert.equal(state.status,'blocked','A rejected log admission must not leave an agent appearing to work');assert.match(state.summary??'',/storage|persist/i);assert.notEqual(memoryService.get(`task-${taskId}`)?.status,'active','Scoped working memory must not retain the unstarted task as active');}
  else if(prior==='completed'){assert.equal(state.status,'completed');assert.equal(state.summary,'Already finished');}
  else{assert.equal(state.ownerActorId,'another-owner');assert.equal(state.status,'running');}
  await brain.stop();
 }
 // Fail the real checkpoint boundary after Recorder/context allocation, not a
 // reimplemented host path. Only this fixture's checkpoint write is intercepted.
 process.env.ECHO_LOG_DIR=join(root,'healthy-logs');
 const {checkDiagnosticWrite}=await import('./diagnostics/storage-budget.js');
 const {readRecoveryCheckpoint}=await import('./agent-replay/recovery.js');
 const originalWrite=fs.writeFileSync;let injected=false;
 const taskId=randomUUID(),provider=new Provider(),brain=new RecordingBrain(provider,'fixture',{}, {autoResume:false});
 const errors:string[]=[];brain.on('error',message=>errors.push(String(message)));
 try{
  fs.writeFileSync=((file:any,...args:any[])=>{
   if(!injected&&String(file).startsWith(process.env.ECHO_LOG_DIR!)&&String(file).includes('.checkpoint.json.')){injected=true;throw Error('Inert checkpoint persistence failure');}
   return (originalWrite as any)(file,...args);
  }) as typeof fs.writeFileSync;syncBuiltinESMExports();
  const ended=new Promise<void>(resolve=>brain.once('turnEnd',resolve));brain.send('Checkpoint admission fixture',undefined,{taskId});await ended;
 }finally{fs.writeFileSync=originalWrite;syncBuiltinESMExports();}
 const state=taskCoordinator.get(taskId)!;
 assert(injected);assert.equal(provider.calls,0);assert.equal(errors.length,1);
 assert.equal(state.status,'blocked','Checkpoint failure before provider dispatch is still an admission failure');
 assert.doesNotThrow(()=>checkDiagnosticWrite(process.env.ECHO_LOG_DIR!,join(process.env.ECHO_LOG_DIR!,'read-only-probe'),0,{directoryBytes:16384,diskReserveBytes:0}),'Unstarted runs must release terminal reservations');
 assert.equal(readRecoveryCheckpoint(join(process.env.ECHO_LOG_DIR!,state.attemptIds.at(-1)!))?.status,'exhausted','A failed startup cannot be silently replayed at next launch');
 assert.equal((brain as any).lastContext?.loop.timer,null,'Startup failure stops the unused heartbeat');
 await brain.stop();
 console.log('PASS failed diagnostic admission blocks only its own unstarted task; completed and foreign work preserved');
}finally{rmSync(root,{recursive:true,force:true});}
