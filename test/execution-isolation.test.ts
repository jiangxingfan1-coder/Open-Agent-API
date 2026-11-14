import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeBundle } from '../src/lang/bundle.js';
import { requiredExecution, type ToolBinding } from '../src/core/contracts.js';
import { AuditLog } from '../src/store/audit.js';
import { Store } from '../src/store/store.js';
import { FixtureModel, agent, setup, token } from './helpers.js';

// Public deployment P1: keys carry a maximum execution level; agents that act with host authority
// are refused before any model call, and authenticated denials land in a coalesced audit trail.
// In-process inject only (no sockets, no models).

const hostTool: ToolBinding = {
  name: 'read_notes',
  capability: {
    id: 'private/notes',
    version: '1',
    description: 'Host-bound notes reader.',
    placement: 'host-bound',
    nodeId: 'local',
    effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiresApproval: false,
    timeoutMs: 60_000,
    cacheTtlMs: 0,
    resultExport: true,
  },
  handler: { kind: 'node', reference: 'notes' },
};

test('the required execution level follows the engine and tool handlers', () => {
  assert.equal(requiredExecution(agent()), 'workspace');
  assert.equal(requiredExecution(agent({ engine: 'codex' })), 'host');
  assert.equal(requiredExecution(agent({ engine: 'adapter/custom' })), 'host');
  assert.equal(requiredExecution(agent({ tools: [hostTool] })), 'host');
});

async function publishAll(s: Awaited<ReturnType<typeof setup>>) {
  s.store.publish('owner', makeBundle(agent()));
  s.store.publish('owner', makeBundle(agent({ id: 'agent/native', engine: 'codex' })));
  s.store.publish('owner', makeBundle(agent({ id: 'agent/hosttool', tools: [hostTool] })));
  s.store.publish(
    'owner',
    makeBundle(
      agent({ id: 'agent/parent', delegates: [{ name: 'ask_native', agent: 'agent/native' }] }),
    ),
  );
  s.store.publish(
    'owner',
    makeBundle(
      agent({ id: 'agent/parent-ok', delegates: [{ name: 'ask_kernel', agent: 'agent/test' }] }),
    ),
  );
}

test('workspace keys reach kernel agents but never host authority, without a model call', async () => {
  const driver = new FixtureModel();
  const s = await setup(driver, { defaultKeyExecution: 'workspace' });
  try {
    await publishAll(s);
    const created = await s.request('POST', '/v1/keys', {
      name: 'public-caller',
      agents: ['*'],
      scopes: ['invoke', 'read'],
    });
    assert.equal(created.json().execution, 'workspace', 'gateway default applies');
    const caller = created.json().token as string;

    const ok = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/test', input: 'hi' },
      caller,
    );
    assert.equal(ok.json().status, 'completed', ok.body);
    const parentOk = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/parent-ok', input: 'hi' },
      caller,
    );
    assert.equal(parentOk.statusCode, 200, 'a workspace delegate is not a false positive');

    const callsBefore = driver.calls;
    for (const model of ['agent/native', 'agent/hosttool', 'agent/parent']) {
      const denied = await s.request('POST', '/v1/responses', { model, input: 'hi' }, caller);
      assert.equal(denied.statusCode, 403, `${model}: ${denied.body}`);
      assert.equal(denied.json().error.code, 'isolation_required', model);
      const preview = await s.request(
        'POST',
        '/v1/agents/preview',
        { agent: model, model: 'auto' },
        caller,
      );
      assert.equal(preview.json().error?.code ?? preview.json().error, 'isolation_required');
    }
    assert.equal(driver.calls, callsBefore, 'denials happen before any model call');

    // An explicit host key, and the owner's admin key, keep today's behaviour.
    const hostKey = (
      await s.request('POST', '/v1/keys', {
        name: 'trusted-partner',
        agents: ['*'],
        scopes: ['invoke', 'read'],
        execution: 'host',
      })
    ).json();
    assert.equal(hostKey.execution, 'host');
    for (const key of [hostKey.token as string, token]) {
      const r = await s.request(
        'POST',
        '/v1/responses',
        { model: 'agent/native', input: 'hi' },
        key,
      );
      assert.notEqual(r.json().error?.code, 'isolation_required', r.body);
    }
  } finally {
    await s.cleanup();
  }
});

test('without defaultKeyExecution nothing changes: new keys may start host agents', async () => {
  const s = await setup();
  try {
    await publishAll(s);
    const created = await s.request('POST', '/v1/keys', {
      name: 'legacy-style',
      agents: ['*'],
      scopes: ['invoke'],
    });
    assert.equal(created.json().execution, 'host');
    const r = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/native', input: 'hi' },
      created.json().token,
    );
    assert.notEqual(r.json().error?.code, 'isolation_required', r.body);
  } finally {
    await s.cleanup();
  }
});

test('authenticated denials are audited, coalesced, and only owner-wide admins can read them', async () => {
  const s = await setup(undefined, { defaultKeyExecution: 'workspace' });
  try {
    await publishAll(s);
    const created = (
      await s.request('POST', '/v1/keys', { name: 'audited', agents: ['*'], scopes: ['invoke'] })
    ).json();
    const deny = () =>
      s.request('POST', '/v1/responses', { model: 'agent/native', input: 'x' }, created.token);
    for (let i = 0; i < 3; i++) assert.equal((await deny()).statusCode, 403);
    // Unauthenticated failures are never written.
    assert.equal((await s.request('GET', '/v1/agents', undefined, 'not-a-key')).statusCode, 401);

    const reader = await s.request('GET', '/v1/audit', undefined, created.token);
    assert.equal(reader.statusCode, 403, 'callers cannot read the audit trail');

    const page = (await s.request('GET', '/v1/audit')).json();
    const isolation = page.data.filter((e: { code: string }) => e.code === 'isolation_required');
    assert.equal(isolation.length, 1, 'three identical denials coalesce into one row');
    assert.equal(isolation[0].key_id, created.id);
    assert.equal(isolation[0].subject, created.id);
    assert.equal(isolation[0].method, 'POST');
    assert.equal(isolation[0].path, '/v1/responses');
    assert.ok(isolation[0].ip);
    // The caller's own attempt to read the audit trail is itself an audited scope denial.
    assert.ok(page.data.some((e: { code: string }) => e.code === 'scope_denied'));
    assert.equal(page.data.filter((e: { code: string }) => e.code === 'unauthorized').length, 0);
  } finally {
    await s.cleanup();
  }
});

test('audit rows carry the suppressed count and are pruned to the retention limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-audit-'));
  let now = 1_000_000;
  const store = new Store(root);
  try {
    const log = new AuditLog(store, () => now);
    const denial = {
      owner: 'o',
      code: 'isolation_required',
      keyId: 'k',
      method: 'POST',
      path: '/x',
    };
    assert.equal(log.record(denial), true);
    assert.equal(log.record(denial), false);
    assert.equal(log.record(denial), false);
    assert.equal(log.record({ ...denial, code: 'invalid_request' }), false, 'not an audited code');
    now += 61_000;
    assert.equal(log.record(denial), true);
    const rows = log.page('o').data;
    assert.deepEqual(
      rows.map((r) => r.suppressed),
      [0, 2],
    );
    assert.equal(log.page('other').data.length, 0, 'owners are separated');

    for (let i = 0; i < 10_050; i++) log.record({ ...denial, path: `/p/${i}` });
    log.prune('o');
    const count = Number(
      store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE owner='o'").get()!.n,
    );
    assert.equal(count, 10_000);
    const first = log.page('o', 0, 1);
    assert.equal(first.data.length, 1);
    assert.notEqual(first.next_after, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
