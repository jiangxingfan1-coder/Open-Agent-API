/** What a worker declares about how it can execute work (sent in its node advertisement). */
import { z } from 'zod';
import { imageInputCapabilitySchema } from './images.js';
import { modelCatalogSchema } from './model-catalog.js';

export const conversionProfileSchema = z
  .object({
    access: z.enum(['kernel', 'native', 'acp', 'oaa-adapter', 'a2a', 'unknown']),
    transport: z.string().min(1).max(120),
    tier: z.enum(['basic', 'streaming', 'interactive']),
    streaming: z.enum(['token', 'message', 'final']),
    approvals: z.enum(['bridged', 'denied', 'none']),
    cancel: z.enum(['cooperative', 'terminate', 'request-abort']),
    resume: z.enum(['native', 'agent-declared', 'adapter-state', 'none']),
    tool_events: z.enum(['tool', 'status', 'none']),
    usage: z.enum(['reported', 'agent-reported', 'partial', 'none']),
    artifacts: z.boolean(),
    model_selection: z.enum(['route', 'declared', 'agent-confirmed', 'allowlist']),
    client_tools: z.enum(['bridge', 'managed']),
    image_input: z.enum(['route', 'native', 'agent-declared', 'workspace-file', 'none']),
  })
  .strict();

export const executionCapabilitiesSchema = z
  .object({
    builtins: z.array(z.string()).max(100),
    scripts: z.array(z.enum(['node', 'python3'])).max(2),
    toolSelection: z.boolean(),
    modelCatalogs: z.record(z.string().max(200), modelCatalogSchema).optional(),
    agentPolicyVersion: z.literal(1).optional(),
    toolFreeReasoning: z.array(z.string()).max(100).optional(),
    projectWorkspaces: z.array(z.string().max(120)).max(1000).optional(),
    projectEngines: z.array(z.string().max(200)).max(100).optional(),
    nativeModels: z.record(
      z.string(),
      z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('declared') }).strict(),
        z.object({ mode: z.literal('allowlist'), models: z.array(z.string()).max(100) }).strict(),
      ]),
    ),
    /** Providers that accept a caller-supplied key; sent only after `byok-v1` negotiation. */
    byokProviders: z.array(z.string()).max(100).optional(),
    /** Providers preserving native turn state; sent only after provider-turn-v1 negotiation. */
    providerStateProviders: z.array(z.string()).max(100).optional(),
    /**
     * Engines that can bridge caller tools (docs/harness.md): `kernel` and ACP `adapter/<name>`.
     * Sent only after `client-tools-v1` negotiation.
     */
    clientTools: z
      .object({ native: z.array(z.string().max(200)).max(100) })
      .strict()
      .optional(),
    /** Image input (docs/images.md); sent only after `image-input-v1`. */
    imageInput: imageInputCapabilitySchema.optional(),
    /** Verified OS sandbox; sent only after `sandbox-v1` negotiation. */
    sandbox: z
      .object({
        backend: z.enum(['srt']),
        version: z.string().max(64),
        kinds: z.array(z.string().max(64)).max(32),
      })
      .strict()
      .optional(),
    /** W3C Trace Context + caller subject propagation; sent after `trace-context-v1`. */
    traceContextVersion: z.literal(1).optional(),
    /** Static ConversionProfiles of enabled `adapter/<name>` entries; sent after `conversion-profiles-v1`. */
    adapterProfiles: z.record(z.string().max(200), conversionProfileSchema).optional(),
  })
  .strict();
export type ExecutionCapabilities = z.infer<typeof executionCapabilitiesSchema>;

export type NodeCredential = {
  nodeId: string;
  owner: string;
  token: string;
  capabilities: string[];
  agents: string[];
};
export type NodePolicyState = 'active' | 'draining' | 'revoked';
export const nodePolicySchema = z
  .object({
    nodeId: z.string().min(1).max(120),
    owner: z.string(),
    state: z.enum(['active', 'draining', 'revoked']),
    actor: z.string(),
    reason: z.string().max(1000),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type NodePolicy = z.infer<typeof nodePolicySchema>;
