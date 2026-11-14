/**
 * Images for external engines (docs/images.md). The image files are already in the task
 * workspace (`inputs/<file id>/<name>`) and named in the input text (the workspace-file
 * fallback). Engines with a documented image input get the image in their own form as well:
 *
 * - ACP: an `image` content block (`mimeType` + base64 `data`) when the agent's `initialize`
 *   declared `promptCapabilities.image`; otherwise the workspace file only, or a refusal when the
 *   adapter set `imageFiles: false`.
 * - Claude Code (Agent SDK): the prompt becomes one streamed `SDKUserMessage` whose content is the
 *   text and Anthropic `image` blocks (base64 source).
 * - Codex (app-server): `turn/start` input items `{ type: "localImage", path }` after the text.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WorkContext } from '../core/contracts.js';
import { Fault } from '../core/util.js';

export type EngineImages = WorkContext['images'];

/** Absolute path of an image inside `cwd`; a path that leaves the workspace is refused. */
export function workspaceImagePath(cwd: string, workspacePath: string): string {
  const root = path.resolve(cwd);
  const full = path.resolve(root, workspacePath);
  if (!full.startsWith(root + path.sep))
    throw new Fault('invalid_path', 'Image path leaves the task workspace.', 400);
  return full;
}

async function base64Images(cwd: string, images: NonNullable<EngineImages>) {
  return Promise.all(
    images.map(async (i) => {
      const file = workspaceImagePath(cwd, i.workspacePath);
      const bytes = await readFile(file).catch(() => {
        throw new Fault(
          'image_delivery_failed',
          `Image delivery failed: ${i.workspacePath} is missing from the task workspace.`,
          502,
        );
      });
      return { mime: i.mime, data: bytes.toString('base64') };
    }),
  );
}

/**
 * A failed turn of an engine whose image input is implemented from its documentation only
 * (Claude Code image blocks, Codex `localImage`): keep the error code, but say that this turn
 * carried images and how they were sent, so the user can tell the image step apart.
 */
export function imageDeliveryHint(
  error: unknown,
  engine: string,
  form: string,
  images: EngineImages,
) {
  if (!images?.length) return error;
  const base = error instanceof Fault ? error : new Fault('native_incomplete', String(error), 502);
  return new Fault(
    base.code,
    `${base.message} (This turn carried ${images.length} image(s), sent to ${engine} as ${form}; that image path is implemented from documentation only. If the error concerns the image, retry without it or attach it as a file.)`,
    base.status,
    base.uncertain,
  );
}

export async function acpImageBlocks(
  capabilities: Record<string, unknown>,
  imageFiles: boolean | undefined,
  cwd: string,
  images: EngineImages,
): Promise<Record<string, unknown>[]> {
  if (!images?.length) return [];
  const prompt = capabilities.promptCapabilities;
  const declared =
    !!prompt && typeof prompt === 'object' && (prompt as Record<string, unknown>).image === true;
  if (declared)
    return (await base64Images(cwd, images)).map((i) => ({
      type: 'image',
      mimeType: i.mime,
      data: i.data,
    }));
  if (imageFiles === false)
    throw new Fault(
      'unsupported_content',
      'This ACP agent does not declare image input and its adapter disables image files (imageFiles: false). Send the request without images.',
      400,
    );
  return [];
}

/** The Agent SDK prompt: the plain string, or one user message with image blocks. */
export async function claudePrompt(
  input: string,
  cwd: string,
  images: EngineImages,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (!images?.length) return input;
  const blocks = (await base64Images(cwd, images)).map((i) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: i.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      data: i.data,
    },
  }));
  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: input }, ...blocks] },
    parent_tool_use_id: null,
  };
  return (async function* () {
    yield message;
  })();
}

/** Codex `turn/start` input: the text, then one `localImage` item per image file. */
export function codexInput(input: string, cwd: string, images: EngineImages) {
  return [
    { type: 'text', text: input },
    ...(images ?? []).map((i) => ({
      type: 'localImage',
      path: workspaceImagePath(cwd, i.workspacePath),
    })),
  ];
}
