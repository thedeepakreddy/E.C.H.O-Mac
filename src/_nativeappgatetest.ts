import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'echo-native-gate-'));
process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.ECHO_MCP='0';
try {
 const {Brain}=await import('./brain/types.js');
 const {RecordingBrain}=await import('./agent-replay/runtime.js');
 const {currentLoop}=await import('./agent-replay/loop-log.js');
 const {runGated,resetGateMemory}=await import('./safety/gate.js');
 const {confirmations}=await import('./safety/confirm.js');
 const {TOOL_MAP}=await import('./tools/registry.js');
 const {EchoComputerControl,installEchoComputerControl,closeEchoComputerControl}=await import('./tools/lcu-control.js');
 let asked=0;
 confirmations.on('ask',({id})=>{asked++;confirmations.settle(id,false,'offline-fixture');});
 async function fixture(app:string,bundleId:string,rows:string,tool:string,extra:Record<string,unknown>,routine:boolean,deniedWithoutPrompt=false) {
  resetGateMemory();asked=0;let dispatched=0;let outcome:any;
  const observation={content:[{type:'text',text:`Window: "${app}", App: ${app}.\n0 standard window ${app}\n${rows}`}],_meta:{'codex/toolSurface':{kind:'computerUse',app:{kind:'appId',appId:bundleId}}}};
  const client={connect:async()=>{},instructions:'offline-fixture',publicTools:()=>[{name:'js'},{name:'js_reset'}],call:async(_name:string,args:{code:string})=>{if(/\.click\(|\.pressKey\(|\.typeText\(/.test(args.code))dispatched++;return observation;},turnEnded:async()=>{},close:async()=>{}};
  installEchoComputerControl(new EchoComputerControl(client,undefined,async()=>{},async()=>({content:[]})));
  class Provider extends Brain {
   async send(){
    const inspected=await runGated(TOOL_MAP.get('inspect_app')!,{app},{workingDir:root});
    const observationId=(inspected.data as any).toolData.observationId;
    outcome=await runGated(TOOL_MAP.get(tool)!,{app,observationId,...extra},{workingDir:root});
    currentLoop()!.exit('completed');this.emit('turnEnd');
   }
   interrupt(){} async stop(){}
  }
  const wrapped=new RecordingBrain(new Provider(),'test',{}, {autoResume:false});
  try {const done=new Promise<void>(resolve=>wrapped.once('turnEnd',resolve));wrapped.send('Offline native gate fixture');await done;
   assert.equal(asked,routine||deniedWithoutPrompt?0:1,`${app}/${tool}: grounded routine actions have no Echo prompt, sensitive commits have one`);
   assert.equal(dispatched,routine?1:0,'A refused or protected action never reaches input dispatch');
   assert.equal(outcome.status,routine?'success':'denied');
  } finally {await wrapped.stop();await closeEchoComputerControl();}
 }
 await fixture('Calculator','com.apple.calculator','\t1 button Description: 2, ID: Two','click_in_app',{target:1},true);
 await fixture('Calculator','com.apple.calculator','\t1 text 2+3\nThe focused UI element is 1 text 2+3','press_app_key',{key:'Return'},true);
 await fixture('Finder','com.apple.finder','\t1 close button','click_in_app',{target:1},true);
 await fixture('Mail','com.apple.mail','\t1 button Description: Send','click_in_app',{target:1},false);
 await fixture('Messages','com.apple.MobileSMS','\t1 text area Description: Message\nThe focused UI element is 1 text area Description: Message','press_app_key',{key:'Return'},false);
 await fixture('Safari','com.apple.Safari','\t1 web area\n\t\t2 button Description: Pay','click_in_app',{target:2},false);
 await fixture('Finder','com.apple.finder','\t1 dialog Description: Accessibility permission\n\t\t2 button Description: Allow','click_in_app',{target:2},false,true);
 console.log('PASS real gate/controller routine auto-allow, payment/send confirmation and protected-dialog refusal; inert native transport');
} finally {rmSync(root,{recursive:true,force:true});}
