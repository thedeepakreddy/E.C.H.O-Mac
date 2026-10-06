import {createBrain} from '../brain/index.js';
import {brainProjectHint} from '../frontier/fleet-brain.js';
import {swarm} from '../frontier/swarm.js';
import {loadConfig, type JarvisConfig} from '../config.js';
import {getAppPath} from '../utils/appPath.js';
import {TOOLS} from '../tools/registry.js';
import {taskCoordinator} from '../memory/task-state.js';
import {outsideInvocation} from '../memory/invocation.js';
import {currentAgentRunContext, outsideAgentContext, runInAgentContext, type AgentRunContext, type AgentIdentity} from '../agent-replay/context.js';
import {getSession, grantProjectActors, listSessions} from '../coding/session.js';
import {inspectProjectCompletion} from '../coding/diagnostics.js';
import {projectFingerprint} from '../coding/snapshot.js';
import {sendToOverlay} from '../overlay.js';
import {TaskSupervisor, type SupervisedSpec, type SupervisedView} from './supervisor.js';
import {acquireDesktopTask,releaseDesktopTask} from './desktop-lane.js';
import {AutomaticTaskRouter} from './automatic.js';
import {ProviderMemoryContext} from '../memory/provider-context.js';
import {conversationId,conversations} from '../memory/conversation.js';
import {memoryService} from '../memory/service.js';

export const INSPECTOR_TOOLS=new Set(['inspect_supervised_task','read_supervised_evidence','submit_task_review','verify_task','inspect_task',
  'inspect_project','inspect_project_diagnostics','inspect_project_recovery','inspect_project_recipe',
  'search_project','read_project_file','project_diff','read_process','project_git_status','inspect_project_preview',
  'read_browser_page','web_search','list_ui_elements','read_screen_text','screenshot','frontmost_app','read_tool_result']);
const DELEGATION_TOOLS=new Set(['run_supervised_task','run_agent_mission','spawn_subagent','delegate_task','schedule_task',
  'start_project_build','try_approaches_in_parallel','send_message','switch_brain','submit_task_review','cancel_supervised_task','cancel_agent_mission','show_task_report']);
const DESKTOP_TOOLS=new Set(['open_url','open_app','click','click_ui_element','click_text','type_text','press_keys','scroll','drag','move_mouse','background_click','background_type','set_value','run_shortcut']);

/** Shared factory: all five provider adapters receive hard authority limits, not just prompt advice. */
export function makeSupervisedBrain(cfg: JarvisConfig, identity: AgentIdentity, spec: SupervisedSpec, inspector: boolean, create=createBrain) {
  const allowedTools=inspector?new Set(INSPECTOR_TOOLS):new Set(TOOLS.filter(t=>!DELEGATION_TOOLS.has(t.name) && (spec.lane==='gui' || !DESKTOP_TOOLS.has(t.name))).map(t=>t.name));
  if(!inspector) allowedTools.add('mcp__*');
  if(cfg.brain==='claude') allowedTools.add('ToolSearch'); // schema discovery still gates every eventual action
  const brain=create(cfg,{identity,maxRecoveryAttempts:0,autoResume:false,
    limits:{maxIterations:inspector?Math.min(30,spec.maxIterations ?? 30):spec.maxIterations,allowedTools}}).brain;
  brain.projectHint=brainProjectHint.value; return brain;
}
function asWorker<T>(view: SupervisedView, action:()=>T): T {
  const context:AgentRunContext={identity:{id:`${view.id}.worker`,name:'Task worker',kind:'clone',parentTaskId:view.id},
    taskId:view.workerTaskIds.at(-1)!, payloadRecording:false, privateMode:view.spec.privateMode,
    recorder:null!,loop:null!,scope:view.spec.scope};
  return outsideInvocation(()=>runInAgentContext(context,action));
}
async function verifyProjects(view:SupervisedView):Promise<string[]> {
  return asWorker(view,async()=>{
    const projects=listSessions().filter(p=>(view.spec.projectIds ?? []).includes(p.id) || p.supervisorTaskId===view.id || view.workerTaskIds.includes(p.taskId ?? ''));
    const blockers:string[]=[];
    for(const id of view.spec.projectIds ?? []) if(!projects.some(p=>p.id===id)) blockers.push(`Project ${id} is missing or inaccessible`);
    for(const project of projects) {
      const before=await projectFingerprint(project.id);
      const check=await inspectProjectCompletion(project.id);
      const after=await projectFingerprint(project.id);
      if(before.hash!==after.hash) blockers.push(`${project.name}: source changed during final verification`);
      if(!check.ready) blockers.push(...check.blockers.map(b=>`${project.name}: ${b}`));
    }
    return blockers;
  });
}
export const supervisor:TaskSupervisor=new TaskSupervisor({coordinator:taskCoordinator,
  makeWorker:(identity,spec)=>makeSupervisedBrain(loadConfig(getAppPath()),identity,spec,false),
  makeInspector:(identity,spec)=>makeSupervisedBrain(loadConfig(getAppPath()),identity,spec,true),verify:verifyProjects,
  onChange:()=>sendToOverlay('clones',[...swarm.list(),...supervisor.listAgents()].map(a=>({name:a.name,progress:a.progress}))),
  onReport:async state=>{releaseDesktopTask(state.id);swarm.wake();const {showTaskReport}=await import('./report-window.js');await showTaskReport(state);},
});
swarm.setExtraRoster(()=>supervisor.listAgents().map(a=>({name:a.name,progress:a.progress})));
swarm.setReservedCapacity(()=>supervisor.activeCount()?2:0);

