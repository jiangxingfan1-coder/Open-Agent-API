import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { canonical, Fault, sha } from '../core/util.js';
import {
  clientConflict,
  clientInvalid,
  guardYamlWrite,
  hasYamlAnnotations,
  jsonMap,
  readClientFile,
  replaceClientFile,
  withClientLocks,
  yamlMap,
  type ClientFile,
} from './local-client-files.js';

export type DshModel = { id: string; name: string; input: ('text' | 'image')[] };
export type DshProvider = {
  displayName: string;
  api: 'openai-completions';
  baseURL: string;
  apiKeyEnv: string;
  models: DshModel[];
  retryPolicy: { mode: 'normal'; maxRetries: 0 };
};
export type DshOwned = {
  providerId: string;
  credentialRef: string;
  provider: DshProvider;
  tokenHash: string;
  createdSettings: boolean;
  createdCredentials: boolean;
};
export type DshSnapshot = {
  root: string;
  settings: ClientFile;
  credentials: ClientFile;
  revision: string;
  providers: Record<string, unknown>;
  refs: Record<string, unknown>;
  profileProviders: string[];
};

function validateCredentialRecords(records: unknown): void {
  const json = (value: unknown, depth = 0, ancestors = new Set<object>()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || depth > 64 || ancestors.has(value))
      throw clientInvalid();
    if (!Array.isArray(value)) jsonMap(value);
    ancestors.add(value);
    for (const child of Object.values(value)) json(child, depth + 1, ancestors);
    ancestors.delete(value);
  };
  for (const [key, value] of Object.entries(jsonMap(records))) {
    if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(key)) throw clientInvalid();
    const fields = jsonMap(value);
    if (fields.kind === 'api-key') {
      if (
        Object.keys(fields).some((k) => !['kind', 'key', 'env'].includes(k)) ||
        (fields.key !== undefined && (typeof fields.key !== 'string' || !fields.key))
      )
        throw clientInvalid();
      if (fields.env !== undefined)
        for (const [name, secret] of Object.entries(jsonMap(fields.env)))
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof secret !== 'string' || !secret)
            throw clientInvalid();
    } else if (fields.kind === 'grant') {
      if (
        Object.keys(fields).some((k) => !['kind', 'payload'].includes(k)) ||
        !Object.hasOwn(fields, 'payload')
      )
        throw clientInvalid();
      json(fields.payload);
    } else throw clientInvalid();
  }
}

