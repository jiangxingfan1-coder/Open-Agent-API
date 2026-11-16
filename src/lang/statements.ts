import {
  bindingSchema,
  type ToolBinding,
  type Effect,
  type DelegateBinding,
} from '../core/contracts.js';
import { builtin, builtinNames, type BuiltinToolName } from '../core/builtins.js';
import { type Token } from './lexer.js';
import { parseValue, type ParseContext } from './parser.js';
import { suggestName, ROUTE_ATTRIBUTES } from './suggest.js';
import { objectKeySites, parseLocated, type KeySites, type SourceSites } from './locate.js';
import { parseTypeDslBlock } from './types.js';

export interface CompiledRoute {
  id: string;
  provider: string;
  model: string;
  priority: number;
  tags?: string[];
  costTier?: number;
  speedTier?: number;
  qualityTier?: number;
}

/**
 * `agent` 块解析过程中逐步累积的状态。没写提供方的 route 先记在 `pendingProvider` 里，
 * 等整个 agent 块解析完、`provider` 确定之后再填。
 */
export interface AgentState {
  provider: string | undefined;
  tools: ToolBinding[];
  delegates: DelegateBinding[];
  routes: CompiledRoute[];
  pendingProvider: CompiledRoute[];
  sites: SourceSites;
}

/** `use builtin ...`；调用时 `use` 关键字（`kw`）已被读掉。 */
export function parseUse(ctx: ParseContext, kw: Token, state: AgentState): void {
  const category = ctx.expect('IDENT', "'builtin'");
  if (category.value !== 'builtin') {
    ctx.fail(
      category,
      `Unsupported 'use' target '${category.value}'. Expected 'use builtin [...]'.`,
    );
  }
  if (ctx.match('LBRACKET')) {
    while (ctx.peek().type !== 'RBRACKET' && ctx.peek().type !== 'EOF') {
      const bTok = ctx.next();
      if ((bTok.type !== 'IDENT' && bTok.type !== 'STRING') || !builtinNames.has(bTok.value)) {
        ctx.fail(
          bTok,
          `Unknown built-in capability '${bTok.value}'.${suggestName(bTok.value, builtinNames)}`,
        );
      }
      state.tools.push(builtin(bTok.value as BuiltinToolName));
      state.sites.tools.push(bTok);
      ctx.match('COMMA');
    }
    ctx.expect('RBRACKET', ']');
  } else {
    const bName = ctx.readStringOrIdent('builtin tool name');
    if (!builtinNames.has(bName))
      ctx.fail(kw, `Unknown built-in capability '${bName}'.${suggestName(bName, builtinNames)}`);
    state.tools.push(builtin(bName as BuiltinToolName));
    state.sites.tools.push(kw);
  }
}

