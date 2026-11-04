// Bundle only the consumers' OS boundaries with inert adapters. Never launch an app.
import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const nativeControl=resolve('src/tools/lcu-control.ts');
const adapters={
  'computer-actions':`import {executeEchoComputerAction} from ${JSON.stringify(nativeControl)};
    export const echoAppAction=executeEchoComputerAction;
    export async function frontmostApp(){globalThis.__consumerFixture.frontmostReads++;return globalThis.__consumerFixture.app;}
    const legacy=name=>async(...args)=>{globalThis.__consumerFixture.legacy.push({name,args});return 'legacy fixture input';};
    export const openApp=legacy('openApp'),click=legacy('click'),typeText=legacy('typeText'),hotkey=legacy('hotkey'),scroll=legacy('scroll');`,
  ax:`export async function dump(){return globalThis.__consumerFixture.ax;}
    export async function press(...args){globalThis.__consumerFixture.legacy.push({name:'ax.press',args});return {ok:true};}
    export function rankScored(elements){return elements.map(element=>({element,score:1}));}
    export function criticVerdict(){return {ok:true};}`,
  vision:`export async function ocr(){return globalThis.__consumerFixture.ocr;}
    export const ocrAll=ocr;export function rankText(){return [];}
    export function textMatchIsAmbiguous(){return false;}`,
};
const result=await build({entryPoints:['src/_consumerlcumigrationtest.ts'],bundle:true,write:false,platform:'node',format:'esm',target:'node20',packages:'external',define:{__ECHO_INERT_CONSUMER_FIXTURE__:'true'},logLevel:'error',plugins:[{
  name:'inert-consumer-os-boundaries',setup(build){
    build.onResolve({filter:/tools\/(computer-actions|ax|vision)\.js$/},args=>{
      if(!/[/\\]frontier[/\\](?:replay|popups|extract|native-consumer)\.ts$/.test(args.importer))return;
      return {path:args.path.match(/(computer-actions|ax|vision)\.js$/)[1],namespace:'fixture-os'};
    });
    build.onLoad({filter:/.*/,namespace:'fixture-os'},args=>({contents:adapters[args.path],loader:'js',resolveDir:process.cwd()}));
  },
}]});
const child=spawn(process.execPath,['--import','./scripts/test-network-guard.mjs','--input-type=module'],{stdio:['pipe','inherit','inherit']});
child.stdin.end(result.outputFiles[0].text);
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
