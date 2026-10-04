import type {SupervisedView} from './supervisor.js';
/** Keep the inspection prompt bounded; original tool results are paginated separately. */
export function supervisionSummary(view:SupervisedView,callOffset=0) {
  const task=view.workerTask;
  const calls=Object.values(task?.calls ?? {}).reverse();
  return {id:view.id,goal:view.goal,status:view.status,attempt:view.attempt,repairs:view.repairs,
    plan:view.spec.steps,acceptanceCriteria:view.spec.acceptanceCriteria,projectIds:view.spec.projectIds,
    workerTaskId:task?.taskId,viewToken:view.viewToken,steps:task?.steps,
    result:task?.result?{...task.result,artifacts:task.result.artifacts.slice(0,20).map(a=>({...a,value:a.value.slice(0,2000)}))}:undefined,
    calls:calls.slice(callOffset,callOffset+12).map(c=>({callId:c.callId,tool:c.tool,status:c.status,verification:c.result?.verification,text:c.result?.text?.slice(0,1200)})),
    callCount:calls.length,nextCallOffset:callOffset+12<calls.length?callOffset+12:null,
    reviews:view.reviews.slice(-8).map(r=>({taskId:r.taskId,final:r.final,verdict:r.verdict,summary:r.summary.slice(0,2000)})),
    blockers:view.blockers,cleanup:view.cleanup};
}
