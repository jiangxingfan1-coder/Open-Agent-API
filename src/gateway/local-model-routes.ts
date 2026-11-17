import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { providerSchema, type GatewayConfig } from '../config/config.js';
import { MODEL_RUNTIMES } from '../config/model-runtimes.js';
import { agentSchema, allowedExecution } from '../core/contracts.js';
import { canonical, Fault } from '../core/util.js';
import { WorkerRuntime, type Executor } from '../fabric/worker.js';
import type { NodeHub } from '../fabric/network.js';
import { makeBundle } from '../lang/bundle.js';
import { findPreset, presetProviderEntry } from '../providers/provider-presets.js';
import { probeProvider } from '../providers/provider-status.js';
import { providerApiKey } from '../providers/provider-key.js';
import type { Store } from '../store/store.js';
import type { Auth } from './auth.js';

export function localModelEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Fault('invalid_request', 'Invalid local model URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/v1\/?$/.test(url.pathname)
  )
    throw new Fault(
      'invalid_request',
      'Use a loopback model endpoint such as http://127.0.0.1:1234/v1, without credentials or query parameters.',
    );
  // Avoid resolving localhost through a proxy or a modified hosts file.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString().replace(/\/$/, '');
}

const targetSchema = z
  .object({
    runtime: z.enum(MODEL_RUNTIMES.map((runtime) => runtime.id)),
    base_url: z.string().max(2048).optional(),
    key_env: z
      .string()
      .regex(/^(?!OAA_)[A-Za-z_][A-Za-z0-9_]{0,127}$/)
      .optional(),
  })
  .strict();

function target(body: z.infer<typeof targetSchema>) {
  const preset = findPreset(body.runtime)!;
  const baseUrl = localModelEndpoint(body.base_url ?? preset.baseUrl);
  const provider = providerSchema.parse(
    presetProviderEntry(preset, { baseUrl, keyEnv: body.key_env }),
  );
  return { preset, provider, baseUrl };
}

/** Persist only explicit connections, never installation guesses, prompts or model weights. */
export function restoreLocalModelProviders(
  store: Store,
  config: GatewayConfig,
  executor?: Executor,
) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS local_model_providers (owner TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,name))',
  );
  if (!config.localWorker) return;
  for (const row of store
    .prepare('SELECT name,payload FROM local_model_providers WHERE owner=?')
    .all(config.localWorker.owner)) {
    const name = String(row.name);
    if (Object.hasOwn(config.localWorker.providers, name)) continue;
    const provider = providerSchema.parse(JSON.parse(String(row.payload)));
    localModelEndpoint(provider.baseUrl);
    config.localWorker.providers[name] = provider;
    if (executor instanceof WorkerRuntime) executor.config.providers[name] = { ...provider };
  }
}

