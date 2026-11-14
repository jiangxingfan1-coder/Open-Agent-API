import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from '../src/core/contracts.js';
import { REPAIR_MARKER } from '../src/kernel/output-contract.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { agent, FixtureModel, setup, token, waitFor } from './helpers.js';

// Structured output (docs/structured-output.md) end to end: a successful answer is JSON that fits, a
// wrong answer is sent back for correction, otherwise the run fails. Offline: a scripted model, the
// ACP stand-in fixture, in-process requests (no listening socket).

const PERSON = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'integer' } },
  required: ['name', 'age'],
  additionalProperties: false,
};
const GOOD = '{"name":"Ada","age":36}';
const CHAT_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'person', schema: PERSON, strict: true },
};

/** A model that answers with the scripted texts in order (the last one repeats) and records what it saw. */
function scripted(answers: string[]) {
  const seen: ModelMessage[][] = [];
  const model = new FixtureModel((_a, messages) => {
    seen.push(messages);
    const text = answers[Math.min(seen.length - 1, answers.length - 1)] ?? '';
    return { text };
  });
  return { model, seen };
}
async function lab(answers: string[], config: Record<string, unknown> = {}) {
  const { model, seen } = scripted(answers);
  const s = await setup(model, config);
  s.store.publish('owner', makeBundle(agent()));
  const chat = (
    extra: Record<string, unknown>,
    headers: Record<string, string> = {},
    path = '/v1/chat/completions',
  ) =>
    s.request(
      'POST',
      path,
      { model: 'agent/test', messages: [{ role: 'user', content: 'who?' }], ...extra },
      token,
      headers,
    );
  return { s, seen, model, chat };
}

test('chat: json_schema answer wrapped in prose and a fence comes back as plain JSON, on both chat endpoints', async () => {
  const { s, chat, seen } = await lab([
    'Here you go:\n```json\n{ "name": "Ada", "age": 36 }\n```\nBye!',
  ]);
  try {
    for (const path of ['/v1/chat/completions', '/v1/compat/chat/completions']) {
      const r = await chat({ response_format: CHAT_FORMAT }, {}, path);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().choices[0].message.content, GOOD);
      assert.equal(r.json().choices[0].finish_reason, 'stop');
    }
    // The agent was told the shape it has to produce.
    assert.match(
      seen[0]!.map((m) => m.content).join('\n'),
      /Response Format Requirement[\s\S]*"required":\["name","age"\]/,
    );
    const object = await chat({ response_format: { type: 'json_object' } });
    assert.equal(object.statusCode, 200, object.body);
    assert.equal(object.json().choices[0].message.content, GOOD);
  } finally {
    await s.cleanup();
  }
});

test('chat: a wrong answer is sent back once, the correction is returned, usage counts both rounds', async () => {
  const { s, chat, seen } = await lab(['{"name":"Ada"}', GOOD]);
  try {
    const r = await chat({ response_format: CHAT_FORMAT });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().choices[0].message.content, GOOD);
    assert.equal(seen.length, 2);
    const repair = seen[1]!.at(-1)!;
    assert.equal(repair.role, 'user');
    assert.ok(repair.content.startsWith(REPAIR_MARKER));
    assert.match(repair.content, /does not match the schema/);
    assert.match(repair.content, /required property 'age'|must have required property/);
    // 10 + 5 per round: two model turns are in the usage.
    assert.equal(r.json().usage.total_tokens, 30);
    const run = s.store.run(String(r.headers['x-run-id']));
    assert.equal(run.metadata['oaa.output_contract'], 'json_schema');
    assert.equal(run.metadata['oaa.output_repairs'], '1');
    // The run inspector's state says a contract was in force and that it needed one correction round.
    const state = await s.request('GET', `/v1/runs/${run.id}/state`);
    assert.deepEqual(state.json().output_contract, { kind: 'json_schema', repairs: 1 });
    // Only the final answer is in the run: the wrong attempt never reached the output or the events.
    assert.deepEqual(
      run.output.map((m) => m.text),
      [GOOD],
    );
    const deltas = s.store.history(run.id).filter((e) => e.type === 'response.output_text.delta');
    assert.equal(deltas.map((e) => (e.data as { delta: string }).delta).join(''), GOOD);
  } finally {
    await s.cleanup();
  }
});

