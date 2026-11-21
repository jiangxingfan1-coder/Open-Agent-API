import path from 'node:path';
import { writePrivate } from '../core/util.js';
import {
  trackStagingBlob,
  type ArtifactStoreLike,
  type StoredArtifactRecord,
} from './large-artifacts.js';
import type { ProvisionalInputs } from './provisional-inputs.js';
import type { UploadPolicy } from './upload-budget.js';

export async function writeFileRecord(
  store: ArtifactStoreLike & { provisionalInputs: ProvisionalInputs },
  file: StoredArtifactRecord,
  subject: string,
  bytes: Buffer,
  origin?: 'inline' | UploadPolicy,
) {
  const unpin = trackStagingBlob(store.db, file.id);
  const insert = () =>
    store
      .prepare('INSERT INTO files(id,owner,payload,subject) VALUES(?,?,?,?)')
      .run(file.id, file.owner, JSON.stringify(file), subject);
  try {
    if (origin)
      await store.provisionalInputs.write(
        file,
        subject,
        bytes,
        insert,
        origin === 'inline' ? { kind: 'inline' } : origin,
      );
    else {
      await writePrivate(path.join(store.root, 'files'), file.id, bytes, true);
      insert();
    }
  } finally {
    unpin();
  }
}
