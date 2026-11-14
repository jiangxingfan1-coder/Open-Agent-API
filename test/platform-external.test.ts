import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundle } from '../src/lang/bundle.js';
import { agent, token, waitFor } from './helpers.js';
import {
  auditRows,
  balance,
  call,
  chat,
  developer,
  listing,
  redeem,
  withExternal,
} from './platform-external-helpers.js';

// Developer platform offering an external agent: the offline sample agent (a real ACP process
// that calls no model) published as adapter/oaa-sample. Covers the per-listing host switch, its
// delegation rules and audit rows, and the billing path end to end. In-process inject only.

test('external listing: refused by default, flagged in the API and hidden from the portal', async () => {
  await withExternal(async (c) => {
    const view = await listing(c, { agent_id: 'agent/sample', price: { per_run: 1 } });
    assert.equal(view.host_execution, false);
    assert.equal(view.requires_host, true);
    assert.equal(view.callable, false);
    assert.deepEqual(view.blocked_by, ['agent/sample']);
    assert.equal(view.usage_reported, false);
    const catalog = await call(c, 'GET', '/v1/portal/agents', undefined, '');
    assert.deepEqual(catalog.json().data, [], 'not shown as callable');
    assert.equal(
      (await call(c, 'GET', '/v1/portal/agent?id=agent%2Fsample', undefined, '')).statusCode,
      404,
    );
    const dev = await developer(c, 5);
    const refused = await chat(c, dev.key);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(refused.json().error.code, 'isolation_required');
    assert.equal(await balance(c, dev.session), 5, 'nothing charged, nothing held');
    assert.equal(c.gw.store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
    // The owner's own key is unaffected.
    const own = await chat(c, token);
    assert.equal(own.statusCode, 200, own.body);
    assert.deepEqual(await auditRows(c), []);
  });
});

test('external listing: the switch lets account keys run only that agent; audited on and off', async () => {
  await withExternal(async (c) => {
    await listing(c, { agent_id: 'agent/sample', price: { per_run: 1 }, host_execution: true });
    const view = await listing(c, { agent_id: 'agent/boss' });
    // The boss is a kernel agent, but it delegates to the sample agent, so it needs the sample's
    // own switch: here the sample's is on, so the boss is callable.
    assert.equal(view.requires_host, false);
    assert.equal(view.callable, true);
    const dev = await developer(c, 5);
    const ok = await chat(c, dev.key);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.match(ok.json().choices[0].message.content, /offline sample agent/);

    // Off again: the next call is refused, and the boss (which delegates to it) too.
    const off = await listing(c, { agent_id: 'agent/sample', host_execution: false });
    assert.equal(off.callable, false);
    const boss = (await call(c, 'GET', '/v1/platform/listings'))
      .json()
      .data.find((l: { agent_id: string }) => l.agent_id === 'agent/boss');
    assert.equal(boss.callable, false);
    assert.deepEqual(boss.blocked_by, ['agent/sample']);
    // Turning the boss's own switch on does not open its delegate.
    const bossOn = await listing(c, { agent_id: 'agent/boss', host_execution: true });
    assert.deepEqual(bossOn.blocked_by, ['agent/sample']);
    for (const model of ['agent/sample', 'agent/boss']) {
      const r = await chat(c, dev.key, model);
      assert.equal(r.statusCode, 403, `${model}: ${r.body}`);
      assert.equal(r.json().error.code, 'isolation_required');
    }
    const removed = await call(c, 'DELETE', '/v1/platform/listings?agent_id=agent%2Fboss');
    assert.equal(removed.statusCode, 204);
    const rows = await auditRows(c);
    assert.deepEqual(
      rows.map((r) => [r.agent_id, r.detail]),
      [
        ['agent/sample', 'on'],
        ['agent/sample', 'off'],
        ['agent/boss', 'on'],
        ['agent/boss', 'off'],
      ],
    );
    assert.equal(rows[0]!.key_id, 'config:test');
  });
});

test('external listing: a fallback chain may not reach a host agent without its own switch', async () => {
  await withExternal(async (c) => {
    await listing(c, { agent_id: 'agent/boss', host_execution: true });
    await listing(c, { agent_id: 'agent/sample' });
    c.gw.store.publish('owner', makeBundle(agent({ id: 'agent/plain' })));
    await listing(c, { agent_id: 'agent/plain' });
    const dev = await developer(c, 0);
    const r = await call(
      c,
      'POST',
      '/v1/responses',
      { model: 'agent/plain', input: 'hi', metadata: { 'oaa.agent_fallback': 'agent/sample' } },
      dev.key,
    );
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error.code, 'isolation_required');
  });
});

