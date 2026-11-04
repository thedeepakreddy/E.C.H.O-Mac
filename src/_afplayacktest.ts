import assert from 'node:assert/strict';
import {test, mock} from 'node:test';
import {EventEmitter} from 'node:events';
import {AfplayPlayer} from './voice/player.js';
import {SpeechStream} from './voice/speech-stream.js';
import {Tts} from './voice/tts.js';
import {DEFAULTS_FOR_TESTS} from './config.js';
import type {TtsStream} from './voice/tts-stream.js';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
class FakeProcess extends EventEmitter {killed=false;kill(){this.killed=true;return true;}}
function fixture(failure?:'spawn'|'write'){
 const children:FakeProcess[]=[],written:string[]=[],removed:string[]=[],drains:any[]=[],errors:unknown[]=[],exits:any[]=[];
 const player=new AfplayPlayer({
  spawn:(bin,args)=>{
   assert.equal(bin,'/usr/bin/afplay');assert.equal(args.length,1);
   if(failure==='spawn')throw Error('fake spawn failure');
   const child=new FakeProcess();children.push(child);return child;
  },
  writeFile:(path,wav)=>{
   if(failure==='write')throw Error('fake write failure');
   assert.equal(wav.subarray(0,4).toString(),'RIFF');written.push(path);
  },
  removeFile:path=>{removed.push(path);},
 });
 player.on('drained',result=>drains.push(result));player.on('error',error=>errors.push(error));
 player.on('exit',(...args)=>exits.push(args));
 const add=(index=0)=>{player.play(Buffer.alloc(4800),24000,index);player.endSentence(index);};
 return {player,children,written,removed,drains,errors,exits,add};
}
class FakeVoice extends EventEmitter implements TtsStream {
 readonly name='say';readonly sampleRate=24000;requested:Array<{text:string;index:number}>=[];
 async open(){}async close(){}abort(){}
 speak(text:string,index:number){this.requested.push({text,index});}
 complete(index=0){this.emit('audio',{pcm:Buffer.alloc(4800),sampleRate:24000,sentence:index});this.emit('sentenceDone',index);}
}
function integrated(){
 const f=fixture(),voices:FakeVoice[]=[];
 const stream=new SpeechStream(structuredClone(DEFAULTS_FOR_TESTS),f.player,{
  maxSentences:()=>0,createTts:()=>{const voice=new FakeVoice();voices.push(voice);return voice;},
 });
 const tts=new Tts('fixture',true,'mac',undefined,undefined,{},undefined,
  {spawn:()=>{throw Error('File TTS bypassed attached stream');}});
 tts.attachStream(stream);return {...f,voices,tts};
}

await test('Afplay advertises truthful playback acknowledgment capability',()=>{
 const f=fixture();assert.equal((f.player as any).supportsPlaybackAcknowledgment,true);f.player.stop();
});

await test('successful exit alone drains the current generation once',async()=>{
 const f=fixture();f.add();assert.equal(f.drains.length,0);assert.equal(f.player.playing,true);
 f.children[0].emit('exit',0,null);await tick();
 assert.equal(f.drains.length,1);assert.equal(f.drains[0]?.status,'completed');assert.equal(f.player.playing,false);
 f.children[0].emit('exit',1,null);await tick();assert.equal(f.drains.length,1);assert.equal(f.errors.length,0);
 assert.deepEqual(f.removed,f.written);
});

await test('nonzero exit, signal and process error never produce successful drain',async()=>{
 for(const how of ['exit','signal','error'] as const){
  const f=fixture();f.add();
  if(how==='error')f.children[0].emit('error',Error('fake device failure'));
  else f.children[0].emit('exit',how==='exit'?7:null,how==='signal'?'SIGTERM':null);
  await tick();assert.equal(f.errors.length,1);assert.equal(f.drains[0]?.status,'failed');
  if(how!=='error')assert.deepEqual(f.exits,[[how==='exit'?7:null,how==='signal'?'SIGTERM':null]]);
  f.children[0].emit('exit',0,null);await tick();assert.equal(f.drains.length,1);
 }
});

await test('two queued files require both successful exits before completion',async()=>{
 const f=fixture();f.add(0);f.add(1);
 f.children[0].emit('exit',0,null);await tick();assert.equal(f.children.length,2);assert.equal(f.drains.length,0);
 f.children[1].emit('exit',0,null);await tick();assert.equal(f.drains[0]?.status,'completed');
 assert.equal(f.removed.length,2);
});

await test('a failed first file cannot be certified by a successful later file',async()=>{
 const f=fixture();f.add(0);f.add(1);f.children[0].emit('exit',1,null);await tick();
 f.children[1].emit('exit',0,null);await tick();assert.equal(f.drains[0]?.status,'failed');
});

