import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=mkdtempSync(join(tmpdir(),'echo-office-background-'));
process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=root;process.env.JARVIS_FLEET_DIR=root;process.env.ECHO_MCP='0';
try {
 const {listFleet,addFleetMember,grantableTools}=await import('./frontier/fleet.js');
 const {makeFleetBrain}=await import('./frontier/fleet-brain.js');
 const {DEFAULTS_FOR_TESTS}=await import('./config.js');
 const {runGated}=await import('./safety/gate.js');
 const {TOOLS}=await import('./tools/registry.js');
 const forbidden=['click','background_click','type_text','press_keys','move_mouse','scroll','drag','screenshot','read_screen_text','list_ui_elements','open_app','open_url','run_terminal_command','run_skill','run_workflow','run_shortcut','show_project_preview','interact_project_preview','start_project_application','start_process','run_project_checks','switch_brain','toggle_hand_gestures','accept_shadow_code','Bash','Write','mcp__lcu__js','mcp__*'];
 const grants=grantableTools();
 assert.ok(grants.includes('web_search')&&grants.includes('read_browser_page'),'Public research stays available');
 assert.ok(!grants.includes('screenshot')&&!grants.includes('read_screen_text'),'Read-only is not enough to make a desktop observer a background grant');
 const custom=addFleetMember({id:'background-reader',name:'Reader',brief:'Read public sources',description:'',tier:'balanced',tools:['web_search','screenshot']});
 assert.deepEqual(custom.tools,['web_search']);
 let executions=0;
 for(const member of listFleet()) {
  let allowed:ReadonlySet<string>|undefined;
  const make=makeFleetBrain(DEFAULTS_FOR_TESTS,((_cfg:unknown,opts:any)=>{allowed=opts.limits.allowedTools;assert.equal(opts.identity.background,true,'Office identity suppresses foreground narration');return {brain:{},provider:'gemini'};}) as any);
  make({id:member.id,name:member.name,kind:'clone'},{profile:member.id,budget:{timeoutMs:1000,maxIterations:2,maxRecoveryAttempts:0}} as any);
  assert.ok(allowed,`${member.id} must have explicit background grants`);
  assert.ok(allowed.has('submit_agent_result'),'Actor-owned result submission stays available');
  for(const name of forbidden) {
   assert.ok(!allowed.has(name),`${member.id} must not discover ${name}`);
   const out=await runGated({name,description:'Isolated forbidden-effect fixture',schema:{},readOnly:true,handler:async()=>{executions++;return {text:'Forbidden effect'};}},{},{workingDir:root,allowedTools:allowed});
   assert.equal(out.status,'denied',`${member.id} cannot execute ${name}, even if marked read-only`);
  }
  const out=await runGated({name:'web_search',description:'No-network background fixture',schema:{},readOnly:true,handler:async()=>({text:'Background evidence'})},{},{workingDir:root,allowedTools:allowed});
  assert.equal(out.text,'Background evidence');
 }
 assert.equal(executions,0,'No forbidden handler or confirmation was reached');
 const nested=await runGated({name:'web_search',description:'Nested dispatcher fixture',schema:{},readOnly:true,handler:async()=>runGated({name:'click',description:'Attempted widening',schema:{},readOnly:false,handler:async()=>{executions++;return {text:'Clicked'};}},{},{workingDir:root,allowedTools:new Set(['click'])})},{},{workingDir:root,allowedTools:new Set(['web_search'])});
 assert.equal(nested.status,'denied','A nested dispatcher cannot widen the office grants');assert.equal(executions,0);
 const {feed}=await import('./frontier/narrate.js');
 const {runInAgentContext}=await import('./agent-replay/context.js');let foregroundReads=0;
 runInAgentContext({identity:{id:'office',name:'Research',kind:'clone',background:true}} as any,()=>feed({get line(){foregroundReads++;return 'Office activity';}}));
 assert.equal(foregroundReads,0,'Background activity never reaches the foreground overlay or Phone feed');
 runInAgentContext({identity:{id:'echo',name:'Echo',kind:'main'}} as any,()=>feed({get line(){foregroundReads++;return 'Echo activity';}}));
 assert.ok(foregroundReads>0,'Echo’s own foreground narration remains available');
 let inspector:ReadonlySet<string>|undefined;
 makeFleetBrain(DEFAULTS_FOR_TESTS,((_cfg:unknown,opts:any)=>{inspector=opts.limits.allowedTools;return {brain:{},provider:'gemini'};}) as any)({id:'echo-inspector',name:'Inspector',kind:'clone'},{readOnly:true,budget:{timeoutMs:1000,maxIterations:2,maxRecoveryAttempts:0}} as any);
 assert.ok(inspector?.has('inspect_project_preview'),'Echo’s supervised inspector keeps its own read capabilities');
 assert.ok(grants.every(name=>TOOLS.find(t=>t.name===name)?.readOnly),'Only reviewed reads can be granted');
 console.log('PASS all fleet roles and custom agents: background grants, denied desktop/native/plugin/command bypasses, public research and actor-owned result submission');
}finally{rmSync(root,{recursive:true,force:true});}
