import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Fault } from '../core/util.js';
import { collectProcess } from './process.js';
import { WorkerSlotBackend, type SrtSlotBackend } from './srt-slot-client.js';
import type {
  SandboxBackend,
  SandboxedCommand,
  SandboxLauncher,
  SandboxPolicy,
  SandboxReport,
} from './sandbox-types.js';

export type { SrtSlotBackend } from './srt-slot-client.js';
export type {
  SandboxBackend,
  SandboxedCommand,
  SandboxLauncher,
  SandboxPolicy,
  SandboxReport,
} from './sandbox-types.js';

/** Native engines that have a sandbox profile (see docs/sandbox-design.md §4.1). */
export const sandboxNativeEngines = ['claude', 'codex', 'antigravity'] as const;
export type SandboxNativeEngine = (typeof sandboxNativeEngines)[number];
export type SandboxProfileEngine = SandboxNativeEngine | 'acp';
export type SandboxEngineProfile = {
  homeVar: string;
  homeDir: string;
  keyVar?: string;
  args: string[];
  /** Populate isolated XDG directories inside `.oaa-home` (Antigravity and generic ACP CLIs). */
  xdg?: boolean;
};

/**
 * Per-engine sandbox profile: isolated state directory inside `.oaa-home`, caller BYOK environment
 * variable (when applicable), and flags preventing nested OS sandboxes or host-credential access.
 */
export const nativeSandboxProfiles: Record<SandboxProfileEngine, SandboxEngineProfile> = {
  claude: {
    homeVar: 'CLAUDE_CONFIG_DIR',
    homeDir: '.claude',
    keyVar: 'ANTHROPIC_API_KEY',
    args: [],
  },
  codex: {
    homeVar: 'CODEX_HOME',
    homeDir: '.codex',
    keyVar: 'OPENAI_API_KEY',
    args: ['-c', 'sandbox_mode="danger-full-access"'],
  },
  antigravity: {
    homeVar: 'AGY_HOME',
    homeDir: '.gemini',
    keyVar: 'GEMINI_API_KEY',
    args: [],
    xdg: true,
  },
  acp: {
    homeVar: 'XDG_CONFIG_HOME',
    homeDir: '.config',
    args: [],
    xdg: true,
  },
};

/** POSIX single-quote a word for `/bin/sh`. */
export const shellQuote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/** Reads denied in every sandboxed call before the per-call re-opens. */
export function defaultDeniedReads(dataDir: string): string[] {
  const denied = [os.homedir(), path.resolve(dataDir)];
  if (process.platform === 'darwin') denied.push('/Volumes', '/Users', '/private/var/folders');
  else denied.push('/home', '/root', '/mnt', '/media');
  return [...new Set(denied)];
}

/** Language runtimes a sandboxed script needs to read (node install). */
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

async function nearestPackageRoot(realFile: string): Promise<string> {
  const fallback = path.dirname(realFile);
  let candidate = fallback;
  for (let i = 0; i < 4; i++) {
    for (const marker of ['package.json', 'pyproject.toml']) {
      const found = await stat(path.join(candidate, marker)).then(
        () => true,
        () => false,
      );
      if (found) return candidate;
    }
    candidate = path.dirname(candidate);
  }
  return fallback;
}

function appBundleContents(realFile: string): string | undefined {
  const marker = `.app${path.sep}Contents${path.sep}`;
  const idx = realFile.indexOf(marker);
  return idx >= 0 ? realFile.slice(0, idx + marker.length - 1) : undefined;
}

const isNodeScript = (firstLine: string, realFile: string) =>
  (firstLine.startsWith('#!') && /\bnode\b/.test(firstLine)) || /\.(mjs|cjs|js)$/.test(realFile);

async function readShebang(realFile: string): Promise<string> {
  const handle = await open(realFile, 'r');
  try {
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, 128, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
  } finally {
    await handle.close();
  }
}

/**
 * Resolve how to launch an installed CLI or stdio ACP adapter inside the sandbox: dereferences
 * symlinks (whose links under HOME are denied), locates bounded read-only package/app-bundle roots,
 * and resolves script file arguments when the command itself is a language runtime.
 */
