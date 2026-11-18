import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import type { ArtifactPayload, WorkResult } from '../core/contracts.js';
import { LIMITS } from '../core/limits.js';
import { Fault, checkAbort } from '../core/util.js';
import {
  attachReceivedArtifact,
  getArtifactByteLimit,
  stageArtifact,
  type ArtifactStoreLike,
} from '../store/large-artifacts.js';
import { withSavepoint } from '../store/savepoint.js';
import { ARTIFACT_CHUNK_BYTES, type ArtifactChunk } from './node-messages.js';

type WireArtifact = ArtifactPayload & { transferIndex?: number };
type Chunk = Omit<ArtifactChunk, 'type' | 'id' | 'leaseId'>;
const bad = () =>
  new Fault(
    'artifact_integrity',
    'The transferred artifact does not match the dispatch manifest.',
    502,
    true,
  );

/** The file path stays on its originating worker. Only one bounded chunk per job is in flight. */
export async function sendArtifacts(
  result: WorkResult,
  supported: boolean,
  signal: AbortSignal,
  send: (chunk: Chunk) => Promise<void>,
): Promise<WorkResult> {
  if (!('artifacts' in result) || !result.artifacts?.length) return result;
  // Several small inline files can collectively exceed a result frame as well.
  const streamInline =
    supported &&
    result.artifacts.reduce((n, a) => n + a.content.length, 0) > LIMITS.nodeMessageBytes / 2;
  if (!streamInline && !result.artifacts.some((a) => a.localPath)) return result;
  if (!supported)
    throw new Fault(
      'capability_unavailable',
      'This gateway does not support streamed worker artifacts.',
      503,
      true,
    );
  const artifacts: WireArtifact[] = [];
  for (const [index, artifact] of result.artifacts.entries()) {
    if (!artifact.localPath) {
      if (!streamInline || !artifact.content.length) {
        artifacts.push(artifact);
        continue;
      }
      const data = Buffer.from(artifact.content, 'base64');
      if (index >= 100 || !data.length || data.length > LIMITS.maxArtifactExportBytes) throw bad();
      const { name, sha256 } = artifact,
        bytes = data.length;
      for (let offset = 0; offset < bytes; offset += ARTIFACT_CHUNK_BYTES) {
        checkAbort(signal);
        await send({
          index,
          offset,
          name,
          sha256,
          bytes,
          data: data.subarray(offset, offset + ARTIFACT_CHUNK_BYTES).toString('base64'),
        });
      }
      artifacts.push({ name, sha256, bytes, content: '', transferIndex: index });
      continue;
    }
    const { name, sha256, bytes } = artifact;
    if (!bytes || bytes > LIMITS.maxArtifactExportBytes || index >= 100) throw bad();
    const input = await open(artifact.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.size !== bytes) throw bad();
      const buffer = Buffer.allocUnsafe(Math.min(ARTIFACT_CHUNK_BYTES, bytes));
      let offset = 0;
      while (offset < bytes) {
        checkAbort(signal);
        const { bytesRead } = await input.read(
          buffer,
          0,
          Math.min(buffer.length, bytes - offset),
          offset,
        );
        if (!bytesRead) throw bad();
        await send({
          index,
          offset,
          name,
          sha256,
          bytes,
          data: buffer.subarray(0, bytesRead).toString('base64'),
        });
        offset += bytesRead;
      }
    } finally {
      await input.close();
    }
    artifacts.push({ name, sha256, bytes, content: '', transferIndex: index });
  }
  return { ...result, artifacts };
}

type Staged = Awaited<ReturnType<typeof stageArtifact>>;
type Incoming = {
  name: string;
  sha256: string;
  bytes: number;
  offset: number;
  stream: PassThrough;
  staging: Promise<Staged>;
  ready?: Staged;
};

