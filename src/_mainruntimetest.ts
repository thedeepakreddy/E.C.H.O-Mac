import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {Brain, type BrainEventMap} from './brain/types.js';
import {BrainLifecycle, type BrainHandlers} from './brain/lifecycle.js';
import {PROVIDERS, unavailableReason} from './brain/switching.js';
import type {Provider} from './brain/index.js';
import {DEFAULTS_FOR_TESTS} from './config.js';
import {RuntimeTimers} from './runtime/timers.js';
import {controlSettingsFor, normalizeControlSettings} from './runtime/control-settings.js';
import {AutomaticTaskRouter,needsTaskDispatch} from './tasks/automatic.js';
import type {SupervisedState} from './tasks/supervisor.js';

let passed = 0;
async function test(name: string, body: () => unknown): Promise<void> {
  await body(); passed++; console.log(`PASS ${name}`);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => resolve = done);
  return {promise, resolve};
}
class FixtureBrain extends Brain {
  stops = 0;
  interrupts = 0;
  stopResult = Promise.resolve();
  send(): void {}
  interrupt(): void {this.interrupts++;}
  async stop(): Promise<void> {this.stops++; await this.stopResult;}
}
function fixture(options: Partial<ConstructorParameters<typeof BrainLifecycle>[1]> = {}) {
  const initial = new FixtureBrain();
  const candidates: FixtureBrain[] = [];
  const activated: Provider[] = [];
  const outputs: string[] = [];
  const manager = new BrainLifecycle({brain: initial, provider: 'claude'}, {
    create: provider => {const brain = new FixtureBrain(); candidates.push(brain); return {brain, provider};},
    unavailable: () => null,
    handlers: () => ({text: text => outputs.push(text), error: message => outputs.push(message)}),
    activated: instance => activated.push(instance.provider), stopTimeoutMs: 30,
    ...options,
  });
  return {manager, initial, candidates, activated, outputs};
}

