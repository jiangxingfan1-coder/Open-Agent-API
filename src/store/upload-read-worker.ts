import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { storedFileTotalSql } from './upload-facts.js';

export type ReadBinding = { file: string; identity: string; lease: string };
export type ReadRequest = { id: string; owner: string; subject: string };
export type ReadResult = { id: string; used?: number | null };
export function databaseIdentity(file: string) {
  const s = statSync(file, { bigint: true });
  if (!s.isFile() || s.ino === 0n) throw new Error('File storage has no stable database identity.');
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}

// The helper never takes the store lease. Bind both the file opened and the read snapshot
// to the serving gateway, and close the read connection before reporting its result.
export function readCommittedBatch(
  binding: ReadBinding,
  requests: readonly ReadRequest[],
): ReadResult[] {
  const results: ReadResult[] = requests.map(({ id }) => ({ id }));
  let db: DatabaseSync | undefined;
  try {
    if (databaseIdentity(binding.file) !== binding.identity) return results;
    db = new DatabaseSync(binding.file, { readOnly: true });
    if (databaseIdentity(binding.file) !== binding.identity) return results;
    const q = db.prepare(
      `SELECT (${storedFileTotalSql}) AS used FROM main.gateway_owner WHERE slot=1 AND lease_id=:lease`,
    );
    for (const [i, { owner, subject }] of requests.entries()) {
      const r = q.get({ owner, subject, lease: binding.lease });
      if (
        r?.used === null ||
        (typeof r?.used === 'number' && Number.isSafeInteger(r.used) && r.used >= 0)
      )
        results[i]!.used = r.used;
    }
  } catch {
    // Unconfirmed results fall back to the serving connection; never substitute zero.
  } finally {
    db?.close();
  }
  return results;
}
const port = parentPort;
if (port && workerData?.role === 'oaa.upload-usage') {
  const queue: ReadRequest[] = [];
  let scheduled = false;
  const drain = () => {
    for (const result of readCommittedBatch(workerData.binding, queue.splice(0, 4)))
      port.postMessage(result);
    if (queue.length) setImmediate(drain);
    else scheduled = false;
  };
  port.on('message', (request: ReadRequest) => {
    queue.push(request);
    if (!scheduled) {
      scheduled = true;
      setImmediate(drain);
    }
  });
}
