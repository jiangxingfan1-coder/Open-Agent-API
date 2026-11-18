/** Local host-management operations shared by the public OpenAPI directory. */
export const LOCAL_MANAGEMENT_OPERATIONS = [
  [
    '/v1/local/model-runtimes/probe',
    'post',
    'Probe an explicit loopback model list without generation or starting a runtime',
  ],
  [
    '/v1/local/model-runtimes/connect',
    'post',
    'Connect a local model provider and publish a kernel agent without host tools or changes to external application settings',
  ],
  [
    '/v1/local/everything-acp/discover',
    'get',
    'Discover generated wrapper descriptors in an owner-selected directory without executing them',
  ],
  [
    '/v1/local/evaluations/sources',
    'get',
    'Inspect opt-in public JSON model facts, provenance and freshness',
  ],
  [
    '/v1/local/evaluations/sources',
    'post',
    'Configure numeric or boolean public facts without importing web instructions',
  ],
  [
    '/v1/local/evaluations/sources/refresh',
    'post',
    'Fetch bounded public HTTPS JSON sources without credentials or redirects',
  ],
  [
    '/v1/local/evaluations/feedback',
    'post',
    'Record explicit human task feedback without storing task text or starting model calls',
  ],
  [
    '/v1/local/everything-acp/import',
    'post',
    'Import a local EverythingACP client.json launch descriptor without copying credentials or starting a task',
  ],
  [
    '/v1/local/evaluations',
    'get',
    'Inspect measured model capability samples and evaluation settings',
  ],
  [
    '/v1/local/evaluations/settings',
    'post',
    'Enable bounded background model evaluations for a published agent',
  ],
  [
    '/v1/local/evaluations/run',
    'post',
    'Schedule evaluations using the configured daily model-call budget',
  ],
  [
    '/v1/local/usage',
    'get',
    'Local owner-admin usage ledger, account quota snapshots and key allowances',
  ],
  [
    '/v1/local/usage/settings',
    'post',
    'Confirm optional collector access with a revision-checked configuration',
  ],
  ['/v1/local/usage/refresh', 'post', 'Refresh enabled usage collectors without model generation'],
  [
    '/v1/local/usage/import',
    'post',
    'Import allowlisted aggregate fields from CodexBar or ccusage JSON',
  ],
  ['/v1/local/backends', 'get', 'Local native engines, owner adapters and the preset catalog'],
  [
    '/v1/local/connections',
    'get',
    'Direct-loopback owner-admin only: discover local clients and inspect managed API/MCP client bindings; refresh=1 rescans installation metadata; never returns credentials',
  ],
  [
    '/v1/local/connections/preview',
    'post',
    'Preview an additive API provider (dsh, opencode, codex) or MCP bridge (claude-desktop, cursor, windsurf, claude-code) connection; no key creation or generation',
  ],
  [
    '/v1/local/connections/apply',
    'post',
    'Apply the revision-checked preview with a dedicated minimal-scope key, private backups and recovery journal',
  ],
  [
    '/v1/local/connections/{id}/check',
    'post',
    'Check the direct loopback endpoint, scoped key and target entry without generation',
  ],
  [
    '/v1/local/connections/{id}',
    'delete',
    'Revoke the dedicated key and conditionally remove only owned client entries; preserve conflicting edits',
  ],
  [
    '/v1/local/backends/{engine}/models',
    'get',
    'Owner-only agent model discovery; refresh=true bypasses the five-minute cache',
  ],
  ['/v1/local/projects', 'get', 'Owner-only private project working-directory bindings'],
  [
    '/v1/local/projects',
    'post',
    'Bind or unbind a project working directory for an idle local agent; not a sandbox',
  ],
  ['/v1/local/backends/{engine}', 'post', 'Enable or disable a local backend on this gateway'],
  [
    '/v1/local/backends/{engine}/check',
    'post',
    'ACP initialize-only handshake check; no session, prompt or model call',
  ],
] as const;
