import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isWriteUnavailable } from './checkpoint.js';
import { Fault, RetryLaterFault } from '../core/util.js';
import { withSavepoint } from './savepoint.js';
import { exactTotal, fileBytes, storedFileTotalSql } from './upload-facts.js';

export type UploadUsageStore = { db: DatabaseSync; prepare(sql: string): StatementSync };
export type UsageConnection = DatabaseSync | UploadUsageStore;
const max = Number.MAX_SAFE_INTEGER;
const pending = `SELECT ${exactTotal("CASE WHEN typeof(bytes)='integer' AND bytes>=0 THEN bytes END")}
  FROM main.oaa_inline_inputs WHERE owner=:owner AND subject=:subject AND phase='writing'`;
const version = '(SELECT data_version FROM main.pragma_data_version)';
const scopeLimit = 256;
export const coldReadRows = 4096;
export class UploadRecountRequired extends Error {}
export const changingUploadTotal = () =>
  new RetryLaterFault('upload_busy', 'File usage kept changing during quota admission.', 503, 1);
const latestAdmission = '(SELECT coalesce(max(touched),0) FROM temp.oaa_upload_usage)';

// REPLACE may discard a row without invoking DELETE triggers. Invalidate both possible
// conflicts (the public id and an explicitly supplied rowid) before SQLite discards them.
const displaced = `DELETE FROM oaa_upload_usage WHERE (owner,subject) IN
  (SELECT owner,subject FROM main.files WHERE id=NEW.id OR rowid=NEW.rowid);`;
const schema = `
  CREATE TEMP TABLE oaa_upload_usage(owner TEXT NOT NULL,subject TEXT NOT NULL,
    version INTEGER NOT NULL,used INTEGER,touched INTEGER NOT NULL,scan TEXT,PRIMARY KEY(owner,subject));
  CREATE INDEX temp.oaa_usage_recency ON oaa_upload_usage(touched);
  CREATE TEMP TRIGGER oaa_usage_bound AFTER INSERT ON oaa_upload_usage
    WHEN (SELECT count(*) FROM oaa_upload_usage)>${scopeLimit} BEGIN
    DELETE FROM oaa_upload_usage WHERE rowid=(SELECT rowid FROM oaa_upload_usage ORDER BY touched,rowid LIMIT 1);
  END;
  CREATE TEMP TRIGGER oaa_usage_replace BEFORE INSERT ON main.files
    WHEN EXISTS(SELECT 1 FROM oaa_upload_usage) BEGIN ${displaced} END;
  CREATE TEMP TRIGGER oaa_usage_append AFTER INSERT ON main.files BEGIN
    DELETE FROM oaa_upload_usage WHERE owner=NEW.owner AND subject=NEW.subject AND scan IS NOT NULL;
    UPDATE oaa_upload_usage SET used=CASE WHEN ${fileBytes('NEW.payload')}<=${max}-used
      THEN used+${fileBytes('NEW.payload')} END WHERE owner=NEW.owner AND subject=NEW.subject;
  END;
  CREATE TEMP TRIGGER oaa_usage_edit BEFORE UPDATE ON main.files BEGIN
    DELETE FROM oaa_upload_usage WHERE (owner=OLD.owner AND subject=OLD.subject) OR (owner=NEW.owner AND subject=NEW.subject);
    ${displaced}
  END;
  CREATE TEMP TRIGGER oaa_usage_delete AFTER DELETE ON main.files BEGIN
    UPDATE oaa_upload_usage SET used=CASE WHEN ${fileBytes('OLD.payload')}<=used
      THEN used-${fileBytes('OLD.payload')} END WHERE owner=OLD.owner AND subject=OLD.subject;
    DELETE FROM oaa_upload_usage WHERE owner=OLD.owner AND subject=OLD.subject AND used IS NULL;
  END;`;

function ensureCache(store: UsageConnection, db: DatabaseSync) {
  if (
    !store
      .prepare("SELECT 1 FROM sqlite_temp_schema WHERE type='table' AND name='oaa_upload_usage'")
      .get()
  )
    withSavepoint(db, () => db.exec(schema));
}

/** A ticket belongs to this connection. Local file edits discard it; external commits
 * invalidate its data_version. Neither reservations nor another owner's append spoil it. */
