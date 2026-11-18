import { z } from 'zod';
import { parsePublishedGraph, compileGraphPlan } from './graph.js';
import { publishedGraphSchema } from './graph-schema.js';
import { parseCron, validateTimeZone } from './cron.js';
import { Fault } from '../core/util.js';

export const taskWorkflowSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/),
    name: z.string().min(1).max(200),
    graph: publishedGraphSchema,
    concurrency: z.number().int().min(1).max(4).default(2),
    project: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/)
      .optional(),
    enabled: z.boolean().default(false),
    trigger: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('manual') }).strict(),
        z
          .object({
            kind: z.literal('interval'),
            minutes: z.number().int().min(1).max(10080),
            input: z.unknown().default({}),
          })
          .strict(),
        z
          .object({
            kind: z.literal('cron'),
            expression: z.string().min(1).max(120),
            timezone: z.string().min(1).max(120).default('UTC'),
            input: z.unknown().default({}),
          })
          .strict(),
        z
          .object({
            kind: z.literal('event'),
            agent: z.string().min(1).max(120),
            subject: z.string().min(1).max(200).optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('webhook'),
            secretHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .strict(),
      ])
      .default({ kind: 'manual' }),
  })
  .strict();
export type TaskWorkflow = z.infer<typeof taskWorkflowSchema>;
export const workflowAgents = (definition: TaskWorkflow) => [
  ...new Set(
    definition.graph.steps
      .flatMap((s) => [s.tool, ...(s.fallback?.tool ? [s.fallback.tool] : [])])
      .filter((name) => name !== '$transform'),
  ),
];
export function validateTaskWorkflow(value: unknown, agents: Set<string>) {
  const definition = taskWorkflowSchema.parse(value);
  if (definition.trigger.kind === 'cron') {
    parseCron(definition.trigger.expression);
    validateTimeZone(definition.trigger.timezone);
  }
  const allowed = new Set(['input', 'model', 'file_ids', 'strategy', 'output_kind', 'format']);
  const argumentsOf = (args: Record<string, unknown>) => {
    if (!Object.hasOwn(args, 'input') || Object.keys(args).some((key) => !allowed.has(key)))
      throw new Fault(
        'invalid_graph',
        'Agent stages require input and accept only model, file_ids, strategy, output_kind and format alongside it.',
      );
  };
  for (const step of definition.graph.steps) {
    if (step.tool !== '$transform') argumentsOf(step.arguments);
    if (step.fallback?.tool && step.fallback.tool !== '$transform')
      argumentsOf(step.fallback.arguments ?? {});
  }
  const steps = parsePublishedGraph(
    definition.graph,
    agents,
    new Map([...agents].map((a) => [a, 'unknown' as const])),
  );
  return {
    definition: { ...definition, graph: { ...definition.graph, steps } },
    plan: compileGraphPlan(steps),
  };
}
