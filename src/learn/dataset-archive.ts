/** Compress training evidence before diagnostic retention removes its live copy. */
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, readdir, access, rename, rm} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {randomUUID} from 'node:crypto';
import {dataRoot} from '../memory/paths.js';
import {captureAllowed, deletionEpoch} from '../memory/capture-policy.js';
export async function archiveDatasetRun(runDir: string, root = join(dataRoot(), 'dataset-history', 'runs')): Promise<void> {
  const epoch = deletionEpoch();
  const check = () => {if (!captureAllowed() || deletionEpoch() !== epoch) throw new Error('Dataset archive cancelled by capture policy.');};
  check();
  const destination = join(root, basename(runDir)), stage = `${destination}.${randomUUID()}.tmp`;
  try {await access(destination); return;} catch { /* no archive yet */ }
  async function copy(source: string, target: string): Promise<void> {
    await mkdir(target,{recursive:true,mode:0o700});
    for (const entry of await readdir(source,{withFileTypes:true})) {
      check(); if (entry.isSymbolicLink()) throw new Error('Refusing to archive symbolic links.');
      if (entry.isDirectory()) await copy(join(source,entry.name),join(target,entry.name));
      else if (entry.isFile()) await pipeline(createReadStream(join(source,entry.name)),createGzip(),createWriteStream(join(target,`${entry.name}.gz`),{mode:0o600}));
    }
  }
  try {await copy(runDir,stage); check(); await rename(stage,destination);}
  catch(error) {await rm(stage,{recursive:true,force:true});throw error;}
}
