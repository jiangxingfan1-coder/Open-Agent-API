import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClaudeMessages,
  parseCompatChat,
  parseCompatResponse,
} from '../src/gateway/protocol.js';
import { parseGeminiGenerateContent, parseUapRequest } from '../src/gateway/uap.js';
import { GATEWAY_FEATURES } from '../src/gateway/server.js';
import { conversionProfile } from '../src/engines/conformance.js';
import {
  CLIENT_TOOLS_MANAGED_NOTE,
  CLIENT_TOOLS_MODES,
  assertClientToolsSupported,
  resolveClientToolsMode,
} from '../src/kernel/harness.js';
import { makeBundle } from '../src/lang/bundle.js';
import { agent, setup } from './helpers.js';

// 双层 Harness 契约（docs/harness.md）：调用方在兼容接口里传入自己的工具时的三种模式。
// 全部离线：解析函数直接调用，网关用 Fastify inject，不监听端口。

const TOOL = { type: 'function', function: { name: 'edit_file', parameters: { type: 'object' } } };
const RESP_TOOL = { type: 'function', name: 'edit_file', parameters: { type: 'object' } };
const CLAUDE_TOOL = { name: 'edit_file', input_schema: { type: 'object' } };
const SUFFIX = `\n\n[Harness note] ${CLIENT_TOOLS_MANAGED_NOTE}`;

type Parser = (body: Record<string, unknown>, headers?: Record<string, unknown>) => unknown;
const PROTOCOLS: { name: string; parse: Parser; body: Record<string, unknown>; tool: unknown }[] = [
  {
    name: 'chat',
    parse: parseCompatChat as Parser,
    body: { model: 'agent/test', messages: [{ role: 'user', content: 'Hello' }] },
    tool: TOOL,
  },
  {
    name: 'responses',
    parse: parseCompatResponse as Parser,
    body: { model: 'agent/test', input: 'Hello' },
    tool: RESP_TOOL,
  },
  {
    name: 'claude',
    parse: parseClaudeMessages as Parser,
    body: { model: 'agent/test', max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }] },
    tool: CLAUDE_TOOL,
  },
];

// 改动前的解析结果（逐字段内联），不带工具的请求必须与之完全相同。
const BASELINE: Record<string, unknown> = {
  chat: {
    protocol: 'oaa/1',
    agent: 'agent/test',
    model: 'auto',
    input: '[user]\nHello',
    file_ids: [],
    agent_version: undefined,
    background: false,
    stream: false,
    metadata: { 'oaa.compat_mode': 'true' },
  },
  responses: {
    protocol: 'oaa/1',
    agent: 'agent/test',
    model: 'auto',
    input: 'Hello',
    file_ids: [],
    previous_response_id: undefined,
    agent_version: undefined,
    background: false,
    stream: false,
    metadata: { 'oaa.compat_mode': 'true' },
  },
  claude: {
    protocol: 'oaa/1',
    agent: 'agent/test',
    model: 'auto',
    input: 'Hello',
    file_ids: [],
    agent_version: undefined,
    background: false,
    stream: false,
    // max_tokens 不再被丢弃，作为输出上限传给内核。
    metadata: { 'oaa.max_output_tokens': '64' },
  },
};
const same = (actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
};

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
type Inv = { input: string; metadata: Record<string, string> };

