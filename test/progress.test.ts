import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_PROGRESS,
  safeTitle,
  summarize,
  type ProgressEvent,
} from '../src/gateway/progress.js';

// Stream progress lines (docs/progress.md): a pure function from run events to short text.

const run = (events: ProgressEvent[], locale: 'zh' | 'en') => {
  let state = INITIAL_PROGRESS;
  const lines: string[] = [];
  for (const e of events) {
    const r = summarize(e, state, locale);
    state = r.state;
    if (r.line) lines.push(r.line);
  }
  return lines;
};

const LIFE: ProgressEvent[] = [
  { type: 'response.created', data: {} },
  { type: 'run.queued', data: { reason: 'fairness' } },
  { type: 'response.in_progress', data: {} },
  { type: 'tool.queued', data: { step_id: 's1', tool: 'read_file', effect: 'read' } },
  { type: 'tool.started', data: { step_id: 's1', node_id: 'local', attempt: 1 } },
  { type: 'tool.started', data: { step_id: 's1', node_id: 'local', attempt: 2 } },
  { type: 'tool.completed', data: { step_id: 's1', node_id: 'local', artifacts: [] } },
  { type: 'tool.queued', data: { step_id: 's2', tool: 'write_file', effect: 'write' } },
  { type: 'tool.failed', data: { step_id: 's2', code: 'tool_timeout', uncertain: false } },
  {
    type: 'run.requires_action',
    data: { approval: { kind: 'tool', detail: { tool: 'deploy', arguments: { token: 'x' } } } },
  },
  { type: 'approval.resolved', data: { decision: 'approve', actor: 'Alice Example' } },
  { type: 'run.queued', data: { reason: 'approval_resolved' } },
  { type: 'response.in_progress', data: {} },
  { type: 'tool.progress', data: { source: 'gateway', event: 'output_repair', round: 1 } },
  {
    type: 'run.queued',
    data: { reason: 'agent_fallback', from: 'agent/a', to: 'agent/b', error: 'model_unavailable' },
  },
  { type: 'response.output_text.delta', data: { delta: 'secret answer' } },
  { type: 'response.completed', data: {} },
];

test('progress: every phase has one line, in Chinese and English', () => {
  assert.deepEqual(run(LIFE, 'zh'), [
    '排队中：与其他运行轮流使用执行名额',
    '开始执行',
    '调用工具 read_file（只读）',
    '重试工具 read_file（第 2 次）',
    '工具 read_file 完成',
    '调用工具 write_file（会修改数据）',
    '工具 write_file 失败（tool_timeout）',
    '等待审批：需要所有者在控制台批准「deploy」',
    '审批通过',
    '等待的事项已处理，重新排队',
    '继续执行',
    '答案不符合要求的格式，退回修改（第 1 轮）',
    '切换到备选智能体 agent/b（原因：model_unavailable）',
    '完成',
  ]);
  assert.deepEqual(run(LIFE, 'en'), [
    'Queued: taking turns with other runs for an execution slot',
    'Started',
    'Calling tool read_file (read-only)',
    'Retrying tool read_file (attempt 2)',
    'Tool read_file finished',
    'Calling tool write_file (changes data)',
    'Tool write_file failed (tool_timeout)',
    'Waiting for approval: the owner must approve "deploy" in the console',
    'Approved',
    'What it waited for is settled; back in the queue',
    'Resumed',
    'The answer did not match the required format; sent back for correction (round 1)',
    'Switching to fallback agent agent/b (reason: model_unavailable)',
    'Done',
  ]);
});

test('progress: no arguments, results, answer text or approver names reach the lines', () => {
  const all = [...run(LIFE, 'zh'), ...run(LIFE, 'en')].join('\n');
  for (const leaked of ['token', 'secret answer', 'Alice', 'local', 'agent/a'])
    assert.ok(!all.includes(leaked), leaked);
});

test('progress: external agent steps use their own titles, redacted and capped', () => {
  const long = `Run tests ${'x'.repeat(300)}`;
  const lines = run(
    [
      { type: 'tool.queued', data: { step_id: 'native_run1', tool: 'acp', effect: 'unknown' } },
      { type: 'tool.progress', data: { source: 'agent', event: 'thinking' } },
      { type: 'tool.progress', data: { source: 'agent', event: 'thinking' } },
      {
        type: 'tool.progress',
        data: {
          source: 'agent',
          event: 'tool',
          title: 'Read with api_key=abc123',
          status: 'pending',
        },
      },
      {
        type: 'tool.progress',
        data: {
          source: 'agent',
          event: 'tool',
          title: 'Read with api_key=abc123',
          status: 'completed',
        },
      },
      {
        type: 'tool.progress',
        data: {
          source: 'agent',
          event: 'item',
          kind: 'tool',
          itemType: 'commandExecution',
          status: 'failed',
        },
      },
      { type: 'tool.progress', data: { source: 'agent', event: 'tool', tool: long } },
      { type: 'tool.progress', data: { source: 'agent', event: 'plan', entries: 3 } },
      { type: 'tool.progress', data: { source: 'agent', event: 'initialized', model: 'm' } },
      { type: 'tool.completed', data: { step_id: 'native_run1' } },
      {
        type: 'run.requires_action',
        data: { approval: { kind: 'client_tool', detail: { tool: 'edit-file' } } },
      },
    ],
    'en',
  );
  assert.equal(lines[0], 'Handed to the agent');
  assert.equal(lines[1], 'The agent is thinking…');
  assert.equal(lines[2], 'Agent tool call: Read with api_key=[REDACTED]');
  assert.equal(lines[3], 'Done: Read with api_key=[REDACTED]');
  assert.equal(lines[4], 'Failed: commandExecution');
  assert.ok(lines[5]!.length < 160 && lines[5]!.endsWith('…'), lines[5]);
  assert.equal(lines[6], 'The agent made a plan (3 steps)');
  assert.equal(lines[7], 'Waiting for the caller to run tool edit-file');
  assert.equal(lines.length, 8);
  assert.equal(safeTitle('  a\n\tb  '), 'a b');
  assert.equal(safeTitle(42), undefined);
});

test('progress: summarize does not change its input state', () => {
  const state = INITIAL_PROGRESS;
  summarize({ type: 'tool.queued', data: { step_id: 's', tool: 't' } }, state, 'zh');
  summarize({ type: 'response.in_progress', data: {} }, state, 'zh');
  assert.deepEqual(state, { tools: {}, started: false, thinking: false });
});
