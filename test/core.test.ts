import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import { makeBundle, validateBundle, buildBundle, builtin } from '../src/lang/bundle.js';
import {
  agent,
  setup,
  FixtureModel,
  principal,
  researchBundle,
  researchFixture,
  token,
  secondToken,
  waitFor,
} from './helpers.js';
import { parseGraph, executeGraph } from '../src/lang/graph.js';
import { invocationSchema, ModelRouter } from '../src/gateway/protocol.js';
import { sleep, sha, readBounded } from '../src/core/util.js';

test('bundles are canonical, immutable and tamper evident', () => {
  const a = makeBundle(agent());
  assert.equal(a.digest, makeBundle(agent()).digest);
  const changed = structuredClone(a);
  changed.agent.instructions = 'Changed';
  assert.throws(() => validateBundle(changed), /digest/);
  assert.notEqual(a.digest, makeBundle(agent({ instructions: 'Changed' })).digest);
});
test('publication rejects secret and traversal files', () => {
  for (const name of ['../escape', '.env', 'credentials.json', 'a\\b'])
    assert.throws(() =>
      makeBundle(agent(), [
        { path: name, content: Buffer.from('x').toString('base64'), sha256: sha('x') },
      ]),
    );
  const data = '-----BEGIN PRIVATE KEY-----';
  assert.throws(
    () =>
      makeBundle(agent(), [
        { path: 'key.txt', content: Buffer.from(data).toString('base64'), sha256: sha(data) },
      ]),
    /secret/,
  );
});
test('explicit local skill import preserves instructions without taking other folders', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-import-'));
  try {
    await writeFile(path.join(dir, 'definition.json'), JSON.stringify({ ...agent(), files: [] }));
    const skill = path.join(dir, 'selected');
    await import('node:fs/promises').then((fs) => fs.mkdir(skill));
    await writeFile(
      path.join(skill, 'SKILL.md'),
      '---\nname: local-test\ndescription: Local test skill\n---\nActual local instructions.',
    );
    await writeFile(path.join(dir, 'unrelated.txt'), 'private unrelated');
    const b = await buildBundle(path.join(dir, 'definition.json'), [skill]);
    assert.equal(b.files.length, 1);
    assert.match(Buffer.from(b.files[0]!.content, 'base64').toString(), /Actual local/);
    assert.equal(b.agent.skills[0]?.name, 'local-test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('file operations reject symlink escapes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-path-'));
  try {
    await symlink('/etc', path.join(dir, 'link'));
    await assert.rejects(() => readBounded(dir, 'link/hosts'), /Symlinks/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('graph validates dependencies, cycles, unknown tools and references', async () => {
  const allowed = new Set(['read', 'join']);
  const steps = parseGraph(
    {
      steps: [
        { id: 'a', tool: 'read', arguments: {} },
        { id: 'b', tool: 'join', arguments: { text: { $ref: 'a#/text' } } },
      ],
    },
    allowed,
  );
  const value = await executeGraph(steps, 4, new AbortController().signal, async (s, args) =>
    s.id === 'a' ? { text: 'value' } : args,
  );
  assert.deepEqual(value.b, { text: 'value' });
  assert.throws(
    () =>
      parseGraph(
        {
          steps: [
            { id: 'a', tool: 'read', arguments: { x: { $ref: 'b#' } } },
            { id: 'b', tool: 'read', arguments: { x: { $ref: 'a#' } } },
          ],
        },
        allowed,
      ),
    /cycle/,
  );
  assert.throws(
    () => parseGraph({ steps: [{ id: 'a', tool: 'missing', arguments: {} }] }, allowed),
    /Unregistered/,
  );
  assert.throws(
    () =>
      parseGraph(
        { steps: [{ id: 'a', tool: 'read', arguments: { x: { $ref: 'missing#' } } }] },
        allowed,
      ),
    /missing/,
  );
});
test('independent graph operations overlap while dependent operations wait', async () => {
  let active = 0,
    max = 0;
  const seen: string[] = [];
  const steps = parseGraph(
    {
      steps: [
        { id: 'a', tool: 'read', arguments: {} },
        { id: 'b', tool: 'read', arguments: {} },
        { id: 'c', tool: 'read', arguments: {}, depends_on: ['a', 'b'] },
      ],
    },
    new Set(['read']),
  );
  await executeGraph(steps, 4, new AbortController().signal, async (s) => {
    active++;
    max = Math.max(max, active);
    await sleep(20);
    seen.push(s.id);
    active--;
    return s.id;
  });
  assert.equal(max, 2);
  assert.equal(seen.at(-1), 'c');
});
test('automatic routing respects availability, explicit selection and sticky sessions', () => {
  const router = new ModelRouter();
  const a = agent({
    routes: [
      { id: 'fast', provider: 'a', model: 'm1', priority: 0 },
      { id: 'quality', provider: 'b', model: 'm2', priority: 1 },
    ],
  });
  assert.equal(router.select('o', 'd', a, 'auto', (p) => p === 'b').model, 'm2');
  assert.equal(router.select('o', 'd', a, 'quality', () => true).mode, 'explicit');
  assert.throws(() => router.select('o', 'd', a, 'unknown', () => true), /published/);
  const previous = { route: { id: 'fast', provider: 'a', model: 'm1', mode: 'auto' } } as never;
  assert.throws(() => router.select('o', 'd', a, 'quality', () => true, previous), /new session/);
});
test('an explicit model route reaches the selected backend model unchanged', async () => {
  const s = await setup(new FixtureModel((a) => ({ text: `selected ${a.model}` })));
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          routes: [
            { id: 'fast', provider: 'fixture', model: 'fast-model', priority: 0 },
            { id: 'quality', provider: 'fixture', model: 'quality-model', priority: 1 },
          ],
        }),
      ),
    );
    const r = await s.request('POST', '/v1/invoke', {
      agent: 'agent/test',
      model: 'quality',
      input: 'use this model',
    });
    assert.equal(r.json().metadata['oaa.selected_model'], 'quality-model');
    assert.equal(r.json().output[0].content[0].text, 'selected quality-model');
  } finally {
    await s.cleanup();
  }
});
test('native bundles cannot silently ignore portable tool bindings', () => {
  assert.throws(() => agent({ engine: 'codex', tools: [builtin('read_file')] }), /Portable tool/);
});
test('HTTP authentication and owner isolation precede execution', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/v1/responses',
          payload: { model: 'agent/test', input: 'hi' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi' }, secondToken))
        .statusCode,
      404,
    );
    assert.equal(s.driver.calls, 0);
    assert.equal(
      (
        await s.request('GET', '/v1/agents', undefined, token, {
          origin: 'https://untrusted.example',
        })
      ).statusCode,
      403,
    );
  } finally {
    await s.cleanup();
  }
});
test('a real kernel loop reads a skill and files, runs tools and returns an artifact without a live model', async () => {
  const s = await setup(researchFixture());
  try {
    s.store.publish('owner', researchBundle());
    const files = [];
    for (let i = 0; i < 3; i++) {
      const r = await s.request('POST', '/v1/files', {
        filename: `source-${i}.txt`,
        content: `Source ${i}: verified fixture value ${i * 10}.`,
      });
      assert.equal(r.statusCode, 200, r.body);
      files.push(r.json().id);
    }
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/research',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Create a report.' },
            ...files.map((file_id) => ({ type: 'input_file', file_id })),
          ],
        },
      ],
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, 'completed', r.body);
    const run = s.store.run(r.json().id);
    assert.equal(run.artifactIds.length, 1);
    const artifact = await s.request('GET', `/v1/files/${run.artifactIds[0]}/content`);
    assert.match(artifact.body, /verified fixture value 20/);
    assert.equal(s.store.steps(run.id).filter((x) => x.status === 'completed').length, 6);
    assert.equal(
      (await s.request('GET', `/v1/files/${run.artifactIds[0]}/content`, undefined, secondToken))
        .statusCode,
      404,
    );
  } finally {
    await s.cleanup();
  }
});
test('idempotency does not execute the same request twice, and conflicts are rejected', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const body = { model: 'agent/test', input: 'hi' };
    const a = await s.request('POST', '/v1/responses', body, token, { 'idempotency-key': 'same' });
    const b = await s.request('POST', '/v1/responses', body, token, { 'idempotency-key': 'same' });
    assert.equal(a.json().id, b.json().id);
    assert.equal(s.driver.calls, 1);
    assert.equal(
      (
        await s.request('POST', '/v1/responses', { ...body, input: 'other' }, token, {
          'idempotency-key': 'same',
        })
      ).statusCode,
      409,
    );
  } finally {
    await s.cleanup();
  }
});
test('unsupported OpenAI fields fail instead of being silently ignored', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const chat = (extra: Record<string, unknown>) =>
      s.request('POST', '/v1/chat/completions', {
        model: 'agent/test',
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
      });
    // 不支持的字段报 unsupported_parameter 并给出 param，不再静默。
    for (const extra of [{ tools: [{ type: 'function' }] }, { n: 2 }]) {
      const r = await chat(extra);
      assert.equal(r.statusCode, 400);
      assert.equal(r.json().error.code, 'unsupported_parameter');
      assert.equal(r.json().error.param, Object.keys(extra)[0]);
    }
    // 采样参数接受但不转发，经 X-OAA-Ignored-Params 告知；max_tokens 生效。
    const sampled = await chat({ temperature: 0.1 });
    assert.equal(sampled.statusCode, 200);
    assert.equal(sampled.headers['x-oaa-ignored-params'], 'temperature');
    const capped = await chat({ max_tokens: 10 });
    assert.equal(capped.statusCode, 200);
    assert.equal(capped.headers['x-oaa-ignored-params'], undefined);
  } finally {
    await s.cleanup();
  }
});
test('Responses SSE has ordered protocol events and a completed final response', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'hi',
      stream: true,
    });
    assert.equal(r.statusCode, 200);
    const events = r.body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    assert.equal(events[0].type, 'response.created');
    assert.ok(events.some((e) => e.type === 'response.output_text.delta'));
    assert.equal(events.at(-1).type, 'response.completed');
    assert.ok(events.every((e, i) => i === 0 || e.sequence_number > events[i - 1].sequence_number));
  } finally {
    await s.cleanup();
  }
});
test('Chat Completions ordinary and stream share the execution core', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const body = { model: 'agent/test', messages: [{ role: 'user', content: 'hi' }] };
    const r = await s.request('POST', '/v1/chat/completions', body);
    assert.equal(r.json().choices[0].message.content, 'Fixture response.');
    const stream = await s.request('POST', '/v1/chat/completions', { ...body, stream: true });
    assert.match(stream.body, /chat.completion.chunk/);
    assert.match(stream.body, /\[DONE\]/);
  } finally {
    await s.cleanup();
  }
});
test('approvals block tool execution until the scoped owner responds', async () => {
  const b = builtin('write_file');
  b.capability.requiresApproval = true;
  const driver = new FixtureModel((_a, m) =>
    m.some((x) => x.role === 'tool')
      ? { text: 'done' }
      : {
          calls: [
            { id: 'write', name: 'write_file', arguments: { path: 'a.txt', content: 'approved' } },
          ],
        },
  );
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ tools: [b] })));
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'write',
      background: true,
    });
    const runId = r.json().id;
    await waitFor(() => s.store.run(runId).status === 'requires_action');
    assert.equal(s.store.steps(runId)[0]?.status, 'pending');
    const a = s.store.approvals(runId)[0]!;
    assert.equal(
      (
        await s.request(
          'POST',
          `/v1/runs/${runId}/actions/${a.id}`,
          { decision: 'approve' },
          secondToken,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await s.request('POST', `/v1/runs/${runId}/actions/${a.id}`, { decision: 'approve' }))
        .statusCode,
      200,
    );
    assert.equal((await s.kernel.wait(runId)).status, 'completed');
    assert.equal(
      (await s.request('POST', `/v1/runs/${runId}/actions/${a.id}`, { decision: 'approve' }))
        .statusCode,
      409,
    );
  } finally {
    await s.cleanup();
  }
});
test('approval expiration is a failure rather than an implicit grant', async () => {
  const b = builtin('write_file');
  b.capability.requiresApproval = true;
  const s = await setup(
    new FixtureModel(() => ({
      calls: [{ id: 'w', name: 'write_file', arguments: { path: 'x', content: 'x' } }],
    })),
    { approvalTimeoutMs: 50 },
  );
  try {
    s.store.publish('owner', makeBundle(agent({ tools: [b] })));
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'x',
      background: true,
    });
    const done = await s.kernel.wait(r.json().id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'approval_expired');
    assert.equal(done.artifactIds.length, 0);
  } finally {
    await s.cleanup();
  }
});
test('cancellation stops an owned in-flight model operation', async () => {
  const s = await setup(
    new FixtureModel(async (_a, _m, signal) => {
      await sleep(5000, signal);
      return { text: 'late' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'hi',
      background: true,
    });
    await waitFor(() => s.driver.calls > 0);
    const cancelled = await s.request('POST', `/v1/responses/${r.json().id}/cancel`, {});
    assert.equal(cancelled.json().status, 'cancelled');
    assert.equal(s.store.run(r.json().id).output.length, 0);
  } finally {
    await s.cleanup();
  }
});
test('published version and model are pinned across continuation', async () => {
  const s = await setup();
  try {
    const b = makeBundle(agent());
    s.store.publish('owner', b);
    const first = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi' });
    s.store.publish('owner', makeBundle(agent({ instructions: 'new' })));
    const next = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'continue',
      previous_response_id: first.json().id,
    });
    assert.equal(next.json().metadata['oaa.agent_version'], b.digest);
    assert.equal(s.store.run(next.json().id).sessionId, s.store.run(first.json().id).sessionId);
  } finally {
    await s.cleanup();
  }
});
test('scoped and revoked keys cannot access other agents or execute after revocation', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/other' })));
    const created = await s.request('POST', '/v1/keys', {
      name: 'limited',
      agents: ['agent/test'],
      scopes: ['read', 'invoke'],
    });
    const key = created.json();
    assert.equal(
      (await s.request('GET', '/v1/agents', undefined, key.token)).json().data.length,
      1,
    );
    assert.equal(
      (await s.request('POST', '/v1/responses', { model: 'agent/other', input: 'hi' }, key.token))
        .statusCode,
      403,
    );
    await s.request('DELETE', `/v1/keys/${key.id}`);
    assert.equal((await s.request('GET', '/v1/agents', undefined, key.token)).statusCode, 401);
  } finally {
    await s.cleanup();
  }
});
