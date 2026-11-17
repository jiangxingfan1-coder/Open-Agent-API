import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, agent, FixtureModel, waitFor } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { artifactMedia, mediaPolicy } from '../src/core/media.js';

test('media contracts reject misleading extensions and unrecognized kind/format requests before model calls', async () => {
  assert.equal(artifactMedia('fake.mp4', Buffer.from('not a video')), undefined);
  assert.equal(artifactMedia('fake.wav', Buffer.from('not audio')), undefined);
  assert.equal(artifactMedia('report.md', Buffer.from('# Actual text'))?.kind, 'document');
  assert.throws(() => mediaPolicy({ 'oaa.output_kind': 'audio', 'oaa.output_format': 'exe' }), {
    code: 'invalid_request',
  });
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const invalid = await s.request('POST', '/v1/media/jobs', {
      agent: 'agent/test',
      input: 'Work',
      kind: 'audio',
      format: 'exe',
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});
test('media jobs use ordinary task permissions and only complete after creating a matching new artifact', async () => {
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'Artifact created.' }
        : {
            calls: [
              {
                id: 'file',
                name: 'write_file',
                arguments: { path: 'result.md', content: '# Actual report' },
              },
            ],
          },
    ),
  );
  try {
    s.store.publish('owner', makeBundle(agent({ tools: [builtin('write_file')] })));
    const started = await s.request('POST', '/v1/media/jobs', {
      agent: 'agent/test',
      input: 'Generate a report',
      kind: 'document',
      format: 'md',
    });
    assert.equal(started.statusCode, 202, started.body);
    const done = await s.kernel.wait(started.json().id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    const result = await s.request('GET', `/v1/media/jobs/${done.id}`);
    assert.equal(result.json().validation, 'signature_only');
    assert.equal(result.json().artifacts[0].mime, 'text/markdown');
    const fake = await s.request('POST', '/v1/media/jobs', {
      agent: 'agent/test',
      input: 'Not audio',
      kind: 'audio',
      format: 'wav',
    });
    const failed = await s.kernel.wait(fake.json().id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'output_contract');
    const other = (
      await s.request('POST', '/v1/keys', {
        name: 'other',
        agents: ['agent/test'],
        scopes: ['read', 'invoke'],
      })
    ).json();
    assert.notEqual(
      (await s.request('GET', `/v1/media/jobs/${done.id}`, undefined, other.token)).statusCode,
      200,
    );
    await waitFor(() => s.kernel.stats().active === 0);
  } finally {
    await s.cleanup();
  }
});
