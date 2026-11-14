import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { readFile } from 'node:fs/promises';
import { z, ZodError } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import type { Executor } from '../fabric/worker.js';
import { WorkerRuntime } from '../fabric/worker.js';
import { Store } from '../store/store.js';
import { Auth } from './auth.js';
import { Kernel } from '../kernel/kernel.js';
import { NodeHub } from '../fabric/network.js';
import { validateBundle, makeBundle } from '../lang/bundle.js';
import { compileOaaLang, decompileToOaaLang, diagnoseOaaLang } from '../lang/lang.js';
import { agentSchema } from '../core/contracts.js';
import {
  parseInvocation,
  parseChat,
  parseCompatChat,
  parseResponse,
  parseCompatResponse,
  parseClaudeMessages,
  previewSchema,
  responseObject,
  chatObject,
  claudeMessageObject,
  type Invocation,
} from './protocol.js';
import {
  detectProtocolDialect,
  geminiResponseObject,
  parseGeminiGenerateContent,
  parseUapRequest,
  uapResponseObject,
} from './uap.js';
import type { AgentDefinition, Principal, Run } from '../core/contracts.js';
import { principalSubject, visibleSubject } from '../core/contracts.js';
import { Fault, canonical, faultOf, relativeName, secret, sha } from '../core/util.js';
import { Catalog, type CatalogEntry } from './catalog.js';
import { conversionProfile } from '../engines/conformance.js';
import { openEventStream, observeAuthorization, revalidateObservation } from './streams.js';
import {
  directoryQuery,
  definitionQuery,
  inspectionQuery,
  listAgents,
  inspectAgent,
  publicMetadata,
} from './discovery.js';
import {
  adapterAgentDescription,
  backendNotEnabled,
  parseBackendEngine,
  presetForEngine,
  restoreLocalBackends,
  type HandshakeRecord,
} from '../fabric/local-backends.js';
import { registerLocalBackendRoutes } from './local-backend-routes.js';
import { publishWarning, publishedNative } from '../fabric/runnability.js';
import { assertUploadRoom } from './upload-quota.js';
import { registerOwnerRoutes } from './shutdown-route.js';
import { ERROR_CATALOG, ERROR_CATALOG_REVISION, ERROR_CATEGORIES } from '../core/errors.js';
import { registerConsoleAssets } from './console-assets.js';
import { streamEvents, type StreamMode } from './compat-stream.js';
import { streamSlots } from './stream-slots.js';
import { geminiQueryKey, sendError, sseRequested, zodFault } from './compat-errors.js';
import * as http from './compat-http.js';
import { ignoredParamsHeader, paramFamily } from './compat-params.js';
import { bridgeDialect, bridgedObject, resumeBridged, waitParkedOrTerminal } from './bridge.js';
import { flattenClientResults } from './client-tools.js';
import { claudeModelList } from './claude.js';
import {
  fromGoogleClient,
  geminiMethod,
  geminiModelList,
  registerGeminiModelRoutes,
} from './gemini.js';
import { openapi, openapiWithPlatform } from './openapi.js';
import { SummaryWindow, TimelineCache, activityFrame, computeActivity } from './activity.js';
import { AUDITED_CODES, AuditLog } from '../store/audit.js';
import { Platform } from './platform.js';
import { GATEWAY_VERSION, buildEndpointDirectory } from './endpoints.js';
import { portalGate, registerPlatform } from './platform-routes.js';
import { registerPlatformSetup, runningPlatform } from './platform-setup.js';
import {
  OverviewRevisions,
  OverviewStreams,
  RevisionCache,
  etagMatches,
  overviewEtag,
  overviewViewKey,
} from './overview.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}
/** Optional, versioned capabilities advertised by GET /health (sorted; see docs/protocol.md). */
export const GATEWAY_FEATURES = [
  'a2a-adapters-v1',
  'acp-adapters-v1',
  'adapter-stream-v1',
  'approval-policy-v1',
  'catalog-events-v1',
  'client-tools-policy-v1',
  'conversion-profile-v1',
  'error-catalog-v1',
  'error-codes-v1',
  'harness-bridge-acp-v1',
  'harness-bridge-v1',
  'local-backends-v1',
  'oaa-lang-roundtrip-v1',
  'overview-activity-v1',
  'overview-etag-v1',
  'overview-events-v1',
  'platform-setup-v1',
  'queue-insight-v1',
  'run-timeline-v1',
  'webhooks-v1',
  'workflow-output-v1',
].sort();
export async function createGateway(
  config: GatewayConfig,
  localExecutor?: Executor,
  /** `configFile`：网关配置文件路径。提供后，控制台里「启用已安装的智能体」会把新条目写回该文件。 */
  options: { configFile?: string } = {},
) {
  const store = new Store(config.dataDir);
  let cleanupHub = async () => {};
  let cleanupCatalog = () => {};
  try {
    const auth = new Auth(store);
    await auth.load(config);
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS local_backends(owner TEXT NOT NULL,engine TEXT NOT NULL,executable TEXT NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(owner,engine))',
    );
    restoreLocalBackends(store.db, config.localWorker, localExecutor);
    const handshakes = new Map<string, HandshakeRecord>();
    const credentials = await Promise.all(
      config.nodeKeys.map(async (n) => ({ ...n, token: await secret(n) })),
    );
    credentials.push(...auth.nodeCredentials());
    const hub = new NodeHub(credentials, config.leaseMs, auth.nodePolicies());
    cleanupHub = () => hub.close();
    if (config.localWorker) {
      hub.addLocal(
        {
          nodeId: config.localWorker.nodeId,
          owner: config.localWorker.owner,
          token: 'local',
          agents: ['*'],
          capabilities: ['*'],
        },
        localExecutor ?? new WorkerRuntime(config.localWorker),
      );
    }
    const kernel = new Kernel(store, hub, {
      maxActiveRuns: config.maxActiveRuns,
      approvalTimeoutMs: config.approvalTimeoutMs,
      ...(config.maxActiveRunsPerSubject !== undefined
        ? { maxActiveRunsPerSubject: config.maxActiveRunsPerSubject }
        : {}),
    });
    kernel.setAuth(auth);
    const running = runningPlatform(config, store.db);
    const platform = running && new Platform(store, auth, running.config, config.localWorker);
    // Per-owner overview revision, advanced by committed run summaries, publications, node/route
    // state and cooldown expiry; drives ETag/304 and GET /v1/overview/events.
    const revisions = new OverviewRevisions();
    const onSummary = ({ owner }: { owner: string }) => revisions.bump(owner, 'runs');
    const onPublished = ({ owner }: { owner: string }) => revisions.bump(owner, 'catalog');
    const onNodes = (owner?: string) => revisions.bump(owner, 'nodes');
    store.events.on('summary', onSummary);
    store.events.on('catalog', onPublished);
    hub.events.on('change', onNodes);
    kernel.router.observer = (owner) => revisions.bump(owner, 'catalog');
    const cleanupRevisions = () => {
      store.events.off('summary', onSummary);
      store.events.off('catalog', onPublished);
      hub.events.off('change', onNodes);
      kernel.router.observer = undefined;
      revisions.close();
    };
    let dynamicPublicBaseUrl = config.publicBaseUrl ?? process.env.OAA_PUBLIC_BASE_URL;
    const matchHostPattern = (pattern: string, hostname: string): boolean => {
      if (pattern === '*') return true;
      const p = pattern.toLowerCase();
      const h = hostname.toLowerCase();
      if (p === h) return true;
      if (p.startsWith('*.')) {
        const suffix = p.slice(1);
        return h.endsWith(suffix) && h.length > suffix.length;
      }
      return false;
    };
    const app = Fastify({
      logger: false,
      // A Base URL typed with a trailing slash makes clients call `/v1//chat/completions`.
      rewriteUrl: (req) => http.rewriteApiUrl(req.url),
      bodyLimit: 24 * 1024 * 1024,
      requestTimeout: config.security.requestTimeoutMs ?? 0,
      forceCloseConnections: true,
      ...(config.tls
        ? {
            https: {
              key: await readFile(config.tls.keyFile),
              cert: await readFile(config.tls.certFile),
            },
          }
        : {}),
    });
    await app.register(multipart, {
      limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 3, parts: 4 },
    });
    app.decorateRequest('principal');
    const hostnameOf = (host: string | undefined): string | undefined => {
      try {
        return new URL(`http://${host ?? ''}`).hostname.toLowerCase();
      } catch {
        return undefined;
      }
    };
    /** True unless `consoleHosts` is configured and this request's Host is not one of them. */
    const onConsoleHost = (host: string | undefined): boolean => {
      if (!config.consoleHosts) return true;
      const hostname = hostnameOf(host);
      return !!hostname && config.consoleHosts.some((p) => matchHostPattern(p, hostname));
    };
    // Includes the wildcard bind addresses `serve --detach` probes when `host` is 0.0.0.0 / ::.
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]']);
    const loopbackPeers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
    /**
     * A direct local probe (CLI `serve --detach`, desktop app): loopback Host and peer, and no
     * reverse-proxy forwarding headers. Only these see the process ID in /health.
     */
    const isLocalProbe = (req: FastifyRequest): boolean =>
      loopbackHosts.has(hostnameOf(req.headers.host) ?? '') &&
      loopbackPeers.has(req.socket.remoteAddress ?? '') &&
      !req.headers['x-forwarded-for'] &&
      !req.headers['x-forwarded-host'] &&
      !req.headers.forwarded;
    const allowedHost = (host: string | undefined) => {
      try {
        const hostname = new URL(`http://${host ?? ''}`).hostname.toLowerCase();
        if (config.allowedHosts.some((p) => matchHostPattern(p, hostname))) return true;
        if (dynamicPublicBaseUrl) {
          const pubHost = new URL(dynamicPublicBaseUrl).hostname.toLowerCase();
          if (pubHost === hostname) return true;
        }
        return false;
      } catch {
        return false;
      }
    };
    const resolvePublicBaseUrl = (req?: FastifyRequest): string => {
      if (dynamicPublicBaseUrl) return dynamicPublicBaseUrl.replace(/\/+$/, '');
      if (config.trustProxy && req) {
        const fwdProto = String(req.headers['x-forwarded-proto'] ?? '')
          .split(',')[0]
          ?.trim();
        const fwdHost = String(req.headers['x-forwarded-host'] ?? '')
          .split(',')[0]
          ?.trim();
        const host = fwdHost || req.headers.host;
        if (host && allowedHost(host)) {
          const proto =
            fwdProto === 'https' || fwdProto === 'http' ? fwdProto : config.tls ? 'https' : 'http';
          return `${proto}://${host}`;
        }
      }
      const scheme = config.tls ? 'https' : 'http';
      const fallbackHost =
        req?.headers.host && allowedHost(req.headers.host)
          ? req.headers.host
          : `${config.host}:${config.port}`;
      return `${scheme}://${fallbackHost}`;
    };
    // Framework and plugin failures get stable, documented codes (docs/protocol.md) instead of
    // the generic execution_failed; client errors keep their 4xx status.
    const frameworkCodes: Record<string, string> = {
      FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_json',
      FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_json',
      FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
      FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
      FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'invalid_request',
      FST_ERR_BAD_URL: 'invalid_url',
      FST_REQ_FILE_TOO_LARGE: 'payload_too_large',
      FST_PARTS_LIMIT: 'payload_too_large',
      FST_FILES_LIMIT: 'payload_too_large',
      FST_FIELDS_LIMIT: 'payload_too_large',
      FST_PROTO_VIOLATION: 'invalid_multipart',
      FST_INVALID_MULTIPART_CONTENT_TYPE: 'invalid_multipart',
      FST_INVALID_JSON_FIELD_ERROR: 'invalid_multipart',
      FST_MP_PREMATURE_CLOSE: 'invalid_multipart',
    };
    const audit = new AuditLog(store);
    /**
     * BYOK: a caller's own model-provider key. It is read per request, passed to the kernel's
     * in-memory holder and never logged, persisted or echoed. A repeated header is rejected.
     */
    const providerKeyOf = (req: FastifyRequest): string | undefined => {
      const value = req.headers['x-oaa-provider-key'];
      if (value === undefined) return undefined;
      if (typeof value !== 'string')
        throw new Fault('invalid_provider_key', 'Send X-OAA-Provider-Key exactly once.', 400);
      return value;
    };
    /** 发布或更新为自动批准的智能体：记一条审计（谁、何时、哪个智能体）。 */
    const auditPolicy = (req: FastifyRequest, agent: AgentDefinition) => {
      if (agent.approvals !== 'auto') return;
      const p = req.principal;
      audit.note({
        owner: p.owner,
        code: 'approval_policy_auto',
        keyId: p.keyId,
        subject: principalSubject(p),
        method: req.method,
        path: req.url.split('?')[0]!,
        ip: clientIp(req),
        agentId: agent.id,
      });
    };
    /** Client address for the audit trail: the first X-Forwarded-For hop behind a trusted proxy. */
    const clientIp = (req: FastifyRequest): string | undefined => {
      const forwarded = config.trustProxy
        ? String(req.headers['x-forwarded-for'] ?? '')
            .split(',')[0]
            ?.trim()
        : '';
      return (forwarded || req.socket?.remoteAddress || undefined)?.slice(0, 64);
    };
    app.setErrorHandler((error, req, reply) => {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const frameworkCode = frameworkCodes[String((error as { code?: unknown }).code ?? '')];
      const fault =
        error instanceof ZodError
          ? zodFault(error)
          : error instanceof Fault
            ? error
            : frameworkCode
              ? new Fault(frameworkCode, (error as Error).message, statusCode ?? 400)
              : statusCode !== undefined && statusCode >= 400 && statusCode < 500
                ? new Fault('invalid_request', (error as Error).message, statusCode)
                : faultOf(error);
      const status = statusCode ?? fault.status;
      const principal = req.principal as Principal | undefined;
      if (principal && AUDITED_CODES.has(fault.code)) {
        try {
          audit.record({
            owner: principal.owner,
            code: fault.code,
            keyId: principal.keyId,
            subject: principalSubject(principal),
            method: req.method,
            path: req.url.split('?')[0]!,
            ip: clientIp(req),
          });
        } catch {
          // The audit trail must never change the response a caller receives.
        }
      }
      sendError(req, reply, status >= 400 && status <= 599 ? status : 500, fault);
    });
    app.setNotFoundHandler(http.notFound);
    app.addHook('onRequest', async (req, reply) => {
      http.tolerateEmptyJsonBody(req);
      reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .header('Cache-Control', 'no-store');
      if (!allowedHost(req.headers.host))
        throw new Fault('invalid_host', 'Host is not in the configured allowlist.', 403);
      const origin = req.headers.origin;
      if (origin) {
        let same = false;
        try {
          same = new URL(origin).host === req.headers.host;
        } catch {
          // An unparsable Origin is treated as cross-origin.
        }
        if (!same && !config.allowedOrigins.includes(origin))
          throw new Fault('origin_denied', 'Origin is not allowed.', 403);
        reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        reply
          .header(
            'Access-Control-Allow-Headers',
            http.corsAllowHeaders(req.headers['access-control-request-headers']),
          )
          .header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
          .code(204)
          .send();
        return;
      }
      const pathname = req.url.split('?')[0]!;
      if (pathname === '/health' || pathname === '/healthz') return;
      if (platform && portalGate(req, reply, pathname, onConsoleHost(req.headers.host))) return;
      if (
        [
          '/',
          '/boot.js',
          '/console.js',
          '/run-inspector.js',
          '/console.css',
          '/icons.js',
          '/brand.svg',
        ].includes(pathname) ||
        /^\/agents\/[a-z0-9-]{1,48}\.svg$/.test(pathname) ||
        /^\/(?:lib|views|dialogs)\/[a-z0-9-]{1,48}\.js$/.test(pathname) ||
        /^\/(?:styles|shared)\/[a-z0-9-]{1,48}\.(?:css|js)$/.test(pathname) ||
        /^\/fonts\/[a-z0-9-]{1,64}\.woff2$/.test(pathname)
      ) {
        // The console is part of the management plane: absent from non-console hosts.
        if (!onConsoleHost(req.headers.host))
          throw new Fault(
            'route_not_found',
            `No route matches ${req.method} ${pathname.slice(0, 200)}.`,
            404,
          );
        return;
      }
      const altApiKey =
        req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? geminiQueryKey(req);
      if (!req.headers.authorization && typeof altApiKey === 'string' && altApiKey.length > 0) {
        req.headers.authorization = `Bearer ${altApiKey}`;
      }
      req.principal = auth.authenticate(req.headers.authorization);
      if (req.principal.scopes.includes('admin') && !onConsoleHost(req.headers.host))
        throw new Fault(
          'admin_host_denied',
          'Admin keys can only be used on a configured console host.',
          403,
        );
    });
    app.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/v1/nodes/connect' || !allowedHost(req.headers.host) || req.headers.origin) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      hub.upgrade(req, socket, head);
    });
    // `features` lets clients negotiate optional APIs without probing for 404s (no secrets/load).
    // The process ID is only for local supervisors; remote and proxied callers never see it.
    const healthPayload = async (req: FastifyRequest) => ({
      status: 'ok',
      protocol: 'oaa/1',
      version: GATEWAY_VERSION,
      ...(isLocalProbe(req) ? { pid: process.pid } : {}),
      features: platform ? [...GATEWAY_FEATURES, 'platform-v1'].sort() : GATEWAY_FEATURES,
    });
    app.get('/health', healthPayload);
    app.get('/healthz', healthPayload);
    registerConsoleAssets(app);
    if (platform)
      registerPlatform(app, { platform, audit, clientIp, publicBaseUrl: resolvePublicBaseUrl });
    registerPlatformSetup(app, { config, db: store.db, running, audit, clientIp });
    const visibleAgents = (p: Principal) =>
      store.agentDefinitions(p.owner, p.agents).map((b) => {
        const plans = new Map<string, ReturnType<NodeHub['availability']>>();
        const inspect = (provider: string, model: string) => {
          const key = JSON.stringify([provider, model]);
          let plan = plans.get(key);
          if (!plan) {
            plan = hub.availability(
              p.owner,
              { ...b.agent, provider, model },
              [],
              undefined,
              b.digest,
            );
            plans.set(key, plan);
          }
          return plan;
        };
        const routes = kernel.router
          .candidates(
            p.owner,
            b.digest,
            b.agent,
            (provider, model) => inspect(provider, model).available,
          )
          .map((r) => ({ ...r, placement: inspect(r.provider, r.model) }));
        const chosen = routes.find((r) => r.automatic_eligible);
        return {
          id: b.agent.id,
          description: b.agent.description,
          engine: b.agent.engine,
          version: b.digest,
          skills: b.agent.skills,
          tools: b.agent.tools.map((t) => ({ name: t.name, ...t.capability })),
          ...(b.agent.workflows?.length ? { workflows: b.agent.workflows } : {}),
          ...(b.agent.delegates?.length ? { delegates: b.agent.delegates } : {}),
          ...(b.agent.approvals === 'auto' ? { approvals: 'auto' as const } : {}),
          routes,
          ready: chosen?.placement.ready ?? false,
          dispatchable: !!chosen,
          status:
            chosen?.placement.status ??
            (routes.some(
              (r) =>
                (r.health?.cooldownUntil ?? 0) > Date.now() ||
                r.placement.status === 'cooling_down',
            )
              ? 'cooling_down'
              : 'unavailable'),
        };
      });
    const catalogEntries = (agents: ReturnType<typeof visibleAgents>): CatalogEntry[] =>
      agents.map((a) => ({
        agent: a.id,
        version: a.version,
        state: {
          ...a,
          routes: a.routes.map((route) => ({
            ...route,
            placement: {
              ...route.placement,
              candidates: route.placement.candidates.map(({ wait_ms, ...candidate }) => ({
                ...candidate,
                cooling_down: wait_ms > 0,
              })),
            },
          })),
        },
      }));
    // Overview projections are memoized per revision; untracked inputs are re-checked after 5 s.
    const nextExpiry = (times: number[]) => {
      const now = Date.now();
      return times.reduce((soonest, at) => (at > now && at < soonest ? at : soonest), Infinity);
    };
    const agentsCache = new RevisionCache<ReturnType<typeof visibleAgents>>(revisions, {
      maxAgeMs: 5_000,
      reason: 'nodes',
      stable: (agents) => sha(canonical(catalogEntries(agents))),
      observe: (owner, agents) => {
        const now = Date.now();
        revisions.expireAt(
          owner,
          nextExpiry(
            agents.flatMap((a) =>
              a.routes.flatMap((r) => [
                r.health?.cooldownUntil ?? 0,
                ...r.placement.candidates.filter((c) => c.wait_ms > 0).map((c) => now + c.wait_ms),
              ]),
            ),
          ),
          'catalog',
        );
      },
    });
    const cachedAgents = (p: Principal) =>
      agentsCache.get(p.owner, overviewViewKey(p), () => visibleAgents(p));
    const nodesCache = new RevisionCache<Record<string, unknown>[]>(revisions, {
      maxAgeMs: 5_000,
      reason: 'nodes',
      stable: (nodes) => sha(canonical(nodes)),
      observe: (owner, nodes) =>
        revisions.expireAt(
          owner,
          nextExpiry(
            nodes.flatMap((n) =>
              (Array.isArray(n.targets) ? n.targets : []).map((t) =>
                Number((t as { cooldownUntil?: unknown }).cooldownUntil ?? 0),
              ),
            ),
          ),
          'nodes',
        ),
    });
    const cachedNodes = (owner: string) => nodesCache.get(owner, owner, () => hub.inventory(owner));
    // Metrics and activity read run summaries only: node load and catalog churn leave them cached.
    const metricsCache = new RevisionCache<ReturnType<Store['metrics']>>(revisions, {
      track: 'runs',
    });
    const cachedMetrics = (p: Principal) =>
      metricsCache.get(p.owner, overviewViewKey(p), () =>
        store.metrics(p.owner, p.agents, visibleSubject(p)),
      );
    const showsNodes = (p: Principal) => p.scopes.includes('admin') && p.agents.includes('*');
    const timelines = new TimelineCache();
    const summaryWindows = new SummaryWindow();
    const activityCache = new RevisionCache<ReturnType<typeof computeActivity>>(revisions, {
      limit: 32,
      track: 'runs',
    });
    const overviewStreams = new OverviewStreams(auth, revisions);
    const catalog = new Catalog((p) => catalogEntries(cachedAgents(p)));
    store.events.on('catalog', catalog.invalidate);
    hub.events.on('change', catalog.invalidate);
    cleanupCatalog = () => {
      store.events.off('catalog', catalog.invalidate);
      hub.events.off('change', catalog.invalidate);
      catalog.close();
      cleanupRevisions();
    };
    app.get('/v1/models', async (req) => {
      auth.require(req.principal, 'read');
      const expand = String((req.query as Record<string, unknown>)?.expand ?? '').toLowerCase();
      const agents = cachedAgents(req.principal);
      if (!expand && req.headers['anthropic-version']) return claudeModelList(agents);
      if (!expand && fromGoogleClient(req)) return geminiModelList(agents);
      if (expand !== 'routes' && expand !== 'true' && expand !== '1') {
        return {
          object: 'list',
          data: agents.map((a) => ({
            id: a.id,
            object: 'model',
            created: 0,
            owned_by: 'open-agent-api',
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
          conversion: conversionProfile(a.engine, config.localWorker),
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
      const definition = store.agentDefinition(
        req.principal.owner,
        query.agent,
        query.agent_version,
      );
      return inspectAgent(
        definition.agent,
        definition.digest,
        query,
        conversionProfile(definition.agent.engine, config.localWorker),
      );
    });
    app.get('/v1/catalog/agent/content', async (req, reply) => {
      const query = definitionQuery
        .extend({ agent_version: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(req.query);
      kernel.authorize(req.principal, query.agent, 'read');
      const definition = store.agentDefinition(
        req.principal.owner,
        query.agent,
        query.agent_version,
      );
      reply.header('Content-Disposition', 'attachment; filename="agent-metadata.json"');
      return reply
        .type('application/json')
        .send(publicMetadata(definition.agent, definition.digest));
    });
    app.post('/v1/agents/preview', async (req) =>
      kernel.preview(
        req.principal,
        previewSchema.parse(req.body),
        providerKeyOf(req) !== undefined,
      ),
    );
    app.post('/v1/agents/publish', async (req) => {
      auth.require(req.principal, 'admin');
      const bundle = validateBundle(req.body);
      kernel.authorize(req.principal, bundle.agent.id, 'admin');
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
          models: z.array(z.string().min(1).max(200)).min(1).max(32),
          approvals: z.enum(['ask', 'auto']).optional(),
        })
        .strict()
        .parse(req.body);
      // Built-in native engines, or an owner adapter (`adapter/<name>`) that a node has enabled.
      const target = parseBackendEngine(b.engine);
      kernel.authorize(req.principal, b.id, 'admin');
      if (
        target.kind === 'adapter' &&
        !hub
          .inventory(req.principal.owner)
          .some((node) => Array.isArray(node.natives) && node.natives.includes(target.engine))
      )
        throw backendNotEnabled();
      const bundle = makeBundle(
        agentSchema.parse({
          id: b.id,
          description:
            target.kind === 'native'
              ? `Native ${b.engine} agent`
              : adapterAgentDescription(target.engine, config.localWorker),
          engine: target.engine,
          model: b.models[0],
          provider: 'native',
          instructions: '',
          tools: [],
          allowGraph: false,
          routes: b.models.map((m, i) => ({ id: m, model: m, provider: 'native', priority: i })),
          ...(b.approvals === 'auto' ? { approvals: 'auto' } : {}),
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
    app.get('/v1/nodes', async (req) => {
      auth.requireNodeAdmin(req.principal);
      return { data: hub.inventory(req.principal.owner) };
    });
    const nodeRegistrations = (principal: Principal) => {
      auth.requireNodeAdmin(principal);
      const online = new Map(
        hub.inventory(principal.owner).map((node) => [String(node.nodeId), node]),
      );
      const policies = new Map(
        auth
          .nodePolicies()
          .filter((policy) => policy.owner === principal.owner)
          .map((policy) => [policy.nodeId, policy]),
      );
      const configured = new Set(config.nodeKeys.map((key) => key.nodeId));
      const owned = hub.credentials.filter((credential) => credential.owner === principal.owner);
      const ids = new Set([
        ...owned.map((credential) => credential.nodeId),
        ...online.keys(),
        ...policies.keys(),
      ]);
      return [...ids].sort().map((nodeId) => {
        const credential = owned.find((c) => c.nodeId === nodeId),
          node = online.get(nodeId),
          policy = policies.get(nodeId);
        const local = hub.isLocal(nodeId) || config.localWorker?.nodeId === nodeId;
        return {
          nodeId,
          source: local
            ? 'local'
            : credential
              ? configured.has(nodeId)
                ? 'configured'
                : 'enrolled'
              : 'retired',
          manageable: !local && !!credential,
          state: policy?.state ?? 'active',
          connected: !!node,
          active: node?.active ?? null,
          drained: !!node && policy?.state === 'draining' && node.active === 0,
          agent_grants: credential?.agents ?? node?.agent_grants ?? [],
          capability_grants: credential?.capabilities ?? node?.capability_grants ?? [],
          updated_at: policy?.updatedAt ?? null,
          actor: policy?.actor ?? null,
          reason: policy?.reason ?? '',
        };
      });
    };
    app.get('/v1/nodes/registrations', async (req) => ({ data: nodeRegistrations(req.principal) }));
    app.get('/v1/nodes/:id/history', async (req) => {
      auth.requireNodeAdmin(req.principal);
      const nodeId = z
        .string()
        .min(1)
        .max(120)
        .parse((req.params as { id: string }).id);
      if (!nodeRegistrations(req.principal).some((node) => node.nodeId === nodeId))
        throw new Fault('node_not_found', 'Node registration not found.', 404);
      const query = z
        .object({
          after: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .strict()
        .parse(req.query);
      return auth.nodePolicyHistory(req.principal, nodeId, query.after, query.limit);
    });
    for (const [action, state] of [
      ['drain', 'draining'],
      ['resume', 'active'],
      ['revoke', 'revoked'],
    ] as const)
      app.post(`/v1/nodes/:id/${action}`, async (req) => {
        auth.requireNodeAdmin(req.principal);
        const nodeId = z
          .string()
          .min(1)
          .max(120)
          .parse((req.params as { id: string }).id);
        const { reason } = z
          .object({ reason: z.string().max(1000).default('') })
          .strict()
          .parse(req.body);
        if (hub.isLocal(nodeId) || config.localWorker?.nodeId === nodeId)
          throw new Fault(
            'local_node_policy',
            'Remote credential controls cannot change the local worker.',
            409,
          );
        const credential = hub.credentials.find(
          (c) => c.nodeId === nodeId && c.owner === req.principal.owner,
        );
        if (!credential) throw new Fault('node_not_found', 'Node registration not found.', 404);
        const policy = auth.setNodePolicy(req.principal, credential, state, reason);
        const result = hub.applyPolicy(policy);
        return {
          ...nodeRegistrations(req.principal).find((node) => node.nodeId === nodeId),
          ...result,
          external_effects_stopped: 'not_verified',
        };
      });
    registerLocalBackendRoutes(app, {
      auth,
      config,
      store,
      hub,
      catalog,
      handshakes,
      localExecutor,
      configFile: options.configFile,
    });
    app.post('/v1/nodes/enroll', async (req) => {
      const body = z
        .object({
          node_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          agents: z.array(z.string()).min(1),
          capabilities: z.array(z.string()).min(1),
        })
        .strict()
        .parse(req.body);
      if (hub.credentials.some((c) => c.nodeId === body.node_id) || hub.nodes.has(body.node_id))
        throw new Fault('node_exists', 'Node ID is already configured.', 409);
      const result = auth.enroll(req.principal, body.node_id, body.agents, body.capabilities);
      hub.credentials.push(result.credential);
      return { node_id: body.node_id, token: result.token };
    });
    registerOwnerRoutes(app, { auth, audit, config, store, kernel, providerKeyOf });
    app.get('/v1/me', async (req) => {
      const usage = req.principal.keyId
        ? auth.keyUsage(req.principal.keyId)
        : { usedTokens: 0, usedRuns: 0, activeRuns: 0 };
      const quota = req.principal.quota ?? null;
      const baseUrl = resolvePublicBaseUrl(req);
      const account = platform?.meAccount(req.principal);
      return {
        principal: {
          id: req.principal.keyId ?? null,
          name: req.principal.name,
          owner: req.principal.owner,
          scopes: req.principal.scopes,
          agents: req.principal.agents,
        },
        quota,
        usage: {
          used_tokens: usage.usedTokens,
          remaining_tokens:
            quota?.maxTotalTokens !== undefined
              ? Math.max(0, quota.maxTotalTokens - usage.usedTokens)
              : null,
          used_runs: usage.usedRuns,
          remaining_runs:
            quota?.maxRuns !== undefined ? Math.max(0, quota.maxRuns - usage.usedRuns) : null,
          active_runs: usage.activeRuns,
        },
        public_base_url: baseUrl,
        endpoints: buildEndpointDirectory(baseUrl),
        ...(account ? { account } : {}),
      };
    });
    app.post('/v1/gateway/public-url', async (req) => {
      auth.require(req.principal, 'admin');
      const b = z
        .object({
          public_base_url: z.string().url().max(256).nullable(),
        })
        .strict()
        .parse(req.body);
      dynamicPublicBaseUrl = b.public_base_url ? b.public_base_url.replace(/\/+$/, '') : undefined;
      revisions.bump(undefined, 'catalog');
      const baseUrl = resolvePublicBaseUrl(req);
      return {
        public_base_url: dynamicPublicBaseUrl ?? null,
        effective_base_url: baseUrl,
        endpoints: buildEndpointDirectory(baseUrl),
      };
    });
    app.get('/v1/catalog/changes', async (req, reply) => {
      auth.require(req.principal, 'read');
      const q = z
        .object({
          cursor: z.string().min(1).max(100).optional(),
          limit: z.coerce.number().int().min(1).max(32).default(32),
          timeout_ms: z.coerce.number().int().min(0).max(25000).default(20000),
        })
        .strict()
        .parse(req.query);
      const controller = new AbortController();
      const disconnect = () =>
        controller.abort(new Fault('wait_cancelled', 'Catalog reader disconnected.', 499));
      const off = observeAuthorization(auth, req, (error) => controller.abort(error));
      reply.raw.once('close', disconnect);
      try {
        const page = await catalog.wait(
          req.principal,
          q.cursor,
          q.limit,
          q.timeout_ms,
          controller.signal,
        );
        revalidateObservation(auth, req);
        return page;
      } finally {
        off();
        reply.raw.off('close', disconnect);
      }
    });
    app.get('/v1/catalog/events', async (req, reply) => {
      auth.require(req.principal, 'read');
      const q = z
        .object({ cursor: z.string().min(1).max(100).optional() })
        .strict()
        .parse(req.query);
      const header = req.headers['last-event-id'];
      if (header !== undefined && (typeof header !== 'string' || header.length > 100))
        throw new Fault('invalid_catalog_cursor', 'Invalid Last-Event-ID.');
      if (header && q.cursor && header !== q.cursor)
        throw new Fault('invalid_catalog_cursor', 'Conflicting catalog cursors.');
      let after = q.cursor ?? header;
      catalog.page(req.principal, after);
      let stream: ReturnType<typeof openEventStream> | undefined;
      let draining = false;
      const drain = () => {
        if (!stream || stream.closed || draining) return;
        draining = true;
        try {
          while (!stream.closed) {
            const page = subscription.read(after);
            if (page.reset)
              stream.write(
                `id: ${page.cursor}\nevent: catalog.reset\ndata: ${JSON.stringify({ cursor: page.cursor, refresh: '/v1/agents' })}\n\n`,
              );
            else
              for (const change of page.data)
                if (
                  !stream.write(
                    `id: ${change.cursor}\nevent: catalog.changed\ndata: ${JSON.stringify(change)}\n\n`,
                  )
                )
                  break;
            after = page.cursor;
            if (!page.has_more) break;
          }
        } catch {
          stream.close();
        } finally {
          draining = false;
        }
      };
      const subscription = catalog.subscribe(req.principal, drain);
      try {
        stream = openEventStream(req, reply, auth, {}, 65536);
        stream.onClose(subscription.close);
        drain();
      } catch (error) {
        subscription.close();
        throw error;
      }
    });
    app.post('/v1/files', async (req) => {
      auth.require(req.principal, 'files');
      if (req.isMultipart()) {
        let uploaded: { name: string; bytes: Buffer } | undefined;
        const parts = req.parts();
        // Malformed multipart framing is a client error with a stable code, not a 500.
        const readable = async function* () {
          try {
            yield* parts;
          } catch (error) {
            if (error instanceof Fault || (error as { statusCode?: number }).statusCode)
              throw error;
            throw new Fault('invalid_multipart', 'The multipart request body is malformed.', 400);
          }
        };
        for await (const part of readable()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file')
              throw new Fault('invalid_file', 'Multipart upload field must be file.');
            relativeName(part.filename);
            uploaded = { name: part.filename, bytes: await part.toBuffer() };
          } else if (
            part.fieldname !== 'purpose' ||
            !['user_data', 'assistants'].includes(String(part.value))
          )
            throw new Fault(
              'invalid_file_field',
              'Only purpose=user_data or assistants is supported.',
            );
        }
        if (!uploaded) throw new Fault('file_required', 'A file part is required.');
        assertUploadRoom(store, config, req.principal, uploaded.bytes.length);
        const f = await store.addFile(
          req.principal.owner,
          uploaded.name,
          uploaded.bytes,
          undefined,
          undefined,
          principalSubject(req.principal),
        );
        return {
          id: f.id,
          object: 'file',
          bytes: f.bytes,
          created_at: Math.floor(f.createdAt / 1000),
          filename: f.name,
          purpose: 'user_data',
        };
      }
      const b = z
        .object({
          filename: z.string().min(1).max(240),
          content: z.string().max(12_000_000),
          encoding: z.enum(['utf8', 'base64']).default('utf8'),
          allowed_nodes: z.array(z.string()).min(1).optional(),
        })
        .strict()
        .parse(req.body);
      relativeName(b.filename);
      const bytes = Buffer.from(b.content, b.encoding === 'utf8' ? 'utf8' : 'base64');
      assertUploadRoom(store, config, req.principal, bytes.length);
      const file = await store.addFile(
        req.principal.owner,
        b.filename,
        bytes,
        b.allowed_nodes,
        undefined,
        principalSubject(req.principal),
      );
      return {
        id: file.id,
        object: 'file',
        bytes: file.bytes,
        created_at: Math.floor(file.createdAt / 1000),
        filename: file.name,
        purpose: 'user_data',
        sha256: file.sha256,
      };
    });
    app.get('/v1/files/:id/content', async (req, reply) => {
      auth.require(req.principal, 'files');
      const visible = visibleSubject(req.principal);
      const file = store.file((req.params as { id: string }).id, req.principal.owner, visible);
      if (file.runId) kernel.authorize(req.principal, store.run(file.runId).agentId, 'read');
      const payload = await store.filePayload(file.id, req.principal.owner, visible);
      reply.header(
        'Content-Disposition',
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      return reply.type('application/octet-stream').send(Buffer.from(payload.content, 'base64'));
    });
    const executeProtocolInvocation = async (
      req: FastifyRequest,
      reply: FastifyReply,
      invocation: Invocation,
      responseDialect: 'responses' | 'chat' | 'claude' | 'gemini' | 'uap',
      streamMode: StreamMode,
      includeUsage = false,
    ) => {
      // 流式请求先占事件流名额，超限时不创建运行。
      const release = invocation.stream ? streamSlots(store).acquire(req.principal) : undefined;
      let run: Run;
      let resumed: ReturnType<typeof resumeBridged>;
      try {
        resumed = resumeBridged(kernel, store, req.principal, invocation);
        run =
          resumed?.run ??
          kernel.submit(
            req.principal,
            flattenClientResults(invocation),
            req.headers['idempotency-key'] as string | undefined,
            providerKeyOf(req),
          );
      } catch (error) {
        release?.();
        throw error;
      }
      reply.header('X-Run-ID', run.id);
      if (responseDialect === 'uap') reply.header('X-UAP-Version', '1.0');
      if (invocation.metadata['oaa.client_tools_ignored'])
        reply.header('X-OAA-Client-Tools', 'ignored');
      const ignored = ignoredParamsHeader(
        paramFamily(req.url.split('?')[0]!, responseDialect),
        req.body,
      );
      if (ignored) reply.header('X-OAA-Ignored-Params', ignored);
      if (invocation.stream) {
        streamEvents(
          req,
          reply,
          store,
          auth,
          run.id,
          resumed?.cursor ?? 0,
          streamMode,
          includeUsage,
          run,
          { jsonArray: responseDialect === 'gemini' && !sseRequested(req), release },
        );
        return;
      }
      if (invocation.background) {
        return responseDialect === 'uap' ? uapResponseObject(run) : responseObject(run);
      }
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      const off = observeAuthorization(auth, req, (error) => controller.abort(error));
      reply.raw.once('close', disconnect);
      try {
        const bridged = bridgeDialect(responseDialect) && run.checkpoint.bridge;
        const final = bridged
          ? await waitParkedOrTerminal(kernel, store, run.id, controller.signal)
          : await kernel.wait(run.id, true, controller.signal);
        revalidateObservation(auth, req);
        if (bridged) return bridgedObject(responseDialect, store, final);
        if (responseDialect === 'chat') return chatObject(final);
        if (responseDialect === 'claude') return claudeMessageObject(final);
        if (responseDialect === 'gemini') return geminiResponseObject(final);
        if (responseDialect === 'uap') return uapResponseObject(final);
        return responseObject(final);
      } finally {
        off();
        reply.raw.off('close', disconnect);
      }
    };

    for (const endpoint of ['/v1/responses', '/v1/invoke', '/v1/chat/completions', '/v1/messages'])
      app.post(endpoint, async (req, reply) => {
        const headers = req.headers as Record<string, unknown>;
        const invocation =
          endpoint === '/v1/invoke'
            ? parseInvocation(req.body, headers)
            : endpoint === '/v1/responses'
              ? parseResponse(req.body, headers)
              : endpoint === '/v1/messages'
                ? parseClaudeMessages(req.body, headers)
                : parseChat(req.body, headers);
        const dialect =
          endpoint === '/v1/chat/completions'
            ? 'chat'
            : endpoint === '/v1/messages'
              ? 'claude'
              : 'responses';
        const streamMode: StreamMode =
          endpoint === '/v1/chat/completions'
            ? 'chat'
            : endpoint === '/v1/messages'
              ? 'claude'
              : 'responses';
        const includeUsage =
          endpoint === '/v1/chat/completions' &&
          (req.body as { stream_options?: { include_usage?: boolean } })?.stream_options
            ?.include_usage === true;
        return executeProtocolInvocation(req, reply, invocation, dialect, streamMode, includeUsage);
      });

    app.get('/v1/compat/models', async (req) => {
      auth.require(req.principal, 'read');
      const agents = cachedAgents(req.principal);
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

    app.post('/v1/compat/chat/completions', async (req, reply) => {
      const headers = req.headers as Record<string, unknown>;
      const invocation = parseCompatChat(req.body, headers);
      const includeUsage =
        (req.body as { stream_options?: { include_usage?: boolean } })?.stream_options
          ?.include_usage === true;
      return executeProtocolInvocation(req, reply, invocation, 'chat', 'chat', includeUsage);
    });

    app.post('/v1/compat/responses', async (req, reply) => {
      const headers = req.headers as Record<string, unknown>;
      const invocation = parseCompatResponse(req.body, headers);
      return executeProtocolInvocation(req, reply, invocation, 'responses', 'responses');
    });

    app.post('/v1/compat/messages', async (req, reply) => {
      const headers = req.headers as Record<string, unknown>;
      const invocation = parseClaudeMessages(req.body, headers);
      return executeProtocolInvocation(req, reply, invocation, 'claude', 'claude');
    });

    app.post('/v1/uap', async (req, reply) => {
      const headers = req.headers as Record<string, unknown>;
      const { invocation, format } = parseUapRequest(req.body, headers);
      const streamMode: StreamMode = format === 'sse' ? 'uap-sse' : 'uap-ndjson';
      return executeProtocolInvocation(req, reply, invocation, 'uap', streamMode);
    });

    registerGeminiModelRoutes(app, auth, cachedAgents);
    // `/v1beta/{agent}:generateContent` without `models/`: the AI SDK Google provider treats any id
    // that contains a slash (every agent id does) as a full resource name and does not add it.
    for (const route of ['/v1beta/models/*', '/v1/models/*', '/v1beta/*'])
      app.post(route, async (req, reply) => {
        const { rawTarget, isStream } = geminiMethod(req);
        const headers = req.headers as Record<string, unknown>;
        const invocation = parseGeminiGenerateContent(req.body, rawTarget, isStream, headers);
        return executeProtocolInvocation(req, reply, invocation, 'gemini', 'gemini');
      });

    app.post('/v1/universal', async (req, reply) => {
      const headers = req.headers as Record<string, unknown>;
      const dialect = detectProtocolDialect(req.body, headers);
      reply.header('X-OAA-Detected-Protocol', dialect);
      if (dialect === 'uap') {
        const { invocation, format } = parseUapRequest(req.body, headers);
        return executeProtocolInvocation(
          req,
          reply,
          invocation,
          'uap',
          format === 'sse' ? 'uap-sse' : 'uap-ndjson',
        );
      }
      if (dialect === 'oaa') {
        const invocation = parseInvocation(req.body, headers);
        return executeProtocolInvocation(req, reply, invocation, 'responses', 'responses');
      }
      if (dialect === 'gemini') {
        const rawBody = req.body as Record<string, unknown>;
        const isStream = Boolean(rawBody.stream);
        const invocation = parseGeminiGenerateContent(req.body, undefined, isStream, headers);
        return executeProtocolInvocation(req, reply, invocation, 'gemini', 'gemini');
      }
      if (dialect === 'claude') {
        const invocation = parseClaudeMessages(req.body, headers);
        return executeProtocolInvocation(req, reply, invocation, 'claude', 'claude');
      }
      if (dialect === 'chat') {
        const invocation = parseCompatChat(req.body, headers);
        const includeUsage =
          (req.body as { stream_options?: { include_usage?: boolean } })?.stream_options
            ?.include_usage === true;
        return executeProtocolInvocation(req, reply, invocation, 'chat', 'chat', includeUsage);
      }
      const invocation = parseCompatResponse(req.body, headers);
      return executeProtocolInvocation(req, reply, invocation, 'responses', 'responses');
    });
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
          const conversion = conversionProfile(a.engine, config.localWorker);
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
        ...(platform ? openapiWithPlatform : openapi),
        servers: [{ url: baseUrl, description: 'OAA Gateway Public Endpoint' }],
      };
    });
    app.addHook('preClose', async () => {
      platform?.close();
      cleanupCatalog();
      await kernel.close();
    });
    app.addHook('onClose', async () => {
      store.close();
    });
    return {
      app,
      kernel,
      store,
      hub,
      auth,
      catalog,
      platform,
      listen: async () => {
        try {
          const address = await app.listen({ host: config.host, port: config.port });
          kernel.start();
          return address;
        } catch (error) {
          await app.close();
          throw error;
        }
      },
    };
  } catch (error) {
    cleanupCatalog();
    await cleanupHub().catch(() => {});
    store.close();
    throw error;
  }
}
