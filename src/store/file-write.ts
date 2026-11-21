import path from 'node:path';
import { writePrivate } from '../core/util.js';
import {
  trackStagingBlob,
  type ArtifactStoreLike,
  type StoredArtifactRecord,
} from './large-artifacts.js';
import type { ProvisionalInputs } from './provisional-inputs.js';

export async function writeFileRecord(
  store: ArtifactStoreLike & { provisionalInputs: ProvisionalInputs },
  file: StoredArtifactRecord,
  subject: string,
  bytes: Buffer,
  origin?: 'inline',
) {
  const unpin = trackStagingBlob(store.db, file.id);
  const insert = () =>
    store
      .prepare('INSERT INTO files(id,owner,payload,subject) VALUES(?,?,?,?)')
      .run(file.id, file.owner, JSON.stringify(file), subject);
  try {
    if (origin === 'inline') await store.provisionalInputs.write(file, subject, bytes, insert);
    else {
      await writePrivate(path.join(store.root, 'files'), file.id, bytes, true);
      insert();
    }
  } finally {
    unpin();
  }
}
