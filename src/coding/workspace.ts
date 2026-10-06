import {lstat, realpath, mkdir} from 'node:fs/promises';
import {isAbsolute, resolve, relative, sep, dirname} from 'node:path';
import {homedir} from 'node:os';
import {getAppPath} from '../utils/appPath.js';
export const within = (root: string, path: string) => {const rel = relative(root,path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));};
export async function openWorkspace(path: string, create = false, appRoot = getAppPath()): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Project path must be absolute.');
  const requested = resolve(path);
  const app = await realpath(appRoot);
  if (requested === sep || requested === homedir() || within(requested,app) || within(app,requested)) throw new Error('Choose a dedicated project directory outside Echo’s installation.');
  // Refuse symlinks at every existing component, before mkdir can follow one.
  await assertNoSymlinks(requested);
  if (create) await mkdir(requested,{recursive:true});
  const info = await lstat(requested);
  if (!info.isDirectory()) throw new Error('Project root is not a directory.');
  const canonical = await realpath(requested);
  if (within(app,canonical) || within(canonical,app)) throw new Error('Project cannot overlap Echo’s installation.');
  return canonical;
}
async function assertNoSymlinks(path: string): Promise<void> {
  let current = resolve(path);
  while (current !== dirname(current)) {
    try {if ((await lstat(current)).isSymbolicLink() && !(process.platform === 'darwin' && ['/tmp','/var','/etc'].includes(current) && await realpath(current) === `/private${current}`)) throw new Error(`Symbolic links are not allowed in project paths: ${current}`);}
    catch(error: any) {if (error.code !== 'ENOENT') throw error;}
    current = dirname(current);
  }
}
export async function projectPath(root: string, path = '.', writable = false): Promise<string> {
  const resolved = resolve(root,path);
  if (!within(root,resolved)) throw new Error('Path escapes the project workspace.');
  if (relative(root,resolved).split(sep).includes('.git')) throw new Error('Use Git tools instead of accessing Git internals.');
  await assertNoSymlinks(resolved);
  if (writable && resolved === root) throw new Error('Cannot replace the workspace root.');
  return resolved;
}
