import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {TOOL_MAP} from './tools/registry.js';
assert(/voiceLog\.init\(dataRoot\(\)\)/.test(readFileSync('src/main.ts','utf8')),'Installed Echo must write voice diagnostics under mutable user data, not its application bundle');
const brightness=TOOL_MAP.get('adjust_brightness')!;
assert.match(brightness.description,/unavailable|unsupported/i,'An unsupported action must not advertise working key simulation');
assert.equal((await brightness.handler({action:'up'})).status,'failed');
const source=readFileSync('src/tools/registry/knowledge.ts','utf8');
const ast=ts.createSourceFile('knowledge.ts',source,ts.ScriptTarget.Latest,true);
let handler:ts.Node|undefined;
function find(node:ts.Node){
 if(ts.isObjectLiteralExpression(node)&&node.properties.some(p=>ts.isPropertyAssignment(p)&&p.name.getText(ast)==='name'&&ts.isStringLiteral(p.initializer)&&p.initializer.text==='osiris_focus')){
  handler=node.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(ast)==='handler');
 }ts.forEachChild(node,find);
}find(ast);assert(handler&&ts.isPropertyAssignment(handler));
const code=ts.transpile(`(${handler.initializer.getText(ast)})`,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}).replace(/\bimport\(/g,'importModule(');
for(const ready of [false,true]){
 let moved=0,geocoded=0;
 const scope=vm.createContext({Number,String,importModule:async(name:string)=>name==='../../osiris.js'?{
  isOsirisOpen:()=>true,canFocusOsiris:async()=>ready,focusOsiris:async()=>{moved++;return ready?'map':'none';},
 }:{osirisFetch:async()=>{geocoded++;return {};},activeBase:async()=> 'https://fixture.invalid'},setTimeout:()=>{throw Error('Unsupported focus must not use a fixed wait');}});
 const result=await vm.runInContext(code,scope)({place:'Tokyo',lat:35,lng:139});
 if(!ready){assert.equal(result.status,'failed');assert.equal(moved,0);assert.equal(geocoded,0);assert.match(result.text,/unavailable|not.*ready|not.*expose/i);}
 else{assert.equal(moved,1);assert.equal(result.status,'success');assert.equal(result.verification,'unverified');}
}
console.log('PASS accurate brightness/focus capabilities, no disabled search/key fallback, no native input or network');
