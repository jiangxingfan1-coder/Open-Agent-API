/**
 * Image inputs in the kernel (docs/images.md). The gateway has already stored inline images as
 * input files; here they become the run's `images`, decide placement (a worker must declare
 * image-input-v1 for the provider or engine; URLs only for URL-capable kernel providers) and
 * ride on the new user message as references. A refusal is `unsupported_content` with
 * `error.param` on the first image part and a message that says what to do instead.
 */
import type { AgentDefinition, ImageMode, ModelImage, Run, RunImage } from '../core/contracts.js';
import { ParamFault } from '../core/param-fault.js';
import { Fault } from '../core/util.js';
import type { Store } from '../store/store.js';
import type { Invocation } from './invocation.js';

/** The run's image list from a materialized invocation; stored images must be the caller's. */
export function runImages(
  store: Store,
  owner: string,
  subject: string | undefined,
  invocation: Pick<Invocation, 'images'>,
): RunImage[] {
  return (invocation.images ?? []).map((image, i) => {
    const param = image.param ?? `images.${i}`;
    if ('url' in image) return { kind: 'url', url: image.url, param };
    if ('data' in image || !image.mime)
      throw new Fault(
        'image_invalid',
        `${param}: the image was not validated by the gateway.`,
        400,
      );
    const file = store.file(image.file_id, owner, subject);
    return {
      kind: 'file',
      fileId: file.id,
      mime: image.mime,
      name: file.name,
      bytes: file.bytes,
      param,
    };
  });
}

/** What a worker must support: `url` when any image is a URL, else `inline`. */
export function imageDemand(
  images: readonly (RunImage | ModelImage)[] | undefined,
): ImageMode | undefined {
  if (!images?.length) return undefined;
  return images.some((i) => i.kind === 'url') ? 'url' : 'inline';
}

/** Images of every message a model turn will send (history included). */
export function messageImages(run: Pick<Run, 'checkpoint'>): ModelImage[] {
  return run.checkpoint.messages.flatMap((m) => m.images ?? []);
}

export function modelImages(images: readonly RunImage[]): ModelImage[] | undefined {
  if (!images.length) return undefined;
  return images.map((i) =>
    i.kind === 'url'
      ? { kind: 'url', url: i.url }
      : { kind: 'file', fileId: i.fileId, mime: i.mime },
  );
}

/**
 * Turn a failed placement into a clear refusal when images are the reason. `reasons` are the
 * placement reasons of the agent's primary route; other failures are left to the caller.
 */
export function assertImagesPlaced(
  agent: AgentDefinition,
  images: readonly RunImage[],
  reasons: readonly { code: string }[],
): void {
  if (!images.length || !reasons.some((r) => r.code === 'image_input_unsupported')) return;
  const url = images.find((i) => i.kind === 'url');
  const first = url ?? images[0]!;
  const kernel = agent.engine === 'kernel';
  const message = url
    ? kernel
      ? `${first.param}: no model route of agent "${agent.id}" fetches image URLs itself. Send the image inline (base64 / data: URL) or upload it with POST /v1/files and reference the file.`
      : `${first.param}: agent "${agent.id}" is an external agent and needs the image bytes; the gateway does not fetch image URLs for it. Send the image inline (base64 / data: URL) or upload it with POST /v1/files and reference the file.`
    : kernel
      ? `${first.param}: agent "${agent.id}" does not accept images: none of its model routes is declared image-capable (providers.<name>.imageInput). Send the request without images, or ask the owner to enable an image-capable route.`
      : `${first.param}: agent "${agent.id}" does not accept images (its engine cannot receive images, or no worker supports image-input-v1). Send the request without images, or use an agent that accepts them (see image_input in GET /v1/models).`;
  throw new ParamFault('unsupported_content', message, 400, first.param);
}
