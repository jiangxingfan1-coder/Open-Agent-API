import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { LIMITS } from '../core/limits.js';
import { Fault } from '../core/util.js';
import { memoryFts } from './project-fts.js';
import { withSavepoint } from './savepoint.js';

type Database = { db: DatabaseSync; prepare(sql: string): StatementSync };

export function putPrivateMemory(
  store: Database,
  owner: string,
  subject: string,
  namespace: string,
  key: string,
  value: unknown,
  runId?: string,
) {
  const now = Date.now(),
    serialized = JSON.stringify(value ?? null);
  if (serialized.length > LIMITS.memoryEntryBytes)
    throw new Fault('memory_too_large', 'Memory entry exceeds the 256KB limit.', 413);
  const fts = memoryFts(store);
  return withSavepoint(store.db, () => {
    store
      .prepare(
        'INSERT INTO memories(owner,subject,namespace,key,value,updated_at,run_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,subject,namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,run_id=excluded.run_id',
      )
      .run(owner, subject, namespace, key, serialized, now, runId ?? null);
    fts.indexPrivate(owner, subject, namespace, key, serialized);
    return { owner, namespace, key, value, updatedAt: now, ...(runId ? { runId } : {}) };
  });
}

export function deletePrivateMemory(
  store: Database,
  owner: string,
  subject: string,
  namespace: string,
  key: string,
) {
  const fts = memoryFts(store);
  return withSavepoint(store.db, () => {
    const res = store
      .prepare('DELETE FROM memories WHERE owner=? AND subject=? AND namespace=? AND key=?')
      .run(owner, subject, namespace, key);
    if (!res.changes) return false;
    fts.removePrivate(owner, subject, namespace, key);
    return true;
  });
}
