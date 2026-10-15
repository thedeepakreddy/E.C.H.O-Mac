import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNativeAppObservation,nativeAppInputRisk,type NativeAppObservation} from './safety/native-app-risk.js';
import type {LcuAction} from './tools/lcu-session.js';

// Inert AX fixtures only. No registry, client, gate, camera or native API imports.
function observation(name:string,bundleId:string,rows:string,options:Partial<NativeAppObservation>={},windowTitle=name):NativeAppObservation {
 return {observationId:'obs-1',nativeApp:{name,bundleId,windowTitle},result:{content:[{type:'text',text:`Window: ${windowTitle}, App: ${name}.\n0 standard window ${windowTitle}\n${rows}${options.focusedIndex===undefined?'':`\nThe focused UI element is ${options.focusedIndex} observed native element`}`}],_meta:{'codex/toolSurface':{app:{kind:'appId',appId:bundleId}}}},...options};
}
const finder=observation('Finder','com.apple.finder',
 '  1 toolbar\n    2 button Description: Back\n    3 button Description: Search\n  4 button Description: Close\n  5 checkbox Description: Show Sidebar, Value: 0\n  6 menu button Description: View\n  7 tab Description: Documents\n  8 button Description: Delete\n  9 checkbox Description: Automatic Payments', {focusedIndex:3});
const mail=observation('Mail','com.apple.mail',
 '  1 group Description: Compose\n    2 text field Description: To\n    3 text field Description: Subject\n    4 text area Description: Message Body\n    5 button Description: Send\n    6 button Description: Reply\n    7 button Description: Save Draft',{focusedIndex:4},'New Message');
const messages=observation('Messages','com.apple.MobileSMS',
 '  1 text area Description: Message\n  2 button Description: Send',{focusedIndex:1});
const calc=observation('Calculator','com.apple.calculator',
 '  1 scroll area Description: Edit field, ID: StandardInputView\n    2 text 5\n  3 button Description: 5, ID: Five\n  4 button Description: Clear\n  5 button Description: Send',{focusedIndex:2});
const safari=observation('Safari','com.apple.Safari',
 '  1 toolbar\n    2 button Description: Back\n  3 web area\n    4 button Description: Back\n    5 button Description: Pay',{focusedIndex:2});
function risk(app:string,state:NativeAppObservation|undefined,action:LcuAction){
 return nativeAppInputRisk(app,{...action,observationId:action.observationId??'obs-1'},state);
}

for(const [name,app,state,action] of [
 ['Finder Back','Finder',finder,{kind:'click',target:2}],
 ['Finder Search','Finder',finder,{kind:'click',target:3}],
 ['Finder Close','Finder',finder,{kind:'click',target:4}],
 ['Finder view checkbox','Finder',finder,{kind:'click',target:5}],
 ['Finder menu opening','Finder',finder,{kind:'click',target:6}],
 ['Finder tab selection','Finder',finder,{kind:'click',target:7}],
 ['Mail Reply opens draft','Mail',mail,{kind:'click',target:6}],
 ['Mail Save Draft','Mail',mail,{kind:'click',target:7}],
 ['Mail literal body','com.apple.mail',mail,{kind:'type',text:'Please send this draft later.'}],
 ['Mail literal subject','Mail',{...mail,focusedIndex:3},{kind:'set',index:3,value:'Status update'}],
 ['Messages literal draft','Messages',messages,{kind:'type',text:'hello'}],
 ['Calculator result key','Calculator',calc,{kind:'press',key:'Return'}],
 ['Calculator number key','Calculator',calc,{kind:'press',key:'5'}],
 ['Calculator digit button','Calculator',calc,{kind:'click',target:3}],
 ['Calculator Clear','Calculator',calc,{kind:'click',target:4}],
 ['Calculator expression','Calculator',calc,{kind:'type',text:'2+3'}],
 ['Native focus navigation','Mail',mail,{kind:'press',key:'Tab'}],
 ['Safari native toolbar Back','Safari',safari,{kind:'click',target:2}],
] as Array<[string,string,NativeAppObservation,LcuAction]>) test(`${name} needs no Echo confirmation`,()=>{
 assert.equal(risk(app,state,action).tier,'medium');assert.equal(risk(app,state,action).decision,'allow');
});

