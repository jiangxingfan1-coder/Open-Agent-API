import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isOwnerWide, principalSubject, type Principal } from '../core/contracts.js';
import { Fault, sha } from '../core/util.js';
import { memoryFts, type MemorySearchHit, type MemorySearchOptions } from './project-fts.js';

type Database = { db: DatabaseSync; prepare(sql: string): StatementSync };
export type ProjectEntry = {
  namespace: string;
  key: string;
  value: unknown;
  revision: string;
  updatedAt: number;
};
const caches = new WeakMap<DatabaseSync, Projects>();
export function projects(store: Database): Projects {
  let value = caches.get(store.db);
  if (!value) caches.set(store.db, (value = new Projects(store)));
  return value;
}

export class Projects {
  constructor(private readonly store: Database) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS projects(owner TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS project_members(owner TEXT NOT NULL,project TEXT NOT NULL,subject TEXT NOT NULL,access TEXT NOT NULL,PRIMARY KEY(owner,project,subject));
      CREATE TABLE IF NOT EXISTS project_memories(owner TEXT NOT NULL,project TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,revision TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,project,namespace,key));
    `);
  }
  require(p: Principal, project: string, write = false): void {
    if (!this.store.prepare('SELECT 1 FROM projects WHERE owner=? AND id=?').get(p.owner, project))
      throw new Fault('scope_denied', 'The project is unavailable to this caller.', 403);
    if (isOwnerWide(p)) return;
    const row = this.store
      .prepare('SELECT access FROM project_members WHERE owner=? AND project=? AND subject=?')
      .get(p.owner, project, principalSubject(p));
    if (!row || (write && row.access !== 'write'))
      throw new Fault('scope_denied', 'The key has no matching project memory grant.', 403);
  }
  list(p: Principal) {
    return this.store
      .prepare('SELECT id,name,created_at FROM projects WHERE owner=? ORDER BY name,id')
      .all(p.owner)
      .filter((row) => {
        try {
          this.require(p, String(row.id));
          return true;
        } catch {
          return false;
        }
      })
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        created_at: Number(row.created_at),
        access: isOwnerWide(p)
          ? 'write'
          : String(
              this.store
                .prepare(
                  'SELECT access FROM project_members WHERE owner=? AND project=? AND subject=?',
                )
                .get(p.owner, String(row.id), principalSubject(p))?.access,
            ),
      }));
  }
  create(p: Principal, id: string, name: string) {
    if (!isOwnerWide(p))
      throw new Fault('scope_denied', 'Only the owner administrator manages projects.', 403);
    if (this.store.prepare('SELECT 1 FROM projects WHERE owner=? AND id=?').get(p.owner, id))
      throw new Fault('version_conflict', 'A project with this ID already exists.', 409);
    this.store.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(p.owner, id, name, Date.now());
    return { id, name };
  }
  members(p: Principal, id: string) {
    this.require(p, id);
    if (!isOwnerWide(p))
      throw new Fault('scope_denied', 'Only the owner administrator manages project grants.', 403);
    return this.store
      .prepare(
        'SELECT subject,access FROM project_members WHERE owner=? AND project=? ORDER BY subject',
      )
      .all(p.owner, id);
  }
  grant(p: Principal, id: string, subject: string, access: 'read' | 'write' | 'none') {
    this.members(p, id);
    if (access === 'none')
      this.store
        .prepare('DELETE FROM project_members WHERE owner=? AND project=? AND subject=?')
        .run(p.owner, id, subject);
    else
      this.store
        .prepare(
          'INSERT INTO project_members VALUES(?,?,?,?) ON CONFLICT(owner,project,subject) DO UPDATE SET access=excluded.access',
        )
        .run(p.owner, id, subject, access);
  }
  entries(p: Principal, id: string, namespace?: string, limit = 100): ProjectEntry[] {
    this.require(p, id);
    return this.store
      .prepare(
        `SELECT namespace,key,payload,revision,updated_at FROM project_memories WHERE owner=? AND project=?${namespace === undefined ? '' : ' AND namespace=?'} ORDER BY updated_at DESC,key LIMIT ?`,
      )
      .all(p.owner, id, ...(namespace === undefined ? [] : [namespace]), Math.min(500, limit))
      .map((row) => ({
        namespace: String(row.namespace),
        key: String(row.key),
        value: JSON.parse(String(row.payload)),
        revision: String(row.revision),
        updatedAt: Number(row.updated_at),
      }));
  }
  put(p: Principal, id: string, namespace: string, key: string, value: unknown, revision?: string) {
    this.require(p, id, true);
    const payload = JSON.stringify(value);
    if (payload === undefined || Buffer.byteLength(payload) > 32768)
      throw new Fault(
        'memory_too_large',
        'Project memory entries must be valid JSON within 32KB.',
        413,
      );
    const previous = this.store
      .prepare(
        'SELECT revision FROM project_memories WHERE owner=? AND project=? AND namespace=? AND key=?',
      )
      .get(p.owner, id, namespace, key);
    if (revision !== undefined && revision !== (previous?.revision ?? 'new'))
      throw new Fault(
        'version_conflict',
        'The project memory changed. Refresh before writing.',
        409,
      );
    const updatedAt = Date.now(),
      next = sha(`${updatedAt}:${payload}`);
    this.store
      .prepare(
        'INSERT INTO project_memories VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,project,namespace,key) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at',
      )
      .run(p.owner, id, namespace, key, payload, next, updatedAt);
    memoryFts(this.store).indexProject(p.owner, id, namespace, key, payload);
    return { namespace, key, value, revision: next, updatedAt };
  }
  get(p: Principal, id: string, namespace: string, key: string): ProjectEntry | undefined {
    this.require(p, id);
    const row = this.store
      .prepare(
        'SELECT payload,revision,updated_at FROM project_memories WHERE owner=? AND project=? AND namespace=? AND key=?',
      )
      .get(p.owner, id, namespace, key);
    return row
      ? {
          namespace,
          key,
          value: JSON.parse(String(row.payload)),
          revision: String(row.revision),
          updatedAt: Number(row.updated_at),
        }
      : undefined;
  }
  search(
    p: Principal,
    id: string,
    query: string,
    options: Omit<MemorySearchOptions, 'owner'> = {},
  ): MemorySearchHit[] {
    this.require(p, id);
    return memoryFts(this.store).searchProject(p.owner, id, query, options);
  }
  delete(p: Principal, id: string, namespace: string, key: string, revision: string) {
    this.require(p, id, true);
    const result = this.store
      .prepare(
        'DELETE FROM project_memories WHERE owner=? AND project=? AND namespace=? AND key=? AND revision=?',
      )
      .run(p.owner, id, namespace, key, revision);
    if (!result.changes)
      throw new Fault('version_conflict', 'The project memory changed or was removed.', 409);
    memoryFts(this.store).removeProject(p.owner, id, namespace, key);
  }
}