/** `route ...`；调用时 `route` 关键字（`kw`）已被读掉。 */
export function parseRoute(ctx: ParseContext, kw: Token, state: AgentState): void {
  const { routes } = state;
  const routeId = ctx.readStringOrIdent('route ID');
  const keys: KeySites = new Map();
  state.sites.routes.push({ tok: kw, keys });
  if (ctx.match('ARROW')) {
    let routeProvider: string | undefined;
    const firstPart = ctx.readValueText('provider or model');
    let routeModel = firstPart;
    if (ctx.match('SLASH')) {
      routeProvider = firstPart;
      routeModel = ctx.readValueText('model name');
    }
    let priority = Math.min(routes.length, 100);
    let costTier: number | undefined;
    let speedTier: number | undefined;
    let qualityTier: number | undefined;
    let tags: string[] | undefined;

    while (
      ctx.peek().type === 'IDENT' &&
      [
        'priority',
        'cost',
        'cost_tier',
        'costTier',
        'speed',
        'speed_tier',
        'speedTier',
        'quality',
        'qualityTier',
        'tags',
      ].includes(ctx.peek().value) &&
      ctx.peek(1).type === 'EQ'
    ) {
      const attrTok = ctx.next();
      const attr = attrTok.value;
      if (!keys.has(attr)) keys.set(attr, attrTok);
      ctx.expect('EQ', '=');
      const val = parseValue(ctx);
      if (attr === 'priority') priority = Number(val);
      else if (attr === 'cost' || attr === 'cost_tier' || attr === 'costTier')
        costTier = Number(val);
      else if (attr === 'speed' || attr === 'speed_tier' || attr === 'speedTier')
        speedTier = Number(val);
      else if (attr === 'quality' || attr === 'qualityTier') qualityTier = Number(val);
      else if (attr === 'tags' && Array.isArray(val)) tags = val.map(String);
    }
    if (
      ctx.peek().type === 'IDENT' &&
      ctx.peek(1).type === 'EQ' &&
      ctx.peek().line === ctx.tokens[ctx.pos - 1]!.line
    )
      ctx.fail(
        ctx.peek(),
        `Unknown route attribute '${ctx.peek().value}'.${suggestName(ctx.peek().value, ROUTE_ATTRIBUTES)} Route attributes are priority, cost, speed and tags.`,
      );

    const route: CompiledRoute = {
      id: routeId,
      provider: routeProvider ?? '',
      model: routeModel,
      priority,
      ...(tags ? { tags } : {}),
      ...(costTier !== undefined ? { costTier } : {}),
      ...(speedTier !== undefined ? { speedTier } : {}),
      ...(qualityTier !== undefined ? { qualityTier } : {}),
    };
    routes.push(route);
    if (routeProvider === undefined) state.pendingProvider.push(route);
  } else {
    const start = ctx.pos;
    const block = parseValue(ctx) as Record<string, unknown>;
    if (!block || typeof block !== 'object' || Array.isArray(block))
      ctx.fail(kw, `Route '${routeId}' must be '-> provider/model' or an object block.`);
    for (const [key, tok] of objectKeySites(ctx.tokens, start, ctx.pos)) keys.set(key, tok);
    ctx.knownProperties(
      block,
      [
        'provider',
        'model',
        'priority',
        'tags',
        'cost',
        'costTier',
        'cost_tier',
        'speed',
        'speedTier',
        'speed_tier',
        'quality',
        'qualityTier',
      ],
      kw,
    );
    const route: CompiledRoute = {
      id: routeId,
      provider: block.provider !== undefined ? String(block.provider) : '',
      model: String(block.model ?? routeId),
      priority:
        block.priority !== undefined ? Number(block.priority) : Math.min(routes.length, 100),
      ...(Array.isArray(block.tags) ? { tags: block.tags.map(String) } : {}),
      ...(block.cost !== undefined || block.costTier !== undefined || block.cost_tier !== undefined
        ? { costTier: Number(block.cost ?? block.costTier ?? block.cost_tier) }
        : {}),
      ...(block.speed !== undefined ||
      block.speedTier !== undefined ||
      block.speed_tier !== undefined
        ? { speedTier: Number(block.speed ?? block.speedTier ?? block.speed_tier) }
        : {}),
      ...(block.quality !== undefined || block.qualityTier !== undefined
        ? { qualityTier: Number(block.quality ?? block.qualityTier) }
        : {}),
    };
    routes.push(route);
    if (block.provider === undefined) state.pendingProvider.push(route);
  }
}

