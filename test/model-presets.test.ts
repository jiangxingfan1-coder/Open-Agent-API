import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerSchema } from '../src/config/config.js';
import { acpPresets, nativeEngines } from '../src/config/agent-presets.js';
import {
  PROVIDER_PRESETS,
  findPreset,
  presetProviderEntry,
} from '../src/providers/provider-presets.js';
import { providerApiKey, providerKeyReady } from '../src/providers/provider-key.js';
import { isLoopbackUrl, providerStatuses } from '../src/providers/provider-status.js';
import {
  assistantSource,
  checkBaseUrl,
  checkKeyFile,
  isModelPreset,
} from '../src/client/connect-model.js';
import { connectTargets } from '../src/client/models-cli.js';
import { Fault } from '../src/core/util.js';
import type { ModelDriver } from '../src/providers/models.js';
import { setup, token, type FixtureModel } from './helpers.js';

const posixOnly =
  process.platform === 'win32' ? 'POSIX permission bits do not apply on Windows' : false;
const isFault = (code: string) => (e: unknown) => e instanceof Fault && e.code === code;

test('presets: ids are unique, well formed and never collide with external agent names', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const taken = new Set<string>([
    ...nativeEngines,
    'agy',
    'claude-code',
    ...acpPresets.map((p) => p.id),
  ]);
  for (const p of PROVIDER_PRESETS) {
    assert.match(p.id, /^[a-z0-9][a-z0-9-]{0,63}$/, p.id);
    assert.ok(!taken.has(p.id), `${p.id} collides with an external agent name`);
    assert.ok(
      ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate'].includes(p.kind),
    );
    assert.match(p.docs, /^https:\/\//, p.id);
    if (p.local) {
      assert.match(p.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/, p.id);
      assert.equal(p.keyEnv, undefined, p.id);
    } else if (p.baseUrl) {
      assert.match(p.baseUrl, /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9/._-]*)?$/, p.id);
      assert.ok(!p.baseUrl.endsWith('/'), p.id);
      assert.match(p.keyEnv ?? '', /^[A-Z][A-Z0-9_]+$/, p.id);
    }
    const entry = presetProviderEntry(p, { baseUrl: p.baseUrl || 'https://example.com/v1' });
    const parsed = providerSchema.parse(entry);
    assert.equal(parsed.kind, p.kind);
    assert.equal(parsed.preset, p.id);
    if (p.local) assert.equal(parsed.noApiKey, true);
  }
  assert.ok(isModelPreset('ollama') && isModelPreset('DeepSeek') && !isModelPreset('codex'));
  assert.ok(!isModelPreset('gemini'), 'gemini stays the Gemini CLI ACP preset');
  assert.equal(findPreset('nope'), undefined);
});

test('presets: the entry stores a key reference only', () => {
  const ds = findPreset('deepseek')!;
  assert.deepEqual(
    { ...presetProviderEntry(ds, {}) },
    {
      kind: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      maxTokensField: 'max_tokens',
      imageInput: 'url',
      preset: 'deepseek',
    },
  );
  const viaFile = presetProviderEntry(ds, { keyFile: '/keys/ds.key' });
  assert.equal(viaFile.apiKeyFile, '/keys/ds.key');
  assert.equal(viaFile.apiKeyEnv, '');
  assert.equal(presetProviderEntry(ds, { keyEnv: 'MY_DS' }).apiKeyEnv, 'MY_DS');
});

test('base URL check: http/https only, no credentials, https off the loopback interface', () => {
  assert.equal(checkBaseUrl('http://127.0.0.1:9999/v1/'), 'http://127.0.0.1:9999/v1');
  assert.equal(checkBaseUrl('https://llm.example.com/v1'), 'https://llm.example.com/v1');
  for (const bad of [
    'ftp://x.example/v1',
    'https://u:p@x.example/v1',
    'http://192.168.1.2:8000/v1',
    'https://x.example/v1?k=1',
  ])
    assert.throws(() => checkBaseUrl(bad), isFault('insecure_endpoint'), bad);
  assert.throws(() => checkBaseUrl('not a url'), isFault('arguments'));
  assert.ok(isLoopbackUrl('http://localhost:1/v1') && !isLoopbackUrl('https://127.example.com'));
});

test('key file check: private regular single-line file; content never echoed', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-keyfile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'good.key');
  await writeFile(good, 'sk-test-not-real-0001\n', { mode: 0o600 });
  await chmod(good, 0o600);
  assert.equal(await checkKeyFile(good), good);
  const two = path.join(dir, 'two.key');
  await writeFile(two, 'line-one\nline-two\n', { mode: 0o600 });
  await assert.rejects(
    checkKeyFile(two),
    (e: unknown) =>
      isFault('key_file_insecure')(e) && !String((e as Error).message).includes('line-one'),
  );
  await assert.rejects(checkKeyFile(dir), isFault('key_file_insecure'));
  await assert.rejects(checkKeyFile(path.join(dir, 'missing')), isFault('key_file_insecure'));
});

