import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Fault } from '../core/util.js';
import { modelPolicySchema, modelRouteId, MAX_AGENT_MODELS } from '../core/model-catalog.js';
import { agentAccessSchema } from '../core/agent-access.js';
import { orchestrationSchema } from '../core/orchestration.js';
import { modelAliases } from './compat-models.js';
import { refreshAgentModels } from '../fabric/model-pool.js';
import { supportsReasoning } from '../fabric/model-pool.js';
import type { GatewayConfig } from '../config/config.js';
import { agentSchema, type AgentDefinition, type Principal } from '../core/contracts.js';
import { agentConversionProfile } from '../engines/conformance.js';
import {
  adapterAgentDescription,
  backendNotEnabled,
  parseBackendEngine,
} from '../fabric/local-backends.js';
import type { NodeHub } from '../fabric/network.js';
import { publishWarning, publishedNative } from '../fabric/runnability.js';
import type { Kernel } from '../kernel/kernel.js';
import { validateBundle, makeBundle } from '../lang/bundle.js';
import { compileOaaLang, decompileToOaaLang, diagnoseOaaLang } from '../lang/lang.js';
import type { Store } from '../store/store.js';
import { catalogEntries, type VisibleAgent } from './agent-views.js';
import type { Auth } from './auth.js';
import type { Catalog } from './catalog.js';
import { claudeModelList } from './claude.js';
import {
  directoryQuery,
  definitionQuery,
  inspectionQuery,
  listAgents,
  inspectAgent,
  publicMetadata,
} from './discovery.js';
import { fromGoogleClient, geminiModelList } from './gemini.js';
import { previewSchema } from './protocol.js';
import { registerAgentModelRoutes } from './agent-model-routes.js';

// 智能体目录与发布：/v1/models、/v1/agents、/v1/catalog/agent(s)、预览、三种发布入口、
// OAA 语言编译与定义导出。从 gateway/server.ts 拆出，注册顺序与拆分前一致。

