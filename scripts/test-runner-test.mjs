import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runTestCommand} from './test-command.mjs';
import {selectTests, testMode, LIVE_TESTS, DEVICE_TESTS} from './test-modes.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
let passed = 0;
async function test(name, body) {await body(); passed++; console.log(`PASS ${name}`);}
const run = (code, options = {}) => runTestCommand(process.execPath, ['-e', code], {cwd, ...options});
await test('offline discovery excludes every declared real service and device test', () => {
  const scripts = {test: 'runner', 'test:live': 'live', exampletest: 'fixture', e2e: 'remote', check: 'device',
    ...Object.fromEntries([...Object.keys(LIVE_TESTS), ...Object.keys(DEVICE_TESTS)].map(name => [name, 'script']))};
  assert.deepEqual(selectTests(scripts, 'offline'), ['exampletest']);
  for (const name of Object.keys(LIVE_TESTS)) assert.equal(testMode(name), 'live');
  for (const name of Object.keys(DEVICE_TESTS)) assert.equal(testMode(name), 'device');
  assert.deepEqual(selectTests(scripts, 'live', ['openrouter']), ['openroutertest']);
});
await test('commands preserve output, exit codes and spawn errors', async () => {
  const good = await run('process.stdout.write("out");process.stderr.write("err")');
  assert.equal(good.code, 0); assert(good.out.includes('out') && good.out.includes('err'));
  assert.equal((await run('process.exit(7)')).code, 7);
  const missing = await runTestCommand('/no-such-echo-test-command', [], {cwd});
  assert.equal(missing.code, 1); assert.match(missing.out, /ENOENT/);
});
await test('output budgets retain the tail without growing unbounded', async () => {
  const large = await run('process.stdout.write("x".repeat(1000000)+"TAIL")');
  assert.equal(large.code, 0); assert(large.out.length <= 256000); assert(large.out.endsWith('TAIL'));
});
await test('deadline kills a command that ignores SIGTERM', async () => {
  const timed = await run('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)', {timeoutMs: 100});
  assert.equal(timed.code, 1); assert.match(timed.out, /exceeded 100 ms/); assert(timed.ms < 3000);
});
await test('cancellation ends pending work and does not start pre-cancelled commands', async () => {
  const controller = new AbortController();
  const pending = run('setInterval(()=>{},1000)', {signal: controller.signal});
  setTimeout(() => controller.abort(), 50);
  assert.equal((await pending).code, 1);
  assert.equal((await run('throw Error("must not launch")', {signal: controller.signal})).ms, 0);
});
await test('test-owned descendants cannot keep output pipes alive after the parent exits', async () => {
  const result = await run('require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});process.exit(0)');
  assert.equal(result.code, 0); assert(result.ms < 3000);
});
await test('offline guard rejects remote fetch and HTTP calls before network access', async () => {
  const script = `
    const assert = require('node:assert/strict');
    (async()=>{
      await assert.rejects(fetch('https://fixture.invalid/api'), /blocked remote/);
      for(const module of ['node:http','node:https']) {
        const http = require(module);
        assert.throws(()=>http.get(module.endsWith('https')?'https://fixture.invalid':'http://fixture.invalid'), /blocked remote/);
        assert.throws(()=>http.request({hostname:'fixture.invalid'}), /blocked remote/);
        assert.throws(()=>http.request('http://localhost', {hostname:'fixture.invalid'}), /blocked remote/);
      }
      console.log('guard verified');
    })().catch(error=>{console.error(error);process.exitCode=1});`;
  const result = await runTestCommand(process.execPath, ['--import', fileURLToPath(new URL('./test-network-guard.mjs', import.meta.url)), '-e', script], {cwd});
  assert.equal(result.code, 0, result.out); assert.match(result.out, /guard verified/);
});
console.log(`\n${passed}/${passed} test runner regression groups passed`);
