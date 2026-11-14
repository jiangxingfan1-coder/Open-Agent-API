/**
 * Image parts on the provider wire (docs/images.md). A user message's `images` become each
 * protocol's own image shape after the text: OpenAI Responses `input_image`, Chat Completions
 * `image_url`, Anthropic `image` (base64 or url source) and Gemini `inlineData`. Bytes are added
 * by the worker from the run's input files right before the call (`withImageData`), so stored
 * checkpoints only ever hold file references.
 */
import type { FilePayload, ModelImage, ModelMessage } from '../core/contracts.js';
import type { ProviderConfig } from '../config/config.js';
import { Fault } from '../core/util.js';

export type ProviderImageInput = 'none' | 'inline' | 'url';

/**
 * A provider's image support: the configured `imageInput`, else a conservative default by kind.
 * `openai-chat` is used for many text-only compatible servers, so it starts at `none`.
 */
export function providerImageInput(config: ProviderConfig): ProviderImageInput {
  if (config.imageInput) return config.imageInput;
  if (config.kind === 'openai-chat') return 'none';
  return config.kind === 'gemini-generate' ? 'inline' : 'url';
}

/** Fill in `data` for file images from the work's input files (a missing file is an error). */
export function withImageData(
  messages: ModelMessage[],
  files: readonly FilePayload[],
): ModelMessage[] {
  if (!messages.some((m) => m.images?.length)) return messages;
  return messages.map((m) =>
    m.images?.length
      ? {
          ...m,
          images: m.images.map((image) => {
            if (image.kind === 'url') return image;
            const file = files.find((f) => f.id === image.fileId);
            if (!file)
              throw new Fault(
                'file_not_found',
                'An image input file is missing on this worker.',
                404,
              );
            return { ...image, data: file.content };
          }),
        }
      : m,
  );
}

const dataOf = (image: Extract<ModelImage, { kind: 'file' }>) => {
  if (image.data === undefined)
    throw new Fault('image_invalid', 'Image bytes were not attached to the model call.', 500);
  return image.data;
};
const dataUrl = (image: ModelImage) =>
  image.kind === 'url' ? image.url : `data:${image.mime};base64,${dataOf(image)}`;

/** Responses API user content: the text, then `input_image` parts. */
export function responsesUserContent(m: ModelMessage): string | Record<string, unknown>[] {
  if (!m.images?.length) return m.content;
  return [
    ...(m.content ? [{ type: 'input_text', text: m.content }] : []),
    ...m.images.map((image) => ({ type: 'input_image', image_url: dataUrl(image) })),
  ];
}

/** Chat Completions user content: the text, then `image_url` parts. */
export function chatUserContent(m: ModelMessage): string | Record<string, unknown>[] {
  if (!m.images?.length) return m.content;
  return [
    ...(m.content ? [{ type: 'text', text: m.content }] : []),
    ...m.images.map((image) => ({ type: 'image_url', image_url: { url: dataUrl(image) } })),
  ];
}

/** Anthropic Messages user blocks: the text, then `image` blocks. */
export function anthropicUserBlocks(m: ModelMessage): Record<string, unknown>[] {
  return [
    { type: 'text', text: m.content },
    ...(m.images ?? []).map((image) => ({
      type: 'image',
      source:
        image.kind === 'url'
          ? { type: 'url', url: image.url }
          : { type: 'base64', media_type: image.mime, data: dataOf(image) },
    })),
  ];
}

/** Gemini user parts: the text, then `inlineData` parts (URLs are never placed on Gemini). */
export function geminiUserParts(m: ModelMessage): Record<string, unknown>[] {
  return [
    { text: m.content },
    ...(m.images ?? []).map((image) => {
      if (image.kind === 'url')
        throw new Fault('image_invalid', 'Gemini routes do not take image URLs.', 500);
      return { inlineData: { mimeType: image.mime, data: dataOf(image) } };
    }),
  ];
}
