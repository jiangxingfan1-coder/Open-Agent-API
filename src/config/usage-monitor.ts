import { accessSync, constants, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { usageSettingsSchema, type UsageSettings } from '../core/usage-monitor.js';
import { Fault } from '../core/util.js';
import { readClientFile, replaceClientFile } from './local-client-files.js';

export function usageCollectorPath(name: 'codexbar' | 'ccusage'): string | null {
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local/bin'),
  ].filter(path.isAbsolute);
  const candidates = dirs.flatMap((dir) => [
    path.join(dir, name),
    ...(process.platform === 'win32'
      ? [path.join(dir, `${name}.cmd`), path.join(dir, `${name}.exe`)]
      : []),
  ]);
  if (name === 'codexbar')
    candidates.push('/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI');
  return candidates.find(usageExecutable) ?? null;
}
export function usageExecutable(file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
export const defaultQuotaCache = () =>
  path.join(os.homedir(), 'Library/Application Support/CodexBar/CLIUsageCache/usage.json');

export class UsageConfiguration {
  readonly directory: string;
  private readonly file: string;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'usage-monitor');
    this.file = path.join(this.directory, 'settings.json');
  }
  async read(): Promise<UsageSettings> {
    const file = await readClientFile(this.file, true);
    if (file.text === null) return usageSettingsSchema.parse({});
    try {
      return usageSettingsSchema.parse(JSON.parse(file.text));
    } catch {
      throw new Fault('invalid_request', 'Usage monitor settings are invalid.', 400);
    }
  }
  async write(value: unknown): Promise<UsageSettings> {
    const settings = usageSettingsSchema.parse(value);
    for (const file of [
      settings.codexbar.file,
      settings.codexbar.executable,
      settings.ccusage.executable,
    ])
      if (file && !path.isAbsolute(file))
        throw new Fault('invalid_request', 'Collector paths must be absolute.', 400);
    if (
      settings.codexbar.enabled &&
      settings.codexbar.mode === 'cli' &&
      !settings.codexbar.providers.length
    )
      throw new Fault('invalid_request', 'Select at least one quota provider.', 400);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await replaceClientFile(
      await readClientFile(this.file, true),
      JSON.stringify(settings, null, 2),
    );
    return settings;
  }
}