test('chat: still wrong after the correction rounds fails with structured_output_invalid and does not quote the answer', async () => {
  const secret = 'TOP-SECRET-ANSWER-TEXT';
  const { s, chat, seen } = await lab([`${secret} is not json`]);
  try {
    const r = await chat({ response_format: CHAT_FORMAT });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.headers['x-should-retry'], 'false');
    assert.equal(r.json().error.code, 'structured_output_invalid');
    assert.match(r.json().error.message, /not parseable JSON/);
    assert.doesNotMatch(r.body, new RegExp(secret));
    assert.equal(seen.length, 2, 'one correction round by default');
    const run = s.store.run(r.json().error.run_id);
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.output, []);
    // Responses reports the same failure as status failed with the error code.
    const resp = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'who?',
      text: { format: { type: 'json_schema', name: 'person', schema: PERSON } },
    });
    assert.equal(resp.statusCode, 200);
    assert.equal(resp.json().status, 'failed');
    assert.equal(resp.json().error.code, 'structured_output_invalid');
  } finally {
    await s.cleanup();
  }
  const none = await lab(['nope'], { structuredOutput: { maxRepairs: 0 } });
  try {
    const r = await none.chat({ response_format: CHAT_FORMAT });
    assert.equal(r.json().error.code, 'structured_output_invalid');
    assert.equal(none.seen.length, 1, 'no correction round when maxRepairs is 0');
  } finally {
    await none.s.cleanup();
  }
  const two = await lab(['nope', 'nope', GOOD], { structuredOutput: { maxRepairs: 2 } });
  try {
    const r = await two.chat({ response_format: CHAT_FORMAT });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(two.seen.length, 3);
  } finally {
    await two.s.cleanup();
  }
});

test('streams are buffered: nothing of a wrong attempt is sent, the final JSON arrives in one piece', async () => {
  const { s, chat } = await lab(['{"name":"Ada"}', GOOD]);
  try {
    const r = await chat({
      response_format: CHAT_FORMAT,
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(r.statusCode, 200, r.body);
    const frames = r.body
      .split('\n\n')
      .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
      .map((f) => JSON.parse(f.slice(6)));
    const text = frames.map((f) => f.choices?.[0]?.delta?.content ?? '').join('');
    assert.equal(text, GOOD);
    const contentFrames = frames.filter((f) => f.choices?.[0]?.delta?.content);
    assert.equal(contentFrames.length, 1, 'the answer is one chunk');
    assert.equal(frames.at(-1).usage.total_tokens, 30);
    assert.ok(r.body.endsWith('data: [DONE]\n\n'));
    // A failing stream ends in the protocol's error, with no content at all.
    const bad = await lab(['prose only']);
    try {
      const f = await bad.chat({ response_format: CHAT_FORMAT, stream: true });
      assert.doesNotMatch(f.body, /prose only/);
      assert.match(f.body, /structured_output_invalid/);
    } finally {
      await bad.s.cleanup();
    }
    // Responses streaming: the same.
    const resp = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'who?',
      stream: true,
      text: { format: { type: 'json_schema', name: 'person', schema: PERSON } },
    });
    const deltas = [
      ...resp.body.matchAll(/event: response\.output_text\.delta\ndata: (.*)\n/g),
    ].map((m) => JSON.parse(m[1]!).delta);
    assert.equal(deltas.join(''), GOOD);
    assert.equal(deltas.length, 1);
  } finally {
    await s.cleanup();
  }
});

