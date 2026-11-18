import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { providerSchema } from '../src/config/config.js';
import type { OutputContract } from '../src/core/contracts.js';
import { TOOL_CHOICE_REPAIR_MARKER } from '../src/core/tool-choice.js';
import type { AcpTimings } from '../src/engines/acp.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { AnthropicModel, GeminiModel, OpenAIModel } from '../src/providers/models.js';
import { agent, FixtureModel, setup, token } from './helpers.js';

const STRICT_PERSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
  required: ['name', 'age'],
  additionalProperties: false,
};
const FREE_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { meta: { type: 'object', additionalProperties: true } },
  required: ['meta'],
  additionalProperties: false,
};
const STRICT_CONTRACT: OutputContract = {
  kind: 'json_schema',
  name: 'person_record',
  strict: true,
  schema: STRICT_PERSON_SCHEMA,
};
const FREE_CONTRACT: OutputContract = {
  kind: 'json_schema',
  name: 'free_record',
  strict: true,
  schema: FREE_OBJECT_SCHEMA,
};

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(encoder.encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}
const sseData = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const chatSse = (chunks: string[]) => [
  ...chunks.map((c) => sseData({ choices: [{ index: 0, delta: { content: c } }] })),
  sseData({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  }),
  'data: [DONE]\n\n',
];
const responsesSse = (text: string) => [
  sseData({ type: 'response.output_text.delta', delta: text }),
  sseData({
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    },
  }),
];
const anthropicSse = (text: string) => [
  sseData({ type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 0 } } }),
  sseData({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  sseData({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  sseData({ type: 'content_block_stop', index: 0 }),
  sseData({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 4 },
  }),
  sseData({ type: 'message_stop' }),
];
const geminiSse = (text: string) => [
  sseData({
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
  }),
];

test('wire pushdown across all 4 model drivers: structured output, schema degradation, tool_choice and phase coordination', async () => {
  const originalFetch = globalThis.fetch;
  process.env.OAA_WIRE_TEST_KEY = 'sk-wire-test-000000000000000000000000';
  const captured: Record<string, unknown>[] = [];
  let responder: () => Response = () => sseResponse(chatSse(['{"name":"Ada","age":36}']));
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    );
    return responder();
  }) as typeof fetch;

  try {
    const toolAgent = agent({
      model: 'gpt-4.1',
      tools: [builtin('list_files')],
      allowGraph: false,
    });
    const plainAgent = agent({ model: 'gpt-4.1', tools: [] });
    const sig = new AbortController().signal;
    const msgs = [{ role: 'user' as const, content: 'Return JSON.' }];
    const noop = () => {};

    const chatDriver = new OpenAIModel(
      providerSchema.parse({
        kind: 'openai-chat',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'OAA_WIRE_TEST_KEY',
      }),
    );
    await chatDriver.call(toolAgent, msgs, sig, noop);
    assert.equal(captured.at(-1)!.response_format, undefined);
    assert.equal(captured.at(-1)!.tool_choice, undefined);

    await chatDriver.call(plainAgent, msgs, sig, noop, { outputContract: { kind: 'json_object' } });
    assert.deepEqual(captured.at(-1)!.response_format, { type: 'json_object' });

    await chatDriver.call(plainAgent, msgs, sig, noop, { outputContract: STRICT_CONTRACT });
    assert.deepEqual(captured.at(-1)!.response_format, {
      type: 'json_schema',
      json_schema: { name: 'person_record', schema: STRICT_PERSON_SCHEMA, strict: true },
    });

    await chatDriver.call(plainAgent, msgs, sig, noop, { outputContract: FREE_CONTRACT });
    assert.equal(captured.at(-1)!.response_format, undefined);

    await chatDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'tool', name: 'list_files' },
      outputContract: STRICT_CONTRACT,
    });
    assert.deepEqual(captured.at(-1)!.tool_choice, {
      type: 'function',
      function: { name: 'list_files' },
    });
    assert.equal(captured.at(-1)!.response_format, undefined);

    await chatDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'none' },
      outputContract: STRICT_CONTRACT,
    });
    assert.equal(captured.at(-1)!.tool_choice, 'none');
    assert.ok(captured.at(-1)!.response_format);

    responder = () => sseResponse(responsesSse('{"name":"Ada","age":36}'));
    const respDriver = new OpenAIModel(
      providerSchema.parse({
        kind: 'openai-responses',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'OAA_WIRE_TEST_KEY',
      }),
    );
    await respDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'tool', name: 'list_files' },
      outputContract: STRICT_CONTRACT,
    });
    assert.deepEqual(captured.at(-1)!.tool_choice, { type: 'function', name: 'list_files' });
    assert.equal(captured.at(-1)!.text, undefined);

    await respDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'auto' },
      outputContract: STRICT_CONTRACT,
    });
    assert.equal(captured.at(-1)!.tool_choice, 'auto');
    assert.deepEqual(captured.at(-1)!.text, {
      format: {
        type: 'json_schema',
        name: 'person_record',
        schema: STRICT_PERSON_SCHEMA,
        strict: true,
      },
    });

    await respDriver.call(plainAgent, msgs, sig, noop, { outputContract: FREE_CONTRACT });
    assert.equal(captured.at(-1)!.text, undefined);

    responder = () => sseResponse(anthropicSse('{"name":"Ada","age":36}'));
    const claudeDriver = new AnthropicModel(
      providerSchema.parse({
        kind: 'anthropic-messages',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'OAA_WIRE_TEST_KEY',
      }),
    );
    await claudeDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'required' },
      outputContract: STRICT_CONTRACT,
    });
    assert.deepEqual(captured.at(-1)!.tool_choice, { type: 'any' });
    assert.equal(captured.at(-1)!.output_config, undefined);

    await claudeDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'tool', name: 'list_files' },
    });
    assert.deepEqual(captured.at(-1)!.tool_choice, { type: 'tool', name: 'list_files' });

    await claudeDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'none' },
      outputContract: STRICT_CONTRACT,
    });
    assert.equal(captured.at(-1)!.tools, undefined);
    assert.equal(captured.at(-1)!.tool_choice, undefined);
    assert.deepEqual(captured.at(-1)!.output_config, {
      format: { type: 'json_schema', schema: STRICT_PERSON_SCHEMA },
    });

    responder = () => sseResponse(geminiSse('{"name":"Ada","age":36}'));
    const geminiDriver = new GeminiModel(
      providerSchema.parse({
        kind: 'gemini-generate',
        baseUrl: 'https://api.example.com/v1beta',
        apiKeyEnv: 'OAA_WIRE_TEST_KEY',
      }),
    );
    await geminiDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'tool', name: 'list_files' },
      outputContract: STRICT_CONTRACT,
    });
    assert.deepEqual(captured.at(-1)!.toolConfig, {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['list_files'] },
    });
    assert.equal(
      (captured.at(-1)!.generationConfig as Record<string, unknown>).responseMimeType,
      undefined,
    );

    await geminiDriver.call(toolAgent, msgs, sig, noop, {
      toolChoice: { mode: 'none' },
      outputContract: STRICT_CONTRACT,
    });
    assert.deepEqual(captured.at(-1)!.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
    assert.deepEqual(captured.at(-1)!.generationConfig, {
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, age: { type: 'INTEGER', minimum: 0 } },
        required: ['name', 'age'],
      },
    });

    await geminiDriver.call(plainAgent, msgs, sig, noop, { outputContract: FREE_CONTRACT });
    assert.deepEqual(captured.at(-1)!.generationConfig, {
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OAA_WIRE_TEST_KEY;
  }
});

