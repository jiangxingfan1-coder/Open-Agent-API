import type { DatabaseSync } from 'node:sqlite';
import { withSavepoint } from './savepoint.js';
import { Fault } from '../core/util.js';

const tableExists = (db: DatabaseSync, table: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
const journal = 'oaa_inline_inputs';
const hasPending = `EXISTS(SELECT 1 FROM ${journal} WHERE owner=NEW.owner AND phase='ready')`;
const workflowsInstalled = new WeakSet<DatabaseSync>();

// These triggers live in the database, not just in this version of the gateway. A run
// admitted by an older binary must still cancel the entitlement to reclaim its inputs.
function protect(db: DatabaseSync, table: string, event: string, name: string, ids: string) {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)) return;
  // If a prior writer could have used an unprotected nonempty table, keep its owners'
  // ready files. No retrospective inference from names, hashes or incomplete history.
  if (db.prepare(`SELECT 1 FROM ${journal} WHERE phase='ready' LIMIT 1`).get()) {
    const uncertain = `phase='ready' AND EXISTS(SELECT 1 FROM ${table} t WHERE t.owner=p.owner)`;
    db.exec(`DELETE FROM ${journal} AS p WHERE ${uncertain}`);
    if (db.prepare(`SELECT 1 FROM ${journal} AS p WHERE ${uncertain} LIMIT 1`).get())
      throw new Fault(
        'persistence_failed',
        'Could not preserve inputs without complete claim history.',
        500,
      );
  }
  const matches = `owner=NEW.owner AND phase='ready' AND file_id IN (${ids})`;
  db.exec(`CREATE TRIGGER ${name} AFTER ${event} ON ${table} WHEN ${hasPending} BEGIN
    DELETE FROM ${journal} WHERE ${matches};
    SELECT CASE WHEN EXISTS(SELECT 1 FROM ${journal} WHERE ${matches}) THEN RAISE(ABORT,'inline input claim not stored') END; END`);
}
export function installWorkflowInputClaims(db: DatabaseSync) {
  if (workflowsInstalled.has(db) || !tableExists(db, journal)) return;
  const sources = (
    [
      ['workflow_executions', 'payload', 'payload'],
      ['task_workflows', 'payload', 'revision'],
      ['workflow_pending_events', 'input', 'input'],
    ] as const
  ).filter(([table]) => tableExists(db, table));
  if (!sources.length) return;
  withSavepoint(db, () => {
    for (const [table, column, update] of sources) {
      const ids = `SELECT atom FROM json_tree(NEW.${column}) WHERE type='text' AND atom GLOB 'file_*'`;
      protect(db, table, 'INSERT', 'oaa_inline_' + table + '_insert', ids);
      protect(db, table, 'UPDATE OF ' + update, 'oaa_inline_' + table + '_update', ids);
    }
  });
  if (!db.isTransaction && sources.length === 3) workflowsInstalled.add(db);
}
export function installInputJournal(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${journal}(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,file_id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,subject TEXT NOT NULL,
    digest TEXT NOT NULL,bytes INTEGER NOT NULL,identity TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('writing','ready','unlink')),due INTEGER,
    CHECK(length(file_id)=37 AND substr(file_id,1,5)='file_' AND substr(file_id,6) NOT GLOB '*[^0-9a-f]*'));
    CREATE INDEX IF NOT EXISTS oaa_inline_owner ON ${journal}(owner,file_id) WHERE phase='ready';
    CREATE INDEX IF NOT EXISTS oaa_inline_due ON ${journal}(due,seq) WHERE due IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS oaa_inline_materialized AFTER INSERT ON files
    WHEN EXISTS(SELECT 1 FROM ${journal} WHERE file_id=NEW.id) BEGIN
      UPDATE ${journal} SET phase='ready' WHERE file_id=NEW.id AND phase='writing' AND owner=NEW.owner AND subject=NEW.subject
        AND digest=json_extract(NEW.payload,'$.sha256') AND bytes=json_extract(NEW.payload,'$.bytes')
        AND NEW.id=json_extract(NEW.payload,'$.id') AND NEW.owner=json_extract(NEW.payload,'$.owner')
        AND json_extract(NEW.payload,'$.runId') IS NULL AND json_extract(NEW.payload,'$.allowedNodes') IS NULL;
      SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reserved inline input identity') END;
    END;`);
  const runIds = "SELECT value FROM json_each(NEW.payload,'$.fileIds') WHERE type='text'";
  protect(db, 'runs', 'INSERT', 'oaa_inline_run_insert', runIds);
  protect(db, 'runs', 'UPDATE OF payload', 'oaa_inline_run_update', runIds);
  installWorkflowInputClaims(db);
  return Number(db.prepare(`SELECT max(seq) AS n FROM ${journal}`).get()!.n ?? 0);
}
