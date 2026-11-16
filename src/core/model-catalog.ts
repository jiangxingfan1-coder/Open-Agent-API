import { z } from 'zod';
import { sha } from './util.js';
export const MAX_AGENT_MODELS = 1024;
export const isRoutingModeId = (id: string): boolean =>
  ['auto', 'fast', 'best', 'eco'].includes(id.toLowerCase());
export const modelRouteId = (model: string): string =>
  /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(model) && !isRoutingModeId(model)
    ? model
    : `model-${sha(model).slice(0, 20)}`;
const routeKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/);
export const modelRouteSchema = z
  .object({
    id: routeKey,
    provider: routeKey,
    model: z.string().min(1).max(200),
    priority: z.number().min(0).max(100).default(0),
    tags: z.array(z.string().min(1).max(32)).max(16).optional(),
    costTier: z.number().min(1).max(5).optional(),
    speedTier: z.number().min(1).max(5).optional(),
    qualityTier: z.number().min(1).max(5).optional(),
    discovered: z.boolean().optional(),
  })
  .strict();

export const discoveredModelSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(240),
    isDefault: z.boolean().optional(),
    verification: z.enum(['discovered', 'configured']),
  })
  .strict();
export const modelCatalogSchema = z
  .object({
    status: z.enum(['ready', 'stale', 'unavailable', 'unsupported']),
    source: z.string().max(80),
    checkedAt: z.number().nonnegative(),
    expiresAt: z.number().nonnegative(),
    models: z.array(discoveredModelSchema).max(MAX_AGENT_MODELS),
    truncated: z.boolean().optional(),
    error: z.string().max(80).optional(),
    clientTools: z.literal('hybrid').optional(),
  })
  .strict();
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export const modelPolicySchema = z
  .object({
    mode: z.enum(['declared', 'discover']),
    allow: z.array(z.string().min(1).max(200)).max(MAX_AGENT_MODELS).optional(),
  })
  .strict();
