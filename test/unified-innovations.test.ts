import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, agent, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import {
  resolveModelSelector,
  detectTaskIntent,
  ModelRouter,
  parseResponse,
  parseChat,
  parseClaudeMessages,
} from '../src/gateway/protocol.js';
import { parseGraph, executeGraph, evaluateAst } from '../src/lang/graph.js';

test('universal model selector resolves @ and : syntax, headers, and metadata', () => {
  // 1. @ 语法
  const res1 = resolveModelSelector('agent/test@gpt-4o');
  assert.equal(res1.agent, 'agent/test');
  assert.equal(res1.model, 'gpt-4o');

  // 2. : 语法
  const res2 = resolveModelSelector('agent/test:claude-3-7-sonnet');
  assert.equal(res2.agent, 'agent/test');
  assert.equal(res2.model, 'claude-3-7-sonnet');

  // 3. Header 显式覆盖
  const res3 = resolveModelSelector(
    'agent/test',
    {},
    {
      'x-oaa-model': 'deepseek-r1',
      'x-routing-strategy': 'speed',
      'x-oaa-agent-version': 'a'.repeat(64),
    },
  );
  assert.equal(res3.agent, 'agent/test');
  assert.equal(res3.model, 'deepseek-r1');
  assert.equal(res3.strategy, 'speed');
  assert.equal(res3.agent_version, 'a'.repeat(64));

  // 4. metadata 优先级最高
  const res4 = resolveModelSelector(
    'agent/test@gpt-4o',
    { 'oaa.model': 'explicit-override-model' },
    { 'x-oaa-model': 'header-model' },
  );
  assert.equal(res4.model, 'explicit-override-model');
});

test('adaptive intent detection recognizes coding, reasoning, fast, and general tasks', () => {
  assert.equal(
    detectTaskIntent('Can you refactor this TypeScript class? const x: number = 10;'),
    'coding',
  );
  assert.equal(
    detectTaskIntent(
      'Please think step by step and provide the mathematical proof for Fermat theorem.',
    ),
    'reasoning',
  );
  assert.equal(detectTaskIntent('Hello!'), 'fast');
  assert.equal(
    detectTaskIntent(
      'Write a comprehensive summary of the French Revolution spanning the years 1789 through 1799, covering political, economic, and social transformations across urban and rural sectors.',
    ),
    'general',
  );
});

test('model router balances strategies dynamically across speed, cost and quality', () => {
  const router = new ModelRouter();
  const def = agent({
    routes: [
      { id: 'standard', provider: 'p1', model: 'gpt-4o', priority: 1 },
      { id: 'fast-node', provider: 'p2', model: 'gemini-flash', priority: 2 },
      { id: 'deep-node', provider: 'p3', model: 'claude-3-7-sonnet-reasoning', priority: 3 },
    ],
  });

  const available = () => true;

  // speed 策略优先偏向高响应度/低延迟
  const speedCandidate = router.candidates('owner', 'digest', def, available, {
    strategy: 'speed',
  });
  assert.ok(speedCandidate.length >= 3);

  // cost 策略倾斜支持带 flash / mini 等轻量关键词的模型
  const costCandidate = router.candidates('owner', 'digest', def, available, { strategy: 'cost' });
  assert.equal(costCandidate[0]?.model, 'gemini-flash');

  // quality / coding 策略倾斜支持带 sonnet / reasoning / gpt-4 等强力模型
  const qualityCandidate = router.candidates('owner', 'digest', def, available, {
    strategy: 'quality',
  });
  assert.equal(qualityCandidate[0]?.model, 'gpt-4o');

  // cascade 接口返回全部候选
  const cascadeList = router.cascade('owner', 'digest', def, available);
  assert.equal(cascadeList.length, 3);
});

test('dsl v2 supports safe expressions, templates, defaults, and conditional branching', async () => {
  // 1. 安全求值器单元验证
  assert.equal(evaluateAst('10 > 5 && true'), true);
  assert.equal(evaluateAst('20 <= 10 || 5 == 5'), true);
  assert.equal(evaluateAst('!false'), true);
  assert.equal(evaluateAst("'ok' == 'ok'"), true);

  // 2. 图执行中的 $default, $template, $expr 和 when 条件分支
  const allowed = new Set(['tool_a', 'tool_b', 'tool_c']);
  const steps = parseGraph(
    {
      steps: [
        { id: 'step1', tool: 'tool_a', arguments: { value: 100 } },
        {
          id: 'step2',
          tool: 'tool_b',
          arguments: {
            summary: { $template: 'Processed count: {{step1#/value}}' },
            fallback: { $ref: 'step1#/non_existing_key', $default: 'default_val' },
          },
        },
        {
          id: 'skipped_step',
          tool: 'tool_c',
          arguments: { flag: 'never_called' },
          when: { $expr: 'step1#/value == 999' }, // 100 != 999，应跳过
        },
      ],
    },
    allowed,
  );

  let toolCCalled = false;
  const results = await executeGraph(steps, 4, new AbortController().signal, async (s, args) => {
    if (s.id === 'step1') return { value: 100 };
    if (s.id === 'step2') return args;
    if (s.id === 'skipped_step') {
      toolCCalled = true;
      return { ok: true };
    }
    return {};
  });

  assert.equal(toolCCalled, false); // 条件未满足，跳过执行
  assert.deepEqual(results.skipped_step, { skipped: true });
  assert.deepEqual(results.step2, {
    summary: 'Processed count: 100',
    fallback: 'default_val',
  });
});

test('unified protocol handles Anthropic Claude Messages API endpoints natively', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const url = await s.listen();

    // 1. 非流式 POST /v1/messages
    const res = await fetch(url + '/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'agent/test',
        messages: [{ role: 'user', content: 'Hello Claude compat!' }],
        system: 'You are a helpful assistant.',
        max_tokens: 1024,
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.model, 'agent/test');
    assert.equal(body.content[0].type, 'text');
    assert.equal(body.content[0].text, 'Fixture response.');
    assert.equal(body.stop_reason, 'end_turn');

    // 2. 流式 POST /v1/messages
    const streamRes = await fetch(url + '/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'agent/test',
        messages: [{ role: 'user', content: 'Stream Claude' }],
        stream: true,
      }),
    });

    assert.equal(streamRes.status, 200);
    const rawText = await streamRes.text();
    assert.match(rawText, /event: message_start/);
    assert.match(rawText, /event: content_block_start/);
    assert.match(rawText, /event: content_block_delta/);
    assert.match(rawText, /event: content_block_stop/);
    assert.match(rawText, /event: message_delta/);
    assert.match(rawText, /event: message_stop/);
  } finally {
    await s.cleanup();
  }
});
