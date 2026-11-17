import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { NodeHub } from '../fabric/network.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Auth } from './auth.js';
import { ModelEvaluator } from '../kernel/model-evaluation.js';
import { evaluationSettingsSchema } from '../core/model-evaluation.js';
import { Fault, canonical, sha } from '../core/util.js';
import { registerModelFeedback } from './model-feedback.js';
import { registerModelSources } from './model-sources.js';

export function registerEvaluationRoutes(
  app: FastifyInstance,
  deps: {
    auth: Auth;
    store: Store;
    hub: NodeHub;
    kernel: Kernel;
    config: GatewayConfig;
    isLocalRequest: (req: FastifyRequest) => boolean;
  },
) {
  const evaluator = new ModelEvaluator(
    deps.store,
    deps.hub,
    deps.kernel,
    deps.config.security.profile === 'local' && !!deps.config.localWorker,
    deps.config.localWorker?.owner,
  );
  app.addHook('preClose', () => evaluator.close());
  const guard = (req: FastifyRequest) => {
    const current = deps.auth.revalidate(req.headers.authorization);
    deps.auth.requireNodeAdmin(current);
    if (current.owner !== req.principal.owner || current.keyId !== req.principal.keyId)
      throw new Fault('scope_denied', 'Administrator identity changed.', 403);
    if (
      !deps.isLocalRequest(req) ||
      deps.config.security.profile !== 'local' ||
      req.principal.owner !== deps.config.localWorker?.owner
    )
      throw new Fault(
        'scope_denied',
        'Model evaluation requires the direct local owner-admin connection.',
        403,
      );
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`)
      throw new Fault('scope_denied', 'Model evaluation requires the same origin.', 403);
  };
  registerModelFeedback(app, deps.store, deps.kernel, evaluator.records, guard);
  registerModelSources(
    app,
    deps.store,
    deps.kernel,
    guard,
    deps.config.security.profile === 'local' && !!deps.config.localWorker,
    deps.config.localWorker?.owner,
  );
  app.get('/v1/local/evaluations', async (req) => {
    guard(req);
    const { agent } = z
      .object({ agent: z.string().min(1).max(120) })
      .strict()
      .parse(req.query);
    const value = evaluator.view(req.principal.owner, agent);
    return { ...value, settings_revision: sha(canonical(value.settings)) };
  });
  app.post('/v1/local/evaluations/settings', async (req) => {
    guard(req);
    const { agent, settings, revision } = z
      .object({
        agent: z.string().min(1).max(120),
        settings: evaluationSettingsSchema,
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(req.body);
    if (revision !== sha(canonical(evaluator.records.settings(req.principal.owner, agent))))
      throw new Fault(
        'version_conflict',
        'Evaluation settings changed. Refresh before saving.',
        409,
      );
    const value = evaluator.configure(req.principal.owner, agent, settings);
    return { ...value, settings_revision: sha(canonical(value.settings)) };
  });
  app.post('/v1/local/evaluations/run', async (req, reply) => {
    guard(req);
    const { agent } = z
      .object({ agent: z.string().min(1).max(120) })
      .strict()
      .parse(req.body);
    const before = evaluator.view(req.principal.owner, agent);
    if (!before.settings.enabled)
      throw new Fault('scope_denied', 'Enable automatic evaluation first.', 403);
    if (!before.supported)
      throw new Fault(
        'capability_unavailable',
        'The engine cannot safely run tool-free evaluations yet.',
        503,
      );
    void evaluator.run(req.principal.owner, agent).catch(() => {});
    return reply.code(202).send(evaluator.view(req.principal.owner, agent));
  });
}
