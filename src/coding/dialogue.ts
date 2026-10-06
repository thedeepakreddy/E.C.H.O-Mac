import {randomUUID} from 'node:crypto';
import {getSession,listSessions,mutateSession,updateProject} from './session.js';
import {stopAllCodingProcesses,stopProcess} from './processes.js';
import {closeProjectPreviews} from './preview.js';
import type {Brain} from '../brain/types.js';import type {JarvisConfig} from '../config.js';
import {isBuildStatusRequest} from './progress.js';
import {readProcess} from './processes.js';
import type {TaskState} from '../memory/task-state.js';
import {automaticTaskSpec} from '../tasks/automatic.js';
import {currentAgentRunContext} from '../agent-replay/context.js';
import type {SupervisedSpec} from '../tasks/supervisor.js';
import type {BuildSession} from './session.js';
const workers=new Map<string,{brain:Brain;phase:'building'|'paused';prompt:string}>();
type BuildEvent={kind:'progress'|'question'|'error'|'finished';projectId:string;text:string};
let eventHandler:(event:BuildEvent)=>void=()=>{};
export const setCodingEventHandler=(handler:typeof eventHandler)=>{eventHandler=handler;};
export async function askBuildQuestion(id:string,revision:number,text:string,options:string[]=[]){
 const result=await mutateSession(id,revision,session=>{session.question={id:randomUUID(),text,options};session.phase='waiting-for-input';});
 const worker=workers.get(id);if(worker){worker.phase='paused';worker.brain.interrupt();}
 eventHandler({kind:'question',projectId:id,text});return result.session;
}
export async function answerBuildQuestion(id:string,questionId:string,answer:string){const session=getSession(id);
 if(session.question?.id!==questionId||session.question.answer)throw new Error('Question is no longer pending. Inspect the current project.');
 return (await mutateSession(id,session.revision,s=>{s.question!.answer=answer;s.contentRevision=(s.contentRevision??0)+1;s.decisions.push(`Question: ${s.question!.text}\nAnswer: ${answer}`);s.phase='planning';})).session;
}
/** The old build entry point and question/continuation paths share the same supervisor. */
export function supervisedProjectSpec(session:BuildSession,prompt:string):SupervisedSpec {
 const spec=automaticTaskSpec('Build a saved project application with verification and regression tests.')!;
 const context=currentAgentRunContext();
 return {...spec,goal:`Build or continue project ${session.name} (${session.id}). User request: ${prompt}. Inspect the saved project specification, decisions and acceptance criteria before changing it.`,
  projectIds:[session.id],privateMode:session.privateMode,scope:context?.scope,parentTaskId:context?.taskId,
  lane:automaticTaskSpec(prompt)?.lane ?? (session.target==='desktop'?'gui':'knowledge'),
  acceptanceCriteria:session.acceptance.length && session.acceptance.length<=18?[...session.acceptance,...spec.acceptanceCriteria.slice(1)]:spec.acceptanceCriteria};
}
export async function startProjectBuild(id:string,prompt:string,cfg:JarvisConfig,makeBrain?:()=>Brain,isCurrent:()=>boolean=()=>true){
 const session=getSession(id);if(workers.get(id)?.phase==='building')throw new Error('This project already has an active writer. Send a change instead.');
 if([...workers.entries()].some(([key,value])=>key!==id&&value.phase==='building'))throw new Error('One coding writer may run at a time on this laptop. Pause the current build first.');
 if(!makeBrain){
  const {startSupervisedTask}=await import('../tasks/runtime.js');
  if(!isCurrent())throw new Error('Build request was cancelled before starting');
  const state=startSupervisedTask(supervisedProjectSpec(session,prompt));
  return {projectId:id,phase:'building',revision:session.revision,taskId:state.id};
 }
 const actorId=`coding-${id}`;
 await mutateSession(id,session.revision,s=>{s.grantedActors=[...new Set([...(s.grantedActors??[]),actorId])];s.phase='implementing';s.decisions.push(`Build request: ${prompt}`);});
 const previous=workers.get(id);if(previous)await previous.brain.stop();
 const brain=makeBrain();
 const worker:{brain:Brain;phase:'building'|'paused';prompt:string}={brain,phase:'building',prompt};workers.set(id,worker);
 brain.on('text',text=>eventHandler({kind:'progress',projectId:id,text}));
 brain.on('progress',text=>eventHandler({kind:'progress',projectId:id,text}));
 brain.on('tool',info=>eventHandler({kind:'progress',projectId:id,text:`Working on ${info.name.replace(/_/g,' ')}.`}));
 brain.on('error',text=>{worker.phase='paused';eventHandler({kind:'error',projectId:id,text});});
 brain.on('turnEnd',()=>{worker.phase='paused';eventHandler({kind:'finished',projectId:id,text:'Coding worker stopped. Inspect project checks and preview evidence before reporting completion.'});});
 const current=getSession(id);
 brain.send(`Build project ${id} at ${current.root}, revision ${current.revision}. User request: ${prompt}\nSaved specification: ${current.spec}\nDecisions: ${JSON.stringify(current.decisions)}\nAcceptance: ${JSON.stringify(current.acceptance)}\nUse inspect_project, project file/patch tools and managed processes. Preserve unrelated files. Ask only blocking questions with ask_build_question, which pauses this worker until the user answers. Inspect recipe/tools first. Verify compiler/test/browser evidence; do not mark completed merely after writing files. Missing toolchain/services are explicit blockers.`,undefined,{privateMode:current.privateMode,parentTaskId:session.taskId});
 return {projectId:id,phase:'building',revision:current.revision};
}
export async function handleBuildInput(text:string,cfg:JarvisConfig,foreground?:TaskState|null,isCurrent:()=>boolean=()=>true):Promise<string|null>{
 if(!isCurrent())return null;
 const sessions=listSessions().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 if(isBuildStatusRequest(text)&&sessions.length){
  const active=sessions.find(s=>text.toLowerCase().includes(s.name.toLowerCase()))??sessions.find(s=>workers.get(s.id)?.phase==='building')??sessions.find(s=>!['completed','cancelled','failed'].includes(s.phase))??sessions[0];
  const checked=active.artifacts.filter(a=>a.kind==='check').at(-1);let last='';
  if(checked)try{const check=JSON.parse(checked.value);const process=await readProcess(active.id,check.processId);last=` Last recorded check: ${check.name} ${process.status==='exited'&&process.exitCode===0?'passed':process.status}.`;}catch{last=' The last check could not be inspected.';}
  const count=new Set(active.artifacts.filter(a=>a.kind==='acceptance-evidence').map(a=>{try{const e=JSON.parse(a.value);return e.contentRevision===(active.contentRevision??0)?e.criterion:null;}catch{return null;}}).filter(Boolean)).size;
  const foregroundActive=foreground&&['running','waiting','verifying'].includes(foreground.status);
  const activity=workers.get(active.id)?.phase==='building'?'The background coding worker is active.':foregroundActive?'A foreground task is active; no background coding worker is running.':'No coding worker is active; the saved phase alone does not mean work is continuing.';
  return `${active.name}: saved phase ${active.phase}. ${count} of ${active.acceptance.length} acceptance criteria have recorded evidence.${last} ${active.question&&!active.question.answer?`Waiting for your answer: ${active.question.text}`:activity}`;
 }
 const pending=sessions.find(s=>s.question&&!s.question.answer);
 if(pending&&!/\b(?:status|progress)\b|^(?:continue|resume|build|create|start)\b|^(?:what|why|how|where|when|who)\b|\?$|\b(?:stop|cancel|pause)\b/i.test(text)){
  const answered=await answerBuildQuestion(pending.id,pending.question!.id,text);await startProjectBuild(answered.id,`Continue after the user's answer: ${text}`,cfg,undefined,isCurrent);return `Saved your answer. Continuing ${answered.name}.`;
 }
 const active=sessions.find(s=>workers.has(s.id))??sessions.find(s=>['blocked','implementing','planning','waiting-for-input'].includes(s.phase));if(!active)return null;
 if(/^(?:pause|stop|cancel)(?:\s+(?:the|this|my))?(?:\s+(?:build|project|coding|work))?[.!]?$/i.test(text)){const worker=workers.get(active.id);if(worker){worker.phase='paused';worker.brain.interrupt();}const cancelled=/^(?:stop|cancel)\b/i.test(text);if(cancelled)for(const processId of active.processIds)try{await stopProcess(active.id,processId);}catch{}const current=getSession(active.id);await updateProject(active.id,current.revision,{phase:cancelled?'cancelled':'blocked'});return `${cancelled?'Stopped':'Paused'} ${active.name}. Progress is saved.`;}
 if(/^(?:continue|resume)(?:\s+(?:the|this|my))?(?:\s+(?:build|project|coding|work))?[.!]?$/i.test(text)){await startProjectBuild(active.id,'Continue the saved project from its next unfinished step.',cfg,undefined,isCurrent);return `Continuing ${active.name}.`;}
 if(/\b(?:build|project|coding)\b.*\b(?:status|progress|doing|finished)\b|\b(?:status|progress)\b.*\b(?:build|project)\b/i.test(text))return `${active.name} is ${active.phase}, revision ${active.revision}. ${active.question&&!active.question.answer?`Waiting for: ${active.question.text}`:''}`;
 if(/^(?:add|change|make|remove|replace|use|switch|fix)\b/i.test(text)&&workers.get(active.id)?.phase==='building'){
  const updated=await mutateSession(active.id,active.revision,s=>{s.decisions.push(`User change: ${text}`);s.contentRevision=(s.contentRevision??0)+1;});
  workers.get(active.id)!.brain.send(`User changed project requirements at revision ${updated.session.revision}: ${text}. Inspect the latest project state and preserve completed work.`);
  return `Queued that change for ${active.name}.`;
 }
 return null;
}
export async function stopCodingWorkers(){closeProjectPreviews();await stopAllCodingProcesses();for(const worker of workers.values())try{await worker.brain.stop();}catch{};workers.clear();}
