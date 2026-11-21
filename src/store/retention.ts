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
 * - a file listed in a kept run's inputs or inherited artifacts keeps its bytes and origin grant;
 * - work is done in short IMMEDIATE transactions of `batchSize` runs, yielding between batches,
 *   so a live gateway keeps serving requests;
 * - blobs are removed after their rows are committed; a crash in between leaves orphan blobs,
 *   which the next prune sweeps.
 */
import { lstat, opendir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sha } from '../core/util.js';
import { RECOVERABLE_WORKFLOW_STATES } from './task-workflows.js';
import { isStagingArtifact } from './large-artifacts.js';
import { PruneProfile, pruneChannel } from './prune-profile.js';
import { pruneWrite } from './prune-write.js';
import { prepareArtifactOrigins } from './artifact-origin.js';

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
  /** Time already spent waiting for another maintenance operation, not a SQLite lock. */
  queueMs?: number;
  /** Do not synchronously wait for another SQLite reader/writer on the gateway thread. */
  live?: boolean;
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

function candidateQuery(db: DatabaseSync, cutoff: number, owner?: string) {
  const ledger = hasTable(db, 'platform_ledger'),
    workflows = hasTable(db, 'workflow_executions'),
    keys = hasTable(db, 'api_key_pending_runs');
  const eligible = (a: string) => `${a}.status IN ${TERMINAL}
    AND json_extract(CASE WHEN json_valid(${a}.payload) THEN ${a}.payload END,'$.updatedAt')<:cutoff
    ${ledger ? `AND NOT EXISTS(SELECT 1 FROM platform_ledger l WHERE l.run_id=${a}.id AND l.status='in_progress')` : ''}
    ${keys ? `AND NOT EXISTS(SELECT 1 FROM api_key_pending_runs k WHERE k.run_id=${a}.id)` : ''}
    ${
      workflows
        ? `AND (${a}.owner,${a}.id) NOT IN (SELECT w.owner,n.value FROM workflow_executions w,
      json_each(w.payload,'$.nodes') n WHERE w.status IN ${RECOVERABLE_WORKFLOW_STATES} AND n.type='text')`
        : ''
    }`;
  const parent = (a: string) =>
    `json_extract(CASE WHEN json_valid(${a}.payload) THEN ${a}.payload END,'$.metadata."oaa.parent_run_id"')`;
  // Follow only actual delegation chains, including protected grandparents. UNION terminates legacy cycles.
  const statement =
    db.prepare(`SELECT r.id,r.owner FROM runs r WHERE ${eligible('r')} ${owner === undefined ? '' : 'AND r.owner=:owner'}
    AND (${parent('r')} IS NULL OR NOT EXISTS (
      WITH RECURSIVE ancestors(id) AS (SELECT ${parent('r')}
        UNION SELECT ${parent('p')} FROM runs p JOIN ancestors a ON p.id=a.id)
      SELECT 1 FROM ancestors a JOIN runs p ON p.id=a.id WHERE p.owner<>r.owner OR NOT coalesce((${eligible('p')}),0)
    )) ORDER BY r.rowid LIMIT :n`);
  return (n: number) =>
    statement
      .all({ cutoff, n, ...(owner === undefined ? {} : { owner }) })
      .map((row) => ({ id: String(row.id), owner: String(row.owner) }));
}

