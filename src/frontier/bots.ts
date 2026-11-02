import {createHash} from 'node:crypto';
import {listFleet,getFleetMember,type FleetMember} from './fleet.js';
import type {MissionState,SwarmManager,SwarmDeps,AgentTaskSpec} from './swarm.js';
import {toProviderMessages} from '../vendor/openbot/history.js';
import {PROVENANCE_GUIDANCE} from '../vendor/openbot/bot-prompt.js';
import {parseVerdict} from './agent-playbooks.js';

export const TEAM_BOT_ID = 'echo:team'; // Cannot collide with a saved fleet id.
export const DEFAULT_TEAM = ['research','plan','review'];
/** Longest task or instruction; matches Echo Phone's MAX_GOAL. */
export const MAX_GOAL = 16000;
/** Saved results keep the agent's full output; this only bounds a runaway payload. */
const MAX_RESULT_TEXT = 200000;
/** Every bot task: the full deliverable is saved, and the agent judges it honestly. */
const DELIVERABLE_CRITERION = 'Put the COMPLETE deliverable in a text artifact (label it with what it is); keep summary to the outcome. End the deliverable with a Quality check and one Verdict line (PASS, PASS WITH MINOR ISSUES, PARTIAL PASS, FAIL or BLOCKED BY MISSING INFORMATION). Submit status completed only if that verdict is PASS or PASS WITH MINOR ISSUES and verificationRefs hold real evidence (URLs or tool results you read); otherwise submit partial or blocked and list what remains.';
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const botRevision = (b:FleetMember) => hash(b).slice(0,24);
export const teamRevision = () => hash(listFleet().sort((a,b)=>a.id.localeCompare(b.id))).slice(0,24);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LEGACY_RUN = /^(?:board-\d{10,16}|solo-[a-z][a-z0-9-]{0,23}-\d{10,16})$/;
export const isBotRunId = (id:string) => /^bot-[a-f0-9-]{36}$/.test(id) || LEGACY_RUN.test(id);
export interface BotRequest {name?:string;goal?:string;requestId?:string;botRevision?:string;parentId?:string;agentIds?:string[]}
type Host = Pick<SwarmManager,'getMission'|'listMissions'|'isMissionLive'|'submitMission'|'cancelMission'|'controlMissionTask'|'taskControlSupported'>;
/** The independent Review step added to single-specialist runs; never counted as a team member. */
export const VERIFY_TASK = 'verify';
const VERIFIED_ROLES = new Set(['research','analyse','write','plan']);
const VERIFY_CRITERION = 'You are the independent verifier for this task, not its author. Read the deliverable in Dependency Results against the user\'s task. Re-read each cited source with read_browser_page and judge every important claim SUPPORTED, PARTIAL or UNSUPPORTED from what the page actually says (meaning, not only numbers). Flag reasoning problems as major or minor (conclusions that do not follow, causal claims from correlation, missing obvious counter-considerations). For writing, judge whether tone, register and format fit the audience the user asked for. Do not invent problems; if it holds up, say what you checked. Submit completed only if the verdict is PASS or PASS WITH MINOR ISSUES.';
const profileIds = (m:MissionState) => [...new Set(Object.values(m.tasks).filter(t=>t.id!==VERIFY_TASK).map(t=>t.profile).filter((p):p is string=>!!p))].sort();
const own = (m:MissionState) => m.id.startsWith('bot-') && m.scope.echoBot===true || LEGACY_RUN.test(m.id) && Object.values(m.tasks).length>0 && Object.values(m.tasks).every(t=>typeof t.profile==='string');
const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
const bounded = (r:MissionState['result']) => r ? {...r,summary:r.summary.slice(0,MAX_RESULT_TEXT),artifacts:[...new Map(r.artifacts.map(a=>[JSON.stringify([a.kind,a.label,a.value]),a])).values()].slice(0,8).map(a=>({...a,label:a.label.slice(0,160),value:a.value.slice(0,MAX_RESULT_TEXT)})),verificationRefs:r.verificationRefs.slice(0,12).map(v=>v.slice(0,500)),blockers:r.blockers.slice(0,8).map(b=>b.slice(0,1000))}:undefined;
const identity = (r:BotRequest) => hash({name:r.name,goal:r.goal?.trim(),revision:r.botRevision,parentId:r.parentId??null,agentIds:r.agentIds?[...new Set(r.agentIds)].sort():null});

