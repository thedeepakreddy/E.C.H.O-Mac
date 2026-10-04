/** Offline provider contract regression. Scripted responses test dispatch, not model intelligence. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'echo-coding-providers-'));
process.env.ECHO_DATA_ROOT=join(root,'data');process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.ECHO_MCP='0';process.env.ECHO_LOG_QUIET='1';
const {DEFAULTS_FOR_TESTS}=await import('./config.js');
const {OpenAIBrain}=await import('./brain/openai.js');
const {ClaudeBrain}=await import('./brain/claude.js');
const {RecordingBrain}=await import('./agent-replay/runtime.js');
const {CODING_TOOL_NAMES}=await import('./coding/tool-selection.js');
const {getSession,listSessions}=await import('./coding/session.js');
const {readProjectFile}=await import('./coding/files.js');
const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
const cfg=structuredClone(DEFAULTS_FOR_TESTS);cfg.agi.toolPruning.enabled=false;cfg.control.workingDir=root;
const originalFetch=globalThis.fetch;
function action(label:string,step:number):{name:string;args:any}{
 if(step===0)return {name:'open_project',args:{path:join(root,label),name:label,create:true}};
 const s=listSessions().find(s=>s.name===label)!;assert(s,'owned project created');const base={projectId:s.id,revision:getSession(s.id).revision};
 switch(step){
  case 1:return {name:'apply_project_patch',args:{...base,path:'index.html',expectedHash:'missing',content:'<h1>Provider fixture</h1>'}};
  case 2:return {name:'read_project_file',args:{projectId:s.id,path:'index.html'}};
  case 3:return {name:'apply_project_patch',args:{...base,path:'index.html',expectedHash:'wrong-hash',content:'must not overwrite'}};
  case 4:return {name:'invoke_coding_tool',args:{action:'apply_project_patch',arguments:{...base,path:'index.html',expectedHash:'missing',content:'must not overwrite'}}};
  case 5:return {name:'finalize_project',args:base};
  default:return {name:'inspect_project',args:{projectId:s.id}};
 }
}
function verifyOutput(output:any,step:number){assert.equal(output.status,step===3||step===4||step===5?'failed':'success',`step ${step}: ${JSON.stringify(output).slice(0,300)}`);}
try{
 for(const label of ['openai','openrouter']){
  let calls=0;
  const endpoint=label==='openrouter'?{url:'https://openrouter.example/api/v1/responses',label:'openrouter'}:undefined;
  const provider=new OpenAIBrain(cfg,{via:'apiKey',key:'offline-fixture'}, {},endpoint) as any;
  globalThis.fetch=(async(input:any,init:any)=>{
   assert.equal(String(input),label==='openrouter'?'https://openrouter.example/api/v1/responses':'https://api.openai.com/v1/responses');
   const body=JSON.parse(init.body);
   for(const name of CODING_TOOL_NAMES)assert(body.tools.some((t:any)=>t.name===name),`${label} missing ${name}`);
   const nested=body.tools.find((t:any)=>t.name==='invoke_coding_tool').parameters.properties.arguments;
   assert.equal(nested.type,'object');assert.notEqual(nested.additionalProperties,false,'nested dispatcher must accept named arguments');
   if(calls>0){const outputs=body.input.filter((i:any)=>i.type==='function_call_output');assert(outputs.length);verifyOutput(JSON.parse(outputs.at(-1).output),calls-1);}
   const step=calls++;
   const output=step<7?[{type:'function_call',name:action(label,step).name,arguments:JSON.stringify(action(label,step).args),call_id:`${label}-${step}`}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixture inspected; full application completion remains unverified.'}]}];
   return new Response(`data: ${JSON.stringify({type:'response.completed',response:{output}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  const brain=new RecordingBrain(provider,label as any,{}, {autoResume:false});
  const finished=new Promise<void>(resolve=>brain.once('turnEnd',resolve));brain.send('Build a website project fixture.');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([finished,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} offline loop timeout`)),8000);})]);}finally{if(timer)clearTimeout(timer);await brain.stop();}
  assert.equal(calls,8);assert.equal(await readFile(join(root,label,'index.html'),'utf8'),'<h1>Provider fixture</h1>');
  assert.notEqual(listSessions().find(s=>s.name===label)!.phase,'completed');
  console.log(`PASS ${label}: actual Responses/SSE adapter, all coding declarations, guarded writes, nested dispatch and completion refusal`);
 }
 globalThis.fetch=originalFetch;
 const claude=new ClaudeBrain(cfg) as any;const sdk=claude.buildMcpServer();const [ct,st]=InMemoryTransport.createLinkedPair();
 await sdk.instance.connect(st);const client=new Client({name:'echo-coding-contract',version:'1'},{capabilities:{}});await client.connect(ct);
 try{const names=(await client.listTools()).tools.map(t=>t.name);for(const name of CODING_TOOL_NAMES)assert(names.includes(name),`Claude missing ${name}`);
  for(let step=0;step<7;step++){const a=action('claude',step);const result=await client.callTool({name:a.name,arguments:a.args});verifyOutput(JSON.parse((result.content as any[])[0].text),step);}
  const s=listSessions().find(s=>s.name==='claude')!;const file=await readProjectFile(s.id,'index.html');assert.equal(file.text,'<h1>Provider fixture</h1>');assert.notEqual(s.phase,'completed');
  console.log('PASS claude: actual in-process MCP client/server, all coding declarations, guarded writes, nested dispatch and completion refusal; live SDK/model loop not measured');
 }finally{await client.close();await sdk.instance.close();await claude.stop();}
}finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
