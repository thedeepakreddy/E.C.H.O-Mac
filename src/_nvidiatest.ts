/** Offline transport and provider contracts. No hosted model or private credentials. */
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {completionRequest, readCompletionStream, CompletionProtocolError} from './brain/chat-completions.js';

const root = await mkdtemp(join(tmpdir(), 'echo-nvidia-test-'));
process.env.ECHO_DATA_ROOT = join(root, 'data'); process.env.ECHO_MEMORY_ROOT = join(root, 'memory');
process.env.ECHO_MCP = '0'; process.env.ECHO_LOG_QUIET = '1';
let passed = 0;
async function test(name: string, run: () => unknown) {await run(); passed++; console.log(`PASS ${name}`);}
const event = (delta: any, finish_reason: string | null = null) => ({choices: [{index: 0, delta, finish_reason}]});
function stream(events: any[], fragmented = false): Response {
  const bytes = new TextEncoder().encode(events.map(item => `data: ${JSON.stringify(item)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({start(controller) {
    if (fragmented) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  }}), {headers: {'content-type': 'text/event-stream'}});
}

try {
  await test('native request preserves reasoning, call grouping, results and screenshots', () => {
    const body = completionRequest({model: 'moonshotai/kimi-k3', instructions: 'public fixture', max_output_tokens: 8192,
      tools: [{name: 'read_screen', description: 'Observe', parameters: {type: 'object'}}], input: [
        {role: 'user', content: [{type: 'input_text', text: 'Inspect'}]},
        {type: 'message', role: 'assistant', content: [], reasoning_content: 'fixture reasoning'},
        {type: 'function_call', call_id: 'call-a', name: 'read_screen', arguments: '{}'},
        {type: 'function_call', call_id: 'call-b', name: 'read_screen', arguments: '{}'},
        {type: 'function_call_output', call_id: 'call-a', output: '{"ok":true}'},
        {type: 'function_call_output', call_id: 'call-b', output: '{"ok":true}'},
        {role: 'user', content: [{type: 'input_image', image_url: 'data:image/png;base64,fixture'}]},
      ]}, 'low');
    assert(!body.input && !body.instructions && !body.store);
    assert.equal(body.messages[2].tool_calls.length, 2);
    assert.equal(body.messages[2].reasoning_content, 'fixture reasoning');
    assert.equal(body.messages[3].tool_call_id, 'call-a');
    assert.equal(body.messages[5].content[0].image_url.url, 'data:image/png;base64,fixture');
    assert.equal(body.tools[0].function.name, 'read_screen');
    assert.equal(body.max_tokens, 8192); assert.equal(body.reasoning_effort, 'low');
  });
  await test('fragmented UTF-8 SSE speaks text only and records accurate usage', async () => {
    const deltas: string[] = [];
    const result = await readCompletionStream(stream([
      event({reasoning_content: 'private fixture reasoning'}), event({content: 'Hello 🐈'}), event({}, 'stop'),
      {choices: [], usage: {prompt_tokens: 10, completion_tokens: 4, total_tokens: 14}},
    ], true), text => deltas.push(text));
    assert.equal(deltas.join(''), 'Hello 🐈');
    assert.equal(result.output[0].reasoning_content, 'private fixture reasoning');
    assert.deepEqual(result.usage, {input_tokens: 10, output_tokens: 4, total_tokens: 14,
      input_tokens_details: undefined, output_tokens_details: undefined});
  });
  await test('interleaved call fragments assemble by index before executing', async () => {
    const result = await readCompletionStream(stream([
      event({tool_calls: [{index: 1, id: 'b', function: {name: 'second', arguments: '{"x":'}},
        {index: 0, id: 'a', function: {name: 'first', arguments: '{}'}}]}),
      event({tool_calls: [{index: 1, function: {arguments: '2}'}}]}, 'tool_calls'),
    ]), () => {});
    assert.deepEqual(result.output.slice(1).map(item => [item.call_id, item.name, item.arguments]),
      [['a', 'first', '{}'], ['b', 'second', '{"x":2}']]);
  });
  await test('truncated calls cannot become executable output', async () => {
    const result = await readCompletionStream(stream([event({tool_calls: [{index: 0, id: 'a',
      function: {name: 'write_file', arguments: '{"path":'}}]}, 'length')]), () => {});
    assert.equal(result.incomplete, 'max_output_tokens');
    assert(!result.output.some(item => item.type === 'function_call'));
  });
  await test('malformed, duplicate and missing calls fail without execution', async () => {
    for (const events of [
      [event({tool_calls: [{index: 0, id: 'a', function: {name: 'action', arguments: '{'}}]}, 'tool_calls')],
      [event({tool_calls: [{index: 0, id: 'a', function: {name: 'action', arguments: '{}'}},
        {index: 1, id: 'a', function: {name: 'action', arguments: '{}'}}]}, 'tool_calls')],
      [event({}, 'tool_calls')], [event({content: 'unfinished'})],
    ]) await assert.rejects(readCompletionStream(stream(events), () => {}), CompletionProtocolError);
    await assert.rejects(readCompletionStream(new Response('data: not-json\n\n'), () => {}), CompletionProtocolError);
  });
  await test('JSON fallback preserves assistant reasoning and complete calls', async () => {
    const result = await readCompletionStream(new Response(JSON.stringify({choices: [{index: 0, finish_reason: 'tool_calls',
      message: {content: null, reasoning_content: 'fixture', tool_calls: [{id: 'a', type: 'function',
        function: {name: 'observe', arguments: '{}'}}]}}]}), {headers: {'content-type': 'application/json'}}), () => {});
    assert.equal(result.output[0].reasoning_content, 'fixture'); assert.equal(result.output[1].name, 'observe');
  });
  await test('a silent stream aborts its request and cancels the reader', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const response = new Response(new ReadableStream({cancel() {cancelled = true;}}));
    await assert.rejects(readCompletionStream(response, () => {}, {controller, silenceMs: 20}), /no progress/);
    assert(controller.signal.aborted); assert(cancelled);
  });
  await test('factory, switching, credentials and restricted grants use NVIDIA identity', async () => {
    const {DEFAULTS_FOR_TESTS} = await import('./config.js');
    const {createBrain} = await import('./brain/index.js');
    const {parseBrainSwitch, unavailableReason} = await import('./brain/switching.js');
    const {TOOLS} = await import('./tools/registry.js');
    const {KEY_FIELDS} = await import('./keystore.js');
    const cfg = structuredClone(DEFAULTS_FOR_TESTS); cfg.brain = 'nvidia';
    cfg.nvidia.apiKeyEnv = 'NVIDIA_FIXTURE_KEY';
    const old = process.env.NVIDIA_FIXTURE_KEY;
    try {
      delete process.env.NVIDIA_FIXTURE_KEY;
      assert.throws(() => createBrain(cfg), /NVIDIA_FIXTURE_KEY/);
      process.env.NVIDIA_FIXTURE_KEY = 'offline-fixture';
      const built = createBrain(cfg, {autoResume: false, limits: {allowedTools: new Set(['read_browser_page']), maxIterations: 2}});
      assert.equal(built.provider, 'nvidia'); assert.equal((built.brain as any).provider, 'nvidia');
      await built.brain.stop();
    } finally {if (old === undefined) delete process.env.NVIDIA_FIXTURE_KEY; else process.env.NVIDIA_FIXTURE_KEY = old;}
    assert.equal(parseBrainSwitch('switch to kimi'), 'nvidia');
    assert.equal(unavailableReason('nvidia', {}), "NVIDIA_API_KEY isn't set");
    assert(KEY_FIELDS.some(field => field.env === 'NVIDIA_API_KEY'));
    assert(TOOLS.find(tool => tool.name === 'switch_brain')!.schema.brain.safeParse('nvidia').success);
  });
  await test('recordings redact embedded NVIDIA keys without erasing token counts', async () => {
    const {stableJson} = await import('./agent-replay/recorder.js');
    const key = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';
    const id = '10373716-2917-4605-bbb3-7b5119bf893b';
    const value = JSON.parse(stableJson({text: `fixture ${key}`, apiKey: key, totalTokens: 12345, id}));
    assert(!JSON.stringify(value).includes(key)); assert.equal(value.totalTokens, 12345);
    assert.equal(value.id, id, 'structural UUIDs must survive credential redaction');
  });
  console.log(`${passed}/${passed} NVIDIA contract groups passed`);
} finally {await rm(root, {recursive: true, force: true});}