export function startSupervisedTask(spec:SupervisedSpec) {
  const owner=currentAgentRunContext();
  const input={...spec,scope:{...spec.scope,supervisorOwnerActorId:owner?.identity.id ?? 'echo'}};
  const existing=supervisor.existing(input);if(existing)return existing;
  if(swarm.count()>2) throw new Error('Too many other agents are running. Wait or stop some to leave room for the worker and inspector.');
  if(spec.lane==='gui' && swarm.list().some(a=>a.lane==='gui')) throw new Error('Another GUI agent owns the desktop. Wait or cancel it before starting a supervised GUI task.');
  for(const id of spec.projectIds ?? []) getSession(id); // check caller's authority before detaching
  return outsideInvocation(()=>outsideAgentContext(()=>supervisor.start(input,async state=>{
    if(spec.lane==='gui' && !acquireDesktopTask(state.id)) throw new Error('Another supervised task owns the desktop');
    const grant=async()=>{for(const id of spec.projectIds ?? []) await grantProjectActors(id,[`${state.id}.worker`,`${state.id}.inspector`]);};
    await outsideInvocation(()=>owner?runInAgentContext(owner,grant):grant());
  })));
}

export const automaticTasks=new AutomaticTaskRouter({current:()=>supervisor.current(),latest:()=>supervisor.latest(),cancel:id=>supervisor.cancel(id),
  start:spec=>{
    const cfg=loadConfig(getAppPath()),scope=spec.scope ?? {};
    const mayRecall=ProviderMemoryContext.enabled && !spec.privateMode && (cfg.brain==='ollama' || ProviderMemoryContext.cloudRecall) && !memoryService.isSuppressed(scope);
    const historyId=conversationId('echo',scope);
    const context=mayRecall?conversations.packet(historyId,2000):'';
    // Only an exact owned project name/path or the current scoped project is delegated.
    // New builds keep their own workspace instead of silently reusing an old one.
    const modifies=/\b(?:fix|debug|refactor|improve|optimize|audit|review|existing|current)\b/i.test(spec.goal);
    const projectIds=spec.projectIds ?? (modifies?listSessions().filter(p=>
      p.name===scope.projectId || spec.goal.includes(p.root) ||
      (p.name.length>=3 && new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(spec.goal))).map(p=>p.id):[]);
    const state=startSupervisedTask({...spec,context,projectIds});
    try {conversations.append(historyId,{role:'user',text:spec.goal,taskId:state.id,provider:cfg.brain,actorId:'echo'},!spec.privateMode);}
    catch(error){console.error('[tasks] conversation recording failed after task start:',error);}
    return state;
  },
});
