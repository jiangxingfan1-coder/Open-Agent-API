import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { PruneProfile } from './prune-profile.js';
import { tryBeginWrite } from './write-lock.js';

/** Retry only BEGIN, never a mutation. Restore the shared connection policy before yielding. */
export async function pruneWrite<T>(
  db: DatabaseSync,
  live: boolean,
  profile: PruneProfile | undefined,
  mutate: () => T,
  committed?: (value: T, heldMs: number) => void,
) {
  const started = performance.now();
  const budget = live ? Number(db.prepare('PRAGMA busy_timeout').get()!.timeout) : 0;
  let retryMs = 10;
  try {
    for (;;) {
      try {
        if (live) tryBeginWrite(db, budget);
        else db.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        const left = budget - (performance.now() - started);
        if (!live || !isBusy(error) || left <= 0 || db.isTransaction) throw error;
        if (profile) profile.lockRetries++;
        await delay(Math.min(retryMs, left));
        retryMs = Math.min(50, retryMs * 2);
      }
    }
  } finally {
    profile?.add('begin', started);
  }
  const held = performance.now();
  let value: T;
  try {
    value = mutate();
    const phase = performance.now();
    try {
      db.exec('COMMIT');
    } finally {
      profile?.add('commit', phase);
    }
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  committed?.(value, performance.now() - held);
  return value;
}

function isBusy(error: unknown) {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 255) === 5
  );
}
