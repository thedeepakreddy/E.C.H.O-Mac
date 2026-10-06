import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'echo-dialogue-'));process.env.ECHO_DATA_ROOT=join(root,'data');process.env.ECHO_MEMORY_ROOT=join(root,'memory');
const {Brain}=await import('./brain/types.js');const {DEFAULTS_FOR_TESTS}=await import('./config.js');const {openProject,getSession}=await import('./coding/session.js');const {startProjectBuild,supervisedProjectSpec,askBuildQuestion,answerBuildQuestion,handleBuildInput,stopCodingWorkers}=await import('./coding/dialogue.js');
class FixtureBrain extends Brain {messages:string[]=[];interrupts=0;send(text:string){this.messages.push(text);}interrupt(){this.interrupts++;}async stop(){this.interrupt();}}
try{const project=await openProject({path:join(root,'site'),create:true});const planned=supervisedProjectSpec({...project,acceptance:['2 + 3 displays 5']},'Continue with the dark theme');assert.deepEqual(planned.projectIds,[project.id]);assert.equal(planned.acceptanceCriteria[0],'2 + 3 displays 5');assert.match(planned.goal,/dark theme/);const brain=new FixtureBrain();await startProjectBuild(project.id,'Make a site',DEFAULTS_FOR_TESTS,()=>brain);assert.equal(brain.messages.length,1);
 await assert.rejects(startProjectBuild(project.id,'Duplicate',DEFAULTS_FOR_TESTS,()=>brain),/active writer/);
 const other=await openProject({path:join(root,'other'),create:true});await assert.rejects(startProjectBuild(other.id,'Other',DEFAULTS_FOR_TESTS,()=>brain),/One coding writer/);
 assert.match((await handleBuildInput('add a contact form',DEFAULTS_FOR_TESTS))!,/Queued/);assert.equal(brain.messages.length,2);
 const pending=await askBuildQuestion(project.id,getSession(project.id).revision,'Which theme?',['light','dark']);assert.equal(pending.phase,'waiting-for-input');assert.equal(brain.interrupts,1);
 const answered=await answerBuildQuestion(project.id,pending.question!.id,'dark');assert.equal(answered.phase,'planning');assert.match(answered.decisions.at(-1)!,/dark/);
 await assert.rejects(answerBuildQuestion(project.id,pending.question!.id,'light'),/no longer pending/);
 brain.emit('turnEnd');assert.notEqual(getSession(project.id).phase,'completed');
 assert.match((await handleBuildInput('pause coding',DEFAULTS_FOR_TESTS))!,/Paused/);assert.equal(getSession(project.id).phase,'blocked');
 console.log('PASS build dialogue: one writer, queued changes, exact questions, pause and no invented completion');
}finally{await stopCodingWorkers();await rm(root,{recursive:true,force:true});}
