import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'echo-tool-architecture-'));
process.env.ECHO_DATA_ROOT = join(root, 'data');
process.env.ECHO_MEMORY_ROOT = join(root, 'memory');
process.env.JARVIS_FLEET_DIR = join(root, 'data');
process.env.ECHO_MCP = '0';
process.env.ECHO_LOG_QUIET = '1';
const {DEFAULTS_FOR_TESTS} = await import('./config.js');
const {runGated} = await import('./safety/gate.js');
const {TOOL_MAP} = await import('./tools/registry.js');
const {RecordingBrain} = await import('./agent-replay/runtime.js');
const {OpenAIBrain} = await import('./brain/openai.js');
const {GeminiBrain} = await import('./brain/gemini.js');
const {OllamaBrain} = await import('./brain/ollama.js');
const {ClaudeBrain} = await import('./brain/claude.js');
const {mcpToolDef, connectMcpServers, closeMcpServers, openMcpServerCount} = await import('./brain/mcp.js');
const {listFleet, addFleetMember, getFleetMember} = await import('./frontier/fleet.js');
const {makeFleetBrain} = await import('./frontier/fleet-brain.js');
const {SwarmManager} = await import('./frontier/swarm.js');
const {TaskCoordinator} = await import('./memory/task-state.js');
const {runCommand, stopTerminalCommands} = await import('./system/terminal.js');
const cfg = structuredClone(DEFAULTS_FOR_TESTS);
cfg.agi.toolPruning.enabled = false;
cfg.control.workingDir = root;
const forbiddenFile = join(root, 'must-not-exist');
const writeArgs = {path: forbiddenFile, content: 'permission escape'};
const originalFetch = globalThis.fetch;

async function finish(brain: InstanceType<typeof RecordingBrain>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const errors: string[] = [];
  brain.on('error', error => errors.push(String(error)));
  const ended = new Promise<void>(resolve => brain.once('turnEnd', resolve));
  brain.send('Inspect this fixture.');
  try {await Promise.race([ended, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(Error('Fixture brain stalled')), 5_000);})]);}
  finally {if (timer) clearTimeout(timer); await brain.stop();}
  assert.deepEqual(errors, []);
}

