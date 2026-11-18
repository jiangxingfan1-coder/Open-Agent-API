import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.js';
import type { Store } from '../store/store.js';
import type { Kernel } from '../kernel/kernel.js';
import { visibleSubject } from '../core/contracts.js';
import { MEDIA_FORMATS } from '../core/media.js';
import { getArtifactByteLimit, sniffStoredArtifactMedia } from '../store/large-artifacts.js';
import { invocationSchema } from '../kernel/invocation.js';
import { responseObject } from '../kernel/response-object.js';
import { applyConnectionDefaults } from './connection-defaults.js';
import { refreshAgentModels } from '../fabric/model-pool.js';

export function registerMediaRoutes(
  app: FastifyInstance,
  {
    auth,
    store,
    kernel,
    providerKeyOf,
  }: {
    auth: Auth;
    store: Store;
    kernel: Kernel;
    providerKeyOf: (request: FastifyRequest) => string | undefined;
  },
) {
  app.get('/v1/media/formats', async (req) => {
    auth.require(req.principal, 'read');
    return {
      formats: MEDIA_FORMATS,
      max_artifact_bytes: getArtifactByteLimit(store),
      validation: 'signature_only',
    };
  });
  app.post('/v1/media/jobs', async (req, reply) => {
    auth.require(req.principal, 'invoke');
    const body = z
      .object({
        agent: z.string().max(120),
        agent_version: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        model: z.string().max(200).default('auto'),
        input: z.string().min(1).max(200000),
        kind: z.enum(['image', 'document', 'audio', 'video']),
        format: z.string().max(20).optional(),
        file_ids: z.array(z.string()).max(20).default([]),
        metadata: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .parse(req.body);
    const invocation = applyConnectionDefaults(
      req,
      store,
      invocationSchema.parse({
        agent: body.agent,
        agent_version: body.agent_version,
        model: body.model,
        input: body.input,
        file_ids: body.file_ids,
        background: true,
        metadata: {
          ...body.metadata,
          'oaa.durable': body.metadata['oaa.durable'] ?? 'true',
          'oaa.output_kind': body.kind,
          ...(body.format ? { 'oaa.output_format': body.format } : {}),
        },
      }),
    );
    const publication = store.bundle(
      req.principal.owner,
      invocation.agent,
      invocation.agent_version,
    ).agent;
    if (publication.modelPolicy?.mode === 'discover')
      await refreshAgentModels(kernel.hub, req.principal.owner, publication.engine);
    const run = kernel.submit(
      auth.revalidate(req.headers.authorization),
      invocation,
      req.headers['idempotency-key'] as string | undefined,
      providerKeyOf(req),
    );
    return reply.code(202).send(responseObject(run));
  });
  app.get('/v1/media/jobs/:id', async (req) => {
    auth.require(req.principal, 'read');
    const { id } = z.object({ id: z.string().max(120) }).parse(req.params);
    const run = store.run(id, req.principal.owner, visibleSubject(req.principal));
    kernel.authorize(req.principal, run.agentId, 'read');
    const artifacts = [];
    for (const id of run.artifactIds) {
      const file = store.file(id, run.owner);
      const detected = await sniffStoredArtifactMedia(store, file);
      artifacts.push({ id, filename: file.name, bytes: file.bytes, ...detected });
    }
    return {
      ...responseObject(run),
      artifacts,
      media: run.checkpoint.media,
      validation: run.metadata['oaa.media_validation'] ?? 'not_completed',
    };
  });
}
