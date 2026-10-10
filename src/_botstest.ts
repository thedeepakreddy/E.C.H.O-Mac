import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'echo-bots-'));process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.JARVIS_FLEET_DIR=root;process.env.JARVIS_REMOTE_DIR=root;process.env.ECHO_MCP='0';
const {createMacBots,botRevision,botIntent}=await import('./frontier/bots.js');
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
 }finally{stopRemote();}
 // Exercise the actual Mac Gemini streaming adapter, preserving signatures and native tool data.
 const brain=new GeminiBrain(structuredClone(DEFAULTS_FOR_TESTS),'fixture-key',{openBot:true,allowedTools:new Set()});const b:any=brain;const deltas:string[]=[],done:string[]=[];
 brain.on('textDelta',d=>deltas.push(d.text));brain.on('textDone',d=>done.push(d.text));b.lastSend={taskId:'fixture-task',turnId:'fixture-turn'};
 b.ai={models:{generateContentStream:async()=>(async function*(){yield {candidates:[{content:{parts:[{text:'Private reasoning',thought:true},{text:'Useful '} ]}}]};yield {candidates:[{content:{role:'model',parts:[{text:'result.'},{functionCall:{id:'real-call',name:'recall',args:{query:'options'}},thoughtSignature:'keep-signature'}]},finishReason:'STOP'}]};})()}};
 const response=await b.generateStreaming({});assert.deepEqual(deltas,['Useful ','result.']);assert.deepEqual(done,['Useful result.']);const parts=response.candidates[0].content.parts;assert.equal(parts[0].text,'Useful result.');assert.equal(parts[1].thoughtSignature,'keep-signature');assert.deepEqual(parts[1].functionCall,{id:'real-call',name:'recall',args:{query:'options'}});
 b.turnAbort=new AbortController();b.turnAbort.abort();await assert.rejects(b.generateStreaming({}));
 console.log('PASS Mac bot lifecycle, persistence, scope, exact request IDs, grants, stop, follow-up, native GUI lane, remote allowlist and real Gemini OpenBot stream assembly.');
}finally{await host.close();rmSync(root,{recursive:true,force:true});}
