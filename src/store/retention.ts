/**
 * Data retention: delete finished runs older than a cutoff together with everything that only
 * they reference (events, steps, approvals, output baselines, summaries, per-run key usage rows,
 * webhook approval announcements, artifacts and their blobs), plus uploads (including stored
 * image inputs) and session workspaces nobody references any more. Developer-platform ledger rows,
 * key usage totals and webhook delivery logs are records, not run data, and are kept.
 *
 * Nothing calls this unless the operator asks for it (`oaa prune`, `POST /v1/maintenance/prune`, or a
 * configured `retention.runsDays`); the default configuration never deletes anything.
 *
 * Safety rules:
 * - only terminal runs (completed / failed / cancelled / incomplete) whose last update is older
 *   than the cutoff; queued, in-progress, waiting-for-approval and interrupted runs are kept;
 * - a run whose parent (delegation) is still kept is kept too;
 * - a file still listed in a kept run's `fileIds` (continuations inherit files) is kept;
 * - work is done in short IMMEDIATE transactions of `batchSize` runs, yielding between batches,
 *   so a live gateway keeps serving requests;
 * - blobs are removed after their rows are committed; a crash in between leaves orphan blobs,
 *   which the next prune sweeps.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sha } from '../core/util.js';
import { RECOVERABLE_WORKFLOW_STATES } from './task-workflows.js';
import { isStagingArtifact } from './large-artifacts.js';

/**
 * Bumped whenever a prune deleted runs. Caches built from run summaries (the console's activity
 * window) compare it and rebuild, so pruned runs do not linger in them.
 */
export const pruneGeneration = { value: 0 };

export type PruneOptions = {
  /** Runs (and unreferenced uploads/workspaces) last updated before `now - olderThanMs` go. */
  olderThanMs: number;
  dryRun?: boolean;
  /** Limit to one owner (the HTTP route); all owners when omitted. */
  owner?: string;
  now?: number;
  batchSize?: number;
  /** Local worker data directory whose `sessions/` workspaces may be swept. */
  workerDataDir?: string;
  /** Called between batches; the gateway yields to its event loop here. */
  pause?: () => Promise<void>;
};
export type PruneReport = {
  dry_run: boolean;
  cutoff: string;
  runs: number;
  events: number;
  files: number;
  file_bytes: number;
  workspaces: number;
  database_bytes_before: number;
  database_bytes_after: number;
};
/** The store pieces retention needs; keeps this module independent of the Store class. */
export type PrunableStore = {
  readonly db: DatabaseSync;
  readonly root: string;
  /** Drop in-memory projections of deleted runs. */
  forget?: (runIds: string[], owners: string[]) => void;
};

const TERMINAL = "('completed','failed','cancelled','incomplete')";
const RUN_TABLES = ['events', 'steps', 'approvals', 'run_output_baselines', 'run_summaries'];

export function databaseBytes(root: string): Promise<number> {
  return Promise.all(
    ['state.sqlite', 'state.sqlite-wal'].map((f) =>
      stat(path.join(root, f)).then(
        (s) => s.size,
        () => 0,
      ),
    ),
  ).then(([a, b]) => a! + b!);
}

/** Parse `30d`, `12h`, `45m`, `90s` or a bare number of days. */
export function parseAge(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([dhms]?)$/.exec(text.trim());
  if (!m) throw new Error(`Invalid age '${text}'. Use e.g. 30d, 12h, 45m.`);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, '': 86_400_000 }[
    m[2] as 'd' | 'h' | 'm' | 's' | ''
  ];
  const ms = Number(m[1]) * unit;
  if (!(ms > 0)) throw new Error(`Invalid age '${text}'. It must be positive.`);
  return ms;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function candidates(db: DatabaseSync, cutoff: number, owner: string | undefined, limit: number) {
  const old = (alias: string) =>
    `${alias}.status IN ${TERMINAL} AND json_valid(${alias}.payload) AND json_extract(${alias}.payload,'$.updatedAt')<?`;
  // A developer-platform ledger row still `in_progress` is settled from the run at the next
  // reconciliation; deleting the run first would settle it as interrupted with 0 tokens.
  const unsettled = hasTable(db, 'platform_ledger')
    ? `AND NOT EXISTS (SELECT 1 FROM platform_ledger l WHERE l.run_id=r.id AND l.status='in_progress')`
    : '';
  const workflowStages = hasTable(db, 'workflow_executions')
    ? `AND (r.owner,r.id) NOT IN (SELECT w.owner,n.value FROM workflow_executions w,
        json_each(w.payload,'$.nodes') n WHERE w.status IN ${RECOVERABLE_WORKFLOW_STATES} AND n.type='text')`
    : '';
  return db
    .prepare(
      `SELECT r.id,r.owner,r.session_id FROM runs r WHERE ${old('r')} ${owner === undefined ? '' : 'AND r.owner=?'}
       AND NOT EXISTS (SELECT 1 FROM runs p WHERE p.id=json_extract(r.payload,'$.metadata."oaa.parent_run_id"') AND NOT (${old('p')}))
       ${unsettled} ${workflowStages}
       ORDER BY r.rowid LIMIT ?`,
    )
    .all(...(owner === undefined ? [cutoff, cutoff, limit] : [cutoff, owner, cutoff, limit]))
    .map((row) => ({
      id: String(row.id),
      owner: String(row.owner),
      session: String(row.session_id),
    }));
}

