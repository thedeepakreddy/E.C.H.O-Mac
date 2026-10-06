import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {mkdir} from 'node:fs/promises';
import {getSession,openProject,codingRoot,assertLive} from './session.js';
const exec=promisify(execFile);
export async function gitProjectState(id:string){const session=getSession(id);const options={cwd:session.root,timeout:15000,maxBuffer:1024*1024};
 const root=(await exec('git',['rev-parse','--show-toplevel'],options)).stdout.trim();if(root!==session.root)throw new Error('Selected directory is not the repository root.');
 const [head,status,diff]=await Promise.all([exec('git',['rev-parse','HEAD'],options),exec('git',['status','--porcelain=v1'],options),exec('git',['diff','--stat'],options)]);
 return {root,head:head.stdout.trim(),status:status.stdout,diff:diff.stdout};}
export async function createProjectWorktree(id:string,branch?:string){
 const session=getSession(id),state=await gitProjectState(id);const name=branch??`codex/echo-${randomUUID().slice(0,8)}`;
 await exec('git',['check-ref-format','--branch',name],{cwd:session.root,timeout:10000});
 const path=join(codingRoot(),'worktrees',randomUUID());await mkdir(join(codingRoot(),'worktrees'),{recursive:true});assertLive();
 await exec('git',['worktree','add','-b',name,path,'HEAD'],{cwd:session.root,timeout:30000,maxBuffer:1024*1024});
 const opened=await openProject({path,name:`${session.name} (${name})`,spec:session.spec,target:session.target});
 return {project:opened,branch:name,baseCommit:state.head,originalDirty:!!state.status.trim(),note:'Existing uncommitted changes remain in the original checkout and are not copied.'};
}
