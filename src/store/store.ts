import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  AgentBundle,
  ExecutionStep,
  ModelMark,
  Run,
  RunEvent,
  RunStatus,
  FilePayload,
  OutputMessage,
} from '../core/contracts.js';
import { LEGACY_SUBJECT, terminal } from '../core/contracts.js';
import { TIMELINE_EVENT_TYPES, type RunEventType } from '../core/events.js';
import { LIMITS } from '../core/limits.js';
import { sourcesOf, transitionFault } from '../core/run-status.js';
import { inputPreview, textPrefix } from './inspection.js';
import { Fault, id, noAgent, sha, writePrivate, readBounded, relativeName } from '../core/util.js';
import {
  finishOutput,
  isOutputEvent,
  outputEventTypes,
  projectOutput,
  type EventInput,
} from './output.js';
import { putPrivateMemory, deletePrivateMemory } from './private-memory.js';
import { installRunOutcomes } from './run-outcomes.js';
import { installArtifactOrigins } from './artifact-origin.js';
import { indexRecoveryCandidates } from './recovery-candidates.js';
import { getArtifactByteLimit } from './large-artifacts.js';
import { terminalOptions, validateStepCompletion, type CheckpointOptions } from './checkpoint.js';
import {
  stageWorkflowCompletion,
  WORKFLOW_EVENT_READY,
  type WorkflowEventKey,
} from './workflow-events.js';
import { refreshWaiting, waitingOn } from './waiting.js';
import {
  approvalRows,
  approvalRow,
  writeApprovalRow,
  changeApprovalRows,
  keepParkedOnRestart,
  installApprovalIndexes,
  pendingWaiter,
  type Approval,
} from './approval-rows.js';
export type { Approval } from './approval-rows.js';
import { backupBeforeMigration } from './backup.js';
import { GatewayLease, hasLiveLease } from './gateway-lease.js';
import { tryBeginWrite } from './write-lock.js';
type Row = Record<string, unknown>;
/**
 * v4 partitions caller data by `subject` (normally the API key ID): runs, summaries, files,
 * memories and idempotency keys. Older gateways refuse a v4 database instead of ignoring it.
 */
const SCHEMA_VERSION = 4;
const MEMORY_COLUMNS =
  "owner TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,run_id TEXT,subject TEXT NOT NULL DEFAULT 'legacy',PRIMARY KEY(owner,subject,namespace,key)";
