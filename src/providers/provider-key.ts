/**
 * Where a model provider's key comes from: `noApiKey` (none), `apiKeyFile` (read here, in the
 * gateway / worker process) or the `apiKeyEnv` environment variable of that process.
 * The key text is never logged or returned to a caller; only its source is described.
 */
import { readFileSync, statSync } from 'node:fs';
import type { ProviderConfig } from '../config/config.js';

type KeyRef = Pick<ProviderConfig, 'apiKeyEnv' | 'apiKeyFile' | 'noApiKey'>;
const MAX_KEY_FILE_BYTES = 8192;

/** The key, `''` for a keyless provider, or undefined when the reference does not resolve. */
export function providerApiKey(
  config: KeyRef,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (config.noApiKey) return '';
  if (config.apiKeyFile) {
    try {
      if (statSync(config.apiKeyFile).size > MAX_KEY_FILE_BYTES) return undefined;
      const key = readFileSync(config.apiKeyFile, 'utf8').trim();
      return key && !/\s/.test(key) ? key : undefined;
    } catch {
      return undefined;
    }
  }
  return env[config.apiKeyEnv] || undefined;
}

/** True when a run could get a key (or needs none). */
export const providerKeyReady = (config: KeyRef, env: NodeJS.ProcessEnv = process.env) =>
  providerApiKey(config, env) !== undefined;

/** How the key is referenced, for messages and listings (never the key itself). */
export function providerKeySource(config: KeyRef): { kind: 'none' | 'file' | 'env'; ref?: string } {
  if (config.noApiKey) return { kind: 'none' };
  if (config.apiKeyFile) return { kind: 'file', ref: config.apiKeyFile };
  return { kind: 'env', ref: config.apiKeyEnv };
}

/** One bilingual-neutral English hint naming what to fix when the key does not resolve. */
export function providerKeyHint(config: KeyRef, name?: string): string {
  const who = name ? `Model provider ${name}` : 'The model provider';
  const source = providerKeySource(config);
  return source.kind === 'file'
    ? `${who}: the key file ${source.ref} is missing, empty, unreadable or larger than 8 KiB.`
    : `${who}: set ${source.ref} in the environment of the gateway / worker process (then restart it), or use apiKeyFile.`;
}