/** `tool ...`；调用时 `tool` 关键字（`kw`）已被读掉。 */
export function parseTool(ctx: ParseContext, kw: Token, state: AgentState): void {
  const { tools } = state;
  const toolName = ctx.readStringOrIdent('tool name');
  state.sites.tools.push(kw);
  if (ctx.match('EQ')) {
    const raw = parseValue(ctx) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      ctx.fail(kw, 'Tool binding must be an object.');
    if (raw.name !== undefined && raw.name !== toolName)
      ctx.fail(kw, 'Tool binding name must match its declaration.');
    tools.push(
      parseLocated(
        () => bindingSchema.parse({ ...raw, name: toolName }),
        (path) => ({ tok: kw, label: ['tool', toolName, ...path].map(String).join('.') }),
      ),
    );
    return;
  }
  ctx.expect('LBRACE', '{');
  const cfg: Record<string, unknown> = {};
  while (ctx.peek().type !== 'RBRACE' && ctx.peek().type !== 'EOF') {
    const prop = ctx.readStringOrIdent('tool property');
    if (prop === 'params' || prop === 'schema') {
      ctx.match('EQ');
      ctx.assign(cfg, 'inputSchema', parseTypeDslBlock(ctx), kw);
      ctx.match('COMMA');
      continue;
    }
    if (prop === 'input_schema' || prop === 'inputSchema') {
      ctx.match('EQ');
      ctx.assign(cfg, 'inputSchema', parseTypeDslBlock(ctx), kw);
      ctx.match('COMMA');
      continue;
    }
    if (!ctx.match('EQ') && !ctx.match('COLON')) {
      if (ctx.peek().type !== 'LBRACE') {
        ctx.fail(ctx.peek(), `Expected '=' or ':' after tool property '${prop}'.`);
      }
    }
    ctx.assign(cfg, prop, parseValue(ctx), kw);
    ctx.match('COMMA');
  }
  ctx.expect('RBRACE', '}');
  ctx.knownProperties(
    cfg,
    [
      'node',
      'nodeId',
      'node_id',
      'script',
      'runtime',
      'reference',
      'required',
      'capability',
      'version',
      'description',
      'effect',
      'inputSchema',
      'approval',
      'requiresApproval',
      'timeout',
      'timeout_ms',
      'timeoutMs',
      'cache_ttl',
      'cache_ttl_ms',
      'cacheTtlMs',
      'resource_key',
      'resourceKey',
      'result_export',
      'resultExport',
      'network',
    ],
    kw,
  );

  const placement = cfg.node || cfg.nodeId || cfg.node_id ? 'host-bound' : 'portable';
  const nodeId = (cfg.node ?? cfg.nodeId ?? cfg.node_id) as string | undefined;
  const handler: ToolBinding['handler'] = cfg.script
    ? {
        kind: 'script',
        path: String(cfg.script),
        runtime: (cfg.runtime as 'node' | 'python3') ?? 'node',
      }
    : {
        kind: 'node',
        reference: String(cfg.reference ?? toolName),
      };
  tools.push({
    name: toolName,
    ...(cfg.required !== undefined ? { required: cfg.required as boolean } : {}),
    handler,
    capability: {
      id: String(cfg.capability ?? `custom/${toolName}`),
      version: String(cfg.version ?? '1'),
      description: String(cfg.description ?? ''),
      placement,
      ...(nodeId ? { nodeId } : {}),
      effect: (cfg.effect as Effect) ?? 'unknown',
      inputSchema: (cfg.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      requiresApproval: (cfg.approval ?? cfg.requiresApproval ?? false) as boolean,
      timeoutMs: Number(cfg.timeout ?? cfg.timeout_ms ?? cfg.timeoutMs ?? 60_000),
      cacheTtlMs: Number(cfg.cache_ttl ?? cfg.cache_ttl_ms ?? cfg.cacheTtlMs ?? 0),
      ...(cfg.resource_key || cfg.resourceKey
        ? { resourceKey: String(cfg.resource_key ?? cfg.resourceKey) }
        : {}),
      resultExport:
        cfg.result_export !== undefined
          ? (cfg.result_export as boolean)
          : cfg.resultExport !== undefined
            ? (cfg.resultExport as boolean)
            : true,
      ...(cfg.network !== undefined ? { network: networkOf(cfg.network) } : {}),
    },
  });
}

// Sub-Agent Delegation:
// delegate "ask_researcher" -> "agent/research"@fast { description = "...", timeout = 60s, forward_files = true }
/** `delegate ...`；调用时 `delegate` 关键字（`kw`）已被读掉。 */
export function parseDelegate(ctx: ParseContext, kw: Token, state: AgentState): void {
  const delegateName = ctx.readStringOrIdent('delegate name');
  let targetAgent = '';
  let targetModel: string | undefined;
  let delDescription: string | undefined;
  let timeoutMs = 120_000;
  let forwardFiles = false;

  if (ctx.match('ARROW')) {
    targetAgent = ctx.readValueText('target agent ID');
    if (ctx.match('AT')) {
      const mTok = ctx.readValueText('route or semantic profile');
      targetModel = mTok.startsWith('@') ? mTok : `@${mTok}`;
    } else if (targetAgent.includes('@')) {
      const idx = targetAgent.indexOf('@');
      targetModel = targetAgent.slice(idx);
      targetAgent = targetAgent.slice(0, idx);
    }
  }

  const keys: KeySites = new Map();
  state.sites.delegates.push({ tok: kw, keys });
  if (ctx.peek().type === 'LBRACE') {
    const start = ctx.pos;
    const block = parseValue(ctx) as Record<string, unknown>;
    for (const [key, tok] of objectKeySites(ctx.tokens, start, ctx.pos)) keys.set(key, tok);
    ctx.knownProperties(
      block,
      [
        'agent',
        'model',
        'description',
        'timeout',
        'timeout_ms',
        'timeoutMs',
        'max_wait',
        'forward_files',
        'forwardFiles',
      ],
      kw,
    );
    if (block.agent) targetAgent = String(block.agent);
    if (block.model) targetModel = String(block.model);
    if (block.description !== undefined) delDescription = String(block.description);
    if (
      block.timeout !== undefined ||
      block.timeout_ms !== undefined ||
      block.timeoutMs !== undefined ||
      block.max_wait !== undefined
    ) {
      timeoutMs = Number(block.timeout ?? block.timeout_ms ?? block.timeoutMs ?? block.max_wait);
    }
    if (block.forward_files !== undefined || block.forwardFiles !== undefined) {
      forwardFiles = (block.forward_files ?? block.forwardFiles) as boolean;
    }
  }

  if (!targetAgent) {
    ctx.fail(kw, `Delegate '${delegateName}' must specify a target agent ID.`);
  }

  state.delegates.push({
    name: delegateName,
    agent: targetAgent,
    ...(targetModel ? { model: targetModel } : {}),
    description: delDescription ?? `Delegate sub-task to ${targetAgent}`,
    timeoutMs,
    forwardFiles,
  });
}

/** `limits ...`；调用时 `limits` 关键字（`kw`）已被读掉。 */
export function parseLimits(
  ctx: ParseContext,
  kw: Token,
  state: AgentState,
): Record<string, unknown> {
  if (!ctx.match('EQ')) ctx.match('COLON');
  const start = ctx.pos;
  const rawLimits = parseValue(ctx) as Record<string, unknown>;
  if (!rawLimits || typeof rawLimits !== 'object' || Array.isArray(rawLimits))
    ctx.fail(kw, "'limits' must be an object block.");
  state.sites.limits = { tok: kw, keys: objectKeySites(ctx.tokens, start, ctx.pos) };
  ctx.knownProperties(
    rawLimits,
    [
      'max_turns',
      'maxTurns',
      'max_output_tokens',
      'maxOutputTokens',
      'timeout_ms',
      'timeoutMs',
      'timeout',
      'wall_ms',
      'tool_concurrency',
      'toolConcurrency',
      'max_total_tokens',
      'maxTotalTokens',
    ],
    kw,
  );
  return {
    ...(rawLimits.max_turns !== undefined || rawLimits.maxTurns !== undefined
      ? { maxTurns: Number(rawLimits.max_turns ?? rawLimits.maxTurns) }
      : {}),
    ...(rawLimits.max_output_tokens !== undefined || rawLimits.maxOutputTokens !== undefined
      ? { maxOutputTokens: Number(rawLimits.max_output_tokens ?? rawLimits.maxOutputTokens) }
      : {}),
    ...(rawLimits.timeout_ms !== undefined ||
    rawLimits.timeoutMs !== undefined ||
    rawLimits.timeout !== undefined ||
    rawLimits.wall_ms !== undefined
      ? {
          timeoutMs: Number(
            rawLimits.timeout ?? rawLimits.timeout_ms ?? rawLimits.timeoutMs ?? rawLimits.wall_ms,
          ),
        }
      : {}),
    ...(rawLimits.tool_concurrency !== undefined || rawLimits.toolConcurrency !== undefined
      ? { toolConcurrency: Number(rawLimits.tool_concurrency ?? rawLimits.toolConcurrency) }
      : {}),
    ...(rawLimits.max_total_tokens !== undefined || rawLimits.maxTotalTokens !== undefined
      ? { maxTotalTokens: Number(rawLimits.max_total_tokens ?? rawLimits.maxTotalTokens) }
      : {}),
  };
}

/** `network { allowed_domains = [...] }`：snake_case 是规范写法，camelCase 照旧接受。 */
function networkOf(raw: unknown): ToolBinding['capability']['network'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return raw as ToolBinding['capability']['network'];
  const { allowed_domains, ...rest } = raw as Record<string, unknown>;
  return (
    allowed_domains !== undefined && !('allowedDomains' in rest)
      ? { allowedDomains: allowed_domains, ...rest }
      : raw
  ) as ToolBinding['capability']['network'];
}
