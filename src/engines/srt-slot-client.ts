import { Worker } from 'node:worker_threads';
import { Fault } from '../core/util.js';

export interface SrtSlotBackend {
  init(): Promise<void>;
  rotate(): Promise<void>;
  wrap(req: {
    commandId: string;
    inner: string;
    commandText: string;
    allowRead: string[];
    allowWrite: string[];
    allowedDomains: string[];
  }): Promise<{ wrapped: string; proxyPort: number | null }>;
  unregister(commandId: string): Promise<void>;
  close(): Promise<void>;
}

export class WorkerSlotBackend implements SrtSlotBackend {
  private worker?: Worker;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly deniedReads: string[],
    private readonly parentProxy?: { http?: string; https?: string; noProxy?: string },
  ) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const worker = new Worker(new URL(`./srt-slot-worker${ext}`, import.meta.url), {
      workerData: {
        deniedReads: this.deniedReads,
        ...(this.parentProxy ? { parentProxy: this.parentProxy } : {}),
      },
    });
    worker.unref();
    worker.on('message', (msg: Record<string, unknown>) => {
      const id = Number(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (this.pending.size === 0) worker.unref();
      if (msg.ok) entry.resolve(msg);
      else
        entry.reject(
          new Fault(
            typeof msg.code === 'string' ? msg.code : 'sandbox_unavailable',
            String(msg.message ?? 'Sandbox worker failed.'),
            typeof msg.status === 'number' ? msg.status : 503,
          ),
        );
    });
    const failAll = (err: unknown) => {
      this.worker = undefined;
      const fault = new Fault(
        'sandbox_unavailable',
        `Sandbox slot worker exited: ${String((err as Error)?.message ?? err)}`,
        503,
      );
      for (const p of this.pending.values()) p.reject(fault);
      this.pending.clear();
    };
    worker.once('error', failAll);
    worker.once('exit', (code) => {
      if (this.pending.size > 0) failAll(new Error(`exit code ${code}`));
      this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private rpc(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id });
    });
  }

  async init(): Promise<void> {
    await this.rpc({ op: 'init' });
  }

  async rotate(): Promise<void> {
    await this.rpc({ op: 'rotate' });
  }

  async wrap(req: {
    commandId: string;
    inner: string;
    commandText: string;
    allowRead: string[];
    allowWrite: string[];
    allowedDomains: string[];
  }): Promise<{ wrapped: string; proxyPort: number | null }> {
    const res = await this.rpc({ op: 'wrap', ...req });
    return {
      wrapped: String(res.wrapped),
      proxyPort: typeof res.proxyPort === 'number' ? res.proxyPort : null,
    };
  }

  async unregister(commandId: string): Promise<void> {
    if (!this.worker) return;
    await this.rpc({ op: 'unregister', commandId });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    try {
      await this.rpcWith(worker, { op: 'close' });
    } catch {
      // Best-effort reset before termination.
    } finally {
      await worker.terminate();
    }
  }

  private rpcWith(worker: Worker, payload: Record<string, unknown>): Promise<unknown> {
    const id = ++this.seq;
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id });
    });
  }
}
