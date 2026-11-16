import { z } from 'zod';

export const toolBoundarySchema = z.enum(['managed', 'client', 'hybrid']);
export type ToolBoundary = z.infer<typeof toolBoundarySchema>;
export const permitsToolBoundary = (
  modes: readonly ToolBoundary[],
  boundary: ToolBoundary,
): boolean => modes.includes(boundary) || modes.includes('hybrid');
export const agentAccessSchema = z
  .object({
    modes: z.array(toolBoundarySchema).min(1).max(3),
    defaultMode: toolBoundarySchema,
    approval: z.enum(['auto', 'caller', 'owner', 'native']),
    trust: z.enum(['private', 'isolated']),
    workspace: z.enum(['session', 'project']).optional(),
  })
  .strict()
  .refine(
    (policy) => policy.modes.includes(policy.defaultMode),
    'The default mode must be enabled.',
  );
export const connectionSchema = z
  .object({
    toolMode: toolBoundarySchema.optional(),
    audience: z.enum(['private', 'external']).optional(),
    reasoningOnly: z.boolean().optional(),
    allowedModes: z.array(toolBoundarySchema).min(1).max(3).optional(),
    models: z.record(z.string().max(120), z.string().min(1).max(200)).optional(),
  })
  .strict()
  .refine(
    (connection) =>
      !connection.toolMode ||
      !connection.allowedModes ||
      permitsToolBoundary(connection.allowedModes, connection.toolMode),
    'The default tool mode must be within the key mode grants.',
  );
export type ConnectionDefaults = z.infer<typeof connectionSchema>;
