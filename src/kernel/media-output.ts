import type { Run } from '../core/contracts.js';
import { artifactMedia } from '../core/media.js';
import { Fault } from '../core/util.js';
import type { Store } from '../store/store.js';

export async function validateMediaOutput(store: Store, run: Run) {
  if (!run.checkpoint.media || run.checkpoint.orchestration?.recommendation) return;
  const expected = run.checkpoint.media;
  const previous = run.previousId ? store.run(run.previousId, run.owner).artifactIds : [];
  for (const id of run.artifactIds.filter((id) => !previous.includes(id))) {
    const file = await store.filePayload(id, run.owner);
    const actual = artifactMedia(file.name, Buffer.from(file.content, 'base64'));
    if (actual?.kind === expected.kind && actual.mime === expected.mime) {
      run.metadata['oaa.media_validation'] = 'signature_only';
      return;
    }
  }
  throw new Fault(
    'output_contract',
    'No new artifact matched the requested media format signature. No media success was claimed.',
    422,
  );
}
