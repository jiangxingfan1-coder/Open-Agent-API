// 网关的 OpenAPI 描述（静态文档，由 /openapi.json 提供）。
import { GATEWAY_VERSION } from './endpoints.js';
import { WEBHOOK_OPERATIONS } from './webhook-core.js';
import { LOCAL_MANAGEMENT_OPERATIONS } from './local-management-api.js';

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

type Access = 'public' | 'session' | 'operator' | 'creditor';
type Query = Record<string, Record<string, unknown>>;
const pageParams = {
  limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  cursor: { type: 'integer', minimum: 0 },
};
const daysParam = { days: { type: 'integer', minimum: 1, maximum: 90, default: 30 } };
const platformQueries: Record<string, Query> = {
  'get /v1/portal/agent': { id: { type: 'string' } },
  'get /v1/portal/usage': daysParam,
  'get /v1/portal/ledger': pageParams,
  'get /v1/portal/runs': {
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
    cursor: { type: 'integer', minimum: 0 },
    agent: { type: 'string', maxLength: 200 },
  },
  'get /v1/platform/accounts': { query: { type: 'string', maxLength: 254 }, ...pageParams },
  'get /v1/platform/accounts/{id}/ledger': pageParams,
  'delete /v1/platform/listings': { agent_id: { type: 'string' } },
  'get /v1/platform/usage': daysParam,
};
/** Developer platform (docs/platform.md): [path, method, success status, access, summary]. */
const platformOperations: [string, string, string, Access, string][] = [
  [
    '/v1/portal/site',
    'get',
    '200',
    'public',
    'Site name, registration mode, base URL, endpoint directory and version',
  ],
  [
    '/v1/portal/agents',
    'get',
    '200',
    'public',
    'Listed agents with prices, model routes and conversion profile',
  ],
  [
    '/v1/portal/agent',
    'get',
    '200',
    'public',
    'One listed agent; 404 agent_not_found when it is not listed',
  ],
  [
    '/v1/portal/signup',
    'post',
    '201',
    'public',
    'Register an account and open a portal session (registration mode applies)',
  ],
  ['/v1/portal/login', 'post', '200', 'public', 'Open a portal session with email and password'],
  [
    '/v1/portal/password-reset',
    'post',
    '204',
    'public',
    'Set a new password with a one-time reset code from the operator; sessions end',
  ],
  ['/v1/portal/logout', 'post', '204', 'session', 'End the portal session (Bearer oas_ token)'],
  ['/v1/portal/account', 'get', '200', 'session', 'The signed-in account and its balance'],
  [
    '/v1/portal/account/password',
    'post',
    '204',
    'session',
    'Change the password; every session of the account ends',
  ],
  ['/v1/portal/keys', 'get', '200', 'session', 'Live API keys of the account (no secrets)'],
  ['/v1/portal/keys', 'post', '201', 'session', 'Create an API key; the secret is returned once'],
  [
    '/v1/portal/keys/{id}',
    'delete',
    '204',
    'session',
    'Delete an API key: it stops working at once and is no longer listed',
  ],
  ['/v1/portal/redeem', 'post', '200', 'session', 'Redeem a credit code'],
  [
    '/v1/portal/usage',
    'get',
    '200',
    'session',
    'Balance, totals, daily and per-agent usage (days 1-90)',
  ],
  ['/v1/portal/ledger', 'get', '200', 'session', 'Ledger entries, newest first, cursor-paged'],
  [
    '/v1/portal/runs',
    'get',
    '200',
    'session',
    'Runs started by the account, newest first, cursor-paged, optional agent filter',
  ],
  [
    '/v1/portal/runs/{id}',
    'get',
    '200',
    'session',
    'One run of the account: status, usage, charge, price, output text and timeline',
  ],
  [
    '/v1/platform/summary',
    'get',
    '200',
    'operator',
    'Operator: accounts, balances, spend and listings',
  ],
  [
    '/v1/platform/accounts',
    'get',
    '200',
    'creditor',
    'Operator or billing key: search and page developer accounts',
  ],
  [
    '/v1/platform/accounts',
    'post',
    '201',
    'operator',
    'Operator: create an account (not limited by registration)',
  ],
  [
    '/v1/platform/accounts/{id}/status',
    'post',
    '200',
    'operator',
    'Operator: disable or enable an account (audited)',
  ],
  [
    '/v1/platform/accounts/{id}/credit',
    'post',
    '200',
    'creditor',
    'Operator: signed balance adjustment; billing key: credit only. Optional reference de-duplicates (audited)',
  ],
  [
    '/v1/platform/accounts/{id}/password',
    'post',
    '204',
    'operator',
    'Operator: reset a password; sessions end (audited)',
  ],
  [
    '/v1/platform/accounts/{id}/reset-code',
    'post',
    '201',
    'operator',
    'Operator: one-time password reset code, valid 24 hours; plaintext is returned once (audited)',
  ],
  [
    '/v1/platform/accounts/{id}/ledger',
    'get',
    '200',
    'operator',
    'Operator: ledger of one account, newest first',
  ],
  ['/v1/platform/listings', 'get', '200', 'operator', 'Operator: listings with prices'],
  ['/v1/platform/listings', 'put', '200', 'operator', 'Operator: create or update a listing'],
  ['/v1/platform/listings', 'delete', '204', 'operator', 'Operator: remove a listing'],
  [
    '/v1/platform/codes',
    'get',
    '200',
    'operator',
    'Operator: credit and invite codes (no plaintext)',
  ],
  [
    '/v1/platform/codes',
    'post',
    '201',
    'operator',
    'Operator: generate codes; plaintext is returned once',
  ],
  ['/v1/platform/codes/{id}', 'delete', '204', 'operator', 'Operator: revoke a code'],
  [
    '/v1/platform/usage',
    'get',
    '200',
    'operator',
    'Operator: usage over all accounts, with per-account totals',
  ],
];
const platformPaths: Record<string, Record<string, unknown>> = {};
for (const [url, method, ok, access, summary] of platformOperations)
  (platformPaths[url] ??= {})[method] = {
    summary,
    ...(access === 'public' ? { security: [] } : {}),
    parameters: [
      ...Array.from(url.matchAll(/\{([^}]+)\}/g), ([, name]) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...Object.entries(platformQueries[`${method} ${url}`] ?? {}).map(([name, schema]) => ({
        name,
        in: 'query',
        required: name === 'id' || name === 'agent_id',
        schema,
      })),
    ],
    responses: {
      [ok]: { description: ok === '204' ? 'Done, no content' : 'Successful response' },
      '400': { description: 'Invalid input' },
      '401': { description: 'Authentication required or portal session invalid' },
      '403': { description: 'Not allowed: scope, owner-wide admin, disabled account' },
      '404': { description: 'Resource does not exist' },
      ...(url.endsWith('/credit')
        ? {
            '409': { description: 'reference_conflict: the reference was used for another credit' },
          }
        : {}),
      '429': { description: 'Rate limited' },
    },
  };
/** `openapi` plus the developer-platform routes; served only when `platform` is configured. */
export const openapiWithPlatform = {
  ...openapi,
  paths: { ...openapi.paths, ...platformPaths },
};
