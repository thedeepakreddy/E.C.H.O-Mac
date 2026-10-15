import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {Tts} from './voice/tts.js';
import {SpeechStream} from './voice/speech-stream.js';
import {DEFAULTS_FOR_TESTS} from './config.js';
import type {AudioPlayer} from './voice/player.js';
import type {TtsStream} from './voice/tts-stream.js';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
class FakeProcess extends EventEmitter {killed=false;kill(){this.killed=true;return true;}}
function queueFixture(enabled=true){
 const children:FakeProcess[]=[],states:boolean[]=[],starts:string[]=[];
 const tts=new Tts('fixture',enabled,'mac',undefined,on=>states.push(on),{},undefined,
  {spawn:()=>{const child=new FakeProcess();children.push(child);return child;}});
 assert.equal(typeof tts.speakWithAcknowledgment,'function','Add the real TTS acknowledgment API before running any legacy say path');
 tts.onAudioStart(text=>starts.push(text));return {tts,children,states,starts};
}
class FakePlayer extends EventEmitter implements AudioPlayer {
 readonly name='fixture';readonly aec=false;readonly frameSource=null;
 readonly supportsPlaybackAcknowledgment=true;
 playing=false;playedMs=0;audioMs=0;stopCount=0;playCount=0;
 async start(){}dispose(){}
 play(pcm:Buffer,rate:number){
  this.playCount++;
  this.audioMs+=pcm.length/2/rate*1000;
  if(!this.playing){this.playing=true;this.playedMs=0;this.emit('started');}
 }
 endSentence(){}
 stop(){this.stopCount++;this.playing=false;this.audioMs=0;this.playedMs=0;this.emit('stopped');}
 finish(){this.playedMs=this.audioMs;this.playing=false;this.emit('drained');}
}
class FakeVoice extends EventEmitter implements TtsStream {
 readonly name='mac-say-pcm';readonly sampleRate=24000;
 requested:Array<{text:string;index:number}>=[];
 async open(){}async close(){}abort(){}
 speak(text:string,index:number){this.requested.push({text,index});}
 audio(index=0){this.emit('audio',{pcm:Buffer.alloc(4800),sampleRate:this.sampleRate,sentence:index});}
 done(index=0){this.emit('sentenceDone',index);}
}
function streamFixture(maxSentences=0){
 const player=new FakePlayer(),voices:FakeVoice[]=[];
 const make=()=>{const voice=new FakeVoice();voices.push(voice);return voice;};
 const stream=new SpeechStream(structuredClone(DEFAULTS_FOR_TESTS),player,
  {maxSentences:()=>maxSentences,createTts:make,createOfflineTts:make});
 const f=queueFixture();f.tts.attachStream(stream);
 return {...f,stream,player,voices};
}

await test('file playback ACK is pending until successful player exit; callbacks remain intact',async()=>{
 const f=queueFixture();let settled=false;
 const ack=f.tts.speakWithAcknowledgment('The report is ready.').then(value=>{settled=true;return value;});await tick();
 assert.equal(settled,false);assert.equal(f.tts.isSpeaking(),true);assert.equal(f.children.length,1);
 f.children[0].emit('exit',0,null);assert.equal((await ack).status,'completed');await tick();
 assert.deepEqual(f.states,[true,false]);assert.equal(f.starts.length,1);
});

await test('disabled/empty output and playback failure never report completed',async()=>{
 assert.equal((await queueFixture(false).tts.speakWithAcknowledgment('Report.')).status,'failed');
 assert.equal((await queueFixture().tts.speakWithAcknowledgment('')).status,'failed');
 for(const event of ['error','exit'] as const){
  const f=queueFixture(),ack=f.tts.speakWithAcknowledgment('Report.');await tick();
  if(event==='error')f.children[0].emit(event,Error('fake playback failure'));else f.children[0].emit(event,1,null);
  assert.equal((await ack).status,'failed');f.tts.stop();
 }
});

await test('busy acknowledgment is rejected without queueing or interrupting speech',async()=>{
 const f=queueFixture(),first=f.tts.speakWithAcknowledgment('First.');
 assert.equal((await f.tts.speakWithAcknowledgment('Second.')).status,'failed');
 assert.equal(f.children.length,1);assert.equal(f.children[0].killed,false);
 f.children[0].emit('exit',0,null);assert.equal((await first).status,'completed');
});

