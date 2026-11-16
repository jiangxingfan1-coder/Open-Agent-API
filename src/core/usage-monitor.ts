import { z } from 'zod';

const localPath = z.string().max(4096).default('');
export const usageSettingsSchema = z
  .object({
    version: z.literal(1).default(1),
    codexbar: z
      .object({
        enabled: z.boolean().default(false),
        mode: z.enum(['cache', 'cli']).default('cache'),
        file: localPath,
        executable: localPath,
        providers: z
          .array(z.string().regex(/^[a-z][a-z0-9-]{0,79}$/))
          .max(8)
          .default([])
          .refine(
            (values) =>
              new Set(values).size === values.length &&
              values.every((v) => v !== 'all' && v !== 'both'),
            'Select distinct individual providers, not all/both.',
          ),
        source: z.enum(['cli', 'oauth', 'api']).default('cli'),
      })
      .strict()
      .prefault({}),
    ccusage: z
      .object({
        enabled: z.boolean().default(false),
        executable: localPath,
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type UsageSettings = z.infer<typeof usageSettingsSchema>;
export type QuotaWindow = {
  id: string;
  label: string;
  used_percent: number | null;
  remaining_percent: number | null;
  resets_at: number | null;
  window_minutes: number | null;
  limit: number | null;
  unit: string | null;
};
export type AccountQuota = {
  id: string;
  provider: string;
  account: string | null;
  source: string;
  confidence: 'exact' | 'estimated' | 'percent_only' | 'unknown';
  observed_at: number | null;
  status: 'reported' | 'stale' | 'unavailable';
  windows: QuotaWindow[];
  balance: {
    remaining: number;
    unit: string;
    observed_at: number | null;
    stale: boolean;
    shared: boolean;
  } | null;
  budget: {
    shared: boolean;
    personal_used: number | null;
    used: number;
    limit: number;
    remaining: number;
    unit: string;
    period: string | null;
    observed_at: number | null;
    resets_at: number | null;
    stale: boolean;
  } | null;
};
export type TokenDay = {
  date: string;
  agent: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  total: number | null;
};
export type CollectedUsage = {
  collector: 'codexbar' | 'ccusage';
  collected_at: number;
  accounts: AccountQuota[];
  daily: TokenDay[];
  partial?: boolean;
};
