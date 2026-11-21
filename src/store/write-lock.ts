import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isWriteContended } from './checkpoint.js';

export type RunWriteMode = 'try' | 'defer';
/** Raised only before BEGIN succeeds: no part of a run or its quota reservation was written. */
export class RunWriteDeferred extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly fileIds: readonly string[],
  ) {
    super('Run admission is waiting for the database writer.');
  }
}
export function beginRunWrite(
  store: { db: DatabaseSync; prepare(sql: string): StatementSync },
  mode: RunWriteMode | undefined,
  fileIds: readonly string[],
) {
  const { db } = store;
  if (!mode) return db.exec('BEGIN IMMEDIATE');
  const timeout = Number(store.prepare('PRAGMA busy_timeout').get()!.timeout);
  if (mode === 'defer') throw new RunWriteDeferred(timeout, fileIds);
  try {
    tryBeginWrite(db, timeout);
  } catch (error) {
    if (!db.isTransaction && isWriteContended(error)) throw new RunWriteDeferred(timeout, fileIds);
    throw error;
  }
}

/** Try the writer lock once; restore the connection policy before any application code runs. */
export function tryBeginWrite(db: DatabaseSync, busyTimeout: number) {
  if (!busyTimeout) return db.exec('BEGIN IMMEDIATE');
  db.exec('PRAGMA busy_timeout=0');
  try {
    db.exec('BEGIN IMMEDIATE');
  } finally {
    db.exec(`PRAGMA busy_timeout=${busyTimeout}`);
  }
}
