import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { ExecutionStep, Run, RunEvent, ToolBinding } from '../src/core/contracts.js';
import { capabilitySchema } from '../src/core/contracts.js';
import { Store } from '../src/store/store.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { Fault, sha } from '../src/core/util.js';
import { setup, agent, principal, FixtureModel } from './helpers.js';

function runFixture(id = 'resp_step'): Run {
  return {
    id,
    owner: 'owner',
    agentId: 'agent/test',
    digest: 'a'.repeat(64),
    sessionId: `session_${id}`,
    previousId: null,
    status: 'in_progress',
    createdAt: 1,
    updatedAt: 1,
    input: 'fixture',
    fileIds: [],
    output: [],
    usage: null,
    checkpoint: { messages: [], turn: 1, phase: 'tools', pending: [] },
    error: null,
    artifactIds: [],
    metadata: {},
    route: { id: 'default', provider: 'fixture', model: 'fixture', mode: 'auto' },
  };
}
const stepFixture = (run: Run, id = 'step_a'): ExecutionStep => ({
  id,
  runId: run.id,
  callId: id,
  name: 'emit_report',
  effect: 'write',
  status: 'running',
  arguments: {},
  nodeId: 'local',
});

test('step completion, artifact references, checkpoint and event commit or roll back together', async () => {
  const s = await setup();
  const reader = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'), { readOnly: true });
  try {
    const run = runFixture();
    s.store.createRun(run);
    const step = stepFixture(run);
    s.store.step(step);
    const file = await s.store.addFile(
      'owner',
      'report.txt',
      Buffer.from('report'),
      ['local'],
      run.id,
    );
    const observations: unknown[] = [];
    s.store.events.on(run.id, (event: RunEvent) => {
      if (event.type === 'tool.completed')
        observations.push({
          transaction: s.store.db.isTransaction,
          step: JSON.parse(
            String(reader.prepare('SELECT payload FROM steps WHERE id=?').get(step.id)!.payload),
          ).status,
          artifacts: JSON.parse(
            String(reader.prepare('SELECT payload FROM runs WHERE id=?').get(run.id)!.payload),
          ).artifactIds,
          memory: [...run.artifactIds],
        });
    });
    const completed = {
      ...step,
      status: 'completed' as const,
      result: { value: { artifacts: [{ id: file.id }] } },
    };
    const event = {
      type: 'tool.completed' as const,
      data: { step_id: step.id, artifacts: [{ id: file.id }] },
    };
    s.store.db.exec(
      `CREATE TRIGGER fail_step_event BEFORE INSERT ON events WHEN NEW.type='tool.completed' BEGIN SELECT RAISE(ABORT,'fixture completion failure'); END;`,
    );
    assert.throws(
      () => s.store.checkpointStep(run, completed, event, [file.id]),
      /fixture completion failure/,
    );
    assert.equal(s.store.getStep(step.id)!.status, 'running');
    assert.deepEqual(s.store.run(run.id).artifactIds, []);
    assert.deepEqual(run.artifactIds, []);
    assert.deepEqual(observations, []);
    assert.deepEqual(s.store.history(run.id), []);
    s.store.db.exec('DROP TRIGGER fail_step_event');
    s.store.checkpointStep(run, completed, event, [file.id]);
    assert.deepEqual(observations, [
      { transaction: false, step: 'completed', artifacts: [file.id], memory: [file.id] },
    ]);
    assert.equal(
      s.store.getStep(step.id)!.result!.value && s.store.artifacts(run.id, run.owner).data[0]!.id,
      file.id,
    );
  } finally {
    reader.close();
    await s.cleanup();
  }
});

test('step checkpoints reject cross-run identities and artifact references', async () => {
  const s = await setup();
  try {
    const a = runFixture(),
      b = runFixture('resp_other');
    s.store.createRun(a);
    s.store.createRun(b);
    const step = stepFixture(a);
    s.store.step(step);
    assert.throws(() => s.store.step({ ...step, runId: b.id }), /another run/);
    assert.equal(s.store.getStep(step.id)!.runId, a.id);
    const otherFile = await s.store.addFile(
      'owner',
      'other.txt',
      Buffer.from('other'),
      undefined,
      b.id,
    );
    const complete = { ...step, status: 'completed' as const, result: { value: 'result' } };
    assert.throws(
      () =>
        s.store.checkpointStep(b, complete, { type: 'tool.completed', data: { step_id: step.id } }),
      /belong/,
    );
    assert.throws(
      () =>
        s.store.checkpointStep(
          a,
          complete,
          { type: 'tool.completed', data: { step_id: step.id } },
          [otherFile.id],
        ),
      /belong/,
    );
    assert.throws(
      () =>
        s.store.checkpointStep(a, complete, {
          type: 'tool.completed',
          data: { step_id: 'different' },
        }),
      /identify/,
    );
    assert.equal(s.store.getStep(step.id)!.status, 'running');
  } finally {
    await s.cleanup();
  }
});