export function registerLocalModelRoutes(
  app: FastifyInstance,
  deps: {
    auth: Auth;
    config: GatewayConfig;
    store: Store;
    hub: NodeHub;
    localExecutor?: Executor;
    isLocalRequest: (req: FastifyRequest) => boolean;
  },
) {
  const { auth, config, store, hub, localExecutor } = deps;
  const localTarget = (body: z.infer<typeof targetSchema>) => {
    const result = target(body);
    const address = app.server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    const endpoint = new URL(result.baseUrl);
    if (endpoint.protocol === 'http:' && Number(endpoint.port || 80) === port)
      throw new Fault('invalid_request', 'A model provider cannot point back to this gateway.');
    return result;
  };
  const guard = (req: FastifyRequest) => {
    const current = auth.revalidate(req.headers.authorization);
    auth.requireNodeAdmin(current);
    if (
      allowedExecution(current) !== 'host' ||
      current.owner !== config.localWorker?.owner ||
      current.owner !== req.principal.owner ||
      current.keyId !== req.principal.keyId ||
      !deps.isLocalRequest(req) ||
      config.security.profile !== 'local' ||
      config.tls ||
      !(localExecutor instanceof WorkerRuntime) ||
      (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`)
    )
      throw new Fault(
        'scope_denied',
        'Local model management requires a direct loopback host owner-admin connection.',
        403,
      );
    return current;
  };
  app.post('/v1/local/model-runtimes/probe', async (req) => {
    guard(req);
    const { provider, baseUrl } = localTarget(targetSchema.parse(req.body));
    if (providerApiKey(provider) === undefined)
      return { status: 'key_missing', base_url: baseUrl, models: [] };
    const result = await probeProvider(provider);
    guard(req);
    return {
      status: !result.reachable
        ? 'unavailable'
        : [401, 403].includes(result.status)
          ? 'authentication_required'
          : result.status >= 400
            ? 'unavailable'
            : result.models?.length
              ? 'ready'
              : 'empty',
      base_url: baseUrl,
      models: result.reachable ? (result.models ?? []) : [],
      ...(!result.reachable ? { error: result.error } : { http_status: result.status }),
      validation: 'model_list_only',
    };
  });
  app.post('/v1/local/model-runtimes/connect', async (req) => {
    const authority = guard(req);
    const body = targetSchema
      .extend({
        model: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^\x00-\x1f]+$/),
        provider_name: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,63}$/)
          .optional(),
        agent: z
          .string()
          .regex(/^agent\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/)
          .optional(),
      })
      .parse(req.body);
    const { preset, provider } = localTarget(body);
    const name = body.provider_name ?? `local-${body.runtime}`;
    const agentId = body.agent ?? `agent/local-${body.runtime}`;
    const bundle = makeBundle(
      agentSchema.parse({
        id: agentId,
        description: `${preset.label}: ${body.model}`,
        instructions: 'Answer the user using the selected local model.',
        provider: name,
        model: body.model,
        tools: [],
        allowGraph: false,
        access: {
          modes: ['managed', 'client'],
          defaultMode: 'managed',
          approval: 'auto',
          trust: 'private',
        },
      }),
    );
    const checkConflicts = () => {
      const existing = config.localWorker!.providers[name];
      const saved = store
        .prepare('SELECT payload FROM local_model_providers WHERE owner=? AND name=?')
        .get(authority.owner, name);
      if (
        (existing && canonical(existing) !== canonical(provider)) ||
        (saved && canonical(JSON.parse(String(saved.payload))) !== canonical(provider))
      )
        throw new Fault(
          'provider_conflict',
          'A different provider already uses this name. Choose another provider name.',
          409,
        );
      const published = store.agentIndex(authority.owner, [agentId])[0];
      if (published && published.digest !== bundle.digest)
        throw new Fault(
          'version_conflict',
          'This agent already exists with different settings. Choose another agent ID.',
          409,
        );
    };
    checkConflicts();
    if (providerApiKey(provider) === undefined)
      throw new Fault(
        'provider_unavailable',
        'The selected key environment variable is not set.',
        503,
      );
    const probe = await probeProvider(provider);
    guard(req);
    checkConflicts();
    if (!probe.reachable || probe.status >= 400)
      throw new Fault(
        'provider_unreachable',
        'The local model server did not return a usable model list. Start it or check its authentication settings.',
        503,
      );
    if (!probe.models?.includes(body.model))
      throw new Fault(
        'model_unavailable',
        'The selected model is not in the server model list. Refresh the model list.',
        503,
      );
    store.publish(authority.owner, bundle, () => {
      store
        .prepare(
          'INSERT INTO local_model_providers VALUES(?,?,?) ON CONFLICT(owner,name) DO NOTHING',
        )
        .run(authority.owner, name, JSON.stringify(provider));
    });
    config.localWorker!.providers[name] = provider;
    (localExecutor as WorkerRuntime).config.providers[name] = { ...provider };
    hub.notifyChange(authority.owner);
    return {
      agent: agentId,
      provider: name,
      model: body.model,
      version: bundle.digest,
      persisted: true,
      validation: 'model_list_only',
      original_configuration_changed: false,
    };
  });
}
