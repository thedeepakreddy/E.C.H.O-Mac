import {createHash} from 'node:crypto';
import {listFleet,getFleetMember,type FleetMember} from './fleet.js';
import type {MissionState,SwarmManager,SwarmDeps} from './swarm.js';
import {toProviderMessages} from '../vendor/openbot/history.js';
import {PROVENANCE_GUIDANCE} from '../vendor/openbot/bot-prompt.js';

export const botRevision=(b:FleetMember)=>createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0,24);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface BotRequest {name?:string;goal?:string;requestId?:string;botRevision?:string;parentId?:string}
type Host=Pick<SwarmManager,'getMission'|'listMissions'|'isMissionLive'|'submitMission'|'cancelMission'>;
/** Mac bots use the existing bounded, guarded native runner. No second computer-control loop. */
export function createMacBots(host:Host,deps:()=>SwarmDeps,scope:()=>Record<string,unknown>,capture:()=>boolean) {
 const result=(r:MissionState['result'])=>r?{...r,summary:r.summary.slice(0,6000),artifacts:r.artifacts.slice(0,8).map(a=>({...a,label:a.label.slice(0,160),value:a.value.slice(0,12000)})),verificationRefs:r.verificationRefs.slice(0,12).map(v=>v.slice(0,500)),blockers:r.blockers.slice(0,8).map(b=>b.slice(0,1000))}:undefined;
 const own=(m:MissionState)=>m.id.startsWith('bot-')&&m.scope.echoBot===true;
 function list(){return {bots:listFleet().map(b=>({id:b.id,name:b.name,role:b.brief,description:b.description,revision:botRevision(b),custom:b.custom,mode:b.custom?'read tools':'native tools'})),jobs:host.listMissions().filter(own).slice(0,12).map(m=>({id:m.id,botId:m.scope.botId,botName:m.scope.botName,goal:m.goal,status:m.status==='running'&&!host.isMissionLive(m.id)?'interrupted':m.status,createdAt:m.createdAt,updatedAt:m.updatedAt,result:result(m.result),steps:Object.values(m.tasks).map(t=>({goal:t.goal,status:t.status,result:result(t.result)})),live:host.isMissionLive(m.id)}))};}
 function run(b:BotRequest){
  if(!UUID.test(b.requestId??'')||typeof b.goal!=='string'||!b.goal.trim()||b.goal.length>4000)return {ok:false,message:'Choose a bot and enter a task in up to 4,000 characters.'};
  if(!capture())return {ok:false,message:'Bots save task history. Turn off private mode before starting a saved bot run.'};
  const id=`bot-${b.requestId}`,goal=b.goal.trim(),old=host.getMission(id);
  if(old)return own(old)&&old.goal===goal&&old.scope.botId===b.name?{ok:true,message:'This run was already accepted.',data:{missionId:id,repeated:true}}:{ok:false,message:'This request ID belongs to another task.'};
  const member=getFleetMember(b.name??'');if(!member||botRevision(member)!==b.botRevision)return {ok:false,message:'This bot changed. Refresh before starting.'};
  if(host.listMissions().some(m=>own(m)&&host.isMissionLive(m.id)))return {ok:false,message:'A bot is already working. Wait or stop it first.'};
  const parent=b.parentId?host.getMission(b.parentId):null;
  if(b.parentId&&(!parent||!own(parent)||parent.scope.botId!==member.id))return {ok:false,message:'That previous run does not belong to this bot.'};
  const history=toProviderMessages({guidance:PROVENANCE_GUIDANCE,messages:parent?[{role:'user',content:parent.goal},{role:'assistant',content:JSON.stringify({status:parent.status,result:parent.result,steps:Object.values(parent.tasks).map(t=>t.result??{status:t.status})}).slice(0,16000)}]:[]});
  const submitted=host.submitMission({id,goal,scope:{...scope(),echoBot:true,botId:member.id,botName:member.name,botRevision:b.botRevision,botContext:history},tasks:[{id:member.id,goal,profile:member.id,runtime:"openbot",botRevision:b.botRevision,lane:/\b(browser|screen|click|website|app|desktop)\b/i.test(goal)?'gui':'knowledge',acceptanceCriteria:['Deliver the requested work with evidence. Report remaining blockers; prepared actions are not executed actions.'],budget:{timeoutMs:10*60_000,maxIterations:40,maxRecoveryAttempts:2}}]},deps());
  return submitted.ok?{ok:true,message:`${member.name} started.`,data:{missionId:submitted.missionId,repeated:false}}:{ok:false,message:submitted.reason??'The bot could not start.'};
 }
 function stop(id:string){const m=host.getMission(id);if(!m||!own(m))return {ok:false,message:'That bot run no longer exists.'};return host.cancelMission(id)?{ok:true,message:'Bot stopped. Review any changes already made.'}:{ok:false,message:'That bot is no longer running.'};}
 return {list,run,stop};
}
/** Deliberately only explicit commands, never quoted or hypothetical requests. */
export function botIntent(text:string):{name:string;goal:string}|null {
 const m=/^(?:echo[, ]+)?(?:ask|run|tell)\s+(research|plan|write|review|analyse|lead)(?:\s+bot)?(?:\s+to\s+|\s*:\s*)([\s\S]{1,4000})[.!]?$/i.exec(text.trim());
 return m?{name:m[1].toLowerCase(),goal:m[2].trim()}:null;
}
