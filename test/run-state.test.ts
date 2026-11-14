import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  addUsage,
  classifyFailure,
  stepIdFor,
  terminalEventType,
  FAILURE_RULES,
} from '../src/kernel/run-state.js';

test('classifyFailure: 逐条覆盖规则表的每条规则', () => {
  // 规则 1: uncertain_effect
  const uncertainResult = classifyFailure({
    fault: { code: 'io_failed', message: 'write pending confirmation', uncertain: true },
    closing: false,
    timedOut: false,
    aborted: false,
    hadEventError: false,
  });
  assert.deepEqual(uncertainResult, {
    status: 'interrupted',
    error: {
      code: 'effect_outcome_unknown',
      message:
        'A side-effecting operation has no confirmed outcome. Reconcile its step before resuming.',
    },
  });

  // 规则 2: closing_or_provider_mismatch - closing 分支
  const closingResult = classifyFailure({
    fault: { code: 'server_stopping', message: 'node is shutting down' },
    closing: true,
    timedOut: false,
    aborted: false,
    hadEventError: false,
  });
  assert.deepEqual(closingResult, {
    status: 'interrupted',
    error: { code: 'server_stopping', message: 'node is shutting down' },
  });

  // 规则 2: closing_or_provider_mismatch - node_draining / provider_state 分支
  for (const code of ['node_draining', 'provider_state_mismatch', 'provider_state_unsupported']) {
    const drainResult = classifyFailure({
      fault: { code, message: `error for ${code}` },
      closing: false,
      timedOut: false,
      aborted: false,
      hadEventError: false,
    });
    assert.deepEqual(drainResult, {
      status: 'interrupted',
      error: { code, message: `error for ${code}` },
    });
  }

  // 规则 3: timed_out
  const timedOutResult = classifyFailure({
    fault: { code: 'cancelled', message: 'execution deadline exceeded' },
    closing: false,
    timedOut: true,
    aborted: false,
    hadEventError: false,
  });
  assert.deepEqual(timedOutResult, {
    status: 'incomplete',
    error: { code: 'run_timeout', message: 'execution deadline exceeded' },
  });

  // 规则 4: aborted (外部中止且无内部事件错误)
  const abortedResult = classifyFailure({
    fault: { code: 'cancelled', message: 'client cancelled request' },
    closing: false,
    timedOut: false,
    aborted: true,
    hadEventError: false,
  });
  assert.deepEqual(abortedResult, {
    status: 'cancelled',
    error: { code: 'cancelled', message: 'client cancelled request' },
  });

  // 规则 5: resource_limit (turn_limit, token_budget, max_output_tokens)
  for (const code of ['turn_limit', 'token_budget', 'max_output_tokens']) {
    const limitResult = classifyFailure({
      fault: { code, message: `limit reached: ${code}` },
      closing: false,
      timedOut: false,
      aborted: false,
      hadEventError: false,
    });
    assert.deepEqual(limitResult, {
      status: 'incomplete',
      error: { code, message: `limit reached: ${code}` },
    });
  }

  // 规则 6: fallback_failed (未匹配上述规则的兜底失败)
  const fallbackResult = classifyFailure({
    fault: { code: 'internal_crash', message: 'unexpected null pointer' },
    closing: false,
    timedOut: false,
    aborted: false,
    hadEventError: false,
  });
  assert.deepEqual(fallbackResult, {
    status: 'failed',
    error: { code: 'internal_crash', message: 'unexpected null pointer' },
  });
});