await test('construction and availability failures preserve the foreground brain', async () => {
  for (const options of [{create: () => {throw Error('bad config');}}, {unavailable: () => 'missing key'}]) {
    const f = fixture(options);
    assert.equal((await f.manager.switch('openrouter')).ok, false);
    f.initial.emit('text', 'still usable');
    assert.deepEqual(f.outputs, ['still usable']); assert.equal(f.initial.stops, 0);
    await f.manager.close();
  }
});
await test('same-provider restart rebuilds, while ordinary selection preserves it', async () => {
  const f = fixture();
  assert.equal((await f.manager.switch('claude')).ok, true);
  assert.equal(f.candidates.length, 0);
  await f.manager.switch('claude', true);
  assert.equal(f.candidates.length, 1); assert.equal(f.initial.stops, 1);
  await f.manager.close(); assert.equal(f.candidates[0].stops, 1);
});
await test('switches coalesce and conflicting requests report busy', async () => {
  const f = fixture(); const held = deferred(); f.initial.stopResult = held.promise;
  const one = f.manager.switch('openai'); const two = f.manager.switch('openai');
  assert.equal(one, two); assert.equal((await f.manager.switch('gemini')).ok, false);
  const ready = f.manager.ready(); held.resolve();
  assert.equal((await one).provider, 'openai'); assert(await ready);
  assert.equal(f.candidates.length, 1); await f.manager.close();
});
await test('all current brain events route once; retired events and errors are isolated', async () => {
  const counts = new Map<string, number>();
  const payloads: BrainEventMap = {status: ['thinking'], text: ['hello'], textDelta: [{text: 'hel'}],
    textDone: [{text: 'hello'}], tool: [{name: 'read', summary: 'reading'}], risk: [{tool: 'read', tier: 'low', reason: 'fixture'}],
    turnEnd: [], error: ['fixture error'], progress: ['working']};
  const handlers = Object.fromEntries(Object.keys(payloads).map(event => [event, () => counts.set(event, (counts.get(event) ?? 0) + 1)])) as BrainHandlers;
  const f = fixture({handlers: () => handlers});
  const emit = (brain: Brain) => {for (const [event, args] of Object.entries(payloads)) brain.emit(event, ...args);};
  emit(f.initial); await f.manager.switch('gemini');
  emit(f.initial); emit(f.candidates[0]);
  assert(Object.keys(payloads).every(event => counts.get(event) === 2));
  await f.manager.close(); emit(f.candidates[0]);
  assert(Object.keys(payloads).every(event => counts.get(event) === 2));
});
await test('shutdown during replacement prevents candidate activation and closes once', async () => {
  const f = fixture(); const held = deferred(); f.initial.stopResult = held.promise;
  const switching = f.manager.switch('openrouter'); await Promise.resolve();
  const closing = f.manager.close(); assert.equal(closing, f.manager.close());
  held.resolve(); assert.equal((await switching).ok, false); await closing;
  assert.deepEqual(f.activated, ['claude']); assert.equal(f.initial.stops, 1);
  assert.equal(f.candidates[0].stops, 1); assert.equal(await f.manager.ready(), false);
  assert.equal((await f.manager.switch('gemini')).ok, false);
});
await test('a provider that ignores stop cannot hold a switch forever', async () => {
  const f = fixture(); f.initial.stopResult = new Promise(() => {});
  const started = Date.now(); assert.equal((await f.manager.switch('ollama')).ok, true);
  assert(Date.now() - started < 1000); await f.manager.close();
});
await test('failed replacement hooks dispose the candidate and preserve the old provider', async () => {
  const f = fixture({beforeReplace: () => {throw Error('hook failed');}});
  assert.equal((await f.manager.switch('openai')).ok, false);
  assert.equal(f.candidates[0].stops, 1); assert.equal(f.candidates[0].listenerCount('text'), 0);
  f.initial.emit('text', 'alive'); assert.deepEqual(f.outputs, ['alive']); await f.manager.close();
});
await test('activation notification and report failures do not leak providers', async () => {
  const f = fixture({activated: () => {throw Error('UI failed');}, report: () => {throw Error('logger failed');}});
  assert.equal((await f.manager.switch('openai')).ok, true);
  assert.equal(f.manager.provider, 'openai'); await f.manager.close();
  assert.equal(f.initial.stops, 1); assert.equal(f.candidates[0].stops, 1);
});
await test('settings accept every configured provider and reject malformed values', () => {
  const cfg = structuredClone(DEFAULTS_FOR_TESTS);
  const current = controlSettingsFor(cfg, '/fixture/config.json');
  for (const brain of PROVIDERS) assert.equal(normalizeControlSettings(current, {brain}).brain, brain);
  assert.equal(unavailableReason('openrouter', {}), "OPENROUTER_API_KEY isn't set");
  assert.equal(unavailableReason('openrouter', {CUSTOM_KEY: 'fixture'}, undefined, undefined, 'CUSTOM_KEY'), null);
  const next = normalizeControlSettings(current, {brain: 'invalid', configPath: '/escape', voice: {
    wakeWord: 'yes', maxSpokenSentences: -1, conversationWindowMs: Infinity, sttLanguage: 'invalid!', ttsEngine: 'unknown',
  }, memory: {retentionDays: 99999}} as any);
  assert.equal(next.brain, current.brain); assert.equal(next.voice.wakeWord, current.voice.wakeWord);
  assert.equal(next.voice.maxSpokenSentences, 0); assert.equal(next.voice.conversationWindowMs, current.voice.conversationWindowMs);
  assert.equal(next.voice.sttLanguage, current.voice.sttLanguage); assert.equal(next.voice.ttsEngine, current.voice.ttsEngine);
  assert.equal(next.memory.retentionDays, 3650); assert.equal(next.configPath, current.configPath);
  next.helpers.shadow = !current.helpers.shadow; assert.notEqual(next.helpers.shadow, current.helpers.shadow);
});

