import { randomBytes } from 'node:crypto';
import type { Principal } from '../core/contracts.js';
import type { ToolBoundary } from '../core/agent-access.js';
import { canonical, Fault, sha } from '../core/util.js';
import { clientConflict } from '../config/local-client-files.js';
import type { Auth } from './auth.js';
import { assertQuotaWithin } from './key-guard.js';
import {
  checkLocalMcpCatalog,
  checkLocalModel,
  recoverManagedRecords,
  validManagedKey,
} from './local-connection-check.js';
import type { ConnectionSource, LocalChannel, LocalTargetId } from './local-connection-source.js';
import type {
  ExtendedTargetId,
  LocalConnectionState,
  ManagedTargetRecord,
} from './local-connection-state.js';
import {
  LocalProviderTargets,
  type ManagedTargetAdapter,
  type ProviderTargetPaths,
  type TargetSnapshot,
} from './local-provider-targets.js';
import { LocalMcpTargets, type McpTargetPaths } from './local-mcp-targets.js';

export type LocalTargetOptions = ProviderTargetPaths & { mcpConfigs?: McpTargetPaths };

type ManagedPlan = {
  id: string;
  owner: string;
  keyId: string | undefined;
  expires: number;
  target: ExtendedTargetId;
  channel: LocalChannel;
  revision: string;
  configFile: string;
  bindingId: string;
  agent: string;
  model: string;
  toolMode: ToolBoundary;
  execution: 'workspace' | 'host';
  sourceRevision: string;
  entryHash: string;
  modelCount: number;
  primaryModel?: string;
  action: 'connect' | 'sync' | 'repair';
  existingKeyId?: string;
  baseUrl: string;
  v1Base: string;
  completed?: boolean;
};

type SourceLookup = (
  p: Principal,
  agent: string,
  model: string,
  base: string,
  toolMode?: ToolBoundary,
  target?: LocalTargetId,
) => ConnectionSource;

const TARGET_LABELS: Record<ExtendedTargetId, string> = {
  opencode: 'OpenCode',
  codex: 'Codex',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  'claude-code': 'Claude Code',
};

function assertUnchanged(snap: TargetSnapshot, existing: ManagedTargetRecord | undefined): void {
  if (!existing || existing.phase === 'removed') {
    if (snap.entryExists) throw clientConflict();
    return;
  }
  if (snap.file.file !== existing.configFile) throw clientConflict();
  if (snap.entryExists && snap.entryHash !== existing.owned.entryHash) throw clientConflict();
}

export class ManagedTargetCoordinator {
  private readonly providers: LocalProviderTargets;
  private readonly mcp: LocalMcpTargets;
  private readonly plans = new Map<string, ManagedPlan>();

  constructor(
    private readonly auth: Auth,
    private readonly state: LocalConnectionState,
    private readonly owner: string,
    private readonly source: SourceLookup,
    private readonly authority: (p: Principal, revalidate?: () => Principal) => Principal,
    options: LocalTargetOptions = {},
  ) {
    this.providers = new LocalProviderTargets(state, options);
    this.mcp = new LocalMcpTargets(state, options.mcpConfigs);
  }

  private adapter(target: ExtendedTargetId): ManagedTargetAdapter {
    return target === 'opencode' || target === 'codex'
      ? this.providers.adapter(target)
      : this.mcp.adapter(target);
  }

  hasPlan(planId: string): boolean {
    return this.plans.has(planId);
  }

  private revoke(p: Principal, record: Pick<ManagedTargetRecord, 'id' | 'keyId'>): void {
    const key = this.auth
      .list(p)
      .find((k) => k.id === record.keyId && k.localConnectionId === record.id);
    if (key) this.auth.revoke(p, record.keyId);
  }

  async records(): Promise<ManagedTargetRecord[]> {
    return (await this.state.listManaged()).filter((r) => r.owner === this.owner);
  }

  async findRecord(id: string): Promise<ManagedTargetRecord | undefined> {
    return (await this.records()).find((r) => r.id === id);
  }

  private validKey(p: Principal, r: ManagedTargetRecord): Promise<boolean> {
    return validManagedKey(this.auth, this.state, p, r);
  }

  async recover(p: Principal): Promise<ManagedTargetRecord[]> {
    await recoverManagedRecords(
      this.auth,
      this.state,
      p,
      await this.records(),
      (target) => this.adapter(target),
      (principal, r) => this.revoke(principal, r),
    );
    return this.records();
  }

  targetSummaries() {
    const ids: ExtendedTargetId[] = [
      'opencode',
      'codex',
      'claude-desktop',
      'cursor',
      'windsurf',
      'claude-code',
    ];
    return Object.fromEntries(
      ids.map((id) => {
        const adp = this.adapter(id);
        return [id, { id, channel: adp.channel, available: true, files: [adp.configPath()] }];
      }),
    );
  }

