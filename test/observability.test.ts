import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitySchema, type ToolBinding } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { buildTimeline, type Timeline, type TimelineInput } from '../src/gateway/timeline.js';
import {
  activityFrame,
  computeActivity,
  SummaryWindow,
  TimelineCache,
} from '../src/gateway/activity.js';
import { GATEWAY_FEATURES } from '../src/gateway/server.js';
import { sleep } from '../src/core/util.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { workerSchema } from '../src/config/config.js';
import path from 'node:path';
import {
  agent,
  FixtureModel,
  principal,
  researchBundle,
  researchFixture,
  secondToken,
  setup,
  token,
  waitFor,
} from './helpers.js';

const second = { ...principal, owner: 'second' };
const submit = (p: typeof principal, agentId: string, input: string) =>
  invocationSchema.parse({ agent: agentId, input, background: true });
function checkShape(timeline: Timeline) {
  const ids = new Set(timeline.spans.map((s) => s.id));
  for (const span of timeline.spans) {
    for (const dep of span.depends_on) assert.ok(ids.has(dep), `${span.id} depends on ${dep}`);
    assert.ok(span.end_ms === null || span.end_ms >= span.start_ms, span.id);
    assert.ok(span.lane >= 0);
  }
  const b = timeline.breakdown_ms;
  assert.equal(b.queue + b.model + b.tools + b.approval + b.other, timeline.total_ms);
  assert.ok(timeline.critical_path_ms <= timeline.total_ms);
  assert.ok(timeline.spans.length <= 200);
}

test('run timeline: queue, model turns, parallel tools, graph, critical path and 304', async () => {
  const s = await setup(researchFixture());
  try {
    s.store.publish('owner', researchBundle());
    const files = [];
    for (let i = 0; i < 3; i++)
      files.push(
        (
          await s.request('POST', '/v1/files', { filename: `source-${i}.txt`, content: `S${i}` })
        ).json().id,
      );
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/research',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Create a report.' },
            ...files.map((file_id: string) => ({ type: 'input_file', file_id })),
          ],
        },
      ],
    });
    assert.equal(r.json().status, 'completed', r.body);
    const res = await s.request('GET', `/v1/runs/${r.json().id}/timeline`);
    assert.equal(res.statusCode, 200);
    const tl = res.json() as Timeline;
    checkShape(tl);
    assert.equal(tl.status, 'completed');
    assert.equal(typeof tl.ended_at, 'number');
    assert.equal(tl.truncated, false);
    assert.equal(tl.last_event_id, s.store.lastEventId(r.json().id));
    const models = tl.spans.filter((s) => s.kind === 'model');
    assert.deepEqual(
      models.map((m) => m.ref.turn),
      [1, 2, 3, 4],
    );
    assert.ok(models.every((m) => m.lane === 0 && m.status === 'completed' && m.critical));
    assert.equal(tl.spans[0]!.kind, 'queue');
    assert.equal(tl.spans[0]!.label, 'admission');
    const tools = tl.spans.filter((s) => s.kind === 'tool');
    assert.deepEqual(tools.map((t) => t.label).sort(), [
      'list_files',
      'read_file',
      'read_file',
      'read_file',
      'read_skill',
      'write_file',
    ]);
    assert.ok(tools.every((t) => t.lane >= 1 && typeof t.ref.step_id === 'string'));
    // Lanes never hold overlapping spans (very fast parallel calls may legitimately share one);
    // each call depends on its requesting turn.
    const graph = tools.filter((t) => t.label === 'read_file');
    for (const x of tools)
      for (const y of tools)
        if (x !== y && x.lane === y.lane)
          assert.ok(x.end_ms! <= y.start_ms || y.end_ms! <= x.start_ms, `${x.id}/${y.id} overlap`);
    const turn2 = models[1]!;
    assert.ok(graph.every((t) => t.depends_on.includes(turn2.id)));
    const turn3 = models[2]!;
    for (const t of graph)
      assert.ok(turn3.depends_on.includes(t.id), 'next turn waits for the batch');
    assert.equal(tools.filter((t) => t.critical).length, 3, 'one tool per batch is critical');
    assert.ok(tl.breakdown_ms.tools > 0 && tl.breakdown_ms.model > 0);
    const etag = String(res.headers.etag);
    assert.match(etag, /^W\/"tl\.\d+\.completed"$/);
    const cached = await s.request(
      'GET',
      `/v1/runs/${r.json().id}/timeline`,
      undefined,
      undefined,
      {
        'if-none-match': etag,
      },
    );
    assert.equal(cached.statusCode, 304);
    assert.equal(
      (await s.request('GET', `/v1/runs/${r.json().id}/timeline`, undefined, secondToken))
        .statusCode,
      404,
    );
    const limited = (
      await s.request('POST', '/v1/keys', {
        name: 'other',
        agents: ['agent/other'],
        scopes: ['read'],
        data_scope: 'owner',
      })
    ).json();
    assert.equal(
      (await s.request('GET', `/v1/runs/${r.json().id}/timeline`, undefined, limited.token))
        .statusCode,
      403,
    );
  } finally {
    await s.cleanup();
  }
});

