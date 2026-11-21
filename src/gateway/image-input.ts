/**
 * Image inputs before submission (docs/images.md): inline base64 is decoded, its real format is
 * sniffed (PNG, JPEG, GIF, WebP) and compared with the declared type, sizes are checked against
 * `images.*` limits, and the bytes become an input file of the caller (the same file store, access
 * control and `maxStoredBytesPerSubject` quota as `POST /v1/files`). Identical bytes the caller
 * already stored are reused, so a client that resends its history does not store an image twice.
 * File references are checked to be visible to the caller and to be images. URLs stay URLs
 * (only a URL-capable kernel route accepts them) unless the owner enabled `images.fetchRemote`.
 * The returned invocation holds only `{file_id, mime}` / `{url}`: no image bytes go further.
 */
import type { GatewayConfig } from '../config/config.js';
import { principalSubject, visibleSubject, type Principal } from '../core/contracts.js';
import { sha } from '../core/util.js';
import type { ImageInput, Invocation } from '../kernel/invocation.js';
import type { Store } from '../store/store.js';
import { checkImageUrl, fetchImage, type ImageTransport } from './image-fetch.js';
import { imageFault } from './image-parts.js';
import { IMAGE_EXT, normalizeImageType, sniffImage, type ImageType } from './image-sniff.js';
import { assertUploadRoom } from './upload-quota.js';
import { storedUploadCopy, type UploadPolicy } from '../store/upload-budget.js';
import { stageImage, stagingCopy } from './image-staging.js';
export { acceptsImages } from './image-catalog.js';

const heldBy = new WeakMap<Invocation, string[]>();
export function releaseImageInputs(store: Store, invocation: Invocation) {
  const ids = heldBy.get(invocation);
  if (ids) {
    heldBy.delete(invocation);
    return store.provisionalInputs.release(ids);
  }
  return undefined;
}

type Limits = GatewayConfig['images'];
type Decoded = { bytes: Buffer; mime: ImageType; param: string };
export type StoredImage =
  { file_id: string; mime: string; param: string } | { url: string; param: string };

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
const tooLarge = (param: string, what: string) => imageFault(param, what, 'image_too_large');

/** Decode one inline image: length first (no decoding of oversized data), then format checks. */
export function decodeImageData(
  data: string,
  declared: string | undefined,
  param: string,
  limits: Pick<Limits, 'maxImageBytes'>,
): Decoded {
  if (data.length > Math.ceil(limits.maxImageBytes / 3) * 4 + 4)
    throw tooLarge(param, `the image exceeds the ${limits.maxImageBytes}-byte limit per image.`);
  // Standard or URL-safe alphabet, padding optional (google-genai sends URL-safe base64).
  if (!data.length || data.length % 4 === 1 || !BASE64.test(data))
    throw imageFault(param, 'the image data is not valid base64.', 'image_invalid');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > limits.maxImageBytes)
    throw tooLarge(param, `the image exceeds the ${limits.maxImageBytes}-byte limit per image.`);
  const mime = sniffImage(bytes);
  if (!mime)
    throw imageFault(param, 'the data is not a PNG, JPEG, GIF or WebP image.', 'image_invalid');
  if (declared) {
    const named = normalizeImageType(declared);
    if (!named)
      throw imageFault(
        param,
        `media type "${declared.slice(0, 80)}" is not supported; send PNG, JPEG, GIF or WebP.`,
        'image_invalid',
      );
    if (named !== mime)
      throw imageFault(
        param,
        `the declared media type ${named} does not match the image content (${mime}).`,
        'image_invalid',
      );
  }
  return { bytes, mime, param };
}

