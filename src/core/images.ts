/** Image input types shared by the kernel, the fabric and the providers (docs/images.md). */
import { z } from 'zod';

/**
 * An image attached to a user message (docs/images.md). `file`: bytes live in the run's input
 * file `fileId`; `data` (base64) is filled in by the worker right before the provider call and is
 * never persisted. `url`: an https URL handed unchanged to a provider that fetches it itself.
 */
export type ModelImage =
  { kind: 'file'; fileId: string; mime: string; data?: string } | { kind: 'url'; url: string };
/** An image input of a run: stored as an input file, or (kernel only) a provider-fetched URL. */
export type RunImage =
  | { kind: 'file'; fileId: string; mime: string; name: string; bytes: number; param: string }
  | { kind: 'url'; url: string; param: string };
/** How images reach a worker's model provider or external engine (image-input-v1). */
export type ImageMode = 'inline' | 'url';

/**
 * A worker's image-input-v1 declaration: per kernel provider `inline` (bytes) or `url` (also
 * https URLs), per external engine how images reach it.
 */
export const imageInputCapabilitySchema = z
  .object({
    providers: z.record(z.string().max(200), z.enum(['none', 'inline', 'url'])),
    native: z.record(z.string().max(200), z.enum(['native', 'agent-declared', 'workspace-file'])),
  })
  .strict();
