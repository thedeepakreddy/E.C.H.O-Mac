import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {SpeechClock, type SpeechClockOptions} from './voice/speech-clock.js';
const source=readFileSync('src/main.ts','utf8'),ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
const names=['ensureRealtime','dispatchToRealtime'];
const stop=ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='stopRealtimeVoice');
const functions=names.map(name=>ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name));assert(functions.every(Boolean));
const clockDeclaration=ast.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(ast)==='realtimeClock'));assert(clockDeclaration);
const code=ts.transpile([...functions,...(stop?[stop]:[]),clockDeclaration].map(s=>s!.getText(ast)).join('\n'));
function fixture(){
 let release:()=>void=()=>{},hold=false,rejectConnect=false,played=0,done=0,stopped=0,paused=false;const sessions:Fake[]=[],outcomes:string[]=[];
 class Fake extends EventEmitter {active=true;conversationId='fixture';closed=false;pushed=0;
  constructor(..._args:unknown[]){super();sessions.push(this);}syncContext(){}
  async connect(){if(hold)await new Promise<void>(resolve=>release=resolve);if(rejectConnect)throw new Error('fixture connect rejected');}
  push(){this.pushed++;}endOfSpeech(){}close(){this.closed=true;this.active=false;}}
 // Use production pending/drain semantics, but no wall-clock timers or audio.
 class TestClock extends SpeechClock {constructor(opts:SpeechClockOptions,onEnd:()=>void){super({...opts,setTimer:()=>1,clearTimer:()=>{},now:()=>100},onEnd);}}
 const context=vm.createContext({RealtimeVoiceSession:Fake,realtime:null,realtimeTurn:null,realtimeSaid:'',lastAssistantText:'',
  inputRevision:0,realtimeConnectSequence:0,realtimeConnectionTurnId:undefined,shuttingDown:false,cfg:{gemini:{apiKeyEnv:'FIXTURE'},control:{workingDir:'/fixture'}},process:{env:{FIXTURE:'inert'}},
  conversationId:()=> 'fixture',currentScope:()=>({}),buildSystemPrompt:()=>'',REALTIME_VOICE_GUIDANCE:'',
  send(){},finishTurn(outcome:string){outcomes.push(outcome);},beginLearnedTurn(){},needsTaskDispatch:()=>false,readWavPcm:()=>Buffer.alloc(3200),Buffer,
  REALTIME_OUTPUT_RATE:24000,Int16Array,setStatus(){},listener:{setPaused(value:boolean){paused=value;}},performance:{now:()=>0},echoSpokeUntil:0,lastBrainStatus:'idle',maybeAutoListen(){},
  voiceSession:{generation:0,brainTurnId:null,brainTurnActive:false,brainOutputIsLive:()=>true,isCurrent:()=>true,
   noteBrainSend(turn:{id:string}){this.brainTurnId=turn.id as any;this.brainTurnActive=true;},noteBrainDone(){done++;this.brainTurnActive=false;},noteSpeaking(){}},
  SpeechClock:TestClock,
  player:Object.assign(new EventEmitter(),{play(){played++;},stop(){stopped++;}}),console});vm.runInContext(code,context);
 return {context,sessions,outcomes,hold:()=>{hold=true;},reject:()=>{rejectConnect=true;},release:()=>release(),played:()=>played,done:()=>done,stopped:()=>stopped,paused:()=>paused,clock:()=>vm.runInContext('realtimeClock',context) as SpeechClock};
}
const turn=(id:string)=>({id,generation:0,cancelled:false,abort:new AbortController()});
const f=fixture();assert.equal(await f.context.dispatchToRealtime('/fixture',turn('voice-1'),'Hello'),true);
f.sessions[0].emit('audio',Buffer.alloc(20));assert.equal(f.played(),1);
f.sessions[0].emit('turnComplete');assert.equal(f.done(),1,'Live turn completion releases the brain busy fence');
assert.equal(f.context.voiceSession.brainTurnActive,false);assert.equal(f.context.realtimeTurn.modelDone,true,'Playback retains ownership until speaker drain');
f.sessions[0].emit('audio',Buffer.alloc(20));assert.equal(f.played(),1,'Completed turn does not accept unsolicited late audio');
f.clock().noteDrained();assert.equal(f.context.realtimeTurn,null);
assert.equal(f.context.realtime,null,'A fully drained turn detaches its transport so it cannot request unsolicited tools');
assert.equal(f.sessions[0].closed,true);
assert.equal(typeof f.context.stopRealtimeVoice,'function');f.context.stopRealtimeVoice();assert.equal(f.sessions[0].closed,true);
f.sessions[0].emit('audio',Buffer.alloc(20));f.sessions[0].emit('turnComplete');assert.equal(f.played(),1);assert.equal(f.done(),1);
const connecting=fixture();connecting.hold();const pending=connecting.context.dispatchToRealtime('/fixture',turn('voice-2'),'Hello');await new Promise<void>(r=>setImmediate(r));connecting.context.inputRevision++;
connecting.release();await pending;assert.equal(connecting.context.realtime,null,'Stop during connect cannot resurrect voice transport');assert.equal(connecting.sessions[0].closed,true);assert.equal(connecting.sessions[0].pushed,0);
const active=fixture();await active.context.dispatchToRealtime('/fixture',turn('first'),'Hello');active.context.stopRealtimeVoice();assert.equal(active.context.voiceSession.brainTurnActive,false,'Stop releases only the owned realtime brain turn');await active.context.dispatchToRealtime('/fixture',turn('next'),'Hello');assert.equal(active.sessions.length,2);active.sessions[0].emit('audio',Buffer.alloc(20));active.sessions[0].emit('turnComplete');assert.equal(active.played(),0);assert.equal(active.context.voiceSession.brainTurnActive,true,'Old session cannot settle a successor');active.sessions[1].emit('turnComplete');assert.equal(active.context.realtimeTurn,null);
console.log('PASS real host Live completion, Stop, delayed-connect and late-audio fences; no sound or provider');

