import type {TaskCoordinator} from '../memory/task-state.js';
import type {MissionTaskState} from './swarm.js';
/** Owner-written progress only; never accept recovery context from the UI. */
export function savedAgentProgress(task:MissionTaskState,coordinator:TaskCoordinator) {
 const sources=[...new Set([...(task.retrySourceTaskIds??[]),...(task.taskId?[task.taskId]:[])])];
 const states=sources.map(id=>coordinator.get(id)).filter(s=>s!==null);
 if(states.length!==sources.length)throw Error('Saved tool history is unavailable. Review existing changes before starting a follow-up; Retry cannot safely continue this task.');
 if(states.some(s=>Object.values(s.calls).some(c=>c.effect!=='observation'&&c.effect!=='internal'&&!['success','denied'].includes(c.status))))throw Error('An external action has an uncertain outcome. Review and verify it before continuing; Retry will not repeat it blindly.');
 const calls=states.flatMap(s=>Object.values(s.calls).map(c=>({taskId:s.taskId,tool:c.tool,status:c.status,effect:c.effect,result:c.result})));
 return {sources,context:JSON.stringify({previousTaskId:task.taskId,lastProgress:task.draft,previousResult:task.result,appliedUpdates:task.updates?.filter(c=>c.operation==='update'&&c.status==='applied').map(c=>c.text),calls:calls.slice(-20),artifacts:states.flatMap(s=>s.artifacts),observations:states.flatMap(s=>Object.values(s.observations)).slice(-20)}).slice(0,24000)};
}
