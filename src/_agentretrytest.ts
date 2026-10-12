import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'echo-agent-retry-'));process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.JARVIS_FLEET_DIR=root;process.env.ECHO_MCP='0';
const {SwarmManager}=await import('./frontier/swarm.js');const {createMacBots,TEAM_BOT_ID}=await import('./frontier/bots.js');const {taskCoordinator}=await import('./memory/task-state.js');const {parseRemoteAction}=await import('./frontier/remote.js');
class Fake extends EventEmitter {sent='';constructor(readonly profile:string){super();}send(text:string){this.sent=text;}recoverFromCheckpoint(){return true;}interrupt(){}async stop(){}}
const host=new SwarmManager(),brains:Fake[]=[];let capture=true;
const deps=()=>({makeBrain:(_:unknown,t?:{id:string})=>{const b=new Fake(t?.id??'');brains.push(b);return b;}}),bots=createMacBots(host,deps,()=>({}),()=>capture);
const brain=(name:string)=>brains.filter(b=>b.profile===name).at(-1)!;
const result=(status:'completed'|'failed',summary:string)=>({status,summary,artifacts:status==='completed'?[{kind:'text' as const,label:'Report',value:summary}]:[],verificationRefs:status==='completed'?['fixture:verified']:[],blockers:[]});
function finish(id:string,name:string,status:'completed'|'failed',summary:string){const t=host.getMission(id)!.tasks[name];taskCoordinator.submitResult(t.taskId!,t.actorId!,result(status,summary));brain(name).emit('turnEnd');return t;}
try{
 const run=bots.run({name:TEAM_BOT_ID,goal:'Compare options',botRevision:bots.revision(TEAM_BOT_ID),requestId:randomUUID(),agentIds:['research','analyse','plan']});assert.ok(run.ok);const id=run.data!.missionId!;
 const request={missionId:id,taskId:'research',attempt:1,operation:'retry',requestId:randomUUID()};
 assert.equal(bots.control(request).ok,false,'An active agent cannot be retried');
 const saved=host.getMission(id)!.tasks.research,call={taskId:saved.taskId!,actorId:saved.actorId!,stepId:'source',callId:randomUUID(),generation:0,baseRevision:0,resources:[]};
 taskCoordinator.startCall(call,'web_search','observation');taskCoordinator.endCall(call,{status:'success',text:'Official source: annual plan costs 120',verification:'verified',verificationRefs:['fixture:source']});
 const oldBrain=brain('research');oldBrain.emit('textDelta',{text:'Saved partial comparison'});
 finish(id,'analyse','completed','Keep this completed analysis');
 finish(id,'research','failed','Temporary connection failure');
 assert.equal(host.getMission(id)!.status,'failed');const completed=host.getMission(id)!.tasks.analyse;
 assert.ok(parseRemoteAction({type:'control-bot',...request}),'Phone-to-Mac accepts text-free retry');
 assert.equal(bots.control({...request,attempt:2}).ok,false,'Stale attempts are refused');
 capture=false;assert.equal(bots.control(request).ok,false,'Private mode cannot start a saved retry');capture=true;
 const retried=bots.control(request);assert.ok(retried.ok,retried.message);const resumed=host.getMission(id)!;
 assert.equal(resumed.tasks.research.attempt,2);assert.equal(resumed.tasks.research.status,'working');assert.equal(resumed.tasks.plan.status,'pending');assert.equal(resumed.tasks.lead.status,'pending');assert.deepEqual(resumed.tasks.analyse,completed);
 assert.match(brains[2].sent,/annual plan costs 120/);assert.match(brains[2].sent,/Saved partial comparison/);assert.match(brains[2].sent,/do not replay/i);
 assert.ok(bots.control(request).ok,'An accepted request can be retried after network loss');assert.equal(brains.length,3);assert.equal(bots.control({...request,requestId:randomUUID()}).ok,false);
 oldBrain.emit('textDelta',{text:'Late old attempt'});oldBrain.emit('turnEnd');assert.equal(host.getMission(id)!.tasks.research.status,'working');assert.doesNotMatch(host.getMission(id)!.tasks.research.draft??'',/Late old/);
 // Isolated crash snapshot: recovery must use the canonical mission ID even
 // when Retry created a new root attempt with a .retry-N suffix.
 const {TaskCoordinator}=await import('./memory/task-state.js'),snapshot=structuredClone(host.getMission(id)!),recoveryCoordinator=new TaskCoordinator(join(root,'crash-snapshot')),recovering=new SwarmManager();
 recoveryCoordinator.create({taskId:snapshot.taskId,ownerActorId:`mission:${id}`,goal:snapshot.goal});recoveryCoordinator.bind(snapshot.taskId,'mission',snapshot);
 recoveryCoordinator.create({taskId:snapshot.canonicalTaskId!,ownerActorId:`mission:${id}`,goal:snapshot.goal});
 const rt=snapshot.tasks.research;recoveryCoordinator.create({taskId:rt.taskId!,ownerActorId:rt.actorId!,goal:rt.goal,parentTaskId:snapshot.taskId});
 const checkpoint={taskId:rt.taskId,actor:{id:rt.actorId,name:rt.actorName,kind:'clone',parentTaskId:snapshot.taskId},originalPrompt:rt.goal,createdAt:rt.startedAt,recoveryAttempts:0} as any;
 assert.equal(recovering.recover(checkpoint,{coordinator:recoveryCoordinator,makeBrain:()=>new Fake('research')}),true,'A retried agent survives a process restart');assert.equal(recovering.isMissionLive(id),true);assert.deepEqual(recovering.getMission(id)!.tasks.analyse,completed);await recovering.close();
 finish(id,'research','completed','Recovered source report');finish(id,'plan','completed','Final plan');finish(id,'lead','completed','Echo combined the recovered reports');
 assert.equal(host.getMission(id)!.status,'completed');assert.equal(taskCoordinator.get(host.getMission(id)!.taskId)!.result!.status,'completed');assert.ok(bots.control(request).ok,'Retry acknowledgment remains idempotent after completion');assert.equal(brains.length,5);
 const reopened=new SwarmManager();assert.equal(reopened.getMission(id)!.status,'completed','Canonical mission lookup retains retry outcome after restart');await reopened.close();
 assert.ok(host.forgetMission(id).ok);assert.equal(new SwarmManager().getMission(id),null,'Deleting a retried mission removes its canonical recovery binding');
 const {savedAgentProgress}=await import('./frontier/agent-retry.js');assert.throws(()=>savedAgentProgress({...saved,taskId:'missing-progress-journal'},taskCoordinator),/unavailable|missing|review/i,'Missing tool journals cannot silently replay external actions');
 const unsafe=bots.run({name:'write',goal:'Deliver message',botRevision:bots.revision('write'),requestId:randomUUID()});assert.ok(unsafe.ok);const uid=unsafe.data!.missionId!,ut=host.getMission(uid)!.tasks.write;
 taskCoordinator.startCall({taskId:ut.taskId!,actorId:ut.actorId!,stepId:'send',callId:randomUUID(),generation:0,baseRevision:0,resources:[]},'send_email','action');finish(uid,'write','failed','Connection lost during send');
 const denied=bots.control({missionId:uid,taskId:'write',attempt:1,operation:'retry',requestId:randomUUID()});assert.equal(denied.ok,false);assert.match(denied.message,/uncertain|verify|review/i);
 const {createInvocation}=await import('./memory/invocation.js'),{runInAgentContext}=await import('./agent-replay/context.js'),{runGated}=await import('./safety/gate.js');
 taskCoordinator.create({taskId:'retry-effect-source',ownerActorId:'source',goal:'Fixture effect'});
 const args={x:10,y:20},inv=createInvocation('retry-effect-source','source','click',args);taskCoordinator.startCall(inv,'click','action');taskCoordinator.endCall(inv,{status:'success',verification:'verified',text:'Already executed'});
 taskCoordinator.create({taskId:'retry-effect-next',ownerActorId:'next',goal:'Continue fixture'});taskCoordinator.bind('retry-effect-next','retrySourceTaskIds',['retry-effect-source']);let executed=0;
 const cached=await runInAgentContext({identity:{id:'next',name:'Next',kind:'clone'},taskId:'retry-effect-next',payloadRecording:false,privateMode:true,loop:{hasExited:false,toolStart(){return 'fixture';},toolEnd(){}}} as any,()=>runGated({name:'click',description:'Fixture',schema:{},readOnly:false,handler:async()=>{executed++;return {text:'Repeated effect'};}},args,{workingDir:root}));
 assert.equal(executed,0,'Completed mutable actions are hard-gated, not merely discouraged in the prompt');assert.equal(cached.text,'Already executed');
 const readResult=taskCoordinator.readCallResult;taskCoordinator.readCallResult=()=>undefined as any;
 try{const missing=await runInAgentContext({identity:{id:'next',name:'Next',kind:'clone'},taskId:'retry-effect-next',payloadRecording:false,privateMode:true,loop:{hasExited:false,toolStart(){return 'fixture';},toolEnd(){}}} as any,()=>runGated({name:'click',description:'Fixture',schema:{},readOnly:false,handler:async()=>{executed++;return {text:'Repeated effect'};}},args,{workingDir:root}));assert.equal(executed,0,'A recorded completed effect with a missing outcome is never repeated');assert.equal(missing.status,'denied');}finally{taskCoordinator.readCallResult=readResult;}
 const limitHost=new SwarmManager(),limitCoordinator=new TaskCoordinator(join(root,'retry-limit')),limitDeps={coordinator:limitCoordinator,makeBrain:()=>{throw Error('Fixture setup failure');}};
 assert.ok(limitHost.submitMission({id:'retry-limit',goal:'Fixture task',tasks:[{id:'write',profile:'write',goal:'Fixture task'}]},limitDeps).ok);
 for(let attempt=1;attempt<10;attempt++)assert.ok(limitHost.controlMissionTask({missionId:'retry-limit',taskId:'write',attempt,operation:'retry',requestId:randomUUID()},limitDeps).ok);
 const limited=limitHost.controlMissionTask({missionId:'retry-limit',taskId:'write',attempt:10,operation:'retry',requestId:randomUUID()},limitDeps);assert.equal(limited.ok,false);assert.match(limited.message,/limit/);await limitHost.close();
 console.log('PASS saved progress, completed siblings, dependency reactivation, exact attempts, idempotency, late fencing, restart/deletion recovery, bounded retries, private-mode and uncertain-action safety');
}finally{await host.close();rmSync(root,{recursive:true,force:true});}
