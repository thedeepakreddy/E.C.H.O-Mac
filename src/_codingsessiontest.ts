import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const root = await mkdtemp(join(tmpdir(),'echo-coding-session-'));
process.env.ECHO_DATA_ROOT=join(root,'data'); process.env.ECHO_MEMORY_ROOT=join(root,'memory');
const {openProject,getSession,updateProject,mutateSession} = await import('./coding/session.js');
const {runInAgentContext}=await import('./agent-replay/context.js');
const {projectPath} = await import('./coding/workspace.js');
try {
  const session = await openProject({path:join(root,'project'),create:true,spec:'Build a site'});
  assert.equal(getSession(session.id).spec,'Build a site');
  assert.equal((await openProject({path:session.root})).id,session.id);
  await assert.rejects(openProject({path:process.cwd()}),/installation/);
  await assert.rejects(openProject({path:'relative'}),/absolute/);
  await mkdir(join(root,'outside')); await symlink(join(root,'outside'),join(session.root,'escape'));
  await assert.rejects(projectPath(session.root,'escape/file'),/Symbolic/);
  await assert.rejects(projectPath(session.root,'../outside/file'),/escapes/);
  const updated = await updateProject(session.id,0,{phase:'planning',acceptance:['Homepage loads']});
  assert.equal(updated.revision,1);
  const results = await Promise.allSettled([mutateSession(session.id,1,s=>{s.spec='A';}),mutateSession(session.id,1,s=>{s.spec='B';})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(getSession(session.id).revision,2);
  const outsider={identity:{id:'outsider',name:'Outsider',kind:'clone'}} as any;assert.throws(()=>runInAgentContext(outsider,()=>getSession(session.id)),/no grant/);await assert.rejects(runInAgentContext(outsider,()=>openProject({path:session.root})),/another actor/);
  console.log('PASS project persistence, installation protection, path/symlink boundaries and concurrent revision conflicts');
} finally {await rm(root,{recursive:true,force:true});}
