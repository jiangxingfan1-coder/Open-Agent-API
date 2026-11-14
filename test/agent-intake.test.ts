/**
 * 外部智能体接入收口（T06b）：事件回调失败、进度与审批数据的统一约束、进度形状、
 * 产物落盘与步骤完成的顺序、Antigravity 的拒绝与工具失败、Claude 文本以流式为准。
 *
 * 不调用任何模型或网络，不监听端口；需要子进程的地方用协议级假智能体（与 conformance 测试同法）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import type { RunEvent } from '../src/core/contracts.js';
import { boundApprovalDetail, sanitizeProgress } from '../src/kernel/agent-events.js';
import { agent, principal, setup } from './helpers.js';

type Gateway = Awaited<ReturnType<typeof setup>>;
const nativeFull = path.resolve('test/fixtures/native-full.mjs');

/** 一个只认 Codex app-server 协议里本测试用到的那几条消息的假智能体。 */
const CODEX_FIXTURE = `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const log = (l) => appendFileSync('.intake-codex.log', l + '\\n');
let seq = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); out({ id, method, params }); });
const done = () => out({ method: 'turn/completed', params: { turn: { id: 't', status: 'completed' } } });
const item = (type, status) => out({ method: 'item/completed', params: { item: { id: 'i', type, status } } });
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg.result); waiting.delete(msg.id); return; }
  if (msg.method === 'initialize') return out({ id: msg.id, result: {} });
  if (msg.method === 'thread/start') return out({ id: msg.id, result: { thread: { id: 'th' } } });
  if (msg.method !== 'turn/start') return;
  out({ id: msg.id, result: { turn: { id: 't', status: 'inProgress' } } });
  const text = msg.params.input.map((p) => p.text).join('');
  if (text.includes('MODE:big')) {
    const answer = await ask('item/commandExecution/requestApproval', { command: 'x'.repeat(300 * 1024) });
    log('approval:' + answer.decision);
    item('commandExecution', answer.decision === 'accept' ? 'completed' : 'declined');
    return done();
  }
  if (text.includes('MODE:shapes')) {
    item('commandExecution', 'S'.repeat(100));
    item('reasoning', { nested: true });
  } else item('commandExecution', 'completed');
  out({ method: 'item/agentMessage/delta', params: { delta: 'intake fixture output' } });
  done();
});
`;

const installCodex = async (s: Gateway, script?: string) => {
  let args = [nativeFull];
  if (script) {
    const file = path.join(s.dir, 'intake-codex.mjs');
    await writeFile(file, script);
    args = [file];
  }
  const make = () => ({ executable: process.execPath, enabled: true, args }) as never;
  s.config.localWorker!.native.codex = make();
  s.runtime.config.native.codex = make();
  const published = await s.request('POST', '/v1/agents/publish-native', {
    id: 'agent/codex',
    engine: 'codex',
    models: ['default'],
  });
  assert.equal(published.statusCode, 200, published.body);
};
const installAntigravity = async (s: Gateway, file = nativeFull) => {
  const make = () => ({ executable: process.execPath, enabled: true, args: [file] }) as never;
  s.config.localWorker!.native.antigravity = make();
  s.runtime.config.native.antigravity = make();
  const published = await s.request('POST', '/v1/agents/publish-native', {
    id: 'agent/agy',
    engine: 'antigravity',
    models: ['default'],
  });
  assert.equal(published.statusCode, 200, published.body);
};
const run = (s: Gateway, id: string, input: string) =>
  s.kernel.wait(
    s.kernel.submit(principal, invocationSchema.parse({ agent: id, input, background: true })).id,
  );
const progressOf = (s: Gateway, runId: string) =>
  s.store
    .history(runId)
    .filter((e: RunEvent) => e.type === 'tool.progress')
    .map((e: RunEvent) => e.data);
/** 统计测试期间出现的未处理拒绝。 */
const watchRejections = () => {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', listener);
  return {
    seen,
    stop: async () => {
      // 让还在路上的拒绝有机会浮出来。
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.off('unhandledRejection', listener);
    },
  };
};

