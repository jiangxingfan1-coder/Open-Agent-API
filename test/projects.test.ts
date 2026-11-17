import test from 'node:test';
import assert from 'node:assert/strict';
import { agent, FixtureModel, principal, setup } from './helpers.js';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { projects } from '../src/store/projects.js';
import { invocationSchema } from '../src/kernel/invocation.js';
import { runMemoryTool } from '../src/kernel/memory-tools.js';

test('shared projects require explicit grants, preserve private memories and reject stale writes', async () => {
  const s = await setup();
  try {
    const data = projects(s.store),
      admin = principal;
    data.create(admin, 'studio', 'Studio');
    const alice = { ...principal, scopes: ['read', 'invoke'], subject: 'alice' };
    const bob = { ...alice, subject: 'bob' };
    const stranger = { ...bob, owner: 'other' };
    assert.throws(() => data.entries(alice, 'studio'), { code: 'scope_denied' });
    data.grant(admin, 'studio', 'alice', 'write');
    data.grant(admin, 'studio', 'bob', 'read');
    const note = data.put(alice, 'studio', 'shared', 'vision', { text: 'Shared vision' }, 'new');
    assert.equal(data.entries(bob, 'studio')[0]?.revision, note.revision);
    assert.throws(() => data.put(bob, 'studio', 'shared', 'vision', 'overwrite'), {
      code: 'scope_denied',
    });
    assert.throws(() => data.entries(stranger, 'studio'), { code: 'scope_denied' });
    assert.throws(() => data.put(alice, 'studio', 'shared', 'vision', 'overwrite', 'old'), {
      code: 'version_conflict',
    });
    s.store.putMemory('owner', 'alice', 'shared', 'secret', 'private');
    assert.equal(
      data.entries(bob, 'studio').some((e) => e.key === 'secret'),
      false,
    );
    data.grant(admin, 'studio', 'bob', 'none');
    assert.throws(() => data.entries(bob, 'studio'), { code: 'scope_denied' });
  } finally {
    await s.cleanup();
  }
});

test('project context crosses agents only in the granted project and completed results become shared claims', async () => {
  let observed = '';
  const s = await setup(
    new FixtureModel((_a, messages) => {
      observed = messages.map((m) => m.content).join('\n');
      return { text: 'Completed shared work.' };
    }),
  );
  try {
    const data = projects(s.store);
    data.create(principal, 'studio', 'Studio');
    data.create(principal, 'separate', 'Separate');
    data.put(principal, 'studio', 'shared', 'vision', 'PROJECT_CONTEXT_MARKER');
    s.store.publish(
      'owner',
      makeBundle(agent({ tools: [builtin('memory_read'), builtin('memory_write')] })),
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({
        agent: 'agent/test',
        input: 'Work',
        metadata: { 'oaa.project': 'studio' },
      }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.match(observed, /PROJECT_CONTEXT_MARKER/);
    assert.equal(data.entries(principal, 'studio', 'runs').length, 1);
    assert.equal(data.entries(principal, 'separate').length, 0);
    runMemoryTool(s.store, done, 'memory_write', {
      scope: 'project',
      key: 'decision',
      value: 'DECISION',
    });
    assert.equal(
      (
        runMemoryTool(s.store, done, 'memory_read', { scope: 'project', key: 'decision' }) as {
          value: string;
        }
      ).value,
      'DECISION',
    );
    assert.throws(
      () =>
        s.kernel.submit(
          principal,
          invocationSchema.parse({
            agent: 'agent/test',
            input: 'Move',
            previous_response_id: done.id,
            metadata: { 'oaa.project': 'separate' },
          }),
        ),
      { code: 'invalid_continuation' },
    );
  } finally {
    await s.cleanup();
  }
});
