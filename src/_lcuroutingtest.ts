import assert from 'node:assert/strict';
import {runInAgentContext} from './agent-replay/context.js';
import {EchoComputerControl,installEchoComputerControl,closeEchoComputerControl} from './tools/lcu-control.js';
import * as actions from './tools/computer-actions.js';
import {withHumanComputerControl} from './tools/human-control.js';
import {JARVIS_PERSONA,LOCAL_PERSONA} from './brain/types.js';
import {lcuModelGuidance,setLcuModelSurface} from './tools/lcu-guidance.js';
import {TOOL_MAP} from './tools/registry.js';
actions.setCliclickBin('/nonexistent/echo-test-no-device-input');
setLcuModelSurface('original fixture instructions',[{name:'js'},{name:'js_reset'}]);
assert.match(lcuModelGuidance(),/automatic default/i,'Computer control must not depend on a user naming the driver');
assert.match(JARVIS_PERSONA,/inspect_app/,'The shared persona must teach the current app-scoped observation loop');
assert.doesNotMatch(JARVIS_PERSONA,/before list_ui_elements or click_ui_element|type_text directly|with click_ui_element or click_text/i,'The persona must not recommend retired or unobserved input');
assert.match(LOCAL_PERSONA,/inspect_app/,'Local models must also select the current approved app route automatically');
assert.doesNotMatch(LOCAL_PERSONA,/then screenshot coordinates|open_url\/open_app, list_ui_elements/i,'Local models must not be taught the old targeting route');
for(const name of ['screenshot','list_ui_elements','read_screen_text'])assert.match(TOOL_MAP.get(name)!.description,/diagnostic/i,'Legacy observers must not be presented as LCU targeting evidence');
let calls:string[]=[];
const content=[{type:'text',text:'Read-back: Calculator'},{type:'image',data:'fixture',mimeType:'image/png'}];
const client={connect:async()=>{},instructions:'original',publicTools:()=>[{name:'js'},{name:'js_reset'}],call:async(_name:string,args:any)=>{calls.push(args.code);return {content};},turnEnded:async()=>{},close:async()=>{}};
let pointerMoves=0;
installEchoComputerControl(new EchoComputerControl(client,undefined,async()=>{},async()=>{pointerMoves++;return {content};}));
const context:any={identity:{id:'echo',kind:'main'},taskId:'task',conversationId:'conversation',recorder:{runId:'run'},toolSignal:new AbortController().signal};
await runInAgentContext(context,async()=>{
 await assert.rejects(actions.moveMouseBy(1,2),/human/i);
 await assert.rejects(Promise.resolve().then(()=>withHumanComputerControl(()=>{})),/agent/i);
 // No native device calls: explicitly target the fixture approved app.
 await actions.echoAppAction('Calculator',{kind:'inspect'});
 await actions.echoAppAction('Calculator',{kind:'type',text:'test'});
 assert.ok(calls.some(code=>code.includes('typeText("test")')),'Autonomous typing reaches the LCU client, not cliclick');
 // The ordinary registry tools select the controller themselves. Neither the
 // user request nor tool arguments contain a driver/mode selection.
 const inspected=await TOOL_MAP.get('inspect_app')!.handler({app:'Calculator',screenshot:true});
 let observationId=(inspected.data as any).observationId;
 for(const [name,args,recipe] of [
  ['click_in_app',{target:2},'.click(2'],
  ['type_in_app',{text:'12*7'},'.typeText("12*7")'],
  ['press_app_key',{key:'Return'},'.pressKey("Return")'],
  ['scroll_in_app',{target:2,direction:'down',pages:1},'.scroll(2,"down",1)'],
  ['drag_in_app',{from:[10,10],to:[20,20]},'.drag([10,10],[20,20])'],
  ['set_app_value',{index:2,value:'84'},'.setValue(2,"84")'],
 ] as const){
  const result=await TOOL_MAP.get(name)!.handler({app:'Calculator',observationId,...args});
  assert.equal(result.status,'success',`${name} automatically reaches the approved foreground controller`);
  assert.ok(calls.some(code=>code.includes(recipe)),`${name} uses its LCU recipe`);
  observationId=(result.data as any).observationId;
 }
 const moved=await TOOL_MAP.get('move_echo_cursor')!.handler({app:'Calculator',observationId,to:[20,20]});
 assert.equal(moved.status,'success');assert.equal(pointerMoves,1,'Free movement automatically uses the pointer-only extension, never a fake click');
});
await closeEchoComputerControl();
console.log('PASS autonomous LCU routing and host-only human-input boundary');
