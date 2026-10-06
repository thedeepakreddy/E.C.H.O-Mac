import {readFileSync, existsSync, mkdirSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {atomicWrite, dataRoot} from '../memory/paths.js';
import {currentAgentRunContext} from '../agent-replay/context.js';
import {currentInvocation} from '../memory/invocation.js';
import {taskCoordinator} from '../memory/task-state.js';
import {captureAllowed} from '../memory/capture-policy.js';
import {openWorkspace} from './workspace.js';
import {scrubSecrets} from '../safety/redact.js';
export type BuildPhase = 'clarifying'|'planning'|'implementing'|'waiting-for-input'|'verifying'|'previewing'|'deploying'|'completed'|'blocked'|'failed'|'cancelled';
export interface BuildSession {
  version: 1; id: string; name: string; root: string; ownerActorId: string; taskId?: string;
  privateMode: boolean; revision: number; phase: BuildPhase; spec: string;
  contentRevision?: number;
  target: string; language?: string; framework?: string; decisions: string[];
  acceptance: string[]; processIds: string[]; artifacts: Array<{kind: string; value: string}>;
  grantedActors?: string[]; question?: {id:string;text:string;options:string[];answer?:string};
  supervisorTaskId?: string;
  createdAt: string; updatedAt: string;
}
const transient = new Map<string,BuildSession>();
const queues = new Map<string,Promise<unknown>>();
export const codingRoot = () => join(dataRoot(),'coding');
function file(id: string) {if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid project identifier.'); return join(codingRoot(),'sessions',`${id}.json`);}
export function assertLive(): void {const invocation = currentInvocation(); if (invocation) taskCoordinator.assertInvocation(invocation);}
export function assertOwner(session: BuildSession): void {
  assertLive(); const context = currentAgentRunContext();
  const actor = context?.identity.id ?? 'echo';
  if (session.ownerActorId !== actor && !session.grantedActors?.includes(actor) && !(session.taskId && context?.identity.parentTaskId === session.taskId) && !(session.supervisorTaskId && context?.identity.parentTaskId === session.supervisorTaskId)) throw new Error('This actor has no grant for the project.');
}
export function getSession(id: string): BuildSession {
  const session = transient.get(id) ?? JSON.parse(readFileSync(file(id),'utf8')) as BuildSession;
  if (session.version !== 1 || session.id !== id) throw new Error('Invalid persisted project state.');
  assertOwner(session);
  const result=structuredClone(session);
  if (currentAgentRunContext()?.privateMode || !captureAllowed()) {result.privateMode=true;transient.set(id,result);}
  return result;
}
export function listSessions(): BuildSession[] {
  const sessions = [...transient.values()]; const root = join(codingRoot(),'sessions');
  if (existsSync(root)) for (const name of readdirSync(root)) {if (!name.endsWith('.json')) continue; try {sessions.push(getSession(name.slice(0,-5)));} catch {/* no grant/corrupt record */}}
  return [...new Map(sessions.map(session=>[session.id,session])).values()].filter(session=>{try {assertOwner(session);return true;}catch{return false;}}).map(session=>structuredClone(session));
}
/** Resolve only exact, uniquely owned names. Never guess between projects. */
export function resolveProjectId(reference: string): string {
  if (/^[a-f0-9-]{36}$/.test(reference)) return getSession(reference).id;
  const matches = [...new Map(listSessions().filter(s=>s.name===reference).map(s=>[s.id,s])).values()];
  if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous project name. Inspect your projects and use the project ID.' : 'No owned project with this exact name. Inspect your projects.');
  return getSession(matches[0].id).id;
}
function persist(session: BuildSession): void {
  assertLive(); session.updatedAt = new Date().toISOString();
  if (session.privateMode || !captureAllowed()) transient.set(session.id,structuredClone(session));
  else atomicWrite(file(session.id),JSON.stringify({...session,spec:scrubSecrets(session.spec),decisions:session.decisions.map(scrubSecrets),acceptance:session.acceptance.map(scrubSecrets),question:session.question ? {...session.question,text:scrubSecrets(session.question.text),options:session.question.options.map(scrubSecrets),answer:session.question.answer ? scrubSecrets(session.question.answer) : undefined} : undefined}));
}
export async function openProject(input: {path?: string; name?: string; create?: boolean; spec?: string; target?: string; appRoot?: string}): Promise<BuildSession> {
  assertLive();const suggested=join(homedir(),'EchoProjects',(input.name??`project-${randomUUID().slice(0,8)}`).replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,64)||'project');
  const root = await openWorkspace(input.path??suggested,input.create??!input.path,input.appRoot);
  for (const session of listSessions()) if (session.root === root) return session;
  const records=join(codingRoot(),'sessions');
  if(existsSync(records))for(const name of readdirSync(records)){try{const saved=JSON.parse(readFileSync(join(records,name),'utf8'));if(saved.root===root)throw new Error('Workspace is owned by another actor; an explicit project grant is required.');}catch(error:any){if(error.message.includes('another actor'))throw error;}}
  const context = currentAgentRunContext(), now = new Date().toISOString();
  const session: BuildSession = {version:1,id:randomUUID(),name:input.name ?? root.split('/').at(-1) ?? 'Project',root,
    ownerActorId:context?.identity.id ?? 'echo',taskId:context?.taskId, supervisorTaskId:context?.scope?.supervisorTaskId,
    grantedActors:context?.scope?.supervisorOwnerActorId?[String(context.scope.supervisorOwnerActorId)]:[], privateMode:context?.privateMode === true || !captureAllowed(),
    revision:0,phase:'clarifying',spec:input.spec ?? '',target:input.target ?? 'web',decisions:[],acceptance:[],processIds:[],artifacts:[],createdAt:now,updatedAt:now};
  persist(session); return session;
}
export async function mutateSession<T>(id: string, expectedRevision: number, mutate: (session: BuildSession)=>Promise<T>|T): Promise<{session: BuildSession; value:T}> {
  const queueKey=getSession(id).root;
  const previous = queues.get(queueKey) ?? Promise.resolve();
  const running = previous.catch(()=>{}).then(async()=>{
    const session = getSession(id);
    if (session.revision !== expectedRevision) throw new Error(`Project revision conflict: expected ${expectedRevision}, actual ${session.revision}. Inspect before retrying.`);
    const value = await mutate(session); assertLive(); session.revision++; persist(session);
    return {session:structuredClone(session),value};
  });
  queues.set(queueKey,running); try {return await running;} finally {if (queues.get(queueKey) === running) queues.delete(queueKey);}
}
export async function updateProject(id: string, revision: number, changes: Partial<Pick<BuildSession,'phase'|'spec'|'target'|'language'|'framework'|'decisions'|'acceptance'>>) {
  if(changes.phase==='completed')throw new Error('Completion requires recorded checks and acceptance evidence. Use project verification tools.');
  return (await mutateSession(id,revision,session=>{if(Object.keys(changes).some(key=>key!=='phase'))session.contentRevision=(session.contentRevision??0)+1;Object.assign(session,changes);})).session;
}
/** Explicit delegation of an already-owned project; inspectors retain their separate read-only tool grants. */
export async function grantProjectActors(id: string, actors: string[]): Promise<void> {
  const session=getSession(id);
  await mutateSession(id,session.revision,s=>{s.grantedActors=[...new Set([...(s.grantedActors ?? []),...actors])];});
}
