import { outputContractOf } from './run-contract.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.js';
import type { Store } from '../store/store.js';
import type { Kernel } from '../kernel/kernel.js';
import { visibleSubject } from '../core/contracts.js';
import { responseObject } from './protocol.js';
import { cursor, streamEvents } from './compat-stream.js';
import { outputPage } from '../store/inspection.js';
import { observeAuthorization, revalidateObservation } from './streams.js';
import { etagMatches } from './overview.js';
import { streamSlots } from './stream-slots.js';
import { buildTimeline } from './timeline.js';
import { Fault, faultOf } from '../core/util.js';

// Request schemas are built once: constructing a zod schema costs far more than parsing with it.
const offsetLimit = (max: number, fallback: number) => ({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(max).default(fallback),
});
const stepsQuery = z
  .object({
    ...offsetLimit(50, 20),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'uncertain']).optional(),
  })
  .strict();
const actionsQuery = z.object(offsetLimit(10, 5)).strict();
const artifactsQuery = z.object(offsetLimit(20, 10)).strict();
const outputQuery = z
  .object({
    cursor: z.string().max(512).optional(),
    max_bytes: z.coerce.number().int().min(256).max(16000).default(8000),
  })
  .strict();
const waitQuery = z
  .object({ timeout_ms: z.coerce.number().int().min(0).max(25000).default(20000) })
  .strict();