export type AgentRouteDeps = {
  auth: Auth;
  config: GatewayConfig;
  store: Store;
  kernel: Kernel;
  hub: NodeHub;
  catalog: Catalog;
  cachedAgents: (p: Principal) => VisibleAgent[];
  providerKeyOf: (req: FastifyRequest) => string | undefined;
  /** 发布或更新为自动批准的智能体时记审计。 */
  auditPolicy: (req: FastifyRequest, agent: AgentDefinition) => void;
};

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  registerAgentModelRoutes(app, deps);
  const { auth, config, store, kernel, hub, catalog, cachedAgents, providerKeyOf, auditPolicy } =
    deps;
  app.get('/v1/models', async (req) => {
    auth.require(req.principal, 'read');
    const expand = String((req.query as Record<string, unknown>)?.expand ?? '').toLowerCase();
    const agents = cachedAgents(req.principal);
    const listed = modelAliases(agents);
    if (!expand && req.headers['anthropic-version']) return claudeModelList(listed);
    if (!expand && fromGoogleClient(req)) return geminiModelList(listed);
    if (expand !== 'routes' && expand !== 'true' && expand !== '1') {
      return {
        object: 'list',
        data: listed.map((a) => ({
          id: a.id,
          object: 'model',
          created: 0,
          owned_by: 'open-agent-api',
          image_input: a.image_input,
        })),
      };
    }
    const expanded: Record<string, unknown>[] = [];
    for (const a of agents) {
      expanded.push({
        id: a.id,
        object: 'model',
        created: 0,
        owned_by: 'open-agent-api',
        kind: 'agent_auto',
        ready: a.ready,
        status: a.status,
      });
      for (const profile of ['fast', 'best', 'eco']) {
        expanded.push({
          id: `${a.id}@${profile}`,
          object: 'model',
          created: 0,
          owned_by: 'open-agent-api',
          kind: 'semantic_profile',
          profile,
        });
      }
      for (const r of a.routes) {
        expanded.push({
          id: `${a.id}@${r.id}`,
          object: 'model',
          created: 0,
          owned_by: 'open-agent-api',
          kind: 'explicit_route',
          route_id: r.id,
          provider: r.provider,
          backend_model: r.model,
          available: r.available,
          automatic_eligible: r.automatic_eligible,
        });
      }
    }
    return { object: 'list', data: expanded };
  });
  app.get('/v1/agents', async (req) => {
    auth.require(req.principal, 'read');
    const data = cachedAgents(req.principal);
    // The cursor covers the catalog state only; `conversion` derives from static configuration.
    return {
      data: data.map((a) => ({
        ...a,
        conversion: agentConversionProfile(a, config.localWorker),
      })),
      catalog_cursor: catalog.cursor(req.principal, catalogEntries(data)),
    };
  });
  app.get('/v1/catalog/agents', async (req) => {
    auth.require(req.principal, 'read');
    return listAgents(store, catalog, req.principal, directoryQuery.parse(req.query));
  });
  app.get('/v1/catalog/agent', async (req) => {
    const query = inspectionQuery.parse(req.query);
    kernel.authorize(req.principal, query.agent, 'read');
    const definition = store.agentDefinition(req.principal.owner, query.agent, query.agent_version);
    return inspectAgent(
      definition.agent,
      definition.digest,
      query,
      agentConversionProfile(definition.agent, config.localWorker),
    );
  });
  app.get('/v1/catalog/agent/content', async (req, reply) => {
    const query = definitionQuery
      .extend({ agent_version: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.query);
    kernel.authorize(req.principal, query.agent, 'read');
    const definition = store.agentDefinition(req.principal.owner, query.agent, query.agent_version);
    reply.header('Content-Disposition', 'attachment; filename="agent-metadata.json"');
    return reply.type('application/json').send(publicMetadata(definition.agent, definition.digest));
  });
  app.post('/v1/agents/preview', async (req) =>
    kernel.preview(req.principal, previewSchema.parse(req.body), providerKeyOf(req) !== undefined),
  );
  app.post('/v1/agents/policy', async (req) => {
    auth.require(req.principal, 'admin');
    const body = z
      .object({
        agent: z.string().min(1).max(120),
        version: z.string().regex(/^[a-f0-9]{64}$/),
        approval: z.enum(['ask', 'auto']),
        orchestration: z.boolean(),
        timeout_ms: z.number().int().min(100).max(604_800_000).optional(),
      })
      .strict()
      .parse(req.body);
    kernel.authorize(req.principal, body.agent, 'admin');
    const prior = store.bundle(req.principal.owner, body.agent);
    if (prior.digest !== body.version)
      throw new Fault('version_conflict', 'The publication changed. Refresh before editing.', 409);
    if (
      body.orchestration &&
      !prior.agent.orchestration?.enabled &&
      !supportsReasoning(hub, req.principal.owner, prior.agent)
    )
      throw new Fault(
        'capability_unavailable',
        'This engine cannot yet enforce tool-free planning.',
        503,
      );
    if (prior.agent.engine === 'kernel' && !prior.agent.access)
      throw new Fault(
        'invalid_request',
        'This kernel publication uses per-tool approvals; edit its definition explicitly.',
      );
    const updated = makeBundle(
      {
        ...prior.agent,
        ...(body.timeout_ms !== undefined
          ? { limits: { ...prior.agent.limits, timeoutMs: body.timeout_ms } }
          : {}),
        ...(prior.agent.access
          ? {
              access: {
                ...prior.agent.access,
                approval:
                  body.approval === 'auto'
                    ? 'auto'
                    : prior.agent.access.approval === 'auto'
                      ? 'owner'
                      : prior.agent.access.approval,
              },
            }
          : {}),
        ...(prior.agent.engine !== 'kernel' ? { approvals: body.approval } : {}),
        ...(body.orchestration !== !!prior.agent.orchestration?.enabled
          ? {
              orchestration: {
                ...prior.agent.orchestration,
                enabled: body.orchestration,
                helpers: prior.agent.orchestration?.helpers ?? [],
                ...(body.orchestration ? { scope: 'agent' as const, helpers: [] } : {}),
              },
            }
          : {}),
      },
      prior.files,
    );
    store.publish(req.principal.owner, updated);
    auditPolicy(req, updated.agent);
    return { agent: body.agent, version: updated.digest };
  });
  app.post('/v1/agents/publish', async (req) => {
    auth.require(req.principal, 'admin');
    const bundle = validateBundle(req.body);
    kernel.authorize(req.principal, bundle.agent.id, 'admin');
    if (
      req.headers['if-none-match'] === '*' &&
      store.agentIndex(req.principal.owner, [bundle.agent.id]).length
    )
      throw new Fault(
        'version_conflict',
        'This agent is already published; first-run seeding cannot replace it.',
        409,
      );
    if (
      bundle.agent.modelPolicy?.mode === 'discover' ||
      (bundle.agent.engine === 'antigravity' && bundle.agent.access)
    )
      await refreshAgentModels(hub, req.principal.owner, bundle.agent.engine);
    if (
      req.headers['if-none-match'] === '*' &&
      store.agentIndex(req.principal.owner, [bundle.agent.id]).length
    )
      throw new Fault(
        'version_conflict',
        'This agent was published during discovery; first-run seeding cannot replace it.',
        409,
      );
    store.publish(req.principal.owner, bundle);
    auditPolicy(req, bundle.agent);
    return {
      id: bundle.agent.id,
      version: bundle.digest,
      endpoint: '/v1/responses',
      validation: { manifest: 'passed', model: 'not_exercised', tools: 'not_exercised' },
      files: bundle.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
      ...publishWarning(hub, bundle.agent, req.headers['accept-language']),
    };
  });
  app.post('/v1/agents/publish-native', async (req) => {
    auth.require(req.principal, 'admin');
    const b = z
      .object({
        id: z.string(),
        engine: z.string().max(140),
        models: z.array(z.string().min(1).max(200)).min(1).max(MAX_AGENT_MODELS),
        model_policy: modelPolicySchema.optional(),
        access: agentAccessSchema.optional(),
        orchestration: orchestrationSchema.optional(),
        approvals: z.enum(['ask', 'auto']).optional(),
      })
      .strict()
      .parse(req.body);
    // Built-in native engines, or an owner adapter (`adapter/<name>`) that a node has enabled.
    const target = parseBackendEngine(b.engine);
    kernel.authorize(req.principal, b.id, 'admin');
    if (b.model_policy?.mode === 'discover' || b.engine === 'antigravity')
      await refreshAgentModels(hub, req.principal.owner, target.engine);
    if (
      target.kind === 'adapter' &&
      !hub
        .inventory(req.principal.owner)
        .some((node) => Array.isArray(node.natives) && node.natives.includes(target.engine))
    )
      throw backendNotEnabled();
    const existing = store.agentDefinitions(req.principal.owner, [b.id])[0]?.agent;
    if (b.access && b.approvals && (b.access.approval === 'auto') !== (b.approvals === 'auto'))
      throw new Fault('invalid_request', 'The access and approval policies disagree.');
    if (
      existing?.access &&
      b.access === undefined &&
      b.approvals !== undefined &&
      b.approvals !== (existing.access.approval === 'auto' ? 'auto' : 'ask')
    )
      throw new Fault(
        'invalid_request',
        'This publication has an explicit access policy. Submit the updated access policy with the approval change.',
      );
    const bundle = makeBundle(
      agentSchema.parse({
        id: b.id,
        description:
          target.kind === 'native'
            ? `Native ${b.engine} agent`
            : adapterAgentDescription(target.engine, config.localWorker),
        engine: target.engine,
        model: b.models[0],
        ...(b.model_policy ? { modelPolicy: b.model_policy } : {}),
        ...(b.access ? { access: b.access } : existing?.access ? { access: existing.access } : {}),
        ...(b.orchestration
          ? { orchestration: { ...b.orchestration, scope: b.orchestration.scope ?? 'agent' } }
          : {}),
        provider: 'native',
        instructions: '',
        tools: [],
        allowGraph: false,
        routes: b.models.map((m, i) => ({
          id: b.model_policy || b.access || b.orchestration ? modelRouteId(m) : m,
          model: m,
          provider: 'native',
          priority: Math.min(i, 100),
        })),
        ...(() => {
          if (b.approvals !== undefined) return { approvals: b.approvals };
          if (b.access) return b.access.approval === 'auto' ? { approvals: 'auto' as const } : {};
          // Default new publications to API-style execution; never loosen a stored policy.
          return existing
            ? {
                ...(existing.approvals ? { approvals: existing.approvals } : {}),
                ...(existing.access ? { access: existing.access } : {}),
              }
            : { approvals: 'auto' as const };
        })(),
      }),
    );
    store.publish(req.principal.owner, bundle);
    auditPolicy(req, bundle.agent);
    return publishedNative(hub, bundle, req.headers['accept-language']);
  });
  app.post('/v1/lang/compile', async (req) => {
    auth.require(req.principal, 'read');
    const b = z
      .object({
        source: z.string().min(1).max(512_000),
      })
      .strict()
      .parse(req.body);
    const report = diagnoseOaaLang(b.source);
    return {
      valid: report.valid,
      diagnostics: report.diagnostics,
      agent: report.agent ?? null,
      formatted: report.formatted ?? null,
      workflow_plans: report.workflowPlans ?? {},
    };
  });
  app.post('/v1/agents/publish-oaa', async (req) => {
    auth.require(req.principal, 'admin');
    const b = z
      .object({
        source: z.string().min(1).max(512_000),
        files: z
          .array(
            z
              .object({
                path: z.string(),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                content: z.string().max(12_000_000),
              })
              .strict(),
          )
          .max(500)
          .default([]),
      })
      .strict()
      .parse(req.body);
    const compiled = compileOaaLang(b.source);
    const bundle = makeBundle(compiled.agent, b.files);
    kernel.authorize(req.principal, bundle.agent.id, 'admin');
    if (
      bundle.agent.modelPolicy?.mode === 'discover' ||
      (bundle.agent.engine === 'antigravity' && bundle.agent.access)
    )
      await refreshAgentModels(hub, req.principal.owner, bundle.agent.engine);
    store.publish(req.principal.owner, bundle);
    auditPolicy(req, bundle.agent);
    return {
      id: bundle.agent.id,
      version: bundle.digest,
      endpoint: '/v1/uap',
      workflow_plans: compiled.workflowPlans,
      validation: {
        manifest: 'passed',
        compiler: 'oaa-lang/2.0',
        model: 'not_exercised',
        tools: 'not_exercised',
      },
      files: bundle.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    };
  });
  app.get('/v1/agents/definition', async (req) => {
    auth.require(req.principal, 'admin');
    const { agent } = z.object({ agent: z.string() }).parse(req.query);
    kernel.authorize(req.principal, agent, 'admin');
    const bundle = store.bundle(req.principal.owner, agent);
    return {
      ...bundle,
      oaa_source: decompileToOaaLang(
        bundle.agent,
        bundle.files.map((f) => f.path),
      ),
    };
  });
}
