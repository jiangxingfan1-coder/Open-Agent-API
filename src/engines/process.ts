import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { checkAbort, Fault, redact } from '../core/util.js';
import type { SandboxLauncher, SandboxPolicy } from './sandbox-types.js';
import { killWindowsTree, launchPlan } from './win-spawn.js';

/** How a worker passes its environment to native agents, ACP agents and stdio adapters. */
export type NativeEnvPolicy = { mode: 'inherit' | 'allowlist'; allow: string[] };
/** Always passed in allowlist mode: process basics a CLI needs to start, find HOME and locale. */
export const NATIVE_ENV_BASE = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TMPDIR',
  'TZ',
  // Windows equivalents.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
];
/**
 * Proxy settings are passed unchanged in allowlist mode as well, so switching modes never changes
 * how a native agent reaches the network.
 */
export const NATIVE_ENV_PROXY = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
/**
 * Environment for an owner-configured agent process. `OAA_*` (gateway/worker credentials) is never
 * passed. `inherit` (default) passes everything else, as before. `allowlist` passes only
 * NATIVE_ENV_BASE, `LC_*`, the proxy variables (either case) and the owner's `allow` names.
 */
export function nativeEnvironment(
  policy?: NativeEnvPolicy,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const entries = Object.entries(source).filter(
    ([k, v]) => v !== undefined && !k.toUpperCase().startsWith('OAA_'),
  );
  if (!policy || policy.mode === 'inherit') return Object.fromEntries(entries);
  const windows = process.platform === 'win32';
  const norm = (k: string) => (windows ? k.toUpperCase() : k);
  const allowed = new Set([...NATIVE_ENV_BASE, ...policy.allow].map(norm));
  const proxies = new Set(NATIVE_ENV_PROXY);
  return Object.fromEntries(
    entries.filter(
      ([k]) => allowed.has(norm(k)) || k.startsWith('LC_') || proxies.has(k.toUpperCase()),
    ),
  );
}

export function terminateOwned(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32') {
    // No SIGTERM equivalent for a console process tree: end the whole tree (the .cmd/node shim
    // and the real CLI behind it), falling back to the direct child if taskkill is unavailable.
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    killWindowsTree(child.pid);
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1500);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
    return;
  }
  const kill = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The process group already exited.
    }
  };
  kill('SIGTERM');
  const timer = setTimeout(() => kill('SIGKILL'), 1500);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}
export function ownedProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  checkAbort(signal);
  const safeEnv = env ?? nativeEnvironment();
  const plan = launchPlan(command, args, safeEnv);
  const child = spawn(plan.command, plan.args, {
    cwd,
    env: safeEnv,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const abort = () => terminateOwned(child);
  signal.addEventListener('abort', abort, { once: true });
  child.once('close', () => {
    signal.removeEventListener('abort', abort);
  });
  return child;
}
export function jsonLines(
  child: ChildProcessWithoutNullStreams,
  onMessage: (value: Record<string, unknown>) => void,
  onFailure: (error: Error) => void,
): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let failed = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 2_097_152) {
      failed = true;
      onFailure(new Fault('invalid_protocol', 'Agent protocol line exceeds 2 MiB.', 502));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Expected an object');
        onMessage(value as Record<string, unknown>);
      } catch {
        failed = true;
        onFailure(new Fault('invalid_protocol', 'Agent emitted invalid JSONL.', 502));
        return;
      }
    }
  });
  child.stdout.on('end', () => {
    if (buffer.trim() && !failed)
      onFailure(new Fault('invalid_protocol', 'Agent ended with an incomplete JSONL frame.', 502));
  });
}
/**
 * Start an owned process inside the OS sandbox. The launcher admits one sandboxed process at a
 * time; its slot is released when this process exits or fails to start.
 */
export async function spawnSandboxed(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  sandbox: { launcher: SandboxLauncher; policy: SandboxPolicy },
): Promise<ChildProcessWithoutNullStreams> {
  const wrapped = await sandbox.launcher.wrap(command, args, env, sandbox.policy, signal);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = ownedProcess(wrapped.command, wrapped.args, cwd, signal, wrapped.env);
  } catch (error) {
    wrapped.release();
    throw error;
  }
  child.once('close', wrapped.release);
  child.once('error', wrapped.release);
  return child;
}

/**
 * A process handle that exists before the real process does. Some hosts (the Claude Agent SDK's
 * `spawnClaudeCodeProcess`) need a process synchronously, while sandbox wrapping is asynchronous:
 * this facade buffers stdin, then pipes to the real child once `start` resolves. A start failure
 * is reported as `error` followed by `exit(1)`, so the host never waits forever.
 */
export class DeferredProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private child?: ChildProcessWithoutNullStreams;
  constructor(start: () => Promise<ChildProcessWithoutNullStreams>) {
    super();
    start().then(
      (child) => {
        this.child = child;
        if (this.killed) terminateOwned(child);
        this.stdin.pipe(child.stdin);
        child.stdout.pipe(this.stdout);
        child.stderr.pipe(this.stderr);
        child.stdin.on('error', () => {});
        child.once('error', (error) => this.emit('error', error));
        child.once('exit', (code, signal) => {
          this.exitCode = code;
          this.signalCode = signal;
          this.emit('exit', code, signal);
        });
      },
      (error: unknown) =>
        setImmediate(() => {
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
          this.exitCode = 1;
          this.stdout.end();
          this.stderr.end();
          this.emit('exit', 1, null);
        }),
    );
  }
  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    // The real child leads its own process group (the sandbox wrapper and the CLI inside it).
    if (this.child) terminateOwned(this.child);
    return true;
  }
}

export async function collectProcess(
  command: string,
  args: string[],
  cwd: string,
  input: string,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
  sandbox?: { launcher: SandboxLauncher; policy: SandboxPolicy },
): Promise<string> {
  const child = sandbox
    ? await spawnSandboxed(command, args, cwd, signal, env ?? nativeEnvironment(), sandbox)
    : ownedProcess(command, args, cwd, signal, env);
  return await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2_097_152) {
        failure = new Fault('output_too_large', 'Process output exceeds 2 MiB.', 502);
        terminateOwned(child);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (signal.aborted) reject(new Fault('cancelled', 'Owned process cancelled.', 409));
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Fault(
            'process_failed',
            `Process exited ${code}: ${redact(stderr).slice(0, 1500)}`,
            502,
          ),
        );
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
