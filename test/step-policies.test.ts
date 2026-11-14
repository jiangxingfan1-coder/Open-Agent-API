import test from 'node:test';
import assert from 'node:assert/strict';
import { executeGraph, parseGraph, type GraphStep } from '../src/lang/graph.js';
import { compileOaaLang, formatOaaLang } from '../src/lang/lang.js';
import { Fault, sleep } from '../src/core/util.js';
import { ApprovalSuspension } from '../src/core/suspension.js';
import type { Effect } from '../src/core/contracts.js';
import { setup, FixtureModel, agent, principal } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { capabilitySchema } from '../src/core/contracts.js';
import { invocationSchema } from '../src/gateway/protocol.js';

const tools = new Set(['lookup', 'save', 'other']);
const effects = new Map<string, Effect>([
  ['lookup', 'read'],
  ['other', 'idempotent-write'],
  ['save', 'write'],
]);
const graph = (step: Record<string, unknown>): GraphStep[] =>
  parseGraph({ steps: [{ id: 's', tool: 'lookup', arguments: {}, ...step }] }, tools, effects);
const live = () => new AbortController().signal;

test('retry：失败后按次数重试，成功就返回；次数用完才报错', async () => {
  let calls = 0;
  const out = await executeGraph(graph({ retry: { attempts: 2 } }), 1, live(), async () => {
    if (++calls < 3) throw new Fault('flaky', 'try again', 502);
    return { ok: calls };
  });
  assert.deepEqual(out.s, { ok: 3 });

  calls = 0;
  await assert.rejects(
    executeGraph(graph({ retry: { attempts: 1 } }), 1, live(), async () => {
      calls++;
      throw new Fault('flaky', 'still failing', 502);
    }),
    (e: Fault) => e.code === 'flaky',
  );
  assert.equal(calls, 2);
});

test('retry：等待间隔生效；重试用尽后才使用回退值', async () => {
  let calls = 0;
  const started = Date.now();
  const out = await executeGraph(
    graph({ retry: { attempts: 2, backoff_ms: 30 }, fallback: { value: 'fallback' } }),
    1,
    live(),
    async () => {
      calls++;
      throw new Fault('down', 'unavailable', 503);
    },
  );
  assert.equal(out.s, 'fallback');
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 55, 'two backoff waits should have elapsed');
});

test('retry：结果未知的副作用和等待审批都不会被重试或掩盖', async () => {
  let calls = 0;
  await assert.rejects(
    executeGraph(graph({ retry: { attempts: 3 }, fallback: { value: 1 } }), 1, live(), async () => {
      calls++;
      throw new Fault('execution_failed', 'outcome unknown', 502, true);
    }),
    (e: Fault) => e.uncertain === true,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    executeGraph(graph({ retry: { attempts: 3 } }), 1, live(), async () => {
      calls++;
      throw new ApprovalSuspension(['approval_1']);
    }),
    (e: unknown) => e instanceof ApprovalSuspension,
  );
  assert.equal(calls, 1);
});

test('timeout：超时会中止这一次尝试并报 step_timeout；可与重试组合', async () => {
  const aborted: boolean[] = [];
  await assert.rejects(
    executeGraph(graph({ timeout_ms: 100 }), 1, live(), async (_s, _a, signal) => {
      try {
        await sleep(5000, signal);
      } finally {
        aborted.push(signal.aborted);
      }
      return 'late';
    }),
    (e: Fault) =>
      e.code === 'step_timeout' && e.status === 504 && /'s' exceeded its 100 ms/.test(e.message),
  );
  assert.deepEqual(aborted, [true]);

  let calls = 0;
  const out = await executeGraph(
    graph({ timeout_ms: 100, retry: { attempts: 1 } }),
    1,
    live(),
    async (_s, _a, signal) => {
      if (++calls === 1) await sleep(5000, signal);
      return 'second attempt';
    },
  );
  assert.equal(out.s, 'second attempt');
  assert.equal(calls, 2);

  // 没超时的步骤不受影响，定时器也不会把后面的调用中止掉。
  const fast = await executeGraph(graph({ timeout_ms: 500 }), 1, live(), async () => 'fast');
  assert.equal(fast.s, 'fast');
});