/** Private blobs are not visible through the API until the final RPC result is validated. */
export class IncomingArtifacts {
  private files = new Map<number, Incoming>();
  private busy = false;
  private closed = false;
  private reserved = 0;
  constructor(
    private store: ArtifactStoreLike,
    private owner: string,
    private runId: string,
    private allowedNodes?: string[],
  ) {}
  async accept(chunk: ArtifactChunk): Promise<void> {
    if (this.closed || this.busy) throw bad();
    this.busy = true;
    try {
      const data = Buffer.from(chunk.data, 'base64');
      if (
        !data.length ||
        data.length > ARTIFACT_CHUNK_BYTES ||
        data.toString('base64') !== chunk.data ||
        chunk.offset + data.length > chunk.bytes
      )
        throw bad();
      let file = this.files.get(chunk.index);
      if (!file) {
        if (chunk.offset || this.files.size >= 100) throw bad();
        if (this.reserved + chunk.bytes > getArtifactByteLimit(this.store))
          throw new Fault(
            'artifacts_too_large',
            'Worker outputs exceed the gateway artifact limit.',
            413,
            true,
          );
        this.reserved += chunk.bytes;
        const stream = new PassThrough({ highWaterMark: ARTIFACT_CHUNK_BYTES });
        stream.on('error', () => {});
        const staging = stageArtifact(this.store, {
          owner: this.owner,
          runId: this.runId,
          allowedNodes: this.allowedNodes,
          name: chunk.name,
          expectedSha256: chunk.sha256,
          maxBytes: chunk.bytes,
          stream,
        });
        void staging.catch((error) => stream.destroy(error));
        file = {
          name: chunk.name,
          sha256: chunk.sha256,
          bytes: chunk.bytes,
          offset: 0,
          stream,
          staging,
        };
        this.files.set(chunk.index, file);
      }
      if (
        file.offset !== chunk.offset ||
        file.bytes !== chunk.bytes ||
        file.sha256 !== chunk.sha256 ||
        file.name !== chunk.name
      )
        throw bad();
      file.offset += data.length;
      if (file.offset === file.bytes) {
        file.stream.end(data);
        file.ready = await file.staging;
      } else {
        const stream = file.stream;
        await new Promise<void>((resolve, reject) => {
          stream.once('error', reject);
          stream.write(data, (error) => {
            stream.off('error', reject);
            if (error) reject(error);
            else resolve();
          });
        });
      }
    } finally {
      this.busy = false;
    }
  }
  finish(result: unknown) {
    const artifacts = (result as { artifacts?: WireArtifact[] } | undefined)?.artifacts ?? [];
    const items: { payload: WireArtifact; staged: Staged }[] = [];
    let total = this.reserved;
    for (const [index, payload] of artifacts.entries()) {
      if (payload.transferIndex === undefined) {
        total += Buffer.byteLength(payload.content, 'base64');
        continue;
      }
      const staged = this.files.get(index)?.ready;
      if (
        this.closed ||
        this.busy ||
        !staged ||
        payload.transferIndex !== index ||
        payload.content !== '' ||
        payload.name !== staged.record.name ||
        payload.sha256 !== staged.record.sha256 ||
        payload.bytes !== staged.record.bytes
      )
        throw bad();
      items.push({ payload, staged });
    }
    if (items.length !== this.files.size) throw bad();
    if (items.length && total > getArtifactByteLimit(this.store))
      throw new Fault(
        'artifacts_too_large',
        'Worker outputs exceed the gateway artifact limit.',
        413,
        true,
      );
    if (items.length) {
      withSavepoint(this.store.db, () => {
        for (const { staged } of items) staged.commit();
      });
      for (const { payload, staged } of items)
        attachReceivedArtifact(this.store, payload, staged.record);
    }
    this.closed = true;
    this.files.clear();
  }
  async discard() {
    this.closed = true;
    const remaining = [...this.files.values()];
    this.files.clear();
    for (const f of remaining) f.stream.destroy(new Error('Artifact transfer closed.'));
    await Promise.allSettled(remaining.map(async (f) => (await f.staging).discard()));
  }
}