await test('Stop removes queued files and fences late old success from draining',async()=>{
 const f=fixture();f.add(0);f.add(1);f.player.stop();
 assert.equal(f.children[0].killed,true);assert.ok(f.removed.includes(f.written[1]));
 f.children[0].emit('exit',0,null);await tick();assert.equal(f.drains.length,0);assert.equal(f.player.playing,false);
 assert.equal(f.children.length,1);assert.deepEqual(new Set(f.removed),new Set(f.written));
});

await test('new playback waits for stopped child exit; old callbacks cannot release it',async()=>{
 const f=fixture();f.add();const old=f.children[0];f.player.stop();f.add();
 assert.equal(f.children.length,1,'Do not overlap a child whose Stop has not exited');
 old.emit('exit',0,null);await tick();assert.equal(f.children.length,2);assert.equal(f.drains.length,0);
 assert.equal(f.player.playing,true);old.emit('error',Error('stale'));old.emit('exit',0,null);await tick();
 assert.equal(f.drains.length,0);assert.equal(f.player.playing,true);assert.equal(f.errors.length,0);
 f.children[1].emit('exit',0,null);await tick();assert.equal(f.drains[0]?.status,'completed');
});

await test('same-millisecond reused sentence identity cannot share a temporary file',async()=>{
 const clock=mock.method(Date,'now',()=>123456);
 try{
  const f=fixture();f.add();f.player.stop();f.add();
  assert.notEqual(f.written[0],f.written[1]);
  f.children[0].emit('exit',0,null);await tick();f.children[1].emit('exit',0,null);await tick();
  assert.equal(new Set(f.removed).size,2);
 }finally{clock.mock.restore();}
});

await test('write and synchronous spawn failures settle as failed, without unhandled rejection',async()=>{
 for(const how of ['write','spawn'] as const){
  const f=fixture(how);assert.doesNotThrow(()=>f.add());await tick();
  assert.equal(f.errors.length,1);assert.equal(f.drains[0]?.status,'failed');assert.equal(f.player.playing,false);
  assert.deepEqual(f.removed,f.written);
 }
});

await test('real Afplay + SpeechStream + Tts report completes only after both code-zero exits',async()=>{
 const f=integrated();let settled=false;
 const ack=f.tts.speakWithAcknowledgment('First sentence. Second sentence.').then(result=>{settled=true;return result;});
 await tick();assert.equal(f.voices.length,1);assert.equal(settled,false);
 f.voices[0].complete(0);f.voices[0].complete(1);await tick();assert.equal(settled,false);
 f.children[0].emit('exit',0,null);await tick();assert.equal(settled,false);
 f.children[1].emit('exit',0,null);assert.equal((await ack).status,'completed');f.tts.stop();
});

await test('real Afplay report bad exit fails and Stop interrupts without stale callback victory',async()=>{
 for(const how of ['exit','stop'] as const){
  const f=integrated(),ack=f.tts.speakWithAcknowledgment('Report.');await tick();
  assert.equal(f.voices.length,1);f.voices[0].complete();
  if(how==='stop')f.tts.stop();else f.children[0].emit('exit',2,null);
  assert.equal((await ack).status,how==='stop'?'interrupted':'failed');
  f.children[0].emit('exit',0,null);await tick();f.tts.stop();
 }
});

await test('actual fallback Stop then new report fences the old process outcome',async()=>{
 const f=integrated(),oldAck=f.tts.speakWithAcknowledgment('Old report.');await tick();
 f.voices[0].complete();const old=f.children[0];f.tts.stop();
 assert.equal((await oldAck).status,'interrupted');
 let settled=false;
 const next=f.tts.speakWithAcknowledgment('New report.').then(result=>{settled=true;return result;});
 await tick();f.voices.at(-1)!.complete();assert.equal(f.children.length,1);
 old.emit('exit',null,'SIGTERM');await tick();assert.equal(f.children.length,2);assert.equal(settled,false);
 old.emit('error',Error('stale old failure'));old.emit('exit',0,null);await tick();
 assert.equal(settled,false);assert.equal(f.tts.isSpeaking(),true);
 f.children[1].emit('exit',0,null);assert.equal((await next).status,'completed');f.tts.stop();
});

await test('failed reserved fallback report cancels queued files and ignores all remaining voice audio',async()=>{
 const f=integrated(),ack=f.tts.speakWithAcknowledgment('First report. Queued report. Late report.');await tick();
 const voice=f.voices[0];voice.complete(0);voice.complete(1);
 assert.equal(f.children.length,1);assert.equal(f.written.length,2);
 f.children[0].emit('exit',2,null);assert.equal((await ack).status,'failed');
 assert.equal(f.children.length,1,'No queued report file may start after failed ACK');
 assert.ok(f.removed.includes(f.written[1]));const written=f.written.length;
 voice.complete(2);f.children[0].emit('exit',0,null);await tick();
 assert.equal(f.written.length,written);assert.equal(f.children.length,1);assert.equal(f.player.playing,false);f.tts.stop();
});
