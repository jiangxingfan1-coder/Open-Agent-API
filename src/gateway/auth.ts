import { randomBytes } from 'node:crypto';
import type { ConnectionDefaults } from '../core/agent-access.js';
import type { GatewayConfig } from '../config/config.js';
import type {
  KeyQuota,
  NodeCredential,
  NodePolicy,
  NodePolicyState,
  Principal,
  RunStatus,
} from '../core/contracts.js';
import {
  allowedExecution,
  executionPermits,
  terminal,
  keyQuotaSchema,
  nodePolicySchema,
  type ExecutionLevel,
} from '../core/contracts.js';
import { Store } from '../store/store.js';
import { Fault, RetryLaterFault, id, safeEqual, secret, sha } from '../core/util.js';
import { permits } from '../fabric/network.js';
import { KeyUsage, type KeyUsageView } from './key-usage.js';
import { generateApiKey, invalidKey, missingKey } from './api-key.js';

import type { StoredKey, AccountKeyView, AccountKeyPolicy } from './key-types.js';
export type { AccountKeyView, AccountKeyPolicy } from './key-types.js';
export class Auth {
  private platform?: AccountKeyPolicy;
  /** keyId -> accountId (revoked keys included: their runs still settle); accountId -> keys. */
  private accountOfKey = new Map<string, string>();
  private keysOfAccount = new Map<string, Map<string, StoredKey>>();
  private configured: { principal: Principal; token: string; hash: string }[] = [];
  private configuredByHash = new Map<string, { principal: Principal; token: string }>();
  private managedByHash = new Map<string, StoredKey>();
  private counts = new Map<string, { start: number; count: number }>();
  private readonly usage: KeyUsage;
  constructor(readonly store: Store) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS node_credentials(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL)',
    );
    this.usage = new KeyUsage(store);
    this.reloadManagedKeys();
  }
  private reloadManagedKeys(): void {
    this.managedByHash.clear();
    this.keysOfAccount.clear();
    for (const row of this.store.prepare('SELECT payload FROM api_keys ORDER BY rowid').all()) {
      const key = JSON.parse(row.payload as string) as StoredKey;
      if (key.accountId) {
        this.accountOfKey.set(key.id, key.accountId);
        this.indexAccountKey(key, key.accountId);
      }
      if (!key.revoked) this.managedByHash.set(key.hash, key);
    }
  }
  private indexAccountKey(key: StoredKey, accountId: string): void {
    let keys = this.keysOfAccount.get(accountId);
    if (!keys) {
      keys = new Map();
      this.keysOfAccount.set(accountId, keys);
    }
    // Replacing an entry keeps its place, so revoking does not reorder.
    keys.set(key.id, key);
  }
  /** Enables account keys; without it they are refused like unknown keys. */
  attachPlatform(policy: AccountKeyPolicy): void {
    this.platform = policy;
  }
  async load(config: GatewayConfig): Promise<void> {
    for (const key of config.keys) {
      const token = await secret(key);
      const principal: Principal = {
        owner: key.owner,
        name: key.name,
        agents: key.agents,
        scopes: key.scopes,
        keyId: `config:${key.name}`,
        ...(key.quota ? { quota: key.quota } : {}),
        ...(key.dataScope ? { dataScope: key.dataScope } : {}),
        ...(key.execution ? { execution: key.execution } : {}),
      };
      const hash = sha(token);
      this.configured.push({ principal, token, hash });
      this.configuredByHash.set(hash, { principal, token });
    }
  }
  authenticate(header: string | undefined): Principal {
    const { principal, hash } = this.verifyHeader(header);
    const now = Date.now();
    const count = this.counts.get(hash) ?? { start: now, count: 0 };
    if (now - count.start >= 60_000) {
      count.start = now;
      count.count = 0;
    }
    const rpmLimit = principal.quota?.rpm ?? 600;
    if (++count.count > rpmLimit)
      // 固定窗口从 count.start 起 60 秒：Retry-After 给窗口真实的剩余秒数。
      throw new RetryLaterFault(
        'rate_limited',
        'API key request rate exceeded.',
        429,
        Math.max(1, Math.ceil((count.start + 60_000 - now) / 1000)),
      );
    this.counts.set(hash, count);
    return principal;
  }
  revalidate(header: string | undefined): Principal {
    return this.verifyHeader(header).principal;
  }
  private verifyHeader(header: string | undefined): { principal: Principal; hash: string } {
    if (!header?.startsWith('Bearer ') || header.length > 1000) throw missingKey();
    const value = header.slice(7);
    const hash = sha(value);
    const cfg = this.configuredByHash.get(hash);
    if (cfg && safeEqual(cfg.token, value)) {
      if (cfg.principal.quota?.expiresAt && Date.now() >= cfg.principal.quota.expiresAt) {
        throw new Fault('key_expired', 'API key has expired.', 401);
      }
      return { principal: cfg.principal, hash };
    }
    const managed = this.managedByHash.get(hash);
    if (managed && !managed.revoked && safeEqual(managed.hash, hash)) {
      if (managed.quota?.expiresAt && Date.now() >= managed.quota.expiresAt) {
        throw new Fault('key_expired', 'API key has expired.', 401);
      }
      if (managed.accountId)
        return { principal: this.accountPrincipal(managed, managed.accountId), hash };
      return {
        principal: {
          owner: managed.owner,
          name: managed.name,
          agents: managed.agents,
          scopes: managed.scopes,
          keyId: managed.id,
          ...(managed.quota ? { quota: managed.quota } : {}),
          ...(managed.dataScope ? { dataScope: managed.dataScope } : {}),
          ...(managed.execution ? { execution: managed.execution } : {}),
          ...(managed.connection ? { connection: managed.connection } : {}),
          ...(managed.connection?.audience === 'external' ? { externalCaller: true } : {}),
        },
        hash,
      };
    }
    throw invalidKey();
  }
  private accountPrincipal(key: StoredKey, accountId: string): Principal {
    const platform = this.platform;
    if (!platform) throw invalidKey();
    platform.assertActive(accountId);
    return {
      owner: key.owner,
      name: key.name,
      agents: platform.agents(),
      scopes: ['invoke', 'read', 'files'],
      keyId: key.id,
      subject: `acct:${accountId}`,
      accountId,
      execution: platform.execution,
      hostAgents: platform.hostAgents(),
      quota: platform.quota,
    };
  }
  keyUsage(keyId: string | undefined): KeyUsageView {
    return this.usage.keyUsage(keyId);
  }
  checkQuotaForRun(p: Principal, agent?: string): void {
    if (p.quota?.expiresAt && Date.now() >= p.quota.expiresAt) {
      throw new Fault('key_expired', 'API key has expired.', 401);
    }
    if (p.accountId && agent !== undefined) this.platform?.checkRun(p.accountId, agent);
    this.usage.checkQuota(p);
  }
  beginKeyRun(keyId: string | undefined, owner: string, runId: string, agent?: string): void {
    if (!keyId) return;
    const accountId = this.accountOfKey.get(keyId);
    if (accountId && agent !== undefined) this.platform?.beginRun(accountId, runId, agent);
    this.usage.begin(keyId, owner, runId);
  }
  /** A resumed run, or a run re-queued at startup, counts against its key's concurrency again. */
  rejoinKeyRun(keyId: string | undefined, runId: string): void {
    if (!keyId) return;
    this.usage.rejoin(keyId, runId);
    if (this.accountOfKey.has(keyId)) this.platform?.reopenRun(runId);
  }
  /**
   * Before an interrupted run is resumed: the run's own key must still be allowed to run it, under
   * the same rules as a new submission (expiry, revocation, account status, the agent still
   * granted, balance, quota). `principal` is whoever resumes it; when that is another key (the
   * owner's admin key in the console), the run's key is looked up and checked instead.
   */
  checkResume(
    principal: Principal,
    run: { id: string; owner: string; agentId: string; keyId?: string },
  ): void {
    const keyId = run.keyId;
    if (!keyId) return;
    const own = principal.keyId === keyId ? principal : this.principalOfKey(keyId, run.owner);
    if (own.quota?.expiresAt && Date.now() >= own.quota.expiresAt)
      throw own === principal
        ? new Fault('key_expired', 'API key has expired.', 401)
        : new Fault('run_key_inactive', "The response's API key has expired.", 409);
    if (
      !permits(own.agents, run.agentId) ||
      !(own.scopes.includes('invoke') || own.scopes.includes('admin'))
    )
      throw new Fault('scope_denied', "The response's API key no longer grants this agent.", 403);
    if (own.accountId) this.platform?.checkRun(own.accountId, run.agentId);
    this.usage.checkQuota(own, run.id);
  }
  /** The principal a key authenticates as, for a key other than the caller's. */
  private principalOfKey(keyId: string, owner: string): Principal {
    const cfg = this.configured.find(
      (k) => k.principal.keyId === keyId && k.principal.owner === owner,
    );
    if (cfg) return cfg.principal;
    const row = this.store.db
      .prepare('SELECT payload FROM api_keys WHERE id=? AND owner=?')
      .get(keyId, owner);
    const key = row ? (JSON.parse(row.payload as string) as StoredKey) : undefined;
    if (!key || key.revoked)
      throw new Fault('run_key_inactive', "The response's API key was revoked or removed.", 409);
    if (!key.accountId)
      return {
        owner: key.owner,
        name: key.name,
        agents: key.agents,
        scopes: key.scopes,
        keyId: key.id,
        ...(key.quota ? { quota: key.quota } : {}),
      };
    if (!this.platform)
      throw new Fault('run_key_inactive', "The response's API key was revoked or removed.", 409);
    try {
      return this.accountPrincipal(key, key.accountId);
    } catch (error) {
      if (error instanceof Fault && error.code === 'unauthorized')
        throw new Fault('run_key_inactive', "The response's account no longer exists.", 409);
      throw error;
    }
  }
  finishKeyRun(
    keyId: string | undefined,
    owner: string,
    runId: string,
    addTokens = 0,
    status?: RunStatus,
  ): void {
    if (!keyId) return;
    // `interrupted` is terminal here: it settles the tokens used so far; if the run is resumed,
    // the next settlement charges only the difference (settleRun is idempotent).
    if (status && terminal(status) && this.accountOfKey.has(keyId))
      this.platform?.settleRun(runId, status, Math.max(0, Math.floor(addTokens)));
    this.usage.finish(keyId, owner, runId, addTokens);
  }
  require(p: Principal, scope: string): void {
    if (!p.scopes.includes('admin') && !p.scopes.includes(scope))
      throw new Fault('scope_denied', `The API key needs ${scope} scope.`, 403);
  }
  requireNodeAdmin(p: Principal): void {
    this.require(p, 'admin');
    if (!p.agents.includes('*'))
      throw new Fault(
        'scope_denied',
        'Node lifecycle management requires an owner-wide admin key.',
        403,
      );
  }
  list(p: Principal): Record<string, unknown>[] {
    this.require(p, 'admin');
    const keys = this.store.db
      .prepare('SELECT payload FROM api_keys WHERE owner=?')
      .all(p.owner)
      .map((r) => JSON.parse(r.payload as string) as StoredKey)
      // Account keys are listed by the developer platform; deleted (revoked) keys are not listed.
      .filter((key) => !key.accountId && !key.revoked)
      .map(({ hash, ...key }) => ({ ...key, managed: true, usage: this.keyUsage(key.id) }));
    return [
      ...this.configured
        .filter((k) => k.principal.owner === p.owner)
        .map((k) => {
          const cid = k.principal.keyId ?? `config:${k.principal.name}`;
          return {
            ...k.principal,
            id: cid,
            managed: false,
            revoked: false,
            usage: this.keyUsage(cid),
          };
        }),
      ...keys,
    ];
  }
  create(
    p: Principal,
    name: string,
    agents: string[],
    scopes: string[],
    quota?: KeyQuota,
    dataScope?: 'own' | 'owner',
    execution: ExecutionLevel = 'host',
    connection?: ConnectionDefaults,
    localConnectionId?: string,
  ): Record<string, unknown> {
    this.require(p, 'admin');
    if (
      connection?.audience === 'external' &&
      (execution === 'host' ||
        dataScope === 'owner' ||
        scopes.some((scope) => scope === 'admin' || scope === 'billing'))
    )
      throw new Fault(
        'scope_denied',
        'External keys cannot grant unrestricted host execution, owner-wide data, or administration.',
        403,
      );
    if (agents.some((a) => !permits(p.agents, a)))
      throw new Fault('scope_denied', 'Cannot grant agents outside the current key scope.', 403);
    if (Object.keys(connection?.models ?? {}).some((agent) => !permits(agents, agent)))
      throw new Fault(
        'scope_denied',
        'Connection defaults must refer only to agents granted by this key.',
        403,
      );
    if (!executionPermits(allowedExecution(p), execution))
      throw new Fault('scope_denied', 'Cannot grant an execution level above your own.', 403);
    const token = generateApiKey();
    const key: StoredKey = {
      id: id('key'),
      owner: p.owner,
      name,
      agents,
      scopes,
      hash: sha(token),
      revoked: false,
      createdAt: Date.now(),
      ...(connection ? { connection } : {}),
      ...(localConnectionId ? { localConnectionId } : {}),
      ...(quota ? { quota } : {}),
      ...(dataScope === 'owner' ? { dataScope } : {}),
      execution,
    };
    this.store.db
      .prepare('INSERT INTO api_keys VALUES(?,?,?)')
      .run(key.id, key.owner, JSON.stringify(key));
    this.managedByHash.set(key.hash, key);
    return {
      id: key.id,
      name,
      agents,
      scopes,
      token,
      data_scope: key.dataScope ?? 'own',
      execution,
      ...(quota ? { quota } : {}),
    };
  }
  /** Live keys of one developer-platform account, newest first (no secrets, deleted ones omitted). */
  accountKeys(owner: string, accountId: string): AccountKeyView[] {
    return [...(this.keysOfAccount.get(accountId)?.values() ?? [])]
      .filter((key) => key.owner === owner && !key.revoked)
      .reverse()
      .map((key) => ({
        id: key.id,
        name: key.name,
        createdAt: key.createdAt,
        revoked: key.revoked,
        usage: this.keyUsage(key.id),
      }));
  }
  /** Creates an account key; `limit` counts the account's live (undeleted) keys. */
  createAccountKey(
    owner: string,
    accountId: string,
    name: string,
    limit: number,
  ): AccountKeyView & { token: string } {
    if (this.accountKeys(owner, accountId).length >= limit)
      throw new Fault('key_limit_reached', `An account may hold at most ${limit} keys.`, 409);
    const token = generateApiKey();
    const key: StoredKey = {
      id: id('key'),
      owner,
      name,
      // Account principals take agents, scopes, execution and quota from the platform at
      // authentication time; these stored values are never used to authorize.
      agents: [],
      scopes: ['invoke', 'read', 'files'],
      hash: sha(token),
      revoked: false,
      createdAt: Date.now(),
      execution: 'workspace',
      accountId,
    };
    this.store.db
      .prepare('INSERT INTO api_keys VALUES(?,?,?)')
      .run(key.id, key.owner, JSON.stringify(key));
    this.managedByHash.set(key.hash, key);
    this.accountOfKey.set(key.id, accountId);
    this.indexAccountKey(key, accountId);
    return {
      id: key.id,
      name,
      createdAt: key.createdAt,
      revoked: false,
      usage: this.keyUsage(key.id),
      token,
    };
  }
  revokeAccountKey(owner: string, accountId: string, keyId: string): void {
    const row = this.store.db
      .prepare('SELECT payload FROM api_keys WHERE id=? AND owner=?')
      .get(keyId, owner);
    const key = row ? (JSON.parse(row.payload as string) as StoredKey) : undefined;
    if (!key || key.accountId !== accountId)
      throw new Fault('key_not_found', 'API key was not found for this account.', 404);
    if (key.revoked) return;
    key.revoked = true;
    this.store.db
      .prepare('UPDATE api_keys SET payload=? WHERE id=?')
      .run(JSON.stringify(key), keyId);
    this.managedByHash.delete(key.hash);
    this.indexAccountKey(key, accountId);
    this.store.authorizationChanged(owner);
  }
  updateQuota(
    p: Principal,
    keyId: string,
    quota: KeyQuota | undefined,
    resetUsage = false,
  ): Record<string, unknown> {
    this.require(p, 'admin');
    const row = this.store.db
      .prepare('SELECT payload FROM api_keys WHERE id=? AND owner=?')
      .get(keyId, p.owner);
    if (row) {
      const key = JSON.parse(row.payload as string) as StoredKey;
      if (quota && Object.keys(quota).length) key.quota = quota;
      else delete key.quota;
      this.store.db
        .prepare('UPDATE api_keys SET payload=? WHERE id=?')
        .run(JSON.stringify(key), keyId);
      if (!key.revoked) this.managedByHash.set(key.hash, key);
    } else {
      const cfg = this.configured.find(
        (k) =>
          k.principal.owner === p.owner &&
          (k.principal.keyId === keyId || `config:${k.principal.name}` === keyId),
      );
      if (!cfg) throw new Fault('key_not_found', 'API key was not found for this owner.', 404);
      if (quota && Object.keys(quota).length) cfg.principal.quota = quota;
      else delete cfg.principal.quota;
    }
    if (resetUsage) this.usage.reset(keyId, p.owner);
    return {
      id: keyId,
      quota: quota && Object.keys(quota).length ? quota : null,
      usage: this.keyUsage(keyId),
    };
  }
  revoke(p: Principal, keyId: string): void {
    this.require(p, 'admin');
    const row = this.store.db
      .prepare('SELECT payload FROM api_keys WHERE id=? AND owner=?')
      .get(keyId, p.owner);
    if (!row) throw new Fault('key_not_found', 'Only generated keys can be revoked here.', 404);
    const key = JSON.parse(row.payload as string) as StoredKey;
    key.revoked = true;
    this.store.db
      .prepare('UPDATE api_keys SET payload=? WHERE id=?')
      .run(JSON.stringify(key), keyId);
    this.managedByHash.delete(key.hash);
    this.store.authorizationChanged(key.owner);
  }
  enroll(
    p: Principal,
    nodeId: string,
    agents: string[],
    capabilities: string[],
  ): { credential: NodeCredential; token: string } {
    this.require(p, 'admin');
    if (agents.some((a) => !permits(p.agents, a)))
      throw new Fault('scope_denied', 'Cannot grant agents outside this key scope.', 403);
    if (
      this.store.db.prepare('SELECT id FROM node_credentials WHERE id=?').get(nodeId) ||
      this.store.db.prepare('SELECT node_id FROM node_policies WHERE node_id=?').get(nodeId)
    )
      throw new Fault('node_exists', 'This node ID has already been enrolled.', 409);
    const token = `oan_${randomBytes(32).toString('base64url')}`;
    const credential: NodeCredential = {
      nodeId,
      owner: p.owner,
      agents,
      capabilities,
      token: `sha256:${sha(token)}`,
    };
    this.store.db
      .prepare('INSERT INTO node_credentials VALUES(?,?,?)')
      .run(nodeId, p.owner, JSON.stringify(credential));
    return { credential, token };
  }
  nodeCredentials(): NodeCredential[] {
    return this.store.db
      .prepare('SELECT payload FROM node_credentials')
      .all()
      .map((r) => JSON.parse(r.payload as string));
  }
  nodePolicies(): NodePolicy[] {
    return this.store.db
      .prepare('SELECT node_id,owner,payload FROM node_policies')
      .all()
      .map((r) => {
        const policy = nodePolicySchema.parse(JSON.parse(String(r.payload)));
        if (policy.nodeId !== r.node_id || policy.owner !== r.owner)
          throw new Fault(
            'node_policy_integrity',
            'Node policy identity does not match its record.',
            500,
          );
        return policy;
      });
  }
  setNodePolicy(
    p: Principal,
    credential: NodeCredential,
    state: NodePolicyState,
    reason: string,
  ): NodePolicy {
    this.requireNodeAdmin(p);
    if (credential.owner !== p.owner)
      throw new Fault('node_not_found', 'Node registration not found.', 404);
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db
        .prepare('SELECT payload FROM node_policies WHERE node_id=?')
        .get(credential.nodeId);
      const prior = row ? nodePolicySchema.parse(JSON.parse(String(row.payload))) : undefined;
      if (prior && prior.owner !== p.owner)
        throw new Fault('node_owner_conflict', 'Node identity is reserved by another owner.', 409);
      if (prior?.state === state) {
        db.exec('COMMIT');
        return prior;
      }
      if (prior?.state === 'revoked')
        throw new Fault(
          'node_revoked',
          'Revocation is terminal. Enroll a new node identity after review.',
          409,
        );
      const next: NodePolicy = {
        nodeId: credential.nodeId,
        owner: p.owner,
        state,
        actor: p.name,
        reason,
        updatedAt: Date.now(),
      };
      const payload = JSON.stringify(next);
      db.prepare(
        'INSERT INTO node_policies VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET payload=excluded.payload',
      ).run(next.nodeId, p.owner, payload);
      db.prepare('INSERT INTO node_policy_events(node_id,owner,payload) VALUES(?,?,?)').run(
        next.nodeId,
        p.owner,
        payload,
      );
      db.exec('COMMIT');
      return next;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  nodePolicyHistory(p: Principal, nodeId: string, after: number, limit: number) {
    this.requireNodeAdmin(p);
    const rows = this.store.db
      .prepare(
        'SELECT id,payload FROM node_policy_events WHERE owner=? AND node_id=? AND id>? ORDER BY id LIMIT ?',
      )
      .all(p.owner, nodeId, after, limit + 1);
    const data = rows
      .slice(0, limit)
      .map((row) => ({ id: Number(row.id), ...(JSON.parse(String(row.payload)) as NodePolicy) }));
    return { data, next_cursor: rows.length > limit ? data.at(-1)!.id : null };
  }
}
