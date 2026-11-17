import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundle } from '../src/lang/bundle.js';
import { setup, agent, FixtureModel, principal } from './helpers.js';
import { validateOrchestrationPlan } from '../src/kernel/orchestration.js';
import { sleep } from '../src/core/util.js';
import { RunTextSink } from '../src/kernel/text-sink.js';

const definition = () =>
  agent({
    id: 'agent/orchestrated',
    model: 'one',
    orchestration: { enabled: true, scope: 'agent' },
    routes: [
      { id: 'one', provider: 'fixture', model: 'one', priority: 0 },
      { id: 'two', provider: 'fixture', model: 'two', priority: 1 },
    ],
  });

test('planner output cannot widen model or helper grants', () => {
  const a = definition();
  const pools = new Map([[a.id, ['one', 'two']]]);
  const stage = { id: 'execute', role: 'execute', agent: a.id, model: 'two', task: 'work' };
  assert.equal(validateOrchestrationPlan({ stages: [stage] }, a, pools, 8).length, 1);
  assert.throws(() =>
    validateOrchestrationPlan({ stages: [{ ...stage, model: 'ungranted' }] }, a, pools, 8),
  );
  assert.throws(() =>
    validateOrchestrationPlan({ stages: [{ ...stage, agent: 'agent/other' }] }, a, pools, 8),
  );
  assert.throws(() => validateOrchestrationPlan({ stages: [stage, stage] }, a, pools, 8));
});

test('quality mode plans, executes on another model, reviews and keeps durable child evidence', async () => {
  const calls: string[] = [];
  const model = new FixtureModel((a, messages) => {
    const input = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    calls.push(a.model);
    if (input.startsWith('Plan this task;'))
      assert.ok(
        input.includes('[Response Format Requirement:'),
        'The actual schema must be included in the planning request.',
      );
    if (input.startsWith('Plan this task;'))
      return {
        text: JSON.stringify({
          stages: [
            {
              id: 'execute',
              role: 'execute',
              agent: a.id,
              model: 'two',
              task: 'Produce the requested result.',
            },
            { id: 'review', role: 'review', agent: a.id, model: 'one', task: 'Check the result.' },
          ],
        }),
      };
    if (input.startsWith('Review the completed task'))
      return {
        text: JSON.stringify({
          passed: true,
          summary: 'The fixture evidence satisfies the requirement.',
        }),
      };
    return { text: 'Completed with execution evidence.' };
  });
  const s = await setup(model);
  try {
    const a = definition();
    s.store.publish('owner', makeBundle(a));
    const submitted = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: a.id,
      model: 'auto',
      input:
        'Analyze this implementation in detail and produce a verified solution with a complete review of its behavior.'.repeat(
          3,
        ),
      file_ids: [],
      metadata: { 'oaa.routing_strategy': 'quality' },
      stream: false,
      background: false,
    });
    const result = await s.kernel.wait(submitted.id);
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.deepEqual(calls, ['one', 'two', 'one']);
    assert.equal(result.metadata['oaa.review'], 'passed');
    assert.equal(result.output.map((m) => m.text).join(''), 'Completed with execution evidence.');
    assert.equal(result.checkpoint.orchestration?.used, 3);
  } finally {
    await s.cleanup();
  }
});

test('an explicit model bypasses orchestration even when quality metadata is present', async () => {
  const s = await setup();
  try {
    const a = definition();
    s.store.publish('owner', makeBundle(a));
    const run = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: a.id,
      model: 'two',
      input: 'Keep this exact model.',
      file_ids: [],
      metadata: { 'oaa.routing_strategy': 'quality' },
      stream: false,
      background: false,
    });
    const result = await s.kernel.wait(run.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.route.model, 'two');
    assert.equal(result.checkpoint.orchestration, undefined);
    assert.equal(s.driver.calls, 1);
  } finally {
    await s.cleanup();
  }
});