const responseQuery = z
  .object({
    stream: z.enum(['true', 'false']).optional(),
    starting_after: z.coerce.number().int().min(-1).optional(),
  })
  .passthrough();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const decisionBody = z
  .object({
    decision: z.enum(['approve', 'deny']),
    response: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const reconcileBody = z
  .object({
    step_id: z.string(),
    outcome: z.enum(['completed', 'not_executed']),
    value: z.unknown().optional(),
  })
  .strict();

export interface RunRouteContext {
  auth: Auth;
  store: Store;
  kernel: Kernel;
  /** 从请求头取调用方自带的模型密钥（BYOK）；没有则为 undefined。 */
  providerKeyOf: (req: FastifyRequest) => string | undefined;
}

/**
 * 请求（运行）的查看与操作接口：状态、时间线、步骤、审批、输出、生成的文件、事件流、
 * 恢复与人工确认。全部只读写该调用方看得见的运行。
 */
export function registerRunRoutes(app: FastifyInstance, context: RunRouteContext): void {
  const { auth, store, kernel, providerKeyOf } = context;
  const ownedRun = (req: FastifyRequest) => {
    const run = store.run(
      (req.params as { id: string }).id,
      req.principal.owner,
      visibleSubject(req.principal),
    );
    kernel.authorize(req.principal, run.agentId, 'read');
    return run;
  };
  const ownedIdentity = (req: FastifyRequest) => {
    const run = store.runIdentity(
      (req.params as { id: string }).id,
      req.principal.owner,
      visibleSubject(req.principal),
    );
    kernel.authorize(req.principal, run.agentId, 'read');
    return run;
  };
  app.get('/v1/runs/:id/state', async (req) => {
    const run = ownedIdentity(req);
    const state = store.runState(run.id, run.owner);
    const queue = kernel.queueInsight(run.id, run.owner, state.status);
    const contract = outputContractOf(store, run.id);
    return {
      ...state,
      ...(contract ? { output_contract: contract } : {}),
      ...(queue ? { queue } : {}),
    };
  });
  // Derived from durable events, steps and checkpoint marks; never calls a model or tool.
  app.get('/v1/runs/:id/timeline', async (req, reply) => {
    const run = ownedIdentity(req);
    const lastEventId = store.lastEventId(run.id);
    const etag = `W/"tl.${lastEventId}.${run.status}"`;
    reply.header('ETag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return buildTimeline({ ...store.timelineSource(run.id, run.owner), now: Date.now() });
  });
  app.get('/v1/runs/:id/steps', async (req) => {
    const run = ownedIdentity(req);
    const q = stepsQuery.parse(req.query);
    return store.stepPage(run.id, run.owner, q.offset, q.limit, q.status);
  });
  app.get('/v1/runs/:id/steps/:step', async (req) => {
    const run = ownedIdentity(req);
    return store.stepDetails(run.id, run.owner, (req.params as { step: string }).step);
  });
  app.get('/v1/runs/:id/steps/:step/content', async (req, reply) => {
    const run = ownedIdentity(req);
    reply.header('Content-Disposition', 'attachment; filename="step.json"');
    return reply
      .type('application/json')
      .send(store.stepContent(run.id, run.owner, (req.params as { step: string }).step));
  });
  app.get('/v1/runs/:id/actions', async (req) => {
    const run = ownedIdentity(req);
    const q = actionsQuery.parse(req.query);
    return store.actionPage(run.id, run.owner, q.offset, q.limit);
  });
  app.get('/v1/runs/:id/actions/:action/content', async (req, reply) => {
    const run = ownedIdentity(req);
    const action = store.getApproval((req.params as { action: string }).action, run.owner);
    if (action.runId !== run.id) throw new Fault('approval_not_found', 'Approval not found.', 404);
    reply.header('Content-Disposition', 'attachment; filename="approval.json"');
    return reply.type('application/json').send(JSON.stringify(action));
  });
  app.get('/v1/runs/:id/output.txt', async (req, reply) => {
    const run = ownedIdentity(req);
    reply.header('Content-Disposition', 'attachment; filename="output.txt"');
    return reply.type('text/plain; charset=utf-8').send(
      store
        .runOutput(run.id, run.owner)
        .output.map((item) => item.text)
        .join('\n\n'),
    );
  });
  app.get('/v1/runs/:id/output', async (req) => {
    const run = ownedIdentity(req);
    const query = outputQuery.parse(req.query);
    return outputPage(store.runOutput(run.id, run.owner), query.cursor, query.max_bytes);
  });
  app.get('/v1/runs/:id/artifacts', async (req) => {
    const run = ownedIdentity(req);
    const query = artifactsQuery.parse(req.query);
    return store.artifacts(run.id, run.owner, query.offset, query.limit);
  });
  app.get('/v1/runs/:id/wait', async (req, reply) => {
    const run = ownedIdentity(req);
    const { timeout_ms } = waitQuery.parse(req.query);
    const release = streamSlots(store).acquire(req.principal);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Fault('wait_timeout', 'The wait deadline expired.', 408)),
      timeout_ms,
    );
    const disconnect = () => controller.abort();
    const off = observeAuthorization(auth, req, (error) => controller.abort(error));
    reply.raw.once('close', disconnect);
    let timedOut = false;
    try {
      await kernel.wait(run.id, true, controller.signal);
    } catch (error) {
      if (faultOf(error).code !== 'wait_timeout') throw error;
      timedOut = true;
    } finally {
      clearTimeout(timer);
      release();
      off();
      reply.raw.off('close', disconnect);
    }
    revalidateObservation(auth, req);
    return { ...store.runState(run.id, run.owner), timed_out: timedOut };
  });
  // `?stream=true` 重新接上流：从头重放（官方 SDK 在本地按 starting_after 过滤），给了
  // `starting_after` 时服务端也跳过不大于它的帧。
  app.get('/v1/responses/:id', async (req, reply) => {
    const run = ownedRun(req);
    const q = responseQuery.parse(req.query);
    if (q.stream !== 'true') return responseObject(run);
    streamEvents(req, reply, store, auth, run.id, 0, 'responses', false, run, {
      skipThrough: q.starting_after,
    });
    return undefined;
  });
  app.get('/v1/runs/:id', async (req) => {
    const run = ownedRun(req);
    return {
      response: responseObject(run),
      status: run.status,
      error: run.error,
      route: run.route,
      steps: store.steps(run.id),
      actions: store.approvals(run.id),
      artifacts: run.artifactIds.map((f) => store.file(f, run.owner)),
    };
  });
  app.get('/v1/runs', async (req) => {
    auth.require(req.principal, 'read');
    const { limit } = listQuery.parse(req.query);
    return {
      data: store.summaries(
        req.principal.owner,
        req.principal.agents,
        limit,
        visibleSubject(req.principal),
      ),
    };
  });
  app.get('/v1/runs/:id/events', async (req, reply) => {
    const run = ownedRun(req);
    const after = cursor(req);
    streamEvents(req, reply, store, auth, run.id, after, 'native', false, run);
  });
  app.post('/v1/responses/:id/cancel', async (req) =>
    responseObject(await kernel.cancel(req.principal, (req.params as { id: string }).id)),
  );
  app.post('/v1/runs/:id/resume', async (req) =>
    responseObject(
      kernel.resume(req.principal, (req.params as { id: string }).id, providerKeyOf(req)),
    ),
  );
  app.post('/v1/runs/:id/actions/:action', async (req) => {
    const p = req.params as { id: string; action: string };
    const b = decisionBody.parse(req.body);
    // 调用方工具的待办不能人工批准：由 kernel.decide 检查（action_kind_mismatch）。
    kernel.decide(req.principal, p.id, p.action, b.decision, b.response);
    return { resolved: true };
  });
  app.post('/v1/runs/:id/reconcile', async (req) => {
    const b = reconcileBody.parse(req.body);
    kernel.reconcile(
      req.principal,
      (req.params as { id: string }).id,
      b.step_id,
      b.outcome,
      b.value ?? null,
    );
    return { resolved: true, evidence: 'operator_assertion' };
  });
}