test('Codex: a progress event that cannot be persisted ends the run with persistence_failed, without an unhandled rejection', async () => {
  const s = await setup();
  const rejections = watchRejections();
  try {
    await installCodex(s);
    s.store.db.exec(
      `CREATE TEMP TRIGGER fail_progress BEFORE INSERT ON main.events WHEN NEW.type='tool.progress' BEGIN SELECT RAISE(ABORT,'injected progress failure'); END;`,
    );
    const done = await run(s, 'agent/codex', 'Answer MARKER:one');
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'persistence_failed');
  } finally {
    await rejections.stop();
    await s.cleanup();
  }
  assert.equal(rejections.seen.length, 0, String(rejections.seen[0]));
});

test('worker: a model delta the gateway cannot accept ends the turn with that error, without an unhandled rejection', async () => {
  const s = await setup();
  const rejections = watchRejections();
  try {
    const bundle = makeBundle(agent({ id: 'agent/model' }));
    await s.runtime.install(bundle);
    const refused = new Error('gateway refused the delta');
    await assert.rejects(
      s.runtime.execute(
        {
          kind: 'model',
          agent: bundle.agent,
          messages: [{ role: 'user', content: 'x' }],
          context: { runId: 'r', sessionId: 's', owner: 'owner', digest: bundle.digest, files: [] },
        },
        new AbortController().signal,
        async () => {
          throw refused;
        },
      ),
      (error: unknown) => error === refused,
    );
  } finally {
    await rejections.stop();
    await s.cleanup();
  }
  assert.equal(rejections.seen.length, 0, String(rejections.seen[0]));
});

test('external agent progress is bounded, shaped and marked source: agent', async () => {
  const s = await setup();
  try {
    await installCodex(s, CODEX_FIXTURE);
    const codex = await run(s, 'agent/codex', 'MODE:shapes');
    assert.equal(codex.status, 'completed', JSON.stringify(codex.error));
    const [command, reasoning] = progressOf(s, codex.id);
    assert.deepEqual(command, {
      native: 'codex',
      event: 'item',
      itemType: 'commandExecution',
      kind: 'tool',
      status: 'S'.repeat(40),
      source: 'agent',
    });
    // 非字符串、非数字、非布尔的字段被丢弃。
    assert.deepEqual(reasoning, {
      native: 'codex',
      event: 'item',
      itemType: 'reasoning',
      kind: 'status',
      source: 'agent',
    });

    await installAntigravity(s);
    const agy = await run(s, 'agent/agy', 'Answer MARKER:one');
    assert.equal(agy.status, 'completed', JSON.stringify(agy.error));
    const events = progressOf(s, agy.id);
    assert.equal(events[0]?.event, 'initialized');
    assert.equal(events[0]?.source, 'agent');
    assert.deepEqual(events[1], {
      native: 'antigravity',
      event: 'tool',
      tool: 'write_file',
      state: 'completed',
      source: 'agent',
    });
  } finally {
    await s.cleanup();
  }
});

test('an approval detail larger than 256 KiB is denied without creating a pending approval', async () => {
  const s = await setup(undefined, { approvalTimeoutMs: 30_000 });
  try {
    await installCodex(s, CODEX_FIXTURE);
    const done = await run(s, 'agent/codex', 'MODE:big');
    assert.equal(s.store.approvals(done.id).length, 0, 'nothing reaches the owner');
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'permission_denied');
    assert.ok(
      progressOf(s, done.id).some(
        (p) =>
          p.event === 'permission_denied' &&
          p.reason === 'approval_too_large' &&
          p.source === 'agent',
      ),
    );
  } finally {
    await s.cleanup();
  }
});

