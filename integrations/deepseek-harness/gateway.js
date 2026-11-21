import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const maxReplyBytes = 64 * 1024;
const tokenLimit = 4096;

export function gatewayBase(input = 'http://127.0.0.1:8787') {
  const url = new URL(input);
  const localHttp = url.protocol === 'http:' && localHosts.has(url.hostname);
  if (
    (!localHttp && url.protocol !== 'https:') ||
    url.username || url.password || url.search || url.hash ||
    !['', '/'].includes(url.pathname.replace(/\/v1\/?$/, '/'))
  ) {
    throw new Error('OAA gateway must be a loopback HTTP or HTTPS origin, optionally ending in /v1.');
  }
  return url.origin + '/v1';
}

async function readToken(path) {
  if (!path || !isAbsolute(path)) {
    throw new Error('Set OAA_DSH_TOKEN_FILE to the absolute path of a private gateway key file.');
  }
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > tokenLimit || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('invalid token file');
    }
    const buffer = Buffer.alloc(tokenLimit + 1);
    const { bytesRead } = await file.read(buffer);
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead > tokenLimit || !/^[\x21-\x7e]+$/.test(token)) throw new Error('invalid token');
    return token;
  } catch {
    throw new Error('Cannot read the OAA key. Use a regular key file with private permissions (0600 on Unix).');
  } finally {
    await file?.close();
  }
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OAA gateway returned an empty response.');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxReplyBytes) throw new Error('OAA gateway reply exceeded 64 KiB.');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('OAA gateway did not return JSON.');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function boundedText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(label + ' is empty or exceeds ' + max + ' UTF-8 bytes.');
  }
  return value;
}

const runPath = (id) => {
  if (typeof id !== 'string' || !/^resp_[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('Use a response ID returned by the OAA delegation tool.');
  }
  return '/runs/' + encodeURIComponent(id);
};

export function createGateway(env = process.env) {
  const allowInvoke = env.OAA_DSH_ALLOW_INVOKE === '1';
  async function request(path, { signal, body, idempotencyKey } = {}) {
    signal?.throwIfAborted();
    const base = gatewayBase(env.OAA_DSH_BASE_URL);
    const token = await readToken(env.OAA_DSH_TOKEN_FILE);
    const timeout = AbortSignal.timeout(16_000);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: effectiveSignal,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new Error('OAA gateway request timed out before confirmation.');
      throw new Error('Cannot reach the configured OAA gateway; redirects are not allowed.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('OAA gateway rejected the request (HTTP ' + response.status + ').');
    }
    return boundedJson(response);
  }

  return {
    allowInvoke,
    list(args, signal) {
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');
      if ((offset > 0 || args.revision !== undefined) && !/^[a-f0-9]{64}$/.test(args.revision ?? '')) {
        throw new Error('Pass the catalog revision when reading subsequent pages.');
      }
      const query = new URLSearchParams({ limit: '20', offset: String(offset) });
      if (args.revision) query.set('revision', args.revision);
      return request('/catalog/agents?' + query, { signal });
    },
    async invoke(args, signal) {
      if (!allowInvoke) throw new Error('Delegation is disabled. Set OAA_DSH_ALLOW_INVOKE=1 to enable it.');
      const key = args.idempotency_key;
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) {
        throw new Error('Use an idempotency key of 1-200 printable ASCII characters without spaces.');
      }
      const result = await request('/invoke', {
        body: {
          protocol: 'oaa/1',
          background: true,
          agent: boundedText(args.agent, 'agent', 256),
          model: 'auto',
          input: boundedText(args.input, 'input', 24_000),
        },
        idempotencyKey: key,
        signal,
      });
      const status = result?.metadata?.['oaa.status'] ?? result?.status;
      if (typeof status !== 'string') throw new Error('OAA gateway did not return a run receipt.');
      runPath(result.id);
      return { id: result.id, status };
    },
    wait(args, signal) {
      return request(runPath(args.response_id) + '/wait?timeout_ms=10000', { signal });
    },
    read(args, signal) {
      const query = new URLSearchParams({ max_bytes: '4000' });
      if (args.cursor !== undefined) query.set('cursor', boundedText(args.cursor, 'cursor', 512));
      return request(runPath(args.response_id) + '/output?' + query, { signal });
    },
  };
}