test('a committed orchestration answer is not emitted a second time during recovery', async () => {
  const s = await setup(
    new FixtureModel((a, messages) =>
      messages.some((m) => m.content.startsWith('Plan this task;'))
        ? {
            text: JSON.stringify({
              stages: [
                { id: 'execute', role: 'execute', agent: a.id, model: 'one', task: 'Hello' },
              ],
            }),
          }
        : { text: 'Hello' },
    ),
  );
  try {
    s.store.publish('owner', makeBundle(definition()));
    const submitted = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: 'agent/orchestrated',
      model: 'auto',
      input: 'Hello',
      file_ids: [],
      metadata: {},
      stream: false,
      background: false,
    });
    const run = await s.kernel.wait(submitted.id);
    const count = s.store.history(run.id).length;
    const sink = new RunTextSink(
      s.store,
      run,
      () => false,
      (fault) => {
        throw fault;
      },
    );
    assert.deepEqual(sink.publishFinalOnce(run.checkpoint.orchestration!.finalText!), []);
    assert.equal(s.store.history(run.id).length, count);
    assert.equal(run.output.length, 1);
  } finally {
    await s.cleanup();
  }
});

test('short speed requests still plan; recommendation never executes the user task', async () => {
  const calls: string[] = [];
  const s = await setup(
    new FixtureModel((a, messages) => {
      const input = messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      calls.push(input);
      return {
        text: JSON.stringify({
          stages: [
            {
              id: 'execute',
              role: 'execute',
              agent: a.id,
              model: 'two',
              task: 'Do not execute this in recommendation mode.',
            },
          ],
        }),
      };
    }),
  );
  try {
    const a = definition();
    s.store.publish('owner', makeBundle(a));
    const run = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: a.id,
      model: 'auto',
      input: 'Hello',
      file_ids: [],
      metadata: { 'oaa.routing_strategy': 'speed', 'oaa.orchestration_action': 'recommend' },
      stream: false,
      background: false,
    });
    const result = await s.kernel.wait(run.id);
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.startsWith('Plan this task;'));
    assert.equal(JSON.parse(result.output.map((m) => m.text).join('')).executed, false);
    assert.equal(result.checkpoint.orchestration?.used, 1);
  } finally {
    await s.cleanup();
  }
});

test('agent-scoped orchestration cannot change agents even when a helper pool is supplied', () => {
  const a = agent({
    ...definition(),
    orchestration: { enabled: true, scope: 'agent', helpers: ['agent/helper'] },
  });
  assert.throws(() =>
    validateOrchestrationPlan(
      {
        stages: [
          { id: 'analyze', role: 'analyze', agent: 'agent/helper', model: 'one', task: 'Analyze' },
          { id: 'execute', role: 'execute', agent: a.id, model: 'one', task: 'Execute' },
        ],
      },
      a,
      new Map([
        [a.id, ['one']],
        ['agent/helper', ['one']],
      ]),
      8,
    ),
  );
});

test('new scoped modes appear in standard model lists and explicit selections still bypass planning', async () => {
  const s = await setup();
  try {
    const a = definition();
    s.store.publish('owner', makeBundle(a));
    const models = (await s.request('GET', '/v1/models'))
      .json()
      .data.map((m: { id: string }) => m.id);
    assert.ok(models.includes(`${a.id}@best`));
    assert.ok(models.includes(`${a.id}@two`));
    const result = await s.request('POST', '/v1/responses', {
      model: `${a.id}@two`,
      input: 'Hello',
    });
    assert.equal(result.statusCode, 200);
    assert.equal(s.driver.calls, 1);
  } finally {
    await s.cleanup();
  }
});