test('kernel native pushdown with maxRepairs=0 streams token deltas directly and still asserts Ajv at completion', async () => {
  const originalFetch = globalThis.fetch;
  process.env.OAA_STREAM_DIRECT_KEY = 'sk-stream-direct-0000000000000000000';
  let chunksToSend = ['{"name":', '"Ada",', '"age":36}'];
  globalThis.fetch = (async () => sseResponse(chatSse(chunksToSend))) as typeof fetch;

  const s = await setup(undefined, { structuredOutput: { maxRepairs: 0 } });
  try {
    const openAiCfg = providerSchema.parse({
      kind: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'OAA_STREAM_DIRECT_KEY',
    });
    s.config.localWorker!.providers.openai = openAiCfg;
    s.runtime.config.providers.openai = openAiCfg;
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/direct', provider: 'openai', model: 'gpt-4.1' })),
    );

    const format = {
      type: 'json_schema',
      json_schema: { name: 'person', schema: STRICT_PERSON_SCHEMA, strict: true },
    };
    const okRes = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/direct',
      stream: true,
      messages: [{ role: 'user', content: 'Give Ada.' }],
      response_format: format,
    });
    assert.equal(okRes.statusCode, 200, okRes.body);
    const deltas = okRes.body
      .split('\n\n')
      .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
      .map(
        (f) =>
          (JSON.parse(f.slice(6)) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]
            ?.delta?.content ?? '',
      )
      .filter((piece) => piece.length > 0);
    assert.ok(deltas.length >= 2, `expected multi-chunk streaming, got ${JSON.stringify(deltas)}`);
    assert.equal(deltas.join(''), '{"name":"Ada","age":36}');

    chunksToSend = ['{"name":"Ada",', '"age":-5}'];
    const badRes = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/direct',
      messages: [{ role: 'user', content: 'Give invalid Ada.' }],
      response_format: format,
    });
    assert.equal(badRes.statusCode, 422);
    assert.equal(badRes.json().error.code, 'structured_output_invalid');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OAA_STREAM_DIRECT_KEY;
    await s.cleanup();
  }
});

