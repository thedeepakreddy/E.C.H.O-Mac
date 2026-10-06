import assert from 'node:assert/strict';
import {automaticTaskSpec, AutomaticTaskRouter} from './tasks/automatic.js';
import type {SupervisedSpec, SupervisedState} from './tasks/supervisor.js';
import {TaskSupervisor} from './tasks/supervisor.js';
import {TaskCoordinator} from './memory/task-state.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';

const coding = [
  'Build a calculator app and show me on my Mac.',
  'Can you build a full-stack StudyForge website with login, courses, a database and regression tests?',
  'I want you to create a desktop application for tracking expenses.',
  'Create a shopping app with products, login, a cart and tests.',
  'Please implement a REST API with authentication, database migrations and tests.',
  'Fix the login bugs in my application and rerun its regression tests.',
  'Refactor the entire tool calling architecture and verify all connections.',
  'Write a production backend with authentication and regression tests.',
];
for (const request of coding) {
  const spec = automaticTaskSpec(request);
  assert(spec, request); assert.equal(spec.goal, request); assert(spec.steps.length >= 4);
  assert(spec.acceptanceCriteria.some(c => /regression/i.test(c)), request);
}
assert.equal(automaticTaskSpec(coding[0])!.lane, 'gui');
assert.equal(automaticTaskSpec(coding[1])!.lane, 'knowledge');
for (const request of [
  'Research battery technologies, compare the evidence and create a detailed report.',
  'Open Safari, find three hotels, compare their prices, then save a report on my Mac.',
  'Audit the whole application, find errors and fix them, then run the tests.',
]) assert(automaticTaskSpec(request), request);
assert.equal(automaticTaskSpec('Open Safari, find three hotels, compare their prices, then save a report on my Mac.')!.lane, 'gui');
assert(!automaticTaskSpec('Research full-stack websites, compare the evidence and create a detailed report.')!.acceptanceCriteria.some(c=>/regression/i.test(c)));

for (const request of [
  'Hello', 'What is a full-stack app?', 'How can I build a large website?',
  'Can Echo build a website?', 'Suggest a website idea so I can build it.',
  'Tell me how to build a full application.', 'Do not build an app yet.',
  "Don't create a website; just explain it.", 'Build nothing for now.',
  'The log says "build a full website". What does that mean?',
  'Write a function that adds two numbers.', 'Open Safari.', 'Check log.',
  'Check the full stack documentation.', 'Create a Vercel API key.',
  'Create a new folder named website.', 'Build the app we discussed earlier.',
  'Create a diagram of a full-stack app.', 'Write a tutorial about building a website.',
  'Build an app.', 'What is the progress?',
]) assert.equal(automaticTaskSpec(request), null, request);

const starts: SupervisedSpec[] = [];
let current: SupervisedState | null = null;
const router = new AutomaticTaskRouter({
  current: () => current,
  latest: () => current,
  cancel: async () => {current!.status='cancelled';},
  start: spec => {
    starts.push(spec);
    current = {version:1,id:'supervised.fixture',goal:spec.goal,status:'executing',spec,attempt:1,repairs:0,
      workerTaskIds:[],inspectorTaskIds:[],reviews:[],blockers:[],cleanup:{finished:false,errors:[]},createdAt:0,updatedAt:0};
    return current;
  },
});
assert.equal(router.handle('Hello'), null); assert.equal(starts.length, 0);
assert.match(router.handle(coding[1], {scope:{projectId:'study'},privateMode:true})!, /started|starting/i);
assert.equal(starts.length, 1); assert.equal(starts[0].scope?.projectId, 'study'); assert.equal(starts[0].privateMode, true);
assert.match(router.handle(coding[1])!, /already|still/i); assert.equal(starts.length, 1);
assert.match(router.handle(coding[0])!, /already|still/i); assert.equal(starts.length, 1);
assert.match(router.handle('did you finish?')!, /executing|working/i); assert.equal(starts.length, 1);
current!.status = 'inspecting';
assert.match(router.handle('are you done?')!, /inspect/i);
current!.status = 'blocked'; current!.blockers = ['Regression check failed'];
assert.match(router.handle('did you finish?')!, /blocked.*Regression check failed/i);
current!.status = 'completed';
assert.match(router.handle('did you finish?')!, /verified|completed/i);
assert.match(router.handle(coding[0])!, /started|starting/i); assert.equal(starts.length, 2);
assert.match(router.control('stop the task')!, /Stopping/);assert.equal(current!.status,'cancelled');

const unavailable = new AutomaticTaskRouter({current:()=>null,latest:()=>null,cancel:async()=>{},start:()=>{throw Error('No room for an inspector');}});
assert.match(unavailable.handle(coding[1])!, /could not start.*No room for an inspector/i);
assert.equal(unavailable.handle('are you done?'), null);
const olderReport=new AutomaticTaskRouter({current:()=>null,latest:()=>({...current!,status:'completed'}),cancel:async()=>{},start:()=>{throw Error('No action requested');}});
assert.equal(olderReport.control('did you finish?',true),null);
assert.equal(olderReport.handle('did you finish?',{foregroundBusy:true}),null);
const root=mkdtempSync(join(tmpdir(),'echo-automatic-task-'));
const worker=new EventEmitter() as any;let workerPrompt='',stops=0,reports=0;
worker.send=(text:string)=>workerPrompt=text;worker.interrupt=()=>{};worker.stop=async()=>{stops++;};
const supervisor=new TaskSupervisor({coordinator:new TaskCoordinator(root),makeWorker:()=>worker,
  makeInspector:()=>{throw Error('A cancelled job must not start its inspector');},verify:async()=>[],onReport:()=>reports++});
try {
  const liveRouter=new AutomaticTaskRouter({start:spec=>supervisor.start({...spec,context:'User chose a dark theme.'}),
    current:()=>supervisor.current(),latest:()=>supervisor.latest(),cancel:id=>supervisor.cancel(id)});
  assert.match(liveRouter.handle(coding[1])!,/started/);
  assert.match(workerPrompt,/StudyForge/);assert.match(workerPrompt,/dark theme/);
  assert.equal(supervisor.activeCount(),1);assert.equal(supervisor.current('other.actor'),null);
  await supervisor.cancelOwned('other.actor');assert.equal(stops,0);
  await supervisor.cancelOwned();assert.equal(stops,1);assert.equal(reports,1);
  assert.equal(supervisor.latest()?.status,'cancelled');assert.equal(supervisor.activeCount(),0);
} finally {await supervisor.close();rmSync(root,{recursive:true,force:true});}
console.log('PASS automatic task routing: natural requests, lightweight exclusions, GUI lane, ownership context, duplicate prevention, truthful status and admission failure');
