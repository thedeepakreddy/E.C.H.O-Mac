import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'echo-retry-evidence-'));
process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.ECHO_MCP='0';
try{
 const {taskCoordinator}=await import('./memory/task-state.js');
 const {createInvocation,runInInvocation}=await import('./memory/invocation.js');
 const {runInAgentContext}=await import('./agent-replay/context.js');
 const {conversationId}=await import('./memory/conversation.js');
 const {AGENT_TOOLS}=await import('./tools/registry/agents.js');
 const {savedAgentProgress,retryEvidenceOriginal}=await import('./frontier/agent-retry.js');
 const scope={projectId:'retry-evidence-fixture'},sourceId='source-evidence',actorId='source-owner';
 taskCoordinator.create({taskId:sourceId,ownerActorId:actorId,goal:'Gather original evidence',scope});
 for(let i=0;i<25;i++){
  const invocation={...createInvocation(sourceId,actorId,'fixture_read',{},root),callId:`original-${i}`};
  taskCoordinator.startCall(invocation,'fixture_read','observation');
  taskCoordinator.endCall(invocation,{status:'success',text:`Original ${i}: ${'evidence '.repeat(1200)}`,data:{toolData:{stable:'value',index:i}},verification:'verified'});
 }
 const source=taskCoordinator.get(sourceId)!;
 taskCoordinator.patch(sourceId,{actorId,expectedRevision:source.revision,generation:source.generation,changes:{artifacts:[{kind:'text',label:'Long artifact',value:'artifact '.repeat(6000)}],observations:[{id:'observation-fixture',sourceCallId:'original-0',observedAt:new Date().toISOString(),value:'observed '.repeat(6000)}]}});
 const task={taskId:sourceId,actorId,draft:'Saved partial report '.repeat(5000),retrySourceTaskIds:[]} as any;
 const progress=savedAgentProgress(task,taskCoordinator);
 const manifest=JSON.parse(progress.context);
 assert.equal(manifest.schemaVersion,1);
 assert(progress.context.length<=24000,'The whole manifest must be valid bounded JSON, not a cut JSON string');
 assert.deepEqual(manifest.sourceTaskIds,[sourceId]);
 assert.equal(manifest.sources[0].calls.totalItems,25);
 assert.equal(manifest.sources[0].artifacts.totalItems,1);
 assert.equal(manifest.sources[0].observations.totalItems,1);
 assert.equal(manifest.sources[0].original.callId,'@retry-evidence');
 assert(manifest.sources[0].calls.items.every((item:any)=>item.taskId===sourceId&&typeof item.callId==='string'));
 assert(manifest.lastProgress.totalChars>24000);
 console.log('PASS valid bounded retry manifest, stable source/call IDs and explicit original evidence paging');
 const nextId='retry-current',nextActor='retry-owner';
 taskCoordinator.create({taskId:nextId,ownerActorId:nextActor,goal:'Continue saved work',scope});
 taskCoordinator.bind(nextId,'retrySourceTaskIds',progress.sources);
 const read=AGENT_TOOLS.find(tool=>tool.name==='read_tool_result')!;
 const context={taskId:nextId,identity:{id:nextActor,name:'Retry',kind:'clone'},scope,conversationId:conversationId(nextActor,scope),privateMode:false,payloadRecording:false} as any;
 const get=(args:Record<string,unknown>,overrides:Record<string,unknown>={})=>runInAgentContext({...context,...overrides},()=>runInInvocation(createInvocation(nextId,nextActor,'read_tool_result',args,root),()=>read.handler(args)));
 const first=await get({sourceTaskId:sourceId,callId:'original-0'});
 assert.equal(first.status,'success','The explicitly bound source must return its archived original, without re-running the tool');
 const allPages=async(args:Record<string,unknown>,afterFirst?:()=>void)=>{
  let text='',offset=0,pages=0;
  do{const result=await get({...args,offset,limit:6000});assert.equal(result.status,'success');assert(result.text!==undefined);assert(result.text.length<=6000);text+=result.text;offset=(result.data as any).nextOffset;assert(++pages<100);if(pages===1)afterFirst?.();}while(offset!==null);
  return text;
 };
 const original=JSON.parse(await allPages({sourceTaskId:sourceId,callId:'original-0'}));
 assert.match(original.text,/^Original 0:/);assert.deepEqual(original.data,{toolData:{stable:'value',index:0}});
 const inventoryText=await allPages({sourceTaskId:sourceId,callId:'@retry-evidence'});
 assert(inventoryText.length>24000);const inventory=JSON.parse(inventoryText);
 assert.deepEqual(inventory.calls.map((call:any)=>call.callId),Array.from({length:25},(_,i)=>`original-${i}`));
 assert(inventory.calls.every((call:any)=>call.taskId===sourceId&&call.original.sourceTaskId===sourceId));
 assert.equal(inventory.progress.lastProgress,task.draft);assert.equal(inventory.artifacts[0].value,'artifact '.repeat(6000));assert.equal(inventory.observations[0].value,'observed '.repeat(6000));
 // Call IDs need not be globally unique; never guess a source from a call ID.
 const currentCall={...createInvocation(nextId,nextActor,'fixture_read',{},root),callId:'original-0'};
 taskCoordinator.startCall(currentCall,'fixture_read','observation');taskCoordinator.endCall(currentCall,{status:'success',text:'Current task result'});
 assert.equal((await get({callId:'original-0'})).text,'Current task result');
 assert.match((await get({sourceTaskId:sourceId,callId:'original-0'})).text??'',/Original 0:/);
 assert.equal((await get({callId:'@retry-evidence'})).status,'denied','Inventory retrieval requires an explicit source');
 taskCoordinator.create({taskId:'foreign-evidence',ownerActorId:'foreign-owner',goal:'Foreign confidential task',scope});
 const foreign={...createInvocation('foreign-evidence','foreign-owner','fixture_read',{},root),callId:'original-0'};
 taskCoordinator.startCall(foreign,'fixture_read','observation');taskCoordinator.endCall(foreign,{status:'success',text:'Foreign confidential result'});
 const assertDenied=async(args:Record<string,unknown>,overrides:Record<string,unknown>={})=>{
  const result=await get(args,overrides);assert.equal(result.status,'denied');assert.doesNotMatch(result.text??'',/Original 0:|Foreign confidential result/);
 };
 await assertDenied({sourceTaskId:'foreign-evidence',callId:'original-0'});
 await assertDenied({sourceTaskId:nextId,callId:'original-0'});
 await assertDenied({sourceTaskId:sourceId,callId:'original-0'},{identity:{id:'wrong-actor'}});
 await assertDenied({sourceTaskId:sourceId,callId:'original-0'},{conversationId:'wrong-conversation'});
 await assertDenied({sourceTaskId:sourceId,callId:'original-0'},{scope:{projectId:'different-project'}});
 await assertDenied({sourceTaskId:sourceId,callId:'original-0'},{privateMode:true});
 // Simulate persisted source identity drift without mutating the real journal.
 const originalGet=taskCoordinator.get.bind(taskCoordinator),originalRead=taskCoordinator.readCallResult.bind(taskCoordinator);let archiveReads=0;
 taskCoordinator.readCallResult=(...args)=>{archiveReads++;return originalRead(...args);};
 try{
  for(const changed of [{ownerActorId:'new-owner'},{scope:{projectId:'different-project'}},{privateMode:true},{bindings:{}}]){
   taskCoordinator.get=id=>{const state=originalGet(id);return state&&id===sourceId?{...state,...changed}:state;};
   await assertDenied({sourceTaskId:sourceId,callId:'original-0'});
  }
  assert.equal(archiveReads,0,'Denied evidence is rejected before reading any archived payload');
 }finally{taskCoordinator.get=originalGet;taskCoordinator.readCallResult=originalRead;}
 // Overflow must be explicit, not an arbitrary last-20 drop. Older source IDs
 // and every omitted call remain discoverable in the paged original inventory.
 const older='many-evidence',olderActor='older-owner';
 let lateRead:ReturnType<typeof createInvocation>|undefined;
 taskCoordinator.create({taskId:older,ownerActorId:olderActor,goal:'Many saved results',scope});
 for(let i=0;i<100;i++){
  const call={...createInvocation(older,olderActor,'fixture_read',{},root),callId:`older-${i}`};
  taskCoordinator.startCall(call,'fixture_read','observation');
  if(i===0)lateRead=call;else taskCoordinator.endCall(call,{status:'success',text:`Saved older result ${i}: ${'bounded excerpt '.repeat(40)}`});
 }
 const many=savedAgentProgress({taskId:older,actorId:olderActor,draft:'Another partial report',retrySourceTaskIds:[sourceId]} as any,taskCoordinator);
 const bounded=JSON.parse(many.context);
 assert(many.context.length<=24000);assert.deepEqual(bounded.sourceTaskIds,[sourceId,older]);assert.equal(bounded.totalTasks,2);
 const olderPreview=bounded.sources[1].calls;
 assert.equal(olderPreview.totalItems,100);assert(olderPreview.items.length<100);assert.equal(olderPreview.nextIndex,olderPreview.items.length);
 assert.equal(olderPreview.items[0].callId,'older-0');
 taskCoordinator.bind(nextId,'retrySourceTaskIds',many.sources);
 const beforeLate=retryEvidenceOriginal(taskCoordinator.get(older)!);
 const olderInventoryText=await allPages({sourceTaskId:older,callId:'@retry-evidence'},()=>taskCoordinator.endCall(lateRead!,{status:'failed',text:'Late observation failure'}));
 assert(olderInventoryText===beforeLate,'Late observations must not corrupt concatenated inventory pages');
 const olderInventory=JSON.parse(olderInventoryText);
 assert.equal(olderInventory.calls[0].status,'running','Inventory pages must remain a coherent saved snapshot when a late observation ends');
 assert.equal(olderInventory.calls.length,100);assert.equal(olderInventory.calls[99].callId,'older-99');
 assert.match((await get({sourceTaskId:older,callId:'older-99'})).text??'',/Saved older result 99:/);
 taskCoordinator.bind(nextId,'retrySourceTaskIds',[]);
 await assertDenied({sourceTaskId:sourceId,callId:'original-0'});
 taskCoordinator.bind(nextId,'retrySourceTaskIds',many.sources);
 await assertDenied({sourceTaskId:sourceId,callId:'original-0',offset:-1});
 const {TaskCoordinator}=await import('./memory/task-state.js');
 const reopened=new TaskCoordinator(taskCoordinator.root());
 const {retrySourceIdentityMatches}=await import('./frontier/agent-retry.js');
 assert(retrySourceIdentityMatches(reopened.get(sourceId)!),'Host ownership pin remains valid after journal reload');
 assert.throws(()=>savedAgentProgress({...task,actorId:'wrong-owner'},taskCoordinator),/ownership/);
 const uncertain={...createInvocation(sourceId,actorId,'fixture_send',{},root),callId:'uncertain-action'};
 taskCoordinator.startCall(uncertain,'fixture_send','action');
 assert.throws(()=>savedAgentProgress(task,taskCoordinator),/uncertain/,'In-flight effects still block retry preparation');
 console.log('PASS original archive and inventory paging, >20 call IDs, >24k progress/artifacts, collision isolation and foreign/actor/conversation/scope/private/owner-change denial');
}finally{rmSync(root,{recursive:true,force:true});}
