import { z } from 'zod';
import { GRAPH_LIMITS } from '../core/limits.js';

const foreachSchema = z
  .object({
    $ref: z.string(),
    as: z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/)
      .default('item'),
    max_items: z.number().int().min(1).max(GRAPH_LIMITS.foreachItems).default(16),
    where: z.unknown().optional(),
  })
  .strict();

const fallbackSchema = z
  .object({
    value: z.unknown().optional(),
    tool: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (f) => f.value !== undefined || f.tool !== undefined,
    'Fallback requires either a static/reference value or a fallback tool.',
  );

const stepSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    depends_on: z.array(z.string()).default([]),
    when: z.unknown().optional(),
    foreach: foreachSchema.optional(),
    fallback: fallbackSchema.optional(),
    retry: z
      .object({
        attempts: z.number().int().min(1).max(3),
        backoff_ms: z.number().int().min(0).max(5000).optional(),
      })
      .strict()
      .optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
  })
  .strict();
const schema = (limit: number) =>
  z
    .object({ steps: z.array(stepSchema).min(1).max(limit), output: z.unknown().optional() })
    .strict();
export const graphSchema = schema(GRAPH_LIMITS.adHocSteps);
export const publishedGraphSchema = schema(GRAPH_LIMITS.publishedSteps);
export type GraphStep = z.infer<typeof stepSchema>;