try {
  // Model declarations are advisory; deliberately request a hidden write anyway.
  for (const provider of ['openai', 'openrouter']) {
    let step = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      const request = JSON.parse(init.body);
      assert(!(request.tools ?? []).some((tool: any) => tool.name === 'write_local_file'));
      if (step > 0) {
        const output = JSON.parse(request.input.filter((item: any) => item.type === 'function_call_output').at(-1).output);
        assert.equal(output.error.category, 'tool_not_granted');
      }
      const output = step++ === 0
        ? [{type: 'function_call', name: 'write_local_file', arguments: JSON.stringify(writeArgs), call_id: 'hidden-write'}]
        : [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Permission refusal verified.'}]}];
      return new Response(`data: ${JSON.stringify({type: 'response.completed', response: {output}})}\n\n`, {headers: {'content-type': 'text/event-stream'}});
    }) as typeof fetch;
    const inner = new OpenAIBrain(cfg, {via: 'apiKey', key: 'offline'}, {allowedTools: new Set()}, provider === 'openrouter' ? {url: 'https://fixture.invalid/responses', label: 'openrouter'} : undefined);
    await finish(new RecordingBrain(inner, 'test', {}, {autoResume: false}));
    assert.equal(step, 2);
  }
  globalThis.fetch = originalFetch;

  const gemini = new GeminiBrain(cfg, 'offline', {allowedTools: new Set()}) as any;
  let geminiStep = 0;
  gemini.ai = {models: {generateContentStream: async (request: any) => {
    assert.equal(request.config.tools[0].functionDeclarations.length, 0);
    if (geminiStep > 0) assert.equal(request.contents.at(-1).parts[0].functionResponse.response.error.category, 'tool_not_granted');
    const parts = geminiStep++ === 0 ? [{functionCall: {name: 'write_local_file', args: writeArgs}}] : [{text: 'Permission refusal verified.'}];
    return (async function* () {yield {candidates: [{content: {role: 'model', parts}, finishReason: 'STOP'}]};})();
  }}};
  await finish(new RecordingBrain(gemini, 'test', {}, {autoResume: false}));
  assert.equal(geminiStep, 2);
  const ollama = new OllamaBrain(cfg, 'http://fixture.invalid', {allowedTools: new Set()}) as any;
  assert.equal(JSON.parse(await ollama.invokeTool('write_local_file', writeArgs)).error.category, 'tool_not_granted');
  await ollama.stop();
  const claude = new ClaudeBrain(cfg, {allowedTools: new Set(['read_local_file'])}) as any;
  assert.equal((await claude.gate('mcp__jarvis__read_local_file', {}, {})).behavior, 'allow');
  assert.equal((await claude.gate('mcp__outside__read_local_file', {}, {})).behavior, 'deny');
  assert.equal((await claude.gate('Bash', {}, {})).behavior, 'deny');
  await claude.stop();
  await assert.rejects(access(forbiddenFile));
  console.log('PASS all provider dispatch boundaries refuse hidden writes; Claude server namespaces cannot borrow local grants');

  const nested = await runGated(TOOL_MAP.get('invoke_coding_tool')!, {action: 'open_project', arguments: {path: join(root, 'escaped-project'), create: true}}, {workingDir: root, allowedTools: new Set(['invoke_coding_tool'])});
  assert.equal(nested.status, 'denied');
  await assert.rejects(access(join(root, 'escaped-project')));
  console.log('PASS nested dispatcher cannot broaden caller grants');

  let mcpCalls = 0;
  const handle = {name: 'mcp__fixture__read_item', originalName: 'read_item', serverName: 'fixture', description: 'fixture', inputSchema: {type: 'object', properties: {id: {type: 'integer', minimum: 1}}, required: ['id'], additionalProperties: false}, call: async () => {mcpCalls++; return {text: 'item'};}};
  const def = mcpToolDef(handle);
  assert.equal(mcpToolDef(handle), def);
  assert.equal((await runGated(def, {}, {workingDir: root})).error?.category, 'invalid_arguments');
  assert.equal((await runGated(def, {id: '1'}, {workingDir: root})).status, 'failed');
  assert.equal((await runGated(def, {id: 1}, {workingDir: root, allowedTools: new Set()})).status, 'denied');
  assert.equal(mcpCalls, 0);
  assert.equal((await runGated(def, {id: 1}, {workingDir: root})).status, 'success');
  assert.equal(mcpCalls, 1);
  for (const dialect of ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft-07/schema#']) {
    const modern = dialect.includes('2020-12');
    const schema = {$schema: dialect, type: 'object', properties: {point: modern
      ? {type: 'array', prefixItems: [{type: 'number'}, {type: 'number'}], items: false, minItems: 2}
      : {type: 'array', items: [{type: 'number'}, {type: 'number'}], additionalItems: false, minItems: 2}}, required: ['point']};
    const typed = mcpToolDef({...handle, inputSchema: schema});
    assert.equal((await runGated(typed, {point: ['wrong', 2]}, {workingDir: root})).error?.category, 'invalid_arguments');
    assert.equal((await runGated(typed, {point: [1, 2, 3]}, {workingDir: root})).error?.category, 'invalid_arguments');
    assert.equal((await runGated(typed, {point: [1, 2]}, {workingDir: root})).status, 'success');
  }
  let cancelled = false;
  const connection = await connectMcpServers({config: {fixture: {command: 'unused'}}, timeout: 30, factory: async () => ({client: {
    listTools: async () => ({tools: [{name: 'slow', inputSchema: {type: 'object'}}]}),
    callTool: (_args: any, _schema: any, options: any) => {options.signal.addEventListener('abort', () => cancelled = true); return new Promise(() => {});}, close: async () => {},
  }, transport: {close: async () => {}}}) as any});
  assert.equal((await connection.tools[0].call({})).status, 'timeout');
  assert(cancelled); await connection.close();
  let launched = false;
  await connectMcpServers({config: {fixture: {command: 'unused'}}, allowedTools: new Set(['read_local_file']), factory: async () => {launched = true; throw Error('Must not connect');}});
  assert.equal(launched, false);
  let listed!: (value: any) => void;
  let discovered!: () => void;
  const discoveryStarted = new Promise<void>(resolve => discovered = resolve);
  let closed = 0;
  const pendingConnection = connectMcpServers({config: {fixture: {command: 'unused'}}, factory: async () => ({client: {
    listTools: () => {discovered(); return new Promise(resolve => listed = resolve);}, close: async () => {closed++;},
  }, transport: {close: async () => {}}}) as any});
  await discoveryStarted; await closeMcpServers();
  assert.equal(closed, 1);
  listed({tools: [{name: 'late', inputSchema: {type: 'object'}}]});
  const late = await pendingConnection;
  assert.equal(late.tools.length, 0); assert.equal(late.servers[0].ok, false);
  assert.equal(openMcpServerCount(), 0);
  console.log('PASS MCP arguments validated locally and deadline sends transport cancellation');

  const builtin = listFleet()[0]; builtin.name = 'mutated'; builtin.tools.push('write_local_file');
  assert.notEqual(listFleet()[0].name, 'mutated');
  addFleetMember({id: 'reader', name: 'Reader', description: '', brief: 'Read carefully.', tier: 'balanced', tools: ['read_local_file']});
  const rosterPath = join(root, 'data', 'fleet.json');
  const goodRoster = await readFile(rosterPath, 'utf8');
  const malformed = JSON.parse(goodRoster); malformed.custom[0].custom = false;
  await writeFile(rosterPath, JSON.stringify(malformed));
  assert.equal(getFleetMember('reader'), null);
  assert.throws(() => addFleetMember({id: 'another', name: 'Another', description: '', brief: 'b', tier: 'balanced', tools: []}));
  assert.equal(await readFile(rosterPath, 'utf8'), JSON.stringify(malformed));
  assert.throws(() => makeFleetBrain(cfg)({id: 'x', name: 'x', kind: 'clone'}, {profile: 'reader', budget: {}} as any), /Unknown agent profile/);
  await writeFile(rosterPath, goodRoster);
  console.log('PASS corrupt roster fails closed, is preserved for repair, and cannot grant an unrestricted fallback brain');

  class Agent extends EventEmitter {sent: string[] = []; stopped = false; send(text: string) {this.sent.push(text);} async stop() {this.stopped = true;}}
  const swarm = new SwarmManager();
  const coordinator = new TaskCoordinator(join(root, 'tasks'));
  const agents = new Map<string, Agent>();
  swarm.submitMission({id: 'same-name', goal: 'Two researchers', tasks: [{id: 'one', goal: 'one', profile: 'research'}, {id: 'two', goal: 'two', profile: 'research'}]}, {
    coordinator, broadcast: () => {}, makeBrain: identity => {const brain = new Agent(); agents.set(identity.id, brain); return brain;},
  });
  const mission = swarm.getMission('same-name')!;
  assert.equal(swarm.send('Research', 'ambiguous'), false);
  assert(swarm.send(mission.tasks.one.actorId!, 'only one'));
  assert.match(agents.get(mission.tasks.one.actorId!)!.sent.at(-1)!, /only one/);
  assert(!agents.get(mission.tasks.two.actorId!)!.sent.at(-1)!.includes('only one'));
  for (const task of Object.values(mission.tasks)) {
    coordinator.submitResult(task.taskId!, task.actorId!, {status: 'completed', summary: 'done', artifacts: [{kind: 'text', label: 'fixture', value: 'verified fixture'}], verificationRefs: ['fixture:assertions'], blockers: []});
    const brain = agents.get(task.actorId!)!; brain.emit('turnEnd'); assert(brain.stopped);
  }
  const failed = new SwarmManager();
  failed.submitMission({id: 'failed-start', goal: 'Fail cleanly', tasks: [{id: 'bad', goal: 'bad'}, {id: 'next', goal: 'next', dependsOn: ['bad']}]}, {coordinator, broadcast: () => {}, makeBrain: () => {throw Error('No such profile');}});
  assert.equal(failed.getMission('failed-start')!.status, 'failed');
  assert.equal(failed.getMission('failed-start')!.tasks.next.status, 'blocked');
  console.log('PASS duplicate agent names stay isolated; completion closes resources; initialization failure settles dependencies');

  process.env.OPENAI_API_KEY = 'fixture-secret'; process.env.VERCEL_TOKEN = 'fixture-token';
  const env = await runCommand(process.execPath, ['-e', 'console.log(process.env.OPENAI_API_KEY, process.env.VERCEL_TOKEN)'], root);
  assert.equal(env.stdout.trim(), 'undefined undefined');
  assert.equal((await runCommand('/bin/bash', ['-c', 'exit 7'], root)).exitCode, 7);
  const large = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], root);
  assert(large.truncated); assert(large.stdout.length <= 64_000);
  const timed = await runCommand('/bin/bash', ['-c', 'trap "" TERM; sleep 30 & wait'], root, 80);
  assert.equal(timed.status, 'timeout');
  const controller = new AbortController();
  const interrupted = runCommand('/bin/bash', ['-c', 'sleep 30'], root, 10_000, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 50)); controller.abort();
  assert.equal((await interrupted).status, 'cancelled');
  assert.equal((await runCommand('/bin/bash', ['-c', `touch "${forbiddenFile}"`], root, 1000, controller.signal)).status, 'cancelled');
  await assert.rejects(access(forbiddenFile));
  const pending = runCommand('/bin/bash', ['-c', 'sleep 30'], root);
  await new Promise(resolve => setTimeout(resolve, 50));
  await stopTerminalCommands(); assert.equal((await pending).status, 'cancelled');
  await assert.rejects(runCommand('/bin/bash', ['-c', 'true'], root), /shutting down/);
  assert.equal(openMcpServerCount(), 0);
  console.log('PASS real terminal exit codes, credential isolation, bounded output, timeout and shutdown cleanup');
} finally {
  globalThis.fetch = originalFetch;
  await stopTerminalCommands(); await closeMcpServers();
  await rm(root, {recursive: true, force: true});
}
