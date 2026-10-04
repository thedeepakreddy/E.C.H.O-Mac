import {createHash} from 'node:crypto';
/** Split by project, never by message/revision/provider. Gold requires separate review. */
export function buildTaskSplit(projectId:string):'train'|'validation'|'held-out'{const bucket=createHash('sha256').update(`echo-coding-v1:${projectId}`).digest().readUInt32BE(0)%10;return bucket===0?'held-out':bucket===1?'validation':'train';}
export function buildTaskIndex(sessions:Array<{id:string;taskId?:string;revision:number;phase:string;processIds:string[];grantedActors?:string[]}>){return sessions.map(s=>({projectId:s.id,taskId:s.taskId,revision:s.revision,phase:s.phase,processIds:s.processIds,actors:s.grantedActors??[],split:buildTaskSplit(s.id),review:'unreviewed',gold:false}));}
