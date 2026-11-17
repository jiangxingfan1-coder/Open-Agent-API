import { z } from 'zod';
export const sourceConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    sources: z
      .array(
        z
          .object({
            url: z.string().min(1).max(4096),
            selector: z
              .object({
                collection: z.string().max(200),
                id: z.string().max(200),
                value: z.string().max(200),
              })
              .strict()
              .optional(),
            fields: z
              .object({
                contextWindow: z.string().max(200).optional(),
                inputCost: z.string().max(200).optional(),
                outputCost: z.string().max(200).optional(),
                supportsImages: z.string().max(200).optional(),
              })
              .strict()
              .refine((fields) => Object.keys(fields).length > 0),
            priceScale: z.number().positive().max(1000000000).default(1),
          })
          .strict(),
      )
      .max(6)
      .default([]),
  })
  .strict();
export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type ModelFacts = {
  contextWindow?: number;
  inputCost?: number;
  outputCost?: number;
  supportsImages?: boolean;
};
export type SourceReport = { url: string; fetchedAt?: number; facts?: ModelFacts; error?: string };
export type ModelSourceEvidence = {
  sourceId: string;
  fetchedAt: number;
  facts: ModelFacts;
  stale: boolean;
  provenance: 'public_report_not_measurement';
};