test('timeout：整个运行被中止时不改写成步骤超时', async () => {
  const controller = new AbortController();
  const task = executeGraph(
    graph({ timeout_ms: 5000, retry: { attempts: 2 } }),
    1,
    controller.signal,
    async (_s, _a, signal) => {
      await sleep(5000, signal);
      return 'never';
    },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(task, (e: Fault) => e.code !== 'step_timeout');
});

test('校验：只允许用在只读或可安全重试的工具上，取值有上下限', () => {
  assert.doesNotThrow(() => graph({ tool: 'other', retry: { attempts: 1 }, timeout_ms: 1000 }));
  assert.throws(
    () => graph({ tool: 'save', retry: { attempts: 1 } }),
    (e: Fault) => e.code === 'unsafe_graph_retry',
  );
  assert.throws(
    () => graph({ tool: 'save', timeout_ms: 1000 }),
    (e: Fault) => e.code === 'unsafe_graph_retry',
  );
  assert.throws(
    () => graph({ tool: '$transform', arguments: { a: 1 }, retry: { attempts: 1 } }),
    (e: Fault) => e.code === 'invalid_graph',
  );
  assert.throws(() => graph({ retry: { attempts: 4 } }));
  assert.throws(() => graph({ retry: { attempts: 0 } }));
  assert.throws(() => graph({ timeout_ms: 50 }));
  assert.throws(() => graph({ retry: { attempts: 1, unknown: true } }));
});

const source = (modifiers: string) => `agent "agent/demo" {
  description = "demo"
  model = "m"
  provider = "p"
  use builtin [read_file, write_file]
  flow "load" {
    params { path: string }
    step doc = read_file(path = $input.path) ${modifiers}
  }
  instructions "x"
}`;

test('OAA-Lang：retry 与 timeout 修饰编译成步骤字段，格式化后保持等价', () => {
  const compiled = compileOaaLang(
    source('retry(2, backoff=200ms) timeout 30s fallback = "missing"'),
  );
  const step = compiled.agent.workflows![0]!.steps[0] as Record<string, unknown>;
  assert.deepEqual(step.retry, { attempts: 2, backoff_ms: 200 });
  assert.equal(step.timeout_ms, 30_000);
  assert.deepEqual(step.fallback, { value: 'missing' });

  const short = compileOaaLang(source('retry 1'));
  assert.deepEqual((short.agent.workflows![0]!.steps[0] as Record<string, unknown>).retry, {
    attempts: 1,
  });

  for (const modifiers of ['retry 1', 'retry(2, backoff=200ms) timeout 30s', 'timeout 1500ms']) {
    const formatted = formatOaaLang(source(modifiers));
    assert.deepEqual(compileOaaLang(formatted).agent, compileOaaLang(source(modifiers)).agent);
    assert.equal(formatOaaLang(formatted), formatted);
  }
  // 没有修饰时产物里不出现这两个字段。
  const plain = compileOaaLang(source('')).agent.workflows![0]!.steps[0] as Record<string, unknown>;
  assert.ok(!('retry' in plain) && !('timeout_ms' in plain));
});

test('OAA-Lang：写错或用在会修改的工具上时在编译期报错', () => {
  const failure = (text: string) => {
    try {
      compileOaaLang(text);
    } catch (e) {
      return String((e as Error).message);
    }
    throw new Error('expected a compile error');
  };
  assert.match(failure(source('retry 9')), /attempts|3/i);
  assert.match(
    failure(source('retry(1, bakoff=5ms)')),
    /Unknown retry option 'bakoff'\. Did you mean 'backoff'\?/,
  );
  assert.match(failure(source('retry 1 retry 2')), /Duplicate 'retry' modifier/);
  const unsafe = source('').replace(
    'step doc = read_file(path = $input.path) ',
    'step doc = write_file(path = $input.path, content = "x") retry 1',
  );
  // write_file 是「可安全重试的修改」，允许。
  assert.doesNotThrow(() => compileOaaLang(unsafe));
});

test('端到端：内核里的工作流步骤超时后重试成功，并留下可检查的步骤记录', async () => {
  let attempts = 0;
  const model = new FixtureModel(async (_a, messages) => {
    if (messages.some((m) => m.role === 'tool')) return { text: 'done' };
    return {
      calls: [
        {
          id: 'g',
          name: 'execute_graph',
          arguments: {
            steps: [
              {
                id: 'slow_then_ok',
                tool: 'flaky_lookup',
                arguments: { key: 'a' },
                timeout_ms: 150,
                retry: { attempts: 2 },
              },
            ],
          },
        },
      ],
    };
  });
  const s = await setup(model);
  try {
    const capability = capabilitySchema.parse({
      id: 'fixture/flaky-lookup',
      version: '1',
      description: 'Slow on the first attempt.',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
    });
    s.runtime.config.tools.push({
      reference: 'flaky_lookup',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('flaky_lookup', async (_args, _ctx, signal) => {
      if (++attempts === 1) await sleep(3000, signal);
      return { value: { attempt: attempts } };
    });
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [
            {
              name: 'flaky_lookup',
              capability,
              handler: { kind: 'node', reference: 'flaky_lookup' },
            },
          ],
        }),
      ),
    );
    const started = Date.now();
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'go', background: true }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.ok(attempts >= 2, `handler ran ${attempts} times`);
    assert.ok(Date.now() - started < 2500, 'the slow first attempt was abandoned at its timeout');
    const toolMessage = done.checkpoint.messages.find((m) => m.role === 'tool')!;
    assert.match(toolMessage.content, /"attempt":\s*[23]/);
  } finally {
    await s.cleanup();
  }
});
