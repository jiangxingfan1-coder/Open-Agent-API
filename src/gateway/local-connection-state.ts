import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Fault } from '../core/util.js';
import { readClientFile, replaceClientFile } from '../config/local-client-files.js';
import type { DshOwned } from '../config/dsh-client.js';
import { MAX_AGENT_MODELS } from '../core/model-catalog.js';
import { toolBoundarySchema, type ToolBoundary } from '../core/agent-access.js';

const providerSchema = z.object({
  displayName: z.string(),
  api: z.literal('openai-completions'),
  baseURL: z.string().url(),
  apiKeyEnv: z.string(),
  models: z
    .array(
      z.object({ id: z.string(), name: z.string(), input: z.array(z.enum(['text', 'image'])) }),
    )
    .min(1)
    .max(MAX_AGENT_MODELS + 4),
  retryPolicy: z.object({ mode: z.literal('normal'), maxRetries: z.literal(0) }),
});

const recordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{24}$/),
    owner: z.string().min(1),
    agent: z.string().min(1),
    model: z.string(),
    toolMode: toolBoundarySchema.default('managed'),
    dshHome: z.string(),
    baseUrl: z.string().url(),
    keyId: z.string(),
    phase: z.enum(['installing', 'active', 'syncing', 'removing', 'removed', 'conflict', 'failed']),
    sourceRevision: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    owned: z.object({
      providerId: z.string(),
      credentialRef: z.string(),
      provider: providerSchema,
      tokenHash: z.string(),
      createdSettings: z.boolean(),
      createdCredentials: z.boolean(),
    }),
    previousProvider: providerSchema.optional(),
    pendingSource: z
      .object({ model: z.string(), baseUrl: z.string(), sourceRevision: z.string() })
      .optional(),
  })
  .strict();
export type LocalConnectionRecord = {
  version: 1;
  id: string;
  owner: string;
  agent: string;
  model: string;
  toolMode: ToolBoundary;
  dshHome: string;
  baseUrl: string;
  keyId: string;
  phase: 'installing' | 'active' | 'syncing' | 'removing' | 'removed' | 'conflict' | 'failed';
  sourceRevision: string;
  createdAt: number;
  updatedAt: number;
  owned: DshOwned;
  previousProvider?: DshOwned['provider'];
  pendingSource?: { model: string; baseUrl: string; sourceRevision: string };
};

/** No plaintext token in connection metadata. Backups stay private and never enter API responses. */
export class LocalConnectionState {
  readonly directory: string;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'local-connections');
  }
  async list(): Promise<LocalConnectionRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.directory)).filter((f) => /^[a-f0-9]{24}\.json$/.test(f));
    if (files.length > 256)
      throw new Fault('local_connection_invalid', 'Too many local connection records.', 400);
    const rows: LocalConnectionRecord[] = [];
    for (const file of files) {
      const text = (await readClientFile(path.join(this.directory, file), true)).text;
      if (text === null || Buffer.byteLength(text) > 2_000_000)
        throw new Fault(
          'local_connection_invalid',
          'A local connection record exceeds its size bound.',
          400,
        );
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Fault(
          'local_connection_invalid',
          'A local connection record is invalid. Preserve it for recovery.',
          400,
        );
      }
      const parsed = recordSchema.safeParse(value);
      if (!parsed.success)
        throw new Fault(
          'local_connection_invalid',
          'A local connection record is invalid. Preserve it for recovery.',
          400,
        );
      if (
        file !== `${parsed.data.id}.json` ||
        parsed.data.owned.providerId !== `oaa-${parsed.data.id}` ||
        parsed.data.owned.credentialRef !== `OAA_DSH_${parsed.data.id.toUpperCase()}` ||
        parsed.data.owned.provider.apiKeyEnv !== parsed.data.owned.credentialRef
      )
        throw new Fault(
          'local_connection_invalid',
          'Local connection ownership markers are inconsistent.',
          400,
        );
      rows.push(parsed.data);
    }
    return rows;
  }
  async save(record: LocalConnectionRecord): Promise<void> {
    recordSchema.parse(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await replaceClientFile(
      await readClientFile(path.join(this.directory, `${record.id}.json`), true),
      JSON.stringify(record, null, 2) + '\n',
    );
  }
  backupDirectory(id: string): string {
    return path.join(this.directory, 'backups', id);
  }
}