for(const [name,app,state,action] of [
 ['final mail Send','Mail',mail,{kind:'click',target:5}],
 ['final message Send','Messages',messages,{kind:'click',target:2}],
 ['Messages Return','Messages',messages,{kind:'press',key:'Return'}],
 ['Mail CmdReturn','Mail',mail,{kind:'press',key:'super+Return'}],
 ['Calculator CmdReturn','Calculator',calc,{kind:'press',key:'cmd+Return'}],
 ['payment','Safari',safari,{kind:'click',target:5}],
 ['Delete','Finder',finder,{kind:'click',target:8}],
 ['payment checkbox','Finder',finder,{kind:'click',target:9}],
 ['webpage Back is not trusted native navigation','Safari',safari,{kind:'click',target:4}],
 ['coordinate click','Finder',finder,{kind:'click',target:[10,20]}],
 ['coordinate drag','Finder',finder,{kind:'drag',from:[1,2],to:[3,4]}],
 ['unknown index','Finder',finder,{kind:'click',target:99}],
 ['unknown native app','Other',observation('Other','org.example.other','  1 button Description: Back'),{kind:'click',target:1}],
 ['mail multiline body','Mail',mail,{kind:'type',text:'hello\nSend'}],
 ['mail carriage return','Mail',mail,{kind:'type',text:'hello\r'}],
 ['mail Unicode line separator','Mail',mail,{kind:'type',text:'hello\u2028world'}],
 ['unfocused Mail subject','Mail',mail,{kind:'set',index:3,value:'Status'}],
 ['missing focus','Mail',{...mail,focusedIndex:undefined},{kind:'type',text:'hello'}],
 ['unknown focus index','Mail',{...mail,focusedIndex:99},{kind:'press',key:'Tab'}],
 ['wrong app metadata','Calculator',mail,{kind:'click',target:6}],
 ['header-app mismatch','Mail',{...mail,nativeApp:{name:'Calculator',bundleId:'com.apple.mail',windowTitle:'New Message'}},{kind:'click',target:6}],
 ['missing host observation','Mail',undefined,{kind:'click',target:6}],
 ['stale observation id','Finder',finder,{kind:'click',target:2,observationId:'old'}],
 ['duplicate target index','Finder',observation('Finder','com.apple.finder','  2 button Description: Back\n  2 button Description: Delete'),{kind:'click',target:2}],
 ['native label overrides forged benign description','Mail',mail,{kind:'click',target:5,description:'Back'} as LcuAction],
] as Array<[string,string,NativeAppObservation|undefined,LcuAction]>) test(`${name} stays high risk`,()=>{
 assert.equal(risk(app,state,action).tier,'high');
});

for(const [name,state] of [
 ['host-marked permission dialog',{...finder,protectedDialog:true}],
 ['native security dialog',observation('Finder','com.apple.finder','  1 dialog Description: Accessibility permission\n    2 button Description: Allow',{focusedIndex:2},'Permission')],
 ['Echo approval UI',observation('Echo','com.echo.app','  2 button Description: Allow',{focusedIndex:2})],
] as Array<[string,NativeAppObservation]>) test(`${name} cannot be automated even with approval`,()=>{
 const assessment=risk(state.nativeApp.name,state,{kind:'click',target:2});
 assert.equal(assessment.tier,'high');assert.equal(assessment.decision,'deny');
});

test('model labels cannot turn routine host AX into different authority',()=>{
 assert.equal(risk('Finder',finder,{kind:'click',target:2,description:'Pay',risk:'low'} as LcuAction).decision,'allow');
});

test('host constructor derives native identity and focus from LCU output',()=>{
 const state=createNativeAppObservation('com.apple.mail',mail.result,'obs-1');
 assert.ok(state);assert.equal(state.nativeApp.bundleId,'com.apple.mail');assert.equal(state.focusedIndex,4);
 assert.equal(risk('Mail',state,{kind:'type',text:'draft'}).decision,'allow');
});
test('host constructor accepts direct appId metadata and actual binding metadata',()=>{
 const result={...finder.result,_meta:{appId:'com.apple.finder'}};
 const direct=createNativeAppObservation('Finder',result,'obs-1');assert.ok(direct);
 const bound=createNativeAppObservation('Finder',{content:finder.result.content},'obs-1',{content:[],_meta:{appId:'com.apple.finder'}});
 assert.ok(bound);assert.equal(risk('Finder',bound,{kind:'click',target:4}).decision,'allow');
});
test('Calculator native header fallback requires a literal approved reference',()=>{
 const bare={content:calc.result.content};
 const state=createNativeAppObservation('Calculator',bare,'obs-1');assert.ok(state);
 assert.equal(state.nativeApp.bundleId,undefined,'no bundle id is fabricated from the name');
 assert.equal(risk('Calculator',state,{kind:'press',key:'Return'}).decision,'allow');
 assert.equal(createNativeAppObservation('/tmp/Calculator.app',bare,'obs-1'),undefined);
 assert.equal(createNativeAppObservation('Finder',{content:finder.result.content},'obs-1'),undefined,'Finder needs actual appId metadata');
});
test('metadata conflicts never fall back to an app name',()=>{
 for(const result of [
  {...calc.result,_meta:{appId:'com.apple.mail'}},
  {...calc.result,appId:'com.apple.mail'},
  {...calc.result,_meta:{appId:'com.apple.mail','codex/toolSurface':{app:{kind:'appId',appId:'com.apple.calculator'}}}},
  {...calc.result,_meta:{'codex/toolSurface':{app:{kind:'tab',appId:'com.apple.calculator'}}}},
 ])assert.equal(createNativeAppObservation('Calculator',result,'obs-1'),undefined);
});
test('focused edit-field Return is not automatically treated as harmless typing',()=>{
 const state=createNativeAppObservation('Mail',mail.result,'obs-1');assert.ok(state);
 assert.equal(risk('Mail',state,{kind:'press',key:'Return'}).tier,'high');
 assert.equal(risk('Messages',messages,{kind:'press',key:'Return'}).decision,'confirm');
});
test('Calculator modal defaults and literal control characters cannot auto-submit',()=>{
 const dialog=observation('Calculator','com.apple.calculator','  1 sheet Description: Save\n    2 button Description: Replace',{focusedIndex:2});
 assert.equal(risk('Calculator',dialog,{kind:'press',key:'Return'}).decision,'confirm');
 for(const text of ['hello\tworld','hello\u001b','hello\u0008'])assert.equal(risk('Mail',mail,{kind:'type',text}).decision,'confirm');
});
