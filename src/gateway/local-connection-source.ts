import path from 'node:path';
import type { GatewayConfig } from '../config/config.js';
import type { DshModel } from '../config/dsh-client.js';
import { requiredExecution, type Principal } from '../core/contracts.js';
import { canonical, Fault, sha } from '../core/util.js';
import type { ToolBoundary } from '../core/agent-access.js';
import type { NodeHub } from '../fabric/network.js';
import type { Store } from '../store/store.js';
import type { VisibleAgent } from './agent-views.js';
import { modelAliases } from './compat-models.js';
import { acceptsImages } from './image-catalog.js';

export const API_TARGETS = ['dsh', 'opencode', 'codex'] as const;
export const MCP_TARGETS = ['claude-desktop', 'cursor', 'windsurf', 'claude-code'] as const;
export const LOCAL_TARGETS = [...API_TARGETS, ...MCP_TARGETS] as const;
export type ApiTargetId = (typeof API_TARGETS)[number];
export type McpTargetId = (typeof MCP_TARGETS)[number];
export type LocalTargetId = (typeof LOCAL_TARGETS)[number];
export type LocalChannel = 'api' | 'mcp';

function matchesClientEngine(
  target: LocalTargetId,
  engine: string,
  adapter: NonNullable<GatewayConfig['localWorker']>['adapters'][string] | undefined,
): boolean {
  const cmd = adapter && 'command' in adapter ? path.basename(adapter.command) : '';
  const args = adapter && 'args' in adapter ? adapter.args.map((a) => path.basename(a)) : [];
  const preset = adapter?.transport === 'acp' ? adapter.preset : undefined;
  if (target === 'dsh') {
    return engine === 'dsh' || preset === 'deepseek-harness' || /^dsh(?:\.exe|\.cmd)?$/i.test(cmd);
  }
  if (target === 'opencode') {
    return (
      engine === 'opencode' ||
      engine === 'adapter/opencode' ||
      engine === 'adapter/opencode-acp' ||
      preset === 'opencode-acp' ||
      /^opencode(?:-acp)?(?:\.exe|\.cmd)?$/i.test(cmd) ||
      args.some((a) => /^opencode(?:-acp)?(?:\.mjs|\.cjs|\.js)?$/i.test(a))
    );
  }
  if (target === 'codex') {
    return (
      engine === 'codex' ||
      engine === 'adapter/codex' ||
      engine === 'adapter/codex-acp' ||
      preset === 'codex-acp' ||
      /^codex(?:-acp)?(?:\.exe|\.cmd)?$/i.test(cmd) ||
      args.some((a) => /^codex(?:-acp)?(?:\.mjs|\.cjs|\.js)?$/i.test(a))
    );
  }
  if (target === 'claude-code' || target === 'claude-desktop') {
    return (
      engine === 'claude' ||
      engine === 'adapter/claude' ||
      engine === 'adapter/claude-acp' ||
      preset === 'claude-acp' ||
      /^claude(?:-acp|-code)?(?:\.exe|\.cmd)?$/i.test(cmd)
    );
  }
  if (target === 'cursor') {
    return (
      engine === 'adapter/cursor' ||
      preset === 'cursor' ||
      /^cursor(?:-agent)?(?:\.exe|\.cmd)?$/i.test(cmd)
    );
  }
  return (
    engine === 'adapter/windsurf' ||
    preset === 'windsurf' ||
    /^windsurf(?:\.exe|\.cmd)?$/i.test(cmd)
  );
}

const TARGET_NAMES: Record<LocalTargetId, string> = {
  dsh: 'DSH',
  opencode: 'OpenCode',
  codex: 'Codex',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  'claude-code': 'Claude Code',
};

/** Refuse declared paths back into the target client being configured; opaque native behavior is not a sandbox. */
export function assertTargetSource(
  store: Store,
  config: GatewayConfig,
  owner: string,
  agentId: string,
  base: string,
  target: LocalTargetId = 'dsh',
): void {
  const visited = new Set<string>();
  const isGateway = (endpoint: string) => {
    const url = new URL(endpoint),
      local = new URL(base);
    return (
      ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(url.hostname) &&
      url.port === local.port
    );
  };
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visited.size >= 128)
      throw new Fault(
        'local_connection_unavailable',
        'The source delegation graph is too large for automatic local configuration.',
        409,
      );
    visited.add(id);
    const a = store.agentDefinition(owner, id).agent;
    const adapter = a.engine.startsWith('adapter/')
      ? config.localWorker?.adapters[a.engine.slice(8)]
      : undefined;
    if (matchesClientEngine(target, a.engine, adapter))
      throw new Fault(
        'local_connection_unavailable',
        `${TARGET_NAMES[target]} cannot be connected back into itself, including through declared delegates or helpers.`,
        409,
      );
    if (adapter && 'url' in adapter && isGateway(adapter.url))
      throw new Fault(
        'local_connection_unavailable',
        'The source adapter already points back to this gateway.',
        409,
      );
    if (a.engine === 'kernel')
      for (const route of [{ provider: a.provider }, ...a.routes]) {
        const provider = config.localWorker?.providers[route.provider];
        if (!provider) continue;
        if (isGateway(provider.baseUrl))
          throw new Fault(
            'local_connection_unavailable',
            'The source model provider already points back to this gateway.',
            409,
          );
      }
    for (const delegate of a.delegates ?? []) visit(delegate.agent);
    for (const helper of a.orchestration?.helpers ?? []) visit(helper);
  };
  visit(agentId);
}