export class DshClient {
  constructor(private readonly home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')) {}
  async snapshot(): Promise<DshSnapshot> {
    let root: string;
    try {
      root = await realpath(this.home);
      if (!(await stat(root)).isDirectory()) throw new Error();
      // The supported base composition supplies the hot-loaded settings and credential stores.
      const profile = JSON.parse(
        await readFile(path.join(root, 'profiles/desktop/package.json'), 'utf8'),
      ) as {
        dsh?: { profile?: { bundles?: unknown[] } };
      };
      if (!profile.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-base')) throw new Error();
      for (const name of ['dsh-settings-file', 'dsh-credentials-local', 'dsh-llm-pi-ai']) {
        const pkg = JSON.parse(
          await readFile(
            path.join(root, 'profiles/node_modules/@deepseek-ai', name, 'package.json'),
            'utf8',
          ),
        ) as { name?: string };
        if (pkg.name !== `@deepseek-ai/${name}`) throw new Error();
      }
    } catch {
      throw new Fault(
        'local_connection_unavailable',
        'A standard local DSH desktop profile with settings and credential stores is required.',
        409,
      );
    }
    const profile = await readClientFile(path.join(root, 'profiles/desktop/cordis.patch.yml'));
    const profileProviders: string[] = [];
    if (profile.text) {
      const doc = parseDocument(profile.text);
      if (doc.errors.length || doc.warnings.length) throw clientInvalid();
      let entries: unknown;
      try {
        entries = doc.toJS({ maxAliasCount: 32 });
      } catch {
        throw clientInvalid();
      }
      if (!Array.isArray(entries)) throw clientInvalid();
      for (const raw of entries) {
        const entry = jsonMap(raw);
        const expected: Record<string, string> = {
          settings: '@deepseek-ai/dsh-settings-file',
          credentials: '@deepseek-ai/dsh-credentials-local',
          'llm-pi-ai': '@deepseek-ai/dsh-llm-pi-ai',
        };
        if (
          !Object.hasOwn(expected, String(entry.id)) &&
          !Object.values(expected).includes(String(entry.name))
        )
          continue;
        const config = entry.config === undefined ? {} : jsonMap(entry.config);
        if (
          (entry.id === 'llm-pi-ai' || entry.name === '@deepseek-ai/dsh-llm-pi-ai') &&
          config.providers !== undefined
        )
          profileProviders.push(...Object.keys(jsonMap(config.providers)));
        if (
          (expected[String(entry.id)] &&
            entry.name !== undefined &&
            entry.name !== expected[String(entry.id)]) ||
          entry.disabled === true ||
          config.path !== undefined ||
          config.dshHome !== undefined ||
          config.watch === false
        )
          throw new Fault(
            'local_connection_unavailable',
            'Custom or disabled DSH settings/credential stores need manual configuration.',
            409,
          );
      }
    }
    const settings = await readClientFile(path.join(root, 'settings.yaml'));
    const credentials = await readClientFile(path.join(root, '.credentials.yaml'), true);
    const settingData = jsonMap(yamlMap(settings).toJS({ maxAliasCount: 32 }));
    const section = settingData['llm-pi-ai'] === undefined ? {} : jsonMap(settingData['llm-pi-ai']);
    const providers = section.providers === undefined ? {} : jsonMap(section.providers);
    const secretData = jsonMap(yamlMap(credentials).toJS({ maxAliasCount: 32 }));
    if (
      credentials.text !== null &&
      (secretData.version !== 1 ||
        Object.keys(secretData).some((key) => !['version', 'refs', 'records'].includes(key)))
    )
      throw clientInvalid();
    const refs = secretData.refs === undefined ? {} : jsonMap(secretData.refs);
    if (
      Object.entries(refs).some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || !value,
      )
    )
      throw clientInvalid();
    if (secretData.records !== undefined) validateCredentialRecords(secretData.records);
    return {
      root,
      settings,
      credentials,
      providers,
      refs,
      profileProviders,
      revision: sha(canonical([root, settings.revision, credentials.revision, profile.revision])),
    };
  }
  async locked<T>(fn: (snapshot: DshSnapshot) => Promise<T>): Promise<T> {
    const before = await this.snapshot();
    return withClientLocks([before.settings.file, before.credentials.file], async () => {
      const snapshot = await this.snapshot();
      if (snapshot.root !== before.root) throw clientConflict();
      return fn(snapshot);
    });
  }
  matches(snapshot: DshSnapshot, owned: DshOwned): boolean {
    return (
      !snapshot.profileProviders.includes(owned.providerId) &&
      canonical(snapshot.providers[owned.providerId] ?? null) === canonical(owned.provider) &&
      typeof snapshot.refs[owned.credentialRef] === 'string' &&
      sha(String(snapshot.refs[owned.credentialRef])) === owned.tokenHash
    );
  }
  writable(snapshot: DshSnapshot, providerId: string, credentialRef: string): void {
    guardYamlWrite(yamlMap(snapshot.settings), ['llm-pi-ai', 'providers', providerId]);
    guardYamlWrite(yamlMap(snapshot.credentials), ['refs', credentialRef]);
  }
  async backup(snapshot: DshSnapshot, directory: string, required = false): Promise<void> {
    const files = [
      ['settings.yaml', snapshot.settings],
      ['credentials.yaml', snapshot.credentials],
    ] as const;
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
      for (const [name] of files) {
        const saved = await readClientFile(path.join(directory, name), true);
        if (revisions[name] !== (saved.text === null ? null : saved.revision))
          throw clientInvalid();
      }
      return;
    }
    if (required) throw clientInvalid();
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(
      path.join(path.dirname(directory), `.${path.basename(directory)}-`),
    );
    try {
      const revisions: Record<string, string | null> = {};
      for (const [name, file] of files) {
        revisions[name] = file.text === null ? null : file.revision;
        if (file.text !== null)
          await replaceClientFile(await readClientFile(path.join(stage, name)), file.text);
      }
      await replaceClientFile(
        await readClientFile(path.join(stage, 'manifest.json')),
        JSON.stringify({ version: 1, files: revisions }, null, 2),
      );
      await rename(stage, directory);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  async install(snapshot: DshSnapshot, owned: DshOwned, token: string): Promise<void> {
    this.writable(snapshot, owned.providerId, owned.credentialRef);
    if (
      Object.hasOwn(snapshot.providers, owned.providerId) ||
      snapshot.profileProviders.includes(owned.providerId) ||
      Object.hasOwn(snapshot.refs, owned.credentialRef) ||
      process.env[owned.credentialRef]
    )
      throw clientConflict();
    const creds = yamlMap(snapshot.credentials);
    creds.set('version', 1);
    creds.setIn(['refs', owned.credentialRef], token);
    const settings = yamlMap(snapshot.settings);
    settings.setIn(['llm-pi-ai', 'providers', owned.providerId], owned.provider);
    const written = await replaceClientFile(snapshot.credentials, creds.toString());
    try {
      await replaceClientFile(snapshot.settings, settings.toString());
    } catch (error) {
      // Only restore the exact write still owned by this failed operation.
      try {
        await replaceClientFile(written, snapshot.credentials.text);
      } catch {}
      throw error;
    }
  }
  async sync(snapshot: DshSnapshot, previous: DshOwned, next: DshProvider): Promise<void> {
    this.writable(snapshot, previous.providerId, previous.credentialRef);
    if (!this.matches(snapshot, previous)) throw clientConflict();
    const doc = yamlMap(snapshot.settings);
    doc.setIn(['llm-pi-ai', 'providers', previous.providerId], next);
    await replaceClientFile(snapshot.settings, doc.toString());
  }
  async remove(snapshot: DshSnapshot, owned: DshOwned): Promise<boolean> {
    let conflict = false;
    const provider = snapshot.providers[owned.providerId];
    if (provider !== undefined) {
      if (canonical(provider) !== canonical(owned.provider)) conflict = true;
      else {
        const doc = yamlMap(snapshot.settings);
        guardYamlWrite(doc, ['llm-pi-ai', 'providers', owned.providerId]);
        doc.deleteIn(['llm-pi-ai', 'providers', owned.providerId]);
        const data = jsonMap(doc.toJS({ maxAliasCount: 32 }));
        if (
          Object.keys(jsonMap(jsonMap(data['llm-pi-ai']).providers ?? {})).length === 0 &&
          !hasYamlAnnotations(doc.getIn(['llm-pi-ai'], true))
        ) {
          doc.deleteIn(['llm-pi-ai', 'providers']);
          const section = doc.toJS({ maxAliasCount: 32 })['llm-pi-ai'];
          if (section && !Object.keys(section).length) doc.delete('llm-pi-ai');
        }
        const empty = Object.keys(doc.toJS({ maxAliasCount: 32 })).length === 0;
        await replaceClientFile(
          snapshot.settings,
          owned.createdSettings &&
            empty &&
            !doc.comment &&
            !doc.commentBefore &&
            !hasYamlAnnotations(doc.contents)
            ? null
            : doc.toString(),
        );
      }
    }
    const value = snapshot.refs[owned.credentialRef];
    if (value !== undefined) {
      if (typeof value !== 'string' || sha(value) !== owned.tokenHash) conflict = true;
      else {
        const doc = yamlMap(snapshot.credentials);
        guardYamlWrite(doc, ['refs', owned.credentialRef]);
        doc.deleteIn(['refs', owned.credentialRef]);
        const data = jsonMap(doc.toJS({ maxAliasCount: 32 }));
        const empty =
          Object.keys(jsonMap(data.refs ?? {})).length === 0 &&
          Object.keys(jsonMap(data.records ?? {})).length === 0;
        await replaceClientFile(
          snapshot.credentials,
          owned.createdCredentials &&
            empty &&
            !doc.comment &&
            !doc.commentBefore &&
            !hasYamlAnnotations(doc.contents)
            ? null
            : doc.toString(),
        );
      }
    }
    return !conflict;
  }
}