test('harness: mode resolution, note and bridge precheck', () => {
  assert.deepEqual([...CLIENT_TOOLS_MODES], ['managed', 'bridge', 'reject']);
  assert.equal(resolveClientToolsMode({}, {}), 'managed');
  assert.equal(resolveClientToolsMode({ 'x-oaa-client-tools': 'REJECT' }, {}), 'reject');
  assert.equal(resolveClientToolsMode({}, { 'oaa.client_tools': 'Bridge' }), 'bridge');
  assert.equal(
    resolveClientToolsMode({ 'x-oaa-client-tools': 'managed' }, { 'oaa.client_tools': 'reject' }),
    'managed',
  );
  assert.throws(
    () => resolveClientToolsMode({ 'x-oaa-client-tools': 'proxy' }, {}),
    (e: { code?: string; status?: number; message: string }) =>
      e.code === 'invalid_request' &&
      e.status === 400 &&
      ['managed', 'bridge', 'reject'].every((m) => e.message.includes(m)),
  );
  assert.equal(CLIENT_TOOLS_MANAGED_NOTE.split(/(?<=\.)\s+/).length, 3);
  assert.throws(
    () => assertClientToolsSupported(agent({ engine: 'codex', model: 'default' }), 'bridge'),
    code('client_tools_bridge_unsupported'),
  );
  assertClientToolsSupported(agent(), 'bridge'); // 内核智能体支持桥接（T09）
  assertClientToolsSupported(agent({ engine: 'codex', model: 'default' }), 'managed');
  assertClientToolsSupported(agent(), undefined);
});

for (const p of PROTOCOLS) {
  test(`harness ${p.name}: no tools and empty tools are byte-identical to before`, () => {
    same(p.parse(p.body), BASELINE[p.name]);
    same(p.parse({ ...p.body, tools: [] }), BASELINE[p.name]);
    // 不带工具时，模式请求头（哪怕是非法值）也不影响解析。
    same(p.parse(p.body, { 'x-oaa-client-tools': 'nonsense' }), BASELINE[p.name]);
  });

  test(`harness ${p.name}: managed (default and explicit) appends the note`, () => {
    const base = BASELINE[p.name] as Inv;
    for (const [body, headers] of [
      [{ ...p.body, tools: [p.tool, p.tool] }, {}],
      [{ ...p.body, tools: [p.tool, p.tool] }, { 'x-oaa-client-tools': 'Managed' }],
      [{ ...p.body, tools: [p.tool, p.tool], metadata: { 'oaa.client_tools': 'managed' } }, {}],
    ] as const) {
      const inv = p.parse(body, headers) as Inv;
      assert.ok(inv.input.endsWith(SUFFIX));
      assert.equal(inv.input, base.input + SUFFIX);
      assert.equal(inv.metadata['oaa.client_tools'], 'managed');
      assert.equal(inv.metadata['oaa.client_tools_ignored'], '2');
    }
  });

  test(`harness ${p.name}: reject, bridge, invalid mode, header beats metadata`, () => {
    const withTools = { ...p.body, tools: [p.tool] };
    assert.throws(
      () => p.parse(withTools, { 'x-oaa-client-tools': 'reject' }),
      code('client_tools_unsupported'),
    );
    assert.throws(
      () => p.parse({ ...withTools, metadata: { 'oaa.client_tools': 'reject' } }),
      code('client_tools_unsupported'),
    );
    const bridged = p.parse(withTools, { 'x-oaa-client-tools': 'bridge' }) as Inv;
    assert.equal(bridged.metadata['oaa.client_tools'], 'bridge');
    assert.equal(bridged.input, (BASELINE[p.name] as Inv).input);
    assert.throws(
      () => p.parse(withTools, { 'x-oaa-client-tools': 'both' }),
      code('invalid_request'),
    );
    const overridden = p.parse(
      { ...withTools, metadata: { 'oaa.client_tools': 'reject' } },
      { 'x-oaa-client-tools': 'managed' },
    ) as Inv;
    assert.equal(overridden.metadata['oaa.client_tools'], 'managed');
  });
}

test('harness: inline directives are still recognised before the note is appended', () => {
  const inv = parseCompatChat(
    {
      model: 'agent/test',
      messages: [{ role: 'user', content: '@oaa(speed)\nHello' }],
      tools: [TOOL],
    },
    {},
  );
  assert.ok(!inv.input.includes('@oaa('), inv.input);
  assert.equal(inv.metadata['oaa.routing_strategy'], 'speed');
  assert.equal(inv.input, `[user]\nHello${SUFFIX}`);
  assert.ok(inv.input.endsWith(SUFFIX));
});

