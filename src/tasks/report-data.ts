import type {SupervisedState} from './supervisor.js';
import type {TaskState} from '../memory/task-state.js';
import {scrubSecrets} from '../safety/redact.js';
export interface ReportData {
  id:string;title:string;status:string;summary:string;duration:string;
  steps:Array<{title:string;status:string}>;
  checks:Array<{title:string;status:string;detail:string}>;
  reviews:Array<{title:string;summary:string}>;
  outputs:Array<{label:string;value:string}>;
  blockers:string[];cleanup:string;
}
export function taskReportData(state:SupervisedState, records:TaskState[]):ReportData {
  const worker=records.find(t=>t.taskId===state.workerTaskIds.at(-1));
  const checks=records.flatMap(t=>Object.values(t.calls).filter(c=>c.tool==='verify_task').flatMap(c=>{
    const results=(c.result?.data as {results?:Array<{check:string;ok:boolean;detail:string}>}|undefined)?.results;
    return results?.map(r=>({title:r.check,status:r.ok?'passed':'failed',detail:r.detail})) ?? [{title:`${c.tool} · ${t.taskId.endsWith('work1')?'worker':'agent'}`,status:c.result?.verification==='verified'?'passed':'unverified',detail:c.result?.text ?? c.status}];
  }));
  const value:ReportData={id:state.id,title:state.goal,status:state.status,summary:state.result?.summary ?? state.blockers.join(' '),
    duration:`${Math.round((state.updatedAt-state.createdAt)/1000)} seconds · ${state.attempt} attempt(s) · ${state.repairs} repair(s)`,
    steps:state.spec.steps.map((title,i)=>({title,status:worker?.steps[`step${i+1}`]?.status ?? 'unverified'})),checks,
    reviews:state.reviews.map(r=>({title:`${r.final?'Final':'Progress'} inspection · ${r.verdict}`,summary:r.summary})),
    outputs:(state.result?.artifacts ?? []).map(a=>({label:a.label,value:a.value})),blockers:state.blockers,
    cleanup:state.cleanup.finished?'All working and inspector agents stopped.':`Cleanup incomplete: ${state.cleanup.errors.join(' ')}`};
  return {...JSON.parse(scrubSecrets(JSON.stringify(value))),id:state.id};
}