test('responses: text.format is applied and echoed; every protocol field maps to the same contract', async () => {
  const { s, seen } = await lab([GOOD]);
  try {
    const format = { type: 'json_schema', name: 'person', schema: PERSON, strict: true };
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'who?',
      text: { format },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().output[0].content[0].text, GOOD);
    assert.deepEqual(r.json().text.format, format);
    const plain = await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'who?' });
    assert.deepEqual(plain.json().text.format, { type: 'text' });

    const claude = await s.request('POST', '/v1/messages', {
      model: 'agent/test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'who?' }],
      output_config: { format: { type: 'json_schema', schema: PERSON } },
    });
    assert.equal(claude.statusCode, 200, claude.body);
    assert.equal(claude.json().content[0].text, GOOD);

    const gemini = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'who?' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { name: { type: 'STRING' }, age: { type: 'INTEGER' } },
          required: ['name', 'age'],
        },
      },
    });
    assert.equal(gemini.statusCode, 200, gemini.body);
    assert.equal(gemini.json().candidates[0].content.parts[0].text, GOOD);
    assert.equal(
      gemini.headers['x-oaa-ignored-params'],
      undefined,
      'the structured-output fields are applied, not ignored',
    );
    const snake = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'who?' }] }],
      generation_config: { response_mime_type: 'application/json', response_json_schema: PERSON },
    });
    assert.equal(snake.json().candidates[0].content.parts[0].text, GOOD);
    const anyJson = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'who?' }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    assert.equal(anyJson.json().candidates[0].content.parts[0].text, GOOD);
    assert.ok(seen.length >= 6);
    const enumMime = await s.request('POST', '/v1beta/models/agent%2Ftest:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      generationConfig: { responseMimeType: 'text/x.enum' },
    });
    assert.equal(enumMime.statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('schemas the gateway cannot enforce are refused at request time with the field that holds them', async () => {
  const { s, chat, seen } = await lab([GOOD]);
  try {
    const cases: [Record<string, unknown>, string, string][] = [
      [
        { type: 'object', properties: { a: { $ref: 'https://example.com/s.json' } } },
        'output_schema_unsupported',
        'response_format.json_schema.schema',
      ],
      [
        { type: 'string', format: 'made-up' },
        'output_schema_unsupported',
        'response_format.json_schema.schema',
      ],
      [
        { type: 'string', pattern: '(a+)+$' },
        'output_schema_unsupported',
        'response_format.json_schema.schema',
      ],
      [{ type: 'bogus' }, 'invalid_schema', 'response_format.json_schema.schema'],
    ];
    for (const [schema, code, param] of cases) {
      const r = await chat({
        response_format: { type: 'json_schema', json_schema: { name: 'x', schema } },
      });
      assert.equal(r.statusCode, 400, JSON.stringify(schema));
      assert.equal(r.json().error.code, code);
      assert.equal(r.json().error.param, param);
    }
    const missing = await chat({
      response_format: { type: 'json_schema', json_schema: { name: 'x' } },
    });
    assert.equal(missing.statusCode, 400);
    const unknown = await chat({ response_format: { type: 'xml' } });
    assert.equal(unknown.json().error.param, 'response_format.type');
    const claude = await s.request('POST', '/v1/messages', {
      model: 'agent/test',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'x' }],
      output_config: { format: { type: 'json_schema', schema: { $async: true } } },
    });
    assert.equal(claude.statusCode, 400);
    assert.equal(claude.json().error.code, 'output_schema_unsupported');
    assert.equal(seen.length, 0, 'no run was started for a refused schema');
  } finally {
    await s.cleanup();
  }
});

