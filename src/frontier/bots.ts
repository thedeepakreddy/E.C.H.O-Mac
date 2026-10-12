import {createHash} from 'node:crypto';
import {listFleet,getFleetMember,type FleetMember} from './fleet.js';
import type {MissionState,SwarmManager,SwarmDeps,AgentTaskSpec} from './swarm.js';
import {toProviderMessages} from '../vendor/openbot/history.js';
import {PROVENANCE_GUIDANCE} from '../vendor/openbot/bot-prompt.js';

export const TEAM_BOT_ID = 'echo:team'; // Cannot collide with a saved fleet id.
export const DEFAULT_TEAM = ['research','plan','review'];
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const OFFICE_POLICY = 'background-reads-v1';
export const botRevision = (b:FleetMember) => hash({policy:OFFICE_POLICY,member:b}).slice(0,24);
export const teamRevision = () => hash({policy:OFFICE_POLICY,members:listFleet().sort((a,b)=>a.id.localeCompare(b.id))}).slice(0,24);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LEGACY_RUN = /^(?:board-\d{10,16}|solo-[a-z][a-z0-9-]{0,23}-\d{10,16})$/;
export const isBotRunId = (id:string) => /^bot-[a-f0-9-]{36}$/.test(id) || LEGACY_RUN.test(id);
export interface BotRequest {name?:string;goal?:string;requestId?:string;botRevision?:string;parentId?:string;agentIds?:string[]}
type Host = Pick<SwarmManager,'getMission'|'listMissions'|'isMissionLive'|'submitMission'|'cancelMission'|'controlMissionTask'|'taskControlSupported'>;
const profileIds = (m:MissionState) => [...new Set(Object.values(m.tasks).map(t=>t.profile).filter((p):p is string=>!!p))].sort();
const own = (m:MissionState) => m.id.startsWith('bot-') && m.scope.echoBot===true || LEGACY_RUN.test(m.id) && Object.values(m.tasks).length>0 && Object.values(m.tasks).every(t=>typeof t.profile==='string');
const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
const bounded = (r:MissionState['result']) => r ? {...r,summary:r.summary.slice(0,6000),artifacts:[...new Map(r.artifacts.map(a=>[JSON.stringify([a.kind,a.label,a.value]),a])).values()].slice(0,8).map(a=>({...a,label:a.label.slice(0,160),value:a.value.slice(0,12000)})),verificationRefs:r.verificationRefs.slice(0,12).map(v=>v.slice(0,500)),blockers:r.blockers.slice(0,8).map(b=>b.slice(0,1000))}:undefined;
const identity = (r:BotRequest) => hash({name:r.name,goal:r.goal?.trim(),revision:r.botRevision,parentId:r.parentId??null,agentIds:r.agentIds?[...new Set(r.agentIds)].sort():null});