/** File ids still listed by a run that stays. */
function referencedFiles(db: DatabaseSync, dryIds: Set<string>, owner?: string): Set<string> {
  const refs = new Set<string>();
  const args = owner === undefined ? [] : [owner];
  for (const r of db
    .prepare(
      `SELECT r.owner,r.id AS run,j.value AS file FROM runs r,
      json_each(CASE WHEN json_valid(r.payload) THEN r.payload ELSE '{}' END,'$.fileIds') j
      ${owner === undefined ? '' : 'WHERE r.owner=?'}`,
    )
    .iterate(...args)) {
    if (!dryIds.has(String(r.run))) refs.add(`${r.owner}\0${r.file}`);
  }
  if (hasTable(db, 'workflow_executions')) {
    // Stage arguments and $ref inputs can name a file before any child run exists.
    for (const r of db
      .prepare(
        `SELECT w.owner,j.atom AS file FROM workflow_executions w,json_tree(w.payload) j
      WHERE w.status IN ${RECOVERABLE_WORKFLOW_STATES} ${owner === undefined ? '' : 'AND w.owner=?'}
      AND j.type='text' AND (j.atom GLOB 'file_*' OR j.atom GLOB 'artifact_*')`,
      )
      .iterate(...args)) {
      refs.add(`${r.owner}\0${r.file}`);
    }
  }
  return refs;
}