test('approval round-trips appear as approval and re-admission spans the tool depends on', async () => {
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'done' }
        : { calls: [{ id: 'guard', name: 'guarded', arguments: {} }] },
    ),
    { approvalTimeoutMs: 10_000 },
  );
  try {
    const capability = capabilitySchema.parse({
      id: 'fixture/guarded',
      version: '1',
      description: 'Approval fixture',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'write',
      requiresApproval: true,
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'guarded',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('guarded', async () => ({ value: 'written' }));
    const binding: ToolBinding = {
      name: 'guarded',
      capability,
      handler: { kind: 'node', reference: 'guarded' },
    };
    s.store.publish('owner', makeBundle(agent({ tools: [binding] })));
    const run = s.kernel.submit(principal, submit(principal, 'agent/test', 'go'));
    await waitFor(() => s.store.approvals(run.id).length === 1);
    await waitFor(() => s.store.run(run.id).status === 'requires_action');
    const pending = (await s.request('GET', `/v1/runs/${run.id}/timeline`)).json() as Timeline;
    const waiting = pending.spans.find((sp) => sp.kind === 'approval')!;
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.end_ms, null);
    assert.equal(pending.ended_at, null);
    s.kernel.decide(principal, run.id, s.store.approvals(run.id)[0]!.id, 'approve');
    assert.equal((await s.kernel.wait(run.id)).status, 'completed');
    const tl = (await s.request('GET', `/v1/runs/${run.id}/timeline`)).json() as Timeline;
    checkShape(tl);
    const approval = tl.spans.find((sp) => sp.kind === 'approval')!;
    assert.equal(approval.status, 'completed');
    assert.equal(approval.label, 'guarded');
    assert.equal(approval.lane, 0);
    const readmit = tl.spans.find((sp) => sp.kind === 'queue' && sp.label === 'approval');
    assert.ok(readmit, 'the run is re-admitted after approval');
    const tool = tl.spans.find((sp) => sp.kind === 'tool' && sp.label === 'guarded')!;
    assert.ok(tool.depends_on.includes(approval.id));
    assert.equal(tool.ref.step_id, approval.ref.step_id);
    assert.ok(tl.breakdown_ms.approval > 0);
  } finally {
    await s.cleanup();
  }
});

const at = (base: number, spec: [number, string, Record<string, unknown>?][]) =>
  spec.map(([offset, type, data], i) => ({
    id: i + 1,
    type,
    time: base + offset,
    data: data ?? {},
  }));
const input = (overrides: Partial<TimelineInput>): TimelineInput => ({
  id: 'resp_fixture',
  status: 'completed',
  createdAt: 1_000_000,
  engine: 'kernel',
  marks: [],
  events: [],
  steps: [],
  lastEventId: 0,
  now: 1_100_000,
  ...overrides,
});

test('native timelines split node waiting and approvals out of agent execution', () => {
  const base = 1_000_000;
  const tl = buildTimeline(
    input({
      engine: 'adapter/gemini',
      events: at(base, [
        [0, 'response.created'],
        [5, 'response.in_progress'],
        [
          100,
          'run.requires_action',
          {
            approval: {
              id: 'approval_1',
              stepId: 'native:a',
              kind: 'native',
              detail: { native: 'acp' },
            },
          },
        ],
        [300, 'approval.resolved', { approval_id: 'approval_1', decision: 'approve' }],
        [400, 'response.completed'],
      ]),
      steps: [
        {
          id: 'native_resp_fixture',
          callId: 'native',
          name: 'adapter/gemini',
          status: 'completed',
          startedAt: base + 50,
        },
      ],
      lastEventId: 5,
    }),
  );
  checkShape(tl);
  assert.deepEqual(
    tl.spans.map((s) => [s.kind, s.label, s.start_ms, s.end_ms, s.lane, s.critical]),
    [
      ['queue', 'admission', 0, 5, 0, true],
      ['queue', 'node', 5, 50, 0, true],
      ['native', 'adapter/gemini', 50, 100, 0, true],
      ['approval', 'acp', 100, 300, 0, true],
      ['native', 'adapter/gemini', 300, 400, 0, true],
    ],
  );
  assert.deepEqual(tl.breakdown_ms, { queue: 50, model: 150, tools: 0, approval: 200, other: 0 });
  assert.equal(tl.critical_path_ms, 400);
});

