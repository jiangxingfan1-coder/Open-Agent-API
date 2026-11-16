import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { UsageSettings, CollectedUsage } from '../core/usage-monitor.js';
import { Fault } from '../core/util.js';
import { readClientFile } from '../config/local-client-files.js';
import { defaultQuotaCache, usageCollectorPath, usageExecutable } from '../config/usage-monitor.js';
import { ownedProcess, terminateOwned, nativeEnvironment } from './process.js';
import { parseCodexBar, parseCcusage } from './usage-parsers.js';

export type UsageSourceState = {
  status: 'disabled' | 'ready' | 'unavailable' | 'error';
  updated_at: number | null;
  error: string | null;
  data: CollectedUsage | null;
  failed_providers?: string[];
};
async function collectorJSON(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<{ value: unknown; partial: boolean }> {
  const child = ownedProcess(command, args, cwd, signal, env);
  return new Promise((resolve, reject) => {
    let output = '',
      bytes = 0,
      overflow = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (overflow) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_097_152) {
        overflow = true;
        terminateOwned(child);
        return;
      }
      output += chunk;
    });
    child.stderr.resume();
    child.once('error', () =>
      reject(new Fault('process_failed', 'The usage collector could not start.', 502)),
    );
    child.once('close', (code) => {
      if (signal.aborted) {
        reject(new Fault('cancelled', 'Usage collection cancelled.', 409));
        return;
      }
      if (overflow) {
        reject(new Fault('output_too_large', 'Usage collector output exceeds 2 MiB.', 502));
        return;
      }
      try {
        resolve({ value: JSON.parse(output), partial: code !== 0 });
      } catch {
        reject(new Fault('invalid_protocol', 'Usage collector did not return valid JSON.', 502));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end('');
  });
}
/** One-shot collectors. No shell, browser source, model prompt, token logging or auto-install. */
export async function collectUsageSource(
  source: 'codexbar' | 'ccusage',
  settings: UsageSettings,
  cwd: string,
  signal: AbortSignal,
): Promise<CollectedUsage> {
  if (!settings[source].enabled)
    throw new Fault('scope_denied', 'Usage collector is disabled.', 403);
  if (source === 'codexbar' && settings.codexbar.mode === 'cache') {
    const file = await readClientFile(settings.codexbar.file || defaultQuotaCache(), true);
    if (file.text === null)
      throw new Fault('capability_unavailable', 'Quota cache is unavailable.', 503);
    return parseCodexBar(JSON.parse(file.text));
  }
  const executable = settings[source].executable || usageCollectorPath(source);
  if (!executable || !usageExecutable(executable))
    throw new Fault('capability_unavailable', 'Usage collector is not installed.', 503);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...nativeEnvironment({
      mode: 'allowlist',
      allow: [
        'CODEX_HOME',
        'CLAUDE_CONFIG_DIR',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'CODEXBAR_CONFIG',
        'ANTIGRAVITY_CLI_PATH',
      ],
    }),
    CODEXBAR_DISABLE_KEYCHAIN_ACCESS: '1',
    NO_COLOR: '1',
    CI: '1',
    TERM: 'dumb',
  };
  env.PATH = [
    path.dirname(process.execPath),
    ...(env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute),
  ].join(path.delimiter);
  const run = async (args: string[]) => {
    const timeout = AbortSignal.timeout(30_000);
    return collectorJSON(executable, args, cwd, AbortSignal.any([signal, timeout]), env);
  };
  if (source === 'ccusage') {
    const since = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
    const result = await run([
      'daily',
      '--by-agent',
      '--json',
      '--offline',
      '--no-cost',
      '--since',
      since,
      '--timezone',
      'UTC',
    ]);
    return { ...parseCcusage(result.value), ...(result.partial ? { partial: true } : {}) };
  }
  const accounts: CollectedUsage['accounts'] = [];
  let partial = false;
  for (const provider of settings.codexbar.providers) {
    if (signal.aborted) throw new Fault('cancelled', 'Usage collection cancelled.', 409);
    try {
      const result = await run([
        'usage',
        '--provider',
        provider,
        '--source',
        settings.codexbar.source,
        '--format',
        'json',
        '--json-only',
      ]);
      const parsed = parseCodexBar(result.value);
      partial ||= result.partial;
      if (parsed.accounts.some((a) => a.provider !== provider))
        throw new Error('Unexpected provider');
      accounts.push(...parsed.accounts);
    } catch {
      partial = true;
      accounts.push({
        id: provider,
        provider,
        account: null,
        source: 'codexbar',
        confidence: 'unknown',
        observed_at: null,
        status: 'unavailable',
        windows: [],
        balance: null,
        budget: null,
      });
    }
  }
  return {
    collector: 'codexbar',
    collected_at: Date.now(),
    accounts,
    daily: [],
    ...(partial ? { partial: true } : {}),
  };
}