type InputConfig = Pick<GatewayConfig, 'images' | 'maxStoredBytesPerSubject' | 'security'>;
export async function materializeImages(
  store: Store,
  config: InputConfig,
  principal: Principal,
  invocation: Invocation,
  transport?: ImageTransport,
  guard?: () => void,
): Promise<Invocation> {
  const images = invocation.images;
  if (!images?.length) return invocation;
  const held: string[] = [];
  try {
    const result = await prepareImages(store, config, principal, images, held, transport, guard);
    const materialized = { ...invocation, images: result };
    if (held.length) heldBy.set(materialized, held);
    return materialized;
  } catch (error) {
    await store.provisionalInputs.release(held);
    throw error;
  }
}
async function prepareImages(
  store: Store,
  config: InputConfig,
  principal: Principal,
  images: ImageInput[],
  held: string[],
  transport?: ImageTransport,
  guard?: () => void,
) {
  const limits = config.images;
  const paramOf = (image: ImageInput, i: number) => image.param ?? `images.${i}`;
  if (images.length > limits.maxImagesPerRequest)
    throw imageFault(
      paramOf(images[limits.maxImagesPerRequest]!, limits.maxImagesPerRequest),
      `at most ${limits.maxImagesPerRequest} images are accepted per request.`,
      'too_many_images',
    );
  const out: (StoredImage | Decoded)[] = [];
  let total = 0;
  for (const [i, image] of images.entries()) {
    const param = paramOf(image, i);
    if ('data' in image) {
      const decoded = decodeImageData(image.data, image.media_type, param, limits);
      total += decoded.bytes.length;
      out.push(decoded);
    } else if ('url' in image) {
      if (!limits.fetchRemote) {
        checkImageUrl(image.url, { profile: 'local' }, param);
        out.push({ url: image.url, param });
        continue;
      }
      const policy = {
        profile: config.security.profile,
        maxBytes: limits.maxImageBytes,
        timeoutMs: limits.fetchTimeoutMs,
      };
      const fetched = await fetchImage(image.url, policy, param, transport);
      total += fetched.bytes.length;
      out.push({ ...fetched, param });
    } else {
      const file = store.file(image.file_id, principal.owner, visibleSubject(principal));
      held.push(...store.provisionalInputs.hold(principal.owner, [file.id]));
      if (file.bytes > limits.maxImageBytes)
        throw tooLarge(
          param,
          `the image exceeds the ${limits.maxImageBytes}-byte limit per image.`,
        );
      const payload = await store.filePayload(file.id, principal.owner, visibleSubject(principal));
      const mime = sniffImage(Buffer.from(payload.content.slice(0, 32), 'base64'));
      if (!mime)
        throw imageFault(
          param,
          `file ${file.id} is not a PNG, JPEG, GIF or WebP image.`,
          'image_invalid',
        );
      total += file.bytes;
      out.push({ file_id: file.id, mime, param });
    }
    if (total > limits.maxTotalBytes)
      throw tooLarge(
        param,
        `the images of one request exceed ${limits.maxTotalBytes} bytes in total.`,
      );
  }
  // Quota for the bytes that will be newly written, checked once before anything is stored.
  const subject = principalSubject(principal),
    owner = principal.owner;
  const policy: UploadPolicy = { kind: 'inline', limit: config.maxStoredBytesPerSubject, guard };
  const costs = new Map<string, number>(),
    digests = new Map<Decoded, string>();
  for (const item of out)
    if ('bytes' in item) {
      const digest = sha(item.bytes);
      digests.set(item, digest);
      if (!costs.has(digest))
        costs.set(
          digest,
          stagingCopy(store, owner, subject, digest) ||
            storedUploadCopy(store, owner, subject, digest, item.bytes.length)
            ? 0
            : item.bytes.length,
        );
    }
  assertUploadRoom(
    store,
    config,
    principal,
    [...costs.values()].reduce((sum, n) => sum + n, 0),
  );
  const ids = new Map<string, string>();
  const result: StoredImage[] = [];
  for (const [i, item] of out.entries()) {
    if (!('bytes' in item)) {
      result.push(item);
      continue;
    }
    const digest = digests.get(item)!;
    let fileId =
      ids.get(digest) ?? storedUploadCopy(store, owner, subject, digest, item.bytes.length);
    if (!fileId) {
      fileId = await stageImage(
        store,
        owner,
        subject,
        digest,
        `image-${i + 1}.${IMAGE_EXT[item.mime]}`,
        item.bytes,
        policy,
        held,
      );
    } else held.push(...store.provisionalInputs.hold(owner, [fileId]));
    ids.set(digest, fileId);
    result.push({ file_id: fileId, mime: item.mime, param: item.param });
  }
  return result;
}
