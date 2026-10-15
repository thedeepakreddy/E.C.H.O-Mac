import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'echo-agent-controls-'));process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.JARVIS_FLEET_DIR=root;process.env.ECHO_MCP='0';
const {SwarmManager}=await import('./frontier/swarm.js');const {createMacBots,TEAM_BOT_ID}=await import('./frontier/bots.js');const {taskCoordinator}=await import('./memory/task-state.js');const {parseRemoteAction}=await import('./frontier/remote.js');
class Fake extends EventEmitter {supportsTaskUpdates=true;sent='';opts:any;pending:Array<()=>void>=[];interrupted=false;send(text:string,_a?:unknown,o?:unknown){this.sent=text;this.opts=o;}queueTaskUpdate(_text:string,applied:()=>void){this.pending.push(applied);return true;}interrupt(){this.interrupted=true;}async stop(){}}
const host=new SwarmManager(),brains:Fake[]=[];const bots=createMacBots(host,()=>({makeBrain:()=>{const b=new Fake();brains.push(b);return b;}}),()=>({}),()=>true);
try{
 const run=bots.run({name:TEAM_BOT_ID,goal:'Verify choices',botRevision:bots.revision(TEAM_BOT_ID),requestId:randomUUID(),agentIds:['research','plan']});assert.ok(run.ok);const id=run.data!.missionId!;
 brains[0].emit('tool',{name:'web_search',summary:'Searching',readOnly:true});assert.equal(host.getMission(id)!.tasks.research.activity?.kind,'reading');
 brains[0].emit('tool',{name:'read_file',summary:'Reading',readOnly:true});brains[0].emit('toolEnd',{name:'web_search'});assert.equal(host.getMission(id)!.tasks.research.activity?.text,'Using · read_file');brains[0].emit('toolEnd',{name:'read_file'});assert.equal(host.getMission(id)!.tasks.research.activity?.kind,'working');
 brains[0].emit('textDelta',{text:'Draft'});assert.equal(host.getMission(id)!.tasks.research.activity?.kind,'writing');brains[0].emit('textDone',{text:'Draft'});assert.equal(host.getMission(id)!.tasks.research.activity?.kind,'working');
 const nativeTask=host.getMission(id)!.tasks.research;
 const eventOwner={taskId:nativeTask.taskId,actorId:nativeTask.actorId};
 brains[0].emit('tool',{...eventOwner,callId:'read-1',name:'read_file',readOnly:true});
 brains[0].emit('tool',{...eventOwner,callId:'read-2',name:'read_file',readOnly:true});
 brains[0].emit('toolEnd',{...eventOwner,callId:'foreign',name:'read_file'});
 brains[0].emit('toolEnd',{...eventOwner,callId:'read-1',name:'read_file'});
 assert.equal(host.getMission(id)!.tasks.research.activity?.kind,'reading','An unknown completion cannot consume a same-name active call');
 brains[0].emit('toolEnd',{...eventOwner,callId:'read-2',name:'read_file'});
 assert.equal(host.getMission(id)!.tasks.research.activity?.kind,'working');
 brains[0].emit('tool',{taskId:'other-task',actorId:nativeTask.actorId,callId:'foreign-task',name:'web_search',readOnly:true});
 assert.equal(host.getMission(id)!.tasks.research.activity?.kind,'working','Foreign-task telemetry cannot start an animation');
 const update={missionId:id,taskId:'research',attempt:1,requestId:randomUUID(),operation:'update',text:'Use primary sources'};
 assert.equal(bots.control({...update,taskId:'unknown'}).ok,false);assert.equal(bots.control({...update,attempt:2}).ok,false);assert.ok(bots.control(update).ok);assert.ok(bots.control(update).ok);assert.equal(brains[0].pending.length,1);assert.equal((host.getMission(id)!.tasks.research.updates![0]).status,'queued');brains[0].pending[0]();assert.equal((host.getMission(id)!.tasks.research.updates![0]).status,'applied');assert.equal(bots.control({...update,text:'Different'}).ok,false);
 const waiting={...update,taskId:'plan',requestId:randomUUID(),text:'Include costs'};assert.ok(bots.control(waiting).ok);assert.equal(host.getMission(id)!.tasks.plan.updates![0].status,'queued');
 const evidenceCall={taskId:nativeTask.taskId!,actorId:nativeTask.actorId!,stepId:'read',callId:randomUUID(),generation:0,baseRevision:0,resources:[]};taskCoordinator.startCall(evidenceCall,'web_search','observation');taskCoordinator.endCall(evidenceCall,{status:'success',text:'Saved annual source'});
 const revise={...update,requestId:randomUUID(),operation:'revise',text:'Focus on annual plans'};assert.ok(bots.control(revise).ok);assert.equal(brains[0].interrupted,true);assert.equal(brains.length,2);const revised=host.getMission(id)!.tasks.research;assert.equal(revised.attempt,2);assert.notEqual(revised.actorId,`${id}.research`);assert.equal(host.getMission(id)!.tasks.plan.status,'pending');brains[0].emit('turnEnd');assert.equal(host.getMission(id)!.tasks.research.status,'working');assert.ok(bots.control(revise).ok);assert.equal(brains.length,2);
 assert.throws(()=>taskCoordinator.submitResult(`${host.getMission(id)!.taskId}.research`,`${id}.research`,{status:'completed',summary:'Late',artifacts:[],verificationRefs:[],blockers:[]}),/cancelled/);
 assert.match(brains[1].sent,/Saved annual source/,'Revision carries authorized saved evidence, not a blank replay');assert.ok(revised.retrySourceTaskIds?.includes(nativeTask.taskId!));
 brains[0].emit('textDelta',{text:'Late draft'});brains[0].emit('tool',{name:'web_search'});assert.notEqual(host.getMission(id)!.tasks.research.activity?.kind,'reading');assert.notEqual(host.getMission(id)!.tasks.research.activity?.kind,'writing');
 taskCoordinator.submitResult(revised.taskId!,revised.actorId!,{status:'completed',summary:'Verified',artifacts:[{kind:'text',label:'Report',value:'Verified sources'}],verificationRefs:['fixture:source'],blockers:[]});brains[1].emit('turnEnd');assert.equal(host.getMission(id)!.tasks.plan.status,'working');assert.ok(brains[2].sent.includes('Include costs'));assert.equal(host.getMission(id)!.tasks.plan.updates![0].status,'applied');
 const stop={...waiting,operation:'stop',requestId:randomUUID(),text:undefined};assert.ok(bots.control(stop).ok);assert.equal(brains[2].interrupted,true);assert.equal(host.getMission(id)!.tasks.lead.status,'blocked');assert.ok(parseRemoteAction({type:'control-bot',...stop}));assert.equal(parseRemoteAction({type:'control-bot',...stop,attempt:0}),null);
 console.log('PASS exact-agent updates, turn acknowledgments, waiting instructions, retries, revised attempts, late-result fences, independent interruption and remote validation');
}finally{await host.close();rmSync(root,{recursive:true,force:true});}
