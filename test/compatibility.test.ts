import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import OpenAI from 'openai';
import { createMcpBridge } from '../src/client/mcp.js';
import { GatewayClient } from '../src/client/client.js';
import { OpenAIModel } from '../src/providers/models.js';
import { providerSchema } from '../src/config/config.js';
import { setup, agent, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import path from 'node:path';

test('owner-installed adapters export additional agents through the same oaa/1 protocol', async () => {
  const s = await setup();
  try {
    s.runtime.config.adapters.custom = {
      transport: 'stdio',
      command: process.execPath,
      args: [path.resolve('test/fixtures/custom-adapter.mjs')],
      enabled: true,
    };
    s.store.publish(
      'owner',
      makeBundle(agent({ engine: 'adapter/custom', model: 'custom-model' })),
    );
    const r = await s.request('POST', '/v1/invoke', {
      protocol: 'oaa/1',
      agent: 'agent/test',
      model: 'custom-model',
      input: 'custom task',
    });
    assert.equal(r.json().status, 'completed');
    assert.match(r.json().output[0].content[0].text, /Custom adapter received custom-model/);
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});

test('official OpenAI SDK parses ordinary Responses, streaming Responses, and Chat Completions', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const url = await s.listen();
    const client = new OpenAI({ apiKey: token, baseURL: url + '/v1', maxRetries: 0 });
    const result = await client.responses.create({ model: 'agent/test', input: 'hello' });
    assert.equal(result.status, 'completed');
    assert.equal(result.output_text, 'Fixture response.');
    const stream = await client.responses.create({
      model: 'agent/test',
      input: 'stream',
      stream: true,
    });
    let text = '';
    let completed = false;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') text += event.delta;
      if (event.type === 'response.completed') completed = true;
    }
    assert.equal(text, 'Fixture response.');
    assert.equal(completed, true);
    const chat = await client.chat.completions.create({
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(chat.choices[0]?.message.content, 'Fixture response.');
  } finally {
    await s.cleanup();
  }
});
test('MCP discovery and invocation use the same API authorization and run records', async () => {
  const s = await setup();
  const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
  let bridge: ReturnType<typeof createMcpBridge> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const url = await s.listen();
    bridge = createMcpBridge(new GatewayClient(url, token));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await bridge.connect(a);
    await client.connect(b);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'oaa_invoke'));
    const list = await client.callTool({ name: 'oaa_list_agents', arguments: {} });
    assert.equal(list.isError, undefined);
    const preview = await client.callTool({
      name: 'oaa_preview_route',
      arguments: { agent: 'agent/test' },
    });
    const plan = JSON.parse((preview.content as { text: string }[])[0]!.text);
    assert.ok(plan.selected);
    assert.equal(s.driver.calls, 0);
    assert.equal(s.store.allRuns().length, 0);
    s.store.publish('owner', makeBundle(agent({ instructions: 'A newer version after preview.' })));
    const invoked = await client.callTool({
      name: 'oaa_invoke',
      arguments: { agent: 'agent/test', input: 'MCP invocation', agent_version: plan.version },
    });
    const content = invoked.content as { text: string }[];
    const id = JSON.parse(content[0]!.text).id;
    assert.equal((await s.kernel.wait(id)).status, 'completed');
    assert.equal(s.store.run(id).digest, plan.version);
    const fetched = await client.callTool({ name: 'oaa_get_run', arguments: { response_id: id } });
    assert.match(JSON.stringify(fetched), /Fixture response/);
  } finally {
    await client.close();
    await bridge?.close();
    await s.cleanup();
  }
});
test('official OpenAI file upload reaches the same authenticated file store', async () => {
  const s = await setup();
  try {
    const url = await s.listen();
    const client = new OpenAI({ apiKey: token, baseURL: url + '/v1', maxRetries: 0 });
    const uploaded = await client.files.create({
      file: new File(['source text'], 'source.txt'),
      purpose: 'user_data',
    });
    assert.equal(uploaded.filename, 'source.txt');
    assert.equal(s.store.file(uploaded.id, 'owner').bytes, 11);
  } finally {
    await s.cleanup();
  }
});
test('OpenAI-compatible upstream adapter decodes fragmented tool arguments with no live provider', async () => {
  let observed: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    observed = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"path":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"source.txt"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ])
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', ...chunk })}\n\n`,
      );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    process.env.OAA_MODEL_FIXTURE = 'fixture-no-real-credential';
    const address = server.address() as { port: number };
    const driver = new OpenAIModel(
      providerSchema.parse({
        kind: 'openai-chat',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'OAA_MODEL_FIXTURE',
      }),
    );
    const result = await driver.call(
      agent(),
      [{ role: 'user', content: 'test' }],
      new AbortController().signal,
      () => {},
    );
    assert.equal(result.calls[0]?.arguments.path, 'source.txt');
    assert.equal(result.usage?.total_tokens, 10);
    assert.equal(observed?.model, 'fixture');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.OAA_MODEL_FIXTURE;
  }
});

test('OpenAI-compatible upstream adapter gracefully handles empty arguments for parameterless tools', async () => {
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl_fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_empty',
                  type: 'function',
                  function: { name: 'list_files', arguments: '' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    process.env.OAA_MODEL_FIXTURE = 'fixture-key';
    const address = server.address() as { port: number };
    const driver = new OpenAIModel(
      providerSchema.parse({
        kind: 'openai-chat',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'OAA_MODEL_FIXTURE',
      }),
    );
    const result = await driver.call(
      agent(),
      [{ role: 'user', content: 'test' }],
      new AbortController().signal,
      () => {},
    );
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0]?.name, 'list_files');
    assert.deepEqual(result.calls[0]?.arguments, {});
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.OAA_MODEL_FIXTURE;
  }
});

test('OpenAI-compatible upstream adapter rejects corrupted tool JSON with invalid_model_result fault', async () => {
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl_fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'broken_tool', arguments: '{"bad_json":' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    process.env.OAA_MODEL_FIXTURE = 'fixture-key';
    const address = server.address() as { port: number };
    const driver = new OpenAIModel(
      providerSchema.parse({
        kind: 'openai-chat',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'OAA_MODEL_FIXTURE',
      }),
    );
    await assert.rejects(
      () =>
        driver.call(
          agent(),
          [{ role: 'user', content: 'test' }],
          new AbortController().signal,
          () => {},
        ),
      (err: any) => err.code === 'invalid_model_result' && err.status === 502,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.OAA_MODEL_FIXTURE;
  }
});
