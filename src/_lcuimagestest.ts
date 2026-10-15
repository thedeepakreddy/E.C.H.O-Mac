import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'echo-image-fixture-'));
process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.ECHO_MCP='0';
try{
 const {trimResponseImages,OpenAIBrain}=await import('./brain/openai.js');
 const image=(id:string)=>({type:'input_image',image_url:'data:image/png;base64,'+id});
 const history=[{role:'user',content:[image('old-1'),image('old-2'),image('old-3')]},{role:'user',content:[image('new-1'),image('new-2'),image('new-3')]}];
 trimResponseImages(history,2,1);
 assert.equal(history[1].content.filter(c=>c.type==='input_image').length,3,'A new batch is never trimmed before its first model delivery');
 assert.equal(history[0].content.filter(c=>c.type==='input_image').length,2);
 const {DEFAULTS_FOR_TESTS}=await import('./config.js');
 const {TOOLS}=await import('./tools/registry.js');
 const {z}=await import('zod');
 TOOLS.push({name:'read_image_fixture',description:'Read fixture images',schema:{id:z.number().int()},readOnly:true,handler:async args=>({text:'Observed fixture',data:{toolData:{observationId:'observation-'+args.id},originalComputerResults:[{content:[{type:'image',mimeType:'image/png',data:'fixture-'+args.id}]}]},computerContent:[{type:'image',mimeType:'image/png',data:'fixture-'+args.id}]})});
 const cfg=structuredClone(DEFAULTS_FOR_TESTS);cfg.agi.toolPruning.enabled=false;
 const provider=new OpenAIBrain(cfg,{via:'apiKey',key:'fixture'},{allowedTools:new Set(['read_image_fixture'])});
 (provider as any).mcpInitialized=true;
 const requests:any[]=[];
 (provider as any).streamResponse=async(request:any)=>{requests.push(structuredClone(request));return {output:requests.length===1?[1,2,3].map(id=>({type:'function_call',call_id:'image-call-'+id,name:'read_image_fixture',arguments:JSON.stringify({id})})):[{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixture observations received.'}]}],usage:{}};};
 const {RecordingBrain}=await import('./agent-replay/runtime.js');
 const wrapped=new RecordingBrain(provider,'openai',{}, {autoResume:false});
 const finished=new Promise<void>(resolve=>wrapped.once('turnEnd',resolve));wrapped.send('Read the three fixture images');await finished;await wrapped.stop();
 const delivered=requests[1].input.flatMap((item:any)=>item.content??[]);
 assert.equal(delivered.filter((block:any)=>block.type==='input_image').length,3,'All three tool images reach the real Responses-loop request');
 const labels=delivered.filter((block:any)=>block.type==='input_text').map((block:any)=>block.text).join('\n');
 for(const id of [1,2,3]){assert.match(labels,new RegExp('image-call-'+id));assert.match(labels,new RegExp('observation-'+id));}
 console.log('PASS fresh batch retention and exact call/observation identity in the Responses provider');
 const {GeminiBrain}=await import('./brain/gemini.js');
 const gemini=new GeminiBrain(structuredClone(cfg),'fixture',{allowedTools:new Set(['read_image_fixture']),maxIterations:6});
 (gemini as any).mcpInitialized=true;
 const geminiRequests:any[][]=[];
 const batches=[[1,2,3,4],[5,6,7,8,9],[10]];
 (gemini as any).ai={models:{generateContentStream:async(request:any)=>{
   geminiRequests.push(structuredClone(request.contents));
   const batch=batches[geminiRequests.length-1];
   const parts=batch?batch.map(id=>({functionCall:{id:'image-call-'+id,name:'read_image_fixture',args:{id}}})):[{text:'Fixture observations received.'}];
   return (async function*(){yield {candidates:[{content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{}};})();
 }}};
 const geminiWrapped=new RecordingBrain(gemini,'gemini',{}, {autoResume:false});
 try {
   const done=new Promise<void>(resolve=>geminiWrapped.once('turnEnd',resolve));
   geminiWrapped.send('Read the fixture image batches');await done;
 } finally {await geminiWrapped.stop();}
 assert.equal(geminiRequests.length,4,'Each batch gets a model delivery through the real streaming provider loop');
 const partsOf=(contents:any[])=>contents.flatMap(content=>content.parts??[]);
 const imagesOf=(contents:any[])=>partsOf(contents).filter(part=>part.inlineData?.mimeType==='image/png').map(part=>part.inlineData.data);
 assert.deepEqual(imagesOf(geminiRequests[1]),['fixture-1','fixture-2','fixture-3','fixture-4'],'Gemini must deliver every image in a new batch before pruning');
 assert.deepEqual(imagesOf(geminiRequests[2]),['fixture-2','fixture-3','fixture-4','fixture-5','fixture-6','fixture-7','fixture-8','fixture-9'],'Only previously delivered observations may be pruned; the new five-image batch stays intact');
 assert.deepEqual(imagesOf(geminiRequests[3]),['fixture-7','fixture-8','fixture-9','fixture-10'],'Prior batches become eligible for the normal three-image history limit');
 assert.equal(partsOf(geminiRequests[3]).filter(part=>part.functionResponse).length,10,'Pruning preserves every tool response');
 for(const [requestIndex,ids] of [[1,batches[0]],[2,batches[1]],[3,batches[2]]] as Array<[number,number[]]>) {
   const deliveredParts=partsOf(geminiRequests[requestIndex]);
   for(const id of ids) {
     const imageIndex=deliveredParts.findIndex(part=>part.inlineData?.data==='fixture-'+id);
     assert.match(deliveredParts[imageIndex-1]?.text??'',new RegExp('image-call-'+id+'(?:\\s|;)'));
     assert.match(deliveredParts[imageIndex-1]?.text??'',new RegExp('observation-'+id+'\\.'));
   }
 }
 console.log('PASS Gemini first-delivery batch retention, subsequent pruning, tool responses and call/observation labels');
}finally{rmSync(root,{recursive:true,force:true});}
