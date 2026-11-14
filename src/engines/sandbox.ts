import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Fault } from '../core/util.js';
import { collectProcess } from './process.js';
import type {
  SandboxBackend,
  SandboxedCommand,
  SandboxLauncher,
  SandboxPolicy,
  SandboxReport,
} from './sandbox-types.js';

export type {
  SandboxBackend,
  SandboxedCommand,
  SandboxLauncher,
  SandboxPolicy,
  SandboxReport,
} from './sandbox-types.js';

/**
 * OS-level isolation for processes a worker starts on behalf of `sandbox`-level callers
 * (docs/sandbox-design.md). Backends are replaceable; S1 ships `srt`
 * (@anthropic-ai/sandbox-runtime: sandbox-exec on macOS, bubblewrap on Linux, host-side proxies
 * that allow only listed domains).
 *
 * Boundary notes that shape this implementation:
 * - srt binds a connection to a per-invocation allow list through a command ID the sandboxed
 *   client presents; "presenting another live invocation's id gets that invocation's allows".
 *   So this launcher runs at most ONE sandboxed process at a time per worker: no concurrent
 *   process can borrow another's network list.
 * - srt reads are allowed by default. Every call denies the home directory, other volumes and the
 *   OAA data directory, then re-opens only the workspace and the declared read-only paths.
 * - srt does not limit CPU or memory. A `ulimit -t` CPU-time cap is applied outside the sandbox;
 *   wall time is enforced by the caller's AbortSignal. Memory and process-count limits are not
 *   enforced by this backend.
 */
/** Native engines that can run inside the sandbox (S2a; see docs/sandbox-design.md §4.1). */
export const sandboxNativeEngines = ['claude', 'codex'] as const;
export type SandboxNativeEngine = (typeof sandboxNativeEngines)[number];
/**
 * Per-engine sandbox profile: where the CLI keeps its state (pointed at the session's own
 * `.oaa-home`), which variable carries the caller's key, and flags that keep the CLI from using
 * the owner's login or nesting its own OS sandbox inside ours.
 */
export const nativeSandboxProfiles: Record<
  SandboxNativeEngine,
  { homeVar: string; homeDir: string; keyVar: string; args: string[] }
> = {
  claude: {
    homeVar: 'CLAUDE_CONFIG_DIR',
    homeDir: '.claude',
    keyVar: 'ANTHROPIC_API_KEY',
    args: [],
  },
  // Unverified until the S2 live check: Codex reading OPENAI_API_KEY with an empty CODEX_HOME.
  codex: {
    homeVar: 'CODEX_HOME',
    homeDir: '.codex',
    keyVar: 'OPENAI_API_KEY',
    args: ['-c', 'sandbox_mode="danger-full-access"'],
  },
};
/** POSIX single-quote a word for `/bin/sh`. */
export const shellQuote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * Reads denied in every sandboxed call before the per-call re-opens. Home and the volumes
 * root cover user data and project checkouts; the worker data directory covers other sessions,
 * bundles and credentials.
 */
export function defaultDeniedReads(dataDir: string): string[] {
  const denied = [os.homedir(), path.resolve(dataDir)];
  if (process.platform === 'darwin') denied.push('/Volumes', '/Users', '/private/var/folders');
  else denied.push('/home', '/root', '/mnt', '/media');
  return [...new Set(denied)];
}

/** Language runtimes a sandboxed script needs to read (node install, python). */
export function runtimeReadPaths(): string[] {
  const nodeRoot = path.dirname(path.dirname(process.execPath));
  return [nodeRoot];
}

/** A domain is permitted when the owner's upper bound lists it, or a `*.` wildcard covers it. */
export function permittedDomains(declared: string[], ownerAllowed: string[]): string[] {
  const covered = (d: string) =>
    ownerAllowed.some(
      (o) => o === d || (o.startsWith('*.') && d.endsWith(o.slice(1)) && d !== o.slice(2)),
    );
  return [...new Set(declared.filter(covered))];
}

/**
 * How to start an installed CLI inside the sandbox. Symlinks under the (denied) home directory
 * cannot be followed there, so the real path is used; a `#!/usr/bin/env node` script runs on the
 * real node binary. `readOnly` covers the install: a node package's root, or a binary's directory.
 */
