import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskCoordinator} from './memory/task-state.js';
import {TaskSupervisor} from './tasks/supervisor.js';

class Agent extends EventEmitter {
  sent: any[] = []; stops = 0;
  send(text: string, _audio?: unknown, opts?: any) { this.sent.push({text, opts}); }
  interrupt() {}
  async stop() { this.stops++; }
}
const root = mkdtempSync(join(tmpdir(), 'echo-supervised-'));
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
let count = 0;
function fixture(name: string, overrides: any = {}) {
  const coordinator = new TaskCoordinator(join(root, name));
  const workers: Agent[] = [], inspectors: Agent[] = [], reports: any[] = [];
  const supervisor = new TaskSupervisor({coordinator,
    makeWorker: () => {const a = new Agent(); workers.push(a); return a;},
    makeInspector: () => {const a = new Agent(); inspectors.push(a); return a;},
    verify: async () => [], onReport: state => reports.push(state), ...overrides});
  const state = supervisor.start({goal:'Build a working calculator', steps:['Implement', 'Test'],
    acceptanceCriteria:['2 + 3 displays 5'], timeoutMs:5000, inspectionIntervalMs:1000, maxRepairs:1});
  return {coordinator, supervisor, workers, inspectors, reports, id:state.id};
}
function finishWorker(f: ReturnType<typeof fixture>, valid = true) {
  const w = f.workers.at(-1)!; const taskId = w.sent[0].opts.taskId;
  const task = f.coordinator.get(taskId)!;
  if (valid) f.coordinator.recordVerification(taskId, ['check:regression']);
  if (valid) f.coordinator.updatePlan({taskId,actorId:task.ownerActorId,callId:'plan',stepId:'plan',generation:task.generation,baseRevision:task.revision,resources:[],inputHash:'plan'},
    ['Implement','Test'].map((description,i)=>({id:`step${i+1}`,description,status:'completed',verificationRefs:['check:regression']})));
  f.coordinator.submitResult(taskId, task.ownerActorId, {status:'completed', summary:'Implemented and tested',
    artifacts:[{kind:'text',label:'Output',value:'Calculator output'}], verificationRefs:['check:regression'], blockers:[]});
  w.emit('turnEnd');
}
function review(f: ReturnType<typeof fixture>, verdict: 'pass'|'repair', refs = ['check:independent']) {
  const inspector = f.inspectors.at(-1)!;
  const taskId = inspector.sent[0].opts.taskId;
  const task = f.coordinator.get(taskId)!;
  f.coordinator.recordVerification(taskId, ['check:independent']);
  const snapshot = f.supervisor.inspect(f.id)!;
  f.supervisor.submitReview(taskId, task.ownerActorId, {viewToken:snapshot.viewToken!, verdict,
    summary: verdict === 'pass' ? 'Observed output and regression results' : 'Addition displays the wrong value; fix and rerun regression',
    checks:[{criterion:'2 + 3 displays 5',passed:verdict==='pass',verificationRefs:refs}]});
  inspector.emit('turnEnd');
}
try {
  {
    const f = fixture('complete'); finishWorker(f); await tick();
    assert.equal(f.supervisor.panelMissions()[0].status,'running');assert.equal(f.supervisor.panelMissions()[0].tasks.inspector.status,'working');assert.equal(f.supervisor.companionMetadata()[0].live,true);
    const restored=new TaskSupervisor({coordinator:f.coordinator,makeWorker:()=>new Agent(),makeInspector:()=>new Agent(),verify:async()=>[]});assert.equal(restored.companionMetadata()[0].live,false);assert.equal(restored.companionMetadata()[0].privateMode,false);
    assert.equal(f.supervisor.inspect(f.id)?.status, 'inspecting');
    assert.equal(f.reports.length, 0, 'worker completion must not publish success');
    review(f,'pass'); await tick();
    assert.equal(f.supervisor.inspect(f.id)?.status,'completed');
    assert.equal(f.supervisor.panelMissions()[0].status,'completed');assert.equal(f.supervisor.companionMetadata()[0].live,false);
    assert.equal(f.reports.length,1); assert.equal(f.workers[0].stops,1); assert.equal(f.inspectors[0].stops,1);
    f.workers[0].emit('turnEnd'); f.inspectors[0].emit('turnEnd'); await tick();
    assert.equal(f.reports.length,1, 'late events cannot publish twice'); count++;
  }
  {
    const f = fixture('repair'); finishWorker(f); await tick(); review(f,'repair'); await tick();
    assert.equal(f.workers.length,2); assert.match(f.workers[1].sent[0].text,/wrong value/);
    finishWorker(f); await tick(); review(f,'pass'); await tick();
    assert.equal(f.supervisor.inspect(f.id)?.status,'completed');
    assert.equal(f.supervisor.inspect(f.id)?.repairs,1); count++;
  }
  {
    const f = fixture('false-evidence'); finishWorker(f); await tick();
    assert.throws(()=>review(f,'pass',['invented:proof']),/evidence/i);
    const inspector=f.inspectors.at(-1)!;const id=inspector.sent[0].opts.taskId;
    f.coordinator.recordVerification(id,['observation:claimed-result']);
    assert.throws(()=>review(f,'pass',['observation:claimed-result']),/evidence/i);
    assert.equal(f.reports.length,0); await f.supervisor.cancel(f.id); count++;
  }
  {
    const f = fixture('worker-fabrication'); finishWorker(f,false); await tick();
    review(f,'pass'); await tick();
    assert.notEqual(f.supervisor.inspect(f.id)?.status,'completed');
    await f.supervisor.cancel(f.id); count++;
  }
  {
    const f = fixture('verification-blocker',{verify:async()=>['Regression test failed']});
    finishWorker(f); await tick(); review(f,'pass'); await tick();
    assert.equal(f.workers.length,2); finishWorker(f); await tick(); review(f,'pass'); await tick();
    assert.equal(f.supervisor.inspect(f.id)?.status,'blocked');
    assert.match(f.reports[0].blockers.join(' '),/Regression/); count++;
  }
  {
    const f = fixture('cancel'); await f.supervisor.cancel(f.id); f.workers[0].emit('turnEnd'); await tick();
    assert.equal(f.supervisor.inspect(f.id)?.status,'cancelled'); assert.equal(f.inspectors.length,0);
    assert.equal(f.workers[0].stops,1); assert.equal(f.reports.length,1); count++;
  }
  {
    const f=fixture('stale-review');finishWorker(f);await tick();
    const inspector=f.inspectors[0], own=inspector.sent[0].opts.taskId;
    const old=f.supervisor.inspect(f.id)!.viewToken;
    f.coordinator.recordVerification(f.supervisor.inspect(f.id)!.workerTaskIds[0],['new:observation']);
    assert.throws(()=>f.supervisor.submitReview(own,f.coordinator.get(own)!.ownerActorId,{viewToken:old,verdict:'repair',summary:'Old review',checks:[]}),/changed/);
    assert.throws(()=>f.supervisor.submitReview(own,'unrelated.actor',{viewToken:old,verdict:'repair',summary:'Old review',checks:[]}),/owns/);
    await f.supervisor.cancel(f.id);assert.equal(inspector.stops,1);count++;
  }
  {
    const f=fixture('cleanup-timeout',{cleanupTimeoutMs:10,makeWorker:()=>{const a=new Agent();a.stop=()=>new Promise<void>(()=>{});return a;}});
    await f.supervisor.cancel(f.id);
    assert.equal(f.supervisor.inspect(f.id)?.cleanup.finished,false);
    assert.match(f.supervisor.inspect(f.id)!.cleanup.errors.join(' '),/exceeded/);count++;
  }
  {
    const f=fixture('progress');await new Promise(resolve=>setTimeout(resolve,1050));
    const i=f.inspectors[0],taskId=i.sent[0].opts.taskId,actorId=f.coordinator.get(taskId)!.ownerActorId;
    f.supervisor.submitReview(taskId,actorId,{viewToken:f.supervisor.inspect(f.id)!.viewToken,verdict:'repair',summary:'Check the planned arithmetic before claiming success',checks:[]});
    i.emit('turnEnd');await tick();assert.match(f.workers[0].sent.at(-1).text,/Inspector/);
    finishWorker(f);await tick();assert.equal(f.inspectors.length,2,'finished work gets a new independent final inspection');
    review(f,'pass');await tick();assert.equal(f.supervisor.inspect(f.id)?.status,'completed');count++;
  }
  {
    const f=fixture('initialization',{makeInspector:()=>{throw new Error('Provider unavailable');}});
    finishWorker(f);await tick();assert.equal(f.supervisor.inspect(f.id)?.status,'blocked');assert.match(f.reports[0].blockers[0],/Provider unavailable/);count++;
  }
  {
    const f=fixture('restart');await f.supervisor.cancel(f.id);
    const saved=f.coordinator.lookup<any>(f.id,'supervised');saved.status='executing';f.coordinator.bind(f.id,'supervised',saved);
    const recovered=new TaskSupervisor({coordinator:f.coordinator,makeWorker:()=>{throw new Error('Must not rerun');},makeInspector:()=>new Agent(),verify:async()=>[]});
    recovered.reconcile();assert.equal(recovered.inspect(f.id)?.status,'blocked');assert.match(recovered.inspect(f.id)!.blockers[0],/restarted/);count++;
  }
  {
    const f=fixture('duplicate');await f.supervisor.cancel(f.id);
    const spec={...f.supervisor.inspect(f.id)!.spec,parentTaskId:'parent'};
    const next=f.supervisor.start(spec);assert.equal(f.workers.length,2);
    assert.equal(f.supervisor.start(spec).id,next.id,'same parent retry reuses the active task');
    assert.equal(f.workers.length,2);await f.supervisor.cancel(next.id);
    assert.equal(f.supervisor.start(spec).status,'cancelled','same parent retry also reuses a terminal result');count++;
  }
  {
    const f=fixture('panel-stop');
    f.workers[0].emit('text','Working on the regression checks');assert.match(f.supervisor.listAgents()[0].progress,/regression/);
    assert.equal(f.supervisor.send('Task worker','Inspect the new requirement'),true);assert.match(f.workers[0].sent.at(-1).text,/new requirement/);
    assert.equal(f.supervisor.send('Task inspector','Forge a pass'),false);
    assert.equal(await f.supervisor.forget(f.id),true);assert.equal(f.supervisor.inspect(f.id),null);assert.equal(f.supervisor.panelMissions().length,0);
    f.workers[0].emit('turnEnd');await tick();assert.equal(f.supervisor.inspect(f.id),null);count++;
  }
  {
    const agent=new Agent();(agent as any).stop=undefined;
    const f=fixture('missing-stop',{makeWorker:()=>agent});await f.supervisor.cancel(f.id);
    assert.equal(f.supervisor.inspect(f.id)?.cleanup.finished,false);assert.match(f.supervisor.inspect(f.id)!.cleanup.errors[0],/no stop implementation/);count++;
  }
  console.log(`${count} supervised task lifecycle groups passed`);
} finally {rmSync(root,{recursive:true,force:true});}
