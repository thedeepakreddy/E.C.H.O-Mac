import type {MissionState,MissionTaskState} from '../frontier/swarm.js';
import type {SupervisedState} from './supervisor.js';
export function supervisionPanel(state:SupervisedState,workerDone=false,inspectorActive=false):MissionState {
  const finished=['completed','blocked','cancelled'].includes(state.status);
  const status=finished?state.status as 'completed'|'blocked'|'cancelled':'running';
  const task=(id:'worker'|'inspector'):MissionTaskState=>({id,goal:id==='worker'?state.goal:'Independently inspect the plan, evidence and acceptance criteria',
    lane:id==='worker'?state.spec.lane ?? 'knowledge':'knowledge',acceptanceCriteria:state.spec.acceptanceCriteria,
    budget:{timeoutMs:id==='worker'?state.spec.timeoutMs ?? 1800000:120000,maxIterations:id==='worker'?state.spec.maxIterations ?? 80:30,maxRecoveryAttempts:0},
    recoveryAttempts:0,taskId:id==='worker'?state.workerTaskIds.at(-1):state.inspectorTaskIds.at(-1),
    actorId:`${state.id}.${id}`,actorName:id==='worker'?'Task worker':'Task inspector',startedAt:state.createdAt,
    status:finished?status as 'completed'|'blocked'|'cancelled':id==='worker'?(workerDone?'partial':'working'):(inspectorActive?'working':'pending'),
    result:finished?state.result:undefined});
  return {schemaVersion:1,id:state.id,taskId:state.id,goal:state.goal,status,scope:state.spec.scope ?? {},
    tasks:{worker:task('worker'),inspector:task('inspector')},createdAt:state.createdAt,updatedAt:state.updatedAt,result:state.result};
}
