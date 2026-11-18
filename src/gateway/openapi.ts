// 网关的 OpenAPI 描述（静态文档，由 /openapi.json 提供）。
import { GATEWAY_VERSION } from './endpoints.js';
import { WEBHOOK_OPERATIONS } from './webhook-core.js';
import { METRICS_OPERATIONS } from './metrics-routes.js';
import { LOCAL_MANAGEMENT_OPERATIONS } from './local-management-api.js';
import { PROJECT_OPERATIONS } from './project-api.js';
import { WORKFLOW_OPERATIONS } from './task-workflow-api.js';
import { platformPaths } from './openapi-platform.js';

const inspectionQueries: Record<string, Record<string, Record<string, unknown>>> = {
  '/v1/agents/models': {
    agent: { type: 'string' },
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  '/v1/catalog/agents': {
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  '/v1/catalog/agent': {
    agent: { type: 'string' },
    agent_version: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    section: {
      type: 'string',
      enum: ['overview', 'routes', 'tools', 'skills'],
      default: 'overview',
    },
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  },
  '/v1/catalog/agent/content': {
    agent: { type: 'string' },
    agent_version: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  '/v1/catalog/changes': {
    cursor: { type: 'string', maxLength: 100 },
    limit: { type: 'integer', minimum: 1, maximum: 32, default: 32 },
    timeout_ms: { type: 'integer', minimum: 0, maximum: 25000, default: 20000 },
  },
  '/v1/catalog/events': { cursor: { type: 'string', maxLength: 100 } },
  '/v1/runs/{id}/steps': {
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'uncertain'] },
  },
  '/v1/runs/{id}/actions': {
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
  },
  '/v1/runs/{id}/output': {
    cursor: { type: 'string', maxLength: 512 },
    max_bytes: { type: 'integer', minimum: 256, maximum: 16000, default: 8000 },
  },
  '/v1/runs/{id}/artifacts': {
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
  },
  '/v1/runs/{id}/wait': {
    timeout_ms: { type: 'integer', minimum: 0, maximum: 25000, default: 20000 },
  },
  '/v1/projects/{id}/memory/search': {
    q: { type: 'string', minLength: 1, maxLength: 2000 },
    namespace: { type: 'string', minLength: 1, maxLength: 120 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
};
/** Caller-defined tools on compatibility endpoints (docs/harness.md). */
/** Image input (docs/images.md), appended to every invocation entry. */
const IMAGES_NOTE =
  '. Image parts are accepted (PNG, JPEG, GIF, WebP as base64 / data: URL, https URL or uploaded ' +
  'file id); an agent without image input answers 400 unsupported_content (see image_input in GET /v1/models)';
const CLIENT_TOOLS_NOTE =
  '. A non-empty `tools` array is handled by the X-OAA-Client-Tools request header or ' +
  'metadata["oaa.client_tools"] (managed | bridge | reject; default managed; bridge: kernel ' +
  'agents return tool_calls / function_call / tool_use / functionCall and continue the same run on the results); ' +
  'managed responses carry the X-OAA-Client-Tools: ignored response header. Streams can carry run ' +
  'progress in the protocol thinking shape (X-OAA-Progress: reasoning | off, docs/progress.md)';

export const openapi = {
  openapi: '3.1.0',
  info: { title: 'Open Agent API', version: GATEWAY_VERSION },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  security: [{ bearer: [] }],
  paths: Object.fromEntries(
    [
      ['/v1/agents', 'get', 'List published agents and model routes'],
      [
        '/v1/agents/policy',
        'post',
        'Revision-checked approval and same-agent orchestration policy; existing runs remain pinned',
      ],
      [
        '/v1/agents/models',
        'get',
        'Scoped, revision-guarded runtime model catalog and permitted tool boundaries; no generation',
      ],
      [
        '/v1/agents/publish-native',
        'post',
        'Publish an external agent with optional model_policy, access policy and orchestration',
      ],
      [
        '/v1/platform/setup',
        'get',
        'Developer platform setup: running state, saved settings, pending restart (owner-wide admin)',
      ],
      [
        '/v1/platform/setup',
        'put',
        'Save developer platform enable/settings; takes effect after a restart (409 platform_managed_by_config)',
      ],
      ['/v1/catalog/agents', 'get', 'Bounded published agent summaries with a revision guard'],
      [
        '/v1/catalog/agent',
        'get',
        'Version-pinned public overview, model routes, tool or skill metadata',
      ],
      [
        '/v1/catalog/agent/content',
        'get',
        'Download complete public metadata, excluding prompts, handlers and files',
      ],
      [
        '/v1/catalog/changes',
        'get',
        'Bounded authorized catalog invalidations with reconnect cursors',
      ],
      ['/v1/catalog/events', 'get', 'SSE catalog changes or an explicit resynchronization request'],
      [
        '/v1/agents/preview',
        'post',
        'Inspect routing constraints and selection without executing a model',
      ],
      ['/v1/agents/publish', 'post', 'Publish a validated immutable capability bundle'],
      [
        '/v1/agents/publish-oaa',
        'post',
        'Compile and publish an OAA-Lang 2.0 (.oaa) agent source definition',
      ],
      [
        '/v1/lang/compile',
        'post',
        'Compile, format, and statically analyze an OAA-Lang 2.0 (.oaa) source definition',
      ],
      ['/v1/invoke', 'post', 'Execute an oaa/1 invocation'],
      [
        '/v1/uap',
        'post',
        'Execute a Unified Agent Protocol (UAP/1) envelope with JSON, SSE, or compact NDJSON delivery' +
          IMAGES_NOTE,
      ],
      [
        '/v1/universal',
        'post',
        'Auto-detect and execute any supported protocol dialect (UAP/1, OAA/1, OpenAI, Claude, Gemini); X-OAA-Protocol names it explicitly, an undecidable Chat/Claude body answers 400 protocol_undetected',
      ],
      ['/v1/responses', 'post', 'Responses-compatible execution' + IMAGES_NOTE],
      [
        '/v1/responses/{id}',
        'get',
        'Retrieve a response; ?stream=true replays its event stream (starting_after skips frames)',
      ],
      ['/v1/responses/{id}/cancel', 'post', 'Cancel owned execution'],
      [
        '/v1/chat/completions',
        'post',
        'Chat Completions compatibility (a created run that did not finish answers 422 with x-should-retry: false)' +
          IMAGES_NOTE,
      ],
      [
        '/v1/messages',
        'post',
        'Anthropic Claude Messages API compatibility' + IMAGES_NOTE + CLIENT_TOOLS_NOTE,
      ],
      [
        '/v1beta/models/*',
        'post',
        'Google Gemini generateContent and streamGenerateContent API compatibility' +
          IMAGES_NOTE +
          CLIENT_TOOLS_NOTE,
      ],
      [
        '/v1/models/*',
        'post',
        'Gemini generateContent / streamGenerateContent under the SDK default v1 prefix ' +
          '({agent}:generateContent | {agent}:streamGenerateContent)' +
          CLIENT_TOOLS_NOTE,
      ],
      ['/v1beta/models', 'get', 'List agents as Google Model objects (single page)'],
      ['/v1beta/models/*', 'get', 'Retrieve one agent as a Google Model object'],
      [
        '/v1/models/*',
        'get',
        'Retrieve one agent as a Google Model object; only with the x-goog-api-client header, otherwise 404',
      ],
      [
        '/v1/models',
        'get',
        'List callable agent model aliases and optional expanded route pools (OpenAI list by default; ' +
          'with anthropic-version an Anthropic ModelInfo list; with x-goog-api-client a Google Model list; ' +
          'expand ignores both headers); each OpenAI entry carries image_input (whether the agent accepts images)',
      ],
      ['/v1/nodes', 'get', 'Inspect node capabilities and health'],
      [
        '/v1/nodes/registrations',
        'get',
        'Owner-admin registry of online, offline and revoked node identities',
      ],
      ['/v1/nodes/{id}/history', 'get', 'Read the owner-admin node policy audit'],
      ['/v1/nodes/{id}/drain', 'post', 'Stop new node dispatch without cancelling started work'],
      ['/v1/nodes/{id}/resume', 'post', 'Reactivate a drained node under its existing grants'],
      [
        '/v1/nodes/{id}/revoke',
        'post',
        'Permanently revoke this node identity and reject subsequent frames',
      ],
      ['/v1/nodes/enroll', 'post', 'Enroll an authorized node'],
      ['/v1/files', 'post', 'Upload an input file using OpenAI multipart or UTF-8/base64 JSON'],
      ['/v1/files/{id}/content', 'get', 'Download an owned file'],
      ['/v1/runs', 'get', 'List bounded owned execution summaries'],
      ['/v1/runs/{id}', 'get', 'Retrieve the complete owned execution record'],
      ['/v1/runs/{id}/events', 'get', 'Replayable execution SSE'],
      [
        '/v1/runs/{id}/state',
        'get',
        'Bounded execution state without full context or step results',
      ],
      [
        '/v1/runs/{id}/wait',
        'get',
        'Wait up to 25 seconds for completion or approval without cancelling the run',
      ],
      ['/v1/runs/{id}/steps', 'get', 'Paginated step metadata without argument or result bodies'],
      [
        '/v1/runs/{id}/steps/{step}',
        'get',
        'Bounded step previews and latest operator reconciliation',
      ],
      ['/v1/runs/{id}/steps/{step}/content', 'get', 'Download the full execution step JSON'],
      ['/v1/runs/{id}/actions', 'get', 'Paginated pending approvals with bounded detail previews'],
      ['/v1/runs/{id}/actions/{action}/content', 'get', 'Download the full owned approval JSON'],
      [
        '/v1/runs/{id}/actions/{action}',
        'post',
        'Decide a pending approval; requires approve scope',
      ],
      [
        '/v1/runs/{id}/reconcile',
        'post',
        'Record an operator assertion for an uncertain step; does not resume',
      ],
      ['/v1/runs/{id}/resume', 'post', 'Explicitly resume an interrupted kernel execution'],
      ['/v1/runs/{id}/output', 'get', 'Cursor-paged committed output text'],
      ['/v1/runs/{id}/output.txt', 'get', 'Download all currently committed output text'],
      ['/v1/runs/{id}/artifacts', 'get', 'Paginated artifact metadata'],
      [
        '/v1/runs/{id}/state',
        'get',
        'Bounded run state; queued or node-waiting runs include queue insight; images lists image inputs (no bytes)',
      ],
      [
        '/v1/runs/{id}/timeline',
        'get',
        'Derived run timeline: spans, lanes, critical path and time breakdown (ETag/304); images lists image inputs',
      ],
      ['/v1/errors', 'get', 'Error code catalog: status, category, retryable, zh (ETag/304)'],
      ['/v1/overview', 'get', 'Console overview with revision ETag and If-None-Match 304'],
      [
        '/v1/overview/activity',
        'get',
        'Activity pulse over UTC-aligned buckets (window=24h|7d; ETag/304)',
      ],
      ['/v1/overview/events', 'get', 'SSE overview change feed: ready, changed, ping'],
      ...LOCAL_MANAGEMENT_OPERATIONS,
      ...METRICS_OPERATIONS,
      ['/health', 'get', 'Public liveness and sorted optional feature list'],
      ...WEBHOOK_OPERATIONS,
      ['/v1/keys', 'get', 'List API keys (deleted keys are not listed)'],
      [
        '/v1/keys',
        'post',
        'Create an API key with optional connection defaults (toolMode, allowedModes, per-agent models)',
      ],
      [
        '/v1/audit',
        'get',
        'Owner-wide admin: coalesced audit trail of authenticated scope, host, isolation and quota denials',
      ],
      [
        '/v1/keys/{id}/quota',
        'post',
        'Update or reset per-key rate, token, and concurrency quotas',
      ],
      [
        '/v1/me',
        'get',
        'Inspect caller principal, granted agents, quota limits, live usage, and public endpoints',
      ],
      ['/v1/gateway/public-url', 'post', 'Bind or update the public base URL of the gateway'],
      [
        '/v1/compat/models',
        'get',
        'List expanded agent and semantic route aliases for third-party OpenAI clients',
      ],
      [
        '/v1/compat/chat/completions',
        'post',
        'Lenient OpenAI Chat Completions compatibility endpoint' + CLIENT_TOOLS_NOTE,
      ],
      [
        '/v1/compat/responses',
        'post',
        'Lenient OpenAI Responses compatibility endpoint' + CLIENT_TOOLS_NOTE,
      ],
      [
        '/v1/compat/messages',
        'post',
        'Lenient Anthropic Messages compatibility endpoint' + CLIENT_TOOLS_NOTE,
      ],
      ['/v1/memory', 'get', 'Read durable cross-session agent memory entries'],
      ...PROJECT_OPERATIONS,
      ...WORKFLOW_OPERATIONS,
    ].reduce<[string, Record<string, unknown>][]>((paths, [url, method, summary]) => {
      const entry = {
        summary,
        parameters: [
          ...Array.from(url!.matchAll(/\{([^}]+)\}/g), ([, name]) => ({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string' },
          })),
          ...Object.entries(inspectionQueries[url!] ?? {}).map(([name, schema]) => ({
            name,
            in: 'query',
            required:
              ((url === '/v1/catalog/agent' || url === '/v1/agents/models') && name === 'agent') ||
              (url === '/v1/projects/{id}/memory/search' && name === 'q') ||
              url === '/v1/catalog/agent/content',
            schema,
          })),
          ...(url === '/v1/catalog/events'
            ? [
                {
                  name: 'Last-Event-ID',
                  in: 'header',
                  required: false,
                  schema: { type: 'string', maxLength: 100 },
                },
              ]
            : []),
          ...(url === '/v1/models'
            ? ['anthropic-version', 'x-goog-api-client'].map((name) => ({
                name,
                in: 'header',
                required: false,
                schema: { type: 'string' },
              }))
            : []),
        ],
        responses: {
          '200': { description: 'Successful response' },
          '400': { description: 'Unsupported or invalid input' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Required scope or agent grant missing' },
          '404': { description: 'Requested resource is not owned or does not exist' },
          '409': { description: 'Requested mutation conflicts with the current execution state' },
          '413': { description: 'Request, file or image exceeds its size limit' },
          '429': { description: 'Request or subscription capacity exceeded' },
        },
      };
      // 同一路径的多个方法合并到一项；同路径同方法以后出现的为准。
      const existing = paths.find(([u]) => u === url);
      if (existing) existing[1][method!] = entry;
      else paths.push([url!, { [method!]: entry }]);
      return paths;
    }, []),
  ),
};

/** `openapi` plus the developer-platform routes; served only when `platform` is configured. */
export const openapiWithPlatform = {
  ...openapi,
  paths: { ...openapi.paths, ...platformPaths },
};
