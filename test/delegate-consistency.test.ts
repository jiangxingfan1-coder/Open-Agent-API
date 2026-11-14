// 委托一致性（T06a）：关机、取消、超时、子运行结果未知、并行委托、孤儿子运行。
// 全部离线：不监听端口，网关用 createGateway + 进程内本地节点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { makeBundle } from '../src/lang/bundle.js';
import { Fault, sleep } from '../src/core/util.js';
import type { Run } from '../src/core/contracts.js';
import type { Store } from '../src/store/store.js';
import { setup, FixtureModel, agent, principal, waitFor } from './helpers.js';

const invoke = (fields: Record<string, unknown>) =>
  invocationSchema.parse({ background: true, ...fields });

const childrenOf = (store: Store, parentId: string): Run[] =>
  store.allRuns().filter((r) => r.metadata?.['oaa.parent_run_id'] === parentId);

type Setup = Awaited<ReturnType<typeof setup>>;

/** 关掉网关，在同一个数据目录上重开一个（新的本地节点，同一个模型替身）。 */
async function reopen(s: Setup, driver: FixtureModel) {
  await s.app.close();
  const runtime = new WorkerRuntime(
    s.config.localWorker!,
    new Map(),
    new Map([['fixture', driver]]),
  );
  return createGateway(s.config, runtime);
}

/** boss 第一轮调用给定的委托工具，拿到工具结果后结束。 */
function bossTurn(calls: { id: string; name: string }[]) {
  return (messages: { role: string; content?: unknown }[]) =>
    messages.some((m) => m.role === 'tool')
      ? { text: 'boss done' }
      : { calls: calls.map((c) => ({ ...c, arguments: { task: `task for ${c.name}` } })) };
}

test('关机时父运行在等子运行：影响未知的委托步骤记为 uncertain，恢复被拦在人工确认，不会出现第二个子运行', async () => {
  let childCalls = 0;
  const driver = new FixtureModel(async (definition, messages, signal) => {
    if (definition.id === 'agent/boss') return bossTurn([{ id: 'c1', name: 'ask_u' }])(messages);
    childCalls++;
    if (childCalls === 1) await sleep(60_000, signal);
    return { text: 'child done' };
  });
  const s = await setup(driver);
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/leaf' })));
    // 带委托的子智能体：副作用等级为 unknown。
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/u', delegates: [{ name: 'ask_leaf', agent: 'agent/leaf' }] })),
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/boss', delegates: [{ name: 'ask_u', agent: 'agent/u' }] })),
    );
    const run = s.kernel.submit(principal, invoke({ agent: 'agent/boss', input: 'go' }));
    await waitFor(() => childrenOf(s.store, run.id).some((c) => c.status === 'in_progress'));
    replacement = await reopen(s, driver);
    let resumeError: unknown;
    try {
      replacement.kernel.resume(principal, run.id);
      await replacement.kernel.wait(run.id);
    } catch (error) {
      resumeError = error;
    }
    assert.equal(childrenOf(replacement.store, run.id).length, 1, 'no second child run');
    assert.equal((resumeError as Fault | undefined)?.code, 'reconciliation_required');
    const parent = replacement.store.run(run.id);
    assert.equal(parent.status, 'interrupted');
    assert.equal(parent.error?.code, 'effect_outcome_unknown');
    const step = replacement.store.steps(run.id).find((x) => x.name === 'ask_u')!;
    assert.equal(step.effect, 'unknown');
    assert.equal(step.status, 'uncertain');
    assert.equal(step.childRunId, childrenOf(replacement.store, run.id)[0]!.id);
  } finally {
    await replacement?.app.close();
    await s.cleanup();
  }
});

