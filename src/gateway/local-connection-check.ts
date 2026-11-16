import { request } from 'node:http';

/** Direct loopback only: never send a client credential through inherited HTTP proxy settings. */
export async function checkLocalModel(
  base: string,
  model: string,
  token: string,
): Promise<{ ok: boolean; status?: number; code?: string }> {
  const url = new URL(`${base}/models/${encodeURIComponent(model)}`);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    return { ok: false, code: 'unreachable' };
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { ok: boolean; status?: number; code?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = request(
      url,
      { method: 'GET', agent: false, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65_536) {
            req.destroy();
            finish({ ok: false, code: 'unreachable' });
          } else chunks.push(chunk);
        });
        res.once('error', () => finish({ ok: false, code: 'unreachable' }));
        res.once('end', () => {
          let id: unknown;
          try {
            id = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown }).id;
          } catch {}
          finish({ ok: res.statusCode === 200 && id === model, status: res.statusCode });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, code: 'unreachable' });
    }, 5000);
    req.once('error', () => finish({ ok: false, code: 'unreachable' }));
    req.end();
  });
}