test('sanitizeProgress keeps every field the access methods emit today and nothing else', () => {
  // ACP `initialized` / `tool` / `plan`, Antigravity `initialized`, adapter, A2A status fields.
  const acp = {
    native: 'acp',
    adapter: 'fixture',
    event: 'initialized',
    agent: 'Fixture',
    version: null,
    load_session: true,
    resume_session: false,
  };
  assert.deepEqual(sanitizeProgress(acp), { ...acp, source: 'agent' });
  const tool = {
    native: 'acp',
    adapter: 'fixture',
    event: 'tool',
    tool_call_id: 'c1',
    title: null,
    kind: 'read',
    status: 'pending',
  };
  assert.deepEqual(sanitizeProgress(tool), { ...tool, source: 'agent' });
  const agy = {
    native: 'antigravity',
    event: 'initialized',
    model: 'm',
    tool_count: 3,
    permission_mode: 'request-review',
  };
  assert.deepEqual(sanitizeProgress(agy), { ...agy, source: 'agent' });
  for (const extra of [
    { event: 'plan', entries: 4 },
    { event: 'content_skipped', content_type: 'image' },
    { event: 'permission_denied', reason: 'owner_denied' },
    { event: 'status', state: 'working', title: 'Thinking' },
  ])
    assert.deepEqual(sanitizeProgress(extra), { ...extra, source: 'agent' });

  const bounded = sanitizeProgress({
    event: 'e'.repeat(100),
    tool: 't'.repeat(500),
    title: 'x'.repeat(500),
    arguments: { secret: 'not whitelisted' },
    status: { nested: true },
    tool_count: Number.NaN,
    entries: ['a'.repeat(500), { object: true }, ...Array.from({ length: 40 }, (_, i) => i)],
    source: 'spoofed',
  });
  assert.equal(bounded.event, 'e'.repeat(40));
  assert.equal(bounded.tool, 't'.repeat(160));
  assert.equal(bounded.title, 'x'.repeat(240));
  assert.equal('arguments' in bounded, false);
  assert.equal('status' in bounded, false);
  assert.equal('tool_count' in bounded, false);
  assert.equal(bounded.source, 'agent');
  const entries = bounded.entries as unknown[];
  assert.equal(entries[0], 'a'.repeat(240));
  assert.ok(entries.length <= 20);
  assert.ok(entries.every((e) => typeof e !== 'object'));
});

test('boundApprovalDetail accepts details up to 256 KiB and denies larger ones', () => {
  assert.equal(
    boundApprovalDetail({ native: 'claude', arguments: { a: 'x'.repeat(1000) } }),
    undefined,
  );
  const denied = boundApprovalDetail({
    native: 'claude',
    arguments: { a: 'x'.repeat(256 * 1024) },
  });
  assert.deepEqual(denied, {
    decision: 'deny',
    progress: { native: 'claude', event: 'permission_denied', reason: 'approval_too_large' },
  });
});

/** 把本地执行节点对外部智能体工作的结果换成 `tamper` 的返回值（文本事件也可以先发）。 */
const patchNative = (
  s: Gateway,
  tamper: (
    result: Record<string, any>,
    emit: (e: { type: 'text'; data: Record<string, unknown> }) => Promise<unknown>,
  ) => Promise<Record<string, any>> | Record<string, any>,
) => {
  const original = s.runtime.execute.bind(s.runtime);
  s.runtime.execute = (async (work, signal, emit) => {
    const result = (await original(work, signal, emit)) as Record<string, any>;
    return work.kind === 'native' ? await tamper(result, emit) : result;
  }) as typeof s.runtime.execute;
};

test('an external agent artifact whose digest does not match fails the run before the step completes', async () => {
  const s = await setup();
  try {
    await installCodex(s);
    patchNative(s, (result) => {
      assert.ok(result.artifacts?.length, 'the fixture exports an artifact');
      result.artifacts[0].sha256 = '0'.repeat(64);
      return result;
    });
    const done = await run(s, 'agent/codex', 'Save MODE:artifact MARKER:x');
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'artifact_integrity');
    const step = s.store.steps(done.id).find((st) => st.callId === 'native');
    assert.ok(step);
    assert.notEqual(step.status, 'completed');
    assert.deepEqual(done.artifactIds, []);
  } finally {
    await s.cleanup();
  }
});