await test('Stop/abort/new legacy speech fence stale process exits and release reservations',async()=>{
 for(const how of ['stop','abort','say'] as const){
  const f=queueFixture(),signal=new AbortController(),old=f.tts.speakWithAcknowledgment('Old.',{signal:signal.signal});
  await tick();const child=f.children[0];
  if(how==='stop')f.tts.stop();else if(how==='abort')signal.abort();else f.tts.say('Foreground.');
  assert.equal((await old).status,'interrupted');assert.equal(child.killed,true);
  child.emit('exit',0,null);await tick();
  if(how==='say'){assert.equal(f.tts.isSpeaking(),true);f.children[1].emit('exit',0,null);await tick();}
  const next=f.tts.speakWithAcknowledgment('Next.');await tick();
  child.emit('exit',0,null);assert.equal(f.tts.isSpeaking(),true,'Old completion cannot release new speech');
  f.children.at(-1)!.emit('exit',0,null);assert.equal((await next).status,'completed');
 }
});

await test('pre-aborted signal does not spawn or steal an idle slot',async()=>{
 const f=queueFixture(),signal=new AbortController();signal.abort();
 assert.equal((await f.tts.speakWithAcknowledgment('Report.',{signal:signal.signal})).status,'interrupted');
 assert.equal(f.children.length,0);assert.equal(f.tts.isSpeaking(),false);
});

await test('ACK invokes local TTS directly, never monkeypatched remote say routing',async()=>{
 const f=queueFixture();let remoteCalls=0;f.tts.say=()=>{remoteCalls++;};
 const ack=f.tts.speakWithAcknowledgment('Local report.');await tick();f.children[0].emit('exit',0,null);
 assert.equal((await ack).status,'completed');assert.equal(remoteCalls,0);
});

await test('stream ACK waits for every sentence and actual player drain, not synthesis done',async()=>{
 const f=streamFixture();let settled=false;
 const ack=f.tts.speakWithAcknowledgment('First sentence. Second sentence.').then(value=>{settled=true;return value;});await tick();
 const voice=f.voices[0];assert.equal(voice.requested.length,2);
 voice.audio(0);voice.done(0);voice.audio(1);voice.done(1);await tick();
 assert.equal(settled,false);assert.equal(f.children.length,0,'Attached stream is used, not file playback');
 f.player.finish();assert.equal((await ack).status,'completed');f.tts.stop();
});

await test('idle report starts a fresh sentence budget after a capped foreground turn',async()=>{
 const f=streamFixture(1);
 f.tts.say('Foreground sentence. Overflow sentence.');await tick();
 const voice=f.voices[0];assert.equal(voice.requested.length,2);
 assert.equal(voice.requested[1].text,'The rest is on screen.');
 for(const {index} of voice.requested){voice.audio(index);voice.done(index);}
 f.player.finish();assert.equal(f.tts.isSpeaking(),false);
 const ack=f.tts.speakWithAcknowledgment('Fresh report.');await tick();
 const reportVoice=f.voices.at(-1)!;
 assert.equal(reportVoice.requested.at(-1)?.text,'Fresh report.','Fresh report must not inherit foreground cap');
 const report=reportVoice.requested.at(-1)!;
 reportVoice.audio(report.index);reportVoice.done(report.index);f.player.finish();
 assert.equal((await ack).status,'completed');f.tts.stop();
});

await test('completed report synthesis callbacks cannot complete the next reservation',async()=>{
 const f=streamFixture(),first=f.tts.speakWithAcknowledgment('First report.');await tick();
 const oldVoice=f.voices[0];oldVoice.audio();oldVoice.done();f.player.finish();
 assert.equal((await first).status,'completed');
 let settled=false;
 const next=f.tts.speakWithAcknowledgment('Next report.').then(result=>{settled=true;return result;});await tick();
 oldVoice.audio();oldVoice.done();f.player.finish();await tick();
 assert.equal(settled,false,'Old generation must not supply the new report audio or completion');
 const voice=f.voices.at(-1)!;voice.audio();voice.done();f.player.finish();
 assert.equal((await next).status,'completed');f.tts.stop();
});

await test('adapter without truthful completion capability cannot acknowledge delivery',async()=>{
 const f=streamFixture();Object.defineProperty(f.player,'supportsPlaybackAcknowledgment',{value:false});
 const ack=f.tts.speakWithAcknowledgment('Report.');await tick();
 if(f.voices[0]){f.voices[0].audio();f.voices[0].done();f.player.finish();}
 assert.equal((await ack).status,'failed');
 assert.equal(f.voices.length,0,'Do not start unacknowledgeable report audio');
 f.tts.stop();
});

await test('silent stream and partial voice/player failure cannot win as completed',async()=>{
 for(const how of ['silent','voice-error','player-error'] as const){
  const f=streamFixture(),ack=f.tts.speakWithAcknowledgment('A complete report.');await tick();
  if(how!=='silent')f.voices[0].audio();
  if(how==='voice-error')f.voices[0].emit('error','fake partial synthesis failure');
  else if(how==='player-error')f.player.emit('error','fake device failure');
  else f.voices[0].done();
  assert.equal((await ack).status,'failed');f.tts.stop();
 }
});

