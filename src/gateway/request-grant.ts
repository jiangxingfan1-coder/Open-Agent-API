import type { FastifyReply, FastifyRequest } from 'fastify';
import { canonical, Fault } from '../core/util.js';
import type { Auth } from './auth.js';

/** A writer wait may span a disconnect, revocation or change of execution privileges. */
export function requestGrant(auth: Auth, req: FastifyRequest, reply: FastifyReply) {
  const grants = canonical(req.principal);
  const guard = () => {
    if (reply.raw.destroyed || req.raw.aborted || req.raw.socket?.destroyed)
      throw new Fault('request_cancelled', 'Client disconnected before admission.', 499);
    if (canonical(auth.revalidate(req.headers.authorization)) !== grants)
      throw new Fault('authorization_changed', 'Caller grants changed before admission.', 403);
  };
  return Object.assign(guard, {
    onDisconnect(notify: () => void) {
      reply.raw.once('close', notify);
      req.raw.once('aborted', notify);
      return () => {
        reply.raw.off('close', notify);
        req.raw.off('aborted', notify);
      };
    },
  });
}
