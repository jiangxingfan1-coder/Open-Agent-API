import test from 'node:test';
import assert from 'node:assert/strict';
import { token, waitFor } from './helpers.js';
import { balance, call, developer, listing, withExternal } from './platform-external-helpers.js';

// A streaming caller that disconnects mid-run: billing follows the run, not the connection. The
// gateway listens on an ephemeral 127.0.0.1 port (config host default, port 0) so a real socket
// can be closed; the agent is the offline sample agent.

test('platform billing: a stream closed mid-run is billed by how the run ends', async () => {
  await withExternal(async (c) => {
    await listing(c, { agent_id: 'agent/sample', price: { per_run: 2 }, host_execution: true });
    const dev = await developer(c, 5);
    const address = await c.gw.listen();
    assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
    const abort = new AbortController();
    const response = await fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'agent/sample',
        stream: true,
        // "approve" makes the sample agent wait for an approval, so the run outlives the stream.
        messages: [{ role: 'user', content: 'please approve a write' }],
      }),
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const runId = response.headers.get('x-run-id');
    assert.ok(runId, 'run id header');
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    // The disconnect does not cancel the task: it waits for the owner, the hold stays.
    let action = '';
    await waitFor(async () => {
      const run = (await call(c, 'GET', `/v1/runs/${runId}`)).json();
      action = run.actions?.[0]?.id ?? '';
      return run.status === 'requires_action' && action !== '';
    }, 15_000);
    assert.equal(await balance(c, dev.session), 3);
    const approve = await call(
      c,
      'POST',
      `/v1/runs/${runId}/actions/${action}`,
      { decision: 'approve' },
      token,
    );
    assert.equal(approve.statusCode, 200, approve.body);
    await waitFor(
      async () => (await call(c, 'GET', `/v1/runs/${runId}`)).json().status === 'completed',
      15_000,
    );
    // Completed after the caller left: charged once, the per-run price.
    await waitFor(async () => (await balance(c, dev.session)) === 3, 5_000);
    const ledger = (await call(c, 'GET', '/v1/portal/ledger', undefined, dev.session)).json().data;
    assert.equal(ledger.filter((e: { kind: string }) => e.kind === 'run').length, 1);
    assert.equal(ledger[0].status, 'completed');
    assert.equal(ledger[0].amount, -2);
  });
});
