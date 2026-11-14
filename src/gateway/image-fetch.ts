/**
 * Gateway-side fetch of an https image URL (docs/images.md), only when the owner turned on
 * `images.fetchRemote`. Rules: https only, no credentials in the URL, no redirects followed, a
 * deadline for the whole request, a byte cap enforced while reading, an image content type that
 * matches the sniffed format, and — under the `public` security profile — no private, loopback,
 * link-local or metadata address (the webhook address rule, checked on the connected address).
 */
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { checkTarget, type TargetPolicy } from './webhook-core.js';
import { checkedLookup } from './checked-lookup.js';
import { imageFault } from './image-parts.js';
import { normalizeImageType, sniffImage, type ImageType } from './image-sniff.js';

export type FetchPolicy = {
  profile: 'local' | 'public';
  maxBytes: number;
  timeoutMs: number;
};
/** The one call made on the network; tests replace it. */
export type ImageTransport = typeof https.request;

const failed = (param: string, why: string) =>
  imageFault(
    param,
    `the image URL could not be fetched by the gateway: ${why} Send the image inline (base64) or upload it with POST /v1/files.`,
    'image_fetch_failed',
  );

/** Validate a URL before any connection: https, no userinfo, address rule on a literal host. */
export function checkImageUrl(
  raw: string,
  policy: Pick<FetchPolicy, 'profile'>,
  param: string,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw imageFault(param, 'the image URL is not a valid absolute URL.', 'image_invalid');
  }
  if (url.protocol !== 'https:')
    throw imageFault(param, 'image URLs must use https (or a data: URL).', 'image_invalid');
  if (url.username || url.password)
    throw imageFault(param, 'image URLs must not contain credentials.', 'image_invalid');
  try {
    checkTarget(url.hostname, targetPolicy(policy));
  } catch {
    throw failed(param, 'the host is a private, loopback, link-local or metadata address.');
  }
  return url;
}

const targetPolicy = (p: Pick<FetchPolicy, 'profile'>): TargetPolicy => ({
  profile: p.profile,
  allowInsecureHttp: false,
  allowPrivateNetwork: false,
});

/** Check a finished answer: 200, an accepted image content type, and the same sniffed format. */
export function checkFetchedImage(
  status: number,
  headers: IncomingHttpHeaders,
  bytes: Buffer,
  param: string,
): { bytes: Buffer; mime: ImageType } {
  if (status >= 300 && status < 400)
    throw failed(param, `redirects are not followed (HTTP ${status}).`);
  if (status !== 200) throw failed(param, `the server answered HTTP ${status}.`);
  const declared = normalizeImageType(String(headers['content-type'] ?? '').split(';')[0]!);
  if (!declared) throw failed(param, 'the response is not a PNG, JPEG, GIF or WebP image.');
  const actual = sniffImage(bytes);
  if (actual !== declared)
    throw failed(param, 'the response content does not match its declared image type.');
  return { bytes, mime: actual };
}

export function fetchImage(
  raw: string,
  policy: FetchPolicy,
  param: string,
  transport: ImageTransport = https.request,
): Promise<{ bytes: Buffer; mime: ImageType }> {
  const url = checkImageUrl(raw, policy, param);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error: unknown, value?: { bytes: Buffer; mime: ImageType }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = transport(
      url,
      {
        method: 'GET',
        headers: { accept: 'image/png, image/jpeg, image/gif, image/webp' },
        lookup: checkedLookup(targetPolicy(policy)),
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          try {
            checkFetchedImage(status, res.headers, Buffer.alloc(0), param);
          } catch (error) {
            done(error);
          }
          return;
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > policy.maxBytes) {
          res.destroy();
          return done(tooLarge(param, policy.maxBytes));
        }
        const chunks: Buffer[] = [];
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > policy.maxBytes) {
            res.destroy();
            done(tooLarge(param, policy.maxBytes));
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            done(undefined, checkFetchedImage(status, res.headers, Buffer.concat(chunks), param));
          } catch (error) {
            done(error);
          }
        });
        res.on('error', () => done(failed(param, 'the connection failed.')));
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      done(failed(param, `no complete answer within ${policy.timeoutMs} ms.`));
    }, policy.timeoutMs);
    deadline.unref();
    req.on('error', (error: NodeJS.ErrnoException) =>
      done(
        error.code === 'webhook_target_denied' || /private, loopback/.test(error.message)
          ? failed(
              param,
              'the host resolves to a private, loopback, link-local or metadata address.',
            )
          : failed(param, 'the connection failed.'),
      ),
    );
    req.end();
  });
}

const tooLarge = (param: string, max: number) =>
  imageFault(param, `the image exceeds the ${max}-byte limit per image.`, 'image_too_large');
