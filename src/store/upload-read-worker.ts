import { statSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { readUsagePage, transferablePrefix, type UsagePrefix } from './upload-usage-page.js';

export type ReadBinding = { file: string; identity: string; lease: string };
export const readerProtocol = 2;
export type ReadRequest = { id: string; owner: string; subject: string };
export type ReadCommand = ReadRequest | { cancel: string };
export type ReadResult = { id: string; used?: number | null };
export type ReadMessage =
  | (ReadResult & { kind: 'done' })
  | { id: string; kind: 'progress'; rows: number }
  | { id: string; kind: 'released'; prefix?: UsagePrefix };
export function databaseIdentity(file: string) {
  const s = statSync(file, { bigint: true });
  if (!s.isFile() || s.ino === 0n) throw new Error('File storage has no stable database identity.');
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}

class BoundReader {
  private db?: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  constructor(private binding: ReadBinding) {}
  prepare(sql: string) {
    let q = this.statements.get(sql);
    if (!q) {
      q = this.db!.prepare(sql);
      this.statements.set(sql, q);
    }
    return q;
  }
  // The lease and page share a snapshot. Never pin a WAL snapshot between event-loop turns.
  read<T>(work: () => T): T | undefined {
    try {
      if (!this.db) {
        if (databaseIdentity(this.binding.file) !== this.binding.identity) return;
        this.db = new DatabaseSync(this.binding.file, { readOnly: true });
        if (databaseIdentity(this.binding.file) !== this.binding.identity) {
          this.close();
          return;
        }
      }
      this.db.exec('BEGIN');
      try {
        if (
          this.prepare('SELECT 1 FROM main.gateway_owner WHERE slot=1 AND lease_id=?').get(
            this.binding.lease,
          )
        )
          return work();
      } finally {
        this.db.exec('ROLLBACK');
      }
    } catch {
      this.close();
    }
    return undefined;
  }
  close() {
    this.statements.clear();
    this.db?.close();
    this.db = undefined;
  }
}
type Job = { req: ReadRequest; width: number; reportedAt: number; prefix?: UsagePrefix };
const jobFor = (req: ReadRequest): Job => ({ req, width: 1024, reportedAt: performance.now() });
function advance(reader: BoundReader, job: Job): ReadResult | undefined {
  const { owner, subject } = job.req,
    start = performance.now(),
    old = job.prefix,
    page = readUsagePage(reader, { owner, subject }, job.width, old?.next, 'reader');
  const bytes = page.bytes === null ? null : (old?.bytes ?? 0) + page.bytes;
  if (bytes === null || !Number.isSafeInteger(bytes) || !page.next)
    return { id: job.req.id, used: Number.isSafeInteger(bytes) ? bytes : null };
  job.prefix = { rows: (old?.rows ?? 0) + job.width, bytes, next: page.next };
  const elapsed = performance.now() - start;
  // The private reader can take a larger contiguous page on fast media. Aim for
  // ~80 ms, without changing the much smaller serving-connection fallback slices.
  const desired = 2 ** Math.floor(Math.log2((job.width * 80) / Math.max(1, elapsed)));
  job.width = Math.min(131072, job.width * 8, Math.max(64, job.width / 4, desired));
  return undefined;
}
// Synchronous callers get one consistent snapshot. The worker below can instead hand off
// its last finished page; only the serving connection can confirm the original scan ticket.
export function readCommittedBatch(
  binding: ReadBinding,
  requests: readonly ReadRequest[],
): ReadResult[] {
  const reader = new BoundReader(binding);
  try {
    return requests.map(
      (req) =>
        reader.read(() => {
          const job = jobFor(req);
          for (;;) {
            const done = advance(reader, job);
            if (done) return done;
          }
        }) ?? { id: req.id },
    );
  } finally {
    reader.close();
  }
}
const port = parentPort;
if (port && workerData?.role === 'oaa.upload-usage' && workerData.protocol !== readerProtocol) {
  // A running older gateway can load this file after an in-place update. It treats
  // every matching id as a final reply, so never send it intermediate frames.
  port.on('message', (req: ReadRequest) => {
    if (typeof req?.id === 'string') port.postMessage({ id: req.id });
  });
} else if (port && workerData?.role === 'oaa.upload-usage') {
  const reader = new BoundReader(workerData.binding),
    jobs = new Map<string, Job>(),
    queue: Job[] = [];
  let scheduled = false;
  const send = (message: ReadMessage) => port.postMessage(message);
  const drain = () => {
    const job = queue.shift();
    const until = performance.now() + 64;
    while (job) {
      const step = reader.read(() => ({ done: advance(reader, job) }));
      if (!step || step.done) {
        jobs.delete(job.req.id);
        if (!queue.length) reader.close();
        send({ kind: 'done', ...(step?.done ?? { id: job.req.id }) });
        break;
      } else {
        const now = performance.now();
        if (now - job.reportedAt >= 250) {
          job.reportedAt = now;
          send({ id: job.req.id, kind: 'progress', rows: job.prefix!.rows });
        }
        // Keep nearby index pages together on cold storage, then yield to the port
        // and to other callers. No read transaction spans this scheduling boundary.
        if (now >= until) {
          queue.push(job);
          break;
        }
      }
    }
    if (queue.length) setImmediate(drain);
    else {
      scheduled = false;
      reader.close();
    }
  };
  port.on('message', (command: ReadCommand) => {
    if ('cancel' in command) {
      const job = jobs.get(command.cancel);
      if (job) {
        jobs.delete(command.cancel);
        queue.splice(queue.indexOf(job), 1);
      }
      if (!queue.length) reader.close();
      // FIFO port delivery and synchronous page reads make this an exclusive handoff:
      // the request is no longer queued and cannot be inside a native read.
      send({
        id: command.cancel,
        kind: 'released',
        ...(transferablePrefix(job?.prefix) && { prefix: job.prefix }),
      });
    } else if (!jobs.has(command.id)) {
      const job = jobFor(command);
      jobs.set(command.id, job);
      queue.push(job);
      if (!scheduled) {
        scheduled = true;
        setImmediate(drain);
      }
    }
  });
  port.postMessage({ ready: readerProtocol });
}
