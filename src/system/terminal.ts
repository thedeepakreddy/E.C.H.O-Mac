import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { stat, realpath } from 'node:fs/promises';
import { executionEnvironment } from './process-env.js';

export interface CommandResult {
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
}

const active = new Set<() => void>();
const MAX_ACTIVE = 4;
const OUTPUT_LIMIT = 64_000;
let closing = false;

/** Await a bounded command. Long-running servers belong in start_process. */
export async function runCommand(program: string, args: string[], cwd: string, timeoutMs = 120_000, abortSignal?: AbortSignal): Promise<CommandResult> {
  if (!program || program.includes('\0') || args.some(arg => arg.includes('\0'))) throw new Error('Invalid command.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Command timeout must be between 1 and 600,000 ms.');
  const directory = await realpath(cwd);
  if (!(await stat(directory)).isDirectory()) throw new Error('Command cwd must be a directory.');
  if (abortSignal?.aborted) return {status: 'cancelled', exitCode: null, signal: null, stdout: '', stderr: '', truncated: false};
  if (closing) throw new Error('Terminal execution is shutting down.');
  if (active.size >= MAX_ACTIVE) throw new Error('Terminal process budget reached (4).');
  return new Promise(resolve => {
    const child = spawn(program, args, {cwd: directory, env: executionEnvironment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    const result: CommandResult = {status: 'success', exitCode: null, signal: null, stdout: '', stderr: '', truncated: false};
    const decoders = {stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8')};
    let used = 0, finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (channel: 'stdout' | 'stderr', text: string) => {
      const remaining = Math.max(0, OUTPUT_LIMIT - used);
      result[channel] += text.slice(0, remaining);
      used += Math.min(text.length, remaining);
      if (text.length > remaining) result.truncated = true;
    };
    // Only signal the process group created by this invocation. On POSIX the
    // group remains owned while pipes are open, even if the shell exits first.
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid || finished) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, value); }
      catch (error: any) { if (error.code !== 'ESRCH') result.error = error.message; }
    };
    const terminate = (reason: 'timeout' | 'cancelled') => {
      if (finished) return;
      if (result.status === 'success') result.status = reason;
      signal('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => signal('SIGKILL'), 300);
    };
    const cancel = () => terminate('cancelled');
    active.add(cancel);
    abortSignal?.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    child.stdout.on('data', chunk => append('stdout', decoders.stdout.write(chunk)));
    child.stderr.on('data', chunk => append('stderr', decoders.stderr.write(chunk)));
    child.on('error', error => {result.status = 'failed'; result.error = error.message;});
    child.on('exit', () => signal('SIGKILL'));
    child.on('close', (code, exitSignal) => {
      append('stdout', decoders.stdout.end()); append('stderr', decoders.stderr.end());
      finished = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      active.delete(cancel);
      abortSignal?.removeEventListener('abort', cancel);
      result.exitCode = code; result.signal = exitSignal;
      if (result.status === 'success' && code !== 0) result.status = 'failed';
      resolve(result);
    });
  });
}

export async function stopTerminalCommands(): Promise<void> {
  closing = true;
  for (const cancel of active) cancel();
  // All owned groups have a 300ms escalation; leave time to reap their pipes.
  const deadline = Date.now() + 2_000;
  while (active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
}
