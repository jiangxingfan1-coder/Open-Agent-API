import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Auth } from './auth.js';
import type { HttpRunAdmission } from './run-admission.js';
import { WorkflowRunner } from '../kernel/task-workflows.js';
import { taskWorkflowSchema, validateTaskWorkflow } from '../lang/task-workflow.js';
import { invocationSchema } from '../kernel/invocation.js';
import { Fault, faultOf, sha } from '../core/util.js';
import { contractInstruction } from '../kernel/output-contract.js';

const WEBHOOK_MAX_BYTES = 65_536;
const WEBHOOK_WINDOW_MS = 60_000;
const WEBHOOK_RPM = 60;
const WEBHOOK_AUTH_FAIL_LIMIT = 20;
const DUMMY_DIGEST = Buffer.alloc(32, 0);

const mintWebhookToken = () => `oaw_${randomBytes(24).toString('base64url')}`;

function extractWebhookToken(req: FastifyRequest): string | undefined {
  const header = req.headers['x-oaa-webhook-token'];
  if (Array.isArray(header))
    throw new Fault('invalid_request', 'Send X-OAA-Webhook-Token at most once.', 400);
  if (typeof header === 'string' && header.trim()) return header.trim();
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function registerTaskWorkflowRoutes(
  app: FastifyInstance,
  {
    auth,
    config,
    store,
    kernel,
    admission,
  }: {
    auth: Auth;
    config?: GatewayConfig;
    store: Store;
    kernel: Kernel;
    admission: HttpRunAdmission;
  },
) {
  const runner = new WorkflowRunner(store, kernel, (p) => auth.refreshPrincipal(p));
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const hitBucket = (key: string, max: number): boolean => {
    const now = Date.now();
    if (rateBuckets.size > 4096) {
      for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
    }
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + WEBHOOK_WINDOW_MS });
      return true;
    }
    if (bucket.count >= max) return false;
    bucket.count++;
    return true;
  };
  const callerIp = (req: FastifyRequest): string => {
    const fwd = config?.trustProxy
      ? String(req.headers['x-forwarded-for'] ?? '')
          .split(',')[0]
          ?.trim()
      : '';
    return (fwd || req.socket?.remoteAddress || 'local').slice(0, 64);
  };

  app.addHook('onListen', async () => runner.start());
  app.addHook('preClose', async () => runner.close());
  const idOf = (value: unknown) => z.object({ id: z.string().min(1).max(200) }).parse(value).id;
  app.get('/v1/workflows', async (req) => {
    auth.require(req.principal, 'read');
    const query = z
      .object({ archived: z.enum(['true', 'false']).default('false') })
      .strict()
      .parse(req.query);
    return {
      data: runner.records
        .list(req.principal.owner)
        .filter((record) => !!record.archivedAt === (query.archived === 'true'))
        .flatMap((record) => {
          try {
            return [runner.view(req.principal, record)];
          } catch {
            return [];
          }
        }),
    };
  });
  for (const action of ['archive', 'restore'] as const)
    app.post(`/v1/workflows/:id/${action}`, async (req) => {
      auth.requireNodeAdmin(req.principal);
      const { revision } = z
        .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(req.body);
      const id = idOf(req.params),
        record = runner.records.get(req.principal.owner, id);
      runner.view(req.principal, record);
      return runner.view(
        req.principal,
        runner.records.archive(req.principal.owner, id, revision, action === 'archive', {
          ...record.definition,
          enabled: false,
        }),
      );
    });
  app.post('/v1/workflows', async (req) => {
    auth.requireNodeAdmin(req.principal);
    const body = z
      .object({
        definition: taskWorkflowSchema,
        revision: z.string().min(1).max(64),
        rotate_webhook_token: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const agents = new Set(
      store.agentDefinitions(req.principal.owner, req.principal.agents).map((b) => b.agent.id),
    );
    const validated = validateTaskWorkflow(body.definition, agents);
    runner.authorize(req.principal, {
      definition: validated.definition,
      revision: body.revision,
      authority: req.principal,
    });
    if (validated.definition.trigger.kind === 'event')
      kernel.authorize(req.principal, validated.definition.trigger.agent, 'read');

    let issuedWebhookToken: string | undefined;
    if (validated.definition.trigger.kind === 'webhook') {
      let existingHash: string | undefined;
      try {
        const current = runner.records.get(req.principal.owner, validated.definition.id);
        if (current.definition.trigger.kind === 'webhook')
          existingHash = current.definition.trigger.secretHash;
      } catch {
        /* New workflow has no prior secretHash. */
      }
      const suppliedHash = validated.definition.trigger.secretHash;
      if (suppliedHash !== undefined && suppliedHash !== existingHash)
        throw new Fault(
          'invalid_request',
          'Webhook secretHash is managed by the gateway and cannot be set directly.',
        );
      if (!suppliedHash || body.rotate_webhook_token) {
        issuedWebhookToken = mintWebhookToken();
        validated.definition.trigger = {
          kind: 'webhook',
          secretHash: sha(issuedWebhookToken),
        };
      }
    }

    const record = runner.records.put(
      req.principal.owner,
      validated.definition,
      req.principal,
      body.revision,
    );
    return {
      ...runner.view(req.principal, record),
      plan: validated.plan,
      ...(issuedWebhookToken ? { webhook_token: issuedWebhookToken } : {}),
    };
  });
  app.post('/v1/workflows/:id/webhook-token', async (req) => {
    auth.requireNodeAdmin(req.principal);
    const body = z
      .object({
        revision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const id = idOf(req.params);
    const current = runner.records.get(req.principal.owner, id);
    runner.view(req.principal, current);
    if (current.archivedAt)
      throw new Fault(
        'not_resumable',
        'Restore the archived workflow before rotating its token.',
        409,
      );
    const expectedRevision = body.revision ?? current.revision;
    const issued = mintWebhookToken();
    const updated = runner.records.put(
      req.principal.owner,
      {
        ...current.definition,
        trigger: { kind: 'webhook', secretHash: sha(issued) },
      },
      req.principal,
      expectedRevision,
    );
    return { ...runner.view(req.principal, updated), webhook_token: issued };
  });
  app.post('/v1/webhooks/workflows/:id', { bodyLimit: WEBHOOK_MAX_BYTES }, async (req, reply) => {
    const workflowId = z
      .object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/) })
      .parse(req.params).id;
    const ip = callerIp(req);
    if (!hitBucket(`req:${ip}:${workflowId}`, WEBHOOK_RPM))
      throw new Fault('rate_limited', 'Too many inbound workflow webhook requests.', 429);

    const payload = req.body === undefined ? {} : req.body;
    const encoded = JSON.stringify(payload) ?? '{}';
    if (Buffer.byteLength(encoded) > WEBHOOK_MAX_BYTES)
      throw new Fault('payload_too_large', 'Inbound webhook JSON payload exceeds 64 KiB.', 413);

    const rawToken = extractWebhookToken(req);
    if (!rawToken) {
      if (!hitBucket(`fail:${ip}`, WEBHOOK_AUTH_FAIL_LIMIT))
        throw new Fault('rate_limited', 'Too many failed webhook authentication attempts.', 429);
      throw new Fault('unauthorized', 'Missing workflow webhook token.', 401);
    }

    const givenDigest = Buffer.from(sha(rawToken), 'hex');
    const candidates = runner.records
      .list()
      .filter(
        (r) =>
          r.definition.id === workflowId &&
          r.definition.trigger.kind === 'webhook' &&
          typeof r.definition.trigger.secretHash === 'string',
      );
    let matched: (typeof candidates)[number] | undefined;
    if (!candidates.length) {
      timingSafeEqual(givenDigest, DUMMY_DIGEST);
    } else {
      for (const candidate of candidates) {
        const trigger = candidate.definition.trigger;
        if (trigger.kind !== 'webhook' || !trigger.secretHash) continue;
        const expected = Buffer.from(trigger.secretHash, 'hex');
        if (expected.length === givenDigest.length && timingSafeEqual(givenDigest, expected)) {
          matched = candidate;
        }
      }
    }
    if (!matched) {
      if (!hitBucket(`fail:${ip}`, WEBHOOK_AUTH_FAIL_LIMIT))
        throw new Fault('rate_limited', 'Too many failed webhook authentication attempts.', 429);
      throw new Fault('unauthorized', 'Invalid workflow webhook token.', 401);
    }
    if (matched.archivedAt)
      throw new Fault('not_resumable', 'Archived workflows cannot be triggered by webhook.', 409);
    if (!matched.definition.enabled)
      throw new Fault('scope_denied', 'Workflow inbound webhook trigger is disabled.', 403);

    try {
      const execution = runner.launch(matched.authority, matched, payload, []);
      runner.records.noteTrigger(matched.authority.owner, matched.definition.id, matched.revision);
      return reply.code(202).send({
        id: execution.id,
        workflow_id: matched.definition.id,
        status: execution.status,
      });
    } catch (error) {
      try {
        runner.records.noteTrigger(
          matched.authority.owner,
          matched.definition.id,
          matched.revision,
          faultOf(error).code,
        );
      } catch {
        /* Status update must not mask admission error. */
      }
      throw error;
    }
  });
  app.post('/v1/workflows/validate', async (req) => {
    auth.requireNodeAdmin(req.principal);
    const body = z.object({ definition: taskWorkflowSchema }).strict().parse(req.body);
    return validateTaskWorkflow(
      body.definition,
      new Set(
        store.agentDefinitions(req.principal.owner, req.principal.agents).map((b) => b.agent.id),
      ),
    );
  });
  app.post('/v1/workflows/draft', async (req, reply) => {
    auth.requireNodeAdmin(req.principal);
    const body = z
      .object({
        agent: z.string().max(120),
        model: z.string().max(200).default('auto'),
        request: z.string().min(1).max(12000),
      })
      .strict()
      .parse(req.body);
    const agents = store
      .agentDefinitions(req.principal.owner, req.principal.agents)
      .map((b) => ({ id: b.agent.id, models: kernel.router.choices(b.agent).map((r) => r.id) }));
    const contract = {
      kind: 'json_schema' as const,
      schema: z.toJSONSchema(taskWorkflowSchema, { target: 'draft-7', io: 'input' }),
      strict: true,
    };
    const invocation = invocationSchema.parse({
      agent: body.agent,
      model: body.model,
      input: `Create a workflow definition, not an execution. Return JSON only. Keep enabled=false and trigger={"kind":"manual"}. Use agent IDs as graph step tools; arguments must contain input and optional model. Dependencies use depends_on and data uses {"$ref":"step#/output"}. Available agents and route IDs: ${JSON.stringify(agents)}. Request: ${body.request}`,
      metadata: { 'oaa.tools_disabled': 'true', 'oaa.orchestration_child': 'true' },
      output_contract: contract,
    });
    invocation.input += `\n\n${contractInstruction(contract)}`;
    const run = await admission.run(req, reply, (submitter) =>
      submitter.submit(req.principal, invocation),
    );
    const result = await kernel.wait(run.id, true);
    auth.requireNodeAdmin(auth.revalidate(req.headers.authorization));
    if (result.status !== 'completed')
      throw new Fault(
        'output_contract',
        `The workflow draft did not complete (${result.error?.code ?? result.status}); no workflow was published or executed.`,
        422,
      );
    const value = JSON.parse(result.output.map((m) => m.text).join('')) as unknown;
    const validated = validateTaskWorkflow(value, new Set(agents.map((a) => a.id)));
    validated.definition.enabled = false;
    validated.definition.trigger = { kind: 'manual' };
    return { definition: validated.definition, plan: validated.plan, run_id: run.id };
  });
  app.post('/v1/workflows/:id/run', async (req, reply) => {
    auth.require(req.principal, 'invoke');
    if (req.headers['x-oaa-provider-key'])
      throw new Fault(
        'byok_not_supported',
        'Workflow executions cannot persist caller provider credentials.',
        400,
      );
    const body = z
      .object({
        input: z.unknown().default({}),
        file_ids: z.array(z.string().max(120)).max(20).default([]),
      })
      .strict()
      .parse(req.body ?? {});
    const record = runner.records.get(req.principal.owner, idOf(req.params));
    runner.view(req.principal, record);
    return reply
      .code(202)
      .send(
        runner.visible(
          req.principal,
          runner.launch(req.principal, record, body.input, body.file_ids),
        ),
      );
  });
  app.get('/v1/workflow-runs', async (req) => {
    auth.require(req.principal, 'read');
    return {
      data: runner.records.executions(req.principal.owner).flatMap((execution) => {
        try {
          return [runner.visible(req.principal, execution)];
        } catch {
          return [];
        }
      }),
    };
  });
  app.get('/v1/workflow-runs/:id', async (req) => {
    auth.require(req.principal, 'read');
    return runner.visible(
      req.principal,
      runner.records.execution(req.principal.owner, idOf(req.params)),
      true,
    );
  });
  app.post('/v1/workflow-runs/:id/cancel', async (req) => {
    auth.require(req.principal, 'invoke');
    const execution = runner.records.execution(req.principal.owner, idOf(req.params));
    await runner.cancel(req.principal, execution);
    const current = auth.revalidate(req.headers.authorization);
    auth.require(current, 'invoke');
    return runner.visible(current, runner.records.execution(req.principal.owner, execution.id));
  });
  app.post('/v1/workflow-runs/:id/resume', async (req) => {
    auth.require(req.principal, 'invoke');
    const execution = runner.records.execution(req.principal.owner, idOf(req.params));
    runner.visible(req.principal, execution);
    if (execution.status !== 'blocked' || execution.cancellation)
      throw new Fault('not_resumable', 'Only blocked workflow executions can be resumed.', 409);
    execution.status = 'queued';
    delete execution.error;
    runner.records.save(execution);
    runner.start();
    return { id: execution.id, status: execution.status };
  });
  return runner;
}
