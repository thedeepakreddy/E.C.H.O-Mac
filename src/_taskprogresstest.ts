import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'echo-task-progress-'));
process.env.ECHO_DATA_ROOT = root;
process.env.ECHO_MEMORY_ROOT = join(root, 'memory');
process.env.ECHO_LOG_DIR = join(root, 'runs');
process.env.ECHO_MCP = '0';
process.env.ECHO_LOG_QUIET = '1';
const {runGated} = await import('./safety/gate.js');
const {runWithReadReuse} = await import('./memory/read-cache.js');
const {compactToolResult} = await import('./memory/tool-context.js');
const {ExternalToolCatalog} = await import('./brain/external-tool-catalog.js');
const {mcpToolOutput, mcpToolDef} = await import('./brain/mcp.js');
const {TaskCoordinator} = await import('./memory/task-state.js');
const {Brain} = await import('./brain/types.js');
const {RecordingBrain} = await import('./agent-replay/runtime.js');
const {currentAgentRunContext} = await import('./agent-replay/context.js');
const {currentLoop} = await import('./agent-replay/loop-log.js');
const {taskCoordinator} = await import('./memory/task-state.js');
const {createInvocation, runInInvocation} = await import('./memory/invocation.js');
const {runInAgentContext} = await import('./agent-replay/context.js');
const {TOOLS} = await import('./tools/registry.js');
try {
  const {createRecoveryCheckpoint, writeRecoveryCheckpoint, pendingRecoveryCheckpoints} = await import('./agent-replay/recovery.js');
  const recoveryRoot = join(root, 'startup');
  for (const name of ['old', 'recent', 'exhausted']) mkdirSync(join(recoveryRoot, name), {recursive: true});
  const old = createRecoveryCheckpoint({id: 'startup-main', name: 'Echo', kind: 'main'}, 'Old command', 2);
  old.createdAt = 100; old.status = 'pending'; writeRecoveryCheckpoint(join(recoveryRoot, 'old'), old);
  const recent = createRecoveryCheckpoint(old.actor, 'New completed command', 2);
  recent.createdAt = 200; recent.status = 'completed'; writeRecoveryCheckpoint(join(recoveryRoot, 'recent'), recent);
  const exhausted = createRecoveryCheckpoint({id: 'startup-clone', name: 'Clone', kind: 'clone'}, 'Exhausted command', 2);
  exhausted.recoveryAttempts = 2; exhausted.status = 'pending'; writeRecoveryCheckpoint(join(recoveryRoot, 'exhausted'), exhausted);
  assert.equal(pendingRecoveryCheckpoints(recoveryRoot).length, 0, 'superseded main tasks and exhausted retries must not select another brain on startup');
  const task = taskCoordinator.create({ownerActorId: 'fixture', goal: 'Check my inbox'});
  const read = createInvocation(task.taskId, 'fixture', 'mcp__composio__GMAIL_FETCH_EMAILS');
  taskCoordinator.startCall(read, 'mcp__composio__GMAIL_FETCH_EMAILS');
  taskCoordinator.endCall(read, {status: 'success', verification: 'verified', verificationRefs: ['fixture-inbox'], text: 'Five unread emails.'});
  const self = createInvocation(task.taskId, 'fixture', 'inspect_task');
  taskCoordinator.startCall(self, 'inspect_task');
  const out = await runInAgentContext({taskId: task.taskId, identity: {id: 'fixture'}} as any,
    () => runInInvocation(self, () => TOOLS.find(t => t.name === 'inspect_task')!.handler({})));
  assert.doesNotMatch(out.text!, /inspect_task \(running\)/, 'inspection must not report itself as an unresolved external action');
  assert.match(out.text!, /0 unresolved/);
  console.log('PASS inspecting progress does not create a false unresolved action');

  taskCoordinator.endCall(self, out);
  assert.equal(taskCoordinator.finish(task.taskId, {status: 'completed'}).status, 'completed');
  const {isEchoItself} = await import('./voice/interjection.js');
  assert.equal(isEchoItself("You're signed into open router. IP code 185 five grants access.", 'You are signed in to OpenRouter. API code 1855 grants access.'), true, 'spoken contractions and split service names remain recognizable');
  assert.equal(isEchoItself('no open my other inbox instead', 'Your inbox has five messages.'), false);
  const t = taskCoordinator.create({taskId: 'aabbccdd-aabb-4cdd-abcd-123456789012', ownerActorId: 'fixture', goal: 'Read messages and save a report'});
  const context = {taskId: t.taskId, identity: {id: 'fixture'}} as any;
  let executed = 0, stopped = 0;
  context.onNoProgress = () => {stopped++;};
  const def = {name: 'mcp__composio__GMAIL_FETCH_EMAILS', readOnly: true} as any;
  const original = JSON.stringify({successfull: true, messages: [{id: 'message-1', subject: 'Fixture subject', body: '<html><style>hidden css</style><body><p>Fixture message</p>' + '<div>full archived detail</div>'.repeat(6000) + '</body></html>'}]});
  let invocationSequence = 0;
  const invoke = async (definition = def, args = {}) => {
    // Deterministically exercise numeric UUID groups that resemble card data.
    const callId = invocationSequence++ === 0 ? 'dddddddd-dddd-4ddd-1234-123456789012' : undefined;
    const inv = createInvocation(t.taskId, 'fixture', definition.name, args, process.cwd(), callId);
    taskCoordinator.startCall(inv, definition.name, definition.readOnly ? 'observation' : 'action');
    const value = await runWithReadReuse(context, definition, args, inv.callId, async () => {executed++; return {status: 'success', text: original} as any;});
    taskCoordinator.endCall(inv, value);
    return {value, inv};
  };
  const first = await invoke();
  assert.equal(first.value.verification, 'verified');
  assert.equal(taskCoordinator.get(t.taskId)!.calls[first.inv.callId].result!.verificationRefs![0], `observation:${t.taskId}:${first.inv.callId}`);
  assert.ok(compactToolResult(first.value).text!.length < 11000);
  assert.match(compactToolResult(first.value).text!, /Fixture subject/);
  assert.doesNotMatch(compactToolResult(first.value).text!, /hidden css/);
  assert.equal(taskCoordinator.readCallResult(t.taskId, first.inv.callId)!.text, original);
  assert.equal(new TaskCoordinator().readCallResult(t.taskId, first.inv.callId)!.text, original);
  for (let i = 0; i < 4; i++) assert.equal((await invoke()).value.status, 'success');
  assert.equal(executed, 1, 'repeated reads reuse original result');
  assert.equal((await invoke()).value.error?.category, 'no_progress');
  assert.equal(stopped, 1);
  context.observationEpoch = 1;
  await invoke(); assert.equal(executed, 2, 'explicit refresh fetches again');
  await invoke(def, {query: 'new'}); assert.equal(executed, 3, 'different inputs fetch independently');
  const write = {name: 'write_local_file', readOnly: false};
  await invoke(write); await invoke(write); assert.equal(executed, 5, 'actions are never cached');
  await invoke(); assert.equal(executed, 6, 'actions invalidate saved reads');
  assert.equal(taskCoordinator.finish(t.taskId, {status: 'completed'}).status, 'verifying', 'read evidence cannot verify a write');
  taskCoordinator.recordVerification(t.taskId, first.value.verificationRefs!);
  assert.equal(taskCoordinator.get(t.taskId)!.status, 'verifying');
  const planInv = createInvocation(t.taskId, 'fixture', 'update_task_plan');
  taskCoordinator.updatePlan(planInv, [{id: 'read', description: 'Read inbox', status: 'completed', verificationRefs: first.value.verificationRefs}, {id: 'report', description: 'Save report', status: 'pending', dependsOn: ['read']}]);
  assert.equal(new TaskCoordinator().get(t.taskId)!.steps.read.status, 'completed');
  assert.throws(() => taskCoordinator.updatePlan(planInv, [{id: 'read', description: 'Read', status: 'pending'}]), /erased/);
  assert.throws(() => taskCoordinator.updatePlan(planInv, [{id: 'report', description: 'Report', status: 'completed', verificationRefs: ['invented']}]), /evidence/);
  assert.throws(() => taskCoordinator.updatePlan(planInv, [{id: 'a', description: 'A', status: 'pending', dependsOn: ['b']}, {id: 'b', description: 'B', status: 'pending', dependsOn: ['a']}]), /cycle/);
  assert.equal(taskCoordinator.finish(t.taskId, {status: 'completed', verificationRefs: ['fixture-write-proof']}).status, 'verifying', 'pending plan steps prevent a completion claim');
  const freshness = taskCoordinator.create({ownerActorId: 'fixture', goal: 'Fresh observations'});
  const freshnessContext = {taskId: freshness.taskId, identity: {id: 'fixture'}} as any;
  let observations = 0;
  const fresh = async (status = 'success') => {
    const inv = createInvocation(freshness.taskId, 'fixture', def.name);
    taskCoordinator.startCall(inv, def.name, 'observation');
    const value = await runWithReadReuse(freshnessContext, def, {}, inv.callId, async () => {observations++; await new Promise(resolve => setImmediate(resolve)); return {status, text: 'fresh fixture'} as any;});
    taskCoordinator.endCall(inv, value); return value;
  };
  await fresh('failed'); await fresh('failed');
  assert.equal(observations, 2, 'failed reads are not reused');
  await Promise.all([fresh(), fresh(), fresh()]);
  assert.equal(observations, 3, 'simultaneous identical reads share one observation');
  const clock = Date.now;
  Date.now = () => clock() + 31000;
  try {await fresh();} finally {Date.now = clock;}
  assert.equal(observations, 4, 'reuse does not extend original observation freshness');
  Date.now = () => clock() + 62000;
  try {
    let latest: any;
    for (let i = 0; i < 5; i++) latest = await fresh();
    assert.equal(latest.error?.category, 'no_progress', 'unchanged results still stop loops when requests outlast cache TTL');
  } finally {Date.now = clock;}
  const privateTask = taskCoordinator.create({ownerActorId: 'fixture', goal: 'Private read', privateMode: true});
  const priv = createInvocation(privateTask.taskId, 'fixture', 'private_read');
  taskCoordinator.startCall(priv, 'private_read', 'observation'); taskCoordinator.endCall(priv, {status: 'success', text: original});
  assert.equal(taskCoordinator.readCallResult(privateTask.taskId, priv.callId)!.text, original);
  assert.equal(existsSync(join(root, 'memory', 'tasks', privateTask.taskId)), false);
  taskCoordinator.forget(t.taskId);
  assert.equal(taskCoordinator.readCallResult(t.taskId, first.inv.callId), undefined);
  assert.equal(existsSync(join(root, 'memory', 'tasks', t.taskId, 'results')), false);
  console.log('PASS read reuse, bounded context, archived originals, privacy, deletion and durable verified plans');
  const handles = Array.from({length: 100}, (_, i) => ({name: i === 99 ? 'mcp__composio__GMAIL_FETCH_EMAILS' : `mcp__fixture__PRODUCT_${i}`, description: i === 99 ? 'Fetch gmail inbox email messages' : 'Unrelated product schema', inputSchema: {type: 'object'}, invoke: async () => ({})})) as any;
  const catalog = new ExternalToolCatalog(handles);
  await catalog.begin('Check my inbox');
  assert.ok(catalog.selected.has(handles[99].name)); assert.ok(catalog.selected.size <= 8);
  await catalog.discover(handles[50].name); assert.ok(catalog.selected.has(handles[50].name));
  assert.equal(mcpToolOutput({content: [{type: 'text', text: '{"successfull":false,"error":"failed"}'}]}).status, 'failed');
  assert.equal(mcpToolDef(handles[99]).readOnly, true);
  console.log('PASS external schema discovery and nested MCP failure handling');
  const {OpenAIBrain} = await import('./brain/openai.js');
  const {DEFAULTS_FOR_TESTS} = await import('./config.js');
  const cfg = structuredClone(DEFAULTS_FOR_TESTS);
  cfg.agi.toolPruning.enabled = false;
  const provider = new OpenAIBrain(cfg, {via: 'apiKey', key: 'fixture'}, {allowedTools: new Set(['inspect_task', 'read_tool_result', 'discover_tools', 'mcp__composio__GMAIL_FETCH_EMAILS'])});
  const requests: any[] = []; let fetches = 0;
  const connected = handles.map((handle: any) => ({...handle, call: async () => {fetches++; return {status: 'success', text: original};}}));
  (provider as any).mcpInitialized = true;
  (provider as any).mcpTools = new Map(connected.map((handle: any) => [handle.name, handle]));
  (provider as any).tools.push(...connected.map((handle: any) => ({type: 'function', name: handle.name, description: handle.description, parameters: {type: 'object', properties: {padding: {type: 'string', description: 'schema padding '.repeat(500)}}}})));
  (provider as any).streamResponse = async (request: any) => {
    requests.push(structuredClone(request));
    const step = requests.length;
    return {output: step < 3 ? [{type: 'function_call', call_id: `fixture-${step}`, name: step === 1 ? connected[99].name : 'inspect_task', arguments: '{}'}] : [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Here are the fixture inbox results.'}]}], usage: {}};
  };
  const real = new RecordingBrain(provider, 'openai', {}, {autoResume: false});
  const finished = new Promise<void>(resolve => real.once('turnEnd', resolve));
  real.send('Check my inbox'); await finished;
  assert.equal(requests.length, 3); assert.equal(fetches, 1);
  assert.equal(requests[0].tools.filter((tool: any) => tool.name.startsWith('mcp__')).length, 1);
  assert.ok(JSON.stringify(requests[0].tools).length < 14000, 'only relevant external schemas reach the request');
  const wire = requests[1].input.find((item: any) => item.type === 'function_call_output');
  assert.ok(wire.output.length < 12000, 'actual Responses loop sends bounded result');
  assert.match(requests[2].input.find((item: any) => item.call_id === 'fixture-2' && item.type === 'function_call_output').output, /0 unresolved/);
  assert.equal(taskCoordinator.list().find(row => row.goal === 'Check my inbox' && row.ownerActorId !== 'fixture')!.status, 'completed');
  await real.stop();
  console.log('PASS real Responses loop + safety gate completes one inbox read with a small request');
  class LoopBrain extends Brain {
    done?: Promise<void>; interrupted = false; lateAction = false;
    send() {
      this.done = (async () => {
        const run = currentAgentRunContext()!;
        for (let n = 0; n < 20 && !this.interrupted; n++) {
          const inv = createInvocation(run.taskId, run.identity.id, def.name);
          taskCoordinator.startCall(inv, def.name, 'observation');
          const value = await runWithReadReuse(run, def, {}, inv.callId, async () => ({status: 'success', text: 'Fixture inbox'}));
          taskCoordinator.endCall(inv, value);
        }
        if (this.interrupted) {
          const refused = await runGated({name: 'write_local_file', readOnly: false, schema: {}, description: 'fixture', handler: async () => {this.lateAction = true; return {text: 'written'};}}, {}, {workingDir: root, emit: () => {}});
          assert.equal(refused.status, 'cancelled');
        }
        if (!this.interrupted) currentLoop()?.exit('completed');
        this.emitEvent('turnEnd');
      })();
    }
    interrupt() {this.interrupted = true;}
    async stop() {}
  }
  const probe = new LoopBrain();
  const runtime = new RecordingBrain(probe, 'test', {}, {autoResume: true});
  let ends = 0; runtime.on('turnEnd', () => {ends++;});
  runtime.send('Check fixture inbox'); await probe.done;
  assert.equal(probe.interrupted, true); assert.equal(probe.lateAction, false, 'loop stop prevents later queued actions');
  assert.equal(ends, 1, 'one terminal event after loop guard');
  const loopTask = taskCoordinator.list().find(row => row.goal === 'Check fixture inbox')!;
  assert.equal(loopTask.status, 'blocked');
  assert.ok(Object.keys(loopTask.calls).length <= 6, 'guard bounds repeated requests');
  await runtime.stop();
  console.log('PASS real RecordingBrain stops a repeating loop without automatic recovery');
} finally { rmSync(root, {recursive: true, force: true}); }
