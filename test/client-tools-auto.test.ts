import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from '../src/core/contracts.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { agent, FixtureModel, setup, token } from './helpers.js';

// Caller tools without a chosen mode ("auto", docs/harness.md): a request that declares tools is bridged
// when the agent can take them over, and gets the entry's older behaviour when it cannot. Offline,
// deterministic model stand-in, in-process (no listening socket).

const results = (messages: ModelMessage[]) => messages.filter((m) => m.role === 'tool');
const editModel = () =>
  new FixtureModel((a, messages) => {
    const done = results(messages);
    // Only an agent that was handed the caller's tool calls it; otherwise it just answers.
    if (!a.tools.some((t) => t.name === 'edit_file')) return { text: 'plain answer' };
    if (!done.length)
      return { text: '', calls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'a.ts' } }] };
    return { text: `Done: ${done.map((m) => m.content).join(',')}` };
  });

async function lab(extra: Record<string, unknown> = {}) {
  const s = await setup(editModel(), extra);
  s.store.publish(
    'owner',
    makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
  );
  // A native engine that is not installed: it runs its own tool loop and cannot bridge (never started).
  s.store.publish('owner', makeBundle(agent({ id: 'agent/native', engine: 'codex' })));
  return s;
}
type Lab = Awaited<ReturnType<typeof lab>>;

const CHAT_TOOL = {
  type: 'function',
  function: {
    name: 'edit_file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
};
const RESP_TOOL = { type: 'function', name: 'edit_file', parameters: { type: 'object' } };
const CLAUDE_TOOL = { name: 'edit_file', input_schema: { type: 'object' } };
const GEMINI_TOOLS = [
  { functionDeclarations: [{ name: 'edit_file', parameters: { type: 'OBJECT' } }] },
];
const post = (s: Lab, url: string, body: unknown, headers: Record<string, string> = {}) =>
  s.request('POST', url, body, token, headers);

test('auto: a bridgeable agent takes the caller tools over on all four entries, without any header', async () => {
  const s = await lab();
  try {
    const chat = await post(s, '/v1/chat/completions', {
      model: 'agent/bridge',
      messages: [{ role: 'user', content: 'fix' }],
      tools: [CHAT_TOOL],
      tool_choice: 'auto',
    });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.equal(chat.headers['x-oaa-client-tools'], 'bridge');
    const call = chat.json().choices[0].message.tool_calls[0] as {
      id: string;
      function: { name: string };
    };
    assert.equal(chat.json().choices[0].finish_reason, 'tool_calls');
    assert.equal(call.function.name, 'edit_file');
    const done = await post(s, '/v1/chat/completions', {
      model: 'agent/bridge',
      tools: [CHAT_TOOL],
      messages: [
        { role: 'user', content: 'fix' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'ok' },
      ],
    });
    assert.equal(done.json().choices[0].message.content, 'Done: ok');

    const resp = await post(s, '/v1/responses', {
      model: 'agent/bridge',
      input: 'fix',
      tools: [RESP_TOOL],
    });
    assert.equal(resp.statusCode, 200, resp.body);
    assert.equal(resp.headers['x-oaa-client-tools'], 'bridge');
    assert.equal(
      resp.json().output.find((o: { type: string }) => o.type === 'function_call').name,
      'edit_file',
    );

    const claude = await post(s, '/v1/messages', {
      model: 'agent/bridge',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'fix' }],
      tools: [CLAUDE_TOOL],
    });
    assert.equal(claude.headers['x-oaa-client-tools'], 'bridge');
    assert.equal(claude.json().stop_reason, 'tool_use');

    const gemini = await post(s, '/v1beta/models/agent%2Fbridge:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'fix' }] }],
      tools: GEMINI_TOOLS,
    });
    assert.equal(gemini.headers['x-oaa-client-tools'], 'bridge');
    assert.equal(gemini.json().candidates[0].content.parts[0].functionCall.name, 'edit_file');

    // The compat entries bridge as well (they used to treat the tools as managed).
    const compat = await post(s, '/v1/compat/chat/completions', {
      model: 'agent/bridge',
      messages: [{ role: 'user', content: 'fix' }],
      tools: [CHAT_TOOL],
    });
    assert.equal(compat.headers['x-oaa-client-tools'], 'bridge');
    assert.equal(compat.json().choices[0].finish_reason, 'tool_calls');
  } finally {
    await s.cleanup();
  }
});

test('auto: an agent that cannot bridge behaves as it did before on every entry', async () => {
  const s = await lab();
  try {
    const runs = s.store.allRuns().length;
    for (const [url, body] of [
      [
        '/v1/chat/completions',
        { model: 'agent/native', messages: [{ role: 'user', content: 'x' }], tools: [CHAT_TOOL] },
      ],
      ['/v1/responses', { model: 'agent/native', input: 'x', tools: [RESP_TOOL] }],
    ] as const) {
      const r = await post(s, url, body);
      assert.equal(r.statusCode, 400, url);
      assert.equal(r.json().error.code, 'unsupported_parameter');
      assert.equal(r.json().error.param, 'tools');
      assert.match(r.json().error.message, /cannot be handed to this agent/);
      for (const exit of ['/v1/compat', 'X-OAA-Compat: true', 'X-OAA-Client-Tools: managed'])
        assert.ok(r.json().error.message.includes(exit), `${url} names ${exit}`);
    }
    assert.equal(s.store.allRuns().length, runs, 'a refused request creates no run');
    // The other entries go on as managed: the agent is started (here it is not installed: 503), not refused.
    for (const [url, body, headers] of [
      [
        '/v1/compat/chat/completions',
        { model: 'agent/native', messages: [{ role: 'user', content: 'x' }], tools: [CHAT_TOOL] },
        {},
      ],
      [
        '/v1/chat/completions',
        { model: 'agent/native', messages: [{ role: 'user', content: 'x' }], tools: [CHAT_TOOL] },
        { 'x-oaa-compat': 'true' },
      ],
      [
        '/v1/messages',
        {
          model: 'agent/native',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'x' }],
          tools: [CLAUDE_TOOL],
        },
        {},
      ],
      [
        '/v1beta/models/agent%2Fnative:generateContent',
        { contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: GEMINI_TOOLS },
        {},
      ],
    ] as const) {
      const r = await post(s, url, body, headers);
      assert.equal(r.statusCode, 503, `${url}: ${r.body}`);
    }
  } finally {
    await s.cleanup();
  }
});

