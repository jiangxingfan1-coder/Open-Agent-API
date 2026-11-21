import { lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Fault } from '../core/util.js';
import { bi } from '../core/locale.js';
import {
  chargeFileScopeIndex,
  fileScopeLayout,
  legacyFileScopeIndex,
} from '../store/file-scope-index.js';
import { hasLiveLease } from '../store/gateway-lease.js';
import { isWriteContended } from '../store/checkpoint.js';
import { SCHEMA_VERSION } from '../store/store.js';
const liveFault = () =>
  new Fault(
    'gateway_already_running',
    bi(
      '请先正常停止占用此数据目录的网关。',
      'Stop the gateway owning this data directory before rebuilding its index.',
    ),
    409,
  );

/** One SQLite transaction, not a Store open: inspection cannot migrate the catalog,
 * run retention, recover uploads, or claim a live gateway's lease. */
type IndexTarget = 'scope-only' | 'scope-bytes';
export function fileIndexOperation(
  db: DatabaseSync,
  write: boolean,
  {
    target = 'scope-bytes',
    checkFile = () => {},
  }: { target?: IndexTarget; checkFile?: () => void } = {},
) {
  if (target !== 'scope-only' && target !== 'scope-bytes')
    throw new Fault('arguments', 'Unknown file index layout.');
  if (db.isTransaction)
    throw new Fault('persistence_failed', 'File index maintenance needs its own transaction.', 500);
  try {
    db.exec('PRAGMA busy_timeout=0');
    if (write) {
      // Refuse a known live gateway without taking its writer. Check again under
      // BEGIN IMMEDIATE so a gateway starting after this probe cannot race the DDL.
      if (
        db
          .prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='gateway_owner'")
          .get() &&
        hasLiveLease(db)
      )
        throw liveFault();
      db.exec('PRAGMA synchronous=FULL');
    }
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    checkFile();
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (
      version !== SCHEMA_VERSION ||
      Number(
        db
          .prepare(
            `SELECT count(*) AS n FROM main.sqlite_schema
      WHERE (type='table' AND name IN ('files','gateway_owner','runs','oaa_inline_inputs')) OR (type='index' AND name='file_upload_facts' AND tbl_name='files')`,
          )
          .get()!.n,
      ) !== 5
    )
      throw new Fault(
        'unsupported_file_catalog',
        bi('这不是当前版本的网关数据库。', 'Expected a gateway catalog with the current schema.'),
        409,
      );
    const before = fileScopeLayout(db),
      live = hasLiveLease(db);
    let changed = false;
    if (write) {
      if (live) throw liveFault();
      if (before !== 'scope-only' && before !== 'scope-bytes')
        throw new Fault(
          'unrecognized_file_index',
          'Not replacing a missing or unrecognized file index.',
          409,
        );
      if (before !== target) {
        db.exec('DROP INDEX main.file_owner_subject');
        db.exec(target === 'scope-bytes' ? chargeFileScopeIndex : legacyFileScopeIndex);
        if (fileScopeLayout(db) !== target)
          throw new Fault('persistence_failed', 'Could not verify the new file index.', 500);
        changed = true;
      }
    }
    const result = {
      storage_schema_version: version,
      live_gateway: live,
      previous_layout: before,
      requested_layout: target,
      layout: changed ? target : before,
      changed,
    };
    checkFile();
    try {
      db.exec('COMMIT');
    } catch (error) {
      if (!changed || db.isTransaction) throw error;
      // The connection left the transaction. Inspect the bound file rather than replaying DDL.
      try {
        checkFile();
        if (fileScopeLayout(db) === target)
          return { ...result, confirmed_after_commit_error: true };
      } catch {
        /* Report uncertainty below. */
      }
      throw new Fault(
        'file_index_commit_unconfirmed',
        'Run file-index without --write to check the catalog before retrying.',
        409,
        true,
      );
    }
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (isWriteContended(error))
      throw new Fault(
        'maintenance_busy',
        'The catalog is busy. Retry offline maintenance when its writer is free.',
        409,
      );
    throw error;
  }
}

export function fileIndexCommand(root: string, write = false, target: IndexTarget = 'scope-bytes') {
  const file = path.resolve(root, 'state.sqlite');
  const identity = () => {
    const s = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!s?.isFile() || (write && s.ino === 0n))
      throw new Fault(
        'invalid_file_catalog',
        'Expected an existing regular gateway database.',
        409,
      );
    return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
  };
  const original = identity(),
    url = pathToFileURL(file);
  // mode=rw (rather than rwc) cannot accidentally initialize a missing database.
  url.searchParams.set('mode', write ? 'rw' : 'ro');
  const db = new DatabaseSync(url.href, { readOnly: !write });
  try {
    const result = fileIndexOperation(db, write, {
      target,
      checkFile: () => {
        if (identity() !== original)
          throw new Fault(
            'invalid_file_catalog',
            'The database file changed during maintenance.',
            409,
          );
      },
    });
    return { database: file, ...result };
  } finally {
    db.close();
  }
}
