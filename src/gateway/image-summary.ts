/**
 * The image inputs of a run as shown in the run state, the timeline and the console inspector
 * (docs/images.md): file id, name, type and size of stored images, only the host of a URL image
 * (a URL may carry a signed token). Never the bytes.
 */
import type { RunImage } from '../core/contracts.js';
import type { Store } from '../store/store.js';

export type ImageSummary =
  | { kind: 'file'; file_id: string; name: string; mime: string; bytes: number }
  | { kind: 'url'; host: string };

export function summarizeImages(images: readonly RunImage[] | undefined): ImageSummary[] {
  return (images ?? []).map((i) => {
    if (i.kind === 'file')
      return { kind: 'file', file_id: i.fileId, name: i.name, mime: i.mime, bytes: i.bytes };
    let host = '';
    try {
      host = new URL(i.url).host;
    } catch {
      // A URL is validated before the run exists; keep an empty host rather than failing.
    }
    return { kind: 'url', host };
  });
}

/** The image summary of one run, read from its stored payload without loading the whole run. */
export function runImageSummary(store: Store, runId: string): ImageSummary[] {
  const row = store.db
    .prepare("SELECT json_extract(payload,'$.images') AS images FROM runs WHERE id=?")
    .get(runId) as { images?: string | null } | undefined;
  if (!row?.images) return [];
  try {
    return summarizeImages(JSON.parse(row.images) as RunImage[]);
  } catch {
    return [];
  }
}
