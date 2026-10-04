/** Intelligence tool availability, pruning and bounded local schemas. No live model calls. */
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'echo-intel-wiring-'));
process.env.ECHO_DATA_ROOT = root;
process.env.ECHO_MEMORY_ROOT = join(root, 'memory');
process.env.ECHO_MCP = '0';
process.env.ECHO_LOG_QUIET = '1';
process.env.OSIRIS_URL = 'https://osiris.example';
const {DEFAULTS_FOR_TESTS} = await import('./config.js');
const {OllamaBrain} = await import('./brain/ollama.js');
const {OpenAIBrain} = await import('./brain/openai.js');
const {GeminiBrain} = await import('./brain/gemini.js');
const {RealtimeVoiceSession} = await import('./voice/realtime.js');
const {selectToolNames} = await import('./brain/tool-router.js');
const {TOOLS} = await import('./tools/registry.js');
const {RecordingBrain} = await import('./agent-replay/runtime.js');
const {ClaudeBrain} = await import('./brain/claude.js');
const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport} = await import('@modelcontextprotocol/sdk/inMemory.js');
const {clearIntelCache} = await import('./tools/intel-feeds.js');
const {runInAgentContext} = await import('./agent-replay/context.js');
const {runInInvocation, createInvocation} = await import('./memory/invocation.js');
const {taskCoordinator} = await import('./memory/task-state.js');
const {compactToolResult} = await import('./memory/tool-context.js');
const {fitLocalTools} = await import('./brain/localtools.js');
const cfg = structuredClone(DEFAULTS_FOR_TESTS);
const cases: Array<[string, string]> = [
  ['Where is the ISS and when does it pass over Budapest?', 'open_intel'],
  ['What is the world news about India?', 'open_intel'],
  ['Find a pharmacy nearby in Budapest', 'open_intel'],
  ['Who owns 8.8.8.8 and AS15169?', 'open_intel'],
  ['ప్రపంచ వార్తలు చెప్పు', 'open_intel'],
  ['आसपास की फार्मेसी खोजो', 'open_intel'],
  ['Which CVEs are being actively exploited?', 'open_intel'],
  ['Read the Osiris earthquakes near Tokyo', 'osiris_intel'],
  ['Show live CCTV cameras in the US', 'osiris_intel'],
  ['Open Osiris world map', 'show_osiris'],
  ['Turn on the military satellite layer in Osiris', 'osiris_layers'],
  ['Focus Osiris on Budapest', 'osiris_focus'],
];
try {
 const local = new OllamaBrain(cfg) as any;
 assert.ok(local.tools.some((t: any) => t.function.name === 'open_intel'), 'Ollama must expose the five open intelligence sources');
 for (const [query, expected] of cases) {
  const keep = await selectToolNames(query, 1);
  assert.ok(!keep || keep.has(expected), `${query}: ${expected} must survive pruning`);
  const narrow = fitLocalTools(local.tools.filter((t: any) => !keep || keep.has(t.function.name)), query, 1200);
  assert.ok(narrow.some((t: any) => t.function.name === expected), `${query}: ${expected} must survive the local RAM budget`);
 }
 const localIntel = fitLocalTools(local.tools, cases[4][0], 1200).find((t: any) => t.function.name === 'open_intel');
 for (const source of ['satellites', 'news', 'nearby', 'network', 'exploited']) assert.match(localIntel.function.description, new RegExp(source), `local description must explain ${source}`);
 const cloud = [new OpenAIBrain(cfg, {via: 'apiKey', key: 'fixture'}), new OpenAIBrain({...cfg, openai: {...cfg.openai, model: 'fixture-openrouter'}}, {via: 'apiKey', key: 'fixture'}), new GeminiBrain(cfg, 'fixture')];
 for (const provider of cloud) {
  const names = ((provider as any).tools ?? (provider as any).functionDeclarations).map((t: any) => t.name);
  for (const name of new Set(cases.map(c => c[1]))) assert.ok(names.includes(name), `cloud declaration missing ${name}`);
  await provider.stop();
 }
 const voice = new RealtimeVoiceSession(cfg, 'fixture', {workingDir: root});
 const names = (voice as any).declarations().map((t: any) => t.name);
 for (const name of new Set(cases.map(c => c[1]))) assert.ok(names.includes(name), `Live voice declaration missing ${name}`);
 voice.close();
 const originalFetch = globalThis.fetch;
 const intelligenceCalls = [
  {source: 'satellites', query: 'ISS over 47.4979,19.0402'},
  {source: 'news', query: 'fixture topic'},
  {source: 'nearby', query: 'pharmacy near 47.4979,19.0402'},
  {source: 'network', query: 'AS15169'},
  {source: 'exploited', query: 'FixtureVendor'},
 ];
 globalThis.fetch = (async (input: any) => {
  const url = String(input);
  let data: any;
  if (url.includes('celestrak')) data = [{OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, EPOCH: '2026-10-01T12:00:00.000000', MEAN_MOTION: 15.49, ECCENTRICITY: .0004, INCLINATION: 51.64, RA_OF_ASC_NODE: 100, ARG_OF_PERICENTER: 50, MEAN_ANOMALY: 150, BSTAR: .0001, MEAN_MOTION_DOT: .00001, MEAN_MOTION_DDOT: 0}];
  else if (url.includes('gdelt')) data = {articles: [{title: 'Fixture headline', url: 'https://example.org/news', language: 'English'}]};
  else if (url.includes('overpass')) data = {elements: [{lat: 47.498, lon: 19.04, tags: {name: 'Fixture pharmacy'}}]};
  else if (url.includes('as-overview')) data = {data: {holder: 'Fixture network', announced: true}};
  else if (url.includes('announced-prefixes')) data = {data: {prefixes: [{prefix: '8.8.8.0/24'}]}};
  else if (url.includes('cisa.gov')) data = {vulnerabilities: [{cveID: 'CVE-2026-0001', vendorProject: 'FixtureVendor', product: 'Fixture product', vulnerabilityName: 'Fixture vulnerability', dateAdded: '2026-10-01'}]};
  else if (url.includes('/api/earthquakes')) data = {earthquakes: [], error: 'fixture upstream unavailable'};
  else throw new Error(`Unmocked request ${new URL(url).hostname}`);
  return new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}});
 }) as typeof fetch;
 try {
  clearIntelCache();
  for (const [label, provider] of [['openai', new OpenAIBrain(cfg, {via: 'apiKey', key: 'fixture'})], ['openrouter', new OpenAIBrain(cfg, {via: 'apiKey', key: 'fixture'})], ['gemini', new GeminiBrain(cfg, 'fixture')]] as const) {
   const snapshots: any[] = []; const p = provider as any;
   p.mcpInitialized = true;
   const exchange = (request: any) => {
    snapshots.push(structuredClone(request));
    if (label === 'gemini') return {candidates: [{finishReason: 'STOP', content: {role: 'model', parts: snapshots.length === 1 ? intelligenceCalls.map(args => ({functionCall: {name: 'open_intel', args}})) : [{text: 'Here are the fixture intelligence results.'}]}}]};
    return {output: snapshots.length === 1 ? intelligenceCalls.map((args, index) => ({type: 'function_call', call_id: `intel-${index}`, name: 'open_intel', arguments: JSON.stringify(args)})) : [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Here are the fixture intelligence results.'}]}], usage: {}};
   };
   if (label === 'gemini') p.generateStreaming = async (request: any) => exchange(request);
   else p.streamResponse = async (request: any) => exchange(request);
   const runtime = new RecordingBrain(provider, label, {}, {autoResume: false});
   const done = new Promise<void>(resolve => runtime.once('turnEnd', resolve));
   runtime.send('Check satellites, world news, nearby pharmacy, network ownership and exploited CVEs');
   await done;
   const outputs = label === 'gemini' ? snapshots[1].contents.flatMap((c: any) => c.parts ?? []).filter((part: any) => part.functionResponse).map((part: any) => part.functionResponse.response) : snapshots[1].input.filter((item: any) => item.type === 'function_call_output').map((item: any) => JSON.parse(item.output));
   assert.equal(outputs.length, 5, `${label} must return all five tool results`);
   assert.ok(outputs.every((out: any) => out.status === 'success'), `${label}: ${JSON.stringify(outputs.map((out: any) => [out.status, out.error]))}`);
   await runtime.stop();
  }
  for (const args of intelligenceCalls) {
   const result = JSON.parse(await local.invokeTool('open_intel', args));
   assert.equal(result.status, 'success', `Ollama call for ${args.source}`);
  }
  const sdk = (new ClaudeBrain(cfg) as any).buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await sdk.instance.connect(serverTransport);
  const client = new Client({name: 'echo-intel-test', version: '1'}, {capabilities: {}});
  await client.connect(clientTransport);
  const sdkNames = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of new Set(cases.map(c => c[1]))) assert.ok(sdkNames.includes(name), `Claude SDK declaration missing ${name}`);
  for (const args of intelligenceCalls) {
   const result = await client.callTool({name: 'open_intel', arguments: args});
   assert.equal(result.isError, false, `Claude SDK call for ${args.source}`);
   assert.equal(JSON.parse((result.content as any[])[0].text).status, 'success');
  }
  await client.close(); await sdk.instance.close();
  const sent: any[] = [];
  const live = new RealtimeVoiceSession(cfg, 'fixture', {workingDir: root, transport: async () => ({sendToolResponse: (response: any) => sent.push(response), sendClientContent() {}, sendRealtimeInput() {}, close() {}})});
  await live.connect();
  await (live as any).runTools(intelligenceCalls.map((args, index) => ({id: `live-${index}`, name: 'open_intel', args})));
  assert.equal(sent[0].functionResponses.length, 5);
  assert.ok(sent[0].functionResponses.every((response: any) => response.response.status === 'success'));
  live.close();
  const missing = await TOOLS.find(tool => tool.name === 'osiris_intel')!.handler({feed: 'made-up-feed'});
  assert.equal(missing.status, 'failed');
  const unavailable = await TOOLS.find(tool => tool.name === 'osiris_intel')!.handler({feed: 'earthquakes'});
  assert.equal(unavailable.status, 'failed', 'HTTP 200 with an upstream error must not become successful evidence');
  const archiveTask = taskCoordinator.create({ownerActorId: 'fixture', goal: 'Structured intelligence evidence'});
  const inv = createInvocation(archiveTask.taskId, 'fixture', 'open_intel');
  taskCoordinator.startCall(inv, 'open_intel', 'observation');
  const structured = {status: 'success' as const, text: 'Fixture CVE summary', data: {records: Array.from({length: 100}, (_, i) => ({cveID: `CVE-fixture-${i}`, detail: 'full evidence '.repeat(100)}))}};
  taskCoordinator.endCall(inv, structured);
  assert.ok(compactToolResult(structured).data, 'model keeps an excerpt of structured intelligence evidence');
  const read = await runInAgentContext({taskId: archiveTask.taskId, identity: {id: 'fixture'}} as any, () => runInInvocation(inv, () => TOOLS.find(tool => tool.name === 'read_tool_result')!.handler({callId: inv.callId, limit: 12000})));
  assert.match(read.text!, /CVE-fixture-0/);
  const expectedPage = JSON.stringify({text: structured.text, data: structured.data}).slice(0, 6000);
  assert.equal(compactToolResult(read).text, expectedPage, 'archive pages preserve exact characters and pagination offsets');
  assert.equal((read.data as any).nextOffset, 6000);
  console.log('PASS all five brains and Live voice execute all five intelligence sources; upstream errors and archived detail stay accurate');
 } finally {globalThis.fetch = originalFetch; clearIntelCache();}
 await local.stop();

 console.log('PASS intelligence tools survive provider declarations, intent pruning and the local budget');
} finally {rmSync(root, {recursive: true, force: true});}
