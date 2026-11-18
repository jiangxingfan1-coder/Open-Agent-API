/**
 * Isolated V8 worker-thread wrapper for `@anthropic-ai/sandbox-runtime`.
 *
 * Upstream `SandboxManager` is a module-level singleton per V8 isolate whose localhost proxy port
 * and auth token are shared by live commands in that isolate. Running one worker thread per pool
 * slot gives each concurrent caller subject its own `SandboxManager` instance, proxy port and
 * `proxyAuthToken`, and rotating on subject switch resets both before the next subject runs.
 */
import { parentPort, workerData } from 'node:worker_threads';

type SrtModule = typeof import('@anthropic-ai/sandbox-runtime');
type WorkerInit = {
  deniedReads: string[];
  parentProxy?: { http?: string; https?: string; noProxy?: string };
};
type RequestMessage =
  | { id: number; op: 'init' }
  | { id: number; op: 'rotate' }
  | {
      id: number;
      op: 'wrap';
      commandId: string;
      inner: string;
      commandText: string;
      allowRead: string[];
      allowWrite: string[];
      allowedDomains: string[];
    }
  | { id: number; op: 'unregister'; commandId: string }
  | { id: number; op: 'close' };

const init = workerData as WorkerInit;
let srt: SrtModule['SandboxManager'] | undefined;

async function ensureInitialized(): Promise<SrtModule['SandboxManager']> {
  if (srt) return srt;
  const { SandboxManager } = (await import('@anthropic-ai/sandbox-runtime')) as SrtModule;
  if (!SandboxManager.isSupportedPlatform()) {
    const err = new Error('srt does not support this platform.') as Error & {
      code?: string;
      status?: number;
    };
    err.code = 'sandbox_unavailable';
    err.status = 503;
    throw err;
  }
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length) {
    const err = new Error(
      `srt dependencies missing: ${deps.errors.join('; ').slice(0, 500)}`,
    ) as Error & {
      code?: string;
      status?: number;
    };
    err.code = 'sandbox_unavailable';
    err.status = 503;
    throw err;
  }
  await SandboxManager.initialize({
    network: {
      allowedDomains: [],
      deniedDomains: [],
      ...(init.parentProxy ? { parentProxy: init.parentProxy } : {}),
    },
    filesystem: { denyRead: init.deniedReads, allowRead: [], allowWrite: [], denyWrite: [] },
  });
  srt = SandboxManager;
  return srt;
}

parentPort?.on('message', (msg: RequestMessage) => {
  void (async () => {
    try {
      if (msg.op === 'init') {
        await ensureInitialized();
        parentPort?.postMessage({ id: msg.id, ok: true });
        return;
      }
      if (msg.op === 'rotate') {
        if (srt) {
          await srt.reset();
          srt = undefined;
        }
        await ensureInitialized();
        parentPort?.postMessage({ id: msg.id, ok: true });
        return;
      }
      if (msg.op === 'wrap') {
        const manager = await ensureInitialized();
        if (msg.allowedDomains.length)
          manager.registerCommandNetworkLists(msg.commandId, {
            allowedDomains: msg.allowedDomains,
          });
        try {
          const wrapped = await manager.wrapWithSandbox(
            msg.inner,
            '/bin/sh',
            {
              filesystem: {
                denyRead: init.deniedReads,
                allowRead: msg.allowRead,
                allowWrite: msg.allowWrite,
                denyWrite: [],
              },
            },
            undefined,
            { commandId: msg.commandId, commandText: msg.commandText },
          );
          parentPort?.postMessage({
            id: msg.id,
            ok: true,
            wrapped,
            proxyPort: manager.getProxyPort() ?? null,
          });
        } catch (error) {
          manager.unregisterCommandNetworkLists(msg.commandId);
          throw error;
        }
        return;
      }
      if (msg.op === 'unregister') {
        srt?.unregisterCommandNetworkLists(msg.commandId);
        parentPort?.postMessage({ id: msg.id, ok: true });
        return;
      }
      if (msg.op === 'close') {
        if (srt) {
          await srt.reset();
          srt = undefined;
        }
        parentPort?.postMessage({ id: msg.id, ok: true });
      }
    } catch (error) {
      const e = error as { message?: string; code?: string; status?: number };
      parentPort?.postMessage({
        id: msg.id,
        ok: false,
        code: typeof e.code === 'string' ? e.code : 'sandbox_unavailable',
        status: typeof e.status === 'number' ? e.status : 503,
        message: String(e.message ?? error),
      });
    }
  })();
});