  async view(p: Principal, r: ManagedTargetRecord, v1Base: string) {
    let status: string = r.phase;
    if (r.phase === 'active') {
      try {
        const snap = await this.adapter(r.target).snapshot(r.configFile);
        const expectedBase = r.channel === 'api' ? v1Base : this.mcp.gatewayOrigin(v1Base);
        if (!snap.entryExists) status = 'missing';
        else if (snap.entryHash !== r.owned.entryHash) status = 'conflict';
        else if (!(await this.validKey(p, r))) status = 'key_unavailable';
        else if (r.baseUrl !== expectedBase) status = 'outdated';
        else if (r.agent !== '*') {
          try {
            if (
              this.source(p, r.agent, r.model, v1Base, r.toolMode, r.target).revision !==
              r.sourceRevision
            )
              status = 'outdated';
          } catch {
            status = 'source_unavailable';
          }
        }
      } catch {
        status = 'unavailable';
      }
    }
    return {
      id: r.id,
      target: r.target,
      channel: r.channel,
      agent: r.agent,
      model: r.model,
      provider: r.owned.entryId,
      model_count: r.owned.modelCount,
      status,
      key_id: r.keyId,
      key_file: r.owned.keyFile,
      files: [r.configFile],
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      base_url: r.baseUrl,
      scopes: ['read', 'invoke', 'files'],
      tool_mode: r.toolMode,
      key_active: this.auth.list(p).some((k) => k.id === r.keyId),
      generation_verified: false,
      ...(r.target === 'codex' ? { env_key: 'OAA_CODEX_API_KEY' } : {}),
    };
  }

  async listViews(p: Principal, v1Base: string) {
    const active = (await this.records()).filter((r) => r.phase !== 'removed');
    return Promise.all(active.map((r) => this.view(p, r, v1Base)));
  }

  private async resolveAction(
    p: Principal,
    existing: ManagedTargetRecord | undefined,
    snap: TargetSnapshot,
    agent: string,
    toolMode: ToolBoundary,
    execution: 'workspace' | 'host',
  ): Promise<'connect' | 'sync' | 'repair'> {
    if (!existing || existing.phase === 'removed') return 'connect';
    return existing.phase === 'active' &&
      existing.agent === agent &&
      existing.toolMode === toolMode &&
      existing.execution === execution &&
      snap.entryExists &&
      snap.entryHash === existing.owned.entryHash &&
      (await this.validKey(p, existing))
      ? 'sync'
      : 'repair';
  }

  async preview(
    p: Principal,
    target: ExtendedTargetId,
    agent: string | undefined,
    model: string,
    v1Base: string,
    toolMode?: ToolBoundary,
  ) {
    const adp = this.adapter(target);
    const selectedAgent = agent ?? (adp.channel === 'mcp' ? '*' : '');
    if (!selectedAgent || (adp.channel === 'api' && selectedAgent === '*'))
      throw new Fault(
        'invalid_request',
        'Select a published source agent for API configuration.',
        400,
      );

    const src =
      selectedAgent === '*'
        ? undefined
        : this.source(p, selectedAgent, model, v1Base, toolMode, target);
    const resolvedModel = src ? src.model : 'auto';
    const resolvedMode: ToolBoundary = src ? src.toolMode : 'managed';
    const resolvedExec: 'workspace' | 'host' = src ? src.execution : 'workspace';
    const sourceRevision = src
      ? src.revision
      : sha(canonical(['mcp-wildcard', this.mcp.gatewayOrigin(v1Base)]));

    const snap = await adp.snapshot();
    const bindingId = sha(canonical([p.owner, target, snap.file.file])).slice(0, 24);
    const existing = await this.findRecord(bindingId);
    assertUnchanged(snap, existing);
    const built = adp.preview(src, v1Base, bindingId);
    const action = await this.resolveAction(
      p,
      existing,
      snap,
      selectedAgent,
      resolvedMode,
      resolvedExec,
    );

    for (const [k, v] of this.plans) if (v.expires < Date.now()) this.plans.delete(k);
    if (this.plans.size >= 128)
      throw new Fault(
        'local_connection_conflict',
        'Too many pending previews. Wait for old previews to expire.',
        409,
      );
    const id = randomBytes(24).toString('hex');
    const modelCount = src ? src.models.length : 0;
    this.plans.set(id, {
      id,
      owner: p.owner,
      keyId: p.keyId,
      expires: Date.now() + 300_000,
      target,
      channel: adp.channel,
      revision: snap.revision,
      configFile: snap.file.file,
      bindingId,
      agent: selectedAgent,
      model: resolvedModel,
      toolMode: resolvedMode,
      execution: resolvedExec,
      sourceRevision,
      entryHash: built.entryHash,
      modelCount,
      primaryModel: src?.models[0]?.id,
      action,
      existingKeyId: existing?.keyId,
      baseUrl: built.baseUrl,
      v1Base,
    });
    return {
      plan_id: id,
      action,
      target,
      channel: adp.channel,
      agent: selectedAgent,
      model: resolvedModel,
      model_count: modelCount,
      files: [snap.file.file],
      key_file: this.state.keyFilePath(bindingId),
      base_url: built.baseUrl,
      scopes: ['read', 'invoke', 'files'],
      tool_mode: resolvedMode,
      execution: resolvedExec,
      summary: built.summary,
      shared_profiles: false,
      generation_verified: false,
      ...(target === 'codex' ? { env_key: 'OAA_CODEX_API_KEY' } : {}),
    };
  }

