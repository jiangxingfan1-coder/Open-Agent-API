import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, providerSchema, type GatewayConfig } from '../src/config/config.js';
import { createGateway } from '../src/gateway/server.js';
import { connectModel, type GatewayControl } from '../src/client/connect-model.js';
import { formatModels, modelsReport } from '../src/client/models-cli.js';
import { AnthropicModel, GeminiModel, OpenAIModel } from '../src/providers/models.js';
import { Fault } from '../src/core/util.js';
import { agent } from './helpers.js';

// oaa connect <model preset> end to end against fake model services on 127.0.0.1 (port 0). No real
// model service is called and nothing outside the temporary directory is written.

type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
};
type Handler = (seen: Seen, res: ServerResponse) => void;

async function fakeService(t: TestContext, handler: Handler) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const entry = {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, seen };
}

const sseFrames = (res: ServerResponse, frames: unknown[], done = true) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.end(done ? 'data: [DONE]\n\n' : '');
};
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** OpenAI-compatible chat service. `strict` is a variant that only knows max_tokens and sends no stream usage. */
function openaiCompatible(strict = false): Handler {
  return (s, res) => {
    if (s.method === 'GET' && s.url === '/v1/models')
      return json(res, 200, { object: 'list', data: [{ id: 'fake-model' }] });
    if (s.method !== 'POST' || s.url !== '/v1/chat/completions')
      return json(res, 404, { error: { message: 'no such path' } });
    if (s.body.model !== 'fake-model')
      return json(res, 404, { error: { message: 'The model does not exist' } });
    if (strict && 'max_completion_tokens' in s.body)
      return json(res, 400, {
        error: { message: 'Unrecognized request argument supplied: max_completion_tokens' },
      });
    if (strict && 'stream_options' in s.body)
      return json(res, 400, { error: { message: 'stream_options is not supported' } });
    const frames: unknown[] = [
      { choices: [{ index: 0, delta: { content: 'O' } }] },
      { choices: [{ index: 0, delta: { content: 'K' }, finish_reason: 'stop' }] },
    ];
    if (!strict && s.body.stream_options)
      frames.push({
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    sseFrames(res, frames);
  };
}

/** A gateway in this process that "restarts" by reloading the configuration file. */
function inProcessGateway(t: TestContext) {
  let current: { close: () => Promise<void>; url: string; file: string } | undefined;
  const states: string[] = [];
  const start = async (file: string) => {
    const config = await loadConfig(file);
    const gateway = await createGateway(config, undefined, { configFile: file });
    const address = await gateway.listen();
    current = {
      close: () => gateway.app.close(),
      url: String(address).replace('localhost', '127.0.0.1'),
      file,
    };
  };
  t.after(async () => current?.close());
  const control: GatewayControl = {
    async ensure(file: string, _config: GatewayConfig, changed: boolean) {
      if (!current) {
        await start(file);
        states.push('started');
        return { url: current!.url, state: 'started' };
      }
      if (!changed) {
        states.push('reused');
        return { url: current.url, state: 'reused' };
      }
      await current.close();
      await start(file);
      states.push('restarted');
      return { url: current!.url, state: 'restarted' };
    },
  };
  return { control, states, url: () => current!.url };
}

async function dataDir(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-model-connect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const admin = path.join(dir, 'admin.token');
  await writeFile(admin, 'test-admin-token-not-a-provider-credential-0001\n', { mode: 0o600 });
  await writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      keys: [
        {
          name: 'owner',
          owner: 'owner',
          tokenFile: admin,
          scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
        },
      ],
      localWorker: { nodeId: 'local', dataDir: path.join(dir, 'worker') },
    }),
    { mode: 0o600 },
  );
  return dir;
}

const cli = path.resolve('dist/src/cli.js');