test('kernel tool_choice: single-turn trigger, automatic continuation convergence to auto, tool_choice=none, and validation', async () => {
  const model = new FixtureModel((a, messages, _signal, controls) => {
    if (controls?.toolChoice?.mode === 'none' || a.tools.length === 0) {
      return { text: '{"name":"NoTool","age":20}' };
    }
    if (!messages.some((m) => m.role === 'tool')) {
      const target =
        controls?.toolChoice?.mode === 'tool' ? controls.toolChoice.name : a.tools[0]!.name;
      return { calls: [{ id: 'tc_1', name: target, arguments: { userId: 'u1' } }] };
    }
    return { text: '{"name":"Ada","age":36}' };
  });

  const s = await setup(model);
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/kbridge', tools: [builtin('list_files')] })),
    );
    const tool = {
      type: 'function',
      function: {
        name: 'fetch-profile',
        parameters: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
    };
    const format = {
      type: 'json_schema',
      json_schema: { name: 'person', schema: STRICT_PERSON_SCHEMA, strict: true },
    };

    const first = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/kbridge',
      messages: [{ role: 'user', content: 'Fetch u1' }],
      tools: [tool],
      tool_choice: { type: 'function', function: { name: 'fetch-profile' } },
      response_format: format,
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers['x-oaa-ignored-params'], undefined);
    const call = first.json().choices[0].message.tool_calls[0] as {
      id: string;
      function: { name: string };
    };
    assert.equal(call.function.name, 'fetch-profile');
    assert.deepEqual(model.seenControls[0]?.toolChoice, { mode: 'tool', name: 'fetch_profile' });
    assert.equal(model.seenWire[0]?.response_format, undefined);

    const second = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/kbridge',
      tools: [tool],
      tool_choice: { type: 'function', function: { name: 'fetch-profile' } },
      response_format: format,
      messages: [
        { role: 'user', content: 'Fetch u1' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: '{"found":"Ada"}' },
      ],
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().choices[0].message.content, '{"name":"Ada","age":36}');
    assert.deepEqual(model.seenControls[1]?.toolChoice, { mode: 'auto' });
    assert.ok(model.seenWire[1]?.response_format);

    const seenToolsOnNone: string[][] = [];
    s.runtime['drivers'].set(
      'fixture',
      new FixtureModel((a) => {
        seenToolsOnNone.push(a.tools.map((t) => t.name));
        return { text: 'Direct text' };
      }),
    );
    const noneRes = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/kbridge',
      messages: [{ role: 'user', content: 'Just answer' }],
      tools: [tool],
      tool_choice: 'none',
    });
    assert.equal(noneRes.statusCode, 200, noneRes.body);
    assert.equal(noneRes.headers['x-oaa-ignored-params'], undefined);
    assert.deepEqual(seenToolsOnNone[0], ['list_files']);

    for (const [url, body, isGemini] of [
      [
        '/v1/chat/completions',
        {
          model: 'agent/kbridge',
          messages: [{ role: 'user', content: 'x' }],
          tools: [tool],
          tool_choice: { type: 'function', function: { name: 'missing' } },
        },
        false,
      ],
      [
        '/v1/messages',
        {
          model: 'agent/kbridge',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'x' }],
          tools: [{ name: 'fetch-profile', input_schema: { type: 'object' } }],
          tool_choice: { type: 'tool', name: 'missing' },
        },
        false,
      ],
      [
        '/v1beta/models/agent%2Fkbridge:generateContent',
        {
          contents: [{ role: 'user', parts: [{ text: 'x' }] }],
          tools: [
            { functionDeclarations: [{ name: 'fetch-profile', parameters: { type: 'OBJECT' } }] },
          ],
          toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['missing'] } },
        },
        true,
      ],
    ] as const) {
      const bad = await s.request('POST', url, body);
      assert.equal(bad.statusCode, 400);
      assert.equal(
        isGemini ? bad.json().error.details[0].reason : bad.json().error.code,
        'invalid_request',
      );
    }

    const managedForced = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      {
        model: 'agent/kbridge',
        messages: [{ role: 'user', content: 'x' }],
        tools: [tool],
        tool_choice: 'required',
      },
      token,
      { 'x-oaa-client-tools': 'managed' },
    );
    assert.equal(managedForced.statusCode, 400);
    assert.equal(managedForced.json().error.code, 'client_tools_unsupported');

    const managedAuto = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      {
        model: 'agent/kbridge',
        messages: [{ role: 'user', content: 'x' }],
        tools: [tool],
        tool_choice: 'auto',
      },
      token,
      { 'x-oaa-client-tools': 'managed' },
    );
    assert.equal(managedAuto.statusCode, 200);
    assert.match(String(managedAuto.headers['x-oaa-ignored-params']), /tool_choice/);
  } finally {
    await s.cleanup();
  }
});