test('the schema formats are enforced: a date-time that is not one is sent back', async () => {
  const schema = {
    type: 'object',
    properties: { when: { type: 'string', format: 'date-time' } },
    required: ['when'],
  };
  const { s, chat, seen } = await lab(['{"when":"tomorrow"}', '{"when":"2026-11-14T10:00:00Z"}']);
  try {
    const r = await chat({
      response_format: { type: 'json_schema', json_schema: { name: 'w', schema } },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().choices[0].message.content, '{"when":"2026-11-14T10:00:00Z"}');
    assert.equal(seen.length, 2);
  } finally {
    await s.cleanup();
  }
});

test('requests without a structured format are untouched', async () => {
  const { s, chat } = await lab(['just text, not JSON']);
  try {
    for (const extra of [{}, { response_format: { type: 'text' } }]) {
      const r = await chat(extra);
      assert.equal(r.json().choices[0].message.content, 'just text, not JSON');
    }
    const run = s.store.allRuns().at(-1)!;
    assert.equal(run.metadata['oaa.output_contract'], undefined);
  } finally {
    await s.cleanup();
  }
});

test('with caller tools bridged: the tool round comes first, only the final answer is checked', async () => {
  const seen: ModelMessage[][] = [];
  const model = new FixtureModel((a, messages) => {
    seen.push(messages);
    const results = messages.filter((m) => m.role === 'tool');
    if (!results.length)
      return {
        text: 'Let me look.',
        calls: [{ id: 'm1', name: 'lookup', arguments: { q: 'ada' } }],
      };
    return { text: GOOD };
  });
  const s = await setup(model);
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
    );
    const tool = {
      type: 'function',
      function: {
        name: 'lookup',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    };
    const first = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/bridge',
      messages: [{ role: 'user', content: 'who?' }],
      tools: [tool],
      response_format: CHAT_FORMAT,
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().choices[0].finish_reason, 'tool_calls');
    assert.equal(
      first.json().choices[0].message.content,
      null,
      'the prose before the tool call is not output',
    );
    const call = first.json().choices[0].message.tool_calls[0];
    const done = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/bridge',
      tools: [tool],
      messages: [
        { role: 'user', content: 'who?' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'found Ada' },
      ],
      response_format: CHAT_FORMAT,
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().choices[0].message.content, GOOD);
    assert.equal(done.headers['x-run-id'], first.headers['x-run-id'], 'the same run continued');
  } finally {
    await s.cleanup();
  }
});

test('with a tool that needs approval: the run waits, then the answer is checked', async () => {
  const model = new FixtureModel((_a, messages) =>
    messages.some((m) => m.role === 'tool')
      ? { text: GOOD }
      : { calls: [{ id: 'w', name: 'write_file', arguments: { path: 'a.txt', content: 'b' } }] },
  );
  const s = await setup(model, { approvalTimeoutMs: 5000 });
  try {
    const write = builtin('write_file');
    write.capability.requiresApproval = true;
    s.store.publish('owner', makeBundle(agent({ id: 'agent/approve', tools: [write] })));
    const submitted = await s.request('POST', '/v1/responses', {
      model: 'agent/approve',
      input: 'write it',
      background: true,
      text: { format: { type: 'json_schema', name: 'person', schema: PERSON } },
    });
    const id = submitted.json().id as string;
    await waitFor(() => s.store.run(id).status === 'requires_action');
    assert.deepEqual(s.store.run(id).output, [], 'nothing is output while waiting');
    const action = s.store.approvals(id)[0]!;
    const decided = await s.request('POST', `/v1/runs/${id}/actions/${action.id}`, {
      decision: 'approve',
    });
    assert.equal(decided.statusCode, 200, decided.body);
    await waitFor(() => s.store.run(id).status === 'completed');
    assert.deepEqual(
      s.store.run(id).output.map((m) => m.text),
      [GOOD],
    );
  } finally {
    await s.cleanup();
  }
});

test('cancelling a run that holds its answer ends it cancelled, with no output', async () => {
  const model = new FixtureModel(async (_a, _m, signal) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    return { text: GOOD };
  });
  const s = await setup(model);
  try {
    s.store.publish('owner', makeBundle(agent()));
    const submitted = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'who?',
      background: true,
      text: { format: { type: 'json_schema', name: 'person', schema: PERSON } },
    });
    const id = submitted.json().id as string;
    await waitFor(() => model.calls === 1);
    const cancelled = await s.request('POST', `/v1/responses/${id}/cancel`, {});
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(s.store.run(id).status, 'cancelled');
    assert.deepEqual(s.store.run(id).output, []);
  } finally {
    await s.cleanup();
  }
});

test('the publisher outputSchema still applies next to the caller contract', async () => {
  const { s, chat } = await lab([GOOD]);
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/strict',
          outputSchema: {
            type: 'object',
            properties: { name: { const: 'Grace' } },
            required: ['name'],
          },
        }),
      ),
    );
    const r = await chat({ model: 'agent/strict', response_format: CHAT_FORMAT });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error.code, 'output_contract');
  } finally {
    await s.cleanup();
  }
});

test('GET /health advertises structured-output-v1', async () => {
  const { s } = await lab([GOOD]);
  try {
    const health = await s.app.inject({ method: 'GET', url: '/health' });
    assert.ok(health.json().features.includes('structured-output-v1'));
  } finally {
    await s.cleanup();
  }
});
