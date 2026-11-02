#!/usr/bin/env node
/** Offline, read-only doctor. The existing npm permissions wrapper is unchanged. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const args=process.argv.slice(2);
let appRoot=ROOT,lcuRoot,json=false,help=false;
try{
 for(let i=0;i<args.length;i++){
  if(args[i]==='--json')json=true;
  else if(args[i]==='--help')help=true;
  else if(['--app-root','--lcu-root'].includes(args[i])&&args[i+1]&&!args[i+1].startsWith('--')){
   const option=args[i],value=resolve(args[++i]);if(option==='--app-root')appRoot=value;else lcuRoot=value;
  }else throw Error('unsupported option');
 }
}catch{
 console.error('Usage: node scripts/doctor.mjs [--json] [--app-root PATH] [--lcu-root PATH]. Live/provider and native permission probes are not supported by this offline doctor.');
 process.exit(2);
}
if(help){
 console.log('Usage: node scripts/doctor.mjs [--json] [--app-root PATH] [--lcu-root PATH]\nOffline only: no provider requests, auth refresh, native prompts, runtime launch or input.\nExit 0: no detected offline blocker, NOT verified readiness. Exit 1: blocker; exit 2: invalid option.\nThe existing npm run doctor wrapper runs its separate permissions script first.');
}else{
 let scratch;
 try{
  scratch=mkdtempSync(join(tmpdir(),'echo-doctor-build-'));
  const output=join(scratch,'doctor.mjs');
  // Existing esbuild dependency; compile real shared TS readers, not a copied config parser.
  await build({entryPoints:[join(ROOT,'src/diagnostics/doctor.ts')],outfile:output,bundle:true,platform:'node',format:'esm',target:'node20',logLevel:'silent',external:['electron']});
  const {collectDoctorReport,formatDoctorReport,doctorExitCode}=await import(pathToFileURL(output).href);
  const report=await collectDoctorReport(appRoot,{lcuRoot});
  console.log(json?JSON.stringify(report):formatDoctorReport(report));
  process.exitCode=doctorExitCode(report);
 }catch{
  // Never echo arbitrary filesystem, config, auth or build errors into a diagnostic report.
  console.error('Doctor unavailable: could not compile, load or collect shared diagnostics. No readiness claim was made.');
  process.exitCode=1;
 }finally{
  if(scratch)rmSync(scratch,{recursive:true,force:true}); // Only this invocation's generated bundle.
 }
}
