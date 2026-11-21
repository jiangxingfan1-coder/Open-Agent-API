import type { DatabaseSync } from 'node:sqlite';

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
