import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.js';
import type { Store } from '../store/store.js';
import { projects } from '../store/projects.js';

const projectId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
const names = {
  namespace: z.string().min(1).max(120).default('shared'),
  key: z.string().min(1).max(240),
};
export function registerProjectRoutes(
  app: FastifyInstance,
  { auth, store }: { auth: Auth; store: Store },
) {
  const data = projects(store);
  const idOf = (params: unknown) => z.object({ id: projectId }).parse(params).id;
  app.get('/v1/projects', async (req) => {
    auth.require(req.principal, 'read');
    return { data: data.list(req.principal) };
  });
  app.post('/v1/projects', async (req) => {
    auth.requireNodeAdmin(req.principal);
    const body = z
      .object({ id: projectId, name: z.string().min(1).max(200) })
      .strict()
      .parse(req.body);
    return data.create(req.principal, body.id, body.name);
  });
  app.get('/v1/projects/:id/members', async (req) => {
    auth.requireNodeAdmin(req.principal);
    return { data: data.members(req.principal, idOf(req.params)) };
  });
  app.post('/v1/projects/:id/members', async (req) => {
    auth.requireNodeAdmin(req.principal);
    const body = z
      .object({ subject: z.string().min(1).max(200), access: z.enum(['read', 'write', 'none']) })
      .strict()
      .parse(req.body);
    data.grant(req.principal, idOf(req.params), body.subject, body.access);
    return { ok: true };
  });
  app.get('/v1/projects/:id/memory/search', async (req) => {
    auth.require(req.principal, 'read');
    const query = z
      .object({
        q: z.string().min(1).max(2000),
        namespace: z.string().min(1).max(120).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()
      .parse(req.query);
    return {
      data: data.search(req.principal, idOf(req.params), query.q, {
        namespace: query.namespace,
        limit: query.limit,
      }),
    };
  });
  app.get('/v1/projects/:id/memory', async (req) => {
    auth.require(req.principal, 'read');
    const query = z
      .object({
        namespace: z.string().min(1).max(120).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .strict()
      .parse(req.query);
    return { data: data.entries(req.principal, idOf(req.params), query.namespace, query.limit) };
  });
  app.put('/v1/projects/:id/memory', async (req) => {
    auth.require(req.principal, 'invoke');
    const body = z
      .object({ ...names, value: z.unknown(), revision: z.string().max(64).optional() })
      .strict()
      .parse(req.body);
    return {
      entry: data.put(
        req.principal,
        idOf(req.params),
        body.namespace,
        body.key,
        body.value,
        body.revision,
      ),
    };
  });
  app.delete('/v1/projects/:id/memory', async (req) => {
    auth.require(req.principal, 'invoke');
    const body = z
      .object({ ...names, revision: z.string().min(1).max(64) })
      .strict()
      .parse(req.body);
    data.delete(req.principal, idOf(req.params), body.namespace, body.key, body.revision);
    return { deleted: true };
  });
}