test('只读委托在恢复时复用已完成的子运行结果，用量只累加一次，不再新建子运行', async () => {
  let childCalls = 0;
  const driver = new FixtureModel(async (definition, messages, signal) => {
    if (definition.id === 'agent/boss')
      return bossTurn([{ id: 'c1', name: 'ask_reader' }])(messages);
    childCalls++;
    if (childCalls === 1) await sleep(60_000, signal);
    return {
      text: 'reader result',
      usage: { input_tokens: 70, output_tokens: 30, total_tokens: 100 },
    };
  });
  const s = await setup(driver);
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/reader' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/boss', delegates: [{ name: 'ask_reader', agent: 'agent/reader' }] }),
      ),
    );
    const run = s.kernel.submit(principal, invoke({ agent: 'agent/boss', input: 'go' }));
    await waitFor(() => childrenOf(s.store, run.id).some((c) => c.status === 'in_progress'));
    replacement = await reopen(s, driver);
    const [child] = childrenOf(replacement.store, run.id);
    assert.equal(child?.status, 'interrupted');
    // 操作员先把子运行恢复完成，再恢复父运行：父运行应直接取用这个子运行的结果。
    replacement.kernel.resume(principal, child.id);
    const finishedChild = await replacement.kernel.wait(child.id);
    assert.equal(finishedChild.status, 'completed');
    const before = replacement.store.run(run.id).usage?.total_tokens ?? 0;
    replacement.kernel.resume(principal, run.id);
    const done = await replacement.kernel.wait(run.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(childrenOf(replacement.store, run.id).length, 1, 'no second child run');
    const step = replacement.store.steps(run.id).find((x) => x.name === 'ask_reader')!;
    assert.equal(step.status, 'completed');
    assert.equal((step.result?.value as { run_id?: string }).run_id, child.id);
    // 父运行恢复后的一轮（15）+ 子运行（100，只算一次）。
    assert.equal(done.usage?.total_tokens, before + 15 + (finishedChild.usage?.total_tokens ?? 0));
  } finally {
    await replacement?.app.close();
    await s.cleanup();
  }
});

test('子运行以结果未知结束：父运行进入 interrupted / effect_outcome_unknown，步骤为 uncertain', async () => {
  const driver = new FixtureModel(async (_definition, messages) =>
    bossTurn([{ id: 'c1', name: 'ask_ext' }])(messages),
  );
  const s = await setup(driver);
  try {
    s.hub.addLocal(
      {
        nodeId: 'external-fixture',
        owner: 'owner',
        token: 'fixture',
        agents: ['*'],
        capabilities: ['*'],
      },
      {
        advertisement: () => ({
          nodeId: 'external-fixture',
          providers: [],
          natives: ['adapter/uncertain-fixture'],
          capabilities: [],
          warm: [],
          concurrency: 1,
        }),
        install: async () => {},
        close: async () => {},
        execute: async () => {
          throw new Fault('native_incomplete', 'The external agent stopped mid-way.', 502, true);
        },
      },
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/ext', engine: 'adapter/uncertain-fixture', model: 'default' })),
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/boss', delegates: [{ name: 'ask_ext', agent: 'agent/ext' }] })),
    );
    const run = s.kernel.submit(principal, invoke({ agent: 'agent/boss', input: 'go' }));
    const done = await s.kernel.wait(run.id);
    const [child] = childrenOf(s.store, run.id);
    assert.equal(child?.status, 'interrupted');
    assert.equal(child?.error?.code, 'effect_outcome_unknown');
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error?.code, 'effect_outcome_unknown');
    const step = s.store.steps(run.id).find((x) => x.name === 'ask_ext')!;
    assert.equal(step.status, 'uncertain');
    assert.equal(step.childRunId, child.id);
  } finally {
    await s.cleanup();
  }
});

for (const maxActiveRuns of [1, 2]) {
  test(`并行委托（maxActiveRuns = ${maxActiveRuns}）：一个父运行只借出一个名额，执行中的运行数符合不变量`, async () => {
    const violations: string[] = [];
    let s!: Setup;
    const sample = () => {
      const st = s.kernel.stats();
      if (st.active < 0 || st.active > maxActiveRuns || st.executing > maxActiveRuns + st.lent)
        violations.push(JSON.stringify(st));
    };
    const driver = new FixtureModel(async (definition, messages) => {
      sample();
      if (definition.id === 'agent/boss')
        return bossTurn([
          { id: 'c1', name: 'ask_a' },
          { id: 'c2', name: 'ask_b' },
        ])(messages);
      await sleep(30);
      sample();
      return { text: `${definition.id} done` };
    });
    s = await setup(driver, { maxActiveRuns });
    const timer = setInterval(sample, 1);
    try {
      s.store.publish('owner', makeBundle(agent({ id: 'agent/reader' })));
      s.store.publish(
        'owner',
        makeBundle(
          agent({
            id: 'agent/boss',
            delegates: [
              { name: 'ask_a', agent: 'agent/reader' },
              { name: 'ask_b', agent: 'agent/reader' },
            ],
          }),
        ),
      );
      const runs = [1, 2].map(() =>
        s.kernel.submit(principal, invoke({ agent: 'agent/boss', input: 'go' })),
      );
      for (const run of runs) {
        const done = await s.kernel.wait(run.id);
        assert.equal(done.status, 'completed', JSON.stringify(done.error));
        assert.equal(childrenOf(s.store, run.id).length, 2);
      }
      await waitFor(() => s.kernel.stats().executing === 0);
      sample();
      assert.deepEqual(violations, []);
      const st = s.kernel.stats();
      assert.equal(st.active, 0);
      assert.equal(st.queued, 0);
      assert.equal(st.lent, 0);
      assert.equal(st.breaches, 0);
    } finally {
      clearInterval(timer);
      await s.cleanup();
    }
  });
}

