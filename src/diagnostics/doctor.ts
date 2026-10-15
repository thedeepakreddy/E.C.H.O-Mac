import {existsSync,statSync,accessSync,constants,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {loadConfig,DEFAULTS_FOR_TESTS} from '../config.js';
import {applyKeys} from '../keystore.js';
import {loadEnv} from '../env.js';
import {dataRoot} from '../memory/paths.js';
import {resolveOpenAIAuth} from '../brain/openai-auth.js';
import {chatgpt} from '../brain/chatgpt-auth.js';

export interface DoctorCheck {
 id:string;label:string;status:'ok'|'missing'|'blocked'|'unverified';detail:string;required:boolean;
}
export interface DoctorReport {selectedBrain:string;configSource:'user'|'app'|'example'|'defaults';checks:DoctorCheck[]}
export interface DoctorOptions {lcuRoot?:string}
const PROVIDERS=['claude','gemini','openai','openrouter','nvidia','ollama'] as const;
const present=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
// Same reviewed client pin enforced by tools/lcu-runtime.ts. Never import/start it here.
const REVIEWED_CLIENT_SHA256='ca17e00b20939c779c75821e217891b3a2c3a7c9173eacf5807b685f975a1479';
function executable(file:unknown):boolean{try{return present(file)&&statSync(file).isFile()&&(accessSync(file,constants.X_OK),true);}catch{return false;}}
function endpointStatus(value:unknown):DoctorCheck['status']{
 if(!present(value))return 'missing';
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password?'ok':'blocked';}catch{return 'blocked';}
}
/** Shared readers can log parse snippets. A doctor may report failure, never those snippets. */
function privateRead<T>(read:()=>T):{value?:T;failed:boolean}{
 const original=console.error;let failed=false;
 console.error=()=>{failed=true;};
 try{return {value:read(),failed};}catch{return {failed:true};}finally{console.error=original;}
}