export function assertDshSource(
  store: Store,
  config: GatewayConfig,
  owner: string,
  agentId: string,
  base: string,
): void {
  assertTargetSource(store, config, owner, agentId, base, 'dsh');
}

export function blockedTargetsForSource(
  store: Store,
  config: GatewayConfig,
  owner: string,
  agentId: string,
  base: string,
): LocalTargetId[] {
  const blocked: LocalTargetId[] = [];
  for (const target of LOCAL_TARGETS) {
    try {
      assertTargetSource(store, config, owner, agentId, base, target);
    } catch {
      blocked.push(target);
    }
  }
  return blocked;
}

export type ConnectionSource = {
  id: string;
  version: string;
  engine: string;
  model: string;
  models: DshModel[];
  revision: string;
  execution: 'workspace' | 'host';
  toolMode: ToolBoundary;
  toolModes: ToolBoundary[];
};
export function connectionSource(
  store: Store,
  hub: NodeHub,
  config: GatewayConfig,
  principal: Principal,
  agents: VisibleAgent[],
  agentId: string,
  model: string,
  base: string,
  requestedMode?: ToolBoundary,
  target: LocalTargetId = 'dsh',
): ConnectionSource {
  const view = agents.find((a) => a.id === agentId);
  if (!view)
    throw new Fault(
      'agent_not_found',
      `Publish the source agent before connecting it to ${TARGET_NAMES[target]}.`,
      404,
    );
  assertTargetSource(store, config, principal.owner, agentId, base, target);
  if (!view.dispatchable)
    throw new Fault(
      'model_unavailable',
      'The selected source agent has no available execution machine.',
      503,
    );
  const bundle = store.agentDefinition(principal.owner, agentId);
  const access = bundle.agent.access;
  const toolModes: ToolBoundary[] = (['managed', 'client', 'hybrid'] as const).filter(
    (mode) => view.tool_boundaries.includes(mode) && (!access || access.modes.includes(mode)),
  );
  const toolMode = requestedMode ?? access?.defaultMode ?? 'managed';
  if (!toolModes.includes(toolMode) || access?.approval === 'caller')
    throw new Fault(
      'local_connection_unavailable',
      'Select a supported tool boundary with publisher or native approval, not caller-only approval.',
      409,
    );
  if (access?.trust === 'isolated' && requiredExecution(bundle.agent) === 'host')
    throw new Fault(
      'local_connection_unavailable',
      'This publication requires a separately verified sandbox connection; automatic host configuration is refused.',
      409,
    );
  const selected = model === 'auto' ? agentId : `${agentId}@${model}`;
  const selectedRoute = view.routes.find((route) => `${agentId}@${route.id}` === selected);
  if (selectedRoute && !selectedRoute.available)
    throw new Fault('model_unavailable', 'The selected model route is not available.', 503);
  const ids = modelAliases([view]).map((a) => a.id);
  if (!ids.includes(selected))
    throw new Fault('model_not_supported', 'Select a model exposed by the published agent.', 400);
  const models: DshModel[] = ids.map((id) => {
    const selector = id.slice(agentId.length + 1);
    const route = view.routes.find((r) => r.id === selector);
    const image = acceptsImages(hub, principal.owner, bundle, route ? [route] : view.routes);
    return {
      id,
      name: route ? `${agentId} / ${route.model}` : id,
      input: image ? ['text', 'image'] : ['text'],
    };
  });
  models.sort((a, b) =>
    a.id === selected ? -1 : b.id === selected ? 1 : a.id.localeCompare(b.id, 'en'),
  );
  return {
    id: agentId,
    version: bundle.digest,
    engine: bundle.agent.engine,
    model,
    models,
    revision: sha(canonical({ version: bundle.digest, models, toolMode })),
    execution:
      access?.trust === 'private' || requiredExecution(bundle.agent) === 'host'
        ? 'host'
        : 'workspace',
    toolMode,
    toolModes,
  };
}
