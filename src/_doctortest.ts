import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Isolate before importing keystore: it captures dataRoot at module load.
const fixture=mkdtempSync(join(tmpdir(),'echo-doctor-fixture-'));
const appRoot=join(fixture,'app'),userRoot=join(fixture,'user'),lcuRoot=join(fixture,'lcu');
mkdirSync(appRoot);mkdirSync(userRoot);mkdirSync(lcuRoot);
mkdirSync(join(userRoot,'chatgpt'));
writeFileSync(join(userRoot,'chatgpt','connection.json'),JSON.stringify({version:1,encrypted:false,payload:JSON.stringify({version:1,clientId:'fixture-client',status:'connected',accessToken:'fake-plan-token-never-send',expiresAt:0,scopes:['chatgpt.tokens.use.direct']})}));
const savedEnv={...process.env};
process.env.ECHO_DATA_ROOT=userRoot;
for(const name of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','NVIDIA_API_KEY','ECHO_DOCTOR_KEY'])delete process.env[name];
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('Doctor fixture must not contact any provider');};
const doctor=await import('./diagnostics/doctor.js');
test.after(()=>{globalThis.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in savedEnv))delete process.env[k];Object.assign(process.env,savedEnv);rmSync(fixture,{recursive:true,force:true});});
const check=(report:Awaited<ReturnType<typeof doctor.collectDoctorReport>>,id:string)=>{const found=report.checks.find(c=>c.id===id);assert.ok(found,`Missing explicit doctor check ${id}`);return found;};

test('doctor uses persisted app selection and real keystore/env precedence without disclosing credentials',async()=>{
 writeFileSync(join(appRoot,'config.json'),JSON.stringify({brain:'claude'}));
 writeFileSync(join(userRoot,'config.json'),JSON.stringify({brain:'nvidia',nvidia:{model:'fixture/model',apiKeyEnv:'ECHO_DOCTOR_KEY'}}));
 writeFileSync(join(userRoot,'keys.env'),'ECHO_DOCTOR_KEY=fake-saved-credential\n');
 writeFileSync(join(appRoot,'.env'),'export ECHO_DOCTOR_KEY=fake-bundle-credential\n');
 const persisted=readFileSync(join(userRoot,'config.json'),'utf8');
 const report=await doctor.collectDoctorReport(appRoot,{lcuRoot});
 assert.equal(report.selectedBrain,'nvidia');
 assert.equal(report.configSource,'user');
 assert.equal(process.env.ECHO_DOCTOR_KEY,'fake-saved-credential');
 assert.equal(check(report,'provider.nvidia.model').status,'ok');
 assert.equal(check(report,'provider.nvidia.authentication').status,'unverified');
 assert.ok(!JSON.stringify(report).includes('fake-saved-credential'));
 assert.equal(readFileSync(join(userRoot,'config.json'),'utf8'),persisted);
 process.env.ECHO_DOCTOR_KEY='fake-shell-credential';
 const overridden=await doctor.collectDoctorReport(appRoot,{lcuRoot});
 assert.equal(process.env.ECHO_DOCTOR_KEY,'fake-shell-credential');
 assert.ok(!doctor.formatDoctorReport(overridden).includes('fake-shell-credential'));
});

test('all six providers report missing models/auth or unverified service without Claude fallback',async()=>{
 writeFileSync(join(userRoot,'keys.env'),'# no fixture credentials\n');
 delete process.env.ECHO_DOCTOR_KEY;
 for(const provider of ['claude','gemini','openai','openrouter','nvidia','ollama']){
  writeFileSync(join(userRoot,'config.json'),JSON.stringify({brain:provider,[provider]:{model:'',apiKeyEnv:'ECHO_DOCTOR_KEY'},openai:{model:'',apiKeyEnv:'ECHO_DOCTOR_KEY',auth:'apiKey'}}));
  // .env must not introduce a fake credential in the missing-auth fixture.
  writeFileSync(join(appRoot,'.env'),'# none\n');
  const report=await doctor.collectDoctorReport(appRoot,{lcuRoot});
  assert.equal(report.selectedBrain,provider);
  assert.equal(check(report,`provider.${provider}.model`).status,'missing');
  assert.equal(check(report,`provider.${provider}.runtime`).status,'unverified');
  assert.equal(check(report,`provider.${provider}.authentication`).status,
   provider==='claude'?'unverified':provider==='ollama'?'ok':'missing');
  assert.equal(doctor.doctorExitCode(report),1);
  for(const other of ['claude','gemini','openai','openrouter','nvidia','ollama'])assert.ok(check(report,`provider.${other}.runtime`));
 }
});