/** Read-only offline snapshot. Never constructs a brain, refreshes auth or operates a device. */
export async function collectDoctorReport(appRoot:string,options:DoctorOptions={}):Promise<DoctorReport>{
 const envRead=privateRead(()=>{applyKeys();loadEnv(appRoot);});
 const configSource=existsSync(join(dataRoot(),'config.json'))?'user':existsSync(join(appRoot,'config.json'))?'app':existsSync(join(appRoot,'config.example.json'))?'example':'defaults';
 // Validation only: selection, merge, defaults and path expansion still come from loadConfig.
 const configFile=configSource==='user'?join(dataRoot(),'config.json'):configSource==='app'?join(appRoot,'config.json'):configSource==='example'?join(appRoot,'config.example.json'):undefined;
 const shape=privateRead(()=>{if(!configFile)return true;const value=JSON.parse(readFileSync(configFile,'utf8'));return value!==null&&typeof value==='object'&&!Array.isArray(value);});
 const configRead=privateRead(()=>loadConfig(appRoot)),cfg=configRead.value??structuredClone(DEFAULTS_FOR_TESTS);
 const selectedBrain=shape.value===true&&!configRead.failed&&PROVIDERS.includes(cfg.brain)?cfg.brain:'unknown';
 const checks:DoctorCheck[]=[];
 checks.push({id:'config',label:'Authoritative configuration',status:selectedBrain==='unknown'?'blocked':'ok',detail:selectedBrain==='unknown'?'Selected configuration is invalid or unreadable; no provider fallback is declared ready.':'Loaded using the app’s persisted user-data-root precedence.',required:true});
 checks.push({id:'environment',label:'Credential environment resolution',status:envRead.failed?'blocked':'ok',detail:envRead.failed?'Credential environment could not be read. Raw errors and values are withheld.':'Real environment wins; saved keystore then bundle .env fill gaps, in the app’s order.',required:true});
 for(const provider of PROVIDERS){
  const settings=cfg[provider],required=selectedBrain===provider;
  const add=(name:string,status:DoctorCheck['status'],detail:string)=>checks.push({id:`provider.${provider}.${name}`,label:`${provider} ${name}`,status,detail,required});
  const openAIRead=provider==='openai'?privateRead(()=>({auth:resolveOpenAIAuth(cfg),session:chatgpt.session()})):undefined;
  const plan=provider==='openai'&&(cfg.openai?.auth==='chatgpt'||openAIRead?.value?.auth?.via==='chatgpt');
  const model=plan?cfg.openai?.chatgptModel:settings?.model;
  add('model',present(model)?'ok':plan?'unverified':'missing',present(model)?'Model identifier configured; availability not probed.':plan?'The app selects the first model offered by the ChatGPT plan; model discovery was not performed.':'No model identifier is configured.');
  let status:DoctorCheck['status']='unverified',detail='Claude SDK subscription/login state is not probed; no authentication request was made.';
  if(provider==='ollama'){status='ok';detail='The Ollama adapter does not require an API credential; host and installed model are not probed.';}
  else if(provider==='openai'){
   const auth=openAIRead?.value?.auth,session=openAIRead?.value?.session;
   status=auth||session?.error||openAIRead?.failed?'unverified':'missing';
   detail=auth?.via==='chatgpt'?'Saved ChatGPT plan permission is available; token freshness, authentication and model access are unverified.':
    auth?.via==='apiKey'?'API credential configured; authentication is unverified.':session?.error||openAIRead?.failed?'Saved ChatGPT sign-in is unreadable in this host. Open Echo to verify it; no refresh or sign-in was attempted.':
    cfg.openai?.auth==='chatgpt'?'The selected ChatGPT sign-in is unavailable to this host; an API key cannot replace this mode.':'No credential is available under the configured OpenAI auth mode.';
  }else if(provider!=='claude'){
   const keyEnv=settings&&typeof settings==='object'&&'apiKeyEnv' in settings?settings.apiKeyEnv:undefined;
   status=present(keyEnv)&&present(process.env[keyEnv])?'unverified':'missing';
   detail=status==='missing'?'No API credential is available under the configured environment key.':'API credential configured; authentication is unverified.';
  }else if(present(process.env.ANTHROPIC_API_KEY)){detail='Claude API credential configured; SDK authentication is unverified.';}
  add('authentication',status,detail);
  if(provider==='ollama'||provider==='openrouter'||provider==='nvidia'){
   const endpoint=provider==='ollama'?cfg.ollama?.host:cfg[provider]?.baseUrl;
   const status=endpointStatus(endpoint);
   add('endpoint',status,status==='ok'?'Endpoint address configured; no connection or request was made.':'Configured service endpoint is missing or malformed; no connection was attempted.');
  }
  if(provider==='claude'||provider==='gemini'){
   let found=false;try{createRequire(join(appRoot,'package.json')).resolve(provider==='claude'?'@anthropic-ai/claude-agent-sdk':'@google/genai');found=true;}catch{/* no import or provider subprocess */}
   add('module',found?'ok':'missing',found?'Provider SDK resolves from this app root; it was not imported or queried.':'Provider SDK cannot be resolved from this app root; availability in another host is not certified.');
  }
  add('runtime','unverified','Provider service and model access were not contacted or verified (offline check).');
 }
 const add=(id:string,label:string,status:DoctorCheck['status'],detail:string,required=true)=>checks.push({id,label,status,detail,required});
 const lcuRoot=options.lcuRoot??join(homedir(),'.local','share','echo-lcu','current');
 const binary=executable(join(lcuRoot,'bin','lcu'));
 add('lcu.binary','LCU binary',binary?'ok':'missing',binary?'Executable file present only; version, launch and architecture are not verified.':'LCU executable is absent or not executable in Echo’s runtime prefix.');
 const clientFile=join(lcuRoot,'adapters','client.mjs');
 let clientStatus:DoctorCheck['status']='missing';
 try{clientStatus=createHash('sha256').update(readFileSync(clientFile)).digest('hex')===REVIEWED_CLIENT_SHA256?'ok':'blocked';}catch{/* report unavailable without filesystem/error details */}
 add('lcu.client','LCU shared client module',clientStatus,clientStatus==='ok'?'Client checksum matches Echo’s reviewed release; module import and handshake were not attempted.':clientStatus==='blocked'?'Client checksum differs from the pin enforced by Echo; runtime would refuse this module.':'Reviewed LCU client module is absent or unreadable.');
 const pointer=executable(join(appRoot,'native','echo-pointer'));
 add('lcu.pointer','Echo pointer helper',pointer?'ok':'missing',pointer?'Executable file present only; no position read, movement or input was attempted.':'The Echo pointer helper is absent or not executable.');
 add('lcu.connection','LCU connection','unverified','No LCU process or module was started. Runtime connection and helper compatibility remain unverified.');
 for(const [id,label] of [['accessibility','Accessibility'],['screen','Screen Recording'],['microphone','Microphone'],['camera','Camera']] as const){
  add(`permission.${id}`,`${label} permission`,'unverified','No native permission probe or prompt was run. Permissions are host-specific; a CLI report cannot certify the Echo/LCU host.',id!=='camera');
 }
 add('permission.lcu-app-approval','LCU native-app approval','unverified','Per-app runtime approval is not known offline. Existing LCU and macOS permission gates must still approve each target.');
 const whisperRequired=!cfg.voice?.sttProvider||cfg.voice.sttProvider==='whisper';
 const whisper=executable(cfg.voice?.whisperBin);
 add('voice.whisper','Whisper executable',whisper?'ok':'missing',whisper?'Executable file present; transcription was not attempted.':'Configured Whisper executable is missing or not executable.',whisperRequired);
 let modelStatus:DoctorCheck['status']='missing';
 try{const file=cfg.voice?.sttModel;if(present(file)){const info=statSync(file);if(info.isFile())modelStatus=info.size>=20_000_000?'ok':'blocked';}}catch{/* metadata only */}
 add('voice.whisper-model','Whisper model',modelStatus,modelStatus==='ok'?'Model file has a plausible size; contents and inference were not verified.':modelStatus==='blocked'?'Configured model file looks truncated.':'Configured Whisper model file is missing or unreadable.',whisperRequired);
 add('voice.say','macOS speech executable',executable('/usr/bin/say')?'ok':'missing','File presence only; no speech was played.',cfg.voice?.ttsEnabled===true&&(!cfg.voice.ttsEngine||cfg.voice.ttsEngine==='mac'));
 add('vision.screencapture','macOS screen-capture executable',executable('/usr/sbin/screencapture')?'ok':'missing','File presence only; no screenshot or permission prompt was attempted.',false);
 return {selectedBrain,configSource,checks};
}
export function doctorExitCode(report:DoctorReport):0|1{return report.checks.some(c=>c.required&&['missing','blocked'].includes(c.status))?1:0;}
export function formatDoctorReport(report:DoctorReport):string{
 return [`Echo — offline system check`,`Selected brain: ${report.selectedBrain}; configuration: ${report.configSource}`,
  ...report.checks.map(c=>`${c.status.toUpperCase().padEnd(10)} ${c.label}${c.required?'':' (not selected/optional)'}: ${c.detail}`),
  doctorExitCode(report)?'Detected blockers; review the required checks.':'No offline blockers detected. Runtime readiness remains unverified.',
 ].join('\n');
}
