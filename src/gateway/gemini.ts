/**
 * Gemini REST 的路径识别与模型端点（官方 `@google/genai` 3.2.0 实测，docs/protocol.md）。
 *
 * - SDK 默认 `apiVersion` 是 `v1`，所以 `/v1/models/{agent}:{method}` 与 `/v1beta/...` 同等对待。
 * - `models.list()` / `models.get()`：`GET {version}/models[/{id}]` 返回 Google 的 Model 形状
 *   （https://ai.google.dev/api/models）。`/v1/models` 只在带 `x-goog-api-client`（SDK 每次都发）
 *   时用这个形状，其余客户端仍是 OpenAI 列表；`/v1/models/{id}` 同理（带 `anthropic-version` 是 Claude 的 ModelInfo，否则是 OpenAI 的 Model 对象）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from './auth.js';
import type { Principal } from '../core/contracts.js';
import { Fault, noAgent } from '../core/util.js';
import { claudeModelInfo, openaiModel, modelAliases } from './compat-models.js';

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

/**
 * Google's REST accepts proto-JSON, so every field may be written in snake_case or camelCase: the
 * REST reference examples use `system_instruction`, and google-genai 3.3.0 sends the tool schema as
 * `parameters_json_schema`. The parsers read camelCase; this renames the known snake_case keys.
 * Subtrees that hold the caller's own data or JSON Schemas (`args`, `response`, schemas) are left alone.
 */
const SNAKE_TO_CAMEL: Record<string, string> = {
  system_instruction: 'systemInstruction',
  generation_config: 'generationConfig',
  max_output_tokens: 'maxOutputTokens',
  response_mime_type: 'responseMimeType',
  response_schema: 'responseSchema',
  function_declarations: 'functionDeclarations',
  parameters_json_schema: 'parametersJsonSchema',
  response_json_schema: 'responseJsonSchema',
  function_call: 'functionCall',
  function_response: 'functionResponse',
  inline_data: 'inlineData',
  file_data: 'fileData',
  tool_config: 'toolConfig',
  function_calling_config: 'functionCallingConfig',
  allowed_function_names: 'allowedFunctionNames',
  safety_settings: 'safetySettings',
  cached_content: 'cachedContent',
  code_execution: 'codeExecution',
  google_search: 'googleSearch',
  mime_type: 'mimeType',
  file_uri: 'fileUri',
};
const OPAQUE = new Set([
  'args',
  'response',
  'parameters',
  'parametersJsonSchema',
  'responseJsonSchema',
  'responseSchema',
]);

export function camelizeGeminiBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeGeminiBody);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const name = SNAKE_TO_CAMEL[key] ?? key;
    out[name] = OPAQUE.has(name) ? child : camelizeGeminiBody(child);
  }
  return out;
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
  const find = (req: FastifyRequest) => {
    auth.require(req.principal, 'read');
    const id = decodeURIComponent(String((req.params as { '*': string })['*'] ?? ''));
    const found = modelAliases(agents(req.principal)).find((a) => a.id === id);
    if (!found) throw noAgent();
    return found;
  };
  app.get('/v1beta/models', async (req) => {
    auth.require(req.principal, 'read');
    return geminiModelList(modelAliases(agents(req.principal)));
  });
  app.get('/v1beta/models/*', async (req) => geminiModel(find(req)));
  // `GET /v1/models/{id}` is shared by three SDKs (agent ids contain a slash, which SDKs send
  // percent-encoded): Google's by the `x-goog-api-client` header, Anthropic's by `anthropic-version`,
  // otherwise the OpenAI Model object.
  app.get('/v1/models/*', async (req) => {
    const found = find(req);
    if (fromGoogleClient(req)) return geminiModel(found);
    return req.headers['anthropic-version'] ? claudeModelInfo(found) : openaiModel(found);
  });
}
