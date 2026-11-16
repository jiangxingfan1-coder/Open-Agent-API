import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import { visibleSubject, type Principal } from '../core/contracts.js';
import { ERROR_CATALOG, ERROR_CATALOG_REVISION, ERROR_CATEGORIES } from '../core/errors.js';
import { agentConversionProfile } from '../engines/conformance.js';
import { presetForEngine } from '../fabric/local-backends.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Store } from '../store/store.js';
import {
  activityFrame,
  computeActivity,
  type SummaryWindow,
  type TimelineCache,
} from './activity.js';
import type { VisibleAgent } from './agent-views.js';
import type { Auth } from './auth.js';
import { buildEndpointDirectory } from './endpoints.js';
import { openapi, openapiWithPlatform } from './openapi.js';
import {
  etagMatches,
  overviewEtag,
  overviewViewKey,
  type OverviewRevisions,
  type OverviewStreams,
  type RevisionCache,
} from './overview.js';

// 控制台概览与说明类只读接口：/v1/errors、/v1/overview（含 activity 与 events）、/openapi.json。
// 从 gateway/server.ts 拆出；缓存与修订号由 createGateway 创建后按引用传入，注册顺序与拆分前一致。

export type OverviewRouteDeps = {
  auth: Auth;
  config: GatewayConfig;
  store: Store;
  kernel: Kernel;
  revisions: OverviewRevisions;
  /** 平台模式开启时 /openapi.json 返回含平台接口的版本。 */
  withPlatform: boolean;
  resolvePublicBaseUrl: (req?: FastifyRequest) => string;
  cachedAgents: (p: Principal) => VisibleAgent[];
  cachedNodes: (owner: string) => Record<string, unknown>[];
  cachedMetrics: (p: Principal) => ReturnType<Store['metrics']>;
  showsNodes: (p: Principal) => boolean;
  activityCache: RevisionCache<ReturnType<typeof computeActivity>>;
  timelines: TimelineCache;
  summaryWindows: SummaryWindow;
  overviewStreams: OverviewStreams;
};

export function registerOverviewRoutes(app: FastifyInstance, deps: OverviewRouteDeps): void {
  const {
    auth,
    config,
    store,
    kernel,
    revisions,
    withPlatform,
    resolvePublicBaseUrl,
    cachedAgents,
    cachedNodes,
    cachedMetrics,
    showsNodes,
    activityCache,
    timelines,
    summaryWindows,
    overviewStreams,
  } = deps;
  // 错误目录：内容随版本固定，ETag 取目录内容的版本号。
  app.get('/v1/errors', async (req, reply) => {
    auth.require(req.principal, 'read');
    const etag = `"errors-${ERROR_CATALOG_REVISION}"`;
    reply.header('ETag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    const revision = ERROR_CATALOG_REVISION;
    return { object: 'list', revision, categories: ERROR_CATEGORIES, data: ERROR_CATALOG };
  });
  app.get('/v1/overview', async (req, reply) => {
    auth.require(req.principal, 'read');
    const p = req.principal;
    const baseUrl = resolvePublicBaseUrl(req);
    // Cached projections may advance the revision (max-age recheck), so read it afterwards.
    const agents = cachedAgents(p);
    const nodes = showsNodes(p) ? cachedNodes(p.owner) : [];
    const metrics = cachedMetrics(p);
    const revision = revisions.revision(p.owner);
    const etag = overviewEtag(revision, p, baseUrl);
    reply.header('ETag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return {
      protocol: 'oaa/1',
      revision,
      public_base_url: baseUrl,
      endpoints: buildEndpointDirectory(baseUrl),
      // `engine` stays native or `adapter/<name>`; `preset` is the optional icon id for the console.
      agents: agents.map((a) => {
        const preset = presetForEngine(a.engine, config.localWorker);
        const conversion = agentConversionProfile(a, config.localWorker);
        return preset ? { ...a, preset, conversion } : { ...a, conversion };
      }),
      nodes,
      // Recomputed per full response so active runs report a current elapsed_ms.
      runs: store.summaries(p.owner, p.agents, 12, visibleSubject(p)).map((r) => {
        const queue = kernel.queueInsight(r.id, p.owner, r.status);
        return {
          id: r.id,
          agent: r.agent,
          status: r.status,
          model: r.model,
          created_at: r.created_at,
          elapsed_ms: r.elapsed_ms,
          input: r.input.slice(0, 160),
          error: r.error,
          ...(queue ? { queue } : {}),
          ...(r.waiting_on ? { waiting_on: r.waiting_on } : {}),
        };
      }),
      metrics,
      principal: {
        name: p.name,
        owner: p.owner,
        scopes: p.scopes,
        agents: p.agents,
      },
    };
  });
  // Activity pulse: UTC-aligned buckets over the caller's visible runs, cached per revision.
  app.get('/v1/overview/activity', async (req, reply) => {
    auth.require(req.principal, 'read');
    const p = req.principal;
    const { window } = z
      .object({ window: z.enum(['24h', '7d']).default('24h') })
      .parse(req.query ?? {});
    const now = Date.now();
    const frame = activityFrame(window, now);
    const value = activityCache.get(
      p.owner,
      `${overviewViewKey(p)}\n${window}\n${frame.start}`,
      () =>
        computeActivity(store, p, window, now, timelines, {
          cache: summaryWindows,
          key: overviewViewKey(p),
        }),
    );
    // Bound to the runs revision: an unchanged pulse stays 304 across node and catalog changes.
    const revision = revisions.revisionOf(p.owner, 'runs');
    const etag = overviewEtag(revision, p, `activity:${window}:${frame.start}`).replace(
      'W/"ov.',
      'W/"act.',
    );
    reply.header('ETag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return { ...value, revision };
  });
  // Change feed for the console: `ready`, coalesced `changed`, `: ping`; closes on revocation.
  app.get('/v1/overview/events', async (req, reply) => {
    auth.require(req.principal, 'read');
    const p = req.principal;
    overviewStreams.open(req, reply, () => {
      cachedAgents(p);
      if (showsNodes(p)) cachedNodes(p.owner);
    });
  });
  app.get('/openapi.json', async (req) => {
    auth.require(req.principal, 'read');
    const baseUrl = resolvePublicBaseUrl(req);
    return {
      ...(withPlatform ? openapiWithPlatform : openapi),
      servers: [{ url: baseUrl, description: 'OAA Gateway Public Endpoint' }],
    };
  });
}
