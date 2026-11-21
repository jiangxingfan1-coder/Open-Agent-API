import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { readFile } from 'node:fs/promises';
import { z, ZodError } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import type { Executor } from '../fabric/worker.js';
import { WorkerRuntime } from '../fabric/worker.js';
import { Store } from '../store/store.js';
import { setArtifactByteLimit } from '../store/large-artifacts.js';
import { Auth } from './auth.js';
import { Kernel } from '../kernel/kernel.js';
import { NodeHub } from '../fabric/network.js';
import type { AgentDefinition, Principal } from '../core/contracts.js';
import { principalSubject, visibleSubject } from '../core/contracts.js';
import { Fault, canonical, faultOf, secret, sha } from '../core/util.js';
import { Catalog } from './catalog.js';
import { restoreLocalBackends, type HandshakeRecord } from '../fabric/local-backends.js';
import { catalogEntries, visibleAgentsFor } from './agent-views.js';
import { registerAgentRoutes } from './agent-routes.js';
import { registerCatalogFeedRoutes } from './catalog-feed-routes.js';
import { registerFileRoutes } from './file-routes.js';
import { registerNodeEnrollRoute, registerNodeRoutes } from './node-routes.js';
import { registerOverviewRoutes } from './overview-routes.js';
import { registerProtocolRoutes } from './protocol-routes.js';
import { HttpRunAdmission } from './run-admission.js';
import { registerLocalBackendRoutes } from './local-backend-routes.js';
import { registerLocalConnectionRoutes } from './local-connection-routes.js';
import type { LocalTargetOptions } from './local-managed-targets.js';
import { registerLocalModelRoutes, restoreLocalModelProviders } from './local-model-routes.js';
import { registerUsageRoutes } from './usage-routes.js';
import { registerEvaluationRoutes } from './evaluation-routes.js';
import { restoreEverythingAcp, registerEverythingAcpRoutes } from './everything-acp-routes.js';
import { registerOwnerRoutes } from './shutdown-route.js';
import { registerMetricsRoutes } from './metrics-routes.js';
import { WebhookDispatcher } from './webhooks.js';
import { registerWebhookRoutes } from './webhook-routes.js';
import { registerConsoleAssets } from './console-assets.js';
import { geminiQueryKey, sendError, zodFault } from './compat-errors.js';
import * as http from './compat-http.js';
import { SummaryWindow, TimelineCache, computeActivity } from './activity.js';
import { AUDITED_CODES, AuditLog } from '../store/audit.js';
import { Platform } from './platform.js';
import { GATEWAY_FEATURES, GATEWAY_VERSION, buildEndpointDirectory } from './endpoints.js';
import { portalGate, registerPlatform } from './platform-routes.js';
import { registerPlatformSetup, runningPlatform } from './platform-setup.js';
import { OverviewRevisions, OverviewStreams, RevisionCache, overviewViewKey } from './overview.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}
export { GATEWAY_FEATURES } from './endpoints.js';
export async function createGateway(
  config: GatewayConfig,
  localExecutor?: Executor,
  /** `configFile`：网关配置文件路径。提供后，控制台里「启用已安装的智能体」会把新条目写回该文件。 */
  options: { configFile?: string; dshHome?: string; localTargets?: LocalTargetOptions } = {},
) {
  const store = new Store(config.dataDir);
  setArtifactByteLimit(store, config.maxArtifactBytes);
  let cleanupHub = async () => {};
  let cleanupCatalog = () => {};
  try {
    const auth = new Auth(store);
    await auth.load(config);
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS local_backends(owner TEXT NOT NULL,engine TEXT NOT NULL,executable TEXT NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(owner,engine))',
    );
    restoreEverythingAcp(store, config, localExecutor);
    restoreLocalModelProviders(store, config, localExecutor);
    restoreLocalBackends(store.db, config.localWorker, localExecutor);
    const handshakes = new Map<string, HandshakeRecord>();
    const credentials = await Promise.all(
      config.nodeKeys.map(async (n) => ({ ...n, token: await secret(n) })),
    );
    credentials.push(...auth.nodeCredentials());
    const hub = new NodeHub(credentials, config.leaseMs, auth.nodePolicies(), store);
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
        (localExecutor ??= new WorkerRuntime({
          ...config.localWorker,
          ...(config.localWorker.maxArtifactBytes === undefined &&
          config.maxArtifactBytes !== undefined
            ? { maxArtifactBytes: config.maxArtifactBytes }
            : {}),
        })),
      );
    }
    // Recovery can write terminal events in the kernel constructor, before Fastify is ready.
    const webhooks = new WebhookDispatcher(store, config.security.profile);
    const kernel = new Kernel(store, hub, {
      maxActiveRuns: config.maxActiveRuns,
      approvalTimeoutMs: config.approvalTimeoutMs,
      structuredRepairs: config.structuredOutput.maxRepairs,
      ...(config.maxActiveRunsPerSubject !== undefined
        ? { maxActiveRunsPerSubject: config.maxActiveRunsPerSubject }
        : {}),
    });
    kernel.setAuth(auth);
    const running = runningPlatform(config, store.db);
    const platform =
      running &&
      new Platform(store, auth, running.config, config.localWorker, config.security.profile);
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
      if (req.method === 'POST' && /^\/v1\/webhooks\/workflows\/[^/]+$/.test(pathname)) return;
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
    const visibleAgents = (p: Principal) => visibleAgentsFor({ store, hub, kernel }, p);
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
    registerAgentRoutes(app, {
      auth,
      config,
      store,
      kernel,
      hub,
      catalog,
      cachedAgents,
      providerKeyOf,
      auditPolicy,
    });
    registerNodeRoutes(app, { auth, config, hub });
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
    registerNodeEnrollRoute(app, { auth, config, hub });
    registerUsageRoutes(app, { auth, config, store, kernel, hub, isLocalRequest: isLocalProbe });
    registerEvaluationRoutes(app, {
      auth,
      config,
      store,
      hub,
      kernel,
      isLocalRequest: isLocalProbe,
    });
    registerEverythingAcpRoutes(app, {
      auth,
      config,
      store,
      hub,
      localExecutor,
      isLocalRequest: isLocalProbe,
    });
    await registerLocalConnectionRoutes(app, {
      auth,
      config,
      store,
      hub,
      cachedAgents,
      dshHome: options.dshHome,
      localTargets: options.localTargets,
      isLocalRequest: isLocalProbe,
    });
    registerLocalModelRoutes(app, {
      auth,
      config,
      store,
      hub,
      localExecutor,
      isLocalRequest: isLocalProbe,
    });
    registerWebhookRoutes(app, webhooks, config);
    const admission = new HttpRunAdmission(auth, kernel);
    app.addHook('preClose', async () => {
      admission.close();
      store.provisionalInputs.stopAccepting();
    });
    registerOwnerRoutes(app, { auth, audit, config, store, kernel, hub, providerKeyOf, admission });
    registerMetricsRoutes(app, {
      auth,
      store,
      hub,
      cachedMetrics,
      activityCache,
      timelines,
      summaryWindows,
    });
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
    registerCatalogFeedRoutes(app, { auth, catalog });
    registerFileRoutes(app, { auth, config, store, kernel });
    registerProtocolRoutes(app, {
      auth,
      config,
      store,
      kernel,
      hub,
      providerKeyOf,
      cachedAgents,
      admission,
    });
    registerOverviewRoutes(app, {
      auth,
      config,
      store,
      kernel,
      hub,
      revisions,
      withPlatform: !!platform,
      resolvePublicBaseUrl,
      cachedAgents,
      cachedNodes,
      cachedMetrics,
      showsNodes,
      activityCache,
      timelines,
      summaryWindows,
      overviewStreams,
    });
    app.addHook('onReady', async () => auth.accounting.recover());
    app.addHook('preClose', async () => {
      platform?.close();
      cleanupCatalog();
      await kernel.close();
    });
    app.addHook('onClose', async () => {
      auth.accounting.close();
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
