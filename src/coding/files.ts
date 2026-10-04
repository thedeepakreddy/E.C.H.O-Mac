import {readFile, writeFile, mkdir, rename, rm, readdir, stat} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {getSession, mutateSession, codingRoot, assertLive} from './session.js';
import {projectPath} from './workspace.js';
export const fileHash = (bytes: Uint8Array|string) => createHash('sha256').update(bytes).digest('hex');
const privatePatches=new Map<string,any>();
const MAX_FILE = 8*1024*1024;
async function textFile(path: string): Promise<{text:string; hash:string}> {
  const info = await stat(path); if (!info.isFile() || info.size > MAX_FILE) throw new Error('Expected a text file no larger than 8 MiB. Use a process for large/binary artifacts.');
  const bytes = await readFile(path); if (bytes.includes(0)) throw new Error('Binary file is not editable as text.');
  const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error('File is not valid UTF-8; refusing lossy editing.');
  return {text,hash:fileHash(bytes)};
}
export async function readProjectFile(id: string, path: string, offset=0, limit=6000) {
  const session=getSession(id), target=await projectPath(session.root,path);
  const file=await textFile(target); const end=Math.min(file.text.length,offset+Math.min(limit,12000));
  return {path:relative(session.root,target),revision:session.revision,hash:file.hash,text:file.text.slice(offset,end),totalChars:file.text.length,nextOffset:end<file.text.length?end:null};
}
const IGNORED = new Set(['.git','node_modules','.venv','venv','target','dist','build','.next','.echo']);
export async function searchProject(id: string, query='', limit=50) {
  const session=getSession(id); const matches:Array<{path:string;line?:number;text?:string}>=[];
  let scanned=0,truncated=false;
  async function visit(dir:string):Promise<void> {
    for (const entry of await readdir(dir,{withFileTypes:true})) {
      if (++scanned>5000 || matches.length>=limit) {truncated=true;return;}
      if (entry.isSymbolicLink() || IGNORED.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name)) continue;
      const path=join(dir,entry.name);
      if (entry.isDirectory()) {await visit(path); if(truncated)return;}
      else if(entry.isFile()) {
        const name=relative(session.root,path);
        if (!query || name.toLowerCase().includes(query.toLowerCase())) {matches.push({path:name});continue;}
        try {const file=await textFile(path); const lines=file.text.split('\n'); for (let i=0;i<lines.length;i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) {matches.push({path:name,line:i+1,text:lines[i].slice(0,500)}); if(matches.length>=limit){truncated=true;return;}}}
        catch {/* binary/oversized/vanished files are not text search candidates */}
      }
    }
  }
  await projectPath(session.root); await visit(session.root);
  return {revision:session.revision,matches,scanned,truncated};
}
export interface ProjectPatch {path:string;expectedHash:string;content?:string;edits?:Array<{before:string;after:string}>;remove?:boolean}
export async function applyProjectPatch(id:string,revision:number,patch:ProjectPatch) {
  return mutateSession(id,revision,async session=>{
    const target=await projectPath(session.root,patch.path,true);
    let before:string|undefined;
    try {before=(await textFile(target)).text;} catch(error:any) {if(error.code!=='ENOENT')throw error;}
    const hash=before===undefined?'missing':fileHash(before);
    if (hash!==patch.expectedHash) throw new Error('File content conflict: read the current hash before editing.');
    if (patch.remove && before===undefined) throw new Error('Cannot remove a missing file.');
    let after=patch.content;
    if (patch.edits) {
      if (after!==undefined || patch.remove) throw new Error('Choose content, edits or remove.');
      after=before??'';
      for (const edit of patch.edits) {if(!edit.before || after.split(edit.before).length!==2)throw new Error('Patch match must occur exactly once.');after=after.replace(edit.before,edit.after);}
    }
    if (!patch.remove && after===undefined) throw new Error('Patch needs content or edits.');
    if (after!==undefined && Buffer.byteLength(after)>MAX_FILE) throw new Error('Patch exceeds the 8 MiB text-file limit.');
    const patchId=randomUUID(), backup=join(codingRoot(),'patches',patchId);
    // Backups are private for private builds; no persistent derived copy.
    if (session.privateMode) privatePatches.set(patchId,{projectId:id,path:patch.path,before,after,revision});
    else {await mkdir(backup,{recursive:true,mode:0o700});await writeFile(join(backup,'change.json'),JSON.stringify({projectId:id,path:patch.path,before,after,revision}),{mode:0o600});}
    await mkdir(dirname(target),{recursive:true});
    const temp=join(dirname(target),`.echo-patch-${patchId}.tmp`);
    try {
      if (!patch.remove) await writeFile(temp,after!,{flag:'wx',mode:before===undefined?0o600:(await stat(target)).mode});
      // A user may have edited the file during the asynchronous write.
      await projectPath(session.root,patch.path,true); assertLive();
      let current='missing';try {current=(await textFile(target)).hash;}catch(error:any){if(error.code!=='ENOENT')throw error;}
      if(current!==hash)throw new Error('File changed during patch; original preserved.');
      if(patch.remove)await rm(target);else await rename(temp,target);
    } finally {await rm(temp,{force:true});}
    session.contentRevision=(session.contentRevision??0)+1;session.phase='implementing';session.artifacts.push({kind:'patch',value:patchId});
    return {patchId,path:patch.path,beforeHash:hash,afterHash:patch.remove?'missing':fileHash(after!)};
  });
}
export async function projectDiff(id:string,patchId:string) {
  getSession(id);if(!/^[a-f0-9-]{36}$/.test(patchId))throw new Error('Invalid patch ID.');
  const change=privatePatches.get(patchId)??JSON.parse(await readFile(join(codingRoot(),'patches',patchId,'change.json'),'utf8'));
  if(change.projectId!==id)throw new Error('Patch belongs to another project.');
  return {...change,before:(change.before??'').slice(0,12000),after:(change.after??'').slice(0,12000),truncated:(change.before?.length??0)>12000||(change.after?.length??0)>12000};
}
export async function undoProjectPatch(id:string,revision:number,patchId:string) {
  const change=await projectDiff(id,patchId);
  // Retrieve the original, never the bounded presentation above.
  const full=privatePatches.get(patchId)??JSON.parse(await readFile(join(codingRoot(),'patches',patchId,'change.json'),'utf8'));
  return applyProjectPatch(id,revision,{path:full.path,expectedHash:full.after===undefined?'missing':fileHash(full.after),...(full.before===undefined?{remove:true}:{content:full.before})});
}