/** Both pages and Phone dispatch to this service; Swarm remains the only job store and executor. */
export function createMacBots(host:Host,deps:()=>SwarmDeps,scope:()=>Record<string,unknown>,capture:()=>boolean,options:{verify?:boolean}={}) {
 /** Single Research/Analyse/Write/Plan runs get an independent Review step unless turned off. */
 const verify=options.verify!==false;
 function revision(name:string) {return name===TEAM_BOT_ID?teamRevision():getFleetMember(name)?botRevision(getFleetMember(name)!):'';}
 function list() {
  const fleet=listFleet();
  const bots=fleet.filter(b=>b.id!=='lead').map(b=>({id:b.id,name:b.name,role:b.brief,description:b.description,revision:botRevision(b),custom:b.custom,mode:b.custom?'read tools':'native tools',team:false,defaultAgentIds:[] as string[]}));
  bots.push({id:TEAM_BOT_ID,name:'Team of specialists',role:'Selected specialists prepare reports. Lead combines them after they finish.',description:'Several perspectives and one combined report; reading tools only.',revision:teamRevision(),custom:false,mode:'team · read tools',team:true,defaultAgentIds:[...DEFAULT_TEAM]});
  const jobs=host.listMissions().filter(own).slice(0,12).map(m=>{
   const ids=profileIds(m),team=m.scope.botId===TEAM_BOT_ID||ids.length>1;
   const primary=team?m.tasks.lead?.result:(m.tasks[ids[0]]??Object.values(m.tasks)[0])?.result;
   const result=bounded(m.result);
   if(result && primary?.status==='completed')result.summary=primary.summary.slice(0,MAX_RESULT_TEXT);
   if(result)result.artifacts=[...new Map(result.artifacts.map(a=>[JSON.stringify([a.kind,a.label,a.value]),a])).values()];
   // The independent Review step's verdict travels with the result the user reads.
   const check=team?undefined:m.tasks[VERIFY_TASK]?.result;
   if(result&&check){const text=[check.summary,...check.artifacts.map(a=>a.value)].join('\n\n'),verdict=parseVerdict(text);
    if(!result.artifacts.some(a=>a.label==='Independent review'))result.artifacts.push({kind:'text',label:'Independent review',value:text.slice(0,MAX_RESULT_TEXT)});
    if(!(verdict==='PASS'||verdict==='PASS WITH MINOR ISSUES')){const line=`Independent review: ${verdict??check.status} · ${check.summary.split('\n')[0].slice(0,300)}`;if(!result.blockers.includes(line))result.blockers.push(line);}}
   return {id:m.id,botId:team?TEAM_BOT_ID:String(m.scope.botId??ids[0]??''),botName:team?'Team of specialists':String(m.scope.botName??getFleetMember(ids[0])?.name??ids[0]??'Specialist'),agentIds:ids.filter(id=>id!=='lead'),goal:m.goal,status:m.status==='running'&&!host.isMissionLive(m.id)?'interrupted':m.status,createdAt:m.createdAt,updatedAt:m.updatedAt,result,steps:Object.values(m.tasks).map(t=>({id:t.id,name:t.actorName??getFleetMember(t.profile??'')?.name??t.profile??t.id,goal:t.goal,status:t.status,result:bounded(t.result)})),live:host.isMissionLive(m.id)};
  });
  for(const job of jobs){const mission=host.getMission(job.id);if(!mission)continue;for(const step of job.steps){const task=mission.tasks[step.id];if(!task)continue;Object.assign(step,{name:task.profile==='lead'?'Echo':step.name,profile:task.profile,attempt:task.attempt??1,commands:task.updates??[],dependsOn:task.dependsOn??[],activity:task.activity,updateSupported:host.taskControlSupported(mission.id,task.id)});}}
  return {bots,jobs,coordinator:{id:'lead',name:'Echo',role:'Coordinates your team and combines specialist reports.'}};
 }
 function run(b:BotRequest) {
  if(!UUID.test(b.requestId??'')||typeof b.goal!=='string'||!b.goal.trim()||b.goal.length>MAX_GOAL||typeof b.name!=='string'||typeof b.botRevision!=='string'||(b.agentIds!==undefined&&(!Array.isArray(b.agentIds)||b.agentIds.length>12||b.agentIds.some(id=>typeof id!=='string'))))return {ok:false,message:'Choose a specialist or team and enter a task in up to 16,000 characters.'};
  if(!capture())return {ok:false,message:'Bots save task history. Turn off private mode before starting a saved task.'};
  const id=`bot-${b.requestId}`,goal=b.goal.trim(),old=host.getMission(id),requestHash=identity(b);
  if(old){
   const unchanged=old.scope.botRequestHash?old.scope.botRequestHash===requestHash:old.goal===goal&&old.scope.botId===b.name&&old.scope.botRevision===b.botRevision&&!b.agentIds&&!b.parentId;
   return own(old)&&unchanged?{ok:true,message:'This task was already accepted.',data:{missionId:id,repeated:true}}:{ok:false,message:'This request ID belongs to another task or different settings.'};
  }
  const parent=b.parentId?host.getMission(b.parentId):null;
  if(b.parentId&&(!parent||!own(parent)))return {ok:false,message:'That previous task no longer exists.'};
  const team=b.name===TEAM_BOT_ID;
  if(!team&&b.agentIds!==undefined)return {ok:false,message:'Only team tasks accept a list of specialists.'};
  const ids=team?[...new Set(b.agentIds??(parent?profileIds(parent).filter(p=>p!=='lead'):DEFAULT_TEAM))].filter(p=>p!=='lead').sort():[b.name];
  if(!ids.length||ids.some(p=>!getFleetMember(p)))return {ok:false,message:'Choose existing specialists. Refresh if the team changed.'};
  if(!team&&b.name==='lead')return {ok:false,message:'Lead combines specialist reports. Choose Team of specialists to create those reports first.'};
  if(revision(b.name)!==b.botRevision)return {ok:false,message:'This specialist or team changed. Refresh before starting.'};
  const taskIds=team?[...ids,'lead'].sort():ids;
  if(parent&&!same(profileIds(parent),taskIds))return {ok:false,message:'This follow-up uses a different team. Keep its specialists or start a new task.'};
  const currentScope=scope();
  const active=host.listMissions(Infinity).find(m=>own(m)&&host.isMissionLive(m.id));
  if(active){
   const duplicate=active.goal===goal&&same(profileIds(active),taskIds)&&same(active.scope.projectId,currentScope.projectId)&&same(active.scope.botParentId??null,b.parentId??null);
   return {ok:false,message:duplicate?'This task is already running. Follow its existing result.':'A task is already working. Wait or stop it before starting another.',data:{missionId:active.id,repeated:duplicate}};
  }
  if(parent?.status==='running')return {ok:false,message:'Wait for that task to finish, or stop it before following up.'};
  const history=toProviderMessages({guidance:PROVENANCE_GUIDANCE,messages:parent?[{role:'user',content:parent.goal},{role:'assistant',content:JSON.stringify({status:parent.status,result:parent.result,steps:Object.values(parent.tasks).map(t=>t.result??{status:t.status})}).slice(0,16000)}]:[]});
  const tasks:AgentTaskSpec[]=taskIds.map(profile=>{
   const candidates=profile==='lead'?ids:profile==='review'?ids.filter(p=>p!=='review'):profile==='write'?ids.filter(p=>['research','analyse','plan'].includes(p)):profile==='plan'?ids.filter(p=>['research','analyse'].includes(p)):[];
   return {id:profile,goal,profile,runtime:'openbot',botRevision:botRevision(getFleetMember(profile)!),readOnly:team,dependsOn:team?candidates:[],lane:!team&&/\b(browser|screen|click|website|app|desktop)\b/i.test(goal)?'gui':'knowledge',acceptanceCriteria:[team?'Use reading tools to prepare your role’s report. Do not perform external changes. Cite evidence and report blockers. For current research use search_research and read_browser_page under your grants, cite actual retrieved sources and name specific access gaps. Use readable Markdown; retain source/author/license credits for relevant pictures from image_search.':'Deliver the requested work with evidence. For current research use search_research and read_browser_page under your grants; cite retrieved sources, not guessed trends. Use readable Markdown and, when helpful for public research, image_search with credited relevant illustrations. Report remaining blockers; prepared actions are not executed actions.',DELIVERABLE_CRITERION],budget:{timeoutMs:team?Math.floor(10*60_000/taskIds.length):10*60_000,maxIterations:40,maxRecoveryAttempts:2}};
  });
  if(verify&&!team&&VERIFIED_ROLES.has(b.name)&&getFleetMember('review'))tasks.push({id:VERIFY_TASK,goal:`Independently verify the ${getFleetMember(b.name)!.name} deliverable for this task: ${goal}`,profile:'review',runtime:'openbot',botRevision:botRevision(getFleetMember('review')!),readOnly:true,dependsOn:[b.name],lane:'knowledge',acceptanceCriteria:[VERIFY_CRITERION,DELIVERABLE_CRITERION],budget:{timeoutMs:5*60_000,maxIterations:25,maxRecoveryAttempts:1}});
  const submitted=host.submitMission({id,goal,scope:{...currentScope,echoBot:true,echoTeam:team,botId:b.name,botName:team?'Team of specialists':getFleetMember(b.name)!.name,botRevision:b.botRevision,botRequestHash:requestHash,botParentId:b.parentId??null,botContext:history},tasks},deps());
  return submitted.ok?{ok:true,message:team?'Team task started. Specialists report first; Lead combines the results.':`${getFleetMember(b.name)!.name} started.`,data:{missionId:submitted.missionId,repeated:false}}:{ok:false,message:submitted.reason??'The task could not start.'};
 }
 /** Old clients use stable request IDs so a retry cannot create a second mission. New UI uses fresh IDs for explicit new tasks. */
 function legacy(b:{name?:string;goal?:string;agentIds?:string[];requestId?:string;parentId?:string}) {
  if(typeof b.goal!=='string'||!b.goal.trim()||b.goal.length>MAX_GOAL||(b.agentIds!==undefined&&(!Array.isArray(b.agentIds)||b.agentIds.length>12||b.agentIds.some(id=>typeof id!=='string'))))return {ok:false,message:'Choose specialists in Bots and enter a task in up to 16,000 characters.'};
  const ids=[...new Set(b.agentIds??[b.name??'research'])].sort();
  if(!ids.length||ids.some(id=>!getFleetMember(id)))return {ok:false,message:'Choose existing specialists in Bots.'};
  const name=ids.length>1?TEAM_BOT_ID:ids[0],rev=revision(name),currentScope=scope();
  const previous=host.listMissions(Infinity).find(m=>LEGACY_RUN.test(m.id)&&own(m)&&m.goal===b.goal?.trim()&&same(profileIds(m),ids)&&same(m.scope.projectId,currentScope.projectId));
  if(previous)return {ok:true,message:'This task already exists. Open Bots to follow it or explicitly start a new task.',data:{missionId:previous.id,repeated:true}};
  const h=hash(['legacy',name,b.goal?.trim(),rev,ids,currentScope.projectId]),requestId=b.requestId??`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  return run({name,goal:b.goal,botRevision:rev,requestId,parentId:b.parentId,...(name===TEAM_BOT_ID?{agentIds:ids.filter(p=>p!=='lead')}:{})});
 }
 function stop(id:string) {const m=host.getMission(id);if(!m||!own(m))return {ok:false,message:'That task no longer exists.'};return host.cancelMission(id)?{ok:true,message:'Task stopped. Review any changes already made.'}:{ok:false,message:'That task is no longer running.'};}
 function control(b:{missionId?:string;taskId?:string;attempt?:number;requestId?:string;operation?:string;text?:string}) {
  if(typeof b.missionId!=='string'||!isBotRunId(b.missionId)||typeof b.taskId!=='string'||!/^[a-zA-Z0-9_.-]{1,64}$/.test(b.taskId)||!Number.isInteger(b.attempt)||Number(b.attempt)<1||!UUID.test(b.requestId??'')||!['update','stop','revise'].includes(b.operation??'')||(b.operation!=='stop'&&(typeof b.text!=='string'||!b.text.trim()||b.text.length>MAX_GOAL)))return {ok:false,message:'Choose an agent task and provide valid instructions.'};
  const m=host.getMission(b.missionId);if(!m||!own(m))return {ok:false,message:'This bot task no longer exists.'};
  const r=host.controlMissionTask({missionId:b.missionId,taskId:b.taskId,attempt:b.attempt!,requestId:b.requestId!,operation:b.operation as 'update'|'stop'|'revise',text:b.text});
  return {ok:r.ok,message:r.message,data:{command:r.command}};
 }
 return {list,run,legacy,revision,stop,control};
}
/** Only explicit commands, never quoted or hypothetical requests. */
export function botIntent(text:string):{name:string;goal:string}|null {
 const m=/^(?:echo[, ]+)?(?:ask|run|tell)\s+(research|plan|write|review|analyse|lead|team)(?:\s+bot)?(?:\s+to\s+|\s*:\s*)([\s\S]{1,16000})[.!]?$/i.exec(text.trim());
 return m?{name:m[1].toLowerCase()==='team'?TEAM_BOT_ID:m[1].toLowerCase(),goal:m[2].trim()}:null;
}
