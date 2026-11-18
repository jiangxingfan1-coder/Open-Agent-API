import { createHash } from 'node:crypto';
import { constants, type ReadStream } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { LEGACY_SUBJECT, type ArtifactPayload } from '../core/contracts.js';
import { LIMITS } from '../core/limits.js';
import { artifactMedia, type MediaKind } from '../core/media.js';
import { Fault, id, relativeName, safePath } from '../core/util.js';
import { restrictToOwner } from '../core/win-acl.js';

export type ArtifactStoreLike = {
  readonly root: string;
  readonly db: DatabaseSync;
  prepare(sql: string): StatementSync;
};

export type StoredArtifactRecord = {
  id: string;
  owner: string;
  name: string;
  sha256: string;
  bytes: number;
  createdAt: number;
  allowedNodes?: string[];
  runId?: string;
};

const CHUNK_BYTES = 65_536;
const storeLimits = new WeakMap<DatabaseSync, number>();
const liveBlobs = new WeakMap<DatabaseSync, Set<string>>();
export function isStagingArtifact(db: DatabaseSync, fileId: string): boolean {
  return liveBlobs.get(db)?.has(fileId) ?? false;
}

export function setArtifactByteLimit(store: ArtifactStoreLike, maxBytes?: number): void {
  if (maxBytes === undefined) {
    storeLimits.delete(store.db);
    return;
  }
  const clamped = Math.max(1024, Math.min(LIMITS.maxArtifactExportBytes, Math.trunc(maxBytes)));
  storeLimits.set(store.db, clamped);
}

export function getArtifactByteLimit(store: ArtifactStoreLike): number {
  return storeLimits.get(store.db) ?? LIMITS.artifactExportBytes;
}

async function writeChunkAt(handle: FileHandle, chunk: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw new Fault('persistence_failed', 'Short write on artifact.', 500);
    offset += bytesWritten;
  }
}

/**
 * Stream-hash a regular file without loading its entire content into memory or Base64-encoding it.
 * Rejects symlinks, non-regular files, and files exceeding `maxBytes`.
 */
export async function hashFileStreaming(
  filePath: string,
  maxBytes: number,
): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Fault('invalid_file', 'Artifact path is not a regular file.', 400);
    if (stat.size > maxBytes)
      throw new Fault('artifacts_too_large', 'Native output export exceeds its limit.', 413);
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes)
        throw new Fault('artifacts_too_large', 'Native output export exceeds its limit.', 413);
      hash.update(buf.subarray(0, bytesRead));
    }
    return { sha256: hash.digest('hex'), bytes: total };
  } finally {
    await handle.close();
  }
}

type ArtifactSource = {
  owner: string;
  name: string;
  runId?: string;
  subject?: string;
  allowedNodes?: string[];
  sourcePath?: string;
  stream?: Readable;
  bytes?: Buffer;
  expectedSha256?: string;
  maxBytes?: number;
};
export async function stageArtifact(store: ArtifactStoreLike, params: ArtifactSource) {
  relativeName(params.name);
  const limit = params.maxBytes ?? (params.runId ? getArtifactByteLimit(store) : LIMITS.fileBytes);
  const tooLargeFault = () =>
    params.runId
      ? new Fault('artifacts_too_large', 'Native output export exceeds its limit.', 413)
      : new Fault('file_too_large', 'File exceeds 8 MiB.', 413);

  if (params.bytes && params.bytes.length > limit) throw tooLargeFault();

  const fileSubject = params.runId
    ? String(
        store.prepare('SELECT subject FROM runs WHERE id=?').get(params.runId)?.subject ??
          LEGACY_SUBJECT,
      )
    : (params.subject ?? LEGACY_SUBJECT);
  const fileId = id(params.runId ? 'artifact' : 'file');
  const filesRoot = path.join(store.root, 'files');
  const target = await safePath(filesRoot, fileId, true);
  const out = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_EXCL,
    0o600,
  );
  const hash = createHash('sha256');
  let total = 0;
  let succeeded = false;
  let active = liveBlobs.get(store.db);
  if (!active) liveBlobs.set(store.db, (active = new Set()));
  active.add(fileId);
  try {
    if (params.sourcePath) {
      const src = await open(params.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await src.stat();
        if (!stat.isFile())
          throw new Fault('invalid_file', 'Artifact path is not a regular file.', 400);
        if (stat.size > limit) throw tooLargeFault();
        const buf = Buffer.allocUnsafe(CHUNK_BYTES);
        while (true) {
          const { bytesRead } = await src.read(buf, 0, buf.length, total);
          if (bytesRead === 0) break;
          const pos = total;
          total += bytesRead;
          if (total > limit) throw tooLargeFault();
          const slice = buf.subarray(0, bytesRead);
          hash.update(slice);
          await writeChunkAt(out, slice, pos);
        }
      } finally {
        await src.close();
      }
    } else if (params.stream) {
      for await (const rawChunk of params.stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        const pos = total;
        total += chunk.length;
        if (total > limit) throw tooLargeFault();
        hash.update(chunk);
        await writeChunkAt(out, chunk, pos);
      }
    } else if (params.bytes) {
      total = params.bytes.length;
      for (let offset = 0; offset < total; offset += CHUNK_BYTES) {
        const slice = params.bytes.subarray(offset, offset + CHUNK_BYTES);
        hash.update(slice);
        await writeChunkAt(out, slice, offset);
      }
    } else {
      throw new Fault('invalid_file', 'Missing artifact source.', 400);
    }
    const digest = hash.digest('hex');
    if (params.expectedSha256 && digest !== params.expectedSha256)
      throw new Fault('artifact_integrity', 'Artifact digest does not match.', 502);

    await out.close();
    if (process.platform === 'win32') await restrictToOwner(target);

    const record: StoredArtifactRecord = {
      id: fileId,
      owner: params.owner,
      name: params.name,
      sha256: digest,
      bytes: total,
      createdAt: Date.now(),
      allowedNodes: params.allowedNodes,
      runId: params.runId,
    };
    succeeded = true;
    return {
      record,
      commit() {
        store
          .prepare('INSERT INTO files(id,owner,payload,subject) VALUES(?,?,?,?)')
          .run(record.id, params.owner, JSON.stringify(record), fileSubject);
        active.delete(fileId);
        return record;
      },
      async discard() {
        try {
          await unlink(target);
        } finally {
          active.delete(fileId);
        }
      },
    };
  } finally {
    if (!succeeded) {
      active.delete(fileId);
      await out.close().catch(() => {});
      await unlink(target).catch(() => {});
    }
  }
}

