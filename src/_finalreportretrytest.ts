import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'echo-report-retry-'));
process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.JARVIS_FLEET_DIR=root;process.env.ECHO_MCP='0';
try {
 const {SwarmManager}=await import('./frontier/swarm.js');
 const {createMacBots,TEAM_BOT_ID}=await import('./frontier/bots.js');
 const {taskCoordinator}=await import('./memory/task-state.js');
 class Fake extends EventEmitter {sent='';constructor(readonly task:string){super();}send(text:string){this.sent=text;}recoverFromCheckpoint(){return true;}interrupt(){}async stop(){}}
 const brains:Fake[]=[],host=new SwarmManager(),terminals:any[]=[];
 host.setTerminalListener(mission=>{assert.ok(taskCoordinator.get(mission.taskId)?.result,'Terminal report callback follows durable Result commit');terminals.push(mission);});
 const deps=()=>({makeBrain:(_:unknown,task?:{id:string})=>{const b=new Fake(task?.id??'');brains.push(b);return b;}});
 const bots=createMacBots(host,deps,()=>({}),()=>true);
 try {
  assert.equal(bots.list().bots.filter(bot=>!bot.team).length,6,'All six desks represent real specialists, not Echo or the compiler');
  const run=bots.run({name:TEAM_BOT_ID,goal:'Compare primary sources',agentIds:['research','plan'],requestId:randomUUID(),botRevision:bots.revision(TEAM_BOT_ID)});
  assert.ok(run.ok);const id=run.data!.missionId!;
  const finish=(name:string,status:'completed'|'failed',summary:string)=>{const task=host.getMission(id)!.tasks[name];taskCoordinator.submitResult(task.taskId!,task.actorId!,{status,summary,artifacts:status==='completed'?[{kind:'text',label:'Report',value:summary}]:[],verificationRefs:status==='completed'?['fixture:source']:[],blockers:status==='failed'?['fixture:temporary']:[]});brains.filter(b=>b.task===name).at(-1)!.emit('turnEnd');};
  finish('research','completed','Saved source report');finish('plan','completed','Saved plan');finish('lead','failed','Temporary report compiler error');
  const before=structuredClone(host.getMission(id)!);
  const retry={missionId:id,taskId:'lead',attempt:1,requestId:randomUUID(),operation:'retry'};
  const accepted=bots.control(retry);assert.ok(accepted.ok,accepted.message);
  const resumed=host.getMission(id)!;
  assert.deepEqual(resumed.tasks.research,before.tasks.research);assert.deepEqual(resumed.tasks.plan,before.tasks.plan);
  assert.equal(brains.length,4,'Only the compiler restarts');assert.equal(brains[3].task,'lead');assert.match(brains[3].sent,/Saved source report/);assert.match(brains[3].sent,/Saved plan/);
  assert.equal(resumed.tasks.lead.attempt,2);assert.equal(resumed.tasks.lead.status,'working');
  assert.equal(bots.control(retry).ok,true,'Lost reply retries the same command, not another compiler');assert.equal(brains.length,4);
  assert.equal(bots.control({...retry,requestId:randomUUID()}).ok,false,'A stale compiler attempt cannot restart again');
  finish('lead','completed','Combined verified report');assert.equal(host.getMission(id)!.status,'completed');
  assert.equal(terminals.length,2,'Each terminal attempt is reported once');assert.notEqual(terminals[0].taskId,terminals[1].taskId,'Retry report has its own terminal identity');assert.equal(terminals[0].status,'failed');assert.equal(terminals[1].status,'completed');
  assert.equal(bots.list().jobs.find(job=>job.id===id)!.result!.summary,'Combined verified report');
  console.log('PASS six specialists and final-report-only retry preserving completed reports and exact command/attempt identity');
 } finally {await host.close();}
 const {TaskCoordinator}=await import('./memory/task-state.js');
 const donorCoordinator=new TaskCoordinator(join(root,'donor')),restoredCoordinator=new TaskCoordinator(join(root,'restored'));
 const donor=new SwarmManager(),restored=new SwarmManager(),factories:string[]=[];let recoveredBrain:Fake;
 try {
  donor.submitMission({id:'recover-factory',goal:'Read then plan',tasks:[{id:'research',profile:'research',goal:'Read sources'},{id:'plan',profile:'plan',goal:'Plan',dependsOn:['research']}]},{coordinator:donorCoordinator,makeBrain:(_,task)=>new Fake(task!.id)});
  const snapshot=structuredClone(donor.getMission('recover-factory')!);
  restoredCoordinator.create({taskId:snapshot.taskId,ownerActorId:'mission:recover-factory',goal:snapshot.goal});restoredCoordinator.bind(snapshot.taskId,'mission',snapshot);
  const saved=snapshot.tasks.research;
  restoredCoordinator.create({taskId:saved.taskId!,ownerActorId:saved.actorId!,goal:saved.goal,parentTaskId:snapshot.taskId});
  const checkpoint={taskId:saved.taskId,actor:{id:saved.actorId,name:saved.actorName,kind:'clone',parentTaskId:snapshot.taskId},originalPrompt:saved.goal,createdAt:saved.startedAt,recoveryAttempts:0} as any;
  assert.equal(restored.recover(checkpoint,{coordinator:restoredCoordinator,makeBrain:(_,task)=>{factories.push('live');return new Fake(task!.id);},makeRecoveredBrain:(_,task)=>{factories.push('saved');return recoveredBrain=new Fake(task!.id);}}),true);
  assert.deepEqual(factories,['saved'],'Only the saved attempt uses its checkpoint provider');
  restoredCoordinator.submitResult(saved.taskId!,saved.actorId!,{status:'completed',summary:'Saved research',artifacts:[{kind:'text',label:'Sources',value:'Evidence'}],verificationRefs:['fixture'],blockers:[]});recoveredBrain!.emit('turnEnd');
  assert.deepEqual(factories,['saved','live'],'New queued work must use Echo’s current provider factory, not the recovered provider');
 } finally {await donor.close();await restored.close();}
} finally {rmSync(root,{recursive:true,force:true});}
