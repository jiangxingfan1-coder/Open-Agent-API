/**
 * Configured model providers as seen by one process: kind, endpoint, where the key comes from and
 * whether it resolves there. Used by GET /v1/local/backends (the gateway's own view) and by
 * `oaa models`. Never contains a key; reachability is probed only on request and only for loopback
 * endpoints unless the caller opts in.
 */
import type { ProviderConfig, WorkerConfig } from '../config/config.js';
import { providerApiKey, providerKeySource } from './provider-key.js';

export type ProviderStatus = {
  name: string;
  kind: ProviderConfig['kind'];
  base_url: string;
  preset?: string;
  local: boolean;
  key: { kind: 'none' | 'file' | 'env'; ref?: string };
  key_ready: boolean;
};

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

export function providerStatuses(
  worker: Pick<WorkerConfig, 'providers'> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProviderStatus[] {
  return Object.entries(worker?.providers ?? {}).map(([name, p]) => ({
    name,
    kind: p.kind,
    base_url: p.baseUrl,
    ...(p.preset ? { preset: p.preset } : {}),
    local: isLoopbackUrl(p.baseUrl),
    key: providerKeySource(p),
    key_ready: providerApiKey(p, env) !== undefined,
  }));
}

/** The model-list request for a provider (no generation, so it costs nothing on metered services). */
function listRequest(
  p: ProviderConfig,
  key: string,
): { url: string; headers: Record<string, string> } {
  const base = p.baseUrl.replace(/\/+$/, '');
  if (p.kind === 'anthropic-messages')
    return {
      url: base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`,
      headers: {
        ...(key ? { 'x-api-key': key } : {}),
        'anthropic-version': p.anthropicVersion ?? '2023-06-01',
      },
    };
  if (p.kind === 'gemini-generate')
    return {
      url: `${base.includes('/v1beta') || base.endsWith('/v1') ? base : `${base}/v1beta`}/models`,
      headers: key ? { 'x-goog-api-key': key } : {},
    };
  return { url: `${base}/models`, headers: key ? { authorization: `Bearer ${key}` } : {} };
}

export type ProbeResult =
  { reachable: true; status: number; models?: string[] } | { reachable: false; error: string };

/** One GET of the provider's model list. Callers decide whether a non-loopback URL may be probed. */
export async function probeProvider(
  p: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 3000,
): Promise<ProbeResult> {
  const { url, headers } = listRequest(p, providerApiKey(p, env) ?? '');
  try {
    const r = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return { reachable: true, status: r.status };
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of r.body ?? []) {
      bytes += chunk.length;
      if (bytes > 1_048_576) return { reachable: false, error: 'model list exceeds 1 MiB' };
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      data?: { id?: unknown }[];
      models?: { name?: unknown }[];
    };
    if (!body || (!Array.isArray(body.data) && !Array.isArray(body.models)))
      return { reachable: false, error: 'invalid model list' };
    const ids = [
      ...(body.data ?? []).map((m) => m?.id),
      ...(body.models ?? []).map((m) =>
        typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : m?.name,
      ),
    ].filter(
      (x): x is string =>
        typeof x === 'string' && x.length > 0 && x.length <= 200 && !/[\x00-\x1f]/.test(x),
    );
    return { reachable: true, status: r.status, models: [...new Set(ids)].slice(0, 200) };
  } catch (error) {
    return {
      reachable: false,
      error: (error as Error).name === 'TimeoutError' ? 'timeout' : 'connection failed',
    };
  }
}
