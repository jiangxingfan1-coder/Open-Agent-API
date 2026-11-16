/** Local host-management operations shared by the public OpenAPI directory. */
export const LOCAL_MANAGEMENT_OPERATIONS = [
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
    'Direct-loopback owner-admin only: discover local clients and inspect DSH bindings; refresh=1 rescans installation metadata; never returns credentials',
  ],
  [
    '/v1/local/connections/preview',
    'post',
    'Preview an additive DSH provider connection for one published agent; no key creation or generation',
  ],
  [
    '/v1/local/connections/apply',
    'post',
    'Apply the revision-checked preview with a dedicated scoped key, private backups and recovery journal',
  ],
  [
    '/v1/local/connections/{id}/check',
    'post',
    'Check the direct loopback endpoint, scoped key and model entry without generation',
  ],
  [
    '/v1/local/connections/{id}',
    'delete',
    'Revoke the dedicated key and conditionally remove only owned DSH entries; preserve conflicting edits',
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
