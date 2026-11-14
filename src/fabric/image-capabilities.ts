/**
 * What a worker declares under image-input-v1 (docs/images.md), and the workspace note that tells
 * an external agent where its image files are.
 *
 * - Kernel providers: `providers.<name>.imageInput`, else a default by kind (image-wire.ts);
 *   drivers supplied in code declare `imageInput` themselves.
 * - External engines: Codex and Claude Code take images natively; ACP agents per their
 *   `promptCapabilities.image` (with the workspace-file fallback unless `imageFiles: false`);
 *   Antigravity, DSH and stdio oaa/1 adapters read workspace files; HTTP adapters and A2A agents
 *   receive text only and are not listed, so images for them are refused before a run exists.
 */
import type { WorkerConfig } from '../config/config.js';
import type { ExecutionCapabilities, WorkContext } from '../core/contracts.js';
import type { ModelDriver } from '../providers/models.js';
import { providerImageInput } from '../providers/image-wire.js';
export { withImageData } from '../providers/image-wire.js';

type ImageInputAdvert = NonNullable<ExecutionCapabilities['imageInput']>;

export function imageInputAdvert(
  config: WorkerConfig,
  drivers: ReadonlyMap<string, ModelDriver>,
): ImageInputAdvert {
  const providers: ImageInputAdvert['providers'] = {};
  for (const [name, provider] of Object.entries(config.providers))
    providers[name] = providerImageInput(provider);
  for (const [name, driver] of drivers)
    if (!(name in config.providers)) providers[name] = driver.imageInput ?? 'none';
  const native: ImageInputAdvert['native'] = {};
  if (config.native.codex?.enabled) native.codex = 'native';
  if (config.native.claude?.enabled) native.claude = 'native';
  if (config.native.antigravity?.enabled) native.antigravity = 'workspace-file';
  if (config.native.dsh?.enabled) native.dsh = 'workspace-file';
  for (const [name, adapter] of Object.entries(config.adapters)) {
    if (!adapter.enabled) continue;
    if (adapter.transport === 'acp') native[`adapter/${name}`] = 'agent-declared';
    else if (adapter.transport === 'stdio' && adapter.imageFiles !== false)
      native[`adapter/${name}`] = 'workspace-file';
  }
  return { providers, native };
}

/** The lines appended to an external agent's input that name its image files. */
export function imageNote(context: Pick<WorkContext, 'images'>): string {
  const images = context.images ?? [];
  if (!images.length) return '';
  const lines = images.map((i, n) => `[Image #${n + 1}] ${i.workspacePath} (${i.mime})`);
  return `\n\nAttached images (files in this task workspace; open them with your own tools):\n${lines.join('\n')}`;
}

/** The input of a workspace agent: the request, its image note, the input file list. */
export function nativeInputText(input: string, context: WorkContext): string {
  const inputPaths = context.files
    .map((f) => f.workspacePath ?? `inputs/${f.id}/${f.name}`)
    .join('\n');
  return `${input}${imageNote(context)}\n\n${inputPaths ? `Available input files:\n${inputPaths}\n` : ''}Place any downloadable deliverables under the outputs/ directory of this task workspace. Do not copy credentials into outputs.`;
}
