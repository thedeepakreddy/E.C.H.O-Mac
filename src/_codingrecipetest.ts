import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'echo-coding-recipe-'));process.env.ECHO_DATA_ROOT=join(root,'data');process.env.ECHO_MEMORY_ROOT=join(root,'memory');
const {openProject}=await import('./coding/session.js');const {detectRecipe,runProjectCheck}=await import('./coding/recipes.js');const {readProcess,stopAllCodingProcesses}=await import('./coding/processes.js');
try{const project=await openProject({path:join(root,'project'),create:true});await writeFile(join(project.root,'index.html'),'<h1>Fixture</h1>');assert.equal((await detectRecipe(project.id)).kind,'static-web');
 await assert.rejects(runProjectCheck(project.id,0,'build'),/No build command/);
 await writeFile(join(project.root,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(7)"'}}));
 const recipe=await detectRecipe(project.id);assert.equal(recipe.kind,'node-web');assert.deepEqual(recipe.commands.test.args,['run','test']);
 const check=await runProjectCheck(project.id,0,'test');let status;for(let n=0;n<100;n++){status=await readProcess(project.id,check.process.id);if(status.status!=='running')break;await new Promise(r=>setTimeout(r,30));}assert.equal(status?.exitCode,7);assert.equal(status?.status,'failed');
 console.log('PASS recipe detection, existing scripts, unavailable checks and real failing test exit status');
}finally{await stopAllCodingProcesses();await rm(root,{recursive:true,force:true});}
