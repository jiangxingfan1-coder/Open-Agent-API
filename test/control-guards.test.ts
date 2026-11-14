import test from 'node:test';
import assert from 'node:assert/strict';
import { Fault } from '../src/core/util.js';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { agent, FixtureModel, principal, setup, token } from './helpers.js';

// 取消一个不在本进程执行的进行中运行要明确拒绝；调用方工具的待办
// 不论从哪个入口都不能人工批准（检查在 kernel.decide 里）。进程内，不监听端口。

const faultCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof Fault ? error.code : String(error);
  }
  return 'no error';
};

test('cancel: an in-progress run that this process does not execute is refused with 409', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const r = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi' });
    const run = s.store.run(r.json().id as string);
    assert.equal(run.status, 'completed');
    // As if another process held it: in progress here, but no local task or controller.
    s.store.db
      .prepare(
        "UPDATE runs SET status='in_progress',payload=json_set(payload,'$.status','in_progress') WHERE id=?",
      )
      .run(run.id);
    const cancelled = await s.request('POST', `/v1/responses/${run.id}/cancel`);
    assert.equal(cancelled.statusCode, 409, cancelled.body);
    assert.equal(cancelled.json().error.code, 'run_not_attached');
    assert.equal(s.store.run(run.id).status, 'in_progress', 'left unchanged');
  } finally {
    await s.cleanup();
  }
});

test('decide: a caller-tool action cannot be approved through kernel.decide either', async () => {
  const model = new FixtureModel((_a, messages) =>
    messages.some((m) => m.role === 'tool')
      ? { text: 'done' }
      : { text: 'Editing.', calls: [{ id: 'm1', name: 'edit_file', arguments: { path: 'a.ts' } }] },
  );
  const s = await setup(model);
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
    );
    const first = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      {
        model: 'agent/bridge',
        messages: [{ role: 'user', content: 'Fix the bug.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'edit-file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
      },
      token,
      { 'x-oaa-client-tools': 'bridge' },
    );
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    const action = s.store.approvals(runId).find((a) => a.status === 'pending');
    assert.equal(action?.kind, 'client_tool');
    assert.equal(
      faultCode(() => s.kernel.decide(principal, runId, action!.id, 'approve')),
      'action_kind_mismatch',
    );
    assert.equal(s.store.approvals(runId).find((a) => a.id === action!.id)?.status, 'pending');
    // The route reports the same code.
    const routed = await s.request('POST', `/v1/runs/${runId}/actions/${action!.id}`, {
      decision: 'deny',
    });
    assert.equal(routed.statusCode, 409);
    assert.equal(routed.json().error.code, 'action_kind_mismatch');
  } finally {
    await s.cleanup();
  }
});
