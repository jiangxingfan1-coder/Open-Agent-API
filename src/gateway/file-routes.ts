import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/config.js';
import { principalSubject, visibleSubject } from '../core/contracts.js';
import { Fault, relativeName } from '../core/util.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Store } from '../store/store.js';
import { openVerifiedFileStream } from '../store/large-artifacts.js';
import type { Auth } from './auth.js';
import { assertUploadRoom } from './upload-quota.js';

// 文件上传（multipart 与 JSON 两种）与下载：POST /v1/files、GET /v1/files/:id/content。
// 从 gateway/server.ts 拆出。

export type FileRouteDeps = { auth: Auth; config: GatewayConfig; store: Store; kernel: Kernel };

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const { auth, config, store, kernel } = deps;
  app.post('/v1/files', async (req) => {
    auth.require(req.principal, 'files');
    if (req.isMultipart()) {
      let uploaded: { name: string; bytes: Buffer } | undefined;
      const parts = req.parts();
      // Malformed multipart framing is a client error with a stable code, not a 500.
      const readable = async function* () {
        try {
          yield* parts;
        } catch (error) {
          if (error instanceof Fault || (error as { statusCode?: number }).statusCode) throw error;
          throw new Fault('invalid_multipart', 'The multipart request body is malformed.', 400);
        }
      };
      for await (const part of readable()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file')
            throw new Fault('invalid_file', 'Multipart upload field must be file.');
          relativeName(part.filename);
          uploaded = { name: part.filename, bytes: await part.toBuffer() };
        } else if (
          part.fieldname !== 'purpose' ||
          !['user_data', 'assistants'].includes(String(part.value))
        )
          throw new Fault(
            'invalid_file_field',
            'Only purpose=user_data or assistants is supported.',
          );
      }
      if (!uploaded) throw new Fault('file_required', 'A file part is required.');
      assertUploadRoom(store, config, req.principal, uploaded.bytes.length);
      const f = await store.addFile(
        req.principal.owner,
        uploaded.name,
        uploaded.bytes,
        undefined,
        undefined,
        principalSubject(req.principal),
      );
      return {
        id: f.id,
        object: 'file',
        bytes: f.bytes,
        created_at: Math.floor(f.createdAt / 1000),
        filename: f.name,
        purpose: 'user_data',
      };
    }
    const b = z
      .object({
        filename: z.string().min(1).max(240),
        content: z.string().max(12_000_000),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        allowed_nodes: z.array(z.string()).min(1).optional(),
      })
      .strict()
      .parse(req.body);
    relativeName(b.filename);
    const bytes = Buffer.from(b.content, b.encoding === 'utf8' ? 'utf8' : 'base64');
    assertUploadRoom(store, config, req.principal, bytes.length);
    const file = await store.addFile(
      req.principal.owner,
      b.filename,
      bytes,
      b.allowed_nodes,
      undefined,
      principalSubject(req.principal),
    );
    return {
      id: file.id,
      object: 'file',
      bytes: file.bytes,
      created_at: Math.floor(file.createdAt / 1000),
      filename: file.name,
      purpose: 'user_data',
      sha256: file.sha256,
    };
  });
  app.get('/v1/files/:id/content', async (req, reply) => {
    auth.require(req.principal, 'files');
    const visible = visibleSubject(req.principal);
    const file = store.file((req.params as { id: string }).id, req.principal.owner, visible);
    if (file.runId) kernel.authorize(req.principal, store.run(file.runId).agentId, 'read');
    const { stream, bytes } = await openVerifiedFileStream(store, file);
    reply
      .header(
        'Content-Disposition',
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .header('Content-Length', String(bytes));
    return reply.type('application/octet-stream').send(stream);
  });
}
