import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/core/util.js';
import { callerToolPermission } from '../src/engines/caller-relay.js';
import { setup } from './helpers.js';

// Security regression probes (in-process via inject; no sockets, no models).

type Setup = Awaited<ReturnType<typeof setup>>;
async function key(
  s: Setup,
  name: string,
  agents: string[],
  scopes: string[],
  token?: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; token: string }> {
  const r = await s.request('POST', '/v1/keys', { name, agents, scopes, ...extra }, token);
  assert.equal(r.statusCode, 200, r.body);
  return { id: r.json().id as string, token: r.json().token as string };
}

test('an agent-restricted admin key cannot revoke or re-quota keys outside its grant, or itself', async () => {
  const s = await setup();
  try {
    const wide = await key(s, 'wide', ['*'], ['read', 'invoke']);
    const narrow = await key(s, 'narrow', ['agent/test'], ['admin'], undefined, {
      quota: { maxRuns: 5 },
    });
    const sibling = await key(s, 'sibling', ['agent/test'], ['read'], narrow.token, {
      quota: { maxRuns: 5 },
    });

    const revokeWide = await s.request('DELETE', `/v1/keys/${wide.id}`, undefined, narrow.token);
    assert.equal(revokeWide.statusCode, 403, revokeWide.body);
    assert.equal(revokeWide.json().error.code, 'scope_denied');
    const liftOwn = await s.request(
      'POST',
      `/v1/keys/${narrow.id}/quota`,
      { quota: null },
      narrow.token,
    );
    assert.equal(liftOwn.statusCode, 403, liftOwn.body);
    const quotaWide = await s.request(
      'POST',
      `/v1/keys/${wide.id}/quota`,
      { quota: { maxRuns: 1 } },
      narrow.token,
    );
    assert.equal(quotaWide.statusCode, 403, quotaWide.body);

    // Keys inside its own grant stay manageable, and the owner-wide admin keeps full control.
    const quotaSibling = await s.request(
      'POST',
      `/v1/keys/${sibling.id}/quota`,
      { quota: { maxRuns: 2 } },
      narrow.token,
    );
    assert.equal(quotaSibling.statusCode, 200, quotaSibling.body);
    assert.equal(
      (await s.request('DELETE', `/v1/keys/${sibling.id}`, undefined, narrow.token)).statusCode,
      204,
    );
    assert.equal(
      (await s.request('POST', `/v1/keys/${narrow.id}/quota`, { quota: null })).statusCode,
      200,
    );
    assert.equal((await s.request('DELETE', `/v1/keys/${wide.id}`)).statusCode, 204);
  } finally {
    await s.cleanup();
  }
});

test('a quota-limited, agent-limited admin key cannot mint or loosen keys beyond its own quota', async () => {
  const s = await setup();
  try {
    const narrow = await key(s, 'narrow', ['agent/test'], ['admin'], undefined, {
      quota: { maxRuns: 5, rpm: 60 },
    });
    // Agents outside its grant are refused (existing rule).
    const wider = await s.request(
      'POST',
      '/v1/keys',
      { name: 'w', agents: ['*'], scopes: ['invoke'] },
      narrow.token,
    );
    assert.equal(wider.statusCode, 403, wider.body);
    for (const quota of [undefined, { maxRuns: 5 }, { maxRuns: 6, rpm: 60 }]) {
      const r = await s.request(
        'POST',
        '/v1/keys',
        { name: 'q', agents: ['agent/test'], scopes: ['invoke'], ...(quota ? { quota } : {}) },
        narrow.token,
      );
      assert.equal(r.statusCode, 403, r.body);
      assert.equal(r.json().error.code, 'quota_exceeds_own');
    }
    const ok = await key(s, 'ok', ['agent/test'], ['invoke'], narrow.token, {
      quota: { maxRuns: 2, rpm: 60 },
    });
    const loosen = await s.request(
      'POST',
      `/v1/keys/${ok.id}/quota`,
      { quota: null },
      narrow.token,
    );
    assert.equal(loosen.statusCode, 403, loosen.body);
    assert.equal(loosen.json().error.code, 'quota_exceeds_own');
    // The owner-wide admin is not limited.
    assert.equal(
      (await s.request('POST', `/v1/keys/${ok.id}/quota`, { quota: null })).statusCode,
      200,
    );
  } finally {
    await s.cleanup();
  }
});