test('external listing: per-token prices are refused for an agent that reports no usage', async () => {
  await withExternal(async (c) => {
    const r = await call(c, 'PUT', '/v1/platform/listings', {
      agent_id: 'agent/sample',
      price: { per_run: 1, per_1k_tokens: 0.5 },
    });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error.code, 'usage_pricing_unsupported');
    assert.deepEqual((await call(c, 'GET', '/v1/platform/listings')).json().data, []);
    // Kernel agents report usage: a per-token price is accepted.
    const kernel = await listing(c, { agent_id: 'agent/boss', price: { per_1k_tokens: 0.5 } });
    assert.equal(kernel.usage_reported, true);
  });
});

test('platform billing end to end with an external agent: charge, exhaust, top up', async () => {
  await withExternal(async (c) => {
    await listing(c, {
      agent_id: 'agent/sample',
      title: 'Sample',
      price: { per_run: 2 },
      host_execution: true,
    });
    const portal = (await call(c, 'GET', '/v1/portal/agents', undefined, '')).json().data;
    assert.deepEqual(
      portal.map((a: { id: string; kind: string }) => [a.id, a.kind]),
      [['agent/sample', 'external']],
    );
    const dev = await developer(c, 5);
    assert.equal(await balance(c, dev.session), 5);

    const first = await chat(c, dev.key);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(await balance(c, dev.session), 3);
    const ledger = (await call(c, 'GET', '/v1/portal/ledger', undefined, dev.session)).json().data;
    assert.equal(ledger[0].kind, 'run');
    assert.equal(ledger[0].amount, -2);
    assert.equal(ledger[0].status, 'completed');
    assert.equal(ledger[0].agent, 'agent/sample');
    assert.equal(ledger[1].kind, 'redeem');
    const runs = (await call(c, 'GET', '/v1/portal/runs', undefined, dev.session)).json().data;
    assert.equal(runs[0].charge, 2);

    // Owner side: usage and the account row.
    const usage = (await call(c, 'GET', '/v1/platform/usage')).json();
    assert.equal(usage.totals.runs, 1);
    assert.equal(usage.totals.spent, 2);
    assert.equal(usage.by_account[0].email, 'dev@x.io');
    assert.deepEqual(usage.by_agent, [{ agent: 'agent/sample', runs: 1, tokens: 0, spent: 2 }]);

    const second = await chat(c, dev.key);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(await balance(c, dev.session), 1);

    // Exhausted: every protocol entry refuses before a run exists, in its own error shape.
    const before = c.gw.store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n;
    const chatRefused = await chat(c, dev.key);
    assert.equal(chatRefused.statusCode, 402);
    assert.equal(chatRefused.json().error.code, 'insufficient_balance');
    const responses = await call(
      c,
      'POST',
      '/v1/responses',
      { model: 'agent/sample', input: 'hi' },
      dev.key,
    );
    assert.equal(responses.statusCode, 402);
    assert.equal(responses.json().error.code, 'insufficient_balance');
    const claude = await call(
      c,
      'POST',
      '/v1/messages',
      { model: 'agent/sample', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      dev.key,
    );
    assert.equal(claude.statusCode, 402, claude.body);
    assert.equal(claude.json().type, 'error');
    assert.equal(claude.json().error.type, 'billing_error');
    assert.equal(claude.json().error.code, 'insufficient_balance');
    const gemini = await call(
      c,
      'POST',
      '/v1beta/models/agent%2Fsample:generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      dev.key,
    );
    assert.equal(gemini.statusCode, 402, gemini.body);
    assert.equal(gemini.json().error.code, 402);
    assert.equal(gemini.json().error.status, 'FAILED_PRECONDITION');
    assert.equal(gemini.json().error.details[0].reason, 'insufficient_balance');
    assert.equal(c.gw.store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, before);
    assert.equal(await balance(c, dev.session), 1);

    // Topped up: works again.
    await redeem(c, dev.session, 4);
    const third = await chat(c, dev.key);
    assert.equal(third.statusCode, 200, third.body);
    assert.equal(await balance(c, dev.session), 3);
    const account = (await call(c, 'GET', '/v1/platform/accounts?query=dev%40x.io')).json().data[0];
    assert.equal(account.id, dev.id);
    assert.equal(account.runs, 3);
    assert.equal(account.spent, 6);
  });
});

test('platform billing: concurrent calls cannot overdraw; each admitted run holds its price', async () => {
  await withExternal(async (c) => {
    await listing(c, { agent_id: 'agent/sample', price: { per_run: 2 }, host_execution: true });
    const dev = await developer(c, 5);
    const results = await Promise.all(Array.from({ length: 6 }, () => chat(c, dev.key)));
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [200, 200, 402, 402, 402, 402], results.map((r) => r.body).join('\n'));
    assert.equal(await balance(c, dev.session), 1);
    const sum = c.gw.store.db
      .prepare('SELECT sum(amount) AS s FROM platform_ledger WHERE account_id=?')
      .get(dev.id)!.s;
    assert.equal(Number(sum), 1_000_000, 'balance equals the ledger');
  });
});

