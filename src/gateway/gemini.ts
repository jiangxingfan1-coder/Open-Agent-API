/**
 * Gemini REST 的路径识别与模型端点（官方 `@google/genai` 3.2.0 实测，docs/protocol.md）。
 *
 * - SDK 默认 `apiVersion` 是 `v1`，所以 `/v1/models/{agent}:{method}` 与 `/v1beta/...` 同等对待。
 * - `models.list()` / `models.get()`：`GET {version}/models[/{id}]` 返回 Google 的 Model 形状
 *   （https://ai.google.dev/api/models）。`/v1/models` 只在带 `x-goog-api-client`（SDK 每次都发）
 *   时用这个形状，其余客户端仍是 OpenAI 列表；`/v1/models/{id}` 同理，否则保持 404。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from './auth.js';
import type { Principal } from '../core/contracts.js';
import { Fault, noAgent } from '../core/util.js';

const notFound = (req: FastifyRequest) =>
  new Fault(
    'route_not_found',
    `No route matches ${req.method} ${req.url.split('?')[0]!.slice(0, 200)}.`,
    404,
  );

/** `/v1beta/*`，或 `/v1/models/{model}:{method}`（Gemini 的自定义方法路径）。 */
export function isGeminiPath(url: string): boolean {
  const path = url.split('?')[0]!;
  return path.startsWith('/v1beta/') || path === '/v1beta' || /^\/v1\/models\/.+:\w+$/.test(path);
}

/** 请求来自 Google 的 SDK（`x-goog-api-client` 头）。 */
export const fromGoogleClient = (req: FastifyRequest) =>
  typeof req.headers['x-goog-api-client'] === 'string';

/**
 * `POST {version}/models/{model}:{method}` 的模型与方法。`/v1beta` 下其它方法是 Gemini 形状的 404；
 * `/v1/models/...` 不是 Gemini 方法路径时保持原来的 `route_not_found`。
 */
export function geminiMethod(req: FastifyRequest): { rawTarget: string; isStream: boolean } {
  const wildcard = String((req.params as { '*': string })['*'] ?? '');
  const match = /^(.+):(generateContent|streamGenerateContent)$/.exec(wildcard);
  if (!match) {
    if (!isGeminiPath(req.url)) throw notFound(req);
    throw new Fault(
      'invalid_request',
      'Gemini endpoint path must end with :generateContent or :streamGenerateContent.',
      404,
    );
  }
  return {
    rawTarget: decodeURIComponent(match[1]!),
    isStream: match[2] === 'streamGenerateContent',
  };
}

const GENERATION_METHODS = ['generateContent', 'streamGenerateContent'];
export const geminiModel = (a: { id: string }) => ({
  name: `models/${a.id}`,
  baseModelId: a.id,
  version: '1',
  displayName: a.id,
  supportedGenerationMethods: GENERATION_METHODS,
});
/** 一次返回全部智能体，不带 `nextPageToken`（SDK 的分页器据此停止）。 */
export const geminiModelList = (agents: readonly { id: string }[]) => ({
  models: agents.map(geminiModel),
});

export function registerGeminiModelRoutes(
  app: FastifyInstance,
  auth: Auth,
  agents: (p: Principal) => readonly { id: string }[],
): void {
  const get = (req: FastifyRequest) => {
    auth.require(req.principal, 'read');
    const id = decodeURIComponent(String((req.params as { '*': string })['*'] ?? ''));
    const found = agents(req.principal).find((a) => a.id === id);
    if (!found) throw noAgent();
    return geminiModel(found);
  };
  app.get('/v1beta/models', async (req) => {
    auth.require(req.principal, 'read');
    return geminiModelList(agents(req.principal));
  });
  app.get('/v1beta/models/*', async (req) => get(req));
  app.get('/v1/models/*', async (req) => {
    if (!fromGoogleClient(req)) throw notFound(req);
    return get(req);
  });
}
