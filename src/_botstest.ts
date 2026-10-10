import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'echo-bots-'));process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.JARVIS_FLEET_DIR=root;process.env.JARVIS_REMOTE_DIR=root;process.env.ECHO_MCP='0';
const {createMacBots,botRevision,botIntent,TEAM_BOT_ID}=await import('./frontier/bots.js');
const {makeFleetBrain}=await import('./frontier/fleet-brain.js');
const {getFleetMember}=await import('./frontier/fleet.js');
const {SwarmManager}=await import('./frontier/swarm.js');
const {taskCoordinator}=await import('./memory/task-state.js');
const {parseRemoteAction,startRemote,stopRemote,setStatusProvider,setActionHandler}=await import('./frontier/remote.js');
const {setPassword}=await import('./frontier/remoteauth.js');
const {GeminiBrain}=await import('./brain/gemini.js');const {DEFAULTS_FOR_TESTS}=await import('./config.js');
class FakeBrain extends EventEmitter {sent='';opts:any;interrupted=false;send(text:string,_a?:unknown,o?:unknown){this.sent=text;this.opts=o;}interrupt(){this.interrupted=true;}async stop(){}}
const brains:FakeBrain[]=[];const host=new SwarmManager();let privateMode=false;
const bots=createMacBots(host,()=>({makeBrain:()=>{const b=new FakeBrain();brains.push(b);return b;}}),()=>({projectId:'test-project'}),()=>!privateMode);
try {
 const member=getFleetMember('research')!,request={name:member.id,botRevision:botRevision(member),requestId:randomUUID(),goal:'Research useful options'};
 assert.equal(bots.run({...request,requestId:'bad'}).ok,false);privateMode=true;assert.equal(bots.run(request).ok,false);privateMode=false;
 assert.equal(bots.run({...request,botRevision:'stale'}).ok,false);const accepted=bots.run(request);assert.equal(accepted.ok,true);assert.equal(brains.length,1);assert.ok(brains[0].sent.includes('cite what you read'));assert.ok(brains[0].sent.includes('submit_agent_result'));
 assert.equal(bots.run(request).data?.repeated,true);assert.equal(brains.length,1);assert.equal(bots.run({...request,goal:'Different'}).ok,false);assert.equal(bots.run({...request,requestId:randomUUID()}).ok,false);
 const first=host.getMission(accepted.data!.missionId!)!,step=first.tasks.research;assert.equal(step.runtime,'openbot');assert.equal(step.budget.maxIterations,40);assert.equal(first.scope.projectId,'test-project');assert.throws(()=>makeFleetBrain(DEFAULTS_FOR_TESTS,(()=>{throw Error('must not construct');}) as any)({id:'test',name:'Test',role:'clone'} as any,{...step,botRevision:'changed'}),/changed after/);
 taskCoordinator.submitResult(step.taskId!,step.actorId!,{status:'completed',summary:'Compared the actual evidence.',artifacts:[{kind:'text',label:'Comparison',value:'Verified comparison text.'}],verificationRefs:['source:fixture'],blockers:[]});brains[0].emit('turnEnd');assert.equal(bots.list().jobs[0].status,'completed');
 const follow=bots.run({...request,requestId:randomUUID(),goal:'Explain the cheapest option',parentId:first.id});assert.equal(follow.ok,true);assert.ok(brains[1].sent.includes('Compared the actual evidence.'));assert.equal(bots.stop(first.id).ok,false);assert.equal(bots.stop(follow.data!.missionId!).ok,true);assert.equal(brains[1].interrupted,true);
 const next=bots.run({...request,requestId:randomUUID(),goal:'Read this website'});assert.equal(next.ok,true);assert.equal(host.getMission(next.data!.missionId!)!.tasks.research.lane,'gui');assert.equal(bots.stop(next.data!.missionId!).ok,true);
 const restored=createMacBots(new SwarmManager(),()=>({makeBrain:()=>{throw Error('must not auto-run');}}),()=>({}),()=>true);assert.equal(restored.list().jobs.length,3);assert.equal(brains.length,3);
 // Both former solo/board routes resolve to the same durable request and reject active duplicate work.
 const legacy=bots.legacy({name:'research',goal:'One canonical task'});assert.equal(legacy.ok,true);const legacyCount=brains.length;
 assert.equal(bots.legacy({agentIds:['research'],goal:'One canonical task'}).data?.missionId,legacy.data!.missionId);assert.equal(brains.length,legacyCount);
 const duplicate=bots.run({...request,goal:'One canonical task',requestId:randomUUID()});assert.equal(duplicate.ok,false);assert.equal(duplicate.data?.missionId,legacy.data!.missionId);assert.equal(brains.length,legacyCount);
 assert.equal(bots.stop(legacy.data!.missionId!).ok,true);assert.equal(bots.legacy({name:'research',goal:'One canonical task'}).data?.repeated,true);assert.equal(brains.length,legacyCount);
 // The actual scheduler runs Research -> Plan -> Review -> Lead, with hard read-only grants.
 const teamRequest={name:TEAM_BOT_ID,goal:'Compare the choices and prepare a decision',botRevision:bots.revision(TEAM_BOT_ID),requestId:randomUUID(),agentIds:['research','plan','review']};
 const beforeTeam=brains.length,team=bots.run(teamRequest);assert.equal(team.ok,true);const teamId=team.data!.missionId!;assert.equal(brains.length,beforeTeam+1);
 assert.equal(bots.run(teamRequest).data?.repeated,true);assert.equal(bots.run({...teamRequest,agentIds:['research','write']}).ok,false);assert.equal(bots.run({...teamRequest,requestId:randomUUID()}).data?.missionId,teamId);assert.equal(brains.length,beforeTeam+1);
 let teamState=host.getMission(teamId)!;assert.equal(teamState.tasks.research.status,'working');assert.equal(teamState.tasks.lead.status,'pending');assert.deepEqual(teamState.tasks.lead.dependsOn,['plan','research','review']);
 for(const task of Object.values(teamState.tasks)){
  assert.equal(task.readOnly,true);let limits:any;makeFleetBrain(DEFAULTS_FOR_TESTS,((_cfg:any,o:any)=>{limits=o.limits;return {brain:new FakeBrain()};}) as any)({id:'grant-test',name:'Grant test',role:'clone'} as any,task);
  assert.ok(limits.allowedTools.has('recall'));assert.ok(limits.allowedTools.has('submit_agent_result'));assert.equal(limits.allowedTools.has('write_local_file'),false);assert.equal(limits.allowedTools.has('run_terminal_command'),false);assert.equal(limits.allowedTools.has('spawn_agent'),false);
 }
 function complete(missionId:string,profile:string,summary:string,status:'completed'|'failed'='completed'){
  const task=host.getMission(missionId)!.tasks[profile];assert.equal(task.status,'working');const brain=brains.find(b=>b.opts?.taskId===task.taskId)!;assert.ok(brain);
  taskCoordinator.submitResult(task.taskId!,task.actorId!,{status,summary,artifacts:status==='completed'?[{kind:'text',label:`${profile} report`,value:summary}]:[],verificationRefs:[`fixture:${profile}`],blockers:status==='failed'?['fixture failure']:[]});brain.emit('turnEnd');
 }
 complete(teamId,'research','Research verified evidence');assert.equal(brains.length,beforeTeam+2);assert.ok(brains.at(-1)!.sent.includes('Research verified evidence'));assert.equal(host.getMission(teamId)!.tasks.review.status,'pending');
 complete(teamId,'plan','Ordered plan using research');assert.equal(brains.length,beforeTeam+3);assert.ok(brains.at(-1)!.sent.includes('Ordered plan using research'));assert.equal(host.getMission(teamId)!.tasks.lead.status,'pending');
 complete(teamId,'review','Review checked the evidence and plan');assert.equal(brains.length,beforeTeam+4);assert.ok(brains.at(-1)!.sent.includes('Review checked the evidence and plan'));assert.ok(brains.at(-1)!.sent.includes('Research verified evidence'));
 complete(teamId,'lead','One consolidated decision');assert.equal(host.getMission(teamId)!.status,'completed');assert.equal(bots.list().jobs.find(j=>j.id===teamId)!.result!.summary,'One consolidated decision');
 const failedTeam=bots.run({...teamRequest,requestId:randomUUID(),goal:'A team with a failed dependency'});const beforeFailure=brains.length;complete(failedTeam.data!.missionId!,'research','The source is unavailable','failed');assert.equal(brains.length,beforeFailure);assert.equal(host.getMission(failedTeam.data!.missionId!)!.tasks.lead.status,'blocked');assert.equal(host.getMission(failedTeam.data!.missionId!)!.status,'failed');
 // A subset remains the same team when a signed-in Phone follows up without resending its selection.
 const subset=bots.run({...teamRequest,requestId:randomUUID(),goal:'Research and write the comparison',agentIds:['research','write']});assert.equal(subset.ok,true);assert.equal(bots.stop(subset.data!.missionId!).ok,true);
 const subsetFollow=bots.run({...teamRequest,requestId:randomUUID(),goal:'Explain that result',parentId:subset.data!.missionId!,agentIds:undefined});assert.equal(subsetFollow.ok,true);assert.deepEqual(Object.keys(host.getMission(subsetFollow.data!.missionId!)!.tasks).sort(),['lead','research','write']);assert.equal(bots.stop(subsetFollow.data!.missionId!).ok,true);
 // Existing board history is projected into the same task list; old clients cannot replay it.
 const oldId=`board-${Date.now()}`,old=host.submitMission({id:oldId,goal:'An existing board task',scope:{projectId:'test-project'},tasks:[{id:'research',profile:'research',goal:'An existing board task'}]}, {makeBrain:()=>{const b=new FakeBrain();brains.push(b);return b;}});assert.equal(old.ok,true);const oldCount=brains.length;
 assert.ok(bots.list().jobs.some(j=>j.id===oldId));assert.equal(bots.legacy({name:'research',goal:'An existing board task'}).data?.missionId,oldId);assert.equal(brains.length,oldCount);assert.equal(bots.stop(oldId).ok,true);
 assert.ok(parseRemoteAction({type:'stop-bot',missionId:oldId}));assert.equal(parseRemoteAction({type:'run-bot',...teamRequest})?.type,'run-bot');assert.equal(parseRemoteAction({type:'run-bot',...teamRequest,agentIds:['bad id']}),null);assert.equal(parseRemoteAction({type:'run-bot',...request,agentIds:['research']}),null);
 for(const text of ['Ask Research to compare laptops','Echo, run Plan bot: plan tomorrow'])assert.ok(botIntent(text));for(const text of ['How do I ask Research to compare?','He said ask Research to compare','Do not ask Research to compare'])assert.equal(botIntent(text),null);
 assert.equal(parseRemoteAction({type:'run-bot',...request})?.type,'run-bot');assert.equal(parseRemoteAction({type:'run-bot',...request,goal:'x'.repeat(4001)}),null);assert.equal(parseRemoteAction({type:'stop-bot',missionId:'ordinary-mission'}),null);
 // A real signed-in Phone route dispatches the same host bot, never a cloud pass alone.
 const probe=http.createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
 setPassword('fixture-private-password');setStatusProvider(()=>({bots:bots.list()}));setActionHandler(async a=>a.type==='run-bot'?bots.run(a):a.type==='stop-bot'?bots.stop(a.missionId):{ok:false});
 const remote=await startRemote({port,ttlMs:60000,relay:{url:'http://127.0.0.1:9',secret:'fixture-relay-secret-'.repeat(3)}});assert.equal(remote.ok,true);const token=new URL(remote.url!).searchParams.get('t'),base=`http://127.0.0.1:${port}`;
 try {
  const body={type:'run-bot',...request,requestId:randomUUID(),goal:'Research from my phone'};
  assert.equal((await fetch(`${base}/action?t=${token}`,{method:'POST',headers:{'content-type':'application/json','x-echo-pass':'cloud-pass-alone'},body:JSON.stringify(body)})).status,401);
  const login=await fetch(`${base}/login?t=${token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'fixture-private-password'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const action=async(b:unknown)=>(await fetch(`${base}/action?t=${token}`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(b)})).json();
  const started=await action(body);assert.equal(started.ok,true);assert.equal((await action(body)).data.repeated,true);
  const status=await fetch(`${base}/status?t=${token}`,{headers:{cookie}}).then(r=>r.json());assert.ok(status.bots.jobs.some((j:any)=>j.id===started.data.missionId));assert.equal((await action({type:'stop-bot',missionId:started.data.missionId})).ok,true);
  const fromPhone={type:'run-bot',...teamRequest,requestId:randomUUID(),agentIds:['research','write'],goal:'A selected team from the phone'};const phoneTeam=await action(fromPhone);assert.equal(phoneTeam.ok,true);assert.equal((await action(fromPhone)).data.missionId,phoneTeam.data.missionId);assert.deepEqual(Object.keys(host.getMission(phoneTeam.data.missionId)!.tasks).sort(),['lead','research','write']);assert.equal((await action({type:'stop-bot',missionId:phoneTeam.data.missionId})).ok,true);
  const phoneFollow=await action({type:'run-bot',name:TEAM_BOT_ID,botRevision:bots.revision(TEAM_BOT_ID),requestId:randomUUID(),goal:'Explain the same team result',parentId:phoneTeam.data.missionId});assert.equal(phoneFollow.ok,true);assert.deepEqual(Object.keys(host.getMission(phoneFollow.data.missionId)!.tasks).sort(),['lead','research','write']);assert.equal((await action({type:'stop-bot',missionId:phoneFollow.data.missionId})).ok,true);

 }finally{stopRemote();}
 // Exercise the actual Mac Gemini streaming adapter, preserving signatures and native tool data.
 const brain=new GeminiBrain(structuredClone(DEFAULTS_FOR_TESTS),'fixture-key',{openBot:true,allowedTools:new Set()});const b:any=brain;const deltas:string[]=[],done:string[]=[];
 brain.on('textDelta',d=>deltas.push(d.text));brain.on('textDone',d=>done.push(d.text));b.lastSend={taskId:'fixture-task',turnId:'fixture-turn'};
 b.ai={models:{generateContentStream:async()=>(async function*(){yield {candidates:[{content:{parts:[{text:'Private reasoning',thought:true},{text:'Useful '} ]}}]};yield {candidates:[{content:{role:'model',parts:[{text:'result.'},{functionCall:{id:'real-call',name:'recall',args:{query:'options'}},thoughtSignature:'keep-signature'}]},finishReason:'STOP'}]};})()}};
 const response=await b.generateStreaming({});assert.deepEqual(deltas,['Useful ','result.']);assert.deepEqual(done,['Useful result.']);const parts=response.candidates[0].content.parts;assert.equal(parts[0].text,'Useful result.');assert.equal(parts[1].thoughtSignature,'keep-signature');assert.deepEqual(parts[1].functionCall,{id:'real-call',name:'recall',args:{query:'options'}});
 b.turnAbort=new AbortController();b.turnAbort.abort();await assert.rejects(b.generateStreaming({}));
 console.log('PASS shared single/team dispatch, duplicate protection, legacy history, read-only grants, Research/Plan/Review/Lead scheduler ordering, failure propagation, Mac bot lifecycle, persistence, scope, exact request IDs, grants, stop, follow-up, native GUI lane, remote allowlist and real Gemini OpenBot stream assembly.');
}finally{await host.close();rmSync(root,{recursive:true,force:true});}
