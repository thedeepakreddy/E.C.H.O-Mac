import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'echo-lcu-verify-cache-'));
process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.ECHO_MCP='0';
try{
 const {Brain}=await import('./brain/types.js');
 const {RecordingBrain}=await import('./agent-replay/runtime.js');
 const {currentLoop}=await import('./agent-replay/loop-log.js');
 const {EchoComputerControl,installEchoComputerControl,closeEchoComputerControl}=await import('./tools/lcu-control.js');
 const {runGated}=await import('./safety/gate.js');
 const {TOOL_MAP}=await import('./tools/registry.js');
 let value='5',failure:unknown;
 const client={connect:async()=>{},instructions:'fixture',publicTools:()=>[{name:'js'},{name:'js_reset'}],call:async()=>({content:[{type:'text',text:`Window: Calculator, App: Calculator.\n0 group\n  1 group ID: StandardResultView\n    2 text 2+3\n  3 group ID: StandardInputView\n    4 text ${value}`}]}),turnEnded:async()=>{},close:async()=>{}};
 installEchoComputerControl(new EchoComputerControl(client,undefined,async()=>{}));
 class Fixture extends Brain {
  async send(){
   const loop=currentLoop();
   try{
    const inspect=()=>runGated(TOOL_MAP.get('inspect_app')!,{app:'Calculator'},{workingDir:root});
    const first=await inspect(),second=await inspect();
    assert.equal(first.status,'success',JSON.stringify(first));assert.equal(second.status,'success',JSON.stringify(second));
    type EvidenceData={toolData?:{observationId?:string}};
    const firstId=(first.data as EvidenceData|undefined)?.toolData?.observationId,secondId=(second.data as EvidenceData|undefined)?.toolData?.observationId;
    assert.equal(typeof firstId,'string');assert.notEqual(firstId,secondId,'Native inspection must never reuse cached indices/observation IDs');
    const args={app:'Calculator',observationId:secondId,kind:'text',index:4,expected:'5'};
    assert.equal((await runGated(TOOL_MAP.get('verify_app_state')!,args,{workingDir:root})).status,'success');
    value='99'; // The fake external app changes independently, no input is sent.
    const changed=await runGated(TOOL_MAP.get('verify_app_state')!,args,{workingDir:root});
    assert.notEqual(changed.status,'success','Verification must observe current native state, never replay a cached success');
   }catch(error){failure=error;}
   loop?.exit('completed');this.emit('turnEnd');
  }
  interrupt(){} async stop(){}
 }
 const brain=new RecordingBrain(new Fixture(),'test',{}, {autoResume:false});brain.on('error',()=>{});
 const done=new Promise<void>(resolve=>brain.once('turnEnd',resolve));brain.send('Open Calculator.');await done;
 await brain.stop();await closeEchoComputerControl();assert.equal(failure,undefined);
 console.log('PASS native inspection and verification bypass generic read caching; fake app only');
}finally{rmSync(root,{recursive:true,force:true});}
