import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { withSavepoint } from './savepoint.js';

type Database = { db: DatabaseSync; prepare(sql: string): StatementSync };
export type MemorySearchOptions = {
  owner?: string;
  namespace?: string;
  limit?: number;
  forceFallback?: boolean;
};
export type MemorySearchHit = {
  namespace: string;
  key: string;
  value: unknown;
  score: number;
  updatedAt: number;
  revision?: string;
};

const CJK_CHAR = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;
const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const TOKEN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-zA-Z0-9_]+/gu;

export function extractSearchableText(value: unknown): string {
  const parts: string[] = [];
  let length = 0;
  const visit = (node: unknown, depth: number): void => {
    if (length >= 32_768 || depth > 12 || node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      const piece = String(node);
      parts.push(piece);
      length += piece.length + 1;
    } else if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
    } else if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        parts.push(k);
        length += k.length + 1;
        visit(v, depth + 1);
        if (length >= 32_768) break;
      }
    }
  };
  visit(value, 0);
  return parts.join(' ').slice(0, 32_768);
}

export const tokenizeForFts = (text: string): string =>
  text.replace(CJK_CHAR, ' $1 ').replace(/\s+/g, ' ').trim();

/** Double-quote every extracted token so FTS5 operators and punctuation never fail SQL parsing. */
export function escapeFts5Query(raw: string): string {
  const clauses: string[] = [];
  const push = (c: string) => {
    if (clauses.length < 48 && !clauses.includes(c)) clauses.push(c);
  };
  for (const match of String(raw ?? '')
    .slice(0, 2000)
    .matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (CJK_RUN.test(token)) {
      const chars = [...token];
      if (chars.length === 1) push(`"${chars[0]!}"`);
      else {
        if (chars.length <= 12) push(`"${chars.join(' ')}"`);
        for (let i = 0; i < chars.length - 1 && clauses.length < 48; i++)
          push(`"${chars[i]!} ${chars[i + 1]!}"`);
      }
    } else {
      const safe = token.toLowerCase().replace(/"/g, '""');
      if (safe) {
        push(`"${safe}"`);
        if (safe.length >= 4) push(`"${safe}"*`);
      }
    }
    if (clauses.length >= 48) break;
  }
  return clauses.join(' OR ');
}

function fallbackTerms(raw: string): { term: string; weight: number }[] {
  const terms: { term: string; weight: number }[] = [];
  const seen = new Set<string>();
  const add = (term: string, weight: number) => {
    if (term && !seen.has(term) && terms.length < 48) {
      seen.add(term);
      terms.push({ term, weight });
    }
  };
  for (const match of String(raw ?? '')
    .slice(0, 2000)
    .matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (CJK_RUN.test(token)) {
      const chars = [...token];
      if (chars.length === 1) add(chars[0]!, 1);
      else {
        if (chars.length <= 12) add(token, 2.5);
        for (let i = 0; i < chars.length - 1; i++) add(`${chars[i]!}${chars[i + 1]!}`, 1);
      }
    } else add(token.toLowerCase(), token.length >= 4 ? 1.5 : 1);
  }
  return terms;
}

const parseJsonSafe = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

function scoreFallbackCandidate(
  terms: { term: string; weight: number }[],
  namespace: string,
  key: string,
  body: string,
): number {
  const nsLower = namespace.toLowerCase(),
    keyLower = key.toLowerCase(),
    bodyLower = body.toLowerCase();
  let score = 0;
  for (const { term, weight } of terms) {
    if (keyLower === term) score += 4 * weight;
    else if (keyLower.includes(term)) score += 3 * weight;
    if (nsLower.includes(term)) score += 1.5 * weight;
    if (bodyLower.includes(term)) score += (1 + 1 / (1 + bodyLower.length / 512)) * weight;
  }
  return Number(score.toFixed(6));
}

const caches = new WeakMap<DatabaseSync, MemoryFts>();
export function memoryFts(store: Database): MemoryFts {
  let instance = caches.get(store.db);
  if (!instance) caches.set(store.db, (instance = new MemoryFts(store)));
  return instance;
}

type ScopeSpec = [
  kind: 'p' | 'm',
  meta: 'project' | 'private',
  table: 'project_memories' | 'memories',
  scopeCol: 'project' | 'subject',
  valCol: 'payload' | 'value',
  hasRevision: boolean,
];
const PROJECT_SPEC: ScopeSpec = ['p', 'project', 'project_memories', 'project', 'payload', true];
const PRIVATE_SPEC: ScopeSpec = ['m', 'private', 'memories', 'subject', 'value', false];

export class MemoryFts {
  readonly ftsAvailable: boolean;

  constructor(private readonly store: Database) {
    let available = false;
    try {
      store.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(owner UNINDEXED,scope UNINDEXED,namespace,key,body,tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS memory_fts_map(kind TEXT NOT NULL,owner TEXT NOT NULL,scope_id TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,fts_rowid INTEGER NOT NULL,PRIMARY KEY(kind,owner,scope_id,namespace,key));
        CREATE INDEX IF NOT EXISTS memory_fts_rowid ON memory_fts_map(fts_rowid);
        CREATE TABLE IF NOT EXISTS memory_fts_scopes(kind TEXT NOT NULL,owner TEXT NOT NULL,scope TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,done INTEGER NOT NULL,PRIMARY KEY(kind,owner,scope));
      `);
      available = true;
    } catch (error) {
      if (!(error instanceof Error && /no such module: fts5/i.test(error.message))) throw error;
      available = false;
    }
    this.ftsAvailable = available;
  }

  private tableExists(name: string): boolean {
    return !!this.store
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
      .get(name);
  }

  private upsertDoc(
    kind: 'p' | 'm',
    owner: string,
    scopeId: string,
    namespace: string,
    key: string,
    raw: string,
  ): void {
    if (!this.ftsAvailable) return;
    const prev = this.store
      .prepare(
        'SELECT fts_rowid FROM memory_fts_map WHERE kind=? AND owner=? AND scope_id=? AND namespace=? AND key=?',
      )
      .get(kind, owner, scopeId, namespace, key);
    if (prev)
      this.store.prepare('DELETE FROM memory_fts WHERE rowid=?').run(Number(prev.fts_rowid));
    const text = tokenizeForFts(extractSearchableText(parseJsonSafe(raw)));
    const res = this.store
      .prepare('INSERT INTO memory_fts(owner,scope,namespace,key,body) VALUES(?,?,?,?,?)')
      .run(owner, `${kind}:${scopeId}`, tokenizeForFts(namespace), tokenizeForFts(key), text);
    this.store
      .prepare(
        'INSERT INTO memory_fts_map VALUES(?,?,?,?,?,?) ON CONFLICT(kind,owner,scope_id,namespace,key) DO UPDATE SET fts_rowid=excluded.fts_rowid',
      )
      .run(kind, owner, scopeId, namespace, key, Number(res.lastInsertRowid));
  }

  private deleteDoc(
    kind: 'p' | 'm',
    owner: string,
    scopeId: string,
    namespace: string,
    key: string,
  ) {
    if (!this.ftsAvailable) return;
    const prev = this.store
      .prepare(
        'SELECT fts_rowid FROM memory_fts_map WHERE kind=? AND owner=? AND scope_id=? AND namespace=? AND key=?',
      )
      .get(kind, owner, scopeId, namespace, key);
    if (!prev) return;
    this.store.prepare('DELETE FROM memory_fts WHERE rowid=?').run(Number(prev.fts_rowid));
    this.store
      .prepare(
        'DELETE FROM memory_fts_map WHERE kind=? AND owner=? AND scope_id=? AND namespace=? AND key=?',
      )
      .run(kind, owner, scopeId, namespace, key);
  }

  private syncPage(
    [kind, , table, scopeCol, valCol]: ScopeSpec,
    owner: string,
    scope: string,
  ): boolean {
    const cursor = this.store
      .prepare(
        'SELECT namespace,key,done FROM memory_fts_scopes WHERE kind=? AND owner=? AND scope=?',
      )
      .get(kind, owner, scope);
    if (cursor?.done) return true;
    return withSavepoint(this.store.db, () => {
      const rows = this.store
        .prepare(
          `SELECT namespace,key,${valCol} AS v FROM ${table} WHERE owner=? AND ${scopeCol}=?
        ${cursor ? 'AND (namespace,key)>(?,?)' : ''} ORDER BY namespace,key LIMIT 64`,
        )
        .all(owner, scope, ...(cursor ? [String(cursor.namespace), String(cursor.key)] : []));
      for (const r of rows)
        this.upsertDoc(kind, owner, scope, String(r.namespace), String(r.key), String(r.v));
      const last = rows.at(-1) ?? cursor;
      const done = rows.length < 64;
      this.store
        .prepare('INSERT OR REPLACE INTO memory_fts_scopes VALUES(?,?,?,?,?,?)')
        .run(
          kind,
          owner,
          scope,
          String(last?.namespace ?? ''),
          String(last?.key ?? ''),
          Number(done),
        );
      return done;
    });
  }

  async warm(scopeType: 'project' | 'private', owner: string, scope: string) {
    const spec = scopeType === 'project' ? PROJECT_SPEC : PRIVATE_SPEC;
    if (!this.ftsAvailable || !this.tableExists(spec[2])) return;
    while (!this.syncPage(spec, owner, scope)) await yieldTurn();
  }

  private searchScope(
    spec: ScopeSpec,
    owner: string,
    scopeId: string,
    query: string,
    options: MemorySearchOptions = {},
  ): MemorySearchHit[] {
    const [kind, , table, scopeCol, valCol, hasRevision] = spec;
    if (!this.tableExists(table)) return [];
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const ns = options.namespace;
    const revSelect = hasRevision ? ', t.revision' : '';
    if (this.ftsAvailable && !options.forceFallback) {
      const ftsQuery = escapeFts5Query(query);
      if (!ftsQuery) return [];
      while (!this.syncPage(spec, owner, scopeId)) {
        /* synchronous kernel snapshots need a complete scope */
      }
      const rows = this.store
        .prepare(
          `SELECT t.namespace, t.key, t.${valCol} AS val, t.updated_at${revSelect},
                  bm25(memory_fts, 0.0, 0.0, 1.5, 3.0, 1.0) AS rank
           FROM memory_fts
           JOIN memory_fts_map map ON map.fts_rowid = memory_fts.rowid
           JOIN ${table} t
             ON map.kind = '${kind}' AND t.owner = map.owner AND t.${scopeCol} = map.scope_id
            AND t.namespace = map.namespace AND t.key = map.key
           WHERE memory_fts MATCH ? AND memory_fts.owner = ? AND memory_fts.scope = ?${ns === undefined ? '' : ' AND t.namespace = ?'}
           ORDER BY rank ASC, t.updated_at DESC, t.key ASC LIMIT ?`,
        )
        .all(ftsQuery, owner, `${kind}:${scopeId}`, ...(ns === undefined ? [] : [ns]), limit);
      return rows.map((r) => ({
        namespace: String(r.namespace),
        key: String(r.key),
        value: parseJsonSafe(String(r.val)),
        score: Math.max(0.000001, Number((-Number(r.rank)).toFixed(6))),
        updatedAt: Number(r.updated_at),
        ...(hasRevision ? { revision: String(r.revision) } : {}),
      }));
    }
    const terms = fallbackTerms(query);
    if (!terms.length) return [];
    const rows = this.store
      .prepare(
        `SELECT namespace,key,${valCol} AS val,updated_at${hasRevision ? ',revision' : ''} FROM ${table} WHERE owner=? AND ${scopeCol}=?${ns === undefined ? '' : ' AND namespace=?'} ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(owner, scopeId, ...(ns === undefined ? [] : [ns]));
    return rows
      .map((r) => {
        const value = parseJsonSafe(String(r.val));
        return {
          namespace: String(r.namespace),
          key: String(r.key),
          value,
          score: scoreFallbackCandidate(
            terms,
            String(r.namespace),
            String(r.key),
            extractSearchableText(value),
          ),
          updatedAt: Number(r.updated_at),
          ...(hasRevision ? { revision: String(r.revision) } : {}),
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  indexProject(owner: string, project: string, ns: string, key: string, payload: string) {
    this.upsertDoc('p', owner, project, ns, key, payload);
  }
  removeProject(owner: string, project: string, ns: string, key: string) {
    this.deleteDoc('p', owner, project, ns, key);
  }
  indexPrivate(owner: string, subject: string, ns: string, key: string, payload: string) {
    this.upsertDoc('m', owner, subject, ns, key, payload);
  }
  removePrivate(owner: string, subject: string, ns: string, key: string) {
    this.deleteDoc('m', owner, subject, ns, key);
  }
  searchProject(owner: string, projectId: string, query: string, opts?: MemorySearchOptions) {
    return this.searchScope(PROJECT_SPEC, owner, projectId, query, opts);
  }
  searchPrivate(owner: string, subject: string, query: string, opts?: MemorySearchOptions) {
    return this.searchScope(PRIVATE_SPEC, owner, subject, query, opts);
  }
}

export function searchProjectMemory(
  store: Database,
  projectId: string,
  query: string,
  options: MemorySearchOptions = {},
): MemorySearchHit[] {
  const owner =
    options.owner ??
    String(
      store.prepare('SELECT owner FROM projects WHERE id=? LIMIT 1').get(projectId)?.owner ?? '',
    );
  return owner ? memoryFts(store).searchProject(owner, projectId, query, options) : [];
}
