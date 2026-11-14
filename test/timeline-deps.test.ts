import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, type TimelineInput } from '../src/gateway/timeline.js';

// 一批并行工具结束后，下一轮模型若在节点上排队 ≥10ms，时间线会插入一个“节点等待”主线跨度：
// 依赖链是 工具批 → 节点等待 → 下一轮，下一轮不直接依赖工具（CI 慢机上偶发出现的形态）。
const base = 1_000_000;
const ev = (spec: [number, string, Record<string, unknown>?][]) =>
  spec.map(([offset, type, data], i) => ({
    id: i + 1,
    type,
    time: base + offset,
    data: data ?? {},
  }));
const tool = (step: string, s: number, e: number): [number, string, Record<string, unknown>][] => [
  [s, 'tool.started', { step_id: step, tool: 'read_file' }],
  [e, 'tool.completed', { step_id: step, tool: 'read_file' }],
];

const build = (dispatchDelay: number, toolEnd: number) => {
  const nextStart = 20;
  const input: TimelineInput = {
    id: 'resp_fixture',
    status: 'completed',
    createdAt: base,
    engine: 'kernel',
    lastEventId: 0,
    now: base + 1000,
    steps: ['a', 'b', 'c'].map((id) => ({
      id,
      callId: `call_${id}`,
      name: 'read_file',
      status: 'completed',
    })),
    marks: [
      { turn: 1, attempt: 0, route: 'r', start: base + 1, end: base + 5 },
      {
        turn: 2,
        attempt: 0,
        route: 'r',
        start: base + nextStart,
        dispatched: base + nextStart + dispatchDelay,
        end: base + nextStart + dispatchDelay + 3,
      },
    ],
    events: ev([
      [0, 'response.created'],
      [1, 'response.in_progress'],
      ...tool('a', 5, 9),
      ...tool('b', 5, toolEnd),
      ...tool('c', 6, 8),
      [200, 'response.completed'],
    ]),
  };
  return buildTimeline(input);
};

/** 从 `from` 沿依赖能否到达 `to`。 */
const reaches = (spans: ReturnType<typeof build>['spans'], from: string, to: string): boolean => {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const walk = (id: string): boolean =>
    id === to || (!seen.has(id) && (seen.add(id), byId.get(id)!.depends_on.some(walk)));
  return walk(from);
};

for (const [dispatchDelay, toolEnd, label] of [
  [0, 19, 'no node wait'],
  [0, 20, 'tool ends in the same millisecond the next turn starts'],
  [0, 21, 'tool end lags the next turn start by 1 ms'],
  [12, 19, 'next turn waited for a node'],
  [12, 20, 'node wait and a same-millisecond tool end'],
] as const)
  test(`the next model turn depends on the whole tool batch (${label})`, () => {
    const tl = build(dispatchDelay, toolEnd);
    const turn2 = tl.spans.find((s) => s.kind === 'model' && s.ref.turn === 2)!;
    const tools = tl.spans.filter((s) => s.kind === 'tool');
    assert.equal(tools.length, 3);
    for (const t of tools) assert.ok(reaches(tl.spans, turn2.id, t.id), `${t.id} not reached`);
    const wait = tl.spans.find((s) => s.kind === 'queue' && s.ref.turn === 2);
    assert.equal(!!wait, dispatchDelay >= 10);
    if (wait) {
      assert.ok(turn2.depends_on.includes(wait.id));
      for (const t of tools)
        assert.ok(wait.depends_on.includes(t.id), 'the node wait follows the batch');
    } else for (const t of tools) assert.ok(turn2.depends_on.includes(t.id));
  });
