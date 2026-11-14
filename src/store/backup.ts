/**
 * Pre-migration backups. Schema upgrades cannot be undone by an older gateway, so an existing
 * database is copied to `<dataDir>/backups/` before it is migrated. Fresh databases and live
 * peers are skipped; a failed copy aborts startup rather than migrating without a restore point.
 *
 * A migration that keeps failing (for example a gateway restarted in a loop by a supervisor)
 * would otherwise write one full copy per attempt, so only the newest `BACKUP_KEEP` copies per
 * source version are kept.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const BACKUP_KEEP = 3;

export function backupBeforeMigration(
  db: DatabaseSync,
  root: string,
  schemaVersion: number,
  livePeer: () => boolean,
): string | undefined {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  const has = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().length > 0;
  if (version >= schemaVersion || !has('runs')) return undefined;
  if (has('gateway_owner') && livePeer()) return undefined;
  const dir = path.join(root, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prefix = `state-v${version}-before-subjects-`;
  const file = path.join(dir, `${prefix}${Date.now()}.sqlite`);
  db.prepare('VACUUM INTO ?').run(file);
  chmodSync(file, 0o600);
  const stamp = (name: string) => Number(name.slice(prefix.length, -'.sqlite'.length));
  const older = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.sqlite'))
    .sort((a, b) => stamp(b) - stamp(a))
    .slice(BACKUP_KEEP);
  for (const name of older) rmSync(path.join(dir, name), { force: true });
  return file;
}