/** Idempotency keys are unique per caller; the stored column value is namespaced by subject. */
const idemKey = (subject: string, idem: string) => `${subject}\n${idem}`;
/** Event types a run timeline needs; output deltas and content parts are never read. */
const timelineEventTypes = TIMELINE_EVENT_TYPES;
type Projection = { messages: OutputMessage[]; updatedAt: number };
export type RunSummary = {
  id: string;
  agent: string;
  model: string;
  route: string;
  status: RunStatus;
  created_at: number;
  updated_at: number;
  elapsed_ms: number;
  usage: Run['usage'];
  error: Run['error'];
  input: string;
  /** 只在 requires_action 且有待处理待办时出现：caller＝全部是调用方工具，owner＝需要人工处理。 */
  waiting_on?: 'caller' | 'owner';
};
export type FileRecord = Omit<FilePayload, 'content'> & {
  owner: string;
  runId?: string;
  bytes: number;
  createdAt: number;
};
export type MemoryRecord = {
  owner: string;
  namespace: string;
  key: string;
  value: unknown;
  updatedAt: number;
  runId?: string;
};
/** One run as the activity pulse reads it; `ordinal` is the run's fixed insertion order. */
export type SummaryRow = {
  id: string;
  agent: string;
  status: RunStatus;
  created: number;
  updated: number;
  ordinal: number;
};
const summaryRow = (row: Row, created: number): SummaryRow => ({
  id: row.run_id as string,
  agent: row.agent_id as string,
  status: row.status as RunStatus,
  created,
  updated: Number(row.updated),
  ordinal: Number(row.ordinal),
});
export class Store {
  readonly db: DatabaseSync;
  readonly events = new EventEmitter();
  /** Synchronous database-only sink; public notifications and network I/O follow commit. */
  stageWebhook?: (run: Run, event: RunEvent) => (() => void) | undefined;
  private lease = new GatewayLease();
  private projections = new Map<string, Projection>();
  private runOwners = new Map<string, string>();
  private eventRing = new Map<string, { fromZero: boolean; events: RunEvent[] }>();
  private notifications: { name: string; value: unknown }[] = [];
  private notifying = false;
  private stmts = new Map<string, StatementSync>();
  private filePayloadCache = new Map<string, { sha256: string; payload: FilePayload }>();
  private bundleCache = new Map<string, AgentBundle>();
  private aliasDigestCache = new Map<string, string>();
  prepare(sql: string): StatementSync {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, 'state.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    try {
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-16000',
      );
      backupBeforeMigration(this.db, root, SCHEMA_VERSION, () => hasLiveLease(this.db));
      this.db.exec('BEGIN IMMEDIATE');
      const version = Number(this.prepare('PRAGMA user_version').get()!.user_version);
      if (version > SCHEMA_VERSION)
        throw new Fault('schema_too_new', 'This data directory requires a newer gateway.', 409);
      this.lease.claim(this.db);
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS bundles (digest TEXT PRIMARY KEY, owner TEXT NOT NULL, agent_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (owner TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL REFERENCES bundles(digest), PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, idem TEXT, fingerprint TEXT, subject TEXT, UNIQUE(owner,idem));
      CREATE UNIQUE INDEX IF NOT EXISTS active_session ON runs(owner,session_id) WHERE status IN ('queued','in_progress','requires_action');
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL, time INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_run ON events(run_id,id);
      CREATE INDEX IF NOT EXISTS run_retention_session ON runs(session_id,owner);
      CREATE INDEX IF NOT EXISTS event_reconciliation ON events(run_id,id) WHERE type='step.reconciled';
      CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS step_run ON steps(run_id);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL, subject TEXT);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), owner TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS approval_run ON approvals(run_id);
      CREATE TABLE IF NOT EXISTS run_output_baselines (run_id TEXT PRIMARY KEY REFERENCES runs(id), cursor INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_output ON events(run_id,id) WHERE type IN (${outputEventTypes.map((t) => `'${t}'`).join(',')});
      CREATE TABLE IF NOT EXISTS run_summaries (run_id TEXT PRIMARY KEY REFERENCES runs(id), owner TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, ordinal INTEGER NOT NULL, total_tokens INTEGER NOT NULL, usage_known INTEGER NOT NULL, payload TEXT NOT NULL, subject TEXT);
      CREATE INDEX IF NOT EXISTS summary_owner_order ON run_summaries(owner,ordinal);
      CREATE INDEX IF NOT EXISTS summary_owner_agent ON run_summaries(owner,agent_id,status);
      CREATE INDEX IF NOT EXISTS run_owner_status ON runs(owner,status);`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS node_policies (node_id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS node_policy_events (id INTEGER PRIMARY KEY AUTOINCREMENT,node_id TEXT NOT NULL,owner TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS node_policy_owner ON node_policy_events(owner,node_id,id);
        CREATE TABLE IF NOT EXISTS memories (${MEMORY_COLUMNS});`);
      this.migrateSubjects();
      installArtifactOrigins(this.db);
      installApprovalIndexes(this.db);
      indexRecoveryCandidates(this.db);
      if (version < 2) {
        for (const row of this.prepare('SELECT payload FROM runs ORDER BY rowid').all()) {
          const run = JSON.parse(row.payload as string) as Run;
          const cursor = Number(
            this.prepare('SELECT coalesce(max(id),0) AS cursor FROM events WHERE run_id=?').get(
              run.id,
            )!.cursor,
          );
          this.prepare('INSERT INTO run_output_baselines VALUES(?,?,?)').run(
            run.id,
            cursor,
            JSON.stringify(run.output),
          );
          this.prepare('UPDATE runs SET payload=? WHERE id=?').run(this.snapshot(run), run.id);
          this.saveSummary(run);
        }
      }
      installRunOutcomes(this.db);
      if (version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
      this.lease.acquired();
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.db.close();
      throw e;
    }
    this.events.setMaxListeners(1000);
  }
  private columns(table: string): Set<string> {
    return new Set(
      this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => String(r.name)),
    );
  }
  /**
   * v4: attribute existing rows to a subject inside the startup transaction. Malformed payloads
   * are skipped here (they become `legacy`) so the existing migrations report them unchanged. Runs use the key
   * recorded at submission (delegated runs inherit their parent's); artifacts follow their run;
   * an uploaded file follows the runs that used it when they all belong to one subject. Anything
   * else becomes `legacy`, readable only by owner-wide admins.
   */
  private migrateSubjects(): void {
    if (!this.columns('runs').has('subject')) {
      this.db.exec(`
        ALTER TABLE runs ADD COLUMN subject TEXT;
        UPDATE runs SET subject=coalesce(json_extract(payload,'$.subject'),json_extract(payload,'$.checkpoint.keyId')) WHERE json_valid(payload);`);
      // Delegation depth is bounded; each pass resolves one more level of nested delegates.
      const inherit = this.db.prepare(
        `UPDATE runs SET subject=(SELECT p.subject FROM runs p WHERE p.id=json_extract(runs.payload,'$.metadata."oaa.parent_run_id"'))
         WHERE subject IS NULL AND json_valid(payload) AND json_extract(payload,'$.metadata."oaa.parent_run_id"') IS NOT NULL
         AND (SELECT p.subject FROM runs p WHERE p.id=json_extract(runs.payload,'$.metadata."oaa.parent_run_id"')) IS NOT NULL`,
      );
      for (let pass = 0; pass < 16 && Number(inherit.run().changes) > 0; pass++);
      this.db.exec(`
        UPDATE runs SET subject='${LEGACY_SUBJECT}' WHERE subject IS NULL;
        UPDATE runs SET payload=json_set(payload,'$.subject',subject) WHERE json_valid(payload);
        UPDATE runs SET idem=subject||char(10)||idem WHERE idem IS NOT NULL;`);
    }
    if (!this.columns('run_summaries').has('subject'))
      this.db.exec(`
        ALTER TABLE run_summaries ADD COLUMN subject TEXT;
        UPDATE run_summaries SET subject=(SELECT subject FROM runs WHERE runs.id=run_summaries.run_id);`);
    if (!this.columns('files').has('subject'))
      this.db.exec(`
        ALTER TABLE files ADD COLUMN subject TEXT;
        UPDATE files SET subject=coalesce(
          (SELECT subject FROM runs WHERE json_valid(files.payload) AND runs.id=json_extract(files.payload,'$.runId')),
          (SELECT CASE WHEN count(DISTINCT r.subject)=1 THEN max(r.subject) END
            FROM runs r, json_each(CASE WHEN json_valid(r.payload) THEN r.payload ELSE '{}' END,'$.fileIds') j WHERE j.value=files.id),
          '${LEGACY_SUBJECT}');`);
    if (!this.columns('memories').has('subject'))
      this.db.exec(`
        CREATE TABLE memories_v4 (${MEMORY_COLUMNS});
        INSERT INTO memories_v4(owner,namespace,key,value,updated_at,run_id,subject)
          SELECT owner,namespace,key,value,updated_at,run_id,
            coalesce((SELECT subject FROM runs WHERE runs.id=memories.run_id),'${LEGACY_SUBJECT}') FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_v4 RENAME TO memories;`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS summary_owner_subject_order ON run_summaries(owner,subject,ordinal);
      CREATE INDEX IF NOT EXISTS run_owner_subject_status ON runs(owner,subject,status);
      CREATE INDEX IF NOT EXISTS file_owner_subject ON files(owner,subject);
      CREATE INDEX IF NOT EXISTS memory_scope_ns ON memories(owner,subject,namespace,updated_at DESC);`);
  }
  private snapshot(run: Run): string {
    return JSON.stringify({ ...run, output: [] });
  }
  private saveSummary(run: Run): void {
    const summary = {
      id: run.id,
      agent: run.agentId,
      model: run.route.model,
      route: run.route.id,
      status: run.status,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      usage: run.usage,
      error: run.error,
      input: inputPreview(run.input),
      ...waitingOn(this, run.id, run.status),
    };
    this.prepare(
      `INSERT INTO run_summaries(run_id,owner,agent_id,status,ordinal,total_tokens,usage_known,payload,subject)
      SELECT id,owner,agent_id,status,rowid,?,?,?,subject FROM runs WHERE id=?
      ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,total_tokens=excluded.total_tokens,usage_known=excluded.usage_known,payload=excluded.payload`,
    ).run(
      run.usage?.total_tokens ?? 0,
      run.usage === null ? 0 : run.metadata['oaa.usage_complete'] === 'false' ? 2 : 1,
      JSON.stringify(summary),
      run.id,
    );
  }
  private remember(runId: string, projection: Projection): void {
    this.projections.delete(runId);
    this.projections.set(runId, projection);
    if (this.projections.size > LIMITS.projectionCacheRuns)
      this.projections.delete(this.projections.keys().next().value!);
  }
  private rememberOwner(runId: string, owner: string): void {
    this.runOwners.delete(runId);
    this.runOwners.set(runId, owner);
    if (this.runOwners.size > 512) this.runOwners.delete(this.runOwners.keys().next().value!);
  }
  private ownerOf(runId: string): string | undefined {
    const cached = this.runOwners.get(runId);
    if (cached !== undefined) return cached;
    const row = this.prepare('SELECT owner FROM runs WHERE id=?').get(runId);
    if (!row) return undefined;
    const owner = String(row.owner);
    this.rememberOwner(runId, owner);
    return owner;
  }
  private appendHotEvents(runId: string, committed: RunEvent[], createdFresh = false): void {
    if (!committed.length && !createdFresh) return;
    let ring = this.eventRing.get(runId);
    if (createdFresh) {
      this.eventRing.delete(runId);
      ring = { fromZero: true, events: [...committed] };
      this.eventRing.set(runId, ring);
      if (this.eventRing.size > 64) this.eventRing.delete(this.eventRing.keys().next().value!);
      return;
    }
    if (!ring) {
      ring = { fromZero: false, events: [] };
      this.eventRing.set(runId, ring);
      if (this.eventRing.size > 64) this.eventRing.delete(this.eventRing.keys().next().value!);
    }
    ring.events.push(...committed);
    if (ring.events.length > 512) {
      ring.events.splice(0, ring.events.length - 512);
      ring.fromZero = false;
    }
  }
  private output(runId: string): Projection {
    const cached = this.projections.get(runId);
    if (cached) {
      this.remember(runId, cached);
      return cached;
    }
    const baseline = this.prepare(
      'SELECT cursor,payload FROM run_output_baselines WHERE run_id=?',
    ).get(runId);
    if (!baseline) throw new Fault('run_not_found', 'Response not found.', 404);
    let messages = JSON.parse(baseline.payload as string) as OutputMessage[];
    let updatedAt = 0;
    for (const row of this.prepare(
      `SELECT type,time,payload FROM events WHERE run_id=? AND id>? AND type IN (${outputEventTypes.map((t) => `'${t}'`).join(',')}) ORDER BY id`,
    ).iterate(runId, baseline.cursor as number)) {
      messages = projectOutput(messages, {
        type: row.type as RunEventType,
        data: JSON.parse(row.payload as string),
      });
      updatedAt = Number(row.time);
    }
    const projection = { messages, updatedAt };
    this.remember(runId, projection);
    return projection;
  }
  private notify(name: string, value: unknown): void {
    this.notifyBatch([{ name, value }]);
  }
  private notifyBatch(batch: { name: string; value: unknown }[]): void {
    // Reentrant observers may write more events; never deliver them ahead of this committed batch.
    this.notifications.push(...batch);
    if (this.notifying) return;
    this.notifying = true;
    try {
      while (this.notifications.length) {
        const { name, value } = this.notifications.shift()!;
        for (const listener of this.events.rawListeners(name)) {
          const failed = () => {
            this.events.off(name, listener as (...args: unknown[]) => void);
            process.emitWarning('Detached a failing store observer after commit.', {
              code: 'OAA_OBSERVER_FAILED',
            });
          };
          try {
            const result = listener.call(this.events, value);
            if (result && typeof result.then === 'function')
              void Promise.resolve(result).catch(failed);
          } catch {
            failed();
          }
        }
      }
    } finally {
      this.notifying = false;
    }
  }
  private rememberBundle(owner: string, bundle: AgentBundle): void {
    const key = `${owner}:${bundle.digest}`;
    this.bundleCache.delete(key);
    this.bundleCache.set(key, structuredClone(bundle));
    if (this.bundleCache.size > 64) {
      this.bundleCache.delete(this.bundleCache.keys().next().value!);
    }
  }
  publish(owner: string, bundle: AgentBundle, persistMetadata?: () => void): void {
    const existing = this.prepare('SELECT owner FROM bundles WHERE digest=?').get(bundle.digest) as
      Row | undefined;
    if (existing && existing.owner !== owner)
      throw new Fault('bundle_owner_conflict', 'The bundle digest belongs to another owner.', 409);
    const serialized = JSON.stringify(bundle);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.prepare('INSERT OR IGNORE INTO bundles VALUES(?,?,?,?,?)').run(
        bundle.digest,
        owner,
        bundle.agent.id,
        serialized,
        Date.now(),
      );
      this.prepare(
        'INSERT INTO agents VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET digest=excluded.digest',
      ).run(owner, bundle.agent.id, bundle.digest);
      persistMetadata?.();
      this.db.exec('COMMIT');
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
    this.aliasDigestCache.set(`${owner}:${bundle.agent.id}`, bundle.digest);
    if (serialized.length <= 262_144) this.rememberBundle(owner, bundle);
    this.notify('catalog', { agent: bundle.agent.id, digest: bundle.digest, owner });
  }
  bundle(owner: string, agentId: string, digest?: string): AgentBundle {
    const targetDigest = digest ?? this.aliasDigestCache.get(`${owner}:${agentId}`);
    if (targetDigest) {
      const cached = this.bundleCache.get(`${owner}:${targetDigest}`);
      if (cached && cached.agent.id === agentId) {
        return structuredClone(cached);
      }
    }
    const row = (
      digest
        ? this.prepare('SELECT payload FROM bundles WHERE owner=? AND agent_id=? AND digest=?').get(
            owner,
            agentId,
            digest,
          )
        : this.prepare(
            'SELECT b.payload FROM agents a JOIN bundles b ON b.digest=a.digest WHERE a.owner=? AND a.id=?',
          ).get(owner, agentId)
    ) as Row | undefined;
    if (!row) throw noAgent();
    const payloadStr = row.payload as string;
    const parsed = JSON.parse(payloadStr) as AgentBundle;
    if (!digest) this.aliasDigestCache.set(`${owner}:${agentId}`, parsed.digest);
    if (payloadStr.length <= 262_144) this.rememberBundle(owner, parsed);
    return parsed;
  }
  agents(owner: string): AgentBundle[] {
    return (
      this.prepare(
        'SELECT b.payload FROM agents a JOIN bundles b ON a.digest=b.digest WHERE a.owner=? ORDER BY a.id',
      ).all(owner) as Row[]
    ).map((r) => JSON.parse(r.payload as string));
  }
  agentDefinitions(owner: string, grants: string[]) {
    if (!grants.length) return [];
    const restricted = !grants.includes('*');
    return this.prepare(
      `SELECT a.digest,json_extract(b.payload,'$.agent') AS agent
      FROM agents a JOIN bundles b ON a.digest=b.digest AND a.owner=b.owner WHERE a.owner=?
      ${restricted ? `AND a.id IN (${grants.map(() => '?').join(',')})` : ''} ORDER BY a.id`,
    )
      .all(owner, ...(restricted ? grants : []))
      .map((row) => ({
        digest: String(row.digest),
        agent: JSON.parse(row.agent as string) as AgentBundle['agent'],
      }));
  }
  agentIndex(owner: string, grants: string[]) {
    return this.prepare(
      `SELECT id,digest FROM agents WHERE owner=?
      AND (? OR id IN (SELECT value FROM json_each(?))) ORDER BY id`,
    )
      .all(owner, grants.includes('*') ? 1 : 0, JSON.stringify(grants))
      .map((row) => ({ id: String(row.id), digest: String(row.digest) }));
  }
  agentSummaryRows(owner: string, digests: string[]) {
    if (!digests.length) return [];
    return this.prepare(
      `SELECT agent_id AS id,digest,
      substr(json_extract(payload,'$.agent.description'),1,1200) AS description,
      length(CAST(json_extract(payload,'$.agent.description') AS BLOB)) AS description_bytes,
      substr(json_extract(payload,'$.agent.engine'),1,512) AS engine,
      length(CAST(json_extract(payload,'$.agent.engine') AS BLOB)) AS engine_bytes,
      json_array_length(payload,'$.agent.tools') AS tools,
      json_array_length(payload,'$.agent.skills') AS skills,
      json_array_length(payload,'$.agent.routes') AS routes
      FROM bundles WHERE owner=? AND digest IN (${digests.map(() => '?').join(',')}) ORDER BY agent_id`,
    ).all(owner, ...digests);
  }
  agentDefinition(owner: string, agentId: string, digest?: string) {
    const row = digest
      ? this.prepare(
          "SELECT digest,json_extract(payload,'$.agent') AS agent FROM bundles WHERE owner=? AND agent_id=? AND digest=?",
        ).get(owner, agentId, digest)
      : this.prepare(
          "SELECT b.digest,json_extract(b.payload,'$.agent') AS agent FROM agents a JOIN bundles b ON a.digest=b.digest AND a.owner=b.owner WHERE a.owner=? AND a.id=?",
        ).get(owner, agentId);
    if (!row) throw noAgent();
    return {
      digest: String(row.digest),
      agent: JSON.parse(row.agent as string) as AgentBundle['agent'],
    };
  }
  authorizationChanged(owner: string): void {
    this.notify('authorization', { owner });
  }
  createRun(
    run: Run,
    idem?: string,
    fingerprint?: string,
    initial?: EventInput,
    stageAdmission?: () => () => void,
  ): { run: Run; created: boolean } {
    const subject = run.subject ?? LEGACY_SUBJECT;
    run.subject = subject;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (idem) {
        const found = this.findIdempotent(run.owner, subject, idem);
        if (found) {
          if (found.fingerprint !== fingerprint)
            throw new Fault(
              'idempotency_conflict',
              'This idempotency key was used for different input.',
              409,
            );
          this.db.exec('COMMIT');
          return { run: this.run(found.id, run.owner, subject), created: false };
        }
      }
      this.prepare(
        'INSERT INTO runs(id,owner,agent_id,session_id,status,payload,idem,fingerprint,subject) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        run.id,
        run.owner,
        run.agentId,
        run.sessionId,
        run.status,
        this.snapshot(run),
        idem ? idemKey(subject, idem) : null,
        fingerprint ?? null,
        subject,
      );
      this.prepare('INSERT INTO run_output_baselines VALUES(?,0,?)').run(
        run.id,
        JSON.stringify(run.output),
      );
      this.saveSummary(run);
      const event = initial ? this.insertEvent(run.id, initial) : undefined;
      const publishAdmission = stageAdmission?.();
      this.db.exec('COMMIT');
      publishAdmission?.();
      this.rememberOwner(run.id, run.owner);
      this.remember(run.id, {
        messages: run.output.map((m) => ({ ...m })),
        updatedAt: run.updatedAt,
      });
      this.appendHotEvents(run.id, event ? [event] : [], true);
      this.notifyBatch([
        ...(event ? [{ name: run.id, value: event }] : []),
        { name: 'summary', value: this.summaryChange(run) },
      ]);
      return { run, created: true };
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      if (String(e).includes('runs.owner, runs.session_id'))
        throw new Fault('session_busy', 'This session already has active work.', 409);
      throw e;
    }
  }
  /**
   * Load a run. `owner` / `subject` restrict visibility; a run outside them is reported as not
   * found so its existence is not revealed. Omitting `subject` means every subject of the owner.
   */
  run(runId: string, owner?: string, subject?: string): Run {
    const row = this.prepare('SELECT owner,subject,payload FROM runs WHERE id=?').get(runId) as
      Row | undefined;
    if (!row) throw new Fault('run_not_found', 'Response not found.', 404);
    if (
      (owner !== undefined && row.owner !== owner) ||
      (subject !== undefined && row.subject !== subject)
    )
      throw new Fault('run_not_found', 'Response not found.', 404);
    this.rememberOwner(runId, String(row.owner));
    const run = JSON.parse(row.payload as string) as Run;
    run.subject = String(row.subject ?? LEGACY_SUBJECT);
    const projection = this.output(runId);
    run.output = projection.messages.map((m) => ({ ...m }));
    run.updatedAt = Math.max(run.updatedAt, projection.updatedAt);
    return run;
  }
  runIdentity(runId: string, owner: string, subject?: string) {
    const row = this.prepare('SELECT agent_id,status,subject FROM runs WHERE id=? AND owner=?').get(
      runId,
      owner,
    );
    if (!row || (subject !== undefined && row.subject !== subject))
      throw new Fault('run_not_found', 'Response not found.', 404);
    return { id: runId, owner, agentId: row.agent_id as string, status: row.status as RunStatus };
  }
  /** An earlier submission by the same caller under this idempotency key, if any. */
  findIdempotent(
    owner: string,
    subject: string,
    idem: string,
  ): { id: string; fingerprint: string | null } | undefined {
    const row = this.prepare('SELECT id,fingerprint FROM runs WHERE owner=? AND idem=?').get(
      owner,
      idemKey(subject, idem),
    );
    return row
      ? {
          id: String(row.id),
          fingerprint: row.fingerprint === null ? null : String(row.fingerprint),
        }
      : undefined;
  }
  runOutput(runId: string, owner: string) {
    const identity = this.runIdentity(runId, owner);
    return { ...identity, output: this.output(runId).messages.map((m) => ({ ...m })) };
  }
  runState(runId: string, owner: string) {
    const identity = this.runIdentity(runId, owner);
    const row = this.prepare(
      `SELECT json_extract(payload,'$.digest','$.createdAt','$.updatedAt','$.route','$.usage','$.error','$.metadata."oaa.usage_complete"') AS head,json_array_length(payload,'$.artifactIds') AS artifacts,(json_extract(payload,'$.checkpoint.modelIdentity') IS NOT NULL AND json_extract(payload,'$.metadata."oaa.evaluation"') IS NULL) AS feedback_identity FROM runs WHERE id=?`,
    ).get(runId)!;
    const [digest, createdAt, updatedAt, route, usage, error, usageComplete] = JSON.parse(
      row.head as string,
    ) as [string, number, number, Run['route'], Run['usage'], Run['error'], string | null];
    const output = this.output(runId);
    const steps = Object.fromEntries(
      this.prepare(
        "SELECT json_extract(payload,'$.status') AS status,count(*) AS n FROM steps WHERE run_id=? GROUP BY status",
      )
        .all(runId)
        .map((r) => [String(r.status), Number(r.n)]),
    );
    const pending = this.prepare(
      "SELECT id,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.expiresAt') AS expires FROM approvals WHERE run_id=? AND json_extract(payload,'$.status')='pending' ORDER BY rowid LIMIT 6",
    ).all(runId);
    return {
      id: runId,
      agent: identity.agentId,
      engine: String(
        this.prepare(
          "SELECT json_extract(payload,'$.agent.engine') AS engine FROM bundles WHERE digest=? AND owner=?",
        ).get(digest, owner)?.engine ?? 'unknown',
      ),
      status: identity.status,
      feedback_eligible:
        row.feedback_identity === 1 &&
        (identity.status === 'completed' ||
          (identity.status === 'failed' &&
            ['output_contract', 'structured_output_invalid'].includes(error?.code ?? ''))),
      version: digest,
      route,
      created_at: createdAt,
      updated_at: Math.max(updatedAt, output.updatedAt),
      usage,
      usage_complete: usage !== null && usageComplete !== 'false',
      error: error
        ? { code: textPrefix(error.code, 256), message: textPrefix(error.message, 2000) }
        : null,
      output: {
        items: output.messages.length,
        characters: output.messages.reduce((n, m) => n + m.text.length, 0),
        preview: textPrefix(output.messages[0]?.text ?? '', 2000),
      },
      steps,
      pending_actions: pending
        .slice(0, 5)
        .map((a) => ({ id: String(a.id), kind: String(a.kind), expires_at: Number(a.expires) })),
      more_pending_actions: pending.length > 5,
      artifact_count: Number(row.artifacts),
      event_id: Number(
        this.prepare('SELECT coalesce(max(id),0) AS id FROM events WHERE run_id=?').get(runId)!.id,
      ),
    };
  }
  /**
   * Durable inputs for a run timeline: lifecycle events (never output deltas; large payloads are
   * trimmed in SQL), step metadata, model-turn marks and, only when graph steps exist, the
   * execute_graph arguments needed to recover graph dependencies.
   */
  timelineSource(runId: string, owner: string) {
    const identity = this.runIdentity(runId, owner);
    const head = this.prepare(
      `SELECT json_extract(payload,'$.createdAt','$.digest','$.checkpoint.marks') AS head FROM runs WHERE id=?`,
    ).get(runId)!;
    const [createdAt, digest, marks] = JSON.parse(head.head as string) as [
      number,
      string,
      ModelMark[] | null,
    ];
    const engine = String(
      this.prepare(
        "SELECT json_extract(payload,'$.agent.engine') AS engine FROM bundles WHERE digest=? AND owner=?",
      ).get(digest, owner)?.engine ?? 'kernel',
    );
    const events = this.prepare(
      `SELECT id,type,time,CASE
        WHEN type LIKE 'response.%' OR type='run.interrupted' THEN '{}'
        WHEN type='run.requires_action' THEN json_object('approval',json_object('id',json_extract(payload,'$.approval.id'),'stepId',json_extract(payload,'$.approval.stepId'),'kind',json_extract(payload,'$.approval.kind'),'detail',json_object('tool',json_extract(payload,'$.approval.detail.tool'),'native',json_extract(payload,'$.approval.detail.native'))))
        ELSE payload END AS payload
      FROM events WHERE run_id=? AND type IN (${timelineEventTypes.map((t) => `'${t}'`).join(',')}) ORDER BY id`,
    )
      .all(runId)
      .map((row) => ({
        id: Number(row.id),
        type: String(row.type),
        time: Number(row.time),
        data: JSON.parse(row.payload as string) as Record<string, unknown>,
      }));
    const lastEventId = Number(
      this.prepare('SELECT coalesce(max(id),0) AS id FROM events WHERE run_id=?').get(runId)!.id,
    );
    const steps = this.prepare(
      "SELECT id,json_extract(payload,'$.callId','$.name','$.status','$.startedAt') AS head FROM steps WHERE run_id=? ORDER BY rowid",
    )
      .all(runId)
      .map((row) => {
        const [callId, name, status, startedAt] = JSON.parse(row.head as string) as [
          string,
          string,
          string,
          number | null,
        ];
        return {
          id: String(row.id),
          callId: String(callId ?? ''),
          name: String(name ?? ''),
          status: String(status ?? ''),
          ...(typeof startedAt === 'number' ? { startedAt } : {}),
        };
      });
    let graphs: Map<string, unknown> | undefined;
    if (steps.some((step) => step.callId.includes(':'))) {
      graphs = new Map();
      for (const row of this.prepare(
        `SELECT json_extract(c.value,'$.id') AS id,json_extract(c.value,'$.arguments') AS args
        FROM runs r,json_each(r.payload,'$.checkpoint.messages') m,json_each(m.value,'$.tool_calls') c
        WHERE r.id=? AND json_extract(c.value,'$.name')='execute_graph'`,
      ).all(runId))
        if (typeof row.id === 'string' && typeof row.args === 'string')
          graphs.set(row.id, JSON.parse(row.args));
    }
    return {
      id: runId,
      status: identity.status,
      agentId: identity.agentId,
      createdAt: Number(createdAt),
      engine,
      marks: Array.isArray(marks) ? marks : [],
      events,
      steps,
      graphs,
      lastEventId,
    };
  }
  /**
   * Newest-first summaries created at or after `since`. Ordinal follows creation order, so the
   * scan reads index ranges in bounded chunks and stops at the window start instead of scanning
   * older history.
   */
  /**
   * Visible run summaries created at or after `since`, newest first. `after` restricts the scan to
   * rows inserted after that ordinal (an incremental read of runs created since the last scan).
   */
  summariesSince(
    owner: string,
    agents: string[],
    since: number,
    after = 0,
    subject?: string,
  ): SummaryRow[] {
    const scope = this.summaryScope(owner, agents, subject);
    const out: SummaryRow[] = [];
    let cursor = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const rows = this.prepare(
        `SELECT run_id,agent_id,status,ordinal,json_extract(payload,'$.created_at') AS created,json_extract(payload,'$.updated_at') AS updated FROM run_summaries WHERE ${scope.sql} AND ordinal<? AND ordinal>? ORDER BY ordinal DESC LIMIT 2000`,
      ).all(...scope.args, cursor, after);
      for (const row of rows) {
        const created = Number(row.created);
        if (created < since) return out;
        out.push(summaryRow(row, created));
      }
      if (rows.length < 2000) return out;
      cursor = Number(rows.at(-1)!.ordinal);
    }
  }
  /** Re-read specific summaries of one owner (runs whose status can still change). */
  summariesById(owner: string, ids: string[]): SummaryRow[] {
    const out: SummaryRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.prepare(
        `SELECT run_id,agent_id,status,ordinal,json_extract(payload,'$.created_at') AS created,json_extract(payload,'$.updated_at') AS updated FROM run_summaries WHERE owner=? AND run_id IN (${chunk.map(() => '?').join(',')})`,
      ).all(owner, ...chunk);
      for (const row of rows) out.push(summaryRow(row, Number(row.created)));
    }
    return out;
  }
  /** Why a queued run is queued: the latest lifecycle event decides (fresh runs: admission). */
  queueReason(runId: string): string {
    const row = this.prepare(
      `SELECT type,json_extract(payload,'$.reason') AS reason FROM events WHERE run_id=? AND type IN ('run.queued','response.created','response.in_progress','response.completed','response.failed','response.cancelled','response.incomplete','run.interrupted') ORDER BY id DESC LIMIT 1`,
    ).get(runId);
    return row?.type === 'run.queued' && typeof row.reason === 'string' ? row.reason : 'admission';
  }
  lastEventId(runId: string): number {
    return Number(
      this.prepare('SELECT coalesce(max(id),0) AS id FROM events WHERE run_id=?').get(runId)!.id,
    );
  }
  ownerOfRun(runId: string): string | undefined {
    return this.ownerOf(runId);
  }
  /** Median end-to-end duration of the owner's recent completed runs, or null without history. */
  /**
   * Recent end-to-end durations of one agent's completed runs (created → finished). A fallback for
   * queue estimates before the kernel has observed real slot occupancy since startup.
   */
  recentDurations(owner: string, agentId: string, samples = 50): number[] {
    return this.prepare(
      "SELECT json_extract(payload,'$.created_at','$.updated_at') AS times FROM run_summaries WHERE owner=? AND agent_id=? AND status='completed' ORDER BY ordinal DESC LIMIT ?",
    )
      .all(owner, agentId, samples)
      .map((row) => {
        const [created, updated] = JSON.parse(row.times as string) as [number, number];
        return Math.max(0, updated - created);
      });
  }
  stepPage(runId: string, owner: string, offset = 0, limit = 20, status?: ExecutionStep['status']) {
    this.runIdentity(runId, owner);
    const where = status ? " AND json_extract(payload,'$.status')=?" : '';
    const args = status ? [runId, status] : [runId];
    const total = Number(
      this.prepare(`SELECT count(*) AS n FROM steps WHERE run_id=?${where}`).get(...args)!.n,
    );
    const rows = this.prepare(
      `SELECT id,json_extract(payload,'$.name') AS name,json_extract(payload,'$.status') AS status,json_extract(payload,'$.effect') AS effect,json_extract(payload,'$.nodeId') AS node_id,substr(json_extract(payload,'$.error'),1,300) AS error,
          EXISTS(SELECT 1 FROM events e WHERE e.run_id=steps.run_id AND e.type='step.reconciled' AND json_extract(e.payload,'$.step_id')=steps.id) AS reconciled FROM steps WHERE run_id=?${where} ORDER BY rowid LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset);
    return {
      data: rows.map((row) => ({
        id: String(row.id),
        name: textPrefix(String(row.name), 400),
        status: String(row.status),
        effect: String(row.effect),
        node_id: row.node_id ?? null,
        error: row.error ?? null,
        reconciled: row.reconciled === 1,
      })),
      total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  private previewJson(raw: unknown, bytes: unknown) {
    const original = String(raw ?? 'null');
    let preview = textPrefix(original, 8000);
    const truncated = Buffer.byteLength(preview) < Number(bytes);
    if (!truncated) {
      const formatted = JSON.stringify(JSON.parse(preview), null, 2);
      if (Buffer.byteLength(JSON.stringify(formatted)) <= 16000) preview = formatted;
    }
    return { preview, bytes: Number(bytes), truncated };
  }
  stepDetails(runId: string, owner: string, stepId: string) {
    this.runIdentity(runId, owner);
    const row = this.prepare(
      `SELECT id,json_extract(payload,'$.name') AS name,json_extract(payload,'$.status') AS status,json_extract(payload,'$.effect') AS effect,json_extract(payload,'$.nodeId') AS node_id,substr(json_extract(payload,'$.error'),1,300) AS error,
      substr(json_quote(json_extract(payload,'$.arguments')),1,8000) AS args,length(CAST(json_quote(json_extract(payload,'$.arguments')) AS BLOB)) AS args_bytes,
      substr(json_quote(json_extract(payload,'$.result')),1,8000) AS result,length(CAST(json_quote(json_extract(payload,'$.result')) AS BLOB)) AS result_bytes
      FROM steps WHERE id=? AND run_id=?`,
    ).get(stepId, runId);
    if (!row) throw new Fault('step_not_found', 'Execution step not found.', 404);
    const reconciliation = this.prepare(
      "SELECT payload,time FROM events WHERE run_id=? AND type='step.reconciled' AND json_extract(payload,'$.step_id')=? ORDER BY id DESC LIMIT 1",
    ).get(runId, stepId);
    return {
      id: String(row.id),
      name: textPrefix(String(row.name), 400),
      status: String(row.status),
      effect: String(row.effect),
      node_id: row.node_id ?? null,
      error: row.error ?? null,
      arguments: this.previewJson(row.args, row.args_bytes),
      result: this.previewJson(row.result, row.result_bytes),
      reconciliation: reconciliation
        ? {
            ...JSON.parse(reconciliation.payload as string),
            recorded_at: Number(reconciliation.time),
          }
        : null,
    };
  }
  stepContent(runId: string, owner: string, stepId: string): string {
    this.runIdentity(runId, owner);
    const row = this.prepare('SELECT payload FROM steps WHERE id=? AND run_id=?').get(
      stepId,
      runId,
    );
    if (!row) throw new Fault('step_not_found', 'Execution step not found.', 404);
    return row.payload as string;
  }
  actionPage(runId: string, owner: string, offset = 0, limit = 5) {
    this.runIdentity(runId, owner);
    const where = "run_id=? AND owner=? AND json_extract(payload,'$.status')='pending'";
    const total = Number(
      this.prepare(`SELECT count(*) AS n FROM approvals WHERE ${where}`).get(runId, owner)!.n,
    );
    const rows = this.prepare(
      `SELECT id,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.stepId') AS step_id,json_extract(payload,'$.expiresAt') AS expires,
      substr(json_quote(json_extract(payload,'$.detail')),1,8000) AS detail,length(CAST(json_quote(json_extract(payload,'$.detail')) AS BLOB)) AS detail_bytes
      FROM approvals WHERE ${where} ORDER BY rowid LIMIT ? OFFSET ?`,
    ).all(runId, owner, limit, offset);
    return {
      data: rows.map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        step_id: String(row.step_id),
        expires_at: Number(row.expires),
        detail: this.previewJson(row.detail, row.detail_bytes),
      })),
      total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  artifacts(runId: string, owner: string, offset = 0, limit = 20) {
    this.runIdentity(runId, owner);
    const rows = this.prepare(
      `SELECT f.payload FROM runs r,json_each(r.payload,'$.artifactIds') a JOIN files f ON f.id=a.value AND f.owner=r.owner WHERE r.id=? ORDER BY CAST(a.key AS INTEGER) LIMIT ? OFFSET ?`,
    ).all(runId, limit + 1, offset);
    return {
      data: rows.slice(0, limit).map((row) => {
        const f = JSON.parse(row.payload as string) as FileRecord;
        return {
          id: f.id,
          filename: f.name,
          bytes: f.bytes,
          sha256: f.sha256,
          created_at: f.createdAt,
        };
      }),
      next_offset: rows.length > limit ? offset + limit : null,
    };
  }
  save(run: Run, stageAdmission?: () => () => void): void {
    if (!stageAdmission) return this.checkpoint(run);
    this.record(run, [], true, { stageAdmission });
  }
  checkpoint(run: Run, events: EventInput[] = [], final?: (view: Run) => EventInput): void {
    this.record(run, events, true, { final });
  }
  checkpointActions(
    run: Run,
    actions: Approval[] | 'expire',
    events: EventInput[],
    final?: (view: Run) => EventInput,
    committed?: () => void,
  ): void {
    this.record(run, events, true, { actions, final, committed });
  }
  checkpointTerminal(
    run: Run,
    events: EventInput[],
    final: (view: Run) => EventInput,
    failure?: { step?: ExecutionStep },
  ): void {
    this.record(run, events, true, terminalOptions(run, final, failure));
  }
  openApproval(run: Run, approval: Approval): void {
    const previous = run.status;
    run.status = 'requires_action';
    try {
      this.checkpointActions(
        run,
        [approval],
        [{ type: 'run.requires_action', data: { approval } }],
      );
    } catch (error) {
      run.status = previous;
      throw error;
    }
  }
  /**
   * 换用备选智能体：把运行改挂到另一个智能体名下，并在同一个事务里写入检查点和事件。
   * 目录列与摘要列一起改，避免出现「载荷说是 B、索引还是 A」的中间状态。
   */
  checkpointReassigned(run: Run, events: EventInput[]): void {
    this.record(run, events, true, { reassign: true });
  }
  checkpointStep(
    run: Run,
    step: ExecutionStep,
    event: EventInput,
    artifactIds: string[] = [],
  ): void {
    validateStepCompletion(this, run, step, artifactIds, event);
    this.record(run, [event], true, { completion: { step, artifactIds } });
  }
  /**
   * 外部智能体一轮的收尾：步骤完成、产物 ID 与检查点（含输出收尾事件）在同一个事务里落盘。
   * 与 checkpointStep 的区别只在事件：这里沿用运行检查点原有的事件，不另发 tool.completed。
   */
  checkpointNativeStep(
    run: Run,
    step: ExecutionStep,
    events: EventInput[],
    artifactIds: string[],
  ): void {
    validateStepCompletion(this, run, step, artifactIds);
    this.record(run, events, true, { completion: { step, artifactIds } });
  }
  recordOutput(run: Run, events: EventInput[]): void {
    if (
      !events.length ||
      events.some((e) => !isOutputEvent(e.type) && !e.type.startsWith('response.content_part.'))
    )
      throw new Fault('invalid_output_event', 'Output writes require output events.', 500);
    this.record(run, events, false);
  }
  private record(
    run: Run,
    specs: EventInput[],
    snapshot: boolean,
    options: CheckpointOptions = {},
  ): void {
    const { final, completion, reassign, stageAdmission, actions, committed } = options;
    const owner = this.ownerOf(run.id);
    if (owner !== run.owner) throw new Fault('run_not_found', 'Response not found.', 404);
    let messages = this.output(run.id).messages;
    for (const spec of specs) messages = projectOutput(messages, spec);
    const view = {
      ...run,
      artifactIds: completion
        ? [...new Set([...run.artifactIds, ...completion.artifactIds])]
        : run.artifactIds,
      output: messages.map((m) => ({ ...m })),
      updatedAt: Date.now(),
    };
    const events: RunEvent[] = [];
    let publishAdmission: (() => void) | undefined;
    let changed: Approval[] = [];
    let pending: WorkflowEventKey[] = [];
    let wakeWebhook: (() => void) | undefined;
    if (options.tryLock)
      tryBeginWrite(this.db, Number(this.prepare('PRAGMA busy_timeout').get()!.timeout));
    else this.db.exec('BEGIN IMMEDIATE');
    try {
      const enteringTerminal =
        snapshot &&
        final &&
        terminal(view.status) &&
        !this.prepare('SELECT 1 FROM runs WHERE id=? AND status=?').get(run.id, view.status);
      if (actions) changed = changeApprovalRows(this, run, actions);
      if (completion) this.step(completion.step);
      if (options.failedStep) this.step(options.failedStep);
      if (reassign) {
        this.prepare('UPDATE runs SET agent_id=? WHERE id=? AND owner=?').run(
          run.agentId,
          run.id,
          run.owner,
        );
        this.prepare('UPDATE run_summaries SET agent_id=? WHERE run_id=?').run(run.agentId, run.id);
      }
      for (const spec of specs) events.push(this.insertEvent(run.id, spec, view.updatedAt));
      if (snapshot) {
        this.writeStatus(view);
        this.saveSummary(view);
      }
      if (final) {
        const event = final(view);
        if (isOutputEvent(event.type))
          throw new Fault(
            'invalid_output_event',
            'A final lifecycle event cannot change output.',
            500,
          );
        events.push(this.insertEvent(run.id, event, view.updatedAt));
        if (enteringTerminal && event.type === 'response.completed') {
          try {
            pending = stageWorkflowCompletion(this, view);
          } catch {
            throw new Fault(
              'persistence_failed',
              'Could not checkpoint the workflow completion event.',
              500,
            );
          }
        }
      }
      if (this.stageWebhook)
        for (const event of events) {
          if (enteringTerminal || (actions && event.type === 'run.requires_action'))
            wakeWebhook = this.stageWebhook(view, event) ?? wakeWebhook;
        }
      publishAdmission = stageAdmission?.();
      this.db.exec('COMMIT');
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
    publishAdmission?.();
    committed?.();
    this.remember(run.id, { messages, updatedAt: view.updatedAt });
    this.appendHotEvents(run.id, events);
    run.output = view.output;
    run.updatedAt = view.updatedAt;
    run.artifactIds = view.artifactIds;
    this.notifyBatch([
      ...events.map((event) => ({ name: run.id, value: event })),
      // Delivered only after commit: summary/metrics read models never see provisional state.
      ...(snapshot ? [{ name: 'summary', value: this.summaryChange(view) }] : []),
      ...changed.map((a) => ({ name: `approval:${a.id}`, value: a })),
      ...pending.map((value) => ({ name: WORKFLOW_EVENT_READY, value })),
    ]);
    wakeWebhook?.();
  }
  /**
   * 落盘运行状态：转移表折进 UPDATE 的 WHERE（只有库里当前状态是合法来源时才写），不多一次往返；
   * 没写进去时才读一次当前状态，抛 invalid_run_transition，外层事务随之回滚。
   */
  private writeStatus(view: Run): void {
    const sources = sourcesOf(view.status, view.checkpoint.phase);
    const res = this.prepare(
      `UPDATE runs SET status=?,payload=? WHERE id=? AND owner=? AND status IN ('${sources.join("','")}')`,
    ).run(view.status, this.snapshot(view), view.id, view.owner);
    if (Number(res.changes) > 0) return;
    const row = this.prepare('SELECT status FROM runs WHERE id=? AND owner=?').get(
      view.id,
      view.owner,
    ) as Row | undefined;
    if (row) throw transitionFault(String(row.status), view.status, view.checkpoint.phase);
  }
  private summaryChange(run: Run) {
    return { owner: run.owner, runId: run.id, agentId: run.agentId, status: run.status };
  }
  allRuns(statuses?: RunStatus[]): Run[] {
    const where = statuses ? ` WHERE status IN (${statuses.map(() => '?').join(',')})` : '';
    return this.prepare(`SELECT id FROM runs${where} ORDER BY rowid`)
      .all(...(statuses ?? []))
      .map((r) => this.run(r.id as string));
  }
  /** Summary filter: owner, granted agents and, unless owner-wide, the caller's own subject. */
  summaryScope(owner: string, agents: string[], subject?: string) {
    const base = agents.includes('*')
      ? { sql: 'owner=?', args: [owner] }
      : {
          sql: `owner=? AND agent_id IN (${agents.map(() => '?').join(',')})`,
          args: [owner, ...agents],
        };
    return subject === undefined
      ? base
      : { sql: `${base.sql} AND subject=?`, args: [...base.args, subject] };
  }
  summaries(owner: string, agents: string[], limit = 50, subject?: string): RunSummary[] {
    const scope = this.summaryScope(owner, agents, subject);
    return this.prepare(
      `SELECT payload FROM run_summaries WHERE ${scope.sql} ORDER BY ordinal DESC LIMIT ?`,
    )
      .all(...scope.args, limit)
      .map((r) => {
        const summary = JSON.parse(r.payload as string) as RunSummary;
        summary.input = inputPreview(summary.input ?? '');
        summary.elapsed_ms =
          (terminal(summary.status) ? summary.updated_at : Date.now()) - summary.created_at;
        return summary;
      });
  }
  /** Run counts by current status within the owner/agents scope; queued + in_progress + requires_action = active. */
  metrics(owner: string, agents: string[], subject?: string) {
    const scope = this.summaryScope(owner, agents, subject);
    const row = this.prepare(
      `SELECT count(*) AS runs,coalesce(sum(status='completed'),0) AS completed,coalesce(sum(status IN ('queued','in_progress','requires_action')),0) AS active,coalesce(sum(status='queued'),0) AS queued,coalesce(sum(status='in_progress'),0) AS in_progress,coalesce(sum(status='requires_action'),0) AS requires_action,coalesce(sum(status='requires_action' AND EXISTS(SELECT 1 FROM approvals a WHERE a.run_id=run_summaries.run_id AND json_extract(a.payload,'$.status')='pending') AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.run_id=run_summaries.run_id AND json_extract(a.payload,'$.status')='pending' AND json_extract(a.payload,'$.kind')!='client_tool')),0) AS awaiting_caller,coalesce(sum(total_tokens),0) AS total_tokens,coalesce(sum(usage_known=0),0) AS unknown_usage_runs,coalesce(sum(usage_known=2),0) AS partial_usage_runs FROM run_summaries WHERE ${scope.sql}`,
    ).get(...scope.args)!;
    const metrics = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
    // 只在等调用方回传工具结果的运行不算「需要人处理」，计入进行中（三者之和仍等于 active）。
    metrics.requires_action! -= metrics.awaiting_caller!;
    metrics.in_progress! += metrics.awaiting_caller!;
    return metrics;
  }
  /** Unfinished runs of the owner, or of one caller subject when `subject` is given. */
  activeCount(owner: string, subject?: string): number {
    return Number(
      subject === undefined
        ? this.prepare(
            "SELECT count(*) AS n FROM runs WHERE owner=? AND status IN ('queued','in_progress','requires_action')",
          ).get(owner)!.n
        : this.prepare(
            "SELECT count(*) AS n FROM runs WHERE owner=? AND subject=? AND status IN ('queued','in_progress','requires_action')",
          ).get(owner, subject)!.n,
    );
  }
  private insertEvent(runId: string, spec: EventInput, time = Date.now()): RunEvent {
    const res = this.prepare('INSERT INTO events(run_id,type,time,payload) VALUES(?,?,?,?)').run(
      runId,
      spec.type,
      time,
      JSON.stringify(spec.data),
    );
    return { id: Number(res.lastInsertRowid), runId, type: spec.type, time, data: spec.data };
  }
  emit(runId: string, type: RunEventType, data: Record<string, unknown>): RunEvent {
    if (isOutputEvent(type))
      throw new Fault('invalid_output_event', 'Use the durable output writer.', 500);
    const event = this.insertEvent(runId, { type, data });
    this.appendHotEvents(runId, [event]);
    this.notify(runId, event);
    return event;
  }
  recentHistory(runId: string, after = 0, limit = 1000): RunEvent[] {
    const ring = this.eventRing.get(runId);
    if (ring) {
      const coversStart =
        (after === 0 && ring.fromZero) ||
        (ring.events.length > 0 && ring.events[0]!.id <= after + 1);
      if (coversStart) {
        const out: RunEvent[] = [];
        for (const ev of ring.events) {
          if (ev.id > after) {
            out.push(ev);
            if (out.length >= limit) break;
          }
        }
        return out;
      }
    }
    return this.history(runId, after, limit);
  }
  history(runId: string, after = 0, limit = 1000): RunEvent[] {
    return (
      this.prepare('SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id LIMIT ?').all(
        runId,
        after,
        limit,
      ) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      runId,
      time: Number(r.time),
      type: r.type as string,
      data: JSON.parse(r.payload as string),
    }));
  }
  private mutation(
    runId: string,
    write: () => void,
    event?: EventInput,
    notifications: { name: string; value: unknown }[] = [],
  ): void {
    if (!event) {
      write();
      this.notifyBatch(notifications);
      return;
    }
    if (isOutputEvent(event.type))
      throw new Fault('invalid_output_event', 'Use the durable output writer.', 500);
    let recorded: RunEvent;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      write();
      recorded = this.insertEvent(runId, event);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    this.appendHotEvents(runId, [recorded]);
    // Observers may dispatch work; neither the state nor its audit can be provisional.
    this.notifyBatch([{ name: runId, value: recorded }, ...notifications]);
  }
  step(step: ExecutionStep, event?: EventInput): void {
    this.mutation(
      step.runId,
      () => {
        const changed = this.prepare(
          'INSERT INTO steps VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE steps.run_id=excluded.run_id',
        ).run(step.id, step.runId, JSON.stringify(step));
        if (!changed.changes)
          throw new Fault('step_scope_mismatch', 'Step identity belongs to another run.', 403);
      },
      event,
    );
  }
  batchSteps(items: { step: ExecutionStep; event?: EventInput }[]): void {
    if (!items.length) return;
    const runId = items[0]!.step.runId;
    const events: RunEvent[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.prepare(
        'INSERT INTO steps VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE steps.run_id=excluded.run_id',
      );
      for (const item of items) {
        const changed = stmt.run(item.step.id, item.step.runId, JSON.stringify(item.step));
        if (!changed.changes)
          throw new Fault('step_scope_mismatch', 'Step identity belongs to another run.', 403);
        if (item.event) {
          events.push(this.insertEvent(item.step.runId, item.event));
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
    if (events.length) {
      this.appendHotEvents(runId, events);
      this.notifyBatch(events.map((e) => ({ name: runId, value: e })));
    }
  }
  steps(runId: string): ExecutionStep[] {
    return (
      this.prepare('SELECT payload FROM steps WHERE run_id=? ORDER BY rowid').all(runId) as Row[]
    ).map((r) => JSON.parse(r.payload as string));
  }
  getStep(stepId: string): ExecutionStep | undefined {
    const r = this.prepare('SELECT payload FROM steps WHERE id=?').get(stepId) as Row | undefined;
    return r ? (JSON.parse(r.payload as string) as ExecutionStep) : undefined;
  }
  approval(a: Approval, event?: EventInput): void {
    const notifications: { name: string; value: unknown }[] = [
      { name: `approval:${a.id}`, value: a },
    ];
    this.mutation(
      a.runId,
      () => {
        writeApprovalRow(this, a);
        notifications.push(...refreshWaiting(this, a.runId));
      },
      event,
      notifications,
    );
  }
  approvals(runId: string): Approval[] {
    return approvalRows(this, runId);
  }
  getApproval(approvalId: string, owner: string): Approval {
    return approvalRow(this, approvalId, owner);
  }
  /**
   * Store a file. An artifact (`runId`) always belongs to its run's subject; an upload belongs to
   * the uploading caller's `subject`.
   */
  async addFile(
    owner: string,
    name: string,
    bytes: Buffer,
    allowedNodes?: string[],
    runId?: string,
    subject?: string,
  ): Promise<FileRecord> {
    const fileSubject = runId
      ? String(
          this.prepare('SELECT subject FROM runs WHERE id=?').get(runId)?.subject ?? LEGACY_SUBJECT,
        )
      : (subject ?? LEGACY_SUBJECT);
    relativeName(name);
    if (bytes.length > (runId ? getArtifactByteLimit(this) : LIMITS.fileBytes))
      throw new Fault('file_too_large', 'File exceeds size limit.', 413);
    const file: FileRecord = {
      id: id(runId ? 'artifact' : 'file'),
      owner,
      name,
      sha256: sha(bytes),
      bytes: bytes.length,
      createdAt: Date.now(),
      allowedNodes,
      runId,
    };
    await writePrivate(path.join(this.root, 'files'), file.id, bytes, true);
    this.prepare('INSERT INTO files(id,owner,payload,subject) VALUES(?,?,?,?)').run(
      file.id,
      owner,
      JSON.stringify(file),
      fileSubject,
    );
    if (bytes.length <= LIMITS.fileBytes) {
      const payload: FilePayload = {
        id: file.id,
        name: file.name,
        content: bytes.toString('base64'),
        sha256: file.sha256,
        allowedNodes: file.allowedNodes,
      };
      this.filePayloadCache.set(file.id, { sha256: file.sha256, payload });
      if (this.filePayloadCache.size > LIMITS.filePayloadCacheFiles)
        this.filePayloadCache.delete(this.filePayloadCache.keys().next().value!);
    }
    return file;
  }
  /** A file of the owner; with `subject`, only that caller's files are visible. */
  file(fileId: string, owner: string, subject?: string): FileRecord {
    const row = this.prepare('SELECT payload,subject FROM files WHERE id=? AND owner=?').get(
      fileId,
      owner,
    ) as Row | undefined;
    if (!row || (subject !== undefined && row.subject !== subject))
      throw new Fault('file_not_found', 'File not found.', 404);
    return JSON.parse(row.payload as string);
  }
  async filePayload(fileId: string, owner: string, subject?: string): Promise<FilePayload> {
    const f = this.file(fileId, owner, subject);
    const cached = this.filePayloadCache.get(fileId);
    if (cached && cached.sha256 === f.sha256) return cached.payload;
    const maxBytes = f.runId ? getArtifactByteLimit(this) : LIMITS.fileBytes;
    const bytes = await readBounded(path.join(this.root, 'files'), f.id, maxBytes);
    if (sha(bytes) !== f.sha256)
      throw new Fault('file_integrity', 'File content has changed.', 500);
    const payload: FilePayload = {
      id: f.id,
      name: f.name,
      content: bytes.toString('base64'),
      sha256: f.sha256,
      allowedNodes: f.allowedNodes,
    };
    if (bytes.length <= LIMITS.fileBytes) {
      this.filePayloadCache.set(fileId, { sha256: f.sha256, payload });
      if (this.filePayloadCache.size > LIMITS.filePayloadCacheFiles)
        this.filePayloadCache.delete(this.filePayloadCache.keys().next().value!);
    }
    return payload;
  }
  /** Memories are partitioned per caller subject; there is no cross-subject read. */
  getMemory(
    owner: string,
    subject: string,
    namespace: string,
    key: string,
  ): MemoryRecord | undefined {
    const row = this.prepare(
      'SELECT value, updated_at, run_id FROM memories WHERE owner=? AND subject=? AND namespace=? AND key=?',
    ).get(owner, subject, namespace, key) as Row | undefined;
    if (!row) return undefined;
    let parsed: unknown = row.value;
    try {
      parsed = JSON.parse(String(row.value));
    } catch {}
    return {
      owner,
      namespace,
      key,
      value: parsed,
      updatedAt: Number(row.updated_at),
      ...(row.run_id ? { runId: String(row.run_id) } : {}),
    };
  }
  listMemories(
    owner: string,
    subject: string,
    namespace?: string,
    prefix?: string,
    limit = 100,
  ): MemoryRecord[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const rows = namespace
      ? (this.prepare(
          'SELECT namespace, key, value, updated_at, run_id FROM memories WHERE owner=? AND subject=? AND namespace=? ORDER BY updated_at DESC LIMIT ?',
        ).all(owner, subject, namespace, safeLimit) as Row[])
      : (this.prepare(
          'SELECT namespace, key, value, updated_at, run_id FROM memories WHERE owner=? AND subject=? ORDER BY updated_at DESC LIMIT ?',
        ).all(owner, subject, safeLimit) as Row[]);
    return rows
      .filter((r) => !prefix || String(r.key).startsWith(prefix))
      .map((r) => {
        let parsed: unknown = r.value;
        try {
          parsed = JSON.parse(String(r.value));
        } catch {}
        return {
          owner,
          namespace: String(r.namespace),
          key: String(r.key),
          value: parsed,
          updatedAt: Number(r.updated_at),
          ...(r.run_id ? { runId: String(r.run_id) } : {}),
        };
      });
  }
  putMemory(
    owner: string,
    subject: string,
    namespace: string,
    key: string,
    value: unknown,
    runId?: string,
  ): MemoryRecord {
    return putPrivateMemory(this, owner, subject, namespace, key, value, runId);
  }
  deleteMemory(owner: string, subject: string, namespace: string, key: string): boolean {
    return deletePrivateMemory(this, owner, subject, namespace, key);
  }
  /** Only caller responses are pending; there is no human decision to grant. */
  awaitingCaller(runId: string): boolean {
    return pendingWaiter(this, runId) === 'caller';
  }
  recover(): void {
    for (const run of this.allRuns(['in_progress', 'requires_action'])) {
      if (keepParkedOnRestart(this, run)) continue;
      for (const step of this.steps(run.id).filter((s) => s.status === 'running')) {
        step.status = ['write', 'unknown'].includes(step.effect) ? 'uncertain' : 'pending';
        this.step(step);
      }
      run.status = 'interrupted';
      run.error = {
        code: 'gateway_restarted',
        message:
          'Execution was interrupted. Explicit resume is required; completed steps are retained.',
      };
      run.metadata['oaa.usage_complete'] = 'false';
      const outputEvents = run.output.flatMap((m, i) =>
        !m.status || m.status === 'in_progress' ? finishOutput(m, i, 'incomplete') : [],
      );
      this.checkpointActions(run, 'expire', outputEvents, () => ({
        type: 'run.interrupted',
        data: { error: run.error },
      }));
    }
  }
  close(): void {
    delete this.stageWebhook;
    this.events.removeAllListeners();
    this.projections.clear();
    this.runOwners.clear();
    this.eventRing.clear();
    this.notifications = [];
    this.stmts.clear();
    this.filePayloadCache.clear();
    this.bundleCache.clear();
    this.aliasDigestCache.clear();
    this.lease.close(this.db);
  }
}
