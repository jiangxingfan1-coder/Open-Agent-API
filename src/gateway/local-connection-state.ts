import { lstat, mkdir, mkdtemp, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Fault } from '../core/util.js';
import {
  clientInvalid,
  jsonMap,
  readClientFile,
  replaceClientFile,
  type ClientFile,
} from '../config/local-client-files.js';
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

const phaseSchema = z.enum([
  'installing',
  'active',
  'syncing',
  'removing',
  'removed',
  'conflict',
  'failed',
]);

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
    phase: phaseSchema,
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

export const extendedTargetSchema = z.enum([
  'opencode',
  'codex',
  'claude-desktop',
  'cursor',
  'windsurf',
  'claude-code',
]);
export type ExtendedTargetId = z.infer<typeof extendedTargetSchema>;

export type ManagedOwned = {
  entryId: string;
  entryHash: string;
  tokenHash: string;
  createdConfig: boolean;
  modelCount: number;
  primaryModel?: string;
  keyFile: string;
};

const managedRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{24}$/),
    target: extendedTargetSchema,
    channel: z.enum(['api', 'mcp']),
    owner: z.string().min(1),
    agent: z.string().min(1),
    model: z.string(),
    toolMode: toolBoundarySchema.default('managed'),
    execution: z.enum(['workspace', 'host']).default('workspace'),
    configFile: z.string().min(1),
    baseUrl: z.string().url(),
    keyId: z.string(),
    phase: phaseSchema,
    sourceRevision: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    owned: z
      .object({
        entryId: z.string().min(1),
        entryHash: z.string().min(1),
        tokenHash: z.string().min(1),
        createdConfig: z.boolean(),
        modelCount: z.number().int().min(0),
        primaryModel: z.string().optional(),
        keyFile: z.string().min(1),
      })
      .strict(),
    previousEntryHash: z.string().optional(),
    previousModelCount: z.number().int().min(0).optional(),
    previousPrimaryModel: z.string().optional(),
    pendingSource: z
      .object({ model: z.string(), baseUrl: z.string(), sourceRevision: z.string() })
      .optional(),
  })
  .strict();

export type ManagedTargetRecord = z.infer<typeof managedRecordSchema>;

/** No plaintext token in connection metadata. Backups and key files stay 0600 private on disk. */
export class LocalConnectionState {
  readonly directory: string;
  readonly targetsDirectory: string;
  readonly keysDirectory: string;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'local-connections');
    this.targetsDirectory = path.join(this.directory, 'targets');
    this.keysDirectory = path.join(this.directory, 'keys');
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
  async listManaged(): Promise<ManagedTargetRecord[]> {
    await mkdir(this.targetsDirectory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.targetsDirectory)).filter((f) =>
      /^[a-f0-9]{24}\.json$/.test(f),
    );
    if (files.length > 256)
      throw new Fault('local_connection_invalid', 'Too many local connection records.', 400);
    const rows: ManagedTargetRecord[] = [];
    for (const file of files) {
      const text = (await readClientFile(path.join(this.targetsDirectory, file), true)).text;
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
      const parsed = managedRecordSchema.safeParse(value);
      if (
        !parsed.success ||
        file !== `${parsed.data.id}.json` ||
        parsed.data.owned.keyFile !== this.keyFilePath(parsed.data.id)
      )
        throw new Fault(
          'local_connection_invalid',
          'A local connection record is invalid. Preserve it for recovery.',
          400,
        );
      rows.push(parsed.data);
    }
    return rows;
  }
  async saveManaged(record: ManagedTargetRecord): Promise<void> {
    managedRecordSchema.parse(record);
    await mkdir(this.targetsDirectory, { recursive: true, mode: 0o700 });
    await replaceClientFile(
      await readClientFile(path.join(this.targetsDirectory, `${record.id}.json`), true),
      JSON.stringify(record, null, 2) + '\n',
    );
  }
  keyFilePath(id: string): string {
    return path.join(this.keysDirectory, `${id}.key`);
  }
  async writeKeyFile(id: string, token: string): Promise<string> {
    await mkdir(this.keysDirectory, { recursive: true, mode: 0o700 });
    const file = this.keyFilePath(id);
    await replaceClientFile(await readClientFile(file, true), `${token}\n`);
    return file;
  }
  async readKeyToken(id: string): Promise<string | null> {
    const file = await readClientFile(this.keyFilePath(id), true);
    return file.text === null ? null : file.text.trim();
  }
  async removeKeyFile(id: string): Promise<void> {
    await unlink(this.keyFilePath(id)).catch(() => {});
  }
  backupDirectory(id: string): string {
    return path.join(this.directory, 'backups', id);
  }
  async backupFile(
    snapshot: ClientFile,
    id: string,
    backupName: string,
    required = false,
  ): Promise<void> {
    const directory = this.backupDirectory(id);
    const info = await lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw clientInvalid();
    });
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw clientInvalid();
      const manifest = await readClientFile(path.join(directory, 'manifest.json'), true);
      let data: Record<string, unknown>;
      try {
        data = jsonMap(JSON.parse(manifest.text ?? ''));
      } catch {
        throw clientInvalid();
      }
      if (data.version !== 1) throw clientInvalid();
      const revisions = jsonMap(data.files);
      const saved = await readClientFile(path.join(directory, backupName), true);
      if (revisions[backupName] !== (saved.text === null ? null : saved.revision))
        throw clientInvalid();
      return;
    }
    if (required) throw clientInvalid();
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(
      path.join(path.dirname(directory), `.${path.basename(directory)}-`),
    );
    try {
      const revisions: Record<string, string | null> = {
        [backupName]: snapshot.text === null ? null : snapshot.revision,
      };
      if (snapshot.text !== null)
        await replaceClientFile(await readClientFile(path.join(stage, backupName)), snapshot.text);
      await replaceClientFile(
        await readClientFile(path.join(stage, 'manifest.json')),
        JSON.stringify({ version: 1, files: revisions }, null, 2),
      );
      await rename(stage, directory);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