test('key file check: refuses a file other users can read', { skip: posixOnly }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-keyfile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const open = path.join(dir, 'open.key');
  await writeFile(open, 'sk-test-not-real-0002\n');
  await chmod(open, 0o644);
  await assert.rejects(
    checkKeyFile(open),
    (e: unknown) => isFault('key_file_insecure')(e) && /chmod 600/.test((e as Error).message),
  );
});

test('provider keys resolve from none, a file or the environment', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-keyref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'k');
  await writeFile(file, '  sk-file-not-real  \n');
  assert.equal(providerApiKey({ apiKeyEnv: 'X', noApiKey: true }), '');
  assert.equal(providerApiKey({ apiKeyEnv: 'X', apiKeyFile: file }), 'sk-file-not-real');
  assert.equal(
    providerApiKey({ apiKeyEnv: 'OAA_KEYREF_TEST' }, { OAA_KEYREF_TEST: 'sk-env' }),
    'sk-env',
  );
  assert.equal(providerApiKey({ apiKeyEnv: 'OAA_KEYREF_TEST' }, {}), undefined);
  assert.equal(providerKeyReady({ apiKeyEnv: '', apiKeyFile: path.join(dir, 'missing') }), false);
  const statuses = providerStatuses({
    providers: {
      a: providerSchema.parse({
        kind: 'openai-chat',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKeyEnv: '',
        apiKeyFile: file,
      }),
    },
  });
  assert.deepEqual(statuses[0]!.key, { kind: 'file', ref: file });
  assert.equal(statuses[0]!.key_ready, true);
  assert.ok(!JSON.stringify(statuses).includes('sk-file-not-real'));
});

test('connect with no target lists external agents and every model preset', async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'oaa-path-'));
  try {
    const lines = (await connectTargets('oaa', (_zh, en) => en, empty, false)).join('\n');
    assert.match(lines, /no codex, claude, agy or dsh found/);
    for (const p of PROVIDER_PRESETS) assert.match(lines, new RegExp(`oaa connect ${p.id}\\b`));
    assert.match(lines, /connect deepseek --key-env DEEPSEEK_API_KEY$/m);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

/** The compatibility lab's fixture model, as the provider behind the assistant template. */
async function labModel(): Promise<ModelDriver> {
  const { FixtureModel } = (await import(
    pathToFileURL(path.resolve('integrations/compat/lib/fixture-model.mjs')).href
  )) as {
    FixtureModel: new (answerFor: (prompt: string) => string | undefined) => ModelDriver;
  };
  const { answerForRequirement } = (await import(
    pathToFileURL(path.resolve('dist/test/compat-replay.js')).href
  )) as {
    answerForRequirement: (prompt: string) => string | undefined;
  };
  return new FixtureModel(answerForRequirement);
}

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('agent/assistant template: tools, structured output and images on the lab fixture model', async () => {
  const s = await setup((await labModel()) as unknown as FixtureModel);
  try {
    const cli = path.resolve('dist/src/cli.js');
    const source = await assistantSource(cli, {
      agent: 'agent/assistant',
      provider: 'fixture',
      model: 'fixture',
    });
    const published = await s.request('POST', '/v1/agents/publish-oaa', { source });
    assert.equal(published.statusCode, 200, published.body);
    const definition = published.json() as { id: string };
    assert.equal(definition.id, 'agent/assistant');
    const chat = (body: Record<string, unknown>) =>
      s.request('POST', '/v1/chat/completions', { model: 'agent/assistant', ...body }, token);

    const tools = await chat({
      messages: [{ role: 'user', content: 'CALLTOOL weather' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    });
    assert.equal(tools.statusCode, 200, tools.body);
    const call = tools.json().choices[0];
    assert.equal(call.finish_reason, 'tool_calls');
    assert.equal(call.message.tool_calls[0].function.name, 'get_weather');

    const structured = await chat({
      messages: [{ role: 'user', content: 'Who?' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'person',
          strict: true,
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
    });
    assert.equal(structured.statusCode, 200, structured.body);
    assert.equal(typeof JSON.parse(structured.json().choices[0].message.content).name, 'string');

    const image = await chat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'SHOW_IMAGES' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
          ],
        },
      ],
    });
    assert.equal(image.statusCode, 200, image.body);
    assert.match(image.json().choices[0].message.content, /^Images: 1 \[image\/png:\d+\]/);
  } finally {
    await s.cleanup();
  }
});

test('the bundled template compiles with a placeholder route that connect rewrites', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-def-'));
  try {
    await mkdir(dir, { recursive: true });
    const custom = path.join(dir, 'mine.oaa');
    await writeFile(
      custom,
      'agent "agent/mine" {\n  description = "x"\n  route "p" -> default/"configure-your-model"\n  instructions = "Be brief."\n}\n',
    );
    const source = await assistantSource('', {
      definition: custom,
      agent: 'agent/ignored',
      provider: 'ds',
      model: 'm-1',
    });
    assert.match(source, /route "p" -> ds\/"m-1"/);
    assert.match(source, /agent "agent\/mine"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
