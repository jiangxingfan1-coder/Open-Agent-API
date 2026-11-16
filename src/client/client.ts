import { readFile } from 'node:fs/promises';
import { processLocale } from '../core/locale.js';
import { Fault } from '../core/util.js';
import { validateEndpoint } from '../config/config.js';
export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
  ifAbsent?: boolean;
};
export class GatewayClient {
  constructor(
    readonly url: string,
    private token: string,
  ) {
    validateEndpoint(url);
  }
  static async fromOptions(url?: string, tokenFile?: string): Promise<GatewayClient> {
    const endpoint = url ?? process.env.OAA_GATEWAY_URL ?? 'http://127.0.0.1:8787';
    const file = tokenFile ?? process.env.OAA_TOKEN_FILE;
    if (!file) throw new Fault('token_required', 'Set OAA_TOKEN_FILE or pass --token-file.');
    return new GatewayClient(endpoint, (await readFile(file, 'utf8')).trim());
  }
  async request<T = Record<string, unknown>>(
    method: string,
    endpoint: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const { bytes } = await this.fetchBytes(method, endpoint, body, options, 24 * 1024 * 1024);
    let result: unknown;
    try {
      result = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
    } catch {
      throw new Fault('invalid_gateway_response', 'Gateway returned invalid JSON.', 502);
    }
    return result as T;
  }
  async download(
    fileId: string,
    options: RequestOptions = {},
    maxBytes = 8 * 1024 * 1024,
  ): Promise<Buffer> {
    return (
      await this.fetchBytes(
        'GET',
        `/v1/files/${encodeURIComponent(fileId)}/content`,
        undefined,
        options,
        maxBytes,
      )
    ).bytes;
  }
  async agentMetadata(
    agent: string,
    version: string,
    options: RequestOptions = {},
    maxBytes = 4 * 1024 * 1024,
  ): Promise<Buffer> {
    return (
      await this.fetchBytes(
        'GET',
        `/v1/catalog/agent/content?${new URLSearchParams({ agent, agent_version: version })}`,
        undefined,
        options,
        maxBytes,
      )
    ).bytes;
  }
  private async fetchBytes(
    method: string,
    endpoint: string,
    body: unknown,
    options: RequestOptions,
    limit: number,
  ) {
    const target = new URL(endpoint, this.url);
    if (
      !endpoint.startsWith('/') ||
      endpoint.startsWith('//') ||
      target.origin !== new URL(this.url).origin
    )
      throw new Fault(
        'invalid_gateway_path',
        'Requests must stay on the configured gateway origin.',
      );
    if (
      options.idempotencyKey !== undefined &&
      !/^[\x21-\x7e]{1,200}$/.test(options.idempotencyKey)
    )
      throw new Fault(
        'invalid_idempotency_key',
        'Use 1-200 printable ASCII characters without spaces.',
      );
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 35_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const response = await fetch(target, {
        method,
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Accept-Language': processLocale(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
          ...(options.ifAbsent ? { 'If-None-Match': '*' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const maximum = response.ok ? limit : 65536;
      if (Number(response.headers.get('content-length')) > maximum) {
        await response.body?.cancel();
        throw new Fault(
          'gateway_response_too_large',
          'Gateway response exceeds its bounded reader.',
          502,
        );
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      try {
        if (reader)
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > maximum)
              throw new Fault(
                'gateway_response_too_large',
                'Gateway response exceeds its bounded reader.',
                502,
              );
            chunks.push(next.value);
          }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(chunks);
      if (!response.ok) {
        let error: { code?: unknown; message?: unknown } | undefined;
        try {
          error = JSON.parse(bytes.toString('utf8'))?.error;
        } catch {
          // Non-JSON error body: report the HTTP status instead.
        }
        throw new Fault(
          typeof error?.code === 'string' ? error.code.slice(0, 100) : 'gateway_error',
          typeof error?.message === 'string'
            ? error.message.slice(0, 2000)
            : `Gateway returned HTTP ${response.status}`,
          response.status,
        );
      }
      return { bytes };
    } catch (error) {
      if (signal.aborted)
        throw new Fault(
          options.signal?.aborted ? 'request_cancelled' : 'gateway_timeout',
          'Gateway request ended before confirmation. An accepted task may still be running; retry submissions with the same idempotency key.',
          options.signal?.aborted ? 499 : 504,
        );
      // fetch 连不上（端口没人监听、地址写错）时只抛 TypeError('fetch failed')：换成能告诉新人下一步的码。
      if (error instanceof TypeError)
        throw new Fault('gateway_unreachable', `Cannot reach the gateway at ${this.url}.`, 503);
      throw error;
    }
  }
}
