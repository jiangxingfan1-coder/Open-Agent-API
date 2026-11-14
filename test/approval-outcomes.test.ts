// 审批被拒绝或运行在等待中结束时，等待中的步骤不能停在 pending。进程内。
import test from 'node:test';
import assert from 'node:assert/strict';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { setup, agent, FixtureModel, waitFor } from './helpers.js';

async function writer() {
  const tool = builtin('write_file');
  tool.capability.requiresApproval = true;
  const s = await setup(
    new FixtureModel((_a, m) =>
      m.some((x) => x.role === 'tool')
        ? { text: 'done' }
        : { calls: [{ id: 'w', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] },
    ),
    { approvalTimeoutMs: 30_000 },
  );
  s.store.publish('owner', makeBundle(agent({ tools: [tool] })));
  const parked = async () => {
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'write',
      background: true,
    });
    const runId = r.json().id as string;
    await waitFor(() => s.store.run(runId).status === 'requires_action');
    return { runId, action: s.store.approvals(runId)[0]! };
  };
  return { s, parked };
}

test('a denied approval fails the run and its waiting step', async () => {
  const { s, parked } = await writer();
  try {
    const { runId, action } = await parked();
    assert.deepEqual(
      s.store.steps(runId).map((x) => x.status),
      ['pending'],
    );
    const denied = await s.request('POST', `/v1/runs/${runId}/actions/${action.id}`, {
      decision: 'deny',
    });
    assert.equal(denied.statusCode, 200);
    const done = await s.kernel.wait(runId);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'permission_denied');
    const steps = s.store.steps(runId);
    assert.deepEqual(
      steps.map((x) => x.status),
      ['failed'],
    );
    assert.match(steps[0]!.error ?? '', /permission_denied|denied/);
  } finally {
    await s.cleanup();
  }
});

test('cancelling a parked run leaves no pending step behind', async () => {
  const { s, parked } = await writer();
  try {
    const { runId } = await parked();
    assert.equal((await s.request('POST', `/v1/responses/${runId}/cancel`)).statusCode, 200);
    await waitFor(() => s.store.run(runId).status === 'cancelled');
    assert.ok(s.store.steps(runId).every((x) => x.status !== 'pending'));
  } finally {
    await s.cleanup();
  }
});
