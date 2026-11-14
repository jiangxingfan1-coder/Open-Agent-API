import type { FastifyInstance } from 'fastify';
import type { Auth } from './auth.js';
import { isOwnerWide } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { bi } from '../core/locale.js';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * `POST /v1/gateway/shutdown`: a clean stop for `oaa stop` where signals cannot be delivered
 * gracefully (Windows maps SIGTERM to TerminateProcess). Only an owner-wide admin key, and only
 * from a loopback peer: a remote caller can never stop the gateway this way. The server closes
 * (draining requests, closing SQLite) after the response is sent.
 */
export function registerShutdownRoute(app: FastifyInstance, auth: Auth): void {
  app.post('/v1/gateway/shutdown', async (req, reply) => {
    auth.require(req.principal, 'admin');
    if (!isOwnerWide(req.principal))
      throw new Fault(
        'scope_denied',
        bi(
          '关闭网关需要覆盖整个所有者的管理员密钥。',
          'Shutdown requires an owner-wide admin key.',
        ),
        403,
      );
    if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? ''))
      throw new Fault(
        'scope_denied',
        bi(
          '只接受来自本机回环地址的关闭请求。',
          'Shutdown is only accepted from this machine (loopback).',
        ),
        403,
      );
    reply.raw.once('finish', () => setImmediate(() => void app.close().catch(() => {})));
    return { stopping: true, pid: process.pid };
  });
}
