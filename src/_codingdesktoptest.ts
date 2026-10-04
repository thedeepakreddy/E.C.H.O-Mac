import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'echo-desktop-'));process.env.ECHO_DATA_ROOT=join(root,'data');process.env.ECHO_MEMORY_ROOT=join(root,'memory');
const {openProject,getSession}=await import('./coding/session.js');const {runProjectCheck,detectRecipe}=await import('./coding/recipes.js');const {startProjectApplication}=await import('./coding/application.js');const {readProcess,stopAllCodingProcesses}=await import('./coding/processes.js');
try{const project=await openProject({path:join(root,'app'),create:true,target:'macOS'});await writeFile(join(project.root,'main.swift'),`import Cocoa
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 320, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Echo isolated desktop fixture"
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
print("windowVisible:\\(window.isVisible)")
fflush(stdout)
app.run()
`);assert.equal((await detectRecipe(project.id)).kind,'swift');const built=await runProjectCheck(project.id,0,'build');let status;for(let n=0;n<1000;n++){status=await readProcess(project.id,built.process.id);if(status.status!=='running')break;await new Promise(r=>setTimeout(r,30));}assert.equal(status?.exitCode,0,status?.output);const run=await startProjectApplication(project.id,getSession(project.id).revision);for(let n=0;n<200;n++){status=await readProcess(project.id,run.process.id);if(status.output.includes('windowVisible:true'))break;await new Promise(r=>setTimeout(r,30));}assert.match(status!.output,/windowVisible:true/);console.log('PASS Swift compile, managed native GUI launch and visible window; signing/distribution not tested');
}finally{await stopAllCodingProcesses();await rm(root,{recursive:true,force:true});}
