import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import {
  ERROR_CATALOG,
  isFallbackExempt,
  isRouteRetryable,
  isUncertainWhenStarted,
} from '../src/core/errors.js';
import { Fault } from '../src/core/util.js';
import { setup, FixtureModel, agent, principal, waitFor } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof setup>>;
const invoke = (body: Record<string, unknown>) => invocationSchema.parse(body);
/** 只在测试里触碰的内核内部：准入循环与入队。 */
const internals = (s: Fixture) =>
  s.kernel as unknown as {
    pump(): void;
    enqueue(runId: string): void;
    queue: string[];
    closing: boolean;
  };
const fallbackEvents = (s: Fixture, runId: string) =>
  s.store
    .history(runId)
    .filter((e) => e.type === 'run.queued' && e.data.reason === 'agent_fallback')
    .map((e) => `${e.data.from}->${e.data.to}`);

test('备选智能体：线路在节点上没有可用执行者时跳过，换到链上下一个可用的', async () => {
  const s = await setup(
    new FixtureModel((definition) => {
      if (definition.id === 'agent/down') throw new Fault('upstream_unavailable', 'down', 503);
      return { text: `by ${definition.id}` };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/down' })));
    // provider 在本机节点上不存在：没有任何执行者能跑它。
    s.store.publish('owner', makeBundle(agent({ id: 'agent/nowhere', provider: 'missing' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/last' })));
    const run = s.kernel.submit(
      principal,
      invoke({
        agent: 'agent/down',
        input: 'x',
        metadata: { 'oaa.agent_fallback': 'agent/nowhere,agent/last' },
      }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.agentId, 'agent/last');
    assert.equal(done.metadata['oaa.fallback_from'], 'agent/down');
    assert.deepEqual(fallbackEvents(s, run.id), ['agent/down->agent/last']);
  } finally {
    await s.cleanup();
  }
});

test('备选智能体：委托链超出密钥执行级别的候选被跳过（与提交时同样的完整检查）', async () => {
  const gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async (definition) => {
      if (definition.id === 'agent/down') {
        await gate.promise;
        throw new Fault('upstream_unavailable', 'down', 503);
      }
      return { text: `by ${definition.id}` };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/down' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/helper' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/parent', delegates: [{ name: 'ask_helper', agent: 'agent/helper' }] }),
      ),
    );
    s.store.publish('owner', makeBundle(agent({ id: 'agent/last' })));
    const limited = { ...principal, scopes: ['invoke', 'read'], execution: 'workspace' as const };
    const run = s.kernel.submit(
      limited,
      invoke({
        agent: 'agent/down',
        input: 'x',
        metadata: { 'oaa.agent_fallback': 'agent/parent,agent/last' },
      }),
    );
    await waitFor(() => s.driver.calls === 1);
    // 提交之后，被委托的智能体改成需要 host 权限的原生智能体。
    s.store.publish('owner', makeBundle(agent({ id: 'agent/helper', engine: 'codex' })));
    gate.resolve();
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.agentId, 'agent/last');
    assert.deepEqual(fallbackEvents(s, run.id), ['agent/down->agent/last']);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('关闭时在调度边界挂起的运行，与停车运行用同一个错误码 shutting_down', async () => {
  const gate = Promise.withResolvers<void>();
  let fixture: Fixture | undefined;
  const s = await setup(
    new FixtureModel(async (definition, messages) => {
      if (definition.id === 'agent/quick') return { text: 'quick' };
      if (messages.some((m) => m.role === 'tool')) return { text: 'done' };
      await gate.promise;
      // 模型轮次返回的那一刻网关开始关闭：随后在调度边界让出时，运行不能再回到队列。
      internals(fixture!).closing = true;
      return { calls: [{ id: 'c1', name: 'list_files', arguments: {} }] };
    }),
    { maxActiveRuns: 1 },
  );
  fixture = s;
  try {
    const { builtin } = await import('../src/lang/bundle.js');
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/long', tools: [builtin('list_files')] })),
    );
    s.store.publish('owner', makeBundle(agent({ id: 'agent/quick' })));
    const long = s.kernel.submit(principal, invoke({ agent: 'agent/long', input: 'x' }));
    await waitFor(() => s.driver.calls === 1);
    s.kernel.submit(principal, invoke({ agent: 'agent/quick', input: 'x' }));
    gate.resolve();
    await waitFor(() => !['queued', 'in_progress'].includes(s.store.run(long.id).status));
    const done = s.store.run(long.id);
    assert.equal(done.status, 'interrupted', JSON.stringify(done.error));
    assert.equal(done.error?.code, 'shutting_down');
  } finally {
    gate.resolve();
    internals(s).closing = false;
    await s.cleanup();
  }
});

test('准入：换人后的运行在旧任务清理前被再次 pump，不会重复登记或丢失任务登记', async () => {
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const s = await setup(
    new FixtureModel(async (definition) => {
      calls.push(definition.id);
      if (definition.id === 'agent/down') throw new Fault('upstream_unavailable', 'down', 503);
      await gate.promise;
      return { text: 'ok' };
    }),
    { maxActiveRuns: 2 },
  );
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/down' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/backup' })));
    const run = s.kernel.submit(
      principal,
      invoke({
        agent: 'agent/down',
        input: 'x',
        metadata: { 'oaa.agent_fallback': 'agent/backup' },
      }),
    );
    // 模拟同一事件循环里另一个运行结束：它的 .finally 会在旧任务清理之前调用 pump。
    s.store.events.on(run.id, (event) => {
      if (event.type === 'run.queued' && event.data.reason === 'agent_fallback')
        queueMicrotask(() => internals(s).pump());
    });
    await waitFor(() => calls.includes('agent/backup'));
    await new Promise((r) => setImmediate(r));
    const stats = s.kernel.stats();
    assert.equal(stats.active, 1);
    assert.equal(stats.executing, 1, 'the running execute keeps its task registration');
    gate.resolve();
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(
      s.store.history(run.id).filter((e) => e.type === 'response.in_progress').length,
      2,
    );
    assert.deepEqual(calls, ['agent/down', 'agent/backup']);
    assert.equal(s.kernel.stats().breaches, 0);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('准入：同一个运行不会重复入队', async () => {
  const s = await setup(new FixtureModel(), { maxActiveRuns: 1 });
  try {
    const k = internals(s);
    k.enqueue('resp_x');
    k.enqueue('resp_x');
    k.enqueue('resp_y');
    assert.deepEqual(
      k.queue.filter((id) => id.startsWith('resp_x') || id.startsWith('resp_y')),
      ['resp_x', 'resp_y'],
    );
    k.queue.length = 0;
  } finally {
    await s.cleanup();
  }
});

// 改动前三份手工名单的原样副本：新目录标记必须对每个错误码给出相同判断。
const OLD_ROUTE_RETRYABLE = [
  'upstream_rate_limited',
  'upstream_failed',
  'upstream_truncated',
  'node_disconnected',
  'work_timeout',
];
const OLD_FALLBACK_EXEMPT = new Set([
  'turn_limit',
  'token_budget',
  'max_output_tokens',
  'scope_denied',
  'isolation_required',
  'permission_denied',
  'output_too_large',
  'persistence_failed',
  'effect_outcome_unknown',
]);
const OLD_UNCERTAIN = ['node_disconnected', 'work_timeout', 'cancelled', 'execution_failed'];

test('三份错误码名单并入目录后，对每个错误码的判断与旧名单完全一致', () => {
  const codes = [...ERROR_CATALOG.map((e) => e.code), 'not_in_catalog', 'subagent_failed'];
  for (const code of codes) {
    assert.equal(isRouteRetryable(code), OLD_ROUTE_RETRYABLE.includes(code), code);
    assert.equal(isFallbackExempt(code), OLD_FALLBACK_EXEMPT.has(code), code);
    assert.equal(isUncertainWhenStarted(code), OLD_UNCERTAIN.includes(code), code);
  }
  for (const entry of ERROR_CATALOG)
    for (const flag of ['routeRetryable', 'fallbackExempt', 'uncertainWhenStarted'] as const)
      assert.ok(!(flag in entry) || entry[flag] === true, `${entry.code}.${flag} only when true`);
});
