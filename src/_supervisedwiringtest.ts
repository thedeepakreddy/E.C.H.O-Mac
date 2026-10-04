import assert from 'node:assert/strict';
import {DEFAULTS_FOR_TESTS} from './config.js';
import {makeSupervisedBrain,INSPECTOR_TOOLS} from './tasks/runtime.js';
import {TOOLS,TOOL_MAP} from './tools/registry.js';
import {ROUTER_ALWAYS_INCLUDE} from './brain/tool-router.js';
import {LOCAL_TOOL_NAMES} from './brain/localtools.js';
import {toolPermitted,toolGranted,withToolPermissions} from './safety/tool-permissions.js';
import {SwarmManager} from './frontier/swarm.js';
import {TaskCoordinator} from './memory/task-state.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {taskReportData} from './tasks/report-data.js';
import {outsideInvocation,currentInvocation,runInInvocation} from './memory/invocation.js';
import {currentAgentRunContext,outsideAgentContext,runInAgentContext} from './agent-replay/context.js';
import {codingRequestToolAllowed} from './coding/tool-selection.js';
const spec={goal:'Build',steps:['Implement','Test'],acceptanceCriteria:['Observed result'],lane:'gui' as const,maxIterations:80};
for(const brain of ['claude','gemini','openai','openrouter','ollama'] as const){
  let options:any;
  const create=((cfg:any,opts:any)=>{assert.equal(cfg.brain,brain);options=opts;return {brain:{projectHint:undefined},provider:brain};}) as any;
  makeSupervisedBrain({...structuredClone(DEFAULTS_FOR_TESTS),brain},{id:'worker',name:'Worker',kind:'clone'},spec,false,create);
  assert.equal(options.limits.allowedTools.has('apply_project_patch'),true);assert.equal(options.limits.allowedTools.has('submit_agent_result'),true);
  assert.equal(options.limits.allowedTools.has('spawn_subagent'),false);assert.equal(options.limits.allowedTools.has('run_supervised_task'),false);
  assert.equal(options.limits.allowedTools.has('start_project_build'),false);
  assert.equal(toolGranted(options.limits.allowedTools,'mcp__jarvis__start_project_build'),false);
  assert.equal(toolGranted(options.limits.allowedTools,'mcp__service__query'),true);
  assert.equal(toolGranted(options.limits.allowedTools,'mcp__jarvis__spawn_subagent'),false);
  makeSupervisedBrain({...structuredClone(DEFAULTS_FOR_TESTS),brain},{id:'inspector',name:'Inspector',kind:'clone'},spec,true,create);
  assert.equal(options.limits.maxIterations,30);
  assert.equal(options.autoResume,false);assert.equal(options.maxRecoveryAttempts,0);
  for(const name of ['apply_project_patch','run_terminal_command','invoke_coding_tool','spawn_subagent','open_app','open_url']) assert.equal(options.limits.allowedTools.has(name),false);
  assert.equal(withToolPermissions(options.limits.allowedTools,()=>toolPermitted('apply_project_patch')),false);
  assert.equal(toolGranted(options.limits.allowedTools,'mcp__service__query'),false);
  for(const name of INSPECTOR_TOOLS) assert.equal(TOOL_MAP.get(name)?.readOnly,true,`${name} must be a real read-only tool`);
}
assert.equal(withToolPermissions(new Set(['inspect_task']),()=>withToolPermissions(new Set(['mcp__*']),()=>toolPermitted('mcp__service__query'))),false,'nested external grant cannot widen caller authority');
{
  const swarm=new SwarmManager();let made=0;
  const denied=swarm.recover({actor:{kind:'clone',id:'inspector',name:'Inspector',parentTaskId:'supervised.root'}} as any,{makeBrain:()=>{made++;throw new Error('Must not recover with unrestricted grants');}});
  assert.equal(denied,false);assert.equal(made,0);
  const root=mkdtempSync(join(tmpdir(),'echo-reserved-capacity-'));
  const coordinator=new TaskCoordinator(root);
  let reservation=2;swarm.setReservedCapacity(()=>reservation);
  swarm.submitMission({goal:'Capacity fixture',tasks:[1,2,3].map(i=>({id:`task${i}`,goal:'Work'}))},
    {coordinator,broadcast:()=>{},makeBrain:()=>{const brain=new EventEmitter() as any;brain.send=()=>{};brain.stop=async()=>{};return brain;}});
  assert.equal(swarm.count(),2);reservation=0;swarm.wake();assert.equal(swarm.count(),3);
  await swarm.close();assert.equal(swarm.count(),0);rmSync(root,{recursive:true,force:true});
}
for(const name of ['run_supervised_task','inspect_supervised_task','read_supervised_evidence','submit_task_review','cancel_supervised_task','show_task_report','read_browser_page']){
  assert(TOOL_MAP.has(name));assert(ROUTER_ALWAYS_INCLUDE.has(name));assert((LOCAL_TOOL_NAMES as readonly string[]).includes(name));
  assert(codingRequestToolAllowed(name),`${name} must survive the coding-specific pruning pass`);
}
assert.equal(TOOLS.length,new Set(TOOLS.map(t=>t.name)).size);
runInAgentContext({identity:{id:'launcher'},taskId:'old'} as any,()=>runInInvocation({taskId:'old'} as any,()=>outsideInvocation(()=>outsideAgentContext(()=>{
  assert.equal(currentInvocation(),null);assert.equal(currentAgentRunContext(),null);
}))));
console.log('All five brains share supervised worker grants, read-only inspector limits, tool routing and detached lifecycle ownership');
