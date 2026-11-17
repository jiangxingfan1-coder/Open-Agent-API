import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Auth } from './auth.js';
import { WorkflowRunner } from '../kernel/task-workflows.js';
import { taskWorkflowSchema, validateTaskWorkflow } from '../lang/task-workflow.js';
import { invocationSchema } from '../kernel/invocation.js';
import { Fault } from '../core/util.js';
import { contractInstruction } from '../kernel/output-contract.js';

export function registerTaskWorkflowRoutes(
  app: FastifyInstance,
  { auth, store, kernel }: { auth: Auth; store: Store; kernel: Kernel },
) {
  const runner = new WorkflowRunner(store, kernel, (p) => auth.refreshPrincipal(p));
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
      .object({ definition: taskWorkflowSchema, revision: z.string().min(1).max(64) })
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
    if (body.definition.trigger.kind === 'event')
      kernel.authorize(req.principal, body.definition.trigger.agent, 'read');
    const record = runner.records.put(
      req.principal.owner,
      validated.definition,
      req.principal,
      body.revision,
    );
    return { ...runner.view(req.principal, record), plan: validated.plan };
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
  app.post('/v1/workflows/draft', async (req) => {
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
    const run = kernel.submit(req.principal, invocation);
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
}
