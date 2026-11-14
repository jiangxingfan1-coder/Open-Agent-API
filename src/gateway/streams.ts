import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from './auth.js';
import { canonical, Fault } from '../core/util.js';

export function revalidateObservation(auth: Auth, req: FastifyRequest): void {
  const current = auth.revalidate(req.headers.authorization);
  const scope = (p: typeof current) =>
    canonical({ owner: p.owner, agents: [...p.agents].sort(), scopes: [...p.scopes].sort() });
  if (scope(current) !== scope(req.principal))
    throw new Fault('authorization_changed', 'Reconnect using the current API key grants.', 403);
}

export function observeAuthorization(
  auth: Auth,
  req: FastifyRequest,
  invalid: (error: unknown) => void,
) {
  const check = ({ owner }: { owner: string }) => {
    if (owner !== req.principal.owner) return;
    try {
      revalidateObservation(auth, req);
    } catch (error) {
      invalid(error);
    }
  };
  auth.store.events.on('authorization', check);
  return () => auth.store.events.off('authorization', check);
}

export function openEventStream(
  req: FastifyRequest,
  reply: FastifyReply,
  auth: Auth,
  extra: Record<string, string> = {},
  bufferedBytes = 2 * 1024 * 1024,
  wireFormat: 'sse' | 'ndjson' | 'json' = 'sse',
  options: { heartbeatMs?: number; heartbeatFrame?: string } = {},
) {
  revalidateObservation(auth, req);
  const raw = reply.raw;
  const headers = Object.fromEntries(
    Object.entries(reply.getHeaders())
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value.join(', ') : String(value),
      ]),
  );
  let closed = false;
  let pendingChunks: string[] = [];
  let pendingBytes = 0;
  let flushScheduled = false;
  const cleanup = new Set<() => void>();

  const flush = () => {
    flushScheduled = false;
    if (closed || !pendingChunks.length) return;
    const payload = pendingChunks.length === 1 ? pendingChunks[0]! : pendingChunks.join('');
    pendingChunks = [];
    pendingBytes = 0;
    try {
      raw.write(payload);
    } catch {
      abortClose();
    }
  };

  const abortClose = () => {
    if (closed) return;
    closed = true;
    pendingChunks = [];
    pendingBytes = 0;
    clearInterval(heartbeat);
    stopAuthorization();
    for (const dispose of cleanup) dispose();
    cleanup.clear();
    raw.end();
  };

  const close = () => {
    if (closed) return;
    flush();
    abortClose();
  };

  const backlog = () => raw.writableLength + pendingBytes;
  // 上限保护的是「客户端不读」：已经积压的字节超过上限才断开。单帧再大（例如带完整输出的
  // 终态帧），只要积压没有超限就照常写出，否则这一帧在任何一次连接里都发不出去。
  // 帧的大小本身由输出上限约束。
  const write = (value: string) => {
    if (closed) return false;
    const chunkBytes = Buffer.byteLength(value);
    if (backlog() > bufferedBytes) {
      abortClose();
      return false;
    }
    pendingChunks.push(value);
    pendingBytes += chunkBytes;
    if (pendingBytes >= 16_384) {
      flush();
    } else if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
    return !closed;
  };

  const stopAuthorization = observeAuthorization(auth, req, abortClose);
  const heartbeatFrame =
    options.heartbeatFrame ??
    (wireFormat === 'ndjson' ? '{"t":"ping"}\n' : wireFormat === 'json' ? '\n' : ': heartbeat\n\n');
  const heartbeat = setInterval(() => {
    try {
      revalidateObservation(auth, req);
      write(heartbeatFrame);
    } catch {
      abortClose();
    }
  }, options.heartbeatMs ?? 15000);

  const contentType =
    wireFormat === 'ndjson'
      ? 'application/x-ndjson; profile="uap/1"; charset=utf-8'
      : wireFormat === 'json'
        ? 'application/json; charset=utf-8'
        : 'text/event-stream; charset=utf-8';

  reply.hijack();
  raw.writeHead(200, {
    ...headers,
    'content-type': contentType,
    'cache-control': 'no-store, no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  raw.flushHeaders();
  raw.once('close', abortClose);
  /**
   * 等积压降到 `lowWater` 以下（客户端读走了数据）。流关闭时返回 false；`stallMs` 内一个字节
   * 都没被读走时按慢客户端断开并返回 false。用于补发历史时按背压分批写。
   */
  const drained = (lowWater: number, stallMs: number): Promise<boolean> => {
    flush();
    if (closed) return Promise.resolve(false);
    if (backlog() <= lowWater) return Promise.resolve(true);
    return new Promise((resolve) => {
      // 'drain' 之外再定时看一眼积压：并非每种 socket 都会在排空时发 'drain'。
      let smallest = backlog();
      let progressAt = Date.now();
      const done = (ok: boolean) => {
        clearInterval(poll);
        raw.off('drain', check);
        cleanup.delete(onClosed);
        resolve(ok);
      };
      const onClosed = () => done(false);
      function check() {
        if (closed) return done(false);
        const now = backlog();
        if (now <= lowWater) return done(true);
        if (now < smallest) {
          smallest = now;
          progressAt = Date.now();
        } else if (Date.now() - progressAt >= stallMs) abortClose();
      }
      cleanup.add(onClosed);
      raw.on('drain', check);
      const poll = setInterval(check, 10);
    });
  };

  return {
    write,
    close,
    backlog,
    drained,
    get closed() {
      return closed;
    },
    onClose(dispose: () => void) {
      if (closed) dispose();
      else cleanup.add(dispose);
    },
  };
}