test('DNS-rebinding Host and cross-site Origin are refused even with a valid key', async () => {
  const s = await setup();
  try {
    const rebound = await s.request('GET', '/v1/models', undefined, undefined, {
      host: 'attacker.example:8787',
    });
    assert.equal(rebound.statusCode, 403, rebound.body);
    assert.equal(rebound.json().error.code, 'invalid_host');
    const cross = await s.request('GET', '/v1/models', undefined, undefined, {
      host: '127.0.0.1:8787',
      origin: 'https://attacker.example',
    });
    assert.equal(cross.statusCode, 403, cross.body);
    assert.equal(cross.json().error.code, 'origin_denied');
    // Static console files are served from the allowlist only; traversal never reaches disk.
    for (const url of ['/lib/..%2f..%2fpackage.json', '/styles/../../package.json'])
      assert.ok([401, 404].includes((await s.app.inject({ method: 'GET', url })).statusCode), url);
  } finally {
    await s.cleanup();
  }
});

test('redact covers gateway, node, session and common upstream credential formats', () => {
  const samples = [
    'sk-oaa-' + 'a'.repeat(40),
    'oaa_' + 'b'.repeat(40),
    'oan_' + 'c'.repeat(43),
    'oas_' + 'd'.repeat(43),
    'sk-ant-api03-' + 'e'.repeat(40),
    'AIza' + 'f'.repeat(35),
    'ghp_' + 'g'.repeat(36),
    'github_pat_' + 'h'.repeat(60),
    'xoxb-' + '1'.repeat(12) + '-' + 'i'.repeat(24),
    'AKIA' + 'J'.repeat(16),
  ];
  for (const sample of samples) {
    const out = redact(`upstream said: ${sample} end`);
    assert.ok(!out.includes(sample), `${sample.slice(0, 8)} leaked: ${out}`);
  }
  assert.equal(redact('plain words stay'), 'plain words stay');
});

test('maxStoredBytesPerSubject caps one caller’s uploads without touching other callers', async () => {
  const s = await setup(undefined, { maxStoredBytesPerSubject: 10 });
  try {
    const a = await key(s, 'a', ['*'], ['files']);
    const b = await key(s, 'b', ['*'], ['files']);
    const up = (token: string, content: string) =>
      s.request('POST', '/v1/files', { filename: 'x.txt', content }, token);
    assert.equal((await up(a.token, '12345678')).statusCode, 200);
    const over = await up(a.token, '123');
    assert.equal(over.statusCode, 413, over.body);
    assert.equal(over.json().error.code, 'storage_quota_exceeded');
    assert.equal((await up(b.token, '1234567890')).statusCode, 200);
  } finally {
    await s.cleanup();
  }
});

test('a native tool call that only mentions the relay and a caller tool is not auto-approved', () => {
  const tools = ['get_secret_number'];
  const call = (title: string, kind = 'execute') => ({
    toolCallId: 't',
    title,
    kind,
    rawInput: {},
  });
  for (const title of [
    'echo oaa-caller get_secret_number; cat ~/.ssh/id_rsa',
    '`rm -rf build` # oaa-caller get_secret_number',
    'Edit /etc/hosts (oaa-caller get_secret_number)',
  ])
    for (const kind of ['execute', 'other'])
      assert.equal(callerToolPermission(call(title, kind), tools), null, `${kind}: ${title}`);
  // The relay's own tool-call titles are still recognised.
  for (const title of [
    'get_secret_number (oaa-caller)',
    'Run mcp_oaa-caller_get_secret_number',
    'get_secret_number (oaa-caller MCP server)',
  ])
    assert.equal(callerToolPermission(call(title, 'other'), tools), 'get_secret_number', title);
  // A title made only of the tool name and filler is still refused when the agent classifies the
  // call as acting on the host.
  for (const kind of ['execute', 'edit', 'delete', 'move'])
    assert.equal(
      callerToolPermission(call('Run oaa-caller get_secret_number', kind), tools),
      null,
      kind,
    );
});
