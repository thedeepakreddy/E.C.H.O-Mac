import assert from 'node:assert/strict';
import {EchoLcuSession} from './tools/lcu-session.js';
import {stableWindowChromeTarget} from './tools/native-observation.js';
const calls:any[]=[],ends:any[]=[];let failure=false,cleanupFailure=false,delivered=false;
const client={instructions:'Original runtime guidance',publicTools:()=>[{name:'js'},{name:'js_reset'}],connect:async()=>{},call:async(name:string,args:any,meta:any)=>{assert.ok(delivered,'Original surface is delivered before any call');calls.push({name,args,meta});return {content:[{type:'text',text:'Observed Calculator state'}],isError:failure&&args.code.includes('typeText')};},turnEnded:async(meta:any)=>{ends.push(meta);if(cleanupFailure)throw Error('Cleanup incomplete');},close:async()=>{}};
const owner={sessionId:'actual-echo-session',turnId:'actual-echo-turn',actorId:'echo',background:false};
const s=new EchoLcuSession(client,owner,async surface=>{assert.equal(surface.instructions,client.instructions);assert.deepEqual(surface.tools,client.publicTools());delivered=true;});
await s.execute('com.apple.calculator',{kind:'inspect'});
assert.equal(calls[0].args.code,'var echoLcuApp = await cua.getApp("com.apple.calculator");');
assert.equal(calls[0].meta.turnId,owner.turnId);assert.equal(calls[0].meta.sessionId,owner.sessionId);
await s.execute('com.apple.calculator',{kind:'press',key:'2'});assert.match(calls.at(-1).args.code,/pressKey\("2"\)/);
const before=calls.length;await assert.rejects(s.execute('com.apple.calculator',{kind:'move',to:[10,20]}),/unsupported/i);assert.equal(calls.length,before,'Missing pointer extension never becomes fake drags or clicks');
await assert.rejects(s.execute('com.electron.electron',{kind:'inspect'}),/host|protected/i);assert.equal(calls.length,before);
await assert.rejects(s.execute('com.apple.calculator',{kind:'type',text:'x'} as any,{...owner,background:true}),/background/i);
await assert.rejects(s.execute('com.apple.calculator',{kind:'type',text:'x'} as any,{...owner,turnId:'another-turn'}),/owner|turn/i);
failure=true;await assert.rejects(s.execute('com.apple.calculator',{kind:'type',text:'3'}),/runtime/i);failure=false;
assert.equal(calls.filter(c=>c.args.code.includes('typeText')).length,1,'A failed write is not replayed');
cleanupFailure=true;await assert.rejects(s.end('Interrupt'),/Cleanup incomplete/);await assert.rejects(s.execute('com.apple.calculator',{kind:'press',key:'Return'}),/cleanup|closed/i);
cleanupFailure=false;await s.end('Interrupt');assert.equal(ends.at(-1).turnId,owner.turnId);
await assert.rejects(s.execute('com.apple.calculator',{kind:'inspect'}),/closed/i);
console.log('PASS original guidance and result forwarding, exact ownership, background/host denial, unsupported movement, no write replay and cleanup fencing');

const originalBinding={content:[{type:'text',text:'Original app instructions'},{type:'image',data:'fixture-image',mimeType:'image/png'}],_meta:{binding:'unchanged'}};
let pointerCalls=0;const abort=new AbortController();
const pointerClient={...client,call:async()=>originalBinding};
const pointerSession=new EchoLcuSession(pointerClient,{...owner,signal:abort.signal},async()=>{},async(app,point,signal)=>{assert.equal(app,'com.apple.calculator');assert.deepEqual(point,[42,80]);assert.equal(signal?.aborted,false);pointerCalls++;return {content:[{type:'text',text:'Pointer read-back: 42,80'}]};});
const binding=await pointerSession.execute('com.apple.calculator',{kind:'inspect'});
assert.ok(binding.content.some(c=>c.type==='image'&&c.data==='fixture-image'),'Initial app image and instructions reach the caller');
assert.equal(binding._meta,originalBinding._meta,'Original binding metadata is retained');
await pointerSession.execute('com.apple.calculator',{kind:'move',to:[42,80]});assert.equal(pointerCalls,1);
abort.abort();await assert.rejects(pointerSession.execute('com.apple.calculator',{kind:'move',to:[42,80]}),/cancel|abort/i);assert.equal(pointerCalls,1,'Cancelled cursor moves never reach the native extension');
await pointerSession.end('Interrupt');
console.log('PASS app-selection content and metadata forwarding; guarded pointer extension and cancellation');

