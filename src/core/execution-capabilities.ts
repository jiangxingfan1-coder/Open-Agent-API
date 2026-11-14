/** What a worker declares about how it can execute work (sent in its node advertisement). */
import { z } from 'zod';
import { imageInputCapabilitySchema } from './images.js';

export const executionCapabilitiesSchema = z
  .object({
    builtins: z.array(z.string()).max(100),
    scripts: z.array(z.enum(['node', 'python3'])).max(2),
    toolSelection: z.boolean(),
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
  })
  .strict();
export type ExecutionCapabilities = z.infer<typeof executionCapabilitiesSchema>;