test('LCU binary/client and pointer presence are checked without execution and never imply permissions',async()=>{
 writeFileSync(join(userRoot,'config.json'),JSON.stringify({brain:'ollama'}));
 let report=await doctor.collectDoctorReport(appRoot,{lcuRoot});
 for(const id of ['lcu.binary','lcu.client','lcu.pointer'])assert.equal(check(report,id).status,'missing');
 for(const id of ['permission.accessibility','permission.screen','permission.microphone','permission.camera','permission.lcu-app-approval','lcu.connection'])assert.equal(check(report,id).status,'unverified');
 mkdirSync(join(lcuRoot,'bin'));mkdirSync(join(lcuRoot,'adapters'));mkdirSync(join(appRoot,'native'));
 // These are inert files, not valid native helpers. Doctor must never run them.
 writeFileSync(join(lcuRoot,'bin','lcu'),'DO NOT EXECUTE fixture\n');chmodSync(join(lcuRoot,'bin','lcu'),0o755);
 writeFileSync(join(appRoot,'native','echo-pointer'),'DO NOT EXECUTE fixture\n');chmodSync(join(appRoot,'native','echo-pointer'),0o755);
 writeFileSync(join(lcuRoot,'adapters','client.mjs'),'throw Error("Doctor must not import a runtime client");');
 report=await doctor.collectDoctorReport(appRoot,{lcuRoot});
 assert.equal(check(report,'lcu.binary').status,'ok');
 assert.equal(check(report,'lcu.pointer').status,'ok');
 assert.equal(check(report,'lcu.client').status,'blocked','Presence of an unreviewed client is not readiness');
 assert.equal(check(report,'permission.accessibility').status,'unverified');
 assert.equal(doctor.doctorExitCode(report),1);
 assert.doesNotMatch(doctor.formatDoctorReport(report),/all clear|all set/i);
 chmodSync(join(lcuRoot,'bin','lcu'),0o644);
 report=await doctor.collectDoctorReport(appRoot,{lcuRoot});
 assert.equal(check(report,'lcu.binary').status,'missing','A file without executable access is not an installed runtime');
});

test('malformed persisted configuration is blocked without leaking parser errors or falling back silently',async()=>{
 writeFileSync(join(userRoot,'config.json'),'{"credential":"fake-sensitive-parser-text",');
 const logs:string[]=[],original=console.error;console.error=(...args:unknown[])=>logs.push(args.map(String).join(' '));
 let report;try{report=await doctor.collectDoctorReport(appRoot,{lcuRoot});}finally{console.error=original;}
 assert.equal(check(report,'config').status,'blocked');
 assert.equal(report.selectedBrain,'unknown');
 assert.equal(doctor.doctorExitCode(report),1);
 assert.ok(!logs.join('\n').includes('fake-sensitive-parser-text'));
 assert.ok(!doctor.formatDoctorReport(report).includes('fake-sensitive-parser-text'));
});

test('OpenAI follows the real ChatGPT auth mode and deferred plan model, without refresh or token disclosure',async()=>{
 process.env.ECHO_DOCTOR_KEY='fake-api-key-should-not-change-auth-mode';
 writeFileSync(join(userRoot,'config.json'),JSON.stringify({brain:'openai',openai:{auth:'chatgpt',apiKeyEnv:'ECHO_DOCTOR_KEY',model:'',chatgptModel:''}}));
 const report=await doctor.collectDoctorReport(appRoot,{lcuRoot});
 assert.equal(check(report,'provider.openai.model').status,'unverified','The real plan can discover its own first model; the API-key model is not required');
 assert.match(check(report,'provider.openai.authentication').detail,/ChatGPT/);
 assert.equal(check(report,'provider.openai.authentication').status,'unverified','Expired fixture token must not be called authenticated');
 assert.ok(!JSON.stringify(report).includes('fake-plan-token-never-send'));
 assert.ok(!JSON.stringify(report).includes('fake-api-key-should-not-change-auth-mode'));
});