export async function cliLaunch(
  executable: string,
  args: readonly string[] = [],
): Promise<{
  command: string;
  prefix: string[];
  args: string[];
  readOnly: string[];
  real: string;
}> {
  const real = await realpath(executable);
  const firstLine = await readShebang(real);
  const readOnly: string[] = [];
  const bundleRoot = appBundleContents(real);
  if (bundleRoot) readOnly.push(bundleRoot);

  let command = real;
  let prefix: string[] = [];
  if (isNodeScript(firstLine, real)) {
    command = process.execPath;
    prefix = [real];
    readOnly.push(await nearestPackageRoot(real), ...runtimeReadPaths());
  } else {
    readOnly.push(path.dirname(real));
    if (real === process.execPath || /\bnode(?:\.exe)?$/i.test(path.basename(real)))
      readOnly.push(...runtimeReadPaths());
  }

  const resolvedArgs: string[] = [];
  for (const arg of args) {
    if (!arg || arg.startsWith('-') || !path.isAbsolute(arg)) {
      resolvedArgs.push(arg);
      continue;
    }
    const target = await realpath(arg).catch(() => undefined);
    const isFile =
      target !== undefined &&
      (await stat(target).then(
        (s) => s.isFile(),
        () => false,
      ));
    if (!isFile || !target) {
      resolvedArgs.push(arg);
      continue;
    }
    resolvedArgs.push(target);
    const argBundle = appBundleContents(target);
    if (argBundle) readOnly.push(argBundle);
    readOnly.push(await nearestPackageRoot(target));
    if (/\.(mjs|cjs|js)$/.test(target)) readOnly.push(...runtimeReadPaths());
  }
  return { command, prefix, args: resolvedArgs, readOnly: [...new Set(readOnly)], real };
}

type Slot = {
  index: number;
  backend: SrtSlotBackend;
  boundKey: string | null;
  exclusive: boolean;
  active: number;
  initialized: boolean;
  busy: Promise<void>;
};
type Waiter = {
  trustKey: string;
  exclusive: boolean;
  resolve: (acquired: { slot: Slot; rotate: boolean }) => void;
  reject: (error: Error) => void;
  cancel: () => void;
};

export class SrtLauncher implements SandboxLauncher {
  readonly backend = 'srt' as const;
  readonly maxConcurrentSandboxes: number;
  private checked?: SandboxReport;
  private readonly slots: Slot[] = [];
  private readonly waiters: Waiter[] = [];
  /** Diagnostic count of active sandbox invocations across all slots. */
  activeCount = 0;

  constructor(
    private readonly options: {
      dataDir: string;
      maxConcurrentSandboxes?: number;
      extraDeniedReads?: string[];
      parentProxy?: { http?: string; https?: string; noProxy?: string };
      createSlotBackend?: (slotIndex: number) => SrtSlotBackend;
    },
  ) {
    this.maxConcurrentSandboxes = Math.max(
      1,
      Math.min(32, Math.floor(options.maxConcurrentSandboxes ?? 4)),
    );
  }

  report(): SandboxReport | undefined {
    return this.checked;
  }

  private deniedReads(): string[] {
    return [...defaultDeniedReads(this.options.dataDir), ...(this.options.extraDeniedReads ?? [])];
  }

  private makeSlot(): Slot {
    const index = this.slots.length;
    const backend =
      this.options.createSlotBackend?.(index) ??
      new WorkerSlotBackend(this.deniedReads(), this.options.parentProxy);
    const slot: Slot = {
      index,
      backend,
      boundKey: null,
      exclusive: false,
      active: 0,
      initialized: false,
      busy: Promise.resolve(),
    };
    this.slots.push(slot);
    return slot;
  }

  private tryClaim(
    trustKey: string,
    exclusive: boolean,
  ): { slot: Slot; rotate: boolean } | undefined {
    if (exclusive && this.slots.some((s) => s.active > 0)) return undefined;
    if (!exclusive) {
      if (this.slots.some((s) => s.active > 0 && s.exclusive)) return undefined;
      const shared = this.slots.find(
        (s) => s.active > 0 && !s.exclusive && s.boundKey === trustKey,
      );
      if (shared) {
        shared.active++;
        return { slot: shared, rotate: false };
      }
    }
    const warmIdle = this.slots.find((s) => s.active === 0 && s.boundKey === trustKey);
    if (warmIdle) {
      warmIdle.exclusive = exclusive;
      warmIdle.active = 1;
      return { slot: warmIdle, rotate: false };
    }
    if (this.slots.length < this.maxConcurrentSandboxes) {
      const created = this.makeSlot();
      created.boundKey = trustKey;
      created.exclusive = exclusive;
      created.active = 1;
      return { slot: created, rotate: false };
    }
    const coldIdle = this.slots.find((s) => s.active === 0);
    if (coldIdle) {
      const rotate = coldIdle.initialized && coldIdle.boundKey !== trustKey;
      coldIdle.boundKey = trustKey;
      coldIdle.exclusive = exclusive;
      coldIdle.active = 1;
      return { slot: coldIdle, rotate };
    }
    return undefined;
  }