test('a recommendation with an incompatible output schema cannot fall through to execution', async () => {
  let calls = 0;
  const s = await setup(
    new FixtureModel((a) => {
      calls++;
      return {
        text: JSON.stringify({
          stages: [
            { id: 'execute', role: 'execute', agent: a.id, model: 'one', task: 'Do the task' },
          ],
        }),
      };
    }),
  );
  try {
    const a = definition();
    s.store.publish('owner', makeBundle(a));
    const run = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: a.id,
      model: 'auto',
      input: 'Hello',
      file_ids: [],
      stream: false,
      background: false,
      metadata: { 'oaa.orchestration_action': 'recommend' },
      output_contract: {
        kind: 'json_schema',
        schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    });
    const result = await s.kernel.wait(run.id);
    assert.equal(result.error?.code, 'structured_output_invalid');
    assert.equal(calls, 1);
    assert.equal(result.checkpoint.orchestration?.used, 1);
  } finally {
    await s.cleanup();
  }
});

test('independent analysis stages overlap at most two at a time, before the sole executor', async () => {
  let active = 0;
  let maximum = 0;
  const model = new FixtureModel(async (a, messages) => {
    const input = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    if (input.startsWith('Plan this task;'))
      return {
        text: JSON.stringify({
          stages: [
            {
              id: 'first',
              role: 'analyze',
              agent: a.id,
              model: 'one',
              task: 'Analyze first part.',
            },
            {
              id: 'second',
              role: 'analyze',
              agent: a.id,
              model: 'two',
              task: 'Analyze second part.',
            },
            {
              id: 'execute',
              role: 'execute',
              agent: a.id,
              model: 'one',
              task: 'Combine the evidence.',
            },
          ],
        }),
      };
    if (input.startsWith('Analyze only your assigned part.')) {
      active++;
      maximum = Math.max(maximum, active);
      await sleep(20);
      active--;
      return { text: 'Analysis evidence.' };
    }
    assert.equal(active, 0);
    return { text: 'Combined.' };
  });
  const s = await setup(model);
  try {
    const a = definition();
    s.store.publish('owner', makeBundle(a));
    const run = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: a.id,
      model: 'auto',
      input: 'Analyze two independent parts carefully and combine their conclusions.'.repeat(4),
      file_ids: [],
      metadata: {},
      stream: false,
      background: false,
    });
    const result = await s.kernel.wait(run.id);
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.equal(maximum, 2);
    assert.equal(result.checkpoint.orchestration?.used, 4);
  } finally {
    await s.cleanup();
  }
});

test('a negative review triggers a bounded correction and re-review, never a false success', async () => {
  let reviews = 0;
  let executions = 0;
  const s = await setup(
    new FixtureModel((a, messages) => {
      const input = messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      if (input.startsWith('Plan this task;'))
        return {
          text: JSON.stringify({
            stages: [
              { id: 'execute', role: 'execute', agent: a.id, model: 'two', task: 'Do the work.' },
              { id: 'review', role: 'review', agent: a.id, model: 'one', task: 'Verify.' },
            ],
          }),
        };
      if (input.startsWith('Review the completed task'))
        return {
          text: JSON.stringify({
            passed: ++reviews > 1,
            summary: reviews === 1 ? 'One required check is missing.' : 'Checked.',
            correction: 'Add the missing check.',
          }),
        };
      return { text: ++executions === 1 ? 'Initial result.' : 'Corrected result.' };
    }),
  );
  try {
    const a = definition();
    s.store.publish('owner', makeBundle(a));
    const run = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: a.id,
      model: 'auto',
      input: 'Produce and carefully verify the requested result.'.repeat(5),
      file_ids: [],
      metadata: { 'oaa.routing_strategy': 'quality' },
      stream: false,
      background: false,
    });
    const result = await s.kernel.wait(run.id);
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.equal(executions, 2);
    assert.equal(reviews, 2);
    assert.equal(result.checkpoint.orchestration?.used, 5);
    assert.equal(result.output.map((m) => m.text).join(''), 'Corrected result.');
  } finally {
    await s.cleanup();
  }
});