export async function prune(store: PrunableStore, options: PruneOptions): Promise<PruneReport> {
  const { db, root } = store;
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanMs;
  const batch = options.batchSize ?? 200;
  const dryRun = !!options.dryRun;
  const report: PruneReport = {
    dry_run: dryRun,
    cutoff: new Date(cutoff).toISOString(),
    runs: 0,
    events: 0,
    files: 0,
    file_bytes: 0,
    workspaces: 0,
    database_bytes_before: await databaseBytes(root),
    database_bytes_after: 0,
  };
  // Per-run rows of optional tables (present once their feature has been used).
  const runTables = ['api_key_run_tokens', 'webhook_announced'].filter((t) => hasTable(db, t));
  const blobs: string[] = [];
  const dryIds = new Set<string>();
  if (dryRun) {
    // Count without deleting: walk the same candidate query to its end.
    const all = candidates(db, cutoff, options.owner, Number.MAX_SAFE_INTEGER);
    report.runs = all.length;
    for (const run of all) dryIds.add(run.id);
    for (const run of all) {
      report.events += Number(
        db.prepare('SELECT count(*) AS n FROM events WHERE run_id=?').get(run.id)!.n,
      );
    }
  } else {
    for (;;) {
      const runs = candidates(db, cutoff, options.owner, batch);
      if (!runs.length) break;
      const ids = runs.map((r) => r.id);
      const marks = ids.map(() => '?').join(',');
      db.exec('BEGIN IMMEDIATE');
      try {
        report.events += Number(
          db.prepare(`DELETE FROM events WHERE run_id IN (${marks})`).run(...ids).changes,
        );
        for (const table of RUN_TABLES.slice(1))
          db.prepare(`DELETE FROM ${table} WHERE run_id IN (${marks})`).run(...ids);
        for (const table of runTables)
          db.prepare(`DELETE FROM ${table} WHERE run_id IN (${marks})`).run(...ids);
        db.prepare(`DELETE FROM runs WHERE id IN (${marks})`).run(...ids);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      store.forget?.(ids, [...new Set(runs.map((r) => r.owner))]);
      pruneGeneration.value++;
      report.runs += runs.length;
      await options.pause?.();
    }
  }
  // Files: artifacts of deleted runs and old uploads, unless a kept run still lists them.
  let referenced = referencedFiles(db, dryIds, options.owner);
  const fileRows = db
    .prepare(
      `SELECT f.id,f.owner,json_extract(f.payload,'$.bytes') AS bytes,json_extract(f.payload,'$.runId') AS run_id,
        json_extract(f.payload,'$.createdAt') AS created FROM files f
       WHERE json_valid(f.payload) ${options.owner === undefined ? '' : 'AND f.owner=?'}`,
    )
    .all(...(options.owner === undefined ? [] : [options.owner]));
  const runExists = db.prepare('SELECT 1 FROM runs WHERE id=?');
  const doomed = fileRows.filter((row) => {
    if (referenced.has(`${row.owner}\0${row.id}`)) return false;
    // An artifact goes with its run; an upload goes once it is old and unreferenced.
    if (row.run_id) return dryIds.has(String(row.run_id)) || !runExists.get(String(row.run_id));
    return Number(row.created) < cutoff;
  });
  const revision = db.prepare('SELECT total_changes() AS n');
  let beforePause = revision.get()!.n;
  for (let i = 0; i < doomed.length; i += batch) {
    if (i && !dryRun && beforePause !== revision.get()!.n) {
      referenced = referencedFiles(db, dryIds, options.owner);
      beforePause = revision.get()!.n;
    }
    const slice = doomed
      .slice(i, i + batch)
      .filter((row) => !referenced.has(`${row.owner}\0${row.id}`));
    if (!slice.length) continue;
    report.files += slice.length;
    report.file_bytes += slice.reduce((n, row) => n + Number(row.bytes ?? 0), 0);
    if (dryRun) continue;
    const ids = slice.map((row) => String(row.id));
    db.prepare(`DELETE FROM files WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    blobs.push(...ids);
    beforePause = revision.get()!.n;
    await options.pause?.();
  }
  if (!dryRun) {
    for (const blob of blobs) await rm(path.join(root, 'files', blob), { force: true });
    if (options.owner === undefined) await sweepOrphanBlobs(db, root, cutoff);
  }
  if (options.workerDataDir)
    report.workspaces = await sweepWorkspaces(db, options.workerDataDir, cutoff, dryRun);
  if (!dryRun && report.runs + report.files > 0) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  report.database_bytes_after = await databaseBytes(root);
  return report;
}

/** Blobs left behind by an interrupted prune (row gone, file still on disk). */
async function sweepOrphanBlobs(db: DatabaseSync, root: string, cutoff: number): Promise<void> {
  const dir = path.join(root, 'files');
  const names = await readdir(dir).catch(() => [] as string[]);
  const known = db.prepare('SELECT 1 FROM files WHERE id=?');
  for (const name of names) {
    if (known.get(name) || isStagingArtifact(db, name)) continue;
    const info = await stat(path.join(dir, name)).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < cutoff && !known.get(name) && !isStagingArtifact(db, name))
      await rm(path.join(dir, name), { force: true });
  }
}

/**
 * Session workspaces live at `<worker>/sessions/<sha16(owner)>/<sessionId>`. One goes when no
 * run of that owner and session remains and it was last modified before the cutoff.
 */
async function sweepWorkspaces(
  db: DatabaseSync,
  workerDir: string,
  cutoff: number,
  dryRun: boolean,
): Promise<number> {
  const base = path.join(workerDir, 'sessions');
  const owners = new Map(
    db
      .prepare('SELECT DISTINCT owner FROM runs')
      .all()
      .map((row) => [sha(String(row.owner)).slice(0, 16), String(row.owner)]),
  );
  const exists = db.prepare('SELECT 1 FROM runs WHERE owner=? AND session_id=? LIMIT 1');
  let removed = 0;
  for (const hashed of await readdir(base).catch(() => [] as string[])) {
    const owner = owners.get(hashed);
    for (const session of await readdir(path.join(base, hashed)).catch(() => [] as string[])) {
      if (owner !== undefined && exists.get(owner, session)) continue;
      const dir = path.join(base, hashed, session);
      const info = await stat(dir).catch(() => undefined);
      if (!info?.isDirectory() || info.mtimeMs >= cutoff) continue;
      removed++;
      if (!dryRun) await rm(dir, { recursive: true, force: true });
    }
  }
  return removed;
}
