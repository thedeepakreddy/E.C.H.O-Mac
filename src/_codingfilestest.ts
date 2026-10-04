import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'echo-coding-files-'));process.env.ECHO_DATA_ROOT=join(root,'data');process.env.ECHO_MEMORY_ROOT=join(root,'memory');
const {openProject,getSession}=await import('./coding/session.js');const {applyProjectPatch,readProjectFile,searchProject,undoProjectPatch}=await import('./coding/files.js');
try {
 const project=await openProject({path:join(root,'project'),create:true});
 const body='const greeting = "こんにちは";\r\n'+'x'.repeat(16000);
 const added=await applyProjectPatch(project.id,0,{path:'src/main.ts',expectedHash:'missing',content:body});
 const first=await readProjectFile(project.id,'src/main.ts',0,6000);assert.equal(first.nextOffset,6000);
 const last=await readProjectFile(project.id,'src/main.ts',12000,6000);assert.equal(first.totalChars,body.length);assert(last.text.endsWith('x'));assert.equal(last.nextOffset,null);
 await assert.rejects(applyProjectPatch(project.id,1,{path:'src/main.ts',expectedHash:'wrong',content:'damage'}),/conflict/);
 const changed=await applyProjectPatch(project.id,1,{path:'src/main.ts',expectedHash:first.hash,edits:[{before:'こんにちは',after:'Hello'}]});
 assert((await readFile(join(project.root,'src/main.ts'),'utf8')).includes('\r\n'));
 await writeFile(join(project.root,'src/main.ts'),'user change');
 await assert.rejects(undoProjectPatch(project.id,2,changed.value.patchId),/conflict/);
 assert.equal(await readFile(join(project.root,'src/main.ts'),'utf8'),'user change');
 assert.equal((await searchProject(project.id,'user change')).matches[0].path,'src/main.ts');
 await assert.rejects(applyProjectPatch(project.id,2,{path:'../escape',expectedHash:'missing',content:'bad'}),/escapes/);
 assert.equal(getSession(project.id).revision,2);
 console.log('PASS paginated UTF-8 reads, CRLF patches, stale-file protection, undo conflict, search and path boundaries');
} finally {await rm(root,{recursive:true,force:true});}
