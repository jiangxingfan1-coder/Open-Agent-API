import type { DatabaseSync } from 'node:sqlite';

/** Synchronous only: never yield the shared connection while the savepoint is open. */
export function withSavepoint<T>(db: DatabaseSync, change: () => T): T {
  db.exec('SAVEPOINT oaa_change');
  try {
    const result = change();
    db.exec('RELEASE oaa_change');
    return result;
  } catch (error) {
    // SQLite may already have rolled back the whole transaction (for example, SQLITE_FULL).
    if (db.isTransaction) db.exec('ROLLBACK TO oaa_change; RELEASE oaa_change');
    throw error;
  }
}