const rejected=fixture();rejected.hold();rejected.reject();
const canceledConnect=rejected.context.dispatchToRealtime('/fixture',turn('canceled-connect'),'Hello');
await new Promise<void>(r=>setImmediate(r));rejected.context.inputRevision++;rejected.context.stopRealtimeVoice();rejected.release();
assert.equal(await canceledConnect,true,'Canceled failed connection must not restart the text fallback');
assert.equal(rejected.sessions[0].closed,true,'Rejected connection candidate is closed');
const failed=fixture();failed.reject();assert.equal(await failed.context.dispatchToRealtime('/fixture',turn('failed-connect'),'Hello'),false,'Uncancelled connection failure still permits fallback');assert.equal(failed.sessions[0].closed,true);

const interrupted=fixture();await interrupted.context.dispatchToRealtime('/fixture',turn('interrupted'),'Hello');
interrupted.sessions[0].emit('audio',Buffer.alloc(20));assert.equal(interrupted.paused(),true);
interrupted.sessions[0].emit('interrupted');
assert.equal(interrupted.context.realtimeTurn,null,'Interruption releases realtime ownership before model completion');
assert.equal(interrupted.context.voiceSession.brainTurnActive,false);assert.equal(interrupted.paused(),false);
assert.equal(interrupted.clock().speaking,false);assert.deepEqual(interrupted.outcomes,['rejected']);
interrupted.sessions[0].emit('turnComplete');assert.deepEqual(interrupted.outcomes,['rejected'],'Late completion cannot record interrupted turn as success');

const closed=fixture();await closed.context.dispatchToRealtime('/fixture',turn('completed'),'Hello');
closed.sessions[0].emit('turnComplete');assert.equal(closed.context.realtimeTurn,null);
const stopCount=closed.stopped();closed.context.player.play();closed.sessions[0].emit('closed');
assert.equal(closed.stopped(),stopCount,'Closing an idle transport cannot stop a later unrelated voice report');
const stoppedAudio=fixture();await stoppedAudio.context.dispatchToRealtime('/fixture',turn('stopped-audio'),'Hello');stoppedAudio.sessions[0].emit('audio',Buffer.alloc(20));
stoppedAudio.context.inputRevision++;stoppedAudio.context.voiceSession.generation++;stoppedAudio.context.stopRealtimeVoice();
assert.equal(stoppedAudio.paused(),false,'Stop releases owned capture even after cancellation advanced the generation');
const badAudio=fixture();badAudio.context.readWavPcm=()=>{throw Error('fixture unreadable capture');};
assert.equal(await badAudio.context.dispatchToRealtime('/fixture',turn('bad-audio'),'Hello'),false);
assert.equal(badAudio.context.realtime,null,'Failed audio preparation releases transport before text fallback');
assert.equal(badAudio.context.voiceSession.brainTurnActive,false);
console.log('PASS rejected-connect cancellation, production-clock interruption and idle-close ownership');