test('classifyFailure: 多条规则同时满足时按优先级取第一条', () => {
  // 冲突用例 1: 规则 1 (uncertain) 优先于 规则 2 (closing) 与 规则 3 (timedOut)
  const priority1 = classifyFailure({
    fault: { code: 'turn_limit', message: 'uncertain with timeout and closing', uncertain: true },
    closing: true,
    timedOut: true,
    aborted: true,
    hadEventError: false,
  });
  assert.equal(priority1.status, 'interrupted');
  // 与重构前一致：已超时的运行，错误码一律是 run_timeout，但状态和文案仍取自规则 1
  assert.equal(priority1.error.code, 'run_timeout');
  assert.match(priority1.error.message, /no confirmed outcome/);
  const uncertainOnly = classifyFailure({
    fault: { code: 'execution_failed', message: 'x', uncertain: true },
    closing: true,
    timedOut: false,
    aborted: true,
    hadEventError: false,
  });
  assert.equal(uncertainOnly.error.code, 'effect_outcome_unknown');

  // 冲突用例 2: 规则 2 (closing) 优先于 规则 3 (timedOut) 与 规则 5 (turn_limit)
  const priority2 = classifyFailure({
    fault: { code: 'turn_limit', message: 'closing takes precedence over timedOut' },
    closing: true,
    timedOut: true,
    aborted: false,
    hadEventError: false,
  });
  assert.equal(priority2.status, 'interrupted');
  assert.equal(priority2.error.code, 'run_timeout');

  // 冲突用例 3: 规则 3 (timedOut) 优先于 规则 4 (aborted) 与 规则 5 (token_budget)
  const priority3 = classifyFailure({
    fault: { code: 'token_budget', message: 'timedOut takes precedence over aborted' },
    closing: false,
    timedOut: true,
    aborted: true,
    hadEventError: false,
  });
  assert.equal(priority3.status, 'incomplete');
  assert.equal(priority3.error.code, 'run_timeout');

  // 冲突用例 4: 规则 4 (aborted) 优先于 规则 5 (resource_limit)
  const priority4 = classifyFailure({
    fault: { code: 'max_output_tokens', message: 'aborted takes precedence over resource limits' },
    closing: false,
    timedOut: false,
    aborted: true,
    hadEventError: false,
  });
  assert.equal(priority4.status, 'cancelled');
  assert.equal(priority4.error.code, 'max_output_tokens');

  // 冲突用例 5: 当 aborted 为真但 hadEventError 亦为真时，规则 4 被规避，降级到规则 6 (fallback_failed)
  const eventErrorBypass = classifyFailure({
    fault: { code: 'output_too_large', message: 'output exceeds limit' },
    closing: false,
    timedOut: false,
    aborted: true,
    hadEventError: true,
  });
  assert.equal(eventErrorBypass.status, 'failed');
  assert.equal(eventErrorBypass.error.code, 'output_too_large');
});

test('stepIdFor: 结果与手写算式一致、长度为 step_ + 32 个字符', () => {
  const runId = 'run_sample123';
  const turn = 3;
  const callId = 'call_abc456';

  const expectedHash = createHash('sha256')
    .update(`${runId}:${turn}:${callId}`)
    .digest('hex')
    .slice(0, 32);
  const expected = `step_${expectedHash}`;

  const actual = stepIdFor(runId, turn, callId);
  assert.equal(actual, expected);
  assert.equal(actual.length, 'step_'.length + 32);
  assert.match(actual, /^step_[0-9a-f]{32}$/);
});

test('terminalEventType: 验证四种终态事件类型映射', () => {
  assert.equal(terminalEventType('interrupted'), 'response.incomplete');
  assert.equal(terminalEventType('completed'), 'response.completed');
  assert.equal(terminalEventType('failed'), 'response.failed');
  assert.equal(terminalEventType('cancelled'), 'response.cancelled');
  assert.equal(terminalEventType('incomplete'), 'response.incomplete');
});

test('addUsage: run.usage 为空与已有值两种情况', () => {
  // 情况 1: run.usage 初始为空 (null 或 undefined)
  const runWithNull: {
    usage: null | { input_tokens: number; output_tokens: number; total_tokens: number };
  } = {
    usage: null,
  };
  addUsage(runWithNull, { input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  assert.deepEqual(runWithNull.usage, {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
  });

  const runWithUndefined: {
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  } = {};
  addUsage(runWithUndefined, { input_tokens: 20, output_tokens: 30, total_tokens: 50 });
  assert.deepEqual(runWithUndefined.usage, {
    input_tokens: 20,
    output_tokens: 30,
    total_tokens: 50,
  });

  // 情况 2: run.usage 已有初始值进行累加
  addUsage(runWithNull, { input_tokens: 15, output_tokens: 25, total_tokens: 40 });
  assert.deepEqual(runWithNull.usage, {
    input_tokens: 115,
    output_tokens: 75,
    total_tokens: 190,
  });

  // 边界测试: 传入空 usage 不应改变原状态
  addUsage(runWithNull, null);
  assert.deepEqual(runWithNull.usage, {
    input_tokens: 115,
    output_tokens: 75,
    total_tokens: 190,
  });
});