await test('failed reserved report stops partial playback and discards late synthesis without failover',async()=>{
 for(const how of ['voice-error','closed','player-error'] as const){
  const f=streamFixture(),ack=f.tts.speakWithAcknowledgment('Partial report. Remaining report.');await tick();
  const old=f.voices[0];old.audio(0);
  if(how==='voice-error')old.emit('error','fake reserved voice failure');
  else if(how==='closed')old.emit('closed');
  else f.player.emit('error','fake reserved device failure');
  assert.equal((await ack).status,'failed');assert.equal(f.player.playing,false,'Sound must stop before failed ACK resolves');
  const played=f.player.playCount;old.audio(0);old.done(0);old.audio(1);old.done(1);await tick();
  assert.equal(f.player.playCount,played,'Failed report cannot feed later audio');
  assert.equal(f.voices.length,1,'Reserved reports cannot fail over after releasing ownership');f.tts.stop();
 }
});

await test('failed report cap cannot enqueue the legacy truncation utterance',async()=>{
 const f=streamFixture(1),ack=f.tts.speakWithAcknowledgment('One report. Two report.');
 assert.equal((await ack).status,'failed');await tick();
 assert.equal(f.player.playCount,0);assert.equal(f.tts.isSpeaking(),false);
 assert.ok(f.voices.every(voice=>voice.requested.length===0));f.tts.stop();
});

await test('failure cleanup and stale callbacks cannot stop reentrant newer foreground output',async()=>{
 const f=streamFixture(),ack=f.tts.speakWithAcknowledgment('Old report.');await tick();
 const old=f.voices[0];old.audio();
 f.stream.once('speaking',on=>{if(!on)f.stream.feed('New foreground sentence. ');});
 old.emit('error','fake report failure');assert.equal((await ack).status,'failed');await tick();
 const voice=f.voices.at(-1)!;assert.equal(voice.requested.at(-1)?.text,'New foreground sentence.');
 voice.audio();const stops=f.player.stopCount,played=f.player.playCount;
 old.audio();old.done();old.emit('error','stale old failure');await tick();
 assert.equal(f.player.stopCount,stops);assert.equal(f.player.playCount,played);assert.equal(f.tts.isSpeaking(),true);
 voice.done();f.player.finish();assert.equal(f.tts.isSpeaking(),false);f.tts.stop();
});

await test('legacy unreserved voice failure still falls back and finishes its remaining text',async()=>{
 const f=streamFixture();f.tts.say('First foreground. Remaining foreground.');await tick();
 f.voices[0].audio(0);f.voices[0].emit('error','fake legacy voice failure');await tick();
 assert.equal(f.voices.length,2);assert.equal(f.voices[1].requested[0]?.text,'Remaining foreground.');
 f.voices[1].audio(1);f.voices[1].done(1);f.player.finish();assert.equal(f.tts.isSpeaking(),false);f.tts.stop();
});

await test('direct foreground stream feed supersedes report; old generation cannot acknowledge next report',async()=>{
 const f=streamFixture(),old=f.tts.speakWithAcknowledgment('Old report.');await tick();const oldVoice=f.voices[0];
 f.stream.feed('Foreground sentence. ');assert.equal((await old).status,'interrupted');await tick();
 oldVoice.audio();oldVoice.done();assert.equal(f.tts.isSpeaking(),true);
 f.tts.stop();const next=f.tts.speakWithAcknowledgment('Next report.');await tick();
 oldVoice.audio();oldVoice.done();f.player.emit('drained');
 assert.equal(f.tts.isSpeaking(),true,'Stale drain without new audio cannot complete a new delivery');
 const voice=f.voices.at(-1)!;voice.audio();voice.done();f.player.finish();
 assert.equal((await next).status,'completed');f.tts.stop();
});

await test('stream busy/pending live-text rejection preserves foreground output',async()=>{
 const f=streamFixture();f.stream.feed('Pending foreground fragment');
 assert.equal((await f.tts.speakWithAcknowledgment('Report.')).status,'failed');
 assert.equal(f.player.stopCount,0);f.tts.stop();
});

await test('stream cap, player Stop and disabling TTS never acknowledge a full delivery',async()=>{
 const capped=streamFixture(1),capAck=capped.tts.speakWithAcknowledgment('One sentence. Two sentences.');await tick();
 assert.equal((await capAck).status,'failed');capped.tts.stop();
 const f=streamFixture(),ack=f.tts.speakWithAcknowledgment('Report.');await tick();f.player.stop();
 assert.equal((await ack).status,'interrupted');f.tts.stop();
 const muted=queueFixture(),muteAck=muted.tts.speakWithAcknowledgment('Report.');muted.tts.setEnabled(false);
 assert.equal((await muteAck).status,'interrupted');
});
