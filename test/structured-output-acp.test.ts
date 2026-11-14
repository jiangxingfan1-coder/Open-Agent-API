import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sha } from '../src/core/util.js';
import type { AcpTimings } from '../src/engines/acp.js';
import { setup } from './helpers.js';

// Structured output with an external agent (docs/structured-output.md): an ACP agent that can resume its
// session gets a correction prompt on that session; one that cannot is not asked again (it would redo the
// work). Stand-in fixture, no model, no network; child processes only (no listening socket).

const fixture = path.resolve('test/fixtures/acp-json-agent.mjs');
const fast: AcpTimings = { handshakeTimeoutMs: 5_000, cancelGraceMs: 1_000, exitGraceMs: 1_000 };
const FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ok',
    schema: {
      type: 'object',
      properties: { ok: { const: true } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
};

async function acpLab(mode: string) {
  const s = await setup(undefined, { approvalTimeoutMs: 15_000 });
  const entry = () => ({
    transport: 'acp' as const,
    command: process.execPath,
    args: [fixture, mode],
    enabled: true,
  });
  s.config.localWorker!.adapters.json = entry();
  s.runtime.config.adapters.json = entry();
  s.runtime.acpTimings = fast;
  const published = await s.request('POST', '/v1/agents/publish-native', {
    id: 'agent/json',
    engine: 'adapter/json',
    models: ['default'],
  });
  assert.equal(published.statusCode, 200, published.body);
  const ask = () =>
    s.request('POST', '/v1/chat/completions', {
      model: 'agent/json',
      messages: [{ role: 'user', content: 'do the task' }],
      response_format: FORMAT,
    });
  const log = async (runId: string) => {
    const file = path.join(
      s.runtime.config.dataDir,
      'sessions',
      sha('owner').slice(0, 16),
      s.store.run(runId).sessionId,
      '.acp-json.log',
    );
    return existsSync(file) ? (await readFile(file, 'utf8')).trim().split('\n') : [];
  };
  return { s, ask, log };
}

test('acp: an answer in a fence with prose around it is unwrapped without any correction round', async () => {
  const { s, ask, log } = await acpLab('good');
  try {
    const r = await ask();
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().choices[0].message.content, '{"ok":true}');
    assert.deepEqual(
      (await log(String(r.headers['x-run-id']))).map((l) => l.split(':')[0]),
      ['prompt'],
    );
  } finally {
    await s.cleanup();
  }
});

test('acp: an agent that can resume its session gets the correction prompt on that session', async () => {
  const { s, ask, log } = await acpLab('bad-then-good');
  try {
    const r = await ask();
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().choices[0].message.content, '{"ok":true}');
    const run = s.store.run(String(r.headers['x-run-id']));
    assert.equal(run.metadata['oaa.output_repairs'], '1');
    assert.deepEqual(
      run.output.map((m) => m.text),
      ['{"ok":true}'],
    );
    const lines = await log(run.id);
    assert.deepEqual(
      lines.map((l) => l.split(':')[0]),
      ['prompt', 'repair'],
    );
    assert.match(lines[1]!, /\[Structured output repair\]/);
    // The correction round has its own step; both rounds are in the run's steps.
    assert.equal(s.store.steps(run.id).filter((st) => st.name === 'adapter/json').length, 2);
  } finally {
    await s.cleanup();
  }
});

test('acp: wrong again after the correction fails the run; an agent that cannot resume is not asked twice', async () => {
  const bad = await acpLab('always-bad');
  try {
    const r = await bad.ask();
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, 'structured_output_invalid');
    assert.match(r.json().error.message, /sent back for correction 1 time/);
    assert.equal((await bad.log(r.json().error.run_id)).length, 2);
  } finally {
    await bad.s.cleanup();
  }
  const noload = await acpLab('noload');
  try {
    const r = await noload.ask();
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, 'structured_output_invalid');
    assert.match(r.json().error.message, /cannot continue its session/);
    assert.equal((await noload.log(r.json().error.run_id)).length, 1, 'the agent was asked once');
  } finally {
    await noload.s.cleanup();
  }
});