test('auto: a tool that collides with one of the agent, built-in tools or a forced tool choice fall back instead of failing', async () => {
  const s = await lab();
  try {
    const clash = {
      type: 'function',
      function: { name: 'list_files', parameters: { type: 'object' } },
    };
    const compat = await post(s, '/v1/compat/chat/completions', {
      model: 'agent/bridge',
      messages: [{ role: 'user', content: 'x' }],
      tools: [clash],
    });
    assert.equal(compat.statusCode, 200, compat.body);
    assert.equal(compat.headers['x-oaa-client-tools'], 'ignored');
    const strict = await post(s, '/v1/chat/completions', {
      model: 'agent/bridge',
      messages: [{ role: 'user', content: 'x' }],
      tools: [clash],
    });
    assert.equal(strict.statusCode, 400);
    assert.match(strict.json().error.message, /conflicts with a published tool/);
    // An explicit bridge keeps failing loudly.
    const explicit = await post(
      s,
      '/v1/compat/chat/completions',
      { model: 'agent/bridge', messages: [{ role: 'user', content: 'x' }], tools: [clash] },
      { 'x-oaa-client-tools': 'bridge' },
    );
    assert.equal(explicit.statusCode, 400);
    assert.equal(explicit.json().error.code, 'client_tool_conflict');
    const builtinTool = await post(s, '/v1beta/models/agent%2Fbridge:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      tools: [{ googleSearch: {} }],
    });
    assert.equal(builtinTool.statusCode, 200, builtinTool.body);
    assert.equal(builtinTool.headers['x-oaa-client-tools'], 'ignored');
    const forced = await post(s, '/v1/messages', {
      model: 'agent/bridge',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'x' }],
      tools: [CLAUDE_TOOL],
      tool_choice: { type: 'any' },
    });
    assert.equal(forced.headers['x-oaa-client-tools'], 'ignored');
    const forcedStrict = await post(s, '/v1/chat/completions', {
      model: 'agent/bridge',
      messages: [{ role: 'user', content: 'x' }],
      tools: [CHAT_TOOL],
      tool_choice: 'required',
    });
    assert.equal(forcedStrict.statusCode, 400);
    assert.equal(forcedStrict.json().error.param, 'tool_choice');
  } finally {
    await s.cleanup();
  }
});

test('auto: explicit modes are never overridden, and clientTools.default changes what an unspecified request gets', async () => {
  const s = await lab();
  try {
    const body = {
      model: 'agent/bridge',
      messages: [{ role: 'user', content: 'x' }],
      tools: [CHAT_TOOL],
    };
    const managed = await post(s, '/v1/compat/chat/completions', body, {
      'x-oaa-client-tools': 'managed',
    });
    assert.equal(managed.headers['x-oaa-client-tools'], 'ignored');
    const reject = await post(s, '/v1/compat/chat/completions', body, {
      'x-oaa-client-tools': 'reject',
    });
    assert.equal(reject.json().error.code, 'client_tools_unsupported');
    const bridge = await post(s, '/v1/compat/chat/completions', body, {
      'x-oaa-client-tools': 'bridge',
    });
    assert.equal(bridge.headers['x-oaa-client-tools'], 'bridge');
    const viaMetadata = await post(s, '/v1/compat/chat/completions', {
      ...body,
      metadata: { 'oaa.client_tools': 'managed' },
    });
    assert.equal(viaMetadata.headers['x-oaa-client-tools'], 'ignored');
  } finally {
    await s.cleanup();
  }
  for (const [configured, expected] of [
    ['managed', 'ignored'],
    ['bridge', 'bridge'],
  ] as const) {
    const c = await lab({ clientTools: { default: configured } });
    try {
      const body = {
        model: 'agent/bridge',
        messages: [{ role: 'user', content: 'x' }],
        tools: [CHAT_TOOL],
      };
      const r = await post(c, '/v1/compat/chat/completions', body);
      assert.equal(r.headers['x-oaa-client-tools'], expected, configured);
      // An explicit auto beats the configured default.
      const auto = await post(c, '/v1/compat/chat/completions', body, {
        'x-oaa-client-tools': 'auto',
      });
      assert.equal(
        auto.headers['x-oaa-client-tools'],
        'bridge',
        `explicit auto under ${configured}`,
      );
    } finally {
      await c.cleanup();
    }
  }
  const strict = await lab({ clientTools: { default: 'reject' } });
  try {
    const r = await post(strict, '/v1/compat/chat/completions', {
      model: 'agent/bridge',
      messages: [{ role: 'user', content: 'x' }],
      tools: [CHAT_TOOL],
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'client_tools_unsupported');
  } finally {
    await strict.cleanup();
  }
});
