import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'echo-coding-git-'));process.env.ECHO_DATA_ROOT=join(root,'data');process.env.ECHO_MEMORY_ROOT=join(root,'memory');
const {openProject}=await import('./coding/session.js');const {gitProjectState,createProjectWorktree}=await import('./coding/git.js');
const project=await openProject({path:join(root,'project'),create:true});const git=(args:string[])=>exec('git',args,{cwd:project.root});
try {
 await git(['init']);await writeFile(join(project.root,'main.txt'),'committed');await git(['add','main.txt']);await git(['-c','user.name=Echo Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);await writeFile(join(project.root,'main.txt'),'user dirty content');
 const state=await gitProjectState(project.id);assert(state.status.includes('main.txt'));
 const result=await createProjectWorktree(project.id,'codex/echo-fixture');assert(result.originalDirty);assert.equal(await readFile(join(result.project.root,'main.txt'),'utf8'),'committed');assert.equal(await readFile(join(project.root,'main.txt'),'utf8'),'user dirty content');
 await assert.rejects(createProjectWorktree(project.id,'--invalid-option'));
 await git(['worktree','remove',result.project.root]);
 console.log('PASS argument-array Git worktree, committed baseline, dirty-file preservation and invalid branch handling');
} finally {await rm(root,{recursive:true,force:true});}