test('runs recorded before model marks get estimated model spans around tool batches', () => {
  const base = 1_000_000;
  const tl = buildTimeline(
    input({
      events: at(base, [
        [0, 'response.created'],
        [2, 'response.in_progress'],
        [20, 'tool.queued', { step_id: 'step_a', tool: 'lookup' }],
        [20, 'tool.started', { step_id: 'step_a' }],
        [50, 'tool.completed', { step_id: 'step_a' }],
        [80, 'response.completed'],
      ]),
      steps: [{ id: 'step_a', callId: 'call_a', name: 'lookup', status: 'completed' }],
    }),
  );
  checkShape(tl);
  const models = tl.spans.filter((s) => s.kind === 'model');
  assert.deepEqual(
    models.map((m) => [m.start_ms, m.end_ms, m.estimated]),
    [
      [2, 20, true],
      [50, 80, true],
    ],
  );
  assert.equal(tl.spans.find((s) => s.kind === 'tool')!.lane, 1);
  assert.deepEqual(tl.breakdown_ms, { queue: 2, model: 48, tools: 30, approval: 0, other: 0 });
});

test('interruption gaps, still-running work and truncation are represented explicitly', () => {
  const base = 1_000_000;
  const resumed = buildTimeline(
    input({
      events: at(base, [
        [0, 'response.created'],
        [1, 'response.in_progress'],
        [50, 'run.interrupted'],
        [200, 'response.in_progress'],
        [260, 'response.completed'],
      ]),
      marks: [
        { turn: 1, attempt: 0, route: 'default', start: base + 2 },
        {
          turn: 1,
          attempt: 0,
          route: 'default',
          start: base + 210,
          end: base + 250,
          status: 'completed',
        },
      ],
    }),
  );
  checkShape(resumed);
  assert.deepEqual(
    resumed.spans.map((s) => [s.kind, s.start_ms, s.end_ms, s.status]),
    [
      ['queue', 0, 1, 'completed'],
      ['model', 2, 50, 'cancelled'],
      ['interrupted', 50, 200, 'completed'],
      ['model', 210, 250, 'completed'],
    ],
  );
  const running = buildTimeline(
    input({
      status: 'in_progress',
      now: base + 500,
      events: at(base, [
        [0, 'response.created'],
        [3, 'response.in_progress'],
      ]),
      marks: [{ turn: 1, attempt: 0, route: 'default', start: base + 4, dispatched: base + 30 }],
    }),
  );
  checkShape(running);
  assert.equal(running.ended_at, null);
  assert.equal(running.total_ms, 500);
  assert.deepEqual(
    running.spans.map((s) => [s.kind, s.label, s.end_ms, s.status]),
    [
      ['queue', 'admission', 3, 'completed'],
      ['queue', 'node', 30, 'completed'],
      ['model', 'default', null, 'running'],
    ],
  );
  const events = [
    ...at(base, [
      [0, 'response.created'],
      [1, 'response.in_progress'],
    ]),
  ];
  const steps = [];
  for (let i = 0; i < 300; i++) {
    const t = 10 + i * 3;
    events.push(
      {
        id: events.length + 1,
        type: 'tool.queued',
        time: base + t,
        data: { step_id: `step_${i}`, tool: 'lookup' },
      },
      {
        id: events.length + 2,
        type: 'tool.started',
        time: base + t,
        data: { step_id: `step_${i}` },
      },
      {
        id: events.length + 3,
        type: 'tool.completed',
        time: base + t + 2,
        data: { step_id: `step_${i}` },
      },
    );
    steps.push({ id: `step_${i}`, callId: `c${i}`, name: 'lookup', status: 'completed' });
  }
  events.push({ id: events.length + 1, type: 'response.completed', time: base + 1000, data: {} });
  const big = buildTimeline(
    input({
      events,
      steps,
      marks: [
        { turn: 1, attempt: 0, route: 'r', start: base + 2, end: base + 9, status: 'completed' },
      ],
    }),
  );
  assert.equal(big.truncated, true);
  assert.equal(big.spans.length, 200);
  checkShape(big);
  assert.ok(big.spans.some((s) => s.critical));
});