export async function storeArtifactStreamOrPath(store: ArtifactStoreLike, params: ArtifactSource) {
  const staged = await stageArtifact(store, params);
  try {
    return staged.commit();
  } catch (error) {
    await staged.discard();
    throw error;
  }
}

// Only the gateway's completed, lease-bound transfer can attach a stored record to a result.
const receipts = new WeakMap<ArtifactPayload, { db: DatabaseSync; file: StoredArtifactRecord }>();
export function attachReceivedArtifact(
  store: ArtifactStoreLike,
  payload: ArtifactPayload,
  file: StoredArtifactRecord,
) {
  receipts.set(payload, { db: store.db, file });
}

/** Persist a worker-reported `ArtifactPayload` (either local file reference or inline Base64). */
export async function persistWorkerArtifact(
  store: ArtifactStoreLike & {
    addFile(
      owner: string,
      name: string,
      bytes: Buffer,
      allowedNodes?: string[],
      runId?: string,
      subject?: string,
    ): Promise<StoredArtifactRecord>;
  },
  owner: string,
  runId: string,
  artifact: ArtifactPayload,
  allowedNodes?: string[],
): Promise<StoredArtifactRecord> {
  const receipt = receipts.get(artifact);
  if (receipt) {
    const { file } = receipt;
    if (
      receipt.db !== store.db ||
      file.owner !== owner ||
      file.runId !== runId ||
      JSON.stringify(file.allowedNodes) !== JSON.stringify(allowedNodes)
    )
      throw new Fault(
        'artifact_integrity',
        'Artifact receipt does not belong to this dispatch.',
        502,
      );
    return file;
  }
  if (artifact.localPath) {
    return storeArtifactStreamOrPath(store, {
      owner,
      name: artifact.name,
      runId,
      allowedNodes,
      sourcePath: artifact.localPath,
      expectedSha256: artifact.sha256,
    });
  }
  const bytes = Buffer.from(artifact.content, 'base64');
  if (bytes.length <= LIMITS.fileBytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== artifact.sha256)
      throw new Fault('artifact_integrity', 'Artifact digest does not match.', 502);
    return store.addFile(owner, artifact.name, bytes, allowedNodes, runId);
  }
  return storeArtifactStreamOrPath(store, {
    owner,
    name: artifact.name,
    runId,
    allowedNodes,
    bytes,
    expectedSha256: artifact.sha256,
  });
}

/**
 * Verify a stored file's SHA-256 in 64 KiB chunks on an opened `O_NOFOLLOW` descriptor, then
 * return a `ReadStream` owned by `FileHandle.createReadStream` (no Base64 heap spikes, no TOCTOU).
 */
export async function openVerifiedFileStream(
  store: ArtifactStoreLike,
  file: StoredArtifactRecord,
): Promise<{ stream: ReadStream; bytes: number }> {
  const target = await safePath(path.join(store.root, 'files'), file.id);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let transferredToStream = false;
  try {
    const stat = await handle.stat();
    const maxAllowed = file.runId ? LIMITS.maxArtifactExportBytes : LIMITS.fileBytes;
    if (!stat.isFile() || stat.size > maxAllowed)
      throw new Fault('invalid_file', 'Not a regular file, or file exceeds size limit.', 413);
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      hash.update(buf.subarray(0, bytesRead));
    }
    if (hash.digest('hex') !== file.sha256)
      throw new Fault('file_integrity', 'File content has changed.', 500);
    const stream = handle.createReadStream({ start: 0, autoClose: true });
    transferredToStream = true;
    return { stream, bytes: offset };
  } finally {
    if (!transferredToStream) await handle.close().catch(() => {});
  }
}

/**
 * Inspect media magic signatures without loading multi-megabyte binary deliverables into a Base64 string.
 */
export async function sniffStoredArtifactMedia(
  store: ArtifactStoreLike,
  file: StoredArtifactRecord,
): Promise<{ kind: MediaKind; mime: string } | undefined> {
  const target = await safePath(path.join(store.root, 'files'), file.id);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Fault('invalid_file', 'Not a regular file, or file exceeds size limit.', 413);
    const ext = file.name.split('.').at(-1)?.toLowerCase();
    const needsFullScan =
      (ext === 'docx' || ext === 'md' || ext === 'txt') && stat.size <= LIMITS.fileBytes;
    const headCap = needsFullScan ? stat.size : Math.min(stat.size, CHUNK_BYTES);
    const head = Buffer.allocUnsafe(headCap);
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    let headFilled = 0;
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      if (headFilled < headCap) {
        const copyLen = Math.min(headCap - headFilled, bytesRead);
        buf.copy(head, headFilled, 0, copyLen);
        headFilled += copyLen;
      }
      offset += bytesRead;
    }
    if (hash.digest('hex') !== file.sha256)
      throw new Fault('file_integrity', 'File content has changed.', 500);
    return artifactMedia(file.name, head.subarray(0, headFilled));
  } finally {
    await handle.close();
  }
}