test('reentrant completion observers cannot lose a previously committed artifact', async () => {
  const s = await setup();
  try {
    const run = runFixture();
    s.store.createRun(run);
    const first = stepFixture(run),
      second = stepFixture(run, 'step_b');
    s.store.step(first);
    s.store.step(second);
    const a = await s.store.addFile(run.owner, 'a.txt', Buffer.from('a'), undefined, run.id);
    const b = await s.store.addFile(run.owner, 'b.txt', Buffer.from('b'), undefined, run.id);
    const events: number[] = [];
    s.store.events.on(run.id, (event: RunEvent) => {
      events.push(event.id);
      if (event.data.step_id === first.id)
        s.store.checkpointStep(
          run,
          { ...second, status: 'completed', result: { value: 'b' } },
          { type: 'tool.completed', data: { step_id: second.id } },
          [b.id],
        );
    });
    s.store.checkpointStep(
      run,
      { ...first, status: 'completed', result: { value: 'a' } },
      { type: 'tool.completed', data: { step_id: first.id } },
      [a.id],
    );
    assert.deepEqual(run.artifactIds, [a.id, b.id]);
    assert.deepEqual(s.store.run(run.id).artifactIds, [a.id, b.id]);
    assert.deepEqual(
      events,
      s.store.history(run.id).map((event) => event.id),
    );
  } finally {
    await s.cleanup();
  }
});

test('failed durable completion of a non-idempotent tool is uncertain and never retried', async () => {
  let calls = 0;
  const s = await setup(
    new FixtureModel(() => ({ calls: [{ id: 'write', name: 'emit_report', arguments: {} }] })),
  );
  try {
    const capability = capabilitySchema.parse({
      id: 'fixture/report',
      version: '1',
      description: 'Owned fixture side effect',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'write',
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'report',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('report', async () => {
      calls++;
      return {
        value: 'confirmed response',
        artifacts: [
          {
            name: 'report.txt',
            content: Buffer.from('report').toString('base64'),
            sha256: sha('report'),
          },
        ],
      };
    });
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [
            { name: 'emit_report', capability, handler: { kind: 'node', reference: 'report' } },
          ],
        }),
      ),
    );
    s.store.db.exec(
      `CREATE TRIGGER fail_step_event BEFORE INSERT ON events WHEN NEW.type='tool.completed' BEGIN SELECT RAISE(ABORT,'fixture completion failure'); END;`,
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error!.code, 'effect_outcome_unknown');
    assert.equal(calls, 1);
    assert.equal(s.driver.calls, 1);
    assert.deepEqual(done.artifactIds, []);
    const step = s.store.steps(run.id)[0]!;
    assert.equal(step.status, 'uncertain');
    assert.equal(step.error, 'step_checkpoint_failed');
    assert.equal(step.result, undefined);
    assert.equal(
      s.store.history(run.id).some((event) => event.type === 'tool.completed'),
      false,
    );
    assert.throws(() => s.kernel.resume(principal, run.id), /uncertain/);
  } finally {
    await s.cleanup();
  }
});

test('an uncommitted tool-start event cannot launch a side effect', async () => {
  let calls = 0;
  const s = await setup(
    new FixtureModel(() => ({ calls: [{ id: 'write', name: 'write_value', arguments: {} }] })),
  );
  try {
    const capability = capabilitySchema.parse({
      id: 'fixture/start',
      version: '1',
      description: 'Controlled fixture',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'write',
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'write',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('write', async () => ({ value: ++calls }));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [
            { name: 'write_value', capability, handler: { kind: 'node', reference: 'write' } },
          ],
        }),
      ),
    );
    s.store.db.exec(
      `CREATE TRIGGER fail_start BEFORE INSERT ON events WHEN NEW.type='tool.started' BEGIN SELECT RAISE(ABORT,'fixture start failure'); END;`,
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    assert.equal((await s.kernel.wait(run.id)).status, 'failed');
    assert.equal(calls, 0);
    assert.equal(s.store.steps(run.id)[0]!.status, 'failed');
    assert.equal(
      s.store.history(run.id).some((event) => event.type === 'tool.started'),
      false,
    );
  } finally {
    await s.cleanup();
  }
});

