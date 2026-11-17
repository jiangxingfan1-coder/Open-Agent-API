import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Run } from '../core/contracts.js';
import type { Store } from '../store/store.js';
import type { Kernel } from '../kernel/kernel.js';
import type { ModelEvaluations } from '../store/model-evaluations.js';
import { discoveredAgent } from '../fabric/model-pool.js';
import { detectTaskIntent } from '../kernel/task-intent.js';
import { Fault } from '../core/util.js';

export const feedbackEligible = (run: Run) =>
  !!run.checkpoint.modelIdentity &&
  !run.metadata['oaa.evaluation'] &&
  (run.status === 'completed' ||
    (run.status === 'failed' &&
      ['output_contract', 'structured_output_invalid'].includes(run.error?.code ?? '')));
export function registerModelFeedback(
  app: FastifyInstance,
  store: Store,
  kernel: Kernel,
  records: ModelEvaluations,
  guard: (request: FastifyRequest) => void,
) {
  app.post('/v1/local/evaluations/feedback', async (request) => {
    guard(request);
    const body = z
      .object({ run_id: z.string().min(1).max(120), passed: z.boolean() })
      .strict()
      .parse(request.body);
    const run = store.run(body.run_id, request.principal.owner);
    if (!feedbackEligible(run) || (run.status !== 'completed' && body.passed))
      throw new Fault(
        'invalid_request',
        'Only identity-captured task results can receive this quality feedback.',
      );
    const agent = discoveredAgent(
      kernel.hub,
      run.owner,
      store.bundle(run.owner, run.agentId, run.digest).agent,
    );
    const health = kernel.router
      .candidates(run.owner, run.digest, agent, () => true)
      .find((route) => route.id === run.route.id)?.health;
    const intent = detectTaskIntent(run.input);
    records.feedback({
      owner: run.owner,
      agent: run.agentId,
      revision: run.checkpoint.modelIdentity!,
      route: run.route.id,
      epoch: 0,
      caseId: `human:${run.id}`,
      dimension: intent === 'coding' || intent === 'reasoning' ? intent : 'tasks',
      runId: run.id,
      startedAt: run.createdAt,
      finishedAt: Date.now(),
      passed: body.passed,
      ...(health?.successfulCalls ? { elapsedMs: health.averageMs } : {}),
    });
    kernel.router.observer?.(run.owner);
    return {
      ok: true,
      agent: run.agentId,
      route: run.route.id,
      performance: records.performance(
        run.owner,
        run.agentId,
        run.checkpoint.modelIdentity!,
        run.route.id,
      ),
    };
  });
}
