import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from '../src/core/contracts.js';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { agent, FixtureModel, setup, token } from './helpers.js';

// Gemini 入口的调用方工具桥接（docs/harness.md）。全部离线：inject + 确定性模型替身。

type Fixture = Awaited<ReturnType<typeof setup>>;
const BRIDGE = { 'x-oaa-client-tools': 'bridge' };
const SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const TOOLS = [
  {
    functionDeclarations: [
      { name: 'edit-file', description: 'Edit a file.', parameters: SCHEMA },
      { name: 'lint', parametersJsonSchema: { type: 'object' } },
    ],
  },
];
const USER = { role: 'user', parts: [{ text: 'Fix the bug.' }] };
const tools = (messages: ModelMessage[]) => messages.filter((m) => m.role === 'tool');

function model(parallel = false, text = 'Editing.') {
  return new FixtureModel((_a, messages) => {
    const results = tools(messages);
    if (!results.length)
      return {
        text,
        calls: [
          { id: 'a', name: 'edit_file', arguments: { path: 'a.ts' } },
          ...(parallel ? [{ id: 'b', name: 'lint', arguments: {} }] : []),
        ],
      };
    return { text: `R:${results.map((r) => r.content).join('|')}` };
  });
}
async function bridgeSetup(m: FixtureModel) {
  const s = await setup(m);
  s.store.publish(
    'owner',
    makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
  );
  return s;
}
const gemini = (
  s: Fixture,
  body: Record<string, unknown>,
  options: { headers?: Record<string, string>; prefix?: string; stream?: boolean } = {},
) =>
  s.request(
    'POST',
    `${options.prefix ?? '/v1beta'}/models/agent%2Fbridge:${options.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    { tools: TOOLS, ...body },
    token,
    options.headers ?? BRIDGE,
  );
const response = (name: string, value: unknown, id?: string) => ({
  functionResponse: { ...(id ? { id } : {}), name, response: value },
});
type Part = { text?: string; functionCall?: { id: string; name: string; args: unknown } };
const partsOf = (body: { candidates: { content: { parts: Part[] } }[] }) =>
  body.candidates[0]!.content.parts;
const chunks = (body: string) =>
  body
    .split('\n\n')
    .filter(Boolean)
    .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>);

test('gemini bridge: single call, functionCall part, functionResponse continuation (both prefixes)', async () => {
  for (const prefix of ['/v1beta', '/v1']) {
    const s = await bridgeSetup(model());
    try {
      const first = await gemini(s, { contents: [USER] }, { prefix });
      assert.equal(first.statusCode, 200, first.body);
      const runId = first.headers['x-run-id'] as string;
      const body = first.json();
      assert.equal(body.candidates[0].finishReason, 'STOP');
      assert.equal(body.responseId, runId);
      assert.ok(body.usageMetadata.totalTokenCount >= 0);
      const parts = partsOf(body);
      assert.deepEqual(parts[0], { text: 'Editing.' });
      const call = parts[1]!.functionCall!;
      assert.match(call.id, /^call_/);
      assert.deepEqual(
        { name: call.name, args: call.args },
        { name: 'edit-file', args: { path: 'a.ts' } },
      );
      const done = await gemini(
        s,
        {
          contents: [
            USER,
            { role: 'model', parts },
            { role: 'user', parts: [response('edit-file', { output: 'patched' }, call.id)] },
          ],
        },
        { prefix },
      );
      assert.equal(done.statusCode, 200, done.body);
      assert.equal(done.headers['x-run-id'], runId);
      assert.equal(done.json().responseId, runId);
      assert.equal(done.json().candidates[0].finishReason, 'STOP');
      assert.deepEqual(partsOf(done.json()), [{ text: 'R:{"output":"patched"}' }]);
    } finally {
      await s.cleanup();
    }
  }
});

test('gemini bridge: parallel calls; ids absent pair by name and order; role "function" accepted', async () => {
  const s = await bridgeSetup(model(true, ''));
  try {
    const first = await gemini(s, { contents: [USER] });
    const parts = partsOf(first.json());
    assert.deepEqual(
      parts.map((p) => p.functionCall?.name),
      ['edit-file', 'lint'],
    );
    const runId = first.headers['x-run-id'];
    // 不带 id：按上一条 model 内容里 functionCall 的名字与出现顺序配对。
    const done = await gemini(s, {
      contents: [
        USER,
        { role: 'model', parts },
        {
          role: 'function',
          parts: [response('lint', { output: 'clean' }), response('edit-file', { output: 'ok' })],
        },
      ],
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.headers['x-run-id'], runId);
    assert.equal(partsOf(done.json())[0]!.text, 'R:{"output":"ok"}|{"output":"clean"}');
  } finally {
    await s.cleanup();
  }
});

test('gemini bridge: a partial reply parks again with the remaining call', async () => {
  const s = await bridgeSetup(model(true, ''));
  try {
    const first = await gemini(s, { contents: [USER] });
    const [a, b] = partsOf(first.json()).map((p) => p.functionCall!);
    const partial = await gemini(s, {
      contents: [USER, { role: 'user', parts: [response(a!.name, { output: '1' }, a!.id)] }],
    });
    assert.equal(partial.headers['x-run-id'], first.headers['x-run-id']);
    assert.deepEqual(
      partsOf(partial.json()).map((p) => p.functionCall?.id),
      [b!.id],
    );
    const done = await gemini(s, {
      contents: [USER, { role: 'user', parts: [response(b!.name, { output: '2' }, b!.id)] }],
    });
    assert.equal(partsOf(done.json())[0]!.text, 'R:{"output":"1"}|{"output":"2"}');
  } finally {
    await s.cleanup();
  }
});

test('gemini bridge: streaming gives the calls as whole parts in one chunk, then resumes', async () => {
  for (const text of ['', 'Editing.']) {
    const s = await bridgeSetup(model(false, text));
    try {
      const first = await gemini(s, { contents: [USER] }, { stream: true });
      assert.equal(first.statusCode, 200, first.body);
      const runId = first.headers['x-run-id'] as string;
      const callId = s.store.approvals(runId)[0]!.id;
      const all = chunks(first.body);
      const last = all.at(-1) as {
        candidates: { content: { parts: Part[] }; finishReason: string }[];
        usageMetadata: { candidatesTokenCount: number };
      };
      assert.deepEqual(last.candidates[0]!.content.parts, [
        { functionCall: { id: callId, name: 'edit-file', args: { path: 'a.ts' } } },
      ]);
      assert.equal(last.candidates[0]!.finishReason, 'STOP');
      assert.equal(last.usageMetadata.candidatesTokenCount, 5);
      assert.ok(!all.some((c) => 'error' in c), first.body);
      const streamedText = all
        .slice(0, -1)
        .map((c) => partsOf(c as never)[0]?.text ?? '')
        .join('');
      assert.equal(streamedText, text);
      const second = await gemini(
        s,
        { contents: [USER, { role: 'user', parts: [response('edit-file', 'ok', callId)] }] },
        { stream: true },
      );
      assert.equal(second.headers['x-run-id'], runId);
      const next = chunks(second.body);
      assert.equal(
        (next.at(-1) as { candidates: { finishReason: string }[] }).candidates[0]!.finishReason,
        'STOP',
      );
      assert.equal(next.map((c) => partsOf(c as never)[0]?.text ?? '').join(''), 'R:ok');
    } finally {
      await s.cleanup();
    }
  }
});

test('gemini bridge: JSON-array streaming (no alt=sse) also carries the call', async () => {
  const s = await bridgeSetup(model(false, ''));
  try {
    const r = await s.request(
      'POST',
      '/v1beta/models/agent%2Fbridge:streamGenerateContent',
      { tools: TOOLS, contents: [USER] },
      token,
      BRIDGE,
    );
    const body = JSON.parse(r.body) as { candidates: { content: { parts: Part[] } }[] }[];
    assert.equal(body.at(-1)!.candidates[0]!.content.parts[0]!.functionCall!.name, 'edit-file');
  } finally {
    await s.cleanup();
  }
});

test('gemini bridge: unpaired or unknown results fall back to a new request; run stays parked', async () => {
  const s = await bridgeSetup(model());
  try {
    const first = await gemini(s, { contents: [USER] });
    const runId = first.headers['x-run-id'];
    const parts = partsOf(first.json());
    const callId = parts[1]!.functionCall!.id;
    const unknownId = await gemini(s, {
      contents: [USER, { role: 'user', parts: [response('edit-file', 'x', 'call_nope')] }],
    });
    assert.equal(unknownId.statusCode, 200, unknownId.body);
    assert.notEqual(unknownId.headers['x-run-id'], runId);
    // 不带 id、也没有可配对的 model 内容：配不上。
    const noHistory = await gemini(s, {
      contents: [USER, { role: 'user', parts: [response('edit-file', 'x')] }],
    });
    assert.notEqual(noHistory.headers['x-run-id'], runId);
    // 名字配不上（上一条 model 内容里没有这个函数）。
    const wrongName = await gemini(s, {
      contents: [USER, { role: 'model', parts }, { role: 'user', parts: [response('other', 'x')] }],
    });
    assert.notEqual(wrongName.headers['x-run-id'], runId);
    assert.equal(s.store.getApproval(callId, 'owner').status, 'pending');
  } finally {
    await s.cleanup();
  }
});

test('gemini bridge: built-in tools are refused; bad declarations are invalid; toolConfig is ignored', async () => {
  const s = await bridgeSetup(model());
  try {
    for (const tool of [
      { googleSearch: {} },
      { codeExecution: {} },
      { urlContext: {} },
      { functionDeclarations: [{ name: 'x' }], googleSearch: {} },
    ]) {
      const r = await gemini(s, { contents: [USER], tools: [tool] });
      assert.equal(r.statusCode, 400, JSON.stringify(tool));
      assert.equal(r.json().error.details[0].reason, 'client_tools_unsupported');
      assert.match(
        r.json().error.message,
        /Bridge mode on Gemini accepts only caller-defined function tools/,
      );
    }
    const nameless = await gemini(s, {
      contents: [USER],
      tools: [{ functionDeclarations: [{ description: 'x' }] }],
    });
    assert.equal(nameless.statusCode, 400);
    assert.equal(nameless.json().error.details[0].reason, 'invalid_client_tool');
    const configured = await gemini(s, {
      contents: [USER],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lint'] } },
    });
    assert.equal(configured.statusCode, 200, configured.body);
    assert.match(String(configured.headers['x-oaa-ignored-params']), /toolConfig/);
    assert.equal(partsOf(configured.json())[1]!.functionCall!.name, 'edit-file');
  } finally {
    await s.cleanup();
  }
});

test('gemini: managed mode is unchanged by bridging; an image for a text-only agent is refused', async () => {
  const s = await bridgeSetup(new FixtureModel(() => ({ text: 'Done.' })));
  try {
    const managed = await gemini(
      s,
      { contents: [USER] },
      { headers: { 'x-oaa-client-tools': 'managed' } },
    );
    assert.equal(managed.statusCode, 200, managed.body);
    assert.equal(managed.headers['x-oaa-client-tools'], 'ignored');
    assert.ok(partsOf(managed.json()).every((p) => !p.functionCall));
    const builtinManaged = await gemini(
      s,
      { contents: [USER], tools: [{ googleSearch: {} }] },
      {
        headers: { 'x-oaa-client-tools': 'managed' },
      },
    );
    assert.equal(builtinManaged.statusCode, 200, 'managed still ignores built-in tools');
    const inline = await gemini(s, {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              },
            },
          ],
        },
      ],
    });
    assert.equal(inline.statusCode, 400);
    assert.equal(inline.json().error.details[0].reason, 'unsupported_content');
  } finally {
    await s.cleanup();
  }
});

test('gemini bridge: OpenAPI-style parameters (uppercase types, nullable) become JSON Schema', async () => {
  const s = await bridgeSetup(model());
  try {
    const r = await gemini(s, {
      contents: [USER],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'edit-file',
              parameters: {
                type: 'OBJECT',
                properties: {
                  path: { type: 'STRING', nullable: true },
                  tags: { type: 'ARRAY', items: { type: 'STRING' } },
                },
                required: ['path'],
              },
            },
          ],
        },
      ],
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(partsOf(r.json()).at(-1)!.functionCall!.name, 'edit-file');
  } finally {
    await s.cleanup();
  }
});

test('gemini bridge: every nested schema position is converted; keyword-named properties and values stay', async () => {
  const s = await bridgeSetup(model());
  const str = { type: 'STRING', nullable: true };
  try {
    const r = await gemini(s, {
      contents: [USER],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'edit-file',
              parameters: {
                type: 'OBJECT',
                properties: {
                  type: { type: 'STRING' },
                  nullable: { type: 'BOOLEAN' },
                  items: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  pick: { oneOf: [str, { type: 'NUMBER' }] },
                  both: { allOf: [{ type: 'OBJECT' }, { $ref: '#/$defs/Node' }] },
                  never: { not: { type: 'NULL' } },
                  map: { type: 'OBJECT', additionalProperties: str },
                  open: { type: 'OBJECT', additionalProperties: true },
                  tuple: { type: 'ARRAY', prefixItems: [{ type: 'STRING' }, { type: 'NUMBER' }] },
                  pattern: { type: 'OBJECT', patternProperties: { '^x-': str } },
                  mode: {
                    type: 'STRING',
                    enum: ['STRING', 'OBJECT'],
                    default: 'STRING',
                    const: 'STRING',
                    example: { type: 'OBJECT' },
                    examples: [{ type: 'ARRAY', nullable: true }],
                  },
                },
                $defs: {
                  Node: { type: 'OBJECT', properties: { type: { type: 'STRING' } } },
                  type: { type: 'INTEGER', nullable: true },
                },
                definitions: { items: { type: 'BOOLEAN' } },
              },
            },
          ],
        },
      ],
    });
    assert.equal(r.statusCode, 200, r.body);
    const runId = String(r.headers['x-run-id']);
    const json = { type: ['string', 'null'] };
    assert.deepEqual(s.store.run(runId).checkpoint.bridge!.tools[0]!.parameters, {
      type: 'object',
      properties: {
        type: { type: 'string' },
        nullable: { type: 'boolean' },
        items: { type: 'array', items: { type: 'integer' } },
        pick: { oneOf: [json, { type: 'number' }] },
        both: { allOf: [{ type: 'object' }, { $ref: '#/$defs/Node' }] },
        never: { not: { type: 'null' } },
        map: { type: 'object', additionalProperties: json },
        open: { type: 'object', additionalProperties: true },
        tuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
        pattern: { type: 'object', patternProperties: { '^x-': json } },
        mode: {
          type: 'string',
          enum: ['STRING', 'OBJECT'],
          default: 'STRING',
          const: 'STRING',
          example: { type: 'OBJECT' },
          examples: [{ type: 'ARRAY', nullable: true }],
        },
      },
      $defs: {
        Node: { type: 'object', properties: { type: { type: 'string' } } },
        type: { type: ['integer', 'null'] },
      },
      definitions: { items: { type: 'boolean' } },
    });
  } finally {
    await s.cleanup();
  }
});