const MCP_CLIENT_URL = import.meta.resolve('@modelcontextprotocol/sdk/client/index.js');
const MCP_STDIO_URL = import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js');
const STANDIN_ACP_SCRIPT = `
import { Client } from ${JSON.stringify(MCP_CLIENT_URL)};
import { StdioClientTransport } from ${JSON.stringify(MCP_STDIO_URL)};
const behavior = process.argv[2];
const sessions = new Map();
const loadedSessions = new Set();
let buf = '';
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
const say = (sessionId, text) =>
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) void onMessage(JSON.parse(line));
  }
});
async function onMessage({ id, method, params = {} }) {
  if (method === 'initialize')
    return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false } }, agentInfo: { name: 'tc-standin', version: '1.0.0' } } });
  if (method === 'session/new' || method === 'session/load') {
    const sessionId = params.sessionId ?? 'tc-session-1';
    if (method === 'session/load') loadedSessions.add(sessionId);
    sessions.set(sessionId, params.mcpServers ?? []);
    return send({ id, result: method === 'session/new' ? { sessionId } : {} });
  }
  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    const text = params.prompt.map((b) => b.text ?? '').join('');
    const hadRepair = text.includes(${JSON.stringify(TOOL_CHOICE_REPAIR_MARKER)});
    const resumed = loadedSessions.has(sessionId);
    if (!(behavior === 'obey-first' || (behavior === 'obey-on-repair' && hadRepair && resumed))) {
      say(sessionId, 'Skipped tool call');
      return send({ id, result: { stopReason: 'end_turn' } });
    }
    const srv = (sessions.get(sessionId) ?? [])[0];
    const transport = new StdioClientTransport({
      command: srv.command,
      args: srv.args,
      env: Object.fromEntries(srv.env.map((e) => [e.name, e.value])),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'tc-standin', version: '1.0.0' });
    await client.connect(transport);
    const res = await client.callTool({ name: 'run_check', arguments: { target: 'src' } });
    await client.close();
    const out = res.content.map((c) => c.text).join('');
    const hasConstraint = text.includes('[Caller Tool Requirement:');
    say(sessionId, 'Done:' + out + ':constraint=' + hasConstraint + ':repair=' + hadRepair + ':resumed=' + resumed);
    return send({ id, result: { stopReason: 'end_turn' } });
  }
}
`;

