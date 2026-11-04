#!/usr/bin/env node
/** Read-only model preflight. Incoming sizes are estimates, NOT a download quota.
 * Whisper's manual downloads are unmanaged: check their model directory here first.
 * Quit Echo, then manually archive diagnostics/models you choose; nothing is deleted.
 */
import {lstatSync,opendirSync,statfsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const MiB=1024*1024;
export function entry(path){try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
export function noDirectoryLinks(path,root){
  for(let current=resolve(path);;current=dirname(current)){
    if(entry(current)?.isSymbolicLink())throw Error('unsafe-path: model installation directory is a symlink');
    if(current===resolve(root)||current===dirname(current))break;
  }
}
export function installationUsage(root){
  let bytes=0,count=0;const started=performance.now();
  const visit=(path,depth)=>{
    if(++count>8192||depth>32||performance.now()-started>100)throw Error('scan-limit: model inventory is too large; inspect and manually archive before installation');
    const st=entry(path);if(!st)return;
    if(!st.isDirectory()||st.isSymbolicLink()){bytes+=st.size;return;}
    const dir=opendirSync(path);try{let item;while((item=dir.readSync()))visit(join(path,item.name),depth+1);}finally{dir.closeSync();}
  };
  visit(root,0);return bytes;
}
export function checkModelStorage(path,{incomingBytes=0,installationBytes=2*1024*MiB,reserveBytes=1024*MiB,statfs}={}){
  for(const n of [incomingBytes,installationBytes,reserveBytes])if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid storage budget');
  const usedBytes=installationUsage(path);
  if(usedBytes+incomingBytes>installationBytes)throw Error('Model installation budget exceeded; manually archive chosen models before retrying. Existing data was preserved.');
  let nearest=resolve(path);while(!entry(nearest)&&dirname(nearest)!==nearest)nearest=dirname(nearest);
  if(entry(nearest)?.isSymbolicLink())throw Error('unsafe-path: model directory is a symlink');
  let availableBytes;
  try{const s=statfs?statfs(nearest):statfsSync(nearest);availableBytes=Number(s.bavail)*Number(s.bsize);}catch{throw Error('disk-space-unknown: cannot authorize a model download');}
  if(!Number.isFinite(availableBytes)||availableBytes<0)throw Error('disk-space-unknown: cannot authorize a model download');
  if(availableBytes-incomingBytes<reserveBytes)throw Error('disk-reserve: insufficient available space for the estimated installation and reserve');
  return {usedBytes,incomingBytes,availableBytes,reserveBytes,installationBytes};
}
export function main(args=process.argv.slice(2)){
  if(args[0]!=='check')throw Error('Usage: node scripts/storage-budget.mjs check [--path MODEL_DIR] [--incoming-bytes N] [--limit-bytes N]');
  const values={};for(let i=1;i<args.length;i+=2){if(!['--path','--incoming-bytes','--limit-bytes'].includes(args[i])||args[i+1]===undefined)throw Error('Invalid budget check argument');values[args[i]]=args[i+1];}
  const path=resolve(values['--path']??join(dirname(dirname(fileURLToPath(import.meta.url))),'vendor'));
  const report=checkModelStorage(path,{incomingBytes:Number(values['--incoming-bytes']??0),installationBytes:Number(values['--limit-bytes']??2*1024*MiB)});
  console.log(JSON.stringify({path,...report,policy:'Read-only preflight estimate; upstream sizes may differ. No continuous download quota. Manual Whisper downloads are unmanaged. Quit Echo before manually archiving chosen data; no automatic deletion.'},null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