  async apply(
    p: Principal,
    planId: string,
    v1Base: string,
    revalidate?: () => Principal,
    expectedTarget?: LocalTargetId,
    expectedChannel?: LocalChannel,
  ) {
    const plan = this.plans.get(planId);
    if (
      !plan ||
      plan.owner !== p.owner ||
      plan.keyId !== p.keyId ||
      plan.expires < Date.now() ||
      (expectedTarget && expectedTarget !== plan.target) ||
      (expectedChannel && expectedChannel !== plan.channel)
    )
      throw clientConflict();
    if (plan.completed) {
      const done = await this.findRecord(plan.bindingId);
      if (!done) throw clientConflict();
      return this.view(p, done, v1Base);
    }
    if (v1Base !== plan.v1Base) throw clientConflict();
    const src =
      plan.agent === '*'
        ? undefined
        : this.source(p, plan.agent, plan.model, v1Base, plan.toolMode, plan.target);
    const currentSourceRev = src
      ? src.revision
      : sha(canonical(['mcp-wildcard', this.mcp.gatewayOrigin(v1Base)]));
    if (currentSourceRev !== plan.sourceRevision) throw clientConflict();

    const adp = this.adapter(plan.target);
    const saved = await adp.locked(async (snap) => {
      if (snap.revision !== plan.revision || snap.file.file !== plan.configFile)
        throw clientConflict();
      const existing = await this.findRecord(plan.bindingId);
      const checkAuth = () => this.authority(p, revalidate);
      checkAuth();
      assertUnchanged(snap, existing);
      const currentAction = await this.resolveAction(
        p,
        existing,
        snap,
        plan.agent,
        plan.toolMode,
        plan.execution,
      );
      if (existing?.keyId !== plan.existingKeyId || currentAction !== plan.action)
        throw clientConflict();

      if (existing && plan.action === 'sync') {
        await this.state.backupFile(snap.file, existing.id, adp.backupName, true);
        existing.previousEntryHash = existing.owned.entryHash;
        existing.previousModelCount = existing.owned.modelCount;
        existing.previousPrimaryModel = existing.owned.primaryModel;
        existing.owned.entryHash = plan.entryHash;
        existing.owned.modelCount = plan.modelCount;
        existing.owned.primaryModel = plan.primaryModel;
        existing.pendingSource = {
          model: plan.model,
          baseUrl: plan.baseUrl,
          sourceRevision: plan.sourceRevision,
        };
        existing.phase = 'syncing';
        await this.state.saveManaged(existing);
        try {
          checkAuth();
          existing.owned.entryHash = await adp.write(
            await adp.snapshot(plan.configFile),
            src,
            v1Base,
            plan.bindingId,
          );
        } catch (err) {
          existing.owned.entryHash = existing.previousEntryHash!;
          if (existing.previousModelCount !== undefined)
            existing.owned.modelCount = existing.previousModelCount;
          existing.owned.primaryModel = existing.previousPrimaryModel;
          existing.phase = 'conflict';
          delete existing.previousEntryHash;
          delete existing.previousModelCount;
          delete existing.previousPrimaryModel;
          delete existing.pendingSource;
          await this.state.saveManaged(existing);
          throw err;
        }
        Object.assign(existing, existing.pendingSource);
        existing.phase = 'active';
        delete existing.previousEntryHash;
        delete existing.previousModelCount;
        delete existing.previousPrimaryModel;
        delete existing.pendingSource;
        existing.updatedAt = Date.now();
        await this.state.saveManaged(existing);
        return existing;
      }

      await this.state.backupFile(
        snap.file,
        plan.bindingId,
        adp.backupName,
        !!existing && existing.phase !== 'removed',
      );
      let createdConfig = snap.file.text === null;
      if (existing && existing.phase !== 'removed') {
        checkAuth();
        this.revoke(p, existing);
        await this.state.removeKeyFile(existing.id);
        createdConfig = existing.owned.createdConfig;
        if (!(await adp.remove(snap, existing))) {
          existing.phase = 'conflict';
          await this.state.saveManaged(existing);
          throw clientConflict();
        }
        if ((await adp.snapshot(plan.configFile)).entryExists) throw clientConflict();
      } else if (snap.entryExists) throw clientConflict();

      const caller = checkAuth();
      assertQuotaWithin(caller, caller.quota);
      const granted = plan.agent === '*' ? ['*'] : [plan.agent];
      const conn =
        plan.agent === '*'
          ? { audience: 'private' as const }
          : {
              toolMode: plan.toolMode,
              allowedModes: [plan.toolMode],
              audience: 'private' as const,
            };
      const key = this.auth.create(
        caller,
        `${TARGET_LABELS[plan.target]} / ${plan.agent}`,
        granted,
        ['read', 'invoke', 'files'],
        caller.quota,
        'own',
        plan.execution,
        conn,
        plan.bindingId,
      );
      const record: ManagedTargetRecord = {
        version: 1,
        id: plan.bindingId,
        target: plan.target,
        channel: plan.channel,
        owner: p.owner,
        agent: plan.agent,
        model: plan.model,
        toolMode: plan.toolMode,
        execution: plan.execution,
        configFile: plan.configFile,
        baseUrl: plan.baseUrl,
        keyId: String(key.id),
        phase: 'installing',
        sourceRevision: plan.sourceRevision,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        owned: {
          entryId: adp.entryId,
          entryHash: plan.entryHash,
          tokenHash: sha(String(key.token)),
          createdConfig,
          modelCount: plan.modelCount,
          ...(plan.primaryModel ? { primaryModel: plan.primaryModel } : {}),
          keyFile: this.state.keyFilePath(plan.bindingId),
        },
      };
      try {
        await this.state.saveManaged(record);
        await this.state.writeKeyFile(plan.bindingId, String(key.token));
        record.owned.entryHash = await adp.write(
          await adp.snapshot(plan.configFile),
          src,
          v1Base,
          plan.bindingId,
        );
        record.phase = 'active';
        record.updatedAt = Date.now();
        await this.state.saveManaged(record);
        return record;
      } catch (err) {
        this.revoke(p, record);
        await this.state.removeKeyFile(record.id);
        record.phase = 'failed';
        try {
          if (!(await adp.remove(await adp.snapshot(plan.configFile), record)))
            record.phase = 'conflict';
        } catch {
          record.phase = 'conflict';
        }
        await this.state.saveManaged(record).catch(() => {});
        if (err instanceof Fault) throw err;
        throw new Fault(
          'local_connection_failed',
          'The connection could not be saved. Its new key was revoked; existing client settings were preserved.',
          500,
        );
      }
    }, plan.configFile);
    plan.completed = true;
    return this.view(p, saved, v1Base);
  }