export async function cliLaunch(
  executable: string,
): Promise<{ command: string; prefix: string[]; readOnly: string[]; real: string }> {
  const { open, realpath, stat } = await import('node:fs/promises');
  const real = await realpath(executable);
  const handle = await open(real, 'r');
  let head = '';
  try {
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, 128, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  const firstLine = head.split('\n')[0] ?? '';
  if ((firstLine.startsWith('#!') && /\bnode\b/.test(firstLine)) || /\.(mjs|cjs|js)$/.test(real)) {
    // The nearest package root within 4 levels (a CLI's own package), else just the script's
    // directory: never widen to an unrelated ancestor.
    let root = path.dirname(real);
    let candidate = root;
    for (let i = 0; i < 4; i++) {
      const found = await stat(path.join(candidate, 'package.json')).then(
        () => true,
        () => false,
      );
      if (found) {
        root = candidate;
        break;
      }
      candidate = path.dirname(candidate);
    }
    return {
      command: process.execPath,
      prefix: [real],
      readOnly: [root, ...runtimeReadPaths()],
      real,
    };
  }
  return { command: real, prefix: [], readOnly: [path.dirname(real)], real };
}

type SrtModule = typeof import('@anthropic-ai/sandbox-runtime');

export class SrtLauncher implements SandboxLauncher {
  readonly backend = 'srt' as const;
  private srt?: SrtModule['SandboxManager'];
  private initializing?: Promise<void>;
  private checked?: SandboxReport;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly options: {
      dataDir: string;
      extraDeniedReads?: string[];
      parentProxy?: { http?: string; https?: string; noProxy?: string };
    },
  ) {}
  report(): SandboxReport | undefined {
    return this.checked;
  }
  private deniedReads(): string[] {
    return [...defaultDeniedReads(this.options.dataDir), ...(this.options.extraDeniedReads ?? [])];
  }
  /** Start srt's proxies (they listen on localhost). Fails closed on an unsupported host. */
  async initialize(): Promise<void> {
    this.initializing ??= (async () => {
      const { SandboxManager } = (await import('@anthropic-ai/sandbox-runtime')) as SrtModule;
      if (!SandboxManager.isSupportedPlatform())
        throw new Fault('sandbox_unavailable', 'srt does not support this platform.', 503);
      const deps = SandboxManager.checkDependencies();
      if (deps.errors.length)
        throw new Fault(
          'sandbox_unavailable',
          `srt dependencies missing: ${deps.errors.join('; ').slice(0, 500)}`,
          503,
        );
      await SandboxManager.initialize({
        network: {
          // Nothing is allowed globally; each call registers its own (unguessable) list.
          allowedDomains: [],
          deniedDomains: [],
          ...(this.options.parentProxy ? { parentProxy: this.options.parentProxy } : {}),
        },
        filesystem: { denyRead: this.deniedReads(), allowRead: [], allowWrite: [], denyWrite: [] },
      });
      this.srt = SandboxManager;
    })();
    return this.initializing;
  }
  async wrap(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    policy: SandboxPolicy,
    signal: AbortSignal,
  ): Promise<SandboxedCommand> {
    await this.initialize();
    const srt = this.srt!;
    // One sandboxed process at a time (see the boundary note above).
    let unlock!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => (unlock = resolve));
    await previous;
    if (signal.aborted) {
      unlock();
      throw new Fault('cancelled', 'Sandboxed work was cancelled before it started.', 409);
    }
    const commandId = randomBytes(16).toString('base64url');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      srt.unregisterCommandNetworkLists(commandId);
      unlock();
    };
    try {
      if (policy.allowedDomains.length)
        srt.registerCommandNetworkLists(commandId, { allowedDomains: policy.allowedDomains });
      const inner = [command, ...args].map(shellQuote).join(' ');
      const wrapped = await srt.wrapWithSandbox(
        inner,
        '/bin/sh',
        {
          filesystem: {
            denyRead: this.deniedReads(),
            allowRead: [
              path.resolve(policy.workspace),
              ...policy.readOnly.map((p) => path.resolve(p)),
            ],
            allowWrite: [path.resolve(policy.workspace)],
            denyWrite: [],
          },
        },
        signal,
        { commandId, commandText: path.basename(command) },
      );
      const cpu = Math.max(1, Math.min(3600, Math.floor(policy.cpuSeconds)));
      return {
        command: '/bin/sh',
        args: ['-c', `ulimit -t ${cpu} 2>/dev/null; ${wrapped}`],
        env,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  /**
   * Verify the boundary on this host before advertising it: a sandboxed probe must be unable to
   * read a file outside its workspace, write outside it, or open a direct TCP connection
   * (loopback or remote), while still writing inside its workspace.
   */
  async selfCheck(
    nodePath = process.execPath,
    natives: Partial<Record<SandboxNativeEngine, string>> = {},
  ): Promise<SandboxReport | undefined> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-sandbox-check-'));
    try {
      const workspace = path.join(root, 'workspace');
      const secretDir = path.join(this.options.dataDir, 'sandbox-check');
      await mkdir(workspace, { recursive: true });
      await mkdir(secretDir, { recursive: true });
      const secret = path.join(secretDir, 'secret.txt');
      await writeFile(secret, 'not readable from the sandbox');
      const outside = path.join(secretDir, 'written-from-sandbox.txt');
      const probe = `
const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const out={};
try{fs.readFileSync(${JSON.stringify(secret)});out.readOutside='allowed'}catch(e){out.readOutside=e.code}
try{fs.writeFileSync(${JSON.stringify(outside)},'x');out.writeOutside='allowed'}catch(e){out.writeOutside=e.code}
try{fs.writeFileSync(path.join(process.cwd(),'inside.txt'),'x');out.writeInside='ok'}catch(e){out.writeInside=e.code}
const connect=(host)=>new Promise(r=>{const s=net.connect({host,port:9});s.setTimeout(1500);s.on('connect',()=>{s.destroy();r('connected')});s.on('timeout',()=>{s.destroy();r('timeout')});s.on('error',e=>r(e.code))});
(async()=>{out.loopback=await connect('127.0.0.1');out.remote=await connect('192.0.2.1');process.stdout.write(JSON.stringify(out))})();`;
      const text = await collectProcess(
        nodePath,
        ['-e', probe],
        workspace,
        '',
        AbortSignal.timeout(20_000),
        { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace, LANG: 'en_US.UTF-8' },
        {
          launcher: this,
          policy: { workspace, readOnly: runtimeReadPaths(), allowedDomains: [], cpuSeconds: 20 },
        },
      );
      const out = JSON.parse(text) as Record<string, string>;
      const outsideWritten = await readFile(outside).then(
        () => true,
        () => false,
      );
      const denied = (v: string | undefined) => !!v && v !== 'allowed' && v !== 'connected';
      const ok =
        denied(out.readOutside) &&
        denied(out.writeOutside) &&
        !outsideWritten &&
        out.writeInside === 'ok' &&
        // A sandbox denial fails fast (EPERM/EACCES); a timeout would mean packets could leave.
        ['EPERM', 'EACCES'].includes(out.loopback ?? '') &&
        ['EPERM', 'EACCES'].includes(out.remote ?? '');
      const { createRequire } = await import('node:module');
      const version = String(
        (
          createRequire(import.meta.url)('@anthropic-ai/sandbox-runtime/package.json') as {
            version: string;
          }
        ).version,
      );
      this.lastCheck = out;
      if (!ok) {
        this.checked = undefined;
        return undefined;
      }
      // A native engine is offered only if its CLI actually starts inside the sandbox (no prompt,
      // no model call: `--version` with an empty HOME and no network).
      const kinds: SandboxReport['kinds'] = ['script'];
      for (const [engine, executable] of Object.entries(natives)) {
        try {
          const launch = await cliLaunch(executable);
          const printed = await collectProcess(
            launch.command,
            [...launch.prefix, '--version'],
            workspace,
            '',
            AbortSignal.timeout(20_000),
            { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace, LANG: 'en_US.UTF-8' },
            {
              launcher: this,
              policy: { workspace, readOnly: launch.readOnly, allowedDomains: [], cpuSeconds: 20 },
            },
          );
          if (!printed.trim()) throw new Error('empty version output');
          kinds.push(`native/${engine}`);
          out[`native/${engine}`] = 'ok';
        } catch (error) {
          out[`native/${engine}`] = String((error as Error).message ?? error).slice(0, 200);
        }
      }
      this.checked = { backend: 'srt', version, kinds };
      return this.checked;
    } catch (error) {
      this.checked = undefined;
      this.lastCheck = { error: String(error).slice(0, 500) };
      return undefined;
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(path.join(this.options.dataDir, 'sandbox-check'), { recursive: true, force: true });
    }
  }
  /** Raw observations of the last self-check (for diagnostics; contains no secrets). */
  lastCheck?: Record<string, string>;
  async close(): Promise<void> {
    if (this.srt) await this.srt.reset();
    this.srt = undefined;
    this.initializing = undefined;
  }
}
