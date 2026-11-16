import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '../config/config.js';
import type { Principal, Run } from '../core/contracts.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Store } from '../store/store.js';
import type { Auth } from './auth.js';
import type { VisibleAgent } from './agent-views.js';
import {
  parseInvocation,
  parseChat,
  parseCompatChat,
  parseResponse,
  parseCompatResponse,
  parseClaudeMessages,
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
import { discardNewImages, materializeImages } from './image-input.js';
import { observeAuthorization, revalidateObservation } from './streams.js';
import { streamEvents, streamOptions, streamSlots, type StreamMode } from './compat-stream.js';
import { ignoredParamsHeader, paramFamily } from './compat-params.js';
import { bridgeDialect, bridgedObject, resumeBridged, waitParkedOrTerminal } from './bridge.js';
import { clientToolsHeader, submitClientTools } from './client-tools-auto.js';
import { applyConnectionDefaults } from './connection-defaults.js';
import { refreshAgentModels } from '../fabric/model-pool.js';
import type { NodeHub } from '../fabric/network.js';
import { checkAccessPolicy } from '../kernel/access-policy.js';
import { geminiMethod, registerGeminiModelRoutes } from './gemini.js';

// 协议入口：OAA Responses / Invoke、OpenAI Chat、Claude Messages、Gemini、UAP 与 /v1/universal 的
// 调用路由，以及 /v1/compat/models。从 gateway/server.ts 拆出，注册顺序与拆分前一致。

export type ProtocolRouteDeps = {
  auth: Auth;
  config: GatewayConfig;
  store: Store;
  kernel: Kernel;
  hub: NodeHub;
  providerKeyOf: (req: FastifyRequest) => string | undefined;
  cachedAgents: (p: Principal) => VisibleAgent[];
};

export function registerProtocolRoutes(app: FastifyInstance, deps: ProtocolRouteDeps): void {
  const { auth, config, store, kernel, hub, providerKeyOf, cachedAgents } = deps;
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
      invocation = applyConnectionDefaults(req, store, invocation);
      const publication = store.bundle(
        req.principal.owner,
        invocation.agent,
        invocation.agent_version,
      ).agent;
      checkAccessPolicy(publication, req.principal, invocation.metadata);
      if (
        publication.modelPolicy?.mode === 'discover' ||
        (publication.engine === 'antigravity' && publication.access)
      )
        await refreshAgentModels(hub, req.principal.owner, publication.engine);
      invocation = await materializeImages(store, config, req.principal, invocation);
      resumed = resumeBridged(kernel, store, req.principal, invocation);
      run =
        resumed?.run ??
        submitClientTools(
          kernel,
          req.principal,
          invocation,
          req.headers['idempotency-key'] as string | undefined,
          providerKeyOf(req),
          config.clientTools.default,
        );
    } catch (error) {
      release?.();
      await discardNewImages(store, req.principal.owner, invocation);
      throw error;
    }
    reply.header('X-Run-ID', run.id);
    if (responseDialect === 'uap') reply.header('X-UAP-Version', '1.0');
    const toolsMode = clientToolsHeader(run);
    if (toolsMode) reply.header('X-OAA-Client-Tools', toolsMode);
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
        streamOptions(req, responseDialect, release, config.streamProgress),
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
  // `/v1beta/*` also takes `{agent}:generateContent` without `models/` (AI SDK Google provider).
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
}