let fixtureState='Original controls';const inputs:string[]=[];
const staleClient={...client,call:async(_name:string,args:any)=>{if(/pressKey|typeText|\.click/.test(args.code))inputs.push(args.code);return {content:[{type:'text',text:fixtureState}]};}};
const stale=new EchoLcuSession(staleClient,owner,async()=>{});
const initial=await stale.execute('Calculator',{kind:'inspect'});
assert.equal(typeof initial.observationId,'string','Every app observation has a host-owned identity');
fixtureState='A different window and controls';
const changed=await stale.execute('Calculator',{kind:'click',target:3,observationId:initial.observationId as string});
assert.equal(changed.lcuActionStatus,'observation_required');assert.equal(inputs.length,0,'Changed controls are shown again, never clicked with a stale index');
await assert.rejects(stale.execute('Calculator',{kind:'click',target:3,observationId:initial.observationId as string}),/stale/i);
await stale.end('Stop');
console.log('PASS stale observation and changed-window input fencing');

// The real Finder log changed only free disk space between observation and
// Close. Window chrome can be re-grounded without restarting the decision.
let disk='4.41 GB',window='Downloads',closeInputs=0;
const finderState=()=>({content:[{type:'text',text:`Window: "${window}", App: Finder.\n${window==='Desktop'?'0 scroll area (disabled) desktop\n\t1 container desktop':`0 standard window ${window}, ID: FinderWindow\n\t1 text ${disk} available\n\t2 close button`}`}]});
const finderClient={...client,call:async(_name:string,args:any)=>{
 if(args.code.includes('.click(')){closeInputs++;window='Desktop';}
 return finderState();
}};
const finder=new EchoLcuSession(finderClient,owner,async()=>{});
const originalFinder=finderState();
const variant=(text:string)=>({content:[{type:'text',text}]});
const source=originalFinder.content[0].text;
for(const altered of [source.replace('Downloads','Documents'),source.replace('\t2 close button','\t3 close button'),source.replace('close button','close button (disabled)'),source+'\n\t3 close button',source+'\n\t4 sheet Save changes?']){
 assert.equal(stableWindowChromeTarget(originalFinder,variant(altered),2),false,'A changed window, target, duplicate or sheet must never reuse the Close decision');
}
const finderObserved=await finder.execute('Finder',{kind:'inspect'});
disk='4.42 GB';
const closed=await finder.execute('Finder',{kind:'click',target:2,observationId:finderObserved.observationId as string});
assert.equal(closed.inputDispatched,true,'Unrelated disk-space text must not block a freshly re-grounded Close button');
assert.equal(closeInputs,1);
const closure=await finder.execute('Finder',{kind:'verify',condition:{kind:'window_closed',title:'Downloads'},observationId:closed.observationId as string});
assert.equal(closure.appConditionVerified,true,'Verified closure requires the host-confirmed original native Close target and a changed window');
assert.equal(finder.completionProof?.kind,'window_closed');
const wrongTitle=await finder.execute('Finder',{kind:'verify',condition:{kind:'window_closed',title:'Documents'},observationId:closed.observationId as string});
assert.equal(wrongTitle.appConditionVerified,false,'A different requested window cannot borrow a Close receipt');
await finder.end('Stop');

let nativeId='com.apple.calculator',identityInputs=0;
const identityState=()=>({content:[{type:'text',text:'Window: "Calculator", App: Calculator.\n0 standard window Calculator\n\t1 button Description: 2, ID: Two'}],_meta:{'codex/toolSurface':{app:{kind:'appId',appId:nativeId}}}});
const identityClient={...client,call:async(_name:string,args:any)=>{if(args.code.includes('.click('))identityInputs++;return identityState();}};
const identities=new EchoLcuSession(identityClient,owner,async()=>{});
const trustedIdentity=await identities.execute('Calculator',{kind:'inspect'});
assert.equal(identities.inputRisk('Calculator',{kind:'click',target:1,observationId:trustedIdentity.observationId as string})?.decision,'allow');
nativeId='com.apple.mail';
const replacedIdentity=await identities.execute('Calculator',{kind:'click',target:1,observationId:trustedIdentity.observationId as string});
assert.equal(replacedIdentity.lcuActionStatus,'observation_required','Identical AX text with changed native app identity must invalidate a low-risk decision');
assert.equal(identityInputs,0);await identities.end('Stop');