test('harness: Gemini supports managed, reject and bridge; UAP keeps rejecting tools strictly', () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }],
  };
  const plain = parseGeminiGenerateContent({ contents: body.contents }, 'agent/test');
  const managed = parseGeminiGenerateContent(body, 'agent/test');
  assert.equal(managed.input, plain.input + SUFFIX);
  assert.equal(managed.metadata['oaa.client_tools_ignored'], '2');
  assert.throws(
    () => parseGeminiGenerateContent(body, 'agent/test', false, { 'x-oaa-client-tools': 'reject' }),
    code('client_tools_unsupported'),
  );
  const bridged = parseGeminiGenerateContent(body, 'agent/test', false, {
    'x-oaa-client-tools': 'bridge',
  });
  assert.equal(bridged.metadata['oaa.client_tools'], 'bridge');
  assert.deepEqual(
    bridged.client_tools?.map((t) => t.name),
    ['a', 'b'],
  );
  assert.deepEqual(
    parseGeminiGenerateContent({ ...body, tools: [] }, 'agent/test'),
    plain,
    'empty tools are ignored as before',
  );
  assert.throws(() => parseUapRequest({ target: 'agent/test', input: 'x', tools: [TOOL] }));
});

test('harness gateway: X-OAA-Client-Tools header, errors and bridge precheck', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/native', engine: 'codex' })));
    const compat = { 'x-oaa-compat': 'true' };
    const chat = { model: 'agent/test', messages: [{ role: 'user', content: 'Hello' }] };

    const plain = await s.request('POST', '/v1/chat/completions', chat, undefined, compat);
    assert.equal(plain.statusCode, 200, plain.body);
    assert.equal(plain.headers['x-oaa-client-tools'], undefined);

    const managed = await s.request(
      'POST',
      '/v1/chat/completions',
      { ...chat, tools: [TOOL] },
      undefined,
      compat,
    );
    assert.equal(managed.statusCode, 200, managed.body);
    assert.equal(managed.headers['x-oaa-client-tools'], 'ignored');

    const streamed = await s.request('POST', '/v1/compat/messages', {
      model: 'agent/test',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [CLAUDE_TOOL],
    });
    assert.equal(streamed.statusCode, 200, streamed.body);
    assert.equal(streamed.headers['x-oaa-client-tools'], 'ignored');
    const streamedPlain = await s.request('POST', '/v1/compat/messages', {
      model: 'agent/test',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(streamedPlain.headers['x-oaa-client-tools'], undefined);

    const rejected = await s.request(
      'POST',
      '/v1/compat/responses',
      { model: 'agent/test', input: 'Hello', tools: [RESP_TOOL] },
      undefined,
      { 'x-oaa-client-tools': 'reject' },
    );
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().error.code, 'client_tools_unsupported');

    // 严格接口：传 tools 仍然直接报错，不受模式影响。
    const strict = await s.request('POST', '/v1/chat/completions', { ...chat, tools: [TOOL] });
    assert.equal(strict.statusCode, 400);

    const before = s.store.allRuns().length;
    for (const model of ['agent/native']) {
      const bridged = await s.request(
        'POST',
        '/v1/compat/chat/completions',
        { ...chat, model, tools: [TOOL] },
        undefined,
        { 'x-oaa-client-tools': 'bridge' },
      );
      assert.equal(bridged.statusCode, 400, bridged.body);
      assert.equal(bridged.json().error.code, 'client_tools_bridge_unsupported');
    }
    assert.equal(s.store.allRuns().length, before, 'no run was created');

    const health = await s.app.inject({ method: 'GET', url: '/health' });
    assert.ok(health.json().features.includes('client-tools-policy-v1'));
    assert.ok(GATEWAY_FEATURES.includes('client-tools-policy-v1'));
    assert.equal(conversionProfile('kernel').client_tools, 'bridge');
    for (const engine of ['codex', 'claude', 'adapter/missing'])
      assert.equal(conversionProfile(engine).client_tools, 'managed', engine);
  } finally {
    await s.cleanup();
  }
});
