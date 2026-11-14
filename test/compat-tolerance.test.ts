import assert from 'node:assert/strict';
import test from 'node:test';
import { agent, FixtureModel, setup, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { corsAllowHeaders } from '../src/gateway/compat-http.js';
import type { ModelMessage } from '../src/core/contracts.js';

// Parameter tolerance of the default (strict) OpenAI endpoints, found by the compatibility lab
// (integrations/compat): harmless sampling and vendor knobs are accepted and listed in
// X-OAA-Ignored-Params; fields that change what the gateway must do are refused with a clear
// error that names the way out. Fixed request samples, in-process, no listening socket.

async function gateway() {
  const seen: ModelMessage[][] = [];
  const s = await setup(
    new FixtureModel((_a, messages) => {
      seen.push(messages);
      return { text: 'ok' };
    }),
    { allowedOrigins: ['http://localhost:3000'] },
  );
  s.store.publish('owner', makeBundle(agent()));
  // An agent that runs its own tool loop: it cannot take caller tools over.
  s.store.publish('owner', makeBundle(agent({ id: 'agent/native', engine: 'codex' })));
  const chat = (extra: Record<string, unknown>, path = '/v1/chat/completions') =>
    s.request('POST', path, {
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    });
  const responses = (extra: Record<string, unknown>) =>
    s.request('POST', '/v1/responses', { model: 'agent/test', input: 'hi', ...extra });
  return { s, seen, chat, responses };
}

test('strict chat: sampling knobs and vendor parameters are accepted and reported as ignored', async () => {
  const { s, chat } = await gateway();
  try {
    const r = await chat({
      temperature: null,
      top_p: 0.9,
      stop: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
      logit_bias: { '50256': -100 },
      logprobs: false,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.1,
      repetition_penalty: 1.1,
      mirostat: 1,
      num_ctx: 4096,
      keep_alive: '5m',
      think: true,
      verbosity: 'low',
      prompt_cache_key: 'k',
      parallel_tool_calls: false,
      tool_choice: 'auto',
      n: null,
      max_tokens: null,
    });
    assert.equal(r.statusCode, 200, r.body);
    const ignored = String(r.headers['x-oaa-ignored-params']).split(', ');
    for (const name of [
      'top_p',
      'stop',
      'logit_bias',
      'top_k',
      'min_p',
      'repeat_penalty',
      'num_ctx',
      'think',
    ])
      assert.ok(ignored.includes(name), `${name} not reported in ${ignored.join(',')}`);
    // An unknown field is still refused: a typo must not be swallowed.
    const typo = await chat({ max_token: 5 });
    assert.equal(typo.statusCode, 400);
    assert.equal(typo.json().error.code, 'unsupported_parameter');
    assert.equal(typo.json().error.param, 'max_token');
  } finally {
    await s.cleanup();
  }
});

test('strict chat: message names, extra keys on content parts and extra stream_options keys are dropped', async () => {
  const { s, seen, chat } = await gateway();
  try {
    const r = await chat({
      messages: [
        { role: 'system', content: 'S', name: 'sys' },
        {
          role: 'user',
          name: 'alice',
          content: [
            { type: 'text', text: 'T1', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'T2' },
          ],
        },
      ],
      stream: true,
      stream_options: { include_usage: true, include_obfuscation: false },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.body, /"usage":\{/);
    const text = seen
      .at(-1)!
      .map((m) => m.content)
      .join('\n');
    assert.match(text, /T1\nT2/);
    // OpenAI itself refuses stream_options without stream: that stays an error.
    const bad = await chat({ stream_options: { include_usage: true } });
    assert.equal(bad.statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('strict chat: forced tool_choice, logprobs and non-text output are refused with the way out; tools are bridged or refused by agent', async () => {
  const { s, chat } = await gateway();
  try {
    const tool = { type: 'function', function: { name: 'f', parameters: { type: 'object' } } };
    const cases: [Record<string, unknown>, string][] = [
      [{ functions: [{ name: 'f' }] }, 'functions'],
      [{ tool_choice: 'required' }, 'tool_choice'],
      [{ tool_choice: { type: 'function', function: { name: 'f' } } }, 'tool_choice'],
      [{ logprobs: true }, 'logprobs'],
      [{ modalities: ['text', 'audio'] }, 'modalities'],
      [{ n: 2 }, 'n'],
    ];
    for (const [extra, param] of cases) {
      const r = await chat(extra);
      assert.equal(r.statusCode, 400, JSON.stringify(extra));
      assert.equal(r.json().error.code, 'unsupported_parameter');
      assert.equal(r.json().error.param, param);
    }
    // Caller tools: a kernel agent takes them over; an agent that cannot gets the refusal that names the way out.
    const bridged = await chat({ tools: [tool] });
    assert.equal(bridged.statusCode, 200, bridged.body);
    assert.equal(bridged.headers['x-oaa-client-tools'], 'bridge');
    const native = await chat({ model: 'agent/native', tools: [tool] });
    assert.equal(native.statusCode, 400);
    assert.equal(native.json().error.code, 'unsupported_parameter');
    assert.equal(native.json().error.param, 'tools');
    assert.match(native.json().error.message, /\/v1\/compat/);
    assert.match(native.json().error.message, /X-OAA-Client-Tools: managed/);
    // Harmless values are accepted: no tools, text format, logprobs off.
    for (const extra of [
      { tools: [] },
      { response_format: { type: 'text' } },
      { logprobs: false },
      { tool_choice: 'none' },
      { modalities: ['text'] },
    ]) {
      const r = await chat(extra);
      assert.equal(r.statusCode, 200, `${JSON.stringify(extra)} ${r.body}`);
    }
    const history = await chat({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c', content: 'x' },
      ],
    });
    assert.equal(history.statusCode, 200, history.body);
    // The compatibility endpoint takes all of them.
    const compat = await chat(
      { tools: [tool], tool_choice: 'required' },
      '/v1/compat/chat/completions',
    );
    assert.equal(compat.statusCode, 200, compat.body);
  } finally {
    await s.cleanup();
  }
});

test('strict chat: reasoning_effort is a routing hint, not an error', async () => {
  const { s, chat } = await gateway();
  try {
    const r = await chat({ reasoning_effort: 'high' });
    assert.equal(r.statusCode, 200, r.body);
    const run = await s.request('GET', `/v1/runs/${String(r.headers['x-run-id'])}`);
    assert.equal(run.json().response.metadata['oaa.reasoning_effort'], 'high');
    assert.equal(run.json().response.metadata['oaa.routing_strategy'], 'quality');
  } finally {
    await s.cleanup();
  }
});

test('strict responses: instructions, reasoning, typed message items and output_text history reach the agent', async () => {
  const { s, seen, responses } = await gateway();
  try {
    const r = await responses({
      instructions: 'INSTRUCTION_MARK',
      reasoning: { effort: 'low', summary: 'auto' },
      text: { format: { type: 'text' } },
      parallel_tool_calls: true,
      tool_choice: 'auto',
      include: [],
      prompt_cache_key: 'k',
      tools: [],
      input: [
        { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
        {
          type: 'message',
          id: 'm2',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'a1', annotations: [] }],
        },
        { role: 'user', content: 'q2' },
      ],
    });
    assert.equal(r.statusCode, 200, r.body);
    const text = seen
      .at(-1)!
      .map((m) => m.content)
      .join('\n');
    for (const mark of ['INSTRUCTION_MARK', 'q1', 'a1', 'q2']) assert.match(text, new RegExp(mark));
    const run = await s.request('GET', `/v1/runs/${String(r.headers['x-run-id'])}`);
    assert.equal(run.json().response.metadata['oaa.routing_strategy'], 'speed');
  } finally {
    await s.cleanup();
  }
});

test('strict responses: a forced tool_choice is refused with the way out; tools are bridged or refused by agent', async () => {
  const { s, responses } = await gateway();
  try {
    const item = await responses({
      input: [
        { role: 'user', content: 'hi' },
        { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
      ],
    });
    assert.equal(item.statusCode, 200, item.body);
    const tools = [{ type: 'function', name: 'f', parameters: { type: 'object' } }];
    const bridged = await responses({ tools });
    assert.equal(bridged.statusCode, 200, bridged.body);
    assert.equal(bridged.headers['x-oaa-client-tools'], 'bridge');
    const native = await responses({ model: 'agent/native', tools });
    assert.equal(native.statusCode, 400);
    assert.equal(native.json().error.param, 'tools');
    assert.match(native.json().error.message, /\/v1\/compat/);
    const refused: [Record<string, unknown>, string][] = [
      [{ tool_choice: 'required' }, 'tool_choice'],
    ];
    for (const [extra, param] of refused) {
      const r = await responses(extra);
      assert.equal(r.statusCode, 400, JSON.stringify(extra));
      assert.equal(r.json().error.code, 'unsupported_parameter');
      assert.equal(r.json().error.param, param);
    }
    const typo = await responses({ max_token: 1 });
    assert.equal(typo.json().error.param, 'max_token');
  } finally {
    await s.cleanup();
  }
});

test('GET /v1/models/{id} answers every SDK in its own shape, with the slash percent-encoded or not', async () => {
  const { s } = await gateway();
  try {
    for (const url of ['/v1/models/agent%2Ftest', '/v1/models/agent/test']) {
      const openai = await s.request('GET', url);
      assert.equal(openai.statusCode, 200, url);
      assert.deepEqual(openai.json(), {
        id: 'agent/test',
        object: 'model',
        created: 0,
        owned_by: 'open-agent-api',
      });
    }
    const claude = await s.request('GET', '/v1/models/agent%2Ftest', undefined, token, {
      'anthropic-version': '2023-06-01',
    });
    assert.equal(claude.json().type, 'model');
    assert.equal(claude.json().id, 'agent/test');
    const missing = await s.request('GET', '/v1/models/agent%2Fnone');
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'agent_not_found');
  } finally {
    await s.cleanup();
  }
});

test('body-less POST with a JSON content type (responses.cancel in the official SDKs) is not an invalid_json error', async () => {
  const { s, responses } = await gateway();
  try {
    const made = await responses({});
    const id = made.json().id as string;
    const cancel = await s.app.inject({
      method: 'POST',
      url: `/v1/responses/${id}/cancel`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': '0',
      },
    });
    assert.notEqual(cancel.json().error?.code, 'invalid_json', cancel.body);
    // A real malformed body is still an error.
    const bad = await s.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{nope',
    });
    assert.equal(bad.json().error.code, 'invalid_json');
  } finally {
    await s.cleanup();
  }
});

test('CORS preflight answers exactly the headers a browser asks for, for an allowed origin only', async () => {
  const { s } = await gateway();
  try {
    const asked = 'authorization,content-type,user-agent,x-stainless-arch,x-stainless-retry-count';
    const ok = await s.app.inject({
      method: 'OPTIONS',
      url: '/v1/chat/completions',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': asked,
      },
    });
    assert.equal(ok.statusCode, 204);
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:3000');
    const allowed = String(ok.headers['access-control-allow-headers']).toLowerCase().split(', ');
    for (const h of asked.split(',')) assert.ok(allowed.includes(h), h);
    assert.ok(allowed.includes('x-oaa-client-tools'));
    const denied = await s.app.inject({
      method: 'OPTIONS',
      url: '/v1/chat/completions',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': asked,
      },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    // Malformed names are not echoed back.
    assert.doesNotMatch(corsAllowHeaders('x-ok, bad name, evil\r\nx: y'), /bad name|evil/);
    assert.match(corsAllowHeaders('x-ok'), /x-ok/);
  } finally {
    await s.cleanup();
  }
});

test('Gemini bodies written in snake_case (REST reference style, google-genai 3.3 tool schemas) are understood', async () => {
  const seen: ModelMessage[][] = [];
  const schemas: unknown[] = [];
  const s = await setup(
    new FixtureModel((a, messages) => {
      seen.push(messages);
      schemas.push(a.tools.map((t) => t.capability.inputSchema));
      return { text: 'ok' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const r = await s.request(
      'POST',
      '/v1beta/models/agent/test:generateContent',
      {
        system_instruction: { parts: [{ text: 'SNAKE_SYSTEM' }] },
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generation_config: { max_output_tokens: 3, temperature: 0.1 },
        tools: [
          {
            function_declarations: [
              {
                name: 'get_weather',
                parameters_json_schema: {
                  type: 'object',
                  properties: { user_id: { type: 'string' } },
                  required: ['user_id'],
                },
              },
            ],
          },
        ],
      },
      token,
      { 'X-OAA-Client-Tools': 'bridge' },
    );
    assert.equal(r.statusCode, 200, r.body);
    assert.match(
      seen
        .at(-1)!
        .map((m) => m.content)
        .join('\n'),
      /SNAKE_SYSTEM/,
    );
    assert.deepEqual(schemas.at(-1), [
      { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] },
    ]);
    // Inline data under its snake_case name is understood as an image; the fixture agent has no
    // image-capable route, so it is refused clearly and nothing reaches the agent.
    const image = await s.request('POST', '/v1beta/models/agent/test:generateContent', {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inline_data: {
                mime_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              },
            },
          ],
        },
      ],
    });
    assert.equal(image.statusCode, 400);
    assert.equal(image.json().error.details[0].reason, 'unsupported_content');
  } finally {
    await s.cleanup();
  }
});

test('Gemini generateContent also answers /v1beta/{agent}:generateContent (AI SDK Google provider, ids with a slash)', async () => {
  const { s } = await gateway();
  try {
    for (const method of ['generateContent', 'streamGenerateContent?alt=sse']) {
      const r = await s.request('POST', `/v1beta/agent/test:${method}`, {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      assert.equal(r.statusCode, 200, `${method}: ${r.body}`);
      assert.match(r.body, /"text":\s*"ok"/);
    }
    // Anything else under /v1beta that is not a generate method stays a Gemini-shaped 404.
    const other = await s.request('POST', '/v1beta/agent/test:countTokens', { contents: [] });
    assert.equal(other.statusCode, 404);
    assert.equal(other.json().error.status, 'NOT_FOUND');
  } finally {
    await s.cleanup();
  }
});

test('sloppy Base URLs: trailing and doubled slashes work, a missing or doubled /v1 gets a 404 that says so', async () => {
  const { s, chat } = await gateway();
  try {
    for (const path of [
      '/v1/chat/completions/',
      '/v1//chat/completions',
      '//v1/chat/completions',
    ]) {
      const r = await chat({}, path);
      assert.equal(r.statusCode, 200, `${path}: ${r.body}`);
      assert.equal(r.json().object, 'chat.completion');
    }
    for (const path of ['/v1/models/', '//v1/models']) {
      const r = await s.request('GET', path);
      assert.equal(r.statusCode, 200, path);
      assert.equal(r.json().object, 'list', path);
    }
    // OpenAI-shaped errors stay OpenAI-shaped on the sloppy forms too.
    const missing = await s.request('POST', '/v1/chat/completions/', {
      model: 'agent/none',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'agent_not_found');
    const noVersion = await chat({}, '/chat/completions');
    assert.equal(noVersion.statusCode, 404);
    assert.equal(noVersion.json().error.code, 'route_not_found');
    assert.match(noVersion.json().error.message, /must end with \/v1/);
    const twice = await chat({}, '/v1/v1/chat/completions');
    assert.match(twice.json().error.message, /\/v1 twice/);
    const unknown = await s.request('GET', '/v1/unknown');
    assert.doesNotMatch(unknown.json().error.message, /Base URL/);
    // Authentication is not relaxed by the tolerant router: the raw path is what is checked.
    const anonymous = await s.app.inject({ method: 'GET', url: '//v1/models' });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await s.cleanup();
  }
});