/** File ids still listed by a run that stays. */
function referencedFiles(db: DatabaseSync, dryIds: Set<string>, owner?: string): Set<string> {
  const refs = new Set<string>();
  const args = owner === undefined ? [] : [owner];
  for (const field of ['fileIds', 'artifactIds'])
    for (const r of db
      .prepare(
        `SELECT r.owner,r.id AS run,j.value AS file FROM runs r,
      json_each(CASE WHEN json_valid(r.payload) THEN r.payload ELSE '{}' END,'$.${field}') j
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
  const profile = pruneChannel.hasSubscribers ? new PruneProfile() : undefined;
  let ok = false;
  try {
    const result = await executePrune(store, options, profile);
    ok = true;
    return result;
  } finally {
    profile?.finish(options.owner === undefined ? 'global' : 'owner', options.queueMs ?? 0, ok);
  }
}

async function executePrune(
  store: PrunableStore,
  options: PruneOptions,
  profile?: PruneProfile,
): Promise<PruneReport> {
  const { db, root } = store;
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanMs;
  const batch = options.batchSize ?? 200;
  const dryRun = !!options.dryRun;
  const pause = async () => {
    const start = performance.now();
    await options.pause?.();
    profile?.add('yield', start);
  };
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
  const dryIds = new Set<string>();
  const candidates = candidateQuery(db, cutoff, options.owner);
  if (dryRun) {
    // Count without deleting: walk the same candidate query to its end.
    const start = performance.now();
    const all = candidates(Number.MAX_SAFE_INTEGER);
    report.runs = all.length;
    for (const run of all) dryIds.add(run.id);
    const count = db.prepare('SELECT count(*) AS n FROM events WHERE run_id=?');
    for (const run of all) {
      report.events += Number(count.get(run.id)!.n);
    }
    profile?.add('candidate', start);
  } else {
    const preserveOrigins = prepareArtifactOrigins(db);
    for (;;) {
      const removed = await pruneWrite(
        db,
        !!options.live,
        profile,
        () => {
          const start = performance.now();
          const runs = candidates(batch);
          profile?.add('candidate', start);
          if (!runs.length) return undefined;
          const ids = runs.map((r) => r.id);
          const marks = ids.map(() => '?').join(',');
          const phase = performance.now();
          preserveOrigins.run(JSON.stringify(ids));
          const events = Number(
            db.prepare(`DELETE FROM events WHERE run_id IN (${marks})`).run(...ids).changes,
          );
          for (const table of RUN_TABLES.slice(1))
            db.prepare(`DELETE FROM ${table} WHERE run_id IN (${marks})`).run(...ids);
          for (const table of runTables)
            db.prepare(`DELETE FROM ${table} WHERE run_id IN (${marks})`).run(...ids);
          db.prepare(`DELETE FROM runs WHERE id IN (${marks})`).run(...ids);
          profile?.add('delete', phase);
          return { ids, owners: [...new Set(runs.map((r) => r.owner))], events };
        },
        (result, held) => {
          if (!result) return;
          pruneGeneration.value++;
          store.forget?.(result.ids, result.owners);
          report.runs += result.ids.length;
          report.events += result.events;
          if (profile) {
            profile.batches++;
            profile.maxRunBatchMs = Math.max(profile.maxRunBatchMs, held);
          }
        },
      );
      if (!removed) break;
      await pause();
    }
  }
  // Files: artifacts of deleted runs and old uploads, unless a kept run still lists them.
  const filePage = db.prepare(
    `SELECT f.rowid AS position,f.id,f.owner,json_extract(f.payload,'$.bytes') AS bytes,json_extract(f.payload,'$.runId') AS run_id,
        json_extract(f.payload,'$.createdAt') AS created FROM files f
       WHERE f.rowid>? AND f.rowid<=? AND json_valid(f.payload) ${options.owner === undefined ? '' : 'AND f.owner=?'}
       ORDER BY f.rowid LIMIT ?`,
  );
  const upper = Number(db.prepare('SELECT max(rowid) AS n FROM files').get()?.n ?? 0);
  const runExists = db.prepare('SELECT 1 FROM runs WHERE id=?');
  const revision = db.prepare(
    'SELECT total_changes() AS local, data_version AS external FROM pragma_data_version',
  );
  let refs = new Set<string>(),
    refsAt: string | undefined,
    position = 0;
  const version = () => {
    const r = revision.get()!;
    return `${r.local}:${r.external}`;
  };
  while (position < upper) {
    const scan = () => {
      const started = performance.now();
      const rows = filePage.all(
        position,
        upper,
        ...(options.owner === undefined ? [] : [options.owner]),
        batch,
      );
      position = rows.length ? Number(rows.at(-1)!.position) : upper;
      const candidates = rows.filter((r) =>
        r.run_id
          ? dryIds.has(String(r.run_id)) || !runExists.get(String(r.run_id))
          : Number(r.created) < cutoff,
      );
      if (candidates.length && refsAt !== version()) {
        refs = referencedFiles(db, dryIds, options.owner);
        refsAt = version();
      }
      const doomed = candidates.filter((r) => !refs.has(`${r.owner}\0${r.id}`));
      const ids = doomed.map((r) => String(r.id));
      if (!dryRun && ids.length) {
        db.prepare(`DELETE FROM files WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        refsAt = version();
      }
      profile?.add('files', started);
      return { ids, bytes: doomed.reduce((n, r) => n + Number(r.bytes ?? 0), 0) };
    };
    const result = dryRun ? scan() : await pruneWrite(db, !!options.live, profile, scan);
    report.files += result.ids.length;
    report.file_bytes += result.bytes;
    if (!dryRun) {
      const started = performance.now();
      for (const id of result.ids) await rm(path.join(root, 'files', id), { force: true });
      profile?.add('unlink', started);
      if (position < upper) await pause();
    }
  }
  if (!dryRun && options.owner === undefined) {
    const t = performance.now();
    await sweepOrphanBlobs(db, root, cutoff);
    profile?.add('sweep', t);
  }
  if (options.workerDataDir) {
    const start = performance.now();
    report.workspaces = await sweepWorkspaces(db, options.workerDataDir, cutoff, dryRun);
    profile?.add('sweep', start);
  }
  if (!dryRun && report.runs + report.files > 0) {
    const t = performance.now();
    const mode = options.live ? 'PASSIVE' : 'TRUNCATE';
    const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get()!;
    if (profile)
      profile.checkpoint = {
        mode,
        busy: Number(row.busy),
        log: Number(row.log),
        checkpointed: Number(row.checkpointed),
      };
    profile?.add('checkpoint', t);
  }
  report.database_bytes_after = await databaseBytes(root);
  profile?.sampleDatabase(db);
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
  if (!(await lstat(base).catch(() => undefined))?.isDirectory()) return 0;
  const hashes = new Map<string, string>();
  const matchingSession = db.prepare('SELECT DISTINCT owner FROM runs WHERE session_id=?');
  const kept = (hashed: string, session: string) => {
    for (const row of matchingSession.iterate(session)) {
      const name = String(row.owner);
      let key = hashes.get(name);
      if (!key) hashes.set(name, (key = sha(name).slice(0, 16)));
      if (key === hashed) return true;
    }
    return false;
  };
  let removed = 0;
  const buckets = await opendir(base).catch(() => undefined);
  if (!buckets) return 0;
  for await (const bucket of buckets) {
    if (!bucket.isDirectory() || !/^[a-f0-9]{16}$/.test(bucket.name)) continue;
    const sessions = await opendir(path.join(base, bucket.name), { bufferSize: 128 }).catch(
      () => undefined,
    );
    if (!sessions) continue;
    for await (const session of sessions) {
      if (!session.isDirectory() || kept(bucket.name, session.name)) continue;
      const dir = path.join(base, bucket.name, session.name);
      const info = await lstat(dir).catch(() => undefined);
      if (!info?.isDirectory() || info.mtimeMs >= cutoff || kept(bucket.name, session.name))
        continue;
      removed++;
      if (!dryRun) await rm(dir, { recursive: true, force: true });
    }
  }
  return removed;
}
