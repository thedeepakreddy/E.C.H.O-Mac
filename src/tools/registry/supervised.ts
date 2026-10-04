import {z} from 'zod';
import type {ToolDef} from '../registry.js';
import {currentAgentRunContext} from '../../agent-replay/context.js';
import {currentInvocation} from '../../memory/invocation.js';
import {owningTaskId} from '../../frontier/task-handoff.js';
import type {SupervisedState} from '../../tasks/supervisor.js';
import {supervisionSummary} from '../../tasks/view.js';
import {taskCoordinator} from '../../memory/task-state.js';
const authorized=(state:SupervisedState|null)=>{
  if(!state)return false;
  const context=currentAgentRunContext();
  return (context?.identity.id ?? 'echo')===(state.spec.scope?.supervisorOwnerActorId ?? 'echo') || context?.identity.parentTaskId===state.id;
};

export const SUPERVISED_TOOLS:ToolDef[]=[
  {name:'run_supervised_task',readOnly:false,
    description:'Automatically execute a complex user request with a concrete plan, one worker, a temporary read-only inspector, bounded repairs and deterministic final verification. No user mode switch is required. Returns immediately; inspect_supervised_task gives progress. On completion or blocker a persistent report window opens. Use for substantial building, coding, research deliverables or multi-step app/browser work; clarify only material missing requirements first.',
    schema:{goal:z.string().min(1).max(12000),steps:z.array(z.string().min(1).max(2000)).min(1).max(30),acceptanceCriteria:z.array(z.string().min(1).max(2000)).min(1).max(20),
      projectIds:z.array(z.string().uuid()).max(10).default([]),lane:z.enum(['knowledge','gui']).default('knowledge'),
      timeoutMs:z.number().int().min(60000).max(3600000).default(1800000),maxIterations:z.number().int().min(10).max(200).default(80),maxRepairs:z.number().int().min(0).max(5).default(2)},
    handler:async a=>{const {startSupervisedTask}=await import('../../tasks/runtime.js');const context=currentAgentRunContext();
      const state=startSupervisedTask({...a,parentTaskId:owningTaskId(),privateMode:context?.privateMode,scope:context?.scope});
      return {text:`Supervised task ${state.id}: ${state.status}. Echo inspects, repairs within budget, verifies, stops its agents and shows a persistent report. Use inspect_supervised_task for progress; never claim completion until its status is completed. A repeated request in the same parent task reuses its saved work.`,data:{taskId:state.id,status:state.status}};},
  },
  {name:'inspect_supervised_task',readOnly:true,description:'Read saved supervised task progress, worker tool calls, plan, inspector reviews, evidence and blockers. Inspectors must use its fresh viewToken for submit_task_review.',
    schema:{taskId:z.string().optional(),callOffset:z.number().int().min(0).default(0)},handler:async a=>{const {supervisor}=await import('../../tasks/runtime.js');
      const found=a.taskId?supervisor.inspect(a.taskId):null;
      const data=a.taskId?(authorized(found)?supervisionSummary(found!,a.callOffset):null):supervisor.list().filter(authorized).map(v=>({id:v.id,goal:v.goal,status:v.status,attempt:v.attempt,blockers:v.blockers}));return {text:JSON.stringify(data,null,2),data,status:data?'success':'failed'};},
  },
  {name:'read_supervised_evidence',readOnly:true,description:'Read an original worker tool result within an owned supervised task. Use workerTaskId and callId from inspect_supervised_task; paginate to review real logs instead of asking the worker to repeat an action.',
    schema:{taskId:z.string(),workerTaskId:z.string(),callId:z.string(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(6000).default(6000)},
    handler:async a=>{const {supervisor}=await import('../../tasks/runtime.js');const state=supervisor.inspect(a.taskId);
      if(!authorized(state) || !state!.workerTaskIds.includes(a.workerTaskId)) return {text:'No grant for this worker evidence.',status:'failed'};
      const result=taskCoordinator.readCallResult(a.workerTaskId,a.callId);if(!result)return {text:'No saved result for that call.',status:'failed'};
      const original=JSON.stringify(result);return {text:original.slice(a.offset,a.offset+a.limit),status:'success',data:{verbatimPage:true,totalChars:original.length,nextOffset:a.offset+a.limit<original.length?a.offset+a.limit:null}};},
  },
  {name:'submit_task_review',readOnly:true,description:'Temporary inspector only: submit independent acceptance checks and concrete repair instructions. Final pass requires every exact criterion and verified tool evidence belonging to this inspector. Progress cannot declare completion.',
    schema:{viewToken:z.string().length(64),verdict:z.enum(['continue','repair','pass','blocked']),summary:z.string().min(10).max(12000),checks:z.array(z.object({criterion:z.string().min(1),passed:z.boolean(),verificationRefs:z.array(z.string()).max(100)})).max(20)},
    handler:async a=>{const {supervisor}=await import('../../tasks/runtime.js');const context=currentAgentRunContext(), invocation=currentInvocation();
      const taskId=owningTaskId(),actorId=invocation?.actorId ?? context?.identity.id;
      if(!taskId || !actorId) throw new Error('A review requires an active actor-owned inspector task');
      supervisor.submitReview(taskId,actorId,a);return {text:'Inspector review recorded. The supervisor will apply the final verification guard before declaring completion.',status:'success'};},
  },
  {name:'cancel_supervised_task',readOnly:false,description:'Cancel a supervised task and stop its worker and inspector. A cancellation report preserves its saved output and blockers.',schema:{taskId:z.string()},
    handler:async a=>{const {supervisor}=await import('../../tasks/runtime.js');if(!authorized(supervisor.inspect(a.taskId))) return {text:'Task not found or not owned by this actor.',status:'failed'};
      await supervisor.cancel(a.taskId);return {text:'Task stopped; inspect its saved report for partial output.',status:'success'};},
  },
  {name:'show_task_report',readOnly:true,description:'Reopen a persistent structured report for a finished supervised task. It stays on screen until the user closes it.',schema:{taskId:z.string().optional()},
    handler:async a=>{const {supervisor}=await import('../../tasks/runtime.js');const state=a.taskId?supervisor.inspect(a.taskId):supervisor.list().filter(authorized).find(s=>['completed','blocked','cancelled'].includes(s.status));
      if(!state || !authorized(state) || !['completed','blocked','cancelled'].includes(state.status)) return {text:'No owned finished report is available.',status:'failed'};
      const {showTaskReport}=await import('../../tasks/report-window.js');await showTaskReport(state);return {text:'Report opened; it remains until you close it.'};},
  },
];