  async remove(p: Principal, r: ManagedTargetRecord, v1Base: string, revalidate?: () => Principal) {
    this.authority(p, revalidate);
    this.revoke(p, r);
    await this.state.removeKeyFile(r.id);
    r.phase = 'removing';
    r.updatedAt = Date.now();
    await this.state.saveManaged(r);
    let removed = false;
    try {
      const adp = this.adapter(r.target);
      removed = await adp.locked((s) => adp.remove(s, r), r.configFile);
      r.phase = removed ? 'removed' : 'conflict';
    } catch {
      r.phase = 'conflict';
    }
    r.updatedAt = Date.now();
    await this.state.saveManaged(r);
    return {
      ...(await this.view(p, r, v1Base)),
      key_revoked: true,
      configuration_removed: removed,
    };
  }

  async check(p: Principal, r: ManagedTargetRecord, v1Base: string) {
    const snap = await this.adapter(r.target).snapshot(r.configFile);
    if (
      snap.file.file !== r.configFile ||
      !snap.entryExists ||
      snap.entryHash !== r.owned.entryHash
    )
      throw clientConflict();
    if (!(await this.validKey(p, r)))
      return { ok: false, code: 'key_unavailable', generation_verified: false };
    const expectedBase = r.channel === 'api' ? v1Base : this.mcp.gatewayOrigin(v1Base);
    if (r.baseUrl !== expectedBase)
      return { ok: false, code: 'outdated', generation_verified: false };
    const token = await this.state.readKeyToken(r.id);
    if (!token) return { ok: false, code: 'key_unavailable', generation_verified: false };
    const probe = r.owned.primaryModel
      ? await checkLocalModel(v1Base, r.owned.primaryModel, token)
      : await checkLocalMcpCatalog(v1Base, token);
    return { ...probe, generation_verified: false };
  }
}