export function needsColdTotal(store: UploadUsageStore, owner: string, subject: string) {
  if (store.db.isTransaction) return false;
  ensureCache(store, store.db);
  const scope = { owner, subject };
  if (
    store
      .prepare(
        `SELECT 1 FROM temp.oaa_upload_usage WHERE owner=:owner AND subject=:subject AND scan IS NULL AND version=${version}`,
      )
      .get(scope)
  )
    return false;
  // Bound the probe, not the account: small scopes are cheaper to count locally than dispatch.
  return largeScope(store, owner, subject);
}
function largeScope(store: UsageConnection, owner: string, subject: string) {
  return !!store
    .prepare(
      `SELECT 1 FROM main.files INDEXED BY file_owner_subject WHERE owner=:owner AND subject=:subject LIMIT 1 OFFSET ${coldReadRows - 1}`,
    )
    .get({ owner, subject });
}
export function startColdTotal(
  store: UploadUsageStore,
  owner: string,
  subject: string,
  scan: string,
) {
  store
    .prepare(
      `INSERT OR REPLACE INTO temp.oaa_upload_usage(owner,subject,version,used,touched,scan)
    VALUES(:owner,:subject,${version},NULL,${latestAdmission}+1,:scan)`,
    )
    .run({ owner, subject, scan });
}
export function currentColdTotal(
  store: UploadUsageStore,
  owner: string,
  subject: string,
  scan: string,
) {
  return (
    !store.db.isTransaction &&
    !!store
      .prepare(
        `SELECT 1 FROM temp.oaa_upload_usage WHERE owner=? AND subject=? AND scan=? AND version=${version}`,
      )
      .get(owner, subject, scan)
  );
}
export function acceptColdTotal(
  store: UploadUsageStore,
  owner: string,
  subject: string,
  scan: string,
  used: number | null,
) {
  if (store.db.isTransaction || (used !== null && (!Number.isSafeInteger(used) || used < 0)))
    return false;
  return !!store
    .prepare(
      `UPDATE temp.oaa_upload_usage SET used=:used,scan=NULL WHERE owner=:owner AND subject=:subject AND scan=:scan AND version=${version}`,
    )
    .run({ owner, subject, scan, used }).changes;
}
export function discardColdTotal(
  store: UploadUsageStore,
  owner: string,
  subject: string,
  scan: string,
) {
  store
    .prepare('DELETE FROM temp.oaa_upload_usage WHERE owner=? AND subject=? AND scan=?')
    .run(owner, subject, scan);
}

/** Never authoritative: rebuild from canonical files on a miss. Pending reservations are
 * read live in the same main snapshot, including when another connection is the writer. */
export function uploadUsage(
  store: UsageConnection,
  owner: string,
  subject: string,
  deferLarge = false,
) {
  const db = 'db' in store ? store.db : store;
  const scope = { owner, subject },
    outer = db.isTransaction;
  try {
    ensureCache(store, db);
    const hit = store
      .prepare(
        `SELECT used,(${pending}) AS reserved,${latestAdmission}-touched>=${scopeLimit / 2} AS refresh FROM temp.oaa_upload_usage
      WHERE owner=:owner AND subject=:subject AND scan IS NULL AND version=${version}`,
      )
      .get(scope);
    if (hit) {
      // Only a cache fill advances the clock. Repeated hits without admission pressure
      // do not write to TEMP or invalidate retention's total_changes() observation.
      if (hit.refresh)
        store
          .prepare(
            `UPDATE temp.oaa_upload_usage SET touched=${latestAdmission} WHERE owner=:owner AND subject=:subject`,
          )
          .run(scope);
      return hit;
    }
    if (deferLarge && largeScope(store, owner, subject)) throw new UploadRecountRequired();
    // This statement only writes TEMP. Even a permanently over-quota caller can warm the
    // cache without taking the main writer lock. A NULL total means unknown, never zero.
    return store
      .prepare(
        `INSERT OR REPLACE INTO temp.oaa_upload_usage(owner,subject,version,used,touched)
      VALUES(:owner,:subject,${version},(${storedFileTotalSql}),${latestAdmission}+1) RETURNING used,(${pending}) AS reserved`,
      )
      .get(scope)!;
  } catch (error) {
    // Read-only preflight can still count the original rows. Never continue a reservation
    // if SQLite has rolled back the writer transaction itself.
    if (!isWriteUnavailable(error) || (outer && !db.isTransaction)) throw error;
    if (deferLarge && largeScope(store, owner, subject))
      throw new Fault(
        'persistence_failed',
        'Cannot verify stored file usage for this caller.',
        500,
      );
    return store
      .prepare(`SELECT (${storedFileTotalSql}) AS used,(${pending}) AS reserved`)
      .get(scope)!;
  }
}