// Execute the real main callbacks without importing Electron or booting Echo.
// Extract complete AST nodes, so tests stay bound to the shipped implementation.
function declaration(path: string, name: string): string {
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name);
  assert(node, `Missing ${name}`); return node.getText(ast).replace(/^export /, '');
}
function runtime(names: string[], additions: Record<string, unknown> = {}) {
  const context: Record<string, any> = {
    console: {log() {}, error() {}}, cfg: {voice: {ttsEnabled: false}, agi: {escalation: {enabled: true, failureThreshold: 2}}},
    brain: {provider: 'ollama'}, ollamaFailureStreak: 0, lastAssistantText: '', lastBrainStatus: 'idle', expectAnswer: false,
    voiceSession: {noteBrainDone() {}}, remoteRecord() {}, endAutoReflex() {}, finishTurn() {}, publishControlUpdate() {},
    maybeAutoListen() {}, send() {}, tts: {say() {}}, shuttingDown: false, inputRevision: 0,
    telegram: undefined, automaticTasks: {control:()=>null,handle:()=>null},
    currentScope:()=>({}), captureAllowed:()=>true, ...additions,
  };
  const functions = names.map(name => declaration('src/main.ts', name)).join('\n');
  const code = `${declaration('src/control-panel.ts', 'ControlTelemetry')}\n${functions}\n`;
  vm.createContext(context);
  vm.runInContext(ts.transpile(code, {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}), context);
  context.controlTelemetry = vm.runInContext('new ControlTelemetry()', context);
  return context;
}
await test('real main callbacks cannot complete or fail the next queued task after an error', () => {
  const context = runtime(['brainHandlers', 'maybeEscalateBrain']);
  context.switchBrain = async () => 'switched';
  const telemetry = context.controlTelemetry;
  telemetry.beginTask('failed turn'); telemetry.beginTask('next turn');
  const handlers = context.brainHandlers(); handlers.error('first error'); handlers.error('second error'); handlers.turnEnd();
  assert.equal(telemetry.tasks[0].status, 'failed'); assert.equal(telemetry.tasks[1].status, 'working');
  assert.equal(telemetry.completedTasks, 0); assert.equal(context.ollamaFailureStreak, 1);
  handlers.turnEnd(); assert.equal(telemetry.tasks[1].status, 'done'); assert.equal(context.ollamaFailureStreak, 0);
});
await test('real main callbacks escalate only after consecutive failed local turns', async () => {
  let switches = 0;
  const context = runtime(['brainHandlers', 'maybeEscalateBrain'], {switchBrain: async () => {switches++; return 'switched';}});
  const handlers = context.brainHandlers();
  handlers.error('failed one'); handlers.turnEnd(); assert.equal(switches, 0);
  handlers.error('failed two'); handlers.turnEnd(); await Promise.resolve(); assert.equal(switches, 1);
});
await test('OpenRouter model selection persists before forcing replacement of the same provider', async () => {
  const stored: any[] = [], switched: any[] = [];
  const context = runtime(['handleControlAction'], {
    cfg: {brain: 'openrouter', openrouter: {model: 'old'}}, brain: {provider: 'openrouter'},
    openRouterModels: [{id: 'new'}], readMutableConfigBase: () => ({openrouter: {apiKeyEnv: 'CUSTOM_KEY'}}),
    writeMutableConfig: (data: any) => stored.push(structuredClone(data)),
    brainLifecycle: {switch: async (...args: any[]) => {assert.equal(stored[0].openrouter.model, 'new'); switched.push(args); return {ok: true};}},
  });
  assert.equal((await context.handleControlAction({type: 'openrouter-set-model', name: 'new'})).ok, true);
  assert.deepEqual(switched, [['openrouter', true]]); assert.equal(stored[0].openrouter.apiKeyEnv, 'CUSTOM_KEY');
  assert.equal((await context.handleControlAction({type: 'openrouter-set-model', name: 'invalid'})).ok, false);
  assert.equal(stored.length, 1);
});
await test('stopping or replacing a brain discards delayed build dispatch results', async () => {
  for (const change of ['stop', 'replace', 'shutdown']) {
    const held = deferred(); let sent = 0;
    const context = runtime(['dispatchToBrain'], {handleBuildInput: async () => {await held.promise; return null;},
      dispatchToBrainUnchecked: () => sent++, brainLifecycle: undefined});
    context.dispatchToBrain('build fixture');
    if (change === 'stop') context.inputRevision++;
    if (change === 'replace') context.brain = {provider: 'openai'};
    if (change === 'shutdown') context.shuttingDown = true;
    held.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 0);
  }
});
await test('natural long tasks enter supervision once on every foreground provider and input modality', async () => {
  for(const provider of PROVIDERS)for(const modality of ['voice','text']) {
    let starts=0,normal=0,spoken='';
    const router=new AutomaticTaskRouter({current:()=>null,latest:()=>null,cancel:async()=>{},start:spec=>{
      starts++;assert.equal(spec.scope?.projectId,'fixture');assert.equal(spec.privateMode,true);
      return {id:'supervised.fixture',goal:spec.goal,status:'executing',spec} as SupervisedState;
    }});
    const context=runtime(['dispatchToBrain'],{brain:{provider},brainLifecycle:undefined,automaticTasks:router,
      handleBuildInput:async()=>null,dispatchToBrainUnchecked:()=>normal++,currentScope:()=>({projectId:'fixture'}),captureAllowed:()=>false,
      speech:undefined,voiceSession:{noteBrainSend(){},noteBrainText(){},noteBrainDone(){}},tts:{say:(text:string)=>spoken=text},finishLocalTurn(){}});
    context.dispatchToBrain('Build a StudyForge app with login, lessons, a database and tests.',undefined,null,modality);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(starts,1,`${provider}/${modality}`);assert.equal(normal,0);assert.match(spoken,/started/);
  }
});
await test('saved supervisor progress takes precedence over old coding status without a model call', async()=>{
  let legacy=0,spoken='';
  const context=runtime(['dispatchToBrain'],{brainLifecycle:undefined,automaticTasks:{control:()=> 'The inspector is verifying the task.',handle:()=>{throw Error('No new task');}},
    handleBuildInput:async()=>{legacy++;return 'No coding worker is active';},speech:undefined,
    voiceSession:{noteBrainSend(){},noteBrainText(){},noteBrainDone(){}},tts:{say:(text:string)=>spoken=text},finishLocalTurn(){}});
  context.dispatchToBrain('did you finish?');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(legacy,0);assert.match(spoken,/inspector/);
});
await test('voice-only transport cannot capture a recognized long task or status request',async()=>{
  let connections=0;
  const context=runtime(['dispatchToRealtime'],{needsTaskDispatch,ensureRealtime:async()=>{connections++;return null;}});
  assert.equal(await context.dispatchToRealtime('fixture.wav',null,'Build a calculator app.'),false);
  assert.equal(await context.dispatchToRealtime('fixture.wav',null,'did you finish?'),false);
  assert.equal(connections,0);
  assert.equal(await context.dispatchToRealtime('fixture.wav',null,'Hello'),false);assert.equal(connections,1);
});
await test('text requests arriving during a switch wait and respect a subsequent stop', async () => {
  for (const cancel of [false, true]) {
    const held = deferred(); let sends = 0;
    const manager = {isSwitching: true, ready: async () => {await held.promise; return true;}};
    const context = runtime(['handleTypedInput'], {
      brainLifecycle: manager, maybeAnswerConfirmation: () => false, maybeMemoryCommand: async () => false,
      maybeQuickReply: () => false, maybeSwitchBrain: async () => false, refreshScope: async () => {},
      beginLearnedTurn() {}, dispatchToBrain: () => sends++, voiceSession: {beginTurn: () => ({id: 'fixture'})},
    });
    context.handleTypedInput('hello'); assert.equal(sends, 0);
    if (cancel) context.inputRevision++;
    manager.isSwitching = false; held.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(sends, cancel ? 0 : 1);
  }
});
await test('credential changes wait for a pending switch and rebuild the provider holding them', async () => {
  for (const available of [true, false]) {
    const held = deferred(); const calls: unknown[][] = [];
    const lifecycle = {provider: 'claude', ready: async () => {await held.promise; return true;},
      switch: async (...args: unknown[]) => {calls.push(args); return {message: 'updated'};}};
    const context = runtime(['refreshCredentialBrain'], {brainLifecycle: lifecycle, brainUnavailable: () => available ? null : 'missing'});
    const pending = context.refreshCredentialBrain('openrouter'); assert.equal(calls.length, 0);
    lifecycle.provider = 'openrouter'; held.resolve(); assert.equal(await pending, 'updated');
    assert.deepEqual(calls, [[available ? 'openrouter' : 'claude', available]]);
  }
});
await test('real sign-out action removes one key and retires its active credential brain', async () => {
  let saved: unknown, refreshed = '';
  const context = runtime(['handleControlAction'], {
    cfg: {openrouter: {apiKeyEnv: 'ROUTER_KEY'}}, process: {env: {ROUTER_KEY: 'fixture'}},
    readKeys: () => ({ROUTER_KEY: 'fixture', OTHER_KEY: 'preserve'}), writeKeys: (keys: unknown) => saved = keys,
    refreshCredentialBrain: async (provider: string) => {refreshed = provider; return 'Now running on Claude.';},
  });
  const result = await context.handleControlAction({type: 'openrouter-sign-out'});
  assert.equal(result.ok, true); assert.equal(refreshed, 'openrouter');
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), {ROUTER_KEY: '', OTHER_KEY: 'preserve'});
  assert.equal(context.process.env.ROUTER_KEY, undefined);
});
await test('saving unrelated keys preserves the current task on every provider', async () => {
  for (const provider of PROVIDERS) {
    const refreshes: string[] = [];
    const config = {gemini: {apiKeyEnv: 'GEMINI_KEY'}, openai: {apiKeyEnv: 'OPENAI_KEY'}, openrouter: {apiKeyEnv: 'ROUTER_KEY'}};
    const context = runtime(['refreshChangedKeys'], {cfg: config, brainLifecycle: {provider, ready: async () => true},
      refreshCredentialBrain: async (name: string) => {refreshes.push(name); return 'updated';}});
    assert.equal(await context.refreshChangedKeys(['VERCEL_TOKEN']), ''); assert.equal(refreshes.length, 0);
    const key = {claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_KEY', openai: 'OPENAI_KEY', openrouter: 'ROUTER_KEY', ollama: ''}[provider];
    assert.equal(await context.refreshChangedKeys([key]), provider === 'ollama' ? '' : 'updated');
    assert.equal(refreshes.length, provider === 'ollama' ? 0 : 1);
  }
});
await test('slow background polls cannot overlap or restart after shutdown', async () => {
  const timers = new RuntimeTimers(); const held = deferred(); const started = deferred(); let polls = 0;
  timers.every(5, async () => {polls++; started.resolve(); await held.promise;});
  // A ref'ed deadline also keeps this test alive while production timers are unref'ed.
  const deadline = setTimeout(() => {throw Error('Poll did not start');}, 1000);
  try {
    await started.promise; await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(polls, 1);
    timers.close(); held.resolve(); timers.every(5, () => polls++);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(polls, 1);
  } finally {clearTimeout(deadline); timers.close(); held.resolve();}
});
console.log(`\n${passed}/${passed} main runtime regression groups passed`);