test('an external agent step completes in the same commit as its artifacts and checkpoint', async () => {
  const s = await setup();
  try {
    await installCodex(s);
    const done = await run(s, 'agent/codex', 'Save MODE:artifact MARKER:x');
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.artifactIds.length, 1);
    const step = s.store.steps(done.id).find((st) => st.callId === 'native');
    assert.equal(step?.status, 'completed');
  } finally {
    await s.cleanup();
  }
});

/** Antigravity stream-json 假智能体：工具步骤带 `tool_info.error`，之后按 MODE 给出结果。 */
const AGY_FIXTURE = `
import readline from 'node:readline';
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
out({ event: 'init', init: { tools: ['run_command'], permission_mode: 'request-review', model: 'fixture-default' } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.event !== 'user') return;
  const text = String(msg.message?.content ?? '');
  const error = text.includes('MODE:denied-error')
    ? 'Permission denied: the user rejected run_command'
    : text.includes('MODE:object-denied')
      ? { code: 'PERMISSION_DENIED', message: 'tool call was denied' }
      : 'exit status 1: no such file';
  out({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command', state: 'error', tool_info: { error } } });
  if (text.includes('MODE:no-result')) return process.exit(0);
  out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Recovered after a failed command.' } });
  out({ event: 'result', result: { status: 'SUCCESS', response: 'Recovered after a failed command.', conversation_id: 'c1' } });
});
`;

test('Antigravity: a failed tool is not a denial; only a recognisable denial is permission_denied', async () => {
  const s = await setup();
  try {
    const file = path.join(s.dir, 'intake-agy.mjs');
    await writeFile(file, AGY_FIXTURE);
    await installAntigravity(s, file);
    const recovered = await run(s, 'agent/agy', 'MODE:tool-failed');
    assert.equal(recovered.status, 'completed', JSON.stringify(recovered.error));
    assert.equal(recovered.output.map((m) => m.text).join(''), 'Recovered after a failed command.');
    for (const mode of ['MODE:denied-error', 'MODE:object-denied']) {
      const denied = await run(s, 'agent/agy', mode);
      assert.equal(denied.status, 'failed');
      assert.equal(denied.error?.code, 'permission_denied', mode);
    }
    const unfinished = await run(s, 'agent/agy', 'MODE:no-result');
    assert.equal(unfinished.status, 'failed');
    assert.equal(unfinished.error?.code, 'native_incomplete');
  } finally {
    await s.cleanup();
  }
});

test('external agent text: what was streamed wins; the final result text is used only when nothing streamed', async () => {
  const s = await setup();
  try {
    await installCodex(s);
    // Streamed deltas ("Codex fixture turn …") differ from the final text: the stream wins.
    patchNative(s, (result) => ({ ...result, text: 'a different final result' }));
    const streamed = await run(s, 'agent/codex', 'Answer MARKER:one');
    assert.equal(streamed.status, 'completed', JSON.stringify(streamed.error));
    assert.equal(streamed.output.map((m) => m.text).join(''), 'Codex fixture turn 1: one');
  } finally {
    await s.cleanup();
  }
  const quiet = await setup();
  try {
    await installCodex(quiet);
    // Same agent with its deltas withheld: the final result becomes the output.
    const original = quiet.runtime.execute.bind(quiet.runtime);
    quiet.runtime.execute = (async (work, signal, emit) => {
      const result = (await original(work, signal, async (event) =>
        event.type === 'text' ? undefined : emit(event),
      )) as Record<string, any>;
      return work.kind === 'native' ? { ...result, text: 'final only' } : result;
    }) as typeof quiet.runtime.execute;
    const final = await run(quiet, 'agent/codex', 'Answer MARKER:one');
    assert.equal(final.status, 'completed', JSON.stringify(final.error));
    assert.equal(final.output.map((m) => m.text).join(''), 'final only');
  } finally {
    await quiet.cleanup();
  }
});