test('connect ollama: probe, provider, publish, key, curl; idempotent; --test goes through the gateway', async (t) => {
  const svc = await fakeService(t, openaiCompatible());
  const dir = await dataDir(t);
  const gw = inProcessGateway(t);
  const run = async (
    extra: Partial<Parameters<typeof connectModel>[0]> = {},
    locale: 'en' | 'zh' = 'en',
  ) => {
    const lines: string[] = [];
    await connectModel({
      preset: 'ollama',
      dir,
      cliPath: cli,
      prefix: 'oaa',
      baseUrl: `${svc.base}/v1`,
      locale,
      out: (l) => lines.push(l),
      gateway: gw.control,
      ...extra,
    });
    return lines.join('\n');
  };
  const first = await run();
  assert.match(first, /1\/5 Found Ollama at http:\/\/127\.0\.0\.1:\d+\/v1 \(1 model: fake-model\)/);
  assert.match(first, /2\/5 Wrote provider ollama to /);
  assert.match(first, /Key: none needed/);
  assert.match(first, /3\/5 Gateway started in the background/);
  assert.match(
    first,
    /4\/5 Published agent\/assistant \(ollama\/fake-model, version [a-f0-9]{12}\)/,
  );
  assert.match(first, /5\/5 Created a key for agent\/assistant only: .*assistant\.key/);
  assert.match(first, /model {4}: agent\/assistant/);
  assert.match(
    first,
    /curl http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions -H "Authorization: Bearer \$\(cat '.*assistant\.key'\)"/,
  );
  assert.match(first, /connect did not call the model\. Add --test/);
  assert.equal(
    svc.seen.filter((s) => s.method === 'POST').length,
    0,
    'connect never generates without --test',
  );
  const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')) as {
    localWorker: { providers: Record<string, Record<string, unknown>> };
  };
  assert.deepEqual(config.localWorker.providers.ollama, {
    kind: 'openai-chat',
    baseUrl: `${svc.base}/v1`,
    apiKeyEnv: '',
    noApiKey: true,
    maxTokensField: 'max_tokens',
    imageInput: 'inline',
    preset: 'ollama',
  });

  const second = await run({ test: true }, 'zh');
  assert.match(second, /2\/5 提供方 ollama 已在配置里，跳过/);
  assert.match(second, /3\/5 网关已在运行且已是最新配置/);
  assert.match(second, /5\/5 沿用密钥：.*assistant\.key/);
  assert.match(second, /测试调用成功（本地服务）：OK/);
  const generated = svc.seen.filter((s) => s.method === 'POST');
  assert.equal(generated.length, 1);
  assert.equal(
    generated[0]!.headers.authorization,
    undefined,
    'keyless provider sends no Authorization',
  );
  assert.equal(generated[0]!.body.max_tokens, 4096);
  assert.equal(gw.states.join(','), 'started,reused');

  // Same name, other settings: refused, file untouched.
  const before = await readFile(path.join(dir, 'config.json'), 'utf8');
  await assert.rejects(
    run({ baseUrl: `${svc.base}/other/v1`, model: 'fake-model' }),
    (e: unknown) => e instanceof Fault && e.code === 'provider_conflict',
  );
  assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), before);

  // oaa models: the gateway's view, with the agent that uses the provider.
  const report = await modelsReport(await loadConfig(path.join(dir, 'config.json')), {
    check: false,
  });
  assert.equal(
    report.gateway.view,
    'local',
    'port 0 in the file: the CLI cannot find the test gateway',
  );
  assert.equal(report.providers[0]!.name, 'ollama');
  assert.equal(report.providers[0]!.reachable, true, 'loopback endpoints are probed automatically');
  assert.deepEqual(report.providers[0]!.models, ['fake-model']);
  const text = formatModels(report, (_zh, en) => en).join('\n');
  assert.match(text, /ollama {2}openai-chat {2}http:\/\/127\.0\.0\.1/);
  assert.match(text, /key: no key needed/);

  // The console inventory lists the provider (no key material).
  const admin = (await readFile(path.join(dir, 'admin.token'), 'utf8')).trim();
  const local = (await (
    await fetch(`${gw.url()}/v1/local/backends`, { headers: { authorization: `Bearer ${admin}` } })
  ).json()) as { providers: { name: string; key_ready: boolean; local: boolean }[] };
  assert.deepEqual(
    local.providers.map((p) => [p.name, p.key_ready, p.local]),
    [['ollama', true, true]],
  );
});

