import type { StatementSync } from 'node:sqlite';
import { fileBytes, chargeFileTotalSql, storedFileTotalSql } from './upload-facts.js';

type Statements = { prepare(sql: string): StatementSync };
export const scopeOnlyIndexSpec = 'file_owner_subject ON files(owner,subject)';
export const legacyFileScopeIndex = 'CREATE INDEX ' + scopeOnlyIndexSpec;
export const fileScopeIndexSpec = `file_owner_subject ON files(owner,subject,${fileBytes('payload')})`;
export const chargeFileScopeIndex = 'CREATE INDEX ' + fileScopeIndexSpec;
export type FileScopeLayout = 'scope-only' | 'scope-bytes' | 'unrecognized' | 'missing';
export class FileScopeLayoutChanged extends Error {}

// Unknown definitions are never replaced. SQLite's own expression matching, not this
// marker, computes the bytes; the layout only selects a covering access path.
export function fileScopeLayout(store: Statements): FileScopeLayout {
  const row = store
    .prepare(
      "SELECT sql FROM main.sqlite_schema WHERE type='index' AND tbl_name='files' AND name='file_owner_subject'",
    )
    .get();
  if (!row) return 'missing';
  if (row.sql === chargeFileScopeIndex) return 'scope-bytes';
  if (row.sql === legacyFileScopeIndex) return 'scope-only';
  return 'unrecognized';
}
export function indexedFileTotal(store: Statements) {
  return fileScopeLayout(store) === 'scope-bytes' ? chargeFileTotalSql : storedFileTotalSql;
}
export function scopeProbeIndex(store: Statements) {
  const layout = fileScopeLayout(store);
  return layout === 'scope-only' || layout === 'scope-bytes'
    ? 'file_owner_subject'
    : 'file_upload_facts';
}
