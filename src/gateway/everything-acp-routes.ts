import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { GatewayConfig } from '../config/config.js';
import { workerSchema } from '../config/config.js';
import type { Auth } from './auth.js';
import { WorkerRuntime, type Executor } from '../fabric/worker.js';
import type { NodeHub } from '../fabric/network.js';
import { readEverythingAcpClient, discoverEverythingAcp } from '../config/everything-acp.js';
import { canonical, Fault } from '../core/util.js';

export function restoreEverythingAcp(store: Store, config: GatewayConfig, executor?: Executor) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS everything_acp_connections (owner TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,id))',
  );
  if (!config.localWorker) return;
  for (const row of store
    .prepare('SELECT id,payload FROM everything_acp_connections WHERE owner=?')
    .all(config.localWorker.owner)) {
    const id = String(row.id);
    if (Object.hasOwn(config.localWorker.adapters, id)) continue;
    const entry = workerSchema.shape.adapters.parse({ [id]: JSON.parse(String(row.payload)) })[id]!;
    config.localWorker.adapters[id] = entry;
    if (executor instanceof WorkerRuntime) executor.config.adapters[id] = { ...entry };
  }
}

export function registerEverythingAcpRoutes(
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
  app.get('/v1/local/everything-acp/discover', async (req) => {
    const guard = () => {
      const current = auth.revalidate(req.headers.authorization);
      auth.requireNodeAdmin(current);
      if (
        !deps.isLocalRequest(req) ||
        config.security.profile !== 'local' ||
        current.owner !== config.localWorker?.owner ||
        (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`)
      )
        throw new Fault(
          'scope_denied',
          'Wrapper discovery requires the direct local owner-admin connection.',
          403,
        );
    };
    guard();
    const body = z
      .object({ directory: z.string().min(1).max(4096) })
      .strict()
      .parse(req.query);
    const result = await discoverEverythingAcp(body.directory);
    guard();
    return result;
  });
  app.post('/v1/local/everything-acp/import', async (req) => {
    auth.requireNodeAdmin(req.principal);
    if (
      !deps.isLocalRequest(req) ||
      req.principal.owner !== config.localWorker?.owner ||
      !(localExecutor instanceof WorkerRuntime) ||
      config.security.profile !== 'local'
    )
      throw new Fault(
        'scope_denied',
        'Wrapper import requires the local owner-admin connection.',
        403,
      );
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`)
      throw new Fault('scope_denied', 'Wrapper import requires the same origin.', 403);
    const body = z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        client_file: z.string().max(4096),
      })
      .strict()
      .parse(req.body);
    const authority = auth.revalidate(req.headers.authorization);
    auth.requireNodeAdmin(authority);
    const adapter = await readEverythingAcpClient(body.client_file);
    const current = auth.revalidate(req.headers.authorization);
    auth.requireNodeAdmin(current);
    if (current.owner !== req.principal.owner || current.keyId !== req.principal.keyId)
      throw new Fault('scope_denied', 'The administrator identity changed.', 403);
    const existing = config.localWorker!.adapters[body.id];
    if (existing && canonical({ ...existing, enabled: false }) !== canonical(adapter))
      throw new Fault(
        'backend_conflict',
        'An adapter with this name already exists. Import using another name.',
        409,
      );
    // An import is deliberately disabled until the owner enables and publishes it.
    const saved = store
      .prepare('SELECT payload FROM everything_acp_connections WHERE owner=? AND id=?')
      .get(req.principal.owner, body.id);
    if (saved && canonical(JSON.parse(String(saved.payload))) !== canonical(adapter))
      throw new Fault(
        'backend_conflict',
        'The saved wrapper descriptor differs. Choose another adapter name.',
        409,
      );
    if (!existing) {
      store
        .prepare(
          'INSERT INTO everything_acp_connections VALUES(?,?,?) ON CONFLICT(owner,id) DO NOTHING',
        )
        .run(req.principal.owner, body.id, JSON.stringify(adapter));
      config.localWorker!.adapters[body.id] = adapter;
      localExecutor.config.adapters[body.id] = { ...adapter };
      hub.notifyChange(req.principal.owner);
    }
    return {
      engine: `adapter/${body.id}`,
      enabled: existing?.enabled ?? false,
      persisted: !existing || !!saved,
      validation: 'descriptor_only',
      original_configuration_changed: false,
    };
  });
}