test('connect with a key file: only the reference is stored, the gateway reads it per call', async (t) => {
  const svc = await fakeService(t, openaiCompatible(true));
  const dir = await dataDir(t);
  const gw = inProcessGateway(t);
  const keyFile = path.join(dir, 'deepseek.key');
  await writeFile(keyFile, 'sk-fake-file-key-0001\n', { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const lines: string[] = [];
  await connectModel({
    preset: 'siliconflow',
    dir,
    cliPath: cli,
    prefix: 'oaa',
    baseUrl: `${svc.base}/v1`,
    model: 'fake-model',
    keyFile,
    test: true,
    locale: 'en',
    out: (l) => lines.push(l),
    gateway: gw.control,
  });
  const out = lines.join('\n');
  assert.ok(!out.includes('sk-fake-file-key'), 'the key is never printed');
  assert.match(out, /Key: the gateway reads .*deepseek\.key on each call/);
  assert.match(out, /Test call succeeded \(local service\): OK/);
  const raw = await readFile(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!raw.includes('sk-fake-file-key'));
  assert.match(raw, /"apiKeyFile": ".*deepseek\.key"/);
  const post = svc.seen.find((s) => s.method === 'POST')!;
  assert.equal(post.headers.authorization, 'Bearer sk-fake-file-key-0001');
  assert.ok(
    !('stream_options' in post.body) && post.body.max_tokens === 4096,
    'the preset sends max_tokens and no stream_options',
  );
});

test('connect: clear errors for an unreachable local service, a missing model and bad key arguments', async (t) => {
  const dir = await dataDir(t);
  const closed = await fakeService(t, () => {});
  const svc = await fakeService(t, openaiCompatible());
  // A port that no longer answers: start a service, read its port, close it first.
  const gone = createServer();
  await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve));
  const { port } = gone.address() as { port: number };
  await new Promise<void>((resolve) => gone.close(() => resolve()));
  void closed;
  const base = {
    dir,
    cliPath: cli,
    prefix: 'oaa',
    locale: 'en' as const,
    out: () => {},
    gateway: inProcessGateway(t).control,
  };
  await assert.rejects(
    connectModel({ ...base, preset: 'lmstudio', baseUrl: `http://127.0.0.1:${port}/v1` }),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === 'provider_unreachable' &&
      /may not be running, or it uses another port/.test(JSON.stringify(e.text)) &&
      /没在运行/.test(e.message) &&
      /--base-url/.test(e.message),
  );
  await assert.rejects(
    connectModel({ ...base, preset: 'ollama', baseUrl: `${svc.base}/v1`, model: 'missing' }),
    (e: unknown) =>
      e instanceof Fault && e.code === 'arguments' && /Available: fake-model/.test(e.message),
  );
  await assert.rejects(
    connectModel({ ...base, preset: 'openai', keyEnv: 'sk-looks-like-a-key' }),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === 'arguments' &&
      /name of an environment variable/.test(JSON.stringify(e.text)),
  );
  await assert.rejects(
    connectModel({ ...base, preset: 'openai', keyEnv: 'A', keyFile: 'b' }),
    (e: unknown) => e instanceof Fault && e.code === 'arguments',
  );
  await assert.rejects(
    connectModel({ ...base, preset: 'openrouter', keyEnv: 'OPENROUTER_API_KEY' }),
    (e: unknown) => e instanceof Fault && e.code === 'arguments' && /--model/.test(e.message),
  );
  await assert.rejects(
    connectModel({ ...base, preset: 'openai-compatible' }),
    (e: unknown) => e instanceof Fault && /--base-url/.test(e.message),
  );
});

const call = (driver: { call: OpenAIModel['call'] }) =>
  driver.call(
    agent({ model: 'fake-model' }),
    [{ role: 'user', content: 'x' }],
    new AbortController().signal,
    () => {},
  );

