import { randomBytes } from 'node:crypto';
import { allowedExecution, type Principal } from '../core/contracts.js';
import type { ToolBoundary } from '../core/agent-access.js';
import { canonical, Fault, sha } from '../core/util.js';
import { DshClient, type DshProvider, type DshSnapshot } from '../config/dsh-client.js';
import { clientConflict } from '../config/local-client-files.js';
import type { Auth } from './auth.js';
import { LocalConnectionState, type LocalConnectionRecord } from './local-connection-state.js';
import type { ConnectionSource } from './local-connection-source.js';
import { assertQuotaWithin } from './key-guard.js';
import { checkLocalModel } from './local-connection-check.js';

type Plan = {
  id: string;
  owner: string;
  keyId: string | undefined;
  expires: number;
  revision: string;
  root: string;
  bindingId: string;
  source: ConnectionSource;
  action: 'connect' | 'sync' | 'repair';
  existingKeyId?: string;
  baseUrl: string;
  completed?: boolean;
};
type Source = (
  p: Principal,
  agent: string,
  model: string,
  base: string,
  toolMode?: ToolBoundary,
) => ConnectionSource;
export class LocalConnections {
  readonly ready: Promise<void>;
  private readonly state: LocalConnectionState;
  private readonly plans = new Map<string, Plan>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly auth: Auth,
    dataDir: string,
    readonly dsh: DshClient,
    private readonly owner: string,
    private readonly source: Source,
  ) {
    this.state = new LocalConnectionState(dataDir);
    this.ready = this.recover();
    void this.ready.catch(() => {});
  }
  private principal(): Principal {
    return {
      owner: this.owner,
      name: 'local-connections',
      agents: ['*'],
      scopes: ['admin'],
      execution: 'host',
    };
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(fn, fn);
    this.tail = pending.catch(() => {});
    return pending;
  }
  private revoke(p: Principal, record: Pick<LocalConnectionRecord, 'id' | 'keyId'>): void {
    const key = this.auth
      .list(p)
      .find((k) => k.id === record.keyId && k.localConnectionId === record.id);
    if (key) this.auth.revoke(p, record.keyId);
  }
  private authority(p: Principal, revalidate?: () => Principal): Principal {
    const caller = revalidate?.() ?? p;
    this.auth.requireNodeAdmin(caller);
    if (caller.owner !== p.owner || caller.keyId !== p.keyId || allowedExecution(caller) !== 'host')
      throw new Fault(
        'scope_denied',
        'Local configuration requires current host administrator authority.',
        403,
      );
    return caller;
  }
  private validKey(p: Principal, r: LocalConnectionRecord, s: DshSnapshot): boolean {
    const token = s.refs[r.owned.credentialRef];
    if (typeof token !== 'string' || sha(token) !== r.owned.tokenHash) return false;
    try {
      const caller = this.auth.revalidate(`Bearer ${token}`);
      const owned = this.auth.list(p).some((k) => k.id === r.keyId && k.localConnectionId === r.id);
      return (
        owned &&
        caller.owner === p.owner &&
        caller.keyId === r.keyId &&
        caller.agents.length === 1 &&
        caller.agents[0] === r.agent &&
        caller.scopes.length === 3 &&
        ['read', 'invoke', 'files'].every((scope) => caller.scopes.includes(scope)) &&
        caller.dataScope !== 'owner' &&
        caller.connection?.toolMode === r.toolMode &&
        caller.connection.allowedModes?.length === 1 &&
        caller.connection.allowedModes[0] === r.toolMode
      );
    } catch {
      return false;
    }
  }
  private action(
    p: Principal,
    r: LocalConnectionRecord | undefined,
    s: DshSnapshot,
    source: ConnectionSource,
  ): Plan['action'] {
    if (!r || r.phase === 'removed') return 'connect';
    if (
      r.phase === 'active' &&
      r.toolMode === source.toolMode &&
      this.validKey(p, r, s) &&
      this.dsh.matches(s, r.owned) &&
      this.auth.list(p).find((k) => k.id === r.keyId)?.execution === source.execution
    )
      return 'sync';
    return 'repair';
  }
  private unchanged(r: LocalConnectionRecord | undefined, s: DshSnapshot, id: string): void {
    const providerId = `oaa-${id}`,
      ref = `OAA_DSH_${id.toUpperCase()}`;
    if (s.profileProviders.includes(providerId)) throw clientConflict();
    const provider = s.providers[providerId],
      value = s.refs[ref];
    if (!r || r.phase === 'removed') {
      if (provider !== undefined || value !== undefined) throw clientConflict();
    } else if (
      (provider !== undefined && canonical(provider) !== canonical(r.owned.provider)) ||
      (value !== undefined && (typeof value !== 'string' || sha(value) !== r.owned.tokenHash))
    )
      throw clientConflict();
  }
  private async records(): Promise<LocalConnectionRecord[]> {
    return (await this.state.list()).filter((r) => r.owner === this.owner);
  }
  private async record(id: string): Promise<LocalConnectionRecord> {
    const row = (await this.records()).find((r) => r.id === id);
    if (!row) throw new Fault('local_connection_not_found', 'Local connection not found.', 404);
    return row;
  }
  private async recover(): Promise<void> {
    const p = this.principal();
    const records = await this.records();
    for (const r of records) {
      if (!['installing', 'syncing', 'removing'].includes(r.phase)) continue;
      try {
        await this.dsh.locked(async (s) => {
          if (s.root !== r.dshHome) throw clientConflict();
          if (r.phase !== 'removing' && this.dsh.matches(s, r.owned) && this.validKey(p, r, s)) {
            if (r.pendingSource) Object.assign(r, r.pendingSource);
            r.phase = 'active';
          } else if (
            r.phase === 'syncing' &&
            r.previousProvider &&
            this.dsh.matches(s, { ...r.owned, provider: r.previousProvider })
          ) {
            r.owned.provider = r.previousProvider;
            r.phase = 'active';
          } else {
            this.revoke(p, r);
            r.phase = (await this.dsh.remove(s, r.owned)) ? 'failed' : 'conflict';
          }
          delete r.previousProvider;
          delete r.pendingSource;
          r.updatedAt = Date.now();
          await this.state.save(r);
        });
      } catch {
        this.revoke(p, r);
        r.phase = 'conflict';
        r.updatedAt = Date.now();
        await this.state.save(r);
      }
    }
    // A crash between minting and journal persistence must not leave an untracked live grant.
    for (const key of this.auth.list(p)) {
      if (typeof key.localConnectionId !== 'string' || typeof key.id !== 'string') continue;
      if (
        !records.some(
          (r) =>
            r.id === key.localConnectionId &&
            r.keyId === key.id &&
            ['active', 'syncing', 'conflict'].includes(r.phase),
        )
      )
        this.auth.revoke(p, key.id);
    }
  }
  private view(p: Principal, r: LocalConnectionRecord, s: DshSnapshot | null, base: string) {
    let status: string = r.phase;
    if (r.phase === 'active') {
      if (!s || s.root !== r.dshHome) status = 'unavailable';
      else if (!Object.hasOwn(s.providers, r.owned.providerId)) status = 'missing';
      else if (!this.dsh.matches(s, r.owned)) status = 'conflict';
      else if (!this.validKey(p, r, s)) status = 'key_unavailable';
      else {
        try {
          if (
            this.source(p, r.agent, r.model, base, r.toolMode).revision !== r.sourceRevision ||
            base !== r.baseUrl
          )
            status = 'outdated';
        } catch {
          status = 'source_unavailable';
        }
      }
    }
    return {
      id: r.id,
      target: 'dsh',
      agent: r.agent,
      model: r.model,
      provider: r.owned.providerId,
      model_count: r.owned.provider.models.length,
      status,
      key_id: r.keyId,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      base_url: r.baseUrl,
      scopes: ['read', 'invoke', 'files'],
      tool_mode: r.toolMode,
      key_active: this.auth.list(p).some((k) => k.id === r.keyId),
      generation_verified: false,
    };
  }
  async list(p: Principal, base: string) {
    await this.ready;
    return this.exclusive(async () => {
      let snapshot: DshSnapshot | null = null;
      let error: string | undefined;
      try {
        snapshot = await this.dsh.snapshot();
      } catch (e) {
        error = e instanceof Fault ? e.code : 'local_connection_unavailable';
      }
      return {
        target: {
          id: 'dsh',
          available: !!snapshot,
          error,
          files: snapshot ? [snapshot.settings.file, snapshot.credentials.file] : [],
          shared_profiles: true,
        },
        data: (await this.records())
          .filter((r) => r.phase !== 'removed')
          .map((r) => this.view(p, r, snapshot, base)),
      };
    });
  }
  async preview(
    p: Principal,
    agent: string,
    model: string,
    baseUrl: string,
    toolMode?: ToolBoundary,
  ) {
    await this.ready;
    return this.exclusive(async () => {
      const source = this.source(p, agent, model, baseUrl, toolMode),
        s = await this.dsh.snapshot();
      const bindingId = sha(canonical([p.owner, s.root, agent])).slice(0, 24);
      this.dsh.writable(s, `oaa-${bindingId}`, `OAA_DSH_${bindingId.toUpperCase()}`);
      const existing = (await this.records()).find((r) => r.id === bindingId);
      if (existing && existing.phase !== 'removed' && s.root !== existing.dshHome)
        throw clientConflict();
      this.unchanged(existing, s, bindingId);
      const action = this.action(p, existing, s, source);
      const id = randomBytes(24).toString('hex');
      for (const [key, value] of this.plans) if (value.expires < Date.now()) this.plans.delete(key);
      if (this.plans.size >= 128)
        throw new Fault(
          'local_connection_conflict',
          'Too many pending previews. Wait for old previews to expire.',
          409,
        );
      this.plans.set(id, {
        id,
        owner: p.owner,
        keyId: p.keyId,
        expires: Date.now() + 300_000,
        revision: s.revision,
        root: s.root,
        bindingId,
        source,
        action,
        existingKeyId: existing?.keyId,
        baseUrl,
      });
      return {
        plan_id: id,
        action,
        target: 'dsh',
        agent,
        model,
        model_count: source.models.length,
        files: [s.settings.file, s.credentials.file],
        base_url: baseUrl,
        scopes: ['read', 'invoke', 'files'],
        tool_mode: source.toolMode,
        execution: source.execution,
        shared_profiles: true,
        generation_verified: false,
      };
    });
  }
  async apply(p: Principal, planId: string, base: string, revalidate?: () => Principal) {
    await this.ready;
    return this.exclusive(async () => {
      const plan = this.plans.get(planId);
      if (!plan || plan.owner !== p.owner || plan.keyId !== p.keyId || plan.expires < Date.now())
        throw clientConflict();
      if (plan.completed) {
        const r = await this.record(plan.bindingId);
        return this.view(p, r, await this.dsh.snapshot(), base);
      }
      const source = this.source(p, plan.source.id, plan.source.model, base, plan.source.toolMode);
      if (source.revision !== plan.source.revision || base !== plan.baseUrl) throw clientConflict();
      const result = await this.dsh.locked(async (snapshot) => {
        if (snapshot.revision !== plan.revision || snapshot.root !== plan.root)
          throw clientConflict();
        let existing = (await this.records()).find((r) => r.id === plan.bindingId);
        const current = () => this.authority(p, revalidate);
        current();
        this.unchanged(existing, snapshot, plan.bindingId);
        if (
          existing?.keyId !== plan.existingKeyId ||
          this.action(p, existing, snapshot, source) !== plan.action
        )
          throw clientConflict();
        const providerId = `oaa-${plan.bindingId}`,
          credentialRef = `OAA_DSH_${plan.bindingId.toUpperCase()}`;
        const provider: DshProvider = {
          displayName: `Open Agent API / ${source.id}`,
          api: 'openai-completions',
          baseURL: base,
          apiKeyEnv: credentialRef,
          models: source.models,
          retryPolicy: { mode: 'normal', maxRetries: 0 },
        };
        if (existing && plan.action === 'sync') {
          if (!this.dsh.matches(snapshot, existing.owned)) throw clientConflict();
          await this.dsh.backup(snapshot, this.state.backupDirectory(existing.id), true);
          const previous = existing.owned.provider;
          existing.previousProvider = previous;
          existing.owned.provider = provider;
          existing.pendingSource = {
            sourceRevision: source.revision,
            model: source.model,
            baseUrl: base,
          };
          existing.phase = 'syncing';
          await this.state.save(existing);
          try {
            current();
            await this.dsh.sync(snapshot, { ...existing.owned, provider: previous }, provider);
          } catch (error) {
            const current = await this.dsh.snapshot().catch(() => null);
            if (current && this.dsh.matches(current, existing.owned)) {
              Object.assign(existing, existing.pendingSource);
              existing.phase = 'active';
              delete existing.previousProvider;
              delete existing.pendingSource;
              existing.updatedAt = Date.now();
              await this.state.save(existing);
              return existing;
            }
            existing.owned.provider = previous;
            existing.phase =
              current && this.dsh.matches(current, existing.owned) ? 'active' : 'conflict';
            delete existing.previousProvider;
            delete existing.pendingSource;
            await this.state.save(existing);
            throw error;
          }
          Object.assign(existing, existing.pendingSource);
          existing.phase = 'active';
          delete existing.previousProvider;
          delete existing.pendingSource;
          existing.updatedAt = Date.now();
          await this.state.save(existing);
          return existing;
        }
        await this.dsh.backup(
          snapshot,
          this.state.backupDirectory(plan.bindingId),
          !!existing && existing.phase !== 'removed',
        );
        if (existing && existing.phase !== 'removed') {
          current();
          this.revoke(p, existing);
          if (!(await this.dsh.remove(snapshot, existing.owned))) {
            existing.phase = 'conflict';
            await this.state.save(existing);
            throw clientConflict();
          }
          snapshot = await this.dsh.snapshot();
        }
        if (
          Object.hasOwn(snapshot.providers, providerId) ||
          snapshot.profileProviders.includes(providerId) ||
          Object.hasOwn(snapshot.refs, credentialRef)
        )
          throw clientConflict();
        const caller = current();
        assertQuotaWithin(caller, caller.quota);
        const key = this.auth.create(
          caller,
          `DSH / ${source.id}`,
          [source.id],
          ['read', 'invoke', 'files'],
          caller.quota,
          'own',
          source.execution,
          { toolMode: source.toolMode, allowedModes: [source.toolMode], audience: 'private' },
          plan.bindingId,
        );
        const record: LocalConnectionRecord = {
          version: 1,
          id: plan.bindingId,
          owner: p.owner,
          agent: source.id,
          model: source.model,
          toolMode: source.toolMode,
          dshHome: snapshot.root,
          baseUrl: base,
          keyId: String(key.id),
          phase: 'installing',
          sourceRevision: source.revision,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          owned: {
            providerId,
            credentialRef,
            provider,
            tokenHash: sha(String(key.token)),
            createdSettings: snapshot.settings.text === null,
            createdCredentials: snapshot.credentials.text === null,
          },
        };
        try {
          await this.state.save(record);
          await this.dsh.install(snapshot, record.owned, String(key.token));
          record.phase = 'active';
          await this.state.save(record);
          return record;
        } catch (error) {
          this.revoke(p, record);
          record.phase = 'failed';
          try {
            const current = await this.dsh.snapshot();
            if (current.root !== record.dshHome || !(await this.dsh.remove(current, record.owned)))
              record.phase = 'conflict';
          } catch {
            record.phase = 'conflict';
          }
          await this.state.save(record).catch(() => {});
          if (error instanceof Fault) throw error;
          throw new Fault(
            'local_connection_failed',
            'The connection could not be saved. Its new key was revoked; existing client providers were not replaced.',
            500,
          );
        }
      });
      plan.completed = true;
      return this.view(p, result, await this.dsh.snapshot(), base);
    });
  }
  async remove(p: Principal, id: string, base: string, revalidate?: () => Principal) {
    await this.ready;
    return this.exclusive(async () => {
      const r = await this.record(id);
      this.authority(p, revalidate);
      this.revoke(p, r);
      r.phase = 'removing';
      r.updatedAt = Date.now();
      await this.state.save(r);
      let removed = false;
      try {
        removed = await this.dsh.locked(async (s) => {
          if (s.root !== r.dshHome) throw clientConflict();
          return this.dsh.remove(s, r.owned);
        });
        r.phase = removed ? 'removed' : 'conflict';
      } catch {
        r.phase = 'conflict';
      }
      await this.state.save(r);
      return { ...this.view(p, r, null, base), key_revoked: true, configuration_removed: removed };
    });
  }
  async check(p: Principal, id: string, base: string) {
    await this.ready;
    return this.exclusive(async () => {
      const r = await this.record(id),
        s = await this.dsh.snapshot();
      if (s.root !== r.dshHome || !this.dsh.matches(s, r.owned)) throw clientConflict();
      if (!this.validKey(p, r, s))
        return { ok: false, code: 'key_unavailable', generation_verified: false };
      if (r.baseUrl !== base) return { ok: false, code: 'outdated', generation_verified: false };
      return {
        ...(await checkLocalModel(
          base,
          r.owned.provider.models[0]!.id,
          String(s.refs[r.owned.credentialRef]),
        )),
        generation_verified: false,
      };
    });
  }
}
