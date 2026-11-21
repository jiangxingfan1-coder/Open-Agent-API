import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isWriteUnavailable } from './checkpoint.js';
import { withSavepoint } from './savepoint.js';

export type UsageConnection =
  DatabaseSync | { db: DatabaseSync; prepare(sql: string): StatementSync };
export const fileBytes = (payload: 'payload' | 'NEW.payload') =>
  `CASE WHEN json_valid(${payload}) THEN CASE WHEN json_type(${payload},'$.bytes')='integer' AND json_extract(${payload},'$.bytes')>=0 THEN json_extract(${payload},'$.bytes') END END`;
const max = Number.MAX_SAFE_INTEGER;
const total = (value: string) =>
  `CASE WHEN count(*)=count(${value}) AND total(${value})<=${max} THEN CAST(total(${value}) AS INTEGER) END`;
const files = `SELECT ${total(fileBytes('payload'))} FROM main.files INDEXED BY file_upload_facts WHERE owner=:owner AND subject=:subject`;
const pending = `SELECT ${total("CASE WHEN typeof(bytes)='integer' AND bytes>=0 THEN bytes END")}
  FROM main.oaa_inline_inputs WHERE owner=:owner AND subject=:subject AND phase='writing'`;
const version = '(SELECT data_version FROM main.pragma_data_version)';
const scopeLimit = 256;

// REPLACE may discard a row without invoking DELETE triggers. Invalidate both possible
// conflicts (the public id and an explicitly supplied rowid) before SQLite discards them.
const displaced = `DELETE FROM oaa_upload_usage WHERE (owner,subject) IN
  (SELECT owner,subject FROM main.files WHERE id=NEW.id OR rowid=NEW.rowid);`;
const schema = `
  CREATE TEMP TABLE oaa_upload_usage(owner TEXT NOT NULL,subject TEXT NOT NULL,
    version INTEGER NOT NULL,used INTEGER,PRIMARY KEY(owner,subject));
  CREATE TEMP TRIGGER oaa_usage_bound AFTER INSERT ON oaa_upload_usage BEGIN
    DELETE FROM oaa_upload_usage WHERE rowid=(SELECT rowid FROM oaa_upload_usage ORDER BY rowid DESC LIMIT 1 OFFSET ${scopeLimit});
  END;
  CREATE TEMP TRIGGER oaa_usage_replace BEFORE INSERT ON main.files
    WHEN EXISTS(SELECT 1 FROM oaa_upload_usage) BEGIN ${displaced} END;
  CREATE TEMP TRIGGER oaa_usage_append AFTER INSERT ON main.files BEGIN
    UPDATE oaa_upload_usage SET used=CASE WHEN ${fileBytes('NEW.payload')}<=${max}-used
      THEN used+${fileBytes('NEW.payload')} END WHERE owner=NEW.owner AND subject=NEW.subject;
  END;
  CREATE TEMP TRIGGER oaa_usage_edit BEFORE UPDATE ON main.files BEGIN
    DELETE FROM oaa_upload_usage WHERE (owner=OLD.owner AND subject=OLD.subject) OR (owner=NEW.owner AND subject=NEW.subject);
    ${displaced}
  END;
  CREATE TEMP TRIGGER oaa_usage_delete AFTER DELETE ON main.files BEGIN
    DELETE FROM oaa_upload_usage WHERE owner=OLD.owner AND subject=OLD.subject;
  END;`;

/** Never authoritative: rebuild from canonical files on a miss. Pending reservations are
 * read live in the same main snapshot, including when another connection is the writer. */
export function uploadUsage(store: UsageConnection, owner: string, subject: string) {
  const db = 'db' in store ? store.db : store;
  const scope = { owner, subject },
    outer = db.isTransaction;
  try {
    if (
      !store
        .prepare("SELECT 1 FROM sqlite_temp_schema WHERE type='table' AND name='oaa_upload_usage'")
        .get()
    )
      withSavepoint(db, () => db.exec(schema));
    const hit = store
      .prepare(
        `SELECT used,(${pending}) AS reserved FROM temp.oaa_upload_usage
      WHERE owner=:owner AND subject=:subject AND version=${version}`,
      )
      .get(scope);
    if (hit) return hit;
    // This statement only writes TEMP. Even a permanently over-quota caller can warm the
    // cache without taking the main writer lock. A NULL total means unknown, never zero.
    return store
      .prepare(
        `INSERT OR REPLACE INTO temp.oaa_upload_usage(owner,subject,version,used)
      VALUES(:owner,:subject,${version},(${files})) RETURNING used,(${pending}) AS reserved`,
      )
      .get(scope)!;
  } catch (error) {
    // Read-only preflight can still count the original rows. Never continue a reservation
    // if SQLite has rolled back the writer transaction itself.
    if (!isWriteUnavailable(error) || (outer && !db.isTransaction)) throw error;
    return store.prepare(`SELECT (${files}) AS used,(${pending}) AS reserved`).get(scope)!;
  }
}
