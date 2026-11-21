// Fault injection stays entirely in the benchmark's child process. The real helper timer,
// local recount, writer transaction, HTTP handlers and on-disk SQLite remain unchanged.
import assert from 'node:assert/strict';
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { copyFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function withholdReader() {
  const held = new Map<Worker, number>(),
    post = Worker.prototype.postMessage,
    stop = Worker.prototype.terminate;
  Worker.prototype.postMessage = function (...args: Parameters<typeof post>) {
    const req = args[0];
    if (typeof req?.cancel === 'string' && held.has(this)) {
      process.send!({ type: 'reader-timeout', withheld: held.get(this) });
      held.delete(this);
    }
    if (
      typeof req?.id === 'string' &&
      typeof req.owner === 'string' &&
      req.owner.startsWith('cold-fixture-') &&
      req.subject === 'config:' + req.owner
    ) {
      held.set(this, (held.get(this) ?? 0) + 1);
      return;
    }
    return post.apply(this, args);
  };
  Worker.prototype.terminate = function () {
    const n = held.get(this);
    if (n) {
      held.delete(this);
      process.send!({ type: 'reader-timeout', withheld: n });
    }
    return stop.call(this);
  };
  return () => {
    Worker.prototype.postMessage = post;
    Worker.prototype.terminate = stop;
  };
}

/** Clone only the closed fixture's catalog, not a live WAL. A new inode alone is not proof of cold pages. */
export async function cloneCatalog(root: string) {
  const file = path.join(root, 'state.sqlite'),
    copy = path.join(root, 'cold-copy.sqlite');
  const wal = await stat(file + '-wal').catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
  assert.ok(!wal || !wal.size, 'fixture catalog must be closed and checkpointed');
  if (process.platform === 'darwin') execFileSync('/bin/cp', ['-c', file, copy]);
  else await copyFile(file, copy, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
  assert.notEqual(
    (await stat(file, { bigint: true })).ino,
    (await stat(copy, { bigint: true })).ino,
  );
  await rename(copy, file);
}
export async function fileResidency(root: string, probe: string) {
  const r: { pages: number; resident: number; page_bytes: number } = JSON.parse(
    (
      await exec(path.resolve(probe), [path.join(root, 'state.sqlite')], {
        encoding: 'utf8',
        timeout: 10000,
      })
    ).stdout,
  );
  assert.ok(
    Number.isSafeInteger(r.pages) &&
      r.pages > 0 &&
      Number.isSafeInteger(r.resident) &&
      r.resident >= 0 &&
      r.resident <= r.pages &&
      Number.isSafeInteger(r.page_bytes) &&
      r.page_bytes > 0,
  );
  return r;
}
export async function observeFallback(
  child: ChildProcess,
  accounts: number,
  start: number,
  read: () => Promise<void>,
  ended: () => number,
) {
  const [marker] = await once(child, 'message', { signal: AbortSignal.timeout(25000) });
  assert.equal(marker.type, 'reader-timeout');
  assert.equal(marker.withheld, accounts);
  const at = performance.now(),
    fixed: number[] = [],
    tail: number[] = [],
    arrivals: number[] = [];
  const sample = async (latency: number[]) => {
    const t = performance.now();
    if (t >= ended()) return;
    await read();
    const end = performance.now();
    latency.push(end - t);
    arrivals.push(end);
  };
  await Promise.all([
    ...Array.from({ length: 24 }, async (_, i) => {
      await delay(Math.max(0, at + 2 * i - performance.now()));
      await sample(fixed);
    }),
    (async () => {
      await delay(48);
      while (ended() === Infinity) {
        await sample(tail);
        await delay(3);
      }
    })(),
  ]);
  const finish = ended();
  assert.ok(Number.isFinite(finish) && finish >= at);
  const points = [at, ...arrivals.filter((n) => n < finish).sort((a, b) => a - b), finish];
  return {
    timeout_observed_ms: at - start,
    recount_and_accept_ms: finish - at,
    read_ms: [...fixed, ...tail],
    fixed_read_ms: fixed,
    max_quiet_gap_ms: Math.max(...points.slice(1).map((n, i) => n - points[i]!)),
    withheld: marker.withheld as number,
  };
}
