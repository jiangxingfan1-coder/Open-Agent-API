import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import { requireOwnerAdmin } from './platform-db.js';
import { WEBHOOK_EVENTS, checkWebhookUrl } from './webhook-core.js';
import type { Delivery, WebhookEndpoint } from './webhook-db.js';
import { WebhookDispatcher } from './webhooks.js';

/** Endpoint as the API shows it (never the secret); `status` summarizes recent deliveries. */
function view(d: WebhookDispatcher, e: WebhookEndpoint) {
  const latest = d.db.deliveries(e.id, 1)[0];
  return {
    object: 'webhook_endpoint',
    id: e.id,
    url: e.url,
    events: e.events,
    agents: e.agents,
    include_output: e.include_output,
    enabled: e.enabled,
    description: e.description,
    allow_insecure_http: e.allow_insecure_http,
    allow_private_network: e.allow_private_network,
    created_at: e.created_at,
    updated_at: e.updated_at,
    status: {
      state: !e.enabled ? 'disabled' : e.consecutive_failures > 0 ? 'failing' : 'ok',
      consecutive_failures: e.consecutive_failures,
      last_success_at: e.last_success_at,
      last_failure_at: e.last_failure_at,
      last_error: e.last_error,
      pending: d.db.pendingCount(e.id),
      ...d.db.queueStatus(e.id),
      latest_delivery: latest ? deliveryView(latest) : null,
    },
  };
}

function deliveryView(d: Delivery) {
  return {
    object: 'webhook_delivery',
    id: d.id,
    endpoint_id: d.endpoint_id,
    event_id: d.event_id,
    event_type: d.event_type,
    run_id: d.run_id,
    status: d.status,
    attempts: d.attempts,
    next_attempt_at: d.status === 'pending' ? d.next_at : null,
    http_status: d.last_status,
    duration_ms: d.duration_ms,
    last_error: d.last_error,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

const fields = {
  url: z.string().min(1).max(2048),
  events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length),
  agents: z.array(z.string().min(1).max(200)).max(100),
  include_output: z.boolean(),
  enabled: z.boolean(),
  description: z.string().max(500),
  allow_insecure_http: z.boolean(),
  allow_private_network: z.boolean(),
};
const createSchema = z
  .object({
    ...fields,
    events: fields.events.default([]),
    agents: fields.agents.default([]),
    include_output: fields.include_output.default(false),
    enabled: fields.enabled.default(true),
    description: fields.description.default(''),
    allow_insecure_http: fields.allow_insecure_http.default(false),
    allow_private_network: fields.allow_private_network.default(false),
  })
  .strict();
const updateSchema = z.object(fields).partial().strict();

/**
 * Run-event webhooks (`/v1/webhooks…`), owner-wide admin keys only. Also owns the dispatcher's
 * lifecycle: sending starts when the app is ready and stops in preClose. Capture remains attached
 * for the kernel's shutdown checkpoints; detach releases it when the gateway closes.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  dispatcher: WebhookDispatcher,
  config: GatewayConfig,
): void {
  app.addHook('onReady', async () => dispatcher.start());
  app.addHook('preClose', async () => dispatcher.halt());
  app.addHook('onClose', async () => dispatcher.detach());
  const db = dispatcher.db;
  const policy = (e: { allow_insecure_http: boolean; allow_private_network: boolean }) => ({
    profile: config.security.profile,
    allowInsecureHttp: e.allow_insecure_http,
    allowPrivateNetwork: e.allow_private_network,
  });
  const param = (req: { params: unknown }, name: string) =>
    (req.params as Record<string, string>)[name]!;

  app.get('/v1/webhooks', async (req) => {
    requireOwnerAdmin(req.principal);
    return { data: db.endpoints(req.principal.owner).map((e) => view(dispatcher, e)) };
  });
  app.post('/v1/webhooks', async (req, reply) => {
    requireOwnerAdmin(req.principal);
    const b = createSchema.parse(req.body);
    const url = checkWebhookUrl(b.url, policy(b)).toString();
    const { endpoint, secret } = db.create(req.principal.owner, { ...b, url });
    dispatcher.changed(endpoint.owner);
    return reply.code(201).send({ ...view(dispatcher, endpoint), secret });
  });
  app.get('/v1/webhooks/:id', async (req) => {
    requireOwnerAdmin(req.principal);
    return view(dispatcher, db.endpoint(req.principal.owner, param(req, 'id')));
  });
  app.patch('/v1/webhooks/:id', async (req) => {
    requireOwnerAdmin(req.principal);
    const b = updateSchema.parse(req.body);
    const current = db.endpoint(req.principal.owner, param(req, 'id'));
    const next: WebhookEndpoint = { ...current, ...b, updated_at: Date.now() };
    next.url = checkWebhookUrl(next.url, policy(next)).toString();
    db.save(next);
    if (
      !next.enabled ||
      next.url !== current.url ||
      next.include_output !== current.include_output ||
      b.agents !== undefined ||
      b.events !== undefined
    )
      dispatcher.forget(next.id);
    dispatcher.changed(next.owner);
    return view(dispatcher, next);
  });
  app.delete('/v1/webhooks/:id', async (req, reply) => {
    requireOwnerAdmin(req.principal);
    const endpointId = param(req, 'id');
    db.remove(req.principal.owner, endpointId);
    dispatcher.forget(endpointId);
    dispatcher.changed(req.principal.owner);
    return reply.code(204).send();
  });
  app.post('/v1/webhooks/:id/rotate-secret', async (req) => {
    requireOwnerAdmin(req.principal);
    const endpointId = param(req, 'id');
    return { id: endpointId, secret: db.rotate(req.principal.owner, endpointId) };
  });
  app.post('/v1/webhooks/:id/test', async (req, reply) => {
    requireOwnerAdmin(req.principal);
    const endpoint = db.endpoint(req.principal.owner, param(req, 'id'));
    return reply.code(202).send(deliveryView(dispatcher.test(endpoint)));
  });
  app.get('/v1/webhooks/:id/deliveries', async (req) => {
    requireOwnerAdmin(req.principal);
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(20) })
      .strict()
      .parse(req.query);
    const endpoint = db.endpoint(req.principal.owner, param(req, 'id'));
    return { data: db.deliveries(endpoint.id, q.limit).map(deliveryView) };
  });
  app.post('/v1/webhooks/:id/deliveries/:delivery/redeliver', async (req, reply) => {
    requireOwnerAdmin(req.principal);
    const d = db.requeue(req.principal.owner, param(req, 'id'), param(req, 'delivery'));
    dispatcher.kick();
    return reply.code(202).send(deliveryView(d));
  });
}
