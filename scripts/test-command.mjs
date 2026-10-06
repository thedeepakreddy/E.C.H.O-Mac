import {spawn} from 'node:child_process';

/** A test owns its process group, output budget, and deadline. */
export function runTestCommand(command, args, {cwd, env, timeoutMs = 120_000, signal} = {}) {
  if (signal?.aborted) return Promise.resolve({code: 1, out: 'Test run cancelled', ms: 0});
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, {cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', failure = '', settled = false, escalation;
    const kill = value => {
      if (!child.pid || settled) return;
      try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, value);}
      catch (error) {if (error.code !== 'ESRCH') failure ||= error.message;}
    };
    const cancel = reason => {
      failure ||= reason;
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 300);
    };
    const aborted = () => cancel('Test run cancelled');
    signal?.addEventListener('abort', aborted, {once: true});
    const timer = setTimeout(() => cancel(`Test exceeded ${timeoutMs} ms`), timeoutMs);
    const append = text => {out = (out + text).slice(-256_000);};
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => {failure = error.message;});
    child.on('exit', () => kill('SIGKILL'));
    child.on('close', code => {
      settled = true;
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', aborted);
      resolve({code: failure ? 1 : code ?? 1, out: failure ? `${out}\n${failure}` : out, ms: Date.now() - started});
    });
  });
}
