import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'echo-model-health-regression-'));
const environment={ECHO_DATA_ROOT:root,ECHO_MEMORY_ROOT:join(root,'memory'),ECHO_MCP:'0',ECHO_LOG_QUIET:'1'};
const previous=new Map(Object.keys(environment).map(key=>[key,process.env[key]]));
Object.assign(process.env,environment);
const originalFetch=globalThis.fetch,originalNow=Date.now;
let networkAttempts=0;
const denyFetch:typeof fetch=async()=>{networkAttempts++;throw Error('Network forbidden in model-health fixtures');};
globalThis.fetch=denyFetch;

try{
 const healthModule=await import('./brain/model-health.js');
 const {modelHealth}=healthModule;
 await test('a dead model that fails its weekly re-probe is excluded again',()=>{
  const start=originalNow();Date.now=()=>start;
  modelHealth.markDead('expired-model-fixture','404 model unavailable');
  assert.equal(modelHealth.usable('expired-model-fixture'),false);
  Date.now=()=>start+8*24*60*60*1000;
  assert.equal(modelHealth.usable('expired-model-fixture'),true);
  modelHealth.markDead('expired-model-fixture','404 still unavailable');
  assert.equal(modelHealth.usable('expired-model-fixture'),false,'A failed re-probe must renew the exclusion');
  Date.now=originalNow;
 });
 await test('availability notes never persist raw provider errors or credentials',()=>{
  const secret='fixture-private-account-material';
  modelHealth.markDead('secret-error-fixture',`404 Error: Bearer ${secret}`);
  modelHealth.markUnavailable('temporary-secret-fixture',`503 apiKey=${secret}`);
  const stored=readFileSync(join(root,'model-health.json'),'utf8');
  assert(!stored.includes(secret),'Only stable reason codes may be persisted');
  assert(!modelHealth.explain(['temporary-secret-fixture']).includes(secret));
 });
 await test('a stale quota failure cannot shorten a same-account model exclusion',()=>{
  const start=originalNow();Date.now=()=>start;
  try{
   const health=healthModule.scopedModelHealth({provider:'openai',account:'concurrent-account-fixture',
    environment:'OPENAI_API_KEY',endpoint:'offline-concurrent-fixture'});
   health.markDead('concurrent-model-fixture','404');
   health.markExhausted('concurrent-model-fixture','429 rate limit from an older request');
   Date.now=()=>start+6*60*1000;
   assert.equal(health.usable('concurrent-model-fixture'),false,'A concurrent quota response must not replace the week-long 404 exclusion');
  }finally{Date.now=originalNow;}
 });
 await test('health cache is isolated by provider, account, configured environment and endpoint',()=>{
  const scope={provider:'gemini',account:'fixture-private-account-a',environment:'CUSTOM_GEMINI_KEY',endpoint:'google-generative-v1beta'};
  const scoped=healthModule.scopedModelHealth;
  assert.equal(typeof scoped,'function','A scoped health boundary is required');
  const own=scoped(scope);own.markDead('shared-model-fixture','404');
  assert.equal(scoped({...scope}).usable('shared-model-fixture'),false,'Same namespace shares known failures');
  for(const changed of [{provider:'openai'},{account:'fixture-private-account-b'},
   {environment:'ANOTHER_GEMINI_KEY'},{endpoint:'different-deployment'}])
   assert.equal(scoped({...scope,...changed}).usable('shared-model-fixture'),true,'Other namespaces must not inherit denial');
  const files=readdirSync(join(root,'model-health'));
  assert(files.length>0);assert(files.every(file=>/^[a-f0-9]{64}\.json$/.test(file)),'Only hashes identify persisted cache scopes');
  const stored=files.map(file=>readFileSync(join(root,'model-health',file),'utf8')).join('');
  assert(!stored.includes(scope.account));assert(!stored.includes(scope.environment));
  process.env.ECHO_DATA_ROOT=join(root,'different-data-root');
  try{assert.equal(own.usable('shared-model-fixture'),true,'A different data root has no inherited cache');}
  finally{process.env.ECHO_DATA_ROOT=root;}
  assert.equal(own.usable('shared-model-fixture'),false,'The original exclusion must reload from disk');
  modelHealth.markDead('legacy-unscoped-fixture','404');
  assert.equal(own.usable('legacy-unscoped-fixture'),true,'Legacy unscoped failures have no account authority');
 });

 const {DEFAULTS_FOR_TESTS,setActiveConfig}=await import('./config.js');
 const config=()=>{const value=structuredClone(DEFAULTS_FOR_TESTS);value.control.workingDir=root;return value;};
 setActiveConfig(config());
 const {GeminiBrain}=await import('./brain/gemini.js');
 const {OpenAIBrain}=await import('./brain/openai.js');
 async function turn(brain:{send(text:string):void;once(event:string,callback:()=>void):unknown;off(event:string,callback:()=>void):unknown}){
  let ended!:()=>void,timer:ReturnType<typeof setTimeout>|undefined;
  const done=new Promise<void>(resolve=>{ended=resolve;brain.once('turnEnd',ended);});
  try{brain.send('Explain an offline concept.');await Promise.race([done,new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(Error('Offline model fixture stalled')),3000);
  })]);}finally{clearTimeout(timer);brain.off('turnEnd',ended);}
 }
 const geminiReply=()=> (async function*(){yield {candidates:[{content:{role:'model',parts:[{text:'Offline model reply.'}]},finishReason:'STOP'}]};})();
 await test('Gemini structured model 404 falls back once and reports the model actually used',async()=>{
  const cfg=config();cfg.gemini.model='unavailable-gemini-fixture';
  const provider=new GeminiBrain(cfg,'gemini-account-fixture-1',{allowedTools:new Set(),maxIterations:3});
  const requests:string[]=[],errors:string[]=[],progress:string[]=[];
  provider.on('error',error=>errors.push(String(error)));provider.on('progress',value=>progress.push(String(value)));
  (provider as any).ai={models:{generateContentStream:async(request:any)=>{
   requests.push(request.model);
   if(request.model==='unavailable-gemini-fixture')throw Object.assign(Error('The requested model does not exist'),{status:404});
   return geminiReply();
  }}};
  try{
   await turn(provider);await turn(provider);
   assert.equal(requests.filter(model=>model==='unavailable-gemini-fixture').length,1,'A known-dead model is not repeatedly requested');
   assert(requests.some(model=>model!=='unavailable-gemini-fixture'),'The existing Gemini ladder supplies the fallback');
   assert.deepEqual(errors,[]);
   assert(progress.some(value=>value.includes(`Using Gemini model ${requests.at(-1)}`)),'Progress names only a model that actually responded');
  }finally{await provider.stop();}
 });
 await test('Gemini skips a fallback another same-account worker marked dead during this turn',async()=>{
  const cfg=config(),account='gemini-shared-account-fixture';cfg.gemini.model='shared-primary-fixture';
  const {GEMINI_MODEL_FALLBACKS}=await import('./brain/types.js');
  const health=healthModule.scopedModelHealth({provider:'gemini',account,
   environment:cfg.gemini.apiKeyEnv,endpoint:'generativelanguage:v1beta'});
  const provider=new GeminiBrain(cfg,account,{allowedTools:new Set(),maxIterations:2});
  const requests:string[]=[];provider.on('error',()=>{});
  (provider as any).ai={models:{generateContentStream:async(request:any)=>{
   requests.push(request.model);
   if(request.model==='shared-primary-fixture'){
    health.markDead(GEMINI_MODEL_FALLBACKS[0],'404 observed by another worker');
    throw Object.assign(Error('Model unavailable'),{status:404});
   }
   return geminiReply();
  }}};
  try{
   await turn(provider);
   assert.deepEqual(requests,['shared-primary-fixture',GEMINI_MODEL_FALLBACKS[1]],'A stale initial ladder must not request the newly dead fallback');
  }finally{await provider.stop();}
 });
 await test('OpenAI explicit unavailable model is requested once, not retried across turns or fabricated into a fallback',async()=>{
  const cfg=config();cfg.openai.model='unavailable-openai-fixture';
  const endpoint={url:'https://offline-model-fixture.invalid/responses',label:'openai'};
  const provider=new OpenAIBrain(cfg,{via:'apiKey',key:'openai-private-account-fixture'},
   {allowedTools:new Set(),maxIterations:2},endpoint);
  const requests:string[]=[],progress:string[]=[],errors:string[]=[];
  provider.on('progress',value=>progress.push(String(value)));provider.on('error',value=>errors.push(String(value)));
  globalThis.fetch=(async(input,options)=>{
   if(String(input)!==endpoint.url)return denyFetch(input,options);
   requests.push(JSON.parse(String(options?.body)).model);
   return new Response(JSON.stringify({error:{code:'model_not_found',message:'The selected model does not exist'}}),{status:404});
  }) as typeof fetch;
  try{
   await turn(provider);await turn(provider);
   assert.deepEqual(requests,['unavailable-openai-fixture'],'A repeated user turn does not repeat a known model 404');
   assert.equal(cfg.openai.model,'unavailable-openai-fixture','No unconfigured model silently replaces the selected model');
   assert.equal(errors.length,2);
   assert(!progress.some(value=>value.includes('Using ')||value.includes('Trying another')),'No model responded and no authorized fallback exists');
  }finally{globalThis.fetch=denyFetch;await provider.stop();}
 });
 await test('OpenAI provider wiring keeps a model 404 within its credential, provider, environment and deployment',async()=>{
  const requests:string[]=[];
  const run=async(key:string,label:string,url:string,env:string)=>{
   const cfg=config();cfg.openai.model='scope-wiring-model-fixture';
   cfg.openai.apiKeyEnv=env;cfg.openrouter.apiKeyEnv=env;cfg.nvidia.apiKeyEnv=env;
   const provider=new OpenAIBrain(cfg,{via:'apiKey',key},{allowedTools:new Set(),maxIterations:2},{label,url});
   provider.on('error',()=>{});
   try{await turn(provider);}finally{await provider.stop();}
  };
  globalThis.fetch=(async(input,options)=>{
   const url=String(input);
   if(!['https://offline-scope.invalid/responses','https://offline-other-scope.invalid/responses'].includes(url))return denyFetch(input,options);
   requests.push(JSON.parse(String(options?.body)).model);
   return new Response(JSON.stringify({error:{code:'model_not_found',message:'Model unavailable'}}),{status:404});
  }) as typeof fetch;
  try{
   await run('scope-key-a','openai','https://offline-scope.invalid/responses','KEY_A');
   await run('scope-key-a','openai','https://offline-scope.invalid/responses','KEY_A');
   assert.equal(requests.length,1,'A new worker shares the same account exclusion');
   await run('scope-key-b','openai','https://offline-scope.invalid/responses','KEY_A');
   await run('scope-key-a','openrouter','https://offline-scope.invalid/responses','KEY_A');
   await run('scope-key-a','nvidia','https://offline-scope.invalid/responses','KEY_A');
   await run('scope-key-a','openai','https://offline-scope.invalid/responses','KEY_B');
   await run('scope-key-a','openai','https://offline-other-scope.invalid/responses','KEY_A');
   assert.equal(requests.length,6,'Each different authority gets its own initial request');
  }finally{globalThis.fetch=denyFetch;}
 });
 for(const type of ['gemini','openai'] as const)await test(`${type} unknown-model 400 is excluded rather than repeatedly requested`,async()=>{
  const cfg=config(),requests:string[]=[];
  cfg[type].model=`unknown-${type}-fixture`;
  const endpoint={url:'https://offline-unknown-model.invalid/responses',label:'openai'};
  const provider=type==='gemini'?new GeminiBrain(cfg,'unknown-gemini-account',{allowedTools:new Set(),maxIterations:2})
   :new OpenAIBrain(cfg,{via:'apiKey',key:'unknown-openai-account'},{allowedTools:new Set(),maxIterations:2},endpoint);
  provider.on('error',()=>{});
  if(type==='gemini')(provider as any).ai={models:{generateContentStream:async(request:any)=>{
   requests.push(request.model);
   if(request.model===`unknown-${type}-fixture`)throw Object.assign(Error('Unrecognized model identifier'),{status:400,code:'unknown_model'});
   return geminiReply();
  }}};
  else globalThis.fetch=(async(input,options)=>{
   if(String(input)!==endpoint.url)return denyFetch(input,options);
   requests.push(JSON.parse(String(options?.body)).model);
   return new Response(JSON.stringify({error:{code:'model_not_found',message:'Requested model is disabled'}}),{status:400});
  }) as typeof fetch;
  try{
   await turn(provider);await turn(provider);
   assert.equal(requests.filter(model=>model===`unknown-${type}-fixture`).length,1);
   assert(requests.length<=3,'Unknown-model retries remain bounded');
  }finally{globalThis.fetch=denyFetch;await provider.stop();}
 });
 await test('automatic ChatGPT plan fallback uses only its cached account catalogue within the same turn',async()=>{
  const {chatgpt}=await import('./brain/chatgpt-auth.js');
  const original={accessToken:chatgpt.accessToken,listModels:chatgpt.listModels,session:chatgpt.session};
  let catalogues=0,token='plan-fixture-token',email='plan-fixture@example.invalid';
  chatgpt.accessToken=async()=>token;
  chatgpt.session=()=>({status:'connected',planUsage:true,email});
  chatgpt.listModels=async()=>{catalogues++;
   if(email==='other-plan-fixture@example.invalid')return [{slug:'other-account-plan-fixture',displayName:'Other account fixture'}];
   return [{slug:'retired-plan-fixture',displayName:'Retired fixture'},
   {slug:'available-plan-fixture',displayName:'Available fixture'}];};
  const cfg=config();cfg.openai.chatgptModel='';
  const endpoint={url:'https://offline-plan-model.invalid/responses',label:'openai'};
  const provider=new OpenAIBrain(cfg,{via:'chatgpt'},{allowedTools:new Set(),maxIterations:2},endpoint);
  const requests:string[]=[],errors:string[]=[],progress:string[]=[];
  provider.on('error',value=>errors.push(String(value)));provider.on('progress',value=>progress.push(String(value)));
  globalThis.fetch=(async(input,options)=>{
   if(String(input)!==endpoint.url)return denyFetch(input,options);
   const model=JSON.parse(String(options?.body)).model;requests.push(model);
   if(model==='retired-plan-fixture')return new Response(JSON.stringify({error:{code:'model_not_found',message:'Model unavailable'}}),{status:404});
   return new Response(`data: ${JSON.stringify({type:'response.completed',response:{output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Offline plan reply.'}]}]}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  try{
   await turn(provider);
   assert.deepEqual(requests,['retired-plan-fixture','available-plan-fixture']);
   assert.equal(catalogues,1,'Failure must not trigger repeated discovery requests');
   assert.deepEqual(errors,[]);
   assert(progress.some(value=>value.includes('Using openai model available-plan-fixture')));
   token='rotated-plan-fixture-token';
   await turn(provider);
   assert.deepEqual(requests,['retired-plan-fixture','available-plan-fixture','available-plan-fixture']);
   assert.equal(catalogues,1,'Refreshing the same account token retains its cached catalogue');
   email='other-plan-fixture@example.invalid';
   await turn(provider);
   assert.equal(requests.at(-1),'other-account-plan-fixture','A new account must select from its own catalogue');
   assert.equal(catalogues,2);
   assert.deepEqual(errors,[]);
  }finally{globalThis.fetch=denyFetch;Object.assign(chatgpt,original);await provider.stop();}
 });
 await test('an explicit ChatGPT selection never discovers or silently selects a replacement model',async()=>{
  const {chatgpt}=await import('./brain/chatgpt-auth.js');
  const original={accessToken:chatgpt.accessToken,listModels:chatgpt.listModels,session:chatgpt.session};
  let catalogues=0;
  chatgpt.accessToken=async()=> 'explicit-plan-token-fixture';
  chatgpt.session=()=>({status:'connected',planUsage:true,email:'explicit-plan@example.invalid'});
  chatgpt.listModels=async()=>{catalogues++;return [{slug:'unselected-fixture',displayName:'Unselected fixture'}];};
  const cfg=config();cfg.openai.chatgptModel='explicit-plan-model-fixture';
  const endpoint={url:'https://offline-explicit-plan.invalid/responses',label:'openai'};
  const provider=new OpenAIBrain(cfg,{via:'chatgpt'},{allowedTools:new Set(),maxIterations:2},endpoint);
  const requests:string[]=[],progress:string[]=[],errors:string[]=[];
  provider.on('error',value=>errors.push(String(value)));provider.on('progress',value=>progress.push(String(value)));
  globalThis.fetch=(async(input,options)=>{
   if(String(input)!==endpoint.url)return denyFetch(input,options);
   requests.push(JSON.parse(String(options?.body)).model);
   return new Response(JSON.stringify({error:{code:'model_not_found',message:'Selected model unavailable'}}),{status:404});
  }) as typeof fetch;
  try{
   await turn(provider);await turn(provider);
   assert.deepEqual(requests,['explicit-plan-model-fixture']);
   assert.equal(catalogues,0,'An explicit selection does not authorize discovery');
   assert.equal(cfg.openai.chatgptModel,'explicit-plan-model-fixture');
   assert.equal(errors.length,2);
   assert(!progress.some(value=>value.includes('Using ')||value.includes('Trying ')));
  }finally{globalThis.fetch=denyFetch;Object.assign(chatgpt,original);await provider.stop();}
 });
 await test('an exhausted automatic catalogue stops at the request cap and never repeats known model failures',async()=>{
  const {chatgpt}=await import('./brain/chatgpt-auth.js');
  const original={accessToken:chatgpt.accessToken,listModels:chatgpt.listModels,session:chatgpt.session};
  let catalogues=0;
  const offered=['gone-plan-1','gone-plan-2','gone-plan-3','gone-plan-4','gone-plan-5','gone-plan-6'];
  chatgpt.accessToken=async()=> 'exhausted-plan-token-fixture';
  chatgpt.session=()=>({status:'connected',planUsage:true,email:'exhausted-plan@example.invalid'});
  chatgpt.listModels=async()=>{catalogues++;return offered.map(slug=>({slug,displayName:slug}));};
  const cfg=config();cfg.openai.chatgptModel='';
  const endpoint={url:'https://offline-exhausted-plan.invalid/responses',label:'openai'};
  const provider=new OpenAIBrain(cfg,{via:'chatgpt'},{allowedTools:new Set(),maxIterations:2},endpoint);
  const requests:string[]=[],progress:string[]=[],errors:string[]=[];
  provider.on('error',value=>errors.push(String(value)));provider.on('progress',value=>progress.push(String(value)));
  globalThis.fetch=(async(input,options)=>{
   if(String(input)!==endpoint.url)return denyFetch(input,options);
   requests.push(JSON.parse(String(options?.body)).model);
   return new Response(JSON.stringify({error:{code:'model_not_found',message:'Model unavailable'}}),{status:404});
  }) as typeof fetch;
  try{
   await turn(provider);
   assert.deepEqual(requests,offered.slice(0,4),'The first turn permits at most four catalogue requests');
   await turn(provider);await turn(provider);
   assert.deepEqual(requests,offered,'Each offered model fails only once; an exhausted catalogue makes no request');
   assert.equal(catalogues,1);
   assert.equal(errors.length,3);
   assert(errors.at(-1)?.includes('No usable model remains'));
   assert(!progress.some(value=>value.includes('Using ')),'A failed model is never reported as actually used');
  }finally{globalThis.fetch=denyFetch;Object.assign(chatgpt,original);await provider.stop();}
 });
 const persisted=readdirSync(join(root,'model-health')).map(file=>
  `${file}\n${readFileSync(join(root,'model-health',file),'utf8')}`).join('\n');
 for(const secret of ['fixture-private-account-a','scope-key-a','scope-key-b','openai-private-account-fixture',
  'plan-fixture-token','rotated-plan-fixture-token','plan-fixture@example.invalid','other-plan-fixture@example.invalid',
  'explicit-plan-token-fixture','explicit-plan@example.invalid','exhausted-plan-token-fixture','exhausted-plan@example.invalid'])
  assert(!persisted.includes(secret),'Health cache files and their names must not disclose account credentials or identities');
 assert.equal(networkAttempts,0);
}finally{
 Date.now=originalNow;globalThis.fetch=originalFetch;
 for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 rmSync(root,{recursive:true,force:true});
}