test('platform billing: cancelled and denied runs pay no per-run price; account keys cannot approve', async () => {
  await withExternal(async (c) => {
    await listing(c, { agent_id: 'agent/sample', price: { per_run: 2 }, host_execution: true });
    const dev = await developer(c, 5);
    const start = async () => {
      const r = await call(
        c,
        'POST',
        '/v1/responses',
        { model: 'agent/sample', input: 'please approve a write', background: true },
        dev.key,
      );
      assert.equal(r.statusCode, 200, r.body);
      const id = r.json().id as string;
      let actions: { id: string }[] = [];
      await waitFor(async () => {
        const run = (await call(c, 'GET', `/v1/runs/${id}`)).json();
        actions = run.actions ?? [];
        return run.status === 'requires_action' && actions.length > 0;
      }, 15_000);
      return { id, action: actions[0]!.id };
    };

    // Waiting for approval: the per-run price is held, not yet earned.
    const waiting = await start();
    assert.equal(await balance(c, dev.session), 3);
    // The account key cannot approve its own run's host action; only the owner can.
    const self = await call(
      c,
      'POST',
      `/v1/runs/${waiting.id}/actions/${waiting.action}`,
      { decision: 'approve' },
      dev.key,
    );
    assert.equal(self.statusCode, 403, self.body);
    assert.equal(self.json().error.code, 'scope_denied');
    // Cancelled by the developer: the hold is released, nothing is charged.
    const cancel = await call(c, 'POST', `/v1/responses/${waiting.id}/cancel`, {}, dev.key);
    assert.equal(cancel.statusCode, 200, cancel.body);
    let final = '';
    await waitFor(async () => {
      final = (await call(c, 'GET', `/v1/runs/${waiting.id}`)).json().status;
      return final === 'cancelled' || final === 'interrupted' || final === 'failed';
    }, 15_000);
    // Cancelled while the agent waits for approval: the native step has no confirmed outcome,
    // so the run ends `interrupted` (effect_outcome_unknown); either way no per-run charge.
    assert.equal(final, 'interrupted');
    await waitFor(async () => (await balance(c, dev.session)) === 5, 15_000);
    const row = (await call(c, 'GET', '/v1/portal/ledger', undefined, dev.session)).json().data[0];
    assert.equal(row.status, final);
    assert.equal(row.amount, 0);

    // The owner denies: an ACP run with a denied request fails (`permission_denied`), so only
    // tokens could be charged (this agent reports none) and the hold is released.
    const denied = await start();
    const deny = await call(c, 'POST', `/v1/runs/${denied.id}/actions/${denied.action}`, {
      decision: 'deny',
    });
    assert.equal(deny.statusCode, 200, deny.body);
    let deniedStatus = '';
    await waitFor(async () => {
      const run = (await call(c, 'GET', `/v1/runs/${denied.id}`)).json();
      deniedStatus = run.status;
      return !['queued', 'in_progress', 'requires_action'].includes(run.status);
    }, 15_000);
    assert.equal(deniedStatus, 'failed');
    assert.equal(
      (await call(c, 'GET', `/v1/runs/${denied.id}`)).json().error.code,
      'permission_denied',
    );
    await waitFor(async () => (await balance(c, dev.session)) === 5, 5_000);
  });
});

test('platform billing: a failed external run is not charged the per-run price', async () => {
  await withExternal(async (c) => {
    await listing(c, { agent_id: 'agent/sample', price: { per_run: 2 }, host_execution: true });
    const dev = await developer(c, 5);
    // Make the adapter fail to start: the run fails, its hold is released.
    const adapter = c.worker.adapters['oaa-sample']!;
    if (adapter.transport === 'acp') adapter.args = ['/nonexistent/sample-agent.mjs'];
    const r = await chat(c, dev.key);
    assert.notEqual(r.statusCode, 200, r.body);
    await waitFor(async () => (await balance(c, dev.session)) === 5, 15_000);
    const row = (await call(c, 'GET', '/v1/portal/ledger', undefined, dev.session)).json().data[0];
    assert.equal(row.kind, 'run');
    assert.equal(row.amount, 0);
    assert.notEqual(row.status, 'completed');
  });
});