test('activity pulse: UTC buckets, totals, success rate, latency, agents, breakdown and 304', async () => {
  let gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async (_a, messages, signal) => {
      const text = messages.at(-1)?.content ?? '';
      if (text.includes('fail')) throw new Error('fixture failure');
      if (text.includes('block')) {
        await Promise.race([
          gate.promise,
          new Promise((_r, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        ]);
      }
      return { text: 'ok' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/other' })));
    for (const text of ['a', 'b', 'c'])
      await s.kernel.wait(s.kernel.submit(principal, submit(principal, 'agent/test', text)).id);
    await s.kernel.wait(s.kernel.submit(principal, submit(principal, 'agent/test', 'fail')).id);
    const blocked = s.kernel.submit(principal, submit(principal, 'agent/other', 'block'));
    await waitFor(() => s.store.run(blocked.id).status === 'in_progress');
    await s.kernel.cancel(principal, blocked.id);
    const res = await s.request('GET', '/v1/overview/activity');
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.window, '24h');
    assert.equal(body.bucket_ms, 3_600_000);
    assert.equal(body.buckets.length, 24);
    const starts = body.buckets.map((b: { start: string }) => Date.parse(b.start));
    assert.ok(
      starts.every(
        (t: number, i: number) =>
          t % 3_600_000 === 0 && (i === 0 || t - starts[i - 1] === 3_600_000),
      ),
    );
    assert.equal(
      starts.at(-1),
      activityFrame('24h', Date.parse(body.generated_at)).start + 23 * 3_600_000,
    );
    const sum = (k: string) =>
      body.buckets.reduce((n: number, b: Record<string, number>) => n + b[k]!, 0);
    assert.deepEqual(
      {
        started: body.totals.started,
        completed: body.totals.completed,
        failed: body.totals.failed,
        cancelled: body.totals.cancelled,
        active: body.totals.active,
      },
      { started: 5, completed: 3, failed: 1, cancelled: 1, active: 0 },
    );
    for (const k of ['started', 'completed', 'failed', 'cancelled', 'interrupted', 'active'])
      assert.equal(sum(k), body.totals[k], k);
    assert.equal(body.totals.success_rate, 0.75, 'completed / (completed + failed + interrupted)');
    assert.equal(body.latency_ms.samples, 5);
    assert.ok(body.latency_ms.p50 <= body.latency_ms.p95);
    assert.equal(body.breakdown_ms.runs, 5);
    assert.deepEqual(body.agents[0], {
      agent: 'agent/test',
      runs: 4,
      completed: 3,
      failed: 1,
      p50_ms: body.agents[0].p50_ms,
    });
    assert.equal(body.agents[1].agent, 'agent/other');
    // The activity revision follows runs only, so it never runs ahead of the overview revision.
    assert.ok(body.revision <= (await s.request('GET', '/v1/overview')).json().revision);
    const etag = String(res.headers.etag);
    assert.match(etag, /^W\/"act\.\d+\.[a-f0-9]{16}"$/);
    const cached = await s.request('GET', '/v1/overview/activity', undefined, undefined, {
      'if-none-match': etag,
    });
    assert.equal(cached.statusCode, 304);
    // Catalog and node churn advance the overview but leave the pulse (and its ETag) untouched.
    const overviewBefore = (await s.request('GET', '/v1/overview')).json().revision;
    s.store.publish('owner', makeBundle(agent({ id: 'agent/churn' })));
    assert.ok((await s.request('GET', '/v1/overview')).json().revision > overviewBefore);
    const afterChurn = await s.request('GET', '/v1/overview/activity', undefined, undefined, {
      'if-none-match': etag,
    });
    assert.equal(afterChurn.statusCode, 304, 'a publication does not invalidate activity');
    const week = (await s.request('GET', '/v1/overview/activity?window=7d')).json();
    assert.equal(week.buckets.length, 28);
    assert.equal(week.bucket_ms, 21_600_000);
    assert.ok(week.buckets.every((b: { start: string }) => Date.parse(b.start) % 21_600_000 === 0));
    assert.notEqual((await s.request('GET', '/v1/overview/activity?window=7d')).headers.etag, etag);
    const bad = await s.request('GET', '/v1/overview/activity?window=1y');
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'invalid_request');
    const limited = (
      await s.request('POST', '/v1/keys', {
        name: 'other',
        agents: ['agent/other'],
        scopes: ['read'],
        data_scope: 'owner',
      })
    ).json();
    const scoped = (
      await s.request('GET', '/v1/overview/activity', undefined, limited.token)
    ).json();
    assert.equal(scoped.totals.started, 1);
    assert.equal(scoped.totals.success_rate, null, 'cancellation is not a settled outcome');
    assert.equal(
      (await s.request('GET', '/v1/overview/activity', undefined, secondToken)).json().totals
        .started,
      0,
    );
    gate.resolve();
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('queue insight: owner-scoped admission positions with estimates, and node waits', async () => {
  let gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async (_a, messages) => {
      if ((messages.at(-1)?.content ?? '').includes('block')) await gate.promise;
      return { text: 'ok' };
    }),
    { maxActiveRuns: 1 },
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.publish('second', makeBundle(agent({ description: 'Second tenant agent' })));
    // The second tenant needs its own worker; it shares the deterministic fixture model.
    s.hub.addLocal(
      {
        nodeId: 'second-node',
        owner: 'second',
        token: 'local',
        agents: ['*'],
        capabilities: ['*'],
      },
      new WorkerRuntime(
        workerSchema.parse({
          nodeId: 'second-node',
          owner: 'second',
          dataDir: path.join(s.dir, 'second'),
        }),
        new Map(),
        new Map([['fixture', s.driver]]),
      ),
    );
    await s.kernel.wait(s.kernel.submit(principal, submit(principal, 'agent/test', 'warm')).id);
    const a = s.kernel.submit(principal, submit(principal, 'agent/test', 'block a'));
    await waitFor(() => s.store.run(a.id).status === 'in_progress');
    const b = s.kernel.submit(principal, submit(principal, 'agent/test', 'b'));
    const c = s.kernel.submit(second, submit(second, 'agent/test', 'c'));
    const d = s.kernel.submit(principal, submit(principal, 'agent/test', 'd'));
    await sleep(20);
    const runs = (await s.request('GET', '/v1/overview')).json().runs as {
      id: string;
      queue?: Record<string, unknown>;
    }[];
    const queueOf = (id: string) => runs.find((r) => r.id === id)?.queue;
    assert.equal(queueOf(a.id), undefined, 'running work has no queue entry');
    assert.deepEqual(
      { ...queueOf(b.id), estimated_start_ms: undefined },
      { position: 1, ahead: 0, reason: 'admission', estimated_start_ms: undefined },
    );
    assert.deepEqual(
      { ...queueOf(d.id), estimated_start_ms: undefined },
      { position: 2, ahead: 1, reason: 'admission', estimated_start_ms: undefined },
    );
    assert.equal(typeof queueOf(d.id)!.estimated_start_ms, 'number');
    assert.ok(
      Number(queueOf(d.id)!.estimated_start_ms) >= Number(queueOf(b.id)!.estimated_start_ms),
    );
    // Another owner's view counts only its own runs, although globally it is behind b.
    const other = (await s.request('GET', '/v1/overview', undefined, secondToken)).json().runs;
    assert.deepEqual(
      { ...other.find((r: { id: string }) => r.id === c.id).queue, estimated_start_ms: undefined },
      {
        position: 1,
        ahead: 0,
        reason: 'admission',
        estimated_start_ms: undefined,
      },
    );
    const state = (await s.request('GET', `/v1/runs/${d.id}/state`)).json();
    assert.equal(state.queue.position, 2);
    gate.resolve();
    for (const id of [a.id, b.id, c.id, d.id]) await s.kernel.wait(id);
    assert.equal((await s.request('GET', `/v1/runs/${d.id}/state`)).json().queue, undefined);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('queue insight reports node_busy while admitted work waits for node capacity', async () => {
  let release = Promise.withResolvers<void>();
  const s = await setup(undefined, { maxActiveRuns: 4 });
  try {
    s.hub.addLocal(
      { nodeId: 'slow', owner: 'owner', token: 'local', agents: ['*'], capabilities: ['*'] },
      {
        advertisement: () => ({
          nodeId: 'slow',
          providers: [],
          natives: ['adapter/slow'],
          capabilities: [],
          warm: [],
          concurrency: 1,
          execution: {
            builtins: [],
            scripts: [],
            toolSelection: true,
            nativeModels: { 'adapter/slow': { mode: 'declared' } },
          },
        }),
        install: async () => {},
        close: async () => {},
        execute: async () => {
          await release.promise;
          return { text: 'slow done', nativeState: {}, usage: null };
        },
      },
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ engine: 'adapter/slow', model: 'default', instructions: '' })),
    );
    const first = s.kernel.submit(principal, submit(principal, 'agent/test', 'one'));
    const next = s.kernel.submit(principal, submit(principal, 'agent/test', 'two'));
    await waitFor(
      () =>
        s.store.run(next.id).status === 'in_progress' &&
        s.store.run(first.id).status === 'in_progress',
    );
    await waitFor(
      () =>
        !!s.kernel.queueInsight(next.id, 'owner', 'in_progress') ||
        !!s.kernel.queueInsight(first.id, 'owner', 'in_progress'),
    );
    const waiting = [first.id, next.id]
      .map((id) => s.kernel.queueInsight(id, 'owner', 'in_progress'))
      .find(Boolean)!;
    assert.equal(waiting.reason, 'node_busy');
    assert.equal(waiting.position, 1);
    assert.equal(typeof waiting.estimated_start_ms, 'number');
    release.resolve();
    await s.kernel.wait(first.id);
    await s.kernel.wait(next.id);
    const tl = (await s.request('GET', `/v1/runs/${next.id}/timeline`)).json() as Timeline;
    checkShape(tl);
    assert.ok(tl.spans.some((sp) => sp.kind === 'native'));
  } finally {
    release.resolve();
    await s.cleanup();
  }
});

test('/health advertises sorted optional features without authentication or load data', async () => {
  const s = await setup();
  try {
    const res = await s.app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), [
      'features',
      'pid',
      'protocol',
      'status',
      'version',
    ]);
    assert.deepEqual(body.features, [...body.features].sort());
    assert.deepEqual(body.features, GATEWAY_FEATURES);
    for (const feature of [
      'run-timeline-v1',
      'overview-activity-v1',
      'queue-insight-v1',
      'overview-events-v1',
    ])
      assert.ok(body.features.includes(feature), feature);
  } finally {
    await s.cleanup();
  }
});