test('doctor CLI delegates to shared diagnostics and never embeds an automatic Claude query',()=>{
 const cli=readFileSync(join(process.cwd(),'scripts','doctor.mjs'),'utf8');
 assert.doesNotMatch(cli,/claude-agent-sdk|\bquery\s*\(/);
 assert.match(cli,/diagnostics\/doctor\.ts/);
});

test('standalone doctor compiles shared TS and reports fake persisted selection as JSON without writes or live probes',()=>{
 writeFileSync(join(userRoot,'config.json'),JSON.stringify({brain:'nvidia',nvidia:{model:'fixture/model',apiKeyEnv:'ECHO_DOCTOR_KEY'}}));
 const before=readFileSync(join(userRoot,'config.json'),'utf8'),keysBefore=readFileSync(join(userRoot,'keys.env'),'utf8');
 const result=spawnSync(process.execPath,['--import',join(process.cwd(),'scripts','test-network-guard.mjs'),join(process.cwd(),'scripts','doctor.mjs'),'--json','--app-root',appRoot,'--lcu-root',lcuRoot],{encoding:'utf8',timeout:30000,env:{...process.env,ECHO_MCP:'0'}});
 assert.equal(result.error,undefined);
 assert.equal(result.status,1,'Deliberately missing/unreviewed runtime is a detected blocker');
 assert.equal(result.stderr,'');
 const report=JSON.parse(result.stdout);
 assert.equal(report.selectedBrain,'nvidia');
 assert.equal(report.configSource,'user');
 assert.equal(check(report,'provider.nvidia.authentication').status,'unverified');
 assert.equal(check(report,'permission.lcu-app-approval').status,'unverified');
 assert.ok(!result.stdout.includes('fake-api-key-should-not-change-auth-mode'));
 assert.ok(!result.stdout.includes('fake-plan-token-never-send'));
 assert.equal(readFileSync(join(userRoot,'config.json'),'utf8'),before);
 assert.equal(readFileSync(join(userRoot,'keys.env'),'utf8'),keysBefore);
 const live=spawnSync(process.execPath,[join(process.cwd(),'scripts','doctor.mjs'),'--live'],{encoding:'utf8',timeout:5000});
 assert.equal(live.status,2,'An unsupported live option cannot silently initiate authentication');
 assert.match(live.stderr,/offline doctor/);
});

test('speech dependencies stay visible and missing configured Ollama endpoint is not called ready',async()=>{
 writeFileSync(join(userRoot,'config.json'),JSON.stringify({brain:'ollama',ollama:{host:''},voice:{sttProvider:'whisper',whisperBin:join(appRoot,'missing-whisper'),sttModel:'missing-model.bin'}}));
 const report=await doctor.collectDoctorReport(appRoot,{lcuRoot});
 assert.equal(check(report,'voice.whisper').status,'missing');
 assert.equal(check(report,'voice.whisper-model').status,'missing');
 assert.equal(check(report,'provider.ollama.endpoint').status,'missing');
});

test('non-object persisted JSON and unknown selected brains are explicit blockers, not successful defaults',async()=>{
 for(const contents of ['null','[]',JSON.stringify({brain:'fake-sensitive-unknown-brain'})]){
  writeFileSync(join(userRoot,'config.json'),contents);
  const report=await doctor.collectDoctorReport(appRoot,{lcuRoot});
  assert.equal(report.selectedBrain,'unknown');
  assert.equal(check(report,'config').status,'blocked');
  assert.equal(doctor.doctorExitCode(report),1);
  assert.ok(!JSON.stringify(report).includes('fake-sensitive-unknown-brain'));
 }
});
