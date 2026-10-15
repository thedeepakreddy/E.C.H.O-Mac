import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'echo-gui-routing-'));
process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.ECHO_MCP='0';
try{
 const {codingToolNames}=await import('./coding/tool-selection.js');
 const {calculatorPostcondition,isAppOperationRequest}=await import('./brain/app-intent.js');
 assert.deepEqual(calculatorPostcondition('Open Calculator and calculate 2 plus 3.'),{expression:'2+3',value:5});
 assert.equal(calculatorPostcondition('Open Calculator and calculate 2 plus 3 plus 4.'),undefined,'A compound goal cannot be reduced to its first two operands');
 assert.equal(isAppOperationRequest('Calculate 2 plus 3.'),false,'Pure arithmetic is not foreground app control');
 assert.equal(isAppOperationRequest('Close the Downloads window.'),true,'Closing a native window must use the app controller and completion guard');
 for(const request of ['Open Calculator and calculate 2 plus 3.','Open the Calculator application.','Please type hello in TextEdit.','Open the project report in Preview.']){
  assert.equal(codingToolNames(request).size,0,`Operating an existing app is not coding: ${request}`);
 }
 for(const request of ['Build a calculator app with tests.','Fix my application login bug.','Compile the Swift project.','Open the coding project and inspect its source.'])assert(codingToolNames(request).size,request);
 const {ProviderMemoryContext}=await import('./memory/provider-context.js');
 const {conversations}=await import('./memory/conversation.js');
 const context=new ProviderMemoryContext('gemini');
 const conversation='1'.repeat(32);
 conversations.append(conversation,{role:'user',provider:'gemini',actorId:'echo',text:'Build a calculator app.'});
 context.begin('Open Calculator and calculate 2 plus 3.',{conversationId:conversation});
 assert.equal(context.isCodingTurn(),false,'An explicit app-operation request overrides older coding conversation');context.close();
 const {DEFAULTS_FOR_TESTS}=await import('./config.js');
 const {GeminiBrain}=await import('./brain/gemini.js');
 const cfg=structuredClone(DEFAULTS_FOR_TESTS);cfg.agi.toolPruning.enabled=true;
 const brain=new GeminiBrain(cfg,'fixture');
 (brain as any).mcpInitialized=true;
 const requests:any[]=[];
 (brain as any).generateStreaming=async(request:any)=>{
  requests.push(structuredClone(request));
  return {candidates:[{content:{role:'model',parts:[{text:'Fixture request captured; no app input performed.'}]},finishReason:'STOP'}]};
 };
 // Keep the production pruning/filter pass active, fake only the transport.
 const ended=new Promise<void>(resolve=>brain.once('turnEnd',resolve));
 brain.send('Open Calculator and calculate 2 plus 3.');await ended;await brain.stop();
 const names=requests[0].config.tools.flatMap((group:any)=>group.functionDeclarations.map((tool:any)=>tool.name));
 for(const name of ['open_app','inspect_app','click_in_app','type_in_app','press_app_key','move_echo_cursor'])assert(names.includes(name),`${name} must reach the actual Gemini request`);
 assert.equal(requests[0].config.toolConfig?.functionCallingConfig?.mode,undefined,'GUI work must not be forced into coding actions');
 const {OpenAIBrain}=await import('./brain/openai.js');
 const originalFetch=globalThis.fetch;
 try{
  for(const label of ['openai','openrouter']){
   const provider=new OpenAIBrain(cfg,{via:'apiKey',key:'offline-fixture'}, {},label==='openrouter'?{url:'https://openrouter.example/api/v1/responses',label}:undefined);
   let captured=false;
   globalThis.fetch=(async(_input:any,init:any)=>{
    const body=JSON.parse(init.body);captured=true;
    const verification=body.tools.find((tool:any)=>tool.name==='verify_app_state');assert(verification,`${label} actual request retains app verification`);
    assert.deepEqual(verification.parameters.properties.kind.enum,['visible','text','window_closed'],`${label} must expose all verification kinds, not drop a union branch`);
    assert(verification.parameters.properties.index&&verification.parameters.properties.expected,`${label} must expose exact text conditions`);
    assert(verification.parameters.properties.windowTitle,`${label} must expose the original native window title for closure verification`);
    return new Response(`data: ${JSON.stringify({type:'response.completed',response:{output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixture captured; no device input.'}]}]}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
   }) as typeof fetch;
   const done=new Promise<void>(resolve=>provider.once('turnEnd',resolve));provider.send('Open Calculator and calculate 2 plus 3.');await done;await provider.stop();assert(captured);
  }
 }finally{globalThis.fetch=originalFetch;}
 console.log('PASS app intent, conversation override and actual Gemini request wiring; fake transport, no device input');
}finally{rmSync(root,{recursive:true,force:true});}