test('external bridged agent forced tool_choice: prompt constraint, 1-round correction re-entry, and 422 tool_choice_unmet', async () => {
  const fast: AcpTimings = { handshakeTimeoutMs: 5_000, cancelGraceMs: 1_000, exitGraceMs: 1_000 };
  const s = await setup(undefined, { approvalTimeoutMs: 15_000 });
  try {
    const scriptPath = path.join(s.dir, 'tc-acp-standin.mjs');
    await writeFile(scriptPath, STANDIN_ACP_SCRIPT, 'utf8');
    for (const mode of ['obey-first', 'obey-on-repair', 'never-call'] as const) {
      const key = `tc_${mode.replace(/-/g, '_')}`;
      const entry = {
        transport: 'acp' as const,
        command: process.execPath,
        args: [scriptPath, mode],
        enabled: true,
      };
      s.config.localWorker!.adapters[key] = entry;
      s.runtime.config.adapters[key] = entry;
      s.runtime.acpTimings = fast;
      const pub = await s.request('POST', '/v1/agents/publish-native', {
        id: `agent/${key}`,
        engine: `adapter/${key}`,
        models: ['default'],
      });
      assert.equal(pub.statusCode, 200, pub.body);
    }
    const tools = [
      {
        type: 'function',
        function: {
          name: 'run_check',
          parameters: {
            type: 'object',
            properties: { target: { type: 'string' } },
            required: ['target'],
          },
        },
      },
    ];

    const r1 = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/tc_obey_first',
      messages: [{ role: 'user', content: 'Check src' }],
      tools,
      tool_choice: { type: 'function', function: { name: 'run_check' } },
    });
    assert.equal(r1.statusCode, 200, r1.body);
    const call1 = r1.json().choices[0].message.tool_calls[0];
    const done1 = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/tc_obey_first',
      tools,
      messages: [
        { role: 'user', content: 'Check src' },
        { role: 'assistant', content: null, tool_calls: [call1] },
        { role: 'tool', tool_call_id: call1.id, content: 'clean' },
      ],
    });
    assert.equal(
      done1.json().choices[0].message.content,
      'Done:clean:constraint=true:repair=false:resumed=false',
    );

    const r2 = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/tc_obey_on_repair',
      messages: [{ role: 'user', content: 'Check src' }],
      tools,
      tool_choice: 'required',
    });
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(r2.json().choices[0].message.content, null);
    const call2 = r2.json().choices[0].message.tool_calls[0];
    const done2 = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/tc_obey_on_repair',
      tools,
      messages: [
        { role: 'user', content: 'Check src' },
        { role: 'assistant', content: null, tool_calls: [call2] },
        { role: 'tool', tool_call_id: call2.id, content: 'repaired-ok' },
      ],
    });
    assert.equal(
      done2.json().choices[0].message.content,
      'Done:repaired-ok:constraint=false:repair=true:resumed=true',
    );
    const repairedRun = s.store.run(String(done2.headers['x-run-id']));
    assert.equal(repairedRun.metadata['oaa.tool_choice_retries'], '1');
    assert.deepEqual(
      repairedRun.output.map((m) => m.text),
      ['Done:repaired-ok:constraint=false:repair=true:resumed=true'],
    );

    const r3 = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/tc_never_call',
      messages: [{ role: 'user', content: 'Ignore tools' }],
      tools,
      tool_choice: { type: 'function', function: { name: 'run_check' } },
    });
    assert.equal(r3.statusCode, 422, r3.body);
    assert.equal(r3.json().error.code, 'tool_choice_unmet');
    const failedRun = s.store.run(r3.json().error.run_id);
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.metadata['oaa.tool_choice_retries'], '1');
    assert.deepEqual(failedRun.output, []);
  } finally {
    await s.cleanup();
  }
});