test('run errors name the provider, the problem and the setting to change', async (t) => {
  const svc = await fakeService(t, openaiCompatible(true));
  const make = (extra: Record<string, unknown>) =>
    new OpenAIModel(
      providerSchema.parse({
        kind: 'openai-chat',
        baseUrl: `${svc.base}/v1`,
        apiKeyEnv: '',
        noApiKey: true,
        ...extra,
      }),
      undefined,
      'strictsvc',
    );
  await assert.rejects(
    call(make({})),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === 'upstream_incompatible' &&
      /strictsvc/.test(e.message) &&
      /"maxTokensField": "max_tokens"/.test(e.message) &&
      !/Unrecognized/.test(e.message),
  );
  await assert.rejects(
    call(make({ maxTokensField: 'max_tokens' })),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === 'upstream_incompatible' &&
      /"streamUsage": false/.test(e.message),
  );
  const ok = await call(make({ maxTokensField: 'max_tokens', streamUsage: false }));
  assert.equal(ok.text, 'OK');
  assert.equal(ok.usage, null, 'no stream usage from this variant');
  await assert.rejects(
    make({ maxTokensField: 'max_tokens', streamUsage: false }).call(
      agent({ model: 'nope' }),
      [{ role: 'user', content: 'x' }],
      new AbortController().signal,
      () => {},
    ),
    (e: unknown) =>
      e instanceof Fault && e.code === 'upstream_model_not_found' && /"nope"/.test(e.message),
  );
  assert.throws(
    () =>
      new OpenAIModel(
        providerSchema.parse({
          kind: 'openai-chat',
          baseUrl: `${svc.base}/v1`,
          apiKeyEnv: '',
          apiKeyFile: path.join(os.tmpdir(), 'oaa-no-such-key-file'),
        }),
        undefined,
        'filesvc',
      ),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === 'model_not_configured' &&
      /filesvc: the key file/.test(e.message),
  );
});

test('Anthropic and Gemini fakes: key file header, success, and a rejected key', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-fake-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'k');
  await writeFile(keyFile, 'fake-provider-key-0001\n', { mode: 0o600 });
  const anthropic = await fakeService(t, (s, res) => {
    if (s.headers['x-api-key'] !== 'fake-provider-key-0001')
      return json(res, 401, { error: { message: 'bad key' } });
    sseFrames(
      res,
      [
        { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ],
      false,
    );
  });
  const gemini = await fakeService(t, (s, res) => {
    if (s.headers['x-goog-api-key'] !== 'fake-provider-key-0001')
      return json(res, 403, { error: { message: 'bad key' } });
    assert.match(s.url, /^\/v1beta\/models\/fake-model:streamGenerateContent\?alt=sse$/);
    sseFrames(
      res,
      [
        {
          candidates: [
            { index: 0, content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' },
          ],
        },
      ],
      false,
    );
  });
  const cfg = (kind: string, baseUrl: string, extra: Record<string, unknown> = {}) =>
    providerSchema.parse({ kind, baseUrl, apiKeyEnv: '', apiKeyFile: keyFile, ...extra });
  assert.equal(
    (
      await call(
        new AnthropicModel(cfg('anthropic-messages', anthropic.base), undefined, 'claude-api'),
      )
    ).text,
    'OK',
  );
  assert.equal(
    (await call(new GeminiModel(cfg('gemini-generate', `${gemini.base}/v1beta`), undefined, 'gem')))
      .text,
    'OK',
  );
  await writeFile(keyFile, 'wrong-key\n');
  await assert.rejects(
    call(new AnthropicModel(cfg('anthropic-messages', anthropic.base), undefined, 'claude-api')),
    (e: unknown) =>
      e instanceof Fault && e.code === 'upstream_auth_failed' && /claude-api/.test(e.message),
  );
  await assert.rejects(
    call(new GeminiModel(cfg('gemini-generate', `${gemini.base}/v1beta`), undefined, 'gem')),
    (e: unknown) =>
      e instanceof Fault && e.code === 'upstream_auth_failed' && /HTTP 403/.test(e.message),
  );
});