test('a parallel sibling cannot publish artifacts from another unfinished step', async () => {
  const staged = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel((_agent, messages) =>
      messages.some((message) => message.role === 'tool')
        ? { text: 'done' }
        : {
            calls: [
              { id: 'a', name: 'collect', arguments: { key: 'a' } },
              { id: 'b', name: 'collect', arguments: { key: 'b' } },
            ],
          },
    ),
  );
  try {
    const capability = capabilitySchema.parse({
      id: 'fixture/collect',
      version: '1',
      description: 'Collect fixture artifacts',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'collect',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('collect', async (args) => {
      if (args.key === 'b') await staged.promise;
      return {
        value: args.key,
        artifacts: (args.key === 'a' ? ['a1.txt', 'a2.txt'] : ['b.txt']).map((name) => ({
          name,
          content: Buffer.from(name).toString('base64'),
          sha256: sha(name),
        })),
      };
    });
    const addFile = s.store.addFile.bind(s.store);
    s.store.addFile = async (...args) => {
      const file = await addFile(...args);
      if (args[1] === 'a2.txt') {
        staged.resolve();
        await release.promise;
      }
      return file;
    };
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [{ name: 'collect', capability, handler: { kind: 'node', reference: 'collect' } }],
        }),
      ),
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    let atSibling: string[] | undefined;
    s.store.events.on(run.id, (event: RunEvent) => {
      if (
        event.type === 'tool.completed' &&
        s.store.getStep(String(event.data.step_id))!.callId === 'b'
      ) {
        atSibling = s.store.artifacts(run.id, run.owner).data.map((artifact) => artifact.filename);
        release.resolve();
      }
    });
    assert.equal((await s.kernel.wait(run.id)).status, 'completed');
    assert.deepEqual(atSibling, ['b.txt']);
    assert.deepEqual(
      s.store
        .artifacts(run.id, run.owner)
        .data.map((artifact) => artifact.filename)
        .sort(),
      ['a1.txt', 'a2.txt', 'b.txt'],
    );
  } finally {
    release.resolve();
    staged.resolve();
    await s.cleanup();
  }
});

test('an uncertain write invalidates session read caches before an explicit reconciled resume', async () => {
  let value = 0,
    reads = 0,
    writes = 0;
  const s = await setup(
    new FixtureModel((_agent, messages) => {
      const count = messages.filter((message) => message.role === 'tool').length;
      if (count === 0) return { calls: [{ id: 'read0', name: 'read_value', arguments: {} }] };
      if (count === 1) return { calls: [{ id: 'write', name: 'write_value', arguments: {} }] };
      if (count === 2) return { calls: [{ id: 'read1', name: 'read_value', arguments: {} }] };
      return { text: messages.filter((message) => message.role === 'tool').at(-1)!.content };
    }),
  );
  try {
    const bindings: ToolBinding[] = ['read', 'write'].map((kind) => {
      const capability = capabilitySchema.parse({
        id: `fixture/${kind}`,
        version: '1',
        description: 'Owned fixture',
        placement: 'host-bound',
        nodeId: 'local',
        effect: kind,
        cacheTtlMs: kind === 'read' ? 60000 : 0,
        inputSchema: { type: 'object' },
      });
      s.runtime.config.tools.push({
        reference: kind,
        capability,
        handler: { kind: 'read_directory', root: s.dir },
      });
      return { name: `${kind}_value`, capability, handler: { kind: 'node', reference: kind } };
    });
    s.runtime.handlers.set('read', async () => {
      reads++;
      return { value };
    });
    s.runtime.handlers.set('write', async () => {
      value = 1;
      writes++;
      throw new Fault('execution_failed', 'Fixture write outcome unknown', 502, true);
    });
    s.store.publish('owner', makeBundle(agent({ tools: bindings })));
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    assert.equal((await s.kernel.wait(run.id)).status, 'interrupted');
    const step = s.store.steps(run.id).find((step) => step.name === 'write_value')!;
    s.kernel.reconcile(principal, run.id, step.id, 'completed', 'operator verified fixture value');
    s.kernel.resume(principal, run.id);
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.output.at(-1)!.text, '1');
    assert.equal(reads, 2);
    assert.equal(writes, 1);
  } finally {
    await s.cleanup();
  }
});

for (const phase of ['inside', 'after'] as const)
  test(`hard termination ${phase} the step transaction cannot leave a false complete checkpoint`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-step-crash-'));
    let reopened: Store | undefined;
    try {
      const child = spawn(
        process.execPath,
        [path.resolve('dist/test/fixtures/step-crash.js'), dir, phase],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let errors = '';
      child.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      const end = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(Error('Crash fixture deadline exceeded.'));
          }, 5000);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        },
      );
      assert.equal(end.signal, 'SIGKILL', errors);
      const marker = JSON.parse(await readFile(path.join(dir, 'checkpoint.json'), 'utf8'));
      assert.equal(marker.transaction, phase === 'inside');
      reopened = new Store(dir);
      reopened.recover();
      const run = reopened.run('resp_crash');
      const step = reopened.getStep('step_crash')!;
      assert.equal(run.status, 'interrupted');
      assert.equal(step.status, phase === 'inside' ? 'uncertain' : 'completed');
      assert.equal(run.artifactIds.length, phase === 'inside' ? 0 : 1);
      assert.equal(
        reopened.history(run.id).filter((event) => event.type === 'tool.completed').length,
        phase === 'inside' ? 0 : 1,
      );
      if (phase === 'after')
        assert.equal(
          (await reopened.filePayload(run.artifactIds[0]!, run.owner)).content,
          Buffer.from('crash fixture artifact').toString('base64'),
        );
    } finally {
      reopened?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