  private acquireSlot(
    trustKey: string,
    exclusive: boolean,
    signal: AbortSignal,
  ): Promise<{ slot: Slot; rotate: boolean }> {
    if (signal.aborted)
      return Promise.reject(
        new Fault('cancelled', 'Sandboxed work was cancelled before it started.', 409),
      );
    const immediate = this.tryClaim(trustKey, exclusive);
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Fault('cancelled', 'Sandboxed work was cancelled before it started.', 409));
      };
      const waiter: Waiter = {
        trustKey,
        exclusive,
        resolve: (claimed) => {
          signal.removeEventListener('abort', onAbort);
          resolve(claimed);
        },
        reject: (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
        cancel: onAbort,
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(slot: Slot): void {
    slot.active = Math.max(0, slot.active - 1);
    while (this.waiters.length > 0) {
      const next = this.waiters[0]!;
      const claimed = this.tryClaim(next.trustKey, next.exclusive);
      if (!claimed) break;
      this.waiters.shift();
      next.resolve(claimed);
    }
  }

  private runOnSlot<T>(slot: Slot, fn: () => Promise<T>): Promise<T> {
    const next = slot.busy.then(fn, fn);
    slot.busy = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Ensure at least one sandbox slot can initialize on this host. */
  async initialize(): Promise<void> {
    const slot = this.slots[0] ?? this.makeSlot();
    await this.runOnSlot(slot, async () => {
      if (!slot.initialized) {
        await slot.backend.init();
        slot.initialized = true;
      }
    });
  }

  async wrap(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    policy: SandboxPolicy,
    signal: AbortSignal,
  ): Promise<SandboxedCommand> {
    const untagged = !policy.subject;
    const domainKey = [...new Set(policy.allowedDomains)].sort().join(',');
    const trustKey = untagged ? '__untagged__' : `${policy.subject}\0${domainKey}`;
    const { slot, rotate } = await this.acquireSlot(trustKey, untagged, signal);
    this.activeCount++;
    const commandId = randomBytes(16).toString('base64url');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      void this.runOnSlot(slot, () => slot.backend.unregister(commandId)).finally(() =>
        this.releaseSlot(slot),
      );
    };
    try {
      if (signal.aborted)
        throw new Fault('cancelled', 'Sandboxed work was cancelled before it started.', 409);
      const inner = [command, ...args].map(shellQuote).join(' ');
      const { wrapped } = await this.runOnSlot(slot, async () => {
        if (!slot.initialized) {
          await slot.backend.init();
          slot.initialized = true;
        } else if (rotate) {
          await slot.backend.rotate();
        }
        return slot.backend.wrap({
          commandId,
          inner,
          commandText: path.basename(command),
          allowRead: [
            path.resolve(policy.workspace),
            ...policy.readOnly.map((p) => path.resolve(p)),
          ],
          allowWrite: [path.resolve(policy.workspace)],
          allowedDomains: policy.allowedDomains,
        });
      });
      if (signal.aborted)
        throw new Fault('cancelled', 'Sandboxed work was cancelled before it started.', 409);
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

  /** Verify the OS sandbox boundary on this host before advertising it. */
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
          policy: {
            workspace,
            readOnly: runtimeReadPaths(),
            allowedDomains: [],
            cpuSeconds: 20,
            subject: '__selfcheck__',
          },
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
              policy: {
                workspace,
                readOnly: launch.readOnly,
                allowedDomains: [],
                cpuSeconds: 20,
                subject: '__selfcheck__',
              },
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
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new Fault('cancelled', 'Sandbox launcher closed.', 409));
    const slots = this.slots.splice(0);
    await Promise.all(slots.map((s) => s.backend.close()));
  }
}