test('重启后，父运行已经不活跃的排队子运行不会被执行（cancelled / parent_interrupted）', async () => {
  const driver = new FixtureModel(() => ({ text: 'ran' }));
  const s = await setup(driver);
  let replacement: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/reader' })));
    const template = await s.kernel.wait(
      s.kernel.submit(principal, invoke({ agent: 'agent/reader', input: 'template' })).id,
    );
    const seed = (fields: Partial<Run>): Run => ({
      ...structuredClone(template),
      output: [],
      usage: null,
      error: null,
      checkpoint: { messages: [{ role: 'user', content: 'seeded' }], phase: 'model', turn: 0 },
      ...fields,
      sessionId: `session_${fields.id}`,
    });
    s.store.createRun(seed({ id: 'resp_seed_parent', status: 'interrupted' }));
    s.store.createRun(
      seed({
        id: 'resp_seed_orphan',
        status: 'queued',
        metadata: { 'oaa.parent_run_id': 'resp_seed_parent', 'oaa.delegate_name': 'ask_reader' },
      }),
    );
    // 对照：父运行仍在排队的子运行、普通排队运行，重启后照常执行。
    s.store.createRun(seed({ id: 'resp_seed_live_parent', status: 'queued' }));
    s.store.createRun(
      seed({
        id: 'resp_seed_live_child',
        status: 'queued',
        metadata: { 'oaa.parent_run_id': 'resp_seed_live_parent' },
      }),
    );
    const callsBefore = driver.calls;
    replacement = await reopen(s, driver);
    // 网关在 listen() 之后才调用 start() 恢复排队运行；离线测试直接调用。
    replacement.kernel.start();
    const orphan = replacement.store.run('resp_seed_orphan');
    assert.equal(orphan.status, 'cancelled');
    assert.equal(orphan.error?.code, 'parent_interrupted');
    assert.equal((await replacement.kernel.wait('resp_seed_live_parent')).status, 'completed');
    assert.equal((await replacement.kernel.wait('resp_seed_live_child')).status, 'completed');
    assert.equal(driver.calls, callsBefore + 2);
    assert.equal(replacement.store.run('resp_seed_orphan').status, 'cancelled');
  } finally {
    await replacement?.app.close();
    await s.cleanup();
  }
});

test('委托超时：步骤与父运行的错误码是 delegate_timeout，子运行被取消', async () => {
  const driver = new FixtureModel(async (definition, messages, signal) => {
    if (definition.id === 'agent/boss') return bossTurn([{ id: 'c1', name: 'ask_slow' }])(messages);
    await sleep(60_000, signal);
    return { text: 'too late' };
  });
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/slow' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/boss',
          delegates: [{ name: 'ask_slow', agent: 'agent/slow', timeoutMs: 100 }],
        }),
      ),
    );
    const run = s.kernel.submit(principal, invoke({ agent: 'agent/boss', input: 'go' }));
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'delegate_timeout');
    const step = s.store.steps(run.id).find((x) => x.name === 'ask_slow')!;
    assert.equal(step.status, 'failed');
    assert.equal(step.error, 'delegate_timeout');
    const [child] = childrenOf(s.store, run.id);
    await waitFor(() => s.store.run(child!.id).status === 'cancelled');
  } finally {
    await s.cleanup();
  }
});

test('父运行被取消时，等待中的委托把子运行一并取消，父运行以 cancelled 结束', async () => {
  const driver = new FixtureModel(async (definition, messages, signal) => {
    if (definition.id === 'agent/boss') return bossTurn([{ id: 'c1', name: 'ask_slow' }])(messages);
    await sleep(60_000, signal);
    return { text: 'too late' };
  });
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/slow' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/boss', delegates: [{ name: 'ask_slow', agent: 'agent/slow' }] }),
      ),
    );
    const run = s.kernel.submit(principal, invoke({ agent: 'agent/boss', input: 'go' }));
    await waitFor(() => childrenOf(s.store, run.id).some((c) => c.status === 'in_progress'));
    const done = await s.kernel.cancel(principal, run.id);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.error?.code, 'cancelled');
    const [child] = childrenOf(s.store, run.id);
    await waitFor(() => s.store.run(child!.id).status === 'cancelled');
    // 只读子智能体：等待被中断时步骤记 failed（不需要人工确认）。
    assert.equal(s.store.steps(run.id).find((x) => x.name === 'ask_slow')?.status, 'failed');
  } finally {
    await s.cleanup();
  }
});
