/**
 * Image content parts of every entry (docs/images.md), normalized to `ImageInput`: OpenAI Chat
 * `image_url`, Responses `input_image`, Claude `image` blocks, Gemini `inlineData` / `fileData`,
 * and UAP / OAA `image` blocks. Parsing here is synchronous and cheap: a `data:` URL is split by
 * looking at its short header only; decoding, format sniffing and size checks happen once, in
 * image-input.ts, before the run is created. The text the agent sees gets an `[Image #n]` marker
 * where the image was; no image bytes ever enter the prompt text.
 */
import type { ImageInput } from '../kernel/invocation.js';
import { CompatFault } from './compat-errors.js';

type Part = Record<string, unknown>;

export function imageFault(param: string, message: string, code = 'unsupported_content') {
  return new CompatFault(
    code,
    `${param}: ${message}`,
    code === 'image_too_large' ? 413 : 400,
    param,
  );
}

const marker = (images: ImageInput[]) => `[Image #${images.length}]`;

/** `data:<type>;base64,<data>` → parts; only the header (before the comma) is inspected. */
export function splitDataUrl(url: string, param: string): { media_type: string; data: string } {
  const comma = url.indexOf(',', 0);
  const header = comma > 0 && comma <= 200 ? url.slice(5, comma) : '';
  const m = /^([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[a-z0-9-]+=[^;,]*)*);base64$/i.exec(header);
  if (!m)
    throw imageFault(
      param,
      'a data: image URL must be base64 encoded (data:image/png;base64,...).',
      'image_invalid',
    );
  return { media_type: (m[1] ?? '').toLowerCase(), data: url.slice(comma + 1) };
}

/** An image given by URL string: `data:` becomes inline data, anything else stays a URL. */
function byUrl(url: string, param: string): ImageInput {
  if (url.slice(0, 5).toLowerCase() === 'data:') return { ...splitDataUrl(url, param), param };
  return { url, param };
}

/** OpenAI Chat `image_url` and Responses `input_image`; undefined for other part types. */
export function openAIImage(part: Part, param: string, images: ImageInput[]): string | undefined {
  if (part.type === 'image_url') {
    const ref = part.image_url;
    const url = typeof ref === 'string' ? ref : (ref as Part | undefined)?.url;
    if (typeof url !== 'string' || !url)
      throw imageFault(param, 'image_url parts need image_url.url.', 'image_invalid');
    images.push(byUrl(url, param));
    return marker(images);
  }
  if (part.type === 'input_image') {
    if (typeof part.file_id === 'string' && part.file_id)
      images.push({ file_id: part.file_id, param });
    else if (typeof part.image_url === 'string' && part.image_url)
      images.push(byUrl(part.image_url, param));
    else throw imageFault(param, 'input_image parts need image_url or file_id.', 'image_invalid');
    return marker(images);
  }
  return undefined;
}

/** Claude `image` blocks: `base64`, `url` and `file` sources. Undefined for other sources. */
export function claudeImage(block: Part, param: string, images: ImageInput[]): string | undefined {
  if (block.type !== 'image') return undefined;
  const source = (block.source ?? {}) as Part;
  if (source.type === 'base64' && typeof source.data === 'string')
    images.push({
      data: source.data,
      ...(typeof source.media_type === 'string' ? { media_type: source.media_type } : {}),
      param,
    });
  else if (source.type === 'url' && typeof source.url === 'string')
    images.push(byUrl(source.url, param));
  else if (source.type === 'file' && typeof source.file_id === 'string')
    images.push({ file_id: source.file_id, param });
  else return undefined;
  return marker(images);
}

/**
 * Gemini `inlineData` (any image/* type) and `fileData` whose `mimeType` is image/* (an
 * `oaa://files/<id>` reference or an https URL). Other `fileData` stays a plain attachment.
 */
export function geminiImage(part: Part, param: string, images: ImageInput[]): string | undefined {
  const inline = part.inlineData as Part | undefined;
  if (inline && typeof inline === 'object') {
    const mime = typeof inline.mimeType === 'string' ? inline.mimeType : '';
    if (!mime.toLowerCase().startsWith('image/') || typeof inline.data !== 'string')
      throw imageFault(
        param,
        `inlineData of type "${mime.slice(0, 80)}" is not supported; only images (PNG, JPEG, GIF, WebP) are.`,
      );
    images.push({ data: inline.data, media_type: mime, param });
    return marker(images);
  }
  const file = part.fileData as Part | undefined;
  const uri = typeof file?.fileUri === 'string' ? file.fileUri : '';
  const mime = typeof file?.mimeType === 'string' ? file.mimeType.toLowerCase() : '';
  if (!uri || !mime.startsWith('image/')) return undefined;
  if (uri.startsWith('oaa://files/'))
    images.push({ file_id: uri.slice('oaa://files/'.length), param });
  else if (/^https:\/\//i.test(uri)) images.push({ url: uri, param });
  else if (/^file[-_]/.test(uri)) images.push({ file_id: uri, param });
  else return undefined;
  return marker(images);
}

/** UAP / OAA native `image` / `input_image` blocks: exactly one of file_id, data, url. */
export function nativeImage(
  block: { file_id?: string; data?: string; media_type?: string; url?: string },
  param: string,
  images: ImageInput[],
): string {
  if (block.file_id) images.push({ file_id: block.file_id, param });
  else if (block.data !== undefined)
    images.push({
      data: block.data,
      ...(block.media_type ? { media_type: block.media_type } : {}),
      param,
    });
  else if (block.url) images.push(byUrl(block.url, param));
  else throw imageFault(param, 'image blocks need file_id, data or url.', 'image_invalid');
  return marker(images);
}