/** Both pages and Phone dispatch to this service; Swarm remains the only job store and executor. */
export function createMacBots(host:Host,deps:()=>SwarmDeps,scope:()=>Record<string,unknown>,capture:()=>boolean) {
 function revision(name:string) {return name===TEAM_BOT_ID?teamRevision():getFleetMember(name)?botRevision(getFleetMember(name)!):'';}
 function list() {
  const fleet=listFleet();
  const bots=fleet.filter(b=>b.id!=='lead').map(b=>({id:b.id,name:b.name,role:b.brief,description:b.description,revision:botRevision(b),custom:b.custom,mode:'background · read tools',team:false,defaultAgentIds:[] as string[]}));
  bots.push({id:TEAM_BOT_ID,name:'Team of specialists',role:'Selected specialists prepare reports. Lead combines them after they finish.',description:'Several perspectives and one combined report; reading tools only.',revision:teamRevision(),custom:false,mode:'team · read tools',team:true,defaultAgentIds:[...DEFAULT_TEAM]});
  const jobs=host.listMissions().filter(own).slice(0,12).map(m=>{
   const ids=profileIds(m),team=m.scope.botId===TEAM_BOT_ID||ids.length>1;
   const primary=team?m.tasks.lead?.result: Object.values(m.tasks)[0]?.result;
   const result=bounded(m.result);
   if(result && primary?.status==='completed')result.summary=primary.summary.slice(0,6000);
   if(result)result.artifacts=[...new Map(result.artifacts.map(a=>[JSON.stringify([a.kind,a.label,a.value]),a])).values()];
   return {id:m.id,botId:team?TEAM_BOT_ID:String(m.scope.botId??ids[0]??''),botName:team?'Team of specialists':String(m.scope.botName??getFleetMember(ids[0])?.name??ids[0]??'Specialist'),agentIds:ids.filter(id=>id!=='lead'),goal:m.goal,status:m.status==='running'&&!host.isMissionLive(m.id)?'interrupted':m.status,createdAt:m.createdAt,updatedAt:m.updatedAt,result,steps:Object.values(m.tasks).map(t=>({id:t.id,name:t.actorName??getFleetMember(t.profile??'')?.name??t.profile??t.id,goal:t.goal,status:t.status,result:bounded(t.result)})),live:host.isMissionLive(m.id)};
  });
  for(const job of jobs){const mission=host.getMission(job.id);if(!mission)continue;for(const step of job.steps){const task=mission.tasks[step.id];if(!task)continue;Object.assign(step,{name:task.profile==='lead'?'Echo':step.name,profile:task.profile,attempt:task.attempt??1,commands:task.updates??[],dependsOn:task.dependsOn??[],activity:task.activity,draft:task.draft,updateSupported:host.taskControlSupported(mission.id,task.id)});}}
  return {bots,jobs,coordinator:{id:'lead',name:'Echo',role:'Coordinates your team and combines specialist reports.'}};
 }
 function run(b:BotRequest) {
  if(!UUID.test(b.requestId??'')||typeof b.goal!=='string'||!b.goal.trim()||b.goal.length>4000||typeof b.name!=='string'||typeof b.botRevision!=='string'||(b.agentIds!==undefined&&(!Array.isArray(b.agentIds)||b.agentIds.length>12||b.agentIds.some(id=>typeof id!=='string'))))return {ok:false,message:'Choose a specialist or team and enter a task in up to 4,000 characters.'};
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
   return {id:profile,goal,profile,runtime:'openbot',botRevision:botRevision(getFleetMember(profile)!),readOnly:true,dependsOn:team?candidates:[],lane:'knowledge',acceptanceCriteria:[team?'Use reading tools to prepare your role’s report. Do not perform external changes. Cite evidence and report blockers. For current research use search_research and read_browser_page under your grants, cite actual retrieved sources and name specific access gaps. Use readable Markdown; retain source/author/license credits for relevant pictures from image_search.':'Deliver the requested background report with evidence. Use only granted reads; desktop actions and external writes must be reported as remaining blocked steps for Echo, never performed or claimed complete. For current research use search_research and read_browser_page under your grants; cite retrieved sources, not guessed trends. Use readable Markdown and, when helpful for public research, image_search with credited relevant illustrations.'],budget:{timeoutMs:team?Math.floor(10*60_000/taskIds.length):10*60_000,maxIterations:40,maxRecoveryAttempts:2}};
  });
  const submitted=host.submitMission({id,goal,scope:{...currentScope,echoBot:true,echoTeam:team,botId:b.name,botName:team?'Team of specialists':getFleetMember(b.name)!.name,botRevision:b.botRevision,botRequestHash:requestHash,botParentId:b.parentId??null,botContext:history},tasks},deps());
  return submitted.ok?{ok:true,message:team?'Team task started. Specialists report first; Lead combines the results.':`${getFleetMember(b.name)!.name} started.`,data:{missionId:submitted.missionId,repeated:false}}:{ok:false,message:submitted.reason??'The task could not start.'};
 }
 /** Old clients use stable request IDs so a retry cannot create a second mission. New UI uses fresh IDs for explicit new tasks. */
 function legacy(b:{name?:string;goal?:string;agentIds?:string[];requestId?:string;parentId?:string}) {
  if(typeof b.goal!=='string'||!b.goal.trim()||b.goal.length>4000||(b.agentIds!==undefined&&(!Array.isArray(b.agentIds)||b.agentIds.length>12||b.agentIds.some(id=>typeof id!=='string'))))return {ok:false,message:'Choose specialists in Bots and enter a task in up to 4,000 characters.'};
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
  if(typeof b.missionId!=='string'||!isBotRunId(b.missionId)||typeof b.taskId!=='string'||!/^[a-zA-Z0-9_.-]{1,64}$/.test(b.taskId)||!Number.isInteger(b.attempt)||Number(b.attempt)<1||!UUID.test(b.requestId??'')||!['update','stop','revise','retry'].includes(b.operation??'')||(!['stop','retry'].includes(b.operation??'')&&(typeof b.text!=='string'||!b.text.trim()||b.text.length>4000)))return {ok:false,message:'Choose an agent task and provide valid instructions.'};
  const m=host.getMission(b.missionId);if(!m||!own(m))return {ok:false,message:'This bot task no longer exists.'};
  if(b.operation==='retry'){
   if(!capture())return {ok:false,message:'Turn off private mode before retrying a saved task.'};
   const task=m.tasks[b.taskId];if(!task?.profile||task.botRevision!==revision(task.profile))return {ok:false,message:'This agent changed. Review its role and start a fresh task.'};
  }
  const r=host.controlMissionTask({missionId:b.missionId,taskId:b.taskId,attempt:b.attempt!,requestId:b.requestId!,operation:b.operation as 'update'|'stop'|'revise'|'retry',text:['retry','stop'].includes(b.operation??'')?undefined:b.text},b.operation==='retry'?deps():undefined);
  return {ok:r.ok,message:r.message,data:{command:r.command}};
 }
 return {list,run,legacy,revision,stop,control};
}
/** Only explicit commands, never quoted or hypothetical requests. */
export function botIntent(text:string):{name:string;goal:string}|null {
 const m=/^(?:echo[, ]+)?(?:ask|run|tell)\s+(research|plan|write|review|analyse|lead|team)(?:\s+bot)?(?:\s+to\s+|\s*:\s*)([\s\S]{1,4000})[.!]?$/i.exec(text.trim());
 return m?{name:m[1].toLowerCase()==='team'?TEAM_BOT_ID:m[1].toLowerCase(),goal:m[2].trim()}:null;
}
