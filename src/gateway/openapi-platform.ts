// Developer platform OpenAPI path specs (merged into /openapi.json only when `platform` is configured).
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
    'Register an account (or stage verification when verificationWebhookUrl is set)',
  ],
  [
    '/v1/portal/signup/verify',
    'post',
    '201',
    'public',
    'Complete staged email verification and open a portal session',
  ],
  ['/v1/portal/login', 'post', '200', 'public', 'Open a portal session with email and password'],
  [
    '/v1/portal/password-reset/request',
    'post',
    '202',
    'public',
    'Request a self-service password reset verification code',
  ],
  [
    '/v1/portal/password-reset',
    'post',
    '204',
    'public',
    'Set a new password with a one-time reset code; sessions end',
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

export const platformPaths: Record<string, Record<string, unknown>> = {};
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