test('compatibility streams keep their exact bytes and model marks stay out of every stream', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'x'.repeat(2048) })));
  try {
    s.store.publish('owner', makeBundle(agent()));
    let lastToken = '';
    for (let i = 0; i < 250; i++)
      lastToken = String(
        s.auth.create(principal, `bench-key-${i}`, ['*'], ['read', 'invoke']).token,
      );
    const headers = { authorization: `Bearer ${lastToken}`, 'content-type': 'application/json' };
    const uap = await s.app.inject({
      method: 'POST',
      url: '/v1/uap',
      headers,
      payload: JSON.stringify({
        uap: '1.0',
        target: 'agent/test',
        input: 'stream test',
        delivery: { stream: true, format: 'uap-ndjson' },
      }),
    });
    const chat = await s.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: JSON.stringify({
        model: 'agent/test',
        stream: true,
        messages: [{ role: 'user', content: 'stream test' }],
      }),
    });
    // Same workload as bench/protocol-speed.ts; byte counts match the pre-change build.
    assert.equal(Buffer.byteLength(uap.body), 10_238);
    assert.equal(Buffer.byteLength(chat.body), 55_219);
    const runId = String(uap.headers['x-run-id']);
    const run = s.store.run(runId);
    assert.equal(run.checkpoint.marks?.length, 1);
    const mark = run.checkpoint.marks![0]!;
    assert.equal(mark.status, 'completed');
    assert.ok(
      mark.start <= (mark.dispatched ?? mark.start) && (mark.dispatched ?? mark.start) <= mark.end!,
    );
    assert.ok(
      !s.store.history(runId).some((e) => e.type.startsWith('model.')),
      'no new event types',
    );
    const native = await s.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/events`,
      headers: { authorization: `Bearer ${token}` },
    });
    for (const body of [uap.body, chat.body, native.body]) assert.ok(!body.includes('"marks"'));
    const response = await s.request('GET', `/v1/responses/${runId}`);
    assert.ok(!response.body.includes('"marks"'));
  } finally {
    await s.cleanup();
  }
});

test('graph $ref edges drive the critical path through dependent steps', () => {
  const base = 1_000_000;
  const tool = (offset: number, type: string, step: string, toolName = 'read_file') =>
    [offset, type, { step_id: step, tool: toolName }] as [number, string, Record<string, unknown>];
  const tl = buildTimeline(
    input({
      events: at(base, [
        [0, 'response.created'],
        [1, 'response.in_progress'],
        tool(10, 'tool.queued', 'step_a'),
        tool(10, 'tool.started', 'step_a'),
        tool(10, 'tool.queued', 'step_c'),
        tool(10, 'tool.started', 'step_c'),
        tool(30, 'tool.completed', 'step_a'),
        tool(30, 'tool.queued', 'step_b'),
        tool(30, 'tool.started', 'step_b'),
        tool(45, 'tool.completed', 'step_c'),
        tool(60, 'tool.completed', 'step_b'),
        [80, 'response.completed'],
      ]),
      marks: [
        {
          turn: 1,
          attempt: 0,
          route: 'r',
          start: base + 2,
          end: base + 9,
          status: 'completed',
          calls: 1,
        },
        {
          turn: 2,
          attempt: 0,
          route: 'r',
          start: base + 61,
          end: base + 79,
          status: 'completed',
          calls: 0,
        },
      ],
      steps: [
        { id: 'step_a', callId: 'g1:a', name: 'read_file', status: 'completed' },
        { id: 'step_b', callId: 'g1:b', name: 'read_file', status: 'completed' },
        { id: 'step_c', callId: 'g1:c', name: 'read_file', status: 'completed' },
      ],
      graphs: new Map([
        [
          'g1',
          {
            steps: [
              { id: 'a', tool: 'read_file', arguments: { path: 'x' } },
              { id: 'b', tool: 'read_file', arguments: { path: { $ref: 'a#/text' } } },
              { id: 'c', tool: 'read_file', arguments: { path: 'y' } },
            ],
          },
        ],
      ]),
    }),
  );
  checkShape(tl);
  const span = (step: string) => tl.spans.find((s) => s.ref.step_id === step)!;
  assert.ok(span('step_b').depends_on.includes(span('step_a').id), 'b waits for a ($ref)');
  assert.ok(!span('step_c').depends_on.includes(span('step_a').id));
  assert.deepEqual(
    [span('step_a').critical, span('step_b').critical, span('step_c').critical],
    [true, true, false],
  );
  // queue 0-1, gap 1-2, model 2-9, gap 9-10, a 10-30, b 30-60, gap 60-61, model 61-79, gap 79-80.
  assert.deepEqual(tl.breakdown_ms, { queue: 1, model: 25, tools: 50, approval: 0, other: 4 });
});

test('overview metrics split active runs into queued, in_progress and requires_action', async () => {
  const gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async (_a, messages) => {
      if (messages.some((m) => m.role === 'tool')) return { text: 'done' };
      const text = messages.at(-1)?.content ?? '';
      if (text.includes('approve'))
        return { calls: [{ id: 'guard', name: 'guarded', arguments: {} }] };
      if (text.includes('block')) await gate.promise;
      return { text: 'ok' };
    }),
    { maxActiveRuns: 2, approvalTimeoutMs: 10_000 },
  );
  try {
    const capability = capabilitySchema.parse({
      id: 'fixture/guarded',
      version: '1',
      description: 'Approval fixture',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'write',
      requiresApproval: true,
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'guarded',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('guarded', async () => ({ value: 'written' }));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/review',
          tools: [{ name: 'guarded', capability, handler: { kind: 'node', reference: 'guarded' } }],
        }),
      ),
    );
    s.store.publish('owner', makeBundle(agent()));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/other' })));
    const metrics = async (key = token) =>
      (await s.request('GET', '/v1/overview', undefined, key)).json().metrics as Record<
        string,
        number
      >;
    const review = s.kernel.submit(principal, submit(principal, 'agent/review', 'approve'));
    await waitFor(() => s.store.run(review.id).status === 'requires_action');
    const a = s.kernel.submit(principal, submit(principal, 'agent/test', 'block a'));
    const b = s.kernel.submit(principal, submit(principal, 'agent/other', 'block b'));
    await waitFor(
      () =>
        s.store.run(a.id).status === 'in_progress' && s.store.run(b.id).status === 'in_progress',
    );
    const c = s.kernel.submit(principal, submit(principal, 'agent/test', 'block c'));
    await sleep(20);
    assert.equal(s.store.run(c.id).status, 'queued');
    const all = await metrics();
    assert.deepEqual(
      {
        active: all.active,
        queued: all.queued,
        in_progress: all.in_progress,
        requires_action: all.requires_action,
      },
      { active: 4, queued: 1, in_progress: 2, requires_action: 1 },
    );
    assert.equal(all.queued! + all.in_progress! + all.requires_action!, all.active);
    const limited = (
      await s.request('POST', '/v1/keys', {
        name: 'other',
        agents: ['agent/other'],
        scopes: ['read'],
        data_scope: 'owner',
      })
    ).json();
    const scoped = await metrics(limited.token);
    assert.deepEqual(
      {
        active: scoped.active,
        queued: scoped.queued,
        in_progress: scoped.in_progress,
        requires_action: scoped.requires_action,
      },
      { active: 1, queued: 0, in_progress: 1, requires_action: 0 },
    );
    s.kernel.decide(principal, review.id, s.store.approvals(review.id)[0]!.id, 'deny');
    gate.resolve();
    for (const id of [review.id, a.id, b.id, c.id]) await s.kernel.wait(id);
    const done = await metrics();
    assert.deepEqual(
      {
        active: done.active,
        queued: done.queued,
        in_progress: done.in_progress,
        requires_action: done.requires_action,
      },
      { active: 0, queued: 0, in_progress: 0, requires_action: 0 },
    );
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('millisecond ties: work requested by a zero-length model turn never precedes it', () => {
  const base = 1_000_000;
  const tool = (step: string, start: number, end: number, name: string) =>
    [
      [start, 'tool.queued', { step_id: step, tool: name }],
      [start, 'tool.started', { step_id: step }],
      [end, 'tool.completed', { step_id: step }],
    ] as [number, string, Record<string, unknown>][];
  const events = at(base, [
    [0, 'response.created'],
    [0, 'response.in_progress'],
    ...tool('a', 6, 10, 'list_files'),
    ...tool('b', 7, 10, 'read_skill'),
    ...tool('c', 11, 12, 'read_file'),
    ...tool('d', 11, 13, 'read_file'),
    ...tool('e', 12, 13, 'read_file'),
    ...tool('f', 16, 18, 'write_file'),
    [21, 'response.completed'],
  ]).sort((x, y) => x.time - y.time || x.id - y.id);
  const mark = (turn: number, start: number, end: number) => ({
    turn,
    attempt: 0,
    route: 'default',
    start: base + start,
    end: base + end,
    status: 'completed' as const,
  });
  const tl = buildTimeline(
    input({
      events,
      marks: [mark(1, 1, 2), mark(2, 11, 11), mark(3, 14, 14), mark(4, 19, 21)],
      steps: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
        id,
        callId: id,
        name: 'tool',
        status: 'completed',
      })),
    }),
  );
  checkShape(tl);
  const model = (turn: number) => tl.spans.find((s) => s.kind === 'model' && s.ref.turn === turn)!;
  const step = (id: string) => tl.spans.find((s) => s.ref.step_id === id)!;
  for (const id of ['c', 'd', 'e']) {
    assert.ok(step(id).depends_on.includes(model(2).id), `${id} was requested by turn 2`);
    assert.ok(!model(2).depends_on.includes(step(id).id), `turn 2 cannot wait for ${id}`);
    assert.ok(!step(id).depends_on.includes(model(3).id), `${id} cannot depend on a later turn`);
  }
  const critical = tl.spans
    .filter((s) => s.kind === 'tool' && s.critical)
    .map((s) => s.ref.step_id);
  assert.equal(critical.length, 3, 'exactly one tool per batch is critical');
  assert.ok(critical.includes('f'));
});

test('incremental activity matches a full scan as runs start, finish and arrive', async () => {
  let gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async (_a, messages, signal) => {
      const text = messages.at(-1)?.content ?? '';
      if (text.includes('fail')) throw new Error('fixture failure');
      if (text.includes('block'))
        await Promise.race([
          gate.promise,
          new Promise((_r, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        ]);
      return { text: 'ok' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/other' })));
    const windows = new SummaryWindow();
    const timelines = new TimelineCache();
    // Compare everything except the generation time: the incremental view must equal a full scan.
    const same = (label: string) => {
      const now = Date.now();
      for (const range of ['24h', '7d'] as const) {
        const strip = (value: ReturnType<typeof computeActivity>) => ({
          ...value,
          generated_at: '',
        });
        const incremental = computeActivity(s.store, principal, range, now, timelines, {
          cache: windows,
          key: 'owner-view',
        });
        const full = computeActivity(s.store, principal, range, now, timelines);
        assert.deepEqual(strip(incremental), strip(full), `${label} (${range})`);
      }
    };
    same('empty');
    for (const text of ['a', 'b'])
      await s.kernel.wait(s.kernel.submit(principal, submit(principal, 'agent/test', text)).id);
    same('two finished runs');
    const blocked = s.kernel.submit(principal, submit(principal, 'agent/other', 'block'));
    await waitFor(() => s.store.run(blocked.id).status === 'in_progress');
    same('one active run is cached as open');
    await s.kernel.wait(s.kernel.submit(principal, submit(principal, 'agent/test', 'fail')).id);
    same('a failure arrives while the other run is still active');
    gate.resolve();
    await s.kernel.wait(blocked.id);
    assert.equal(s.store.run(blocked.id).status, 'completed');
    same('the cached open run finishes');
    gate = Promise.withResolvers<void>();
    const second = s.kernel.submit(principal, submit(principal, 'agent/other', 'block'));
    await waitFor(() => s.store.run(second.id).status === 'in_progress');
    await s.kernel.cancel(principal, second.id);
    same('a cancelled run');
    const scoped = { ...principal, agents: ['agent/other'] };
    const view = (p: typeof principal) =>
      computeActivity(s.store, p, '24h', Date.now(), timelines, { cache: windows, key: 'scoped' });
    assert.equal(view(scoped).totals.started, 2, 'scoped views keep their own grant filter');
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});
