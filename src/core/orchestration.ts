import { z } from 'zod';

export const ORCHESTRATION_PROFILES = {
  auto: { maxStages: 8, timeoutMs: 900_000 },
  speed: { maxStages: 3, timeoutMs: 300_000 },
  quality: { maxStages: 12, timeoutMs: 1_800_000 },
  cost: { maxStages: 4, timeoutMs: 600_000 },
} as const;
export type OrchestrationMode = keyof typeof ORCHESTRATION_PROFILES;
export type ModelMark = {
  turn: number;
  attempt: number;
  route: string;
  start: number;
  dispatched?: number;
  end?: number;
  status?: 'completed' | 'failed' | 'cancelled';
  calls?: number;
};
export const orchestrationSchema = z
  .object({
    enabled: z.boolean(),
    scope: z.enum(['agent', 'helpers']).optional(),
    helpers: z
      .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/))
      .max(16)
      .default([]),
    maxStages: z.number().int().min(1).max(24).optional(),
    timeoutMs: z.number().int().min(1000).max(604_800_000).optional(),
  })
  .strict();
export const orchestrationPlanSchema = z
  .object({
    stages: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
            role: z.enum(['analyze', 'execute', 'review']),
            agent: z.string().min(1).max(120),
            model: z.string().min(1).max(200),
            task: z.string().min(1).max(12_000),
          })
          .strict(),
      )
      .min(1)
      .max(23),
  })
  .strict();
export type OrchestrationStage = z.infer<typeof orchestrationPlanSchema>['stages'][number];
export type OrchestrationState = {
  mode: OrchestrationMode;
  maxStages: number;
  used: number;
  started?: string[];
  plan?: OrchestrationStage[];
  results: Record<string, { output: string; runId?: string }>;
  activeStage?: string;
  finalText?: string;
  recommendation?: boolean;
};
