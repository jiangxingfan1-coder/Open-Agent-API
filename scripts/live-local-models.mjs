// Explicit live acceptance against already running local servers. No runtime is installed or started.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gatewaySchema } from '../dist/src/config/config.js';
import { createGateway } from '../dist/src/gateway/server.js';
import { writePrivate } from '../dist/src/core/util.js';

const dir = path.resolve(process.env.OAA_LOCAL_MODEL_DIR ?? 'output/local-models-20261117/gateway');
const targets = JSON.parse(process.env.OAA_LOCAL_MODEL_TARGETS ?? '[]');
const token = await readFile(path.join(dir, 'admin.token'), 'utf8').catch(() =>
  randomBytes(32).toString('hex'),
);
await writePrivate(dir, 'admin.token', token);
process.env.OAA_LOCAL_MODEL_TEST_TOKEN = token;
const config = gatewaySchema.parse({
  dataDir: dir,
  host: '127.0.0.1',
  port: Number(process.env.OAA_LOCAL_MODEL_PORT ?? '18817'),
  keys: [
    {
      name: 'local-runtime-acceptance',
      owner: 'owner',
      tokenEnv: 'OAA_LOCAL_MODEL_TEST_TOKEN',
      scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
    },
  ],
  localWorker: {
    nodeId: 'local-model-acceptance',
    dataDir: path.join(dir, 'worker'),
    providers: {},
  },
});
let gateway = await createGateway(config);
let base = await gateway.listen();
console.log(JSON.stringify({ base, token_file: path.join(dir, 'admin.token') }));
const call = async (url, body) => {
  const response = await fetch(`${base}${url}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
};
try {
  const results = [];
  for (const target of targets) {
    const probe = await call('/v1/local/model-runtimes/probe', target);
    assert.equal(probe.status, 'ready', JSON.stringify(probe));
    const model = probe.models[0];
    const connected = await call('/v1/local/model-runtimes/connect', { ...target, model });
    const chat = await call('/v1/chat/completions', {
      model: connected.agent,
      messages: [{ role: 'user', content: 'Once upon a time, there was a small red house.' }],
      max_tokens: 24,
    });
    assert.ok(chat.choices[0].message.content.length > 0);
    const response = await call('/v1/responses', {
      model: connected.agent,
      input: 'Tell a very short story about a red house.',
      max_output_tokens: 24,
    });
    assert.ok(['completed', 'incomplete'].includes(response.status));
    assert.ok(response.output.some((item) => item.content?.some((part) => part.text?.length)));
    if (response.status === 'incomplete')
      assert.equal(response.incomplete_details?.reason, 'max_output_tokens');
    results.push({
      runtime: target.runtime,
      endpoint: target.base_url,
      model,
      agent: connected.agent,
      chat: chat.choices[0].message.content,
      responses_status: response.status,
    });
  }
  if (targets.length) {
    await gateway.app.close();
    config.localWorker.providers = {};
    gateway = await createGateway(config);
    base = await gateway.listen();
    const restored = await call('/v1/local/backends');
    for (const result of results)
      assert.ok(restored.providers.some((provider) => provider.name === `local-${result.runtime}`));
    await writePrivate(
      dir,
      'acceptance.json',
      JSON.stringify({ results, restart: 'passed' }, null, 2),
    );
    console.log(JSON.stringify({ results, restart: 'passed', base }));
  }
  if (process.argv.includes('--serve')) {
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
  }
} finally {
  await gateway.app.close();
}
