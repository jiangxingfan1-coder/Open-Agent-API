/**
 * How the operator commands (`approvals`, `approve`, `deny`, `status`, `verify`) find the gateway
 * and a key. Explicit flags and the OAA_GATEWAY_URL / OAA_TOKEN_FILE variables win (the same inputs
 * every other command uses); otherwise the local data directory (`--dir`, default `.oaa`) supplies the
 * gateway address and the owner admin key written by `oaa init`. No new permission is created: the
 * gateway still decides what the chosen key may do.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type GatewayConfig } from '../config/config.js';
import { Fault } from '../core/util.js';
import { bi } from '../core/locale.js';
import { GatewayClient } from './client.js';
import { gatewayUrl } from './onboarding.js';

export type ConnectionFlags = { dir?: string; url?: string; 'token-file'?: string };

export type Connection = {
  client: GatewayClient;
  url: string;
  /** Present when the data directory has a readable configuration. */
  config?: GatewayConfig;
  dir: string;
  /** `flags`: explicit --url/--token-file or environment; `config`: the data directory's admin key. */
  source: 'flags' | 'config';
};

async function tryConfig(dir: string): Promise<GatewayConfig | undefined> {
  try {
    return await loadConfig(path.join(dir, 'config.json'));
  } catch {
    return undefined;
  }
}

/** The admin key file the local configuration names, if any. */
export function adminTokenFile(config: GatewayConfig | undefined): string | undefined {
  return config?.keys.find((k) => k.scopes.includes('admin') && k.tokenFile)?.tokenFile;
}

export type Endpoint = {
  url: string;
  tokenFile?: string;
  config?: GatewayConfig;
  dir: string;
  source: 'flags' | 'config';
};

/** Gateway address and key file, without reading the key or contacting the gateway. */
export async function resolveEndpoint(
  flags: ConnectionFlags,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Endpoint> {
  const dir = path.resolve(flags.dir ?? '.oaa');
  const config = await tryConfig(dir);
  const explicitUrl = flags.url ?? env.OAA_GATEWAY_URL;
  const explicitToken = flags['token-file'] ?? env.OAA_TOKEN_FILE;
  const configured = config ? gatewayUrl(config) : undefined;
  if (explicitToken)
    return {
      url: explicitUrl ?? configured ?? 'http://127.0.0.1:8787',
      tokenFile: explicitToken,
      config,
      dir,
      source: 'flags',
    };
  return {
    url: explicitUrl ?? configured ?? 'http://127.0.0.1:8787',
    tokenFile: adminTokenFile(config),
    config,
    dir,
    source: 'config',
  };
}

export async function resolveConnection(
  flags: ConnectionFlags,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Connection> {
  const endpoint = await resolveEndpoint(flags, env);
  if (!endpoint.tokenFile)
    throw new Fault(
      'token_required',
      bi(
        `没有找到密钥：用 --token-file 指定密钥文件，或设置 OAA_TOKEN_FILE；也可以在含 ${path.join(endpoint.dir, 'config.json')} 的数据目录里运行（--dir 指定）。`,
        `No key found: pass --token-file, set OAA_TOKEN_FILE, or run against a data directory that has ${path.join(endpoint.dir, 'config.json')} (--dir).`,
      ),
    );
  const client = new GatewayClient(
    endpoint.url,
    (await readFile(endpoint.tokenFile, 'utf8')).trim(),
  );
  return { client, ...endpoint };
}
