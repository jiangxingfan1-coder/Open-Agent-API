import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { principalSubject, type Run } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/kernel/invocation.js';
import { callDelegate, type DelegateRuntime } from '../src/kernel/delegate.js';
import { stepIdFor } from '../src/kernel/run-state.js';
import { Fault } from '../src/core/util.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { createGateway } from '../src/gateway/server.js';
import { projects } from '../src/store/projects.js';
import { agent, FixtureModel, principal, setup, waitFor } from './helpers.js';

function driver() {
  const calls: string[] = [];
  return {
    calls,
    model: new FixtureModel((definition, messages) => {
      calls.push(definition.id);
      return definition.id === 'agent/parent' && !messages.some((m) => m.role === 'tool')
        ? {
            calls: [
              { id: 'delegate', name: 'ask_leaf', arguments: { task: 'read the project note' } },
            ],
          }
        : { text: 'fixture done' };
    }),
  };
}
function publish(s: Awaited<ReturnType<typeof setup>>) {
  s.store.publish('owner', makeBundle(agent({ id: 'agent/leaf' })));
  s.store.publish(
    'owner',
    makeBundle(
      agent({ id: 'agent/parent', delegates: [{ name: 'ask_leaf', agent: 'agent/leaf' }] }),
    ),
  );
}

test('delegate: unreadable, missing and mismatched receipts are not mistaken for confirmed work', async (t) => {
  const hold = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async (definition) => {
      if (definition.id === 'agent/parent') await hold.promise;
      return { text: 'unrelated fixture result' };
    }),
  );
  try {
    publish(s);
    const invoke = (agent: string) =>
      invocationSchema.parse({ agent, input: 'fixture', background: true });
    const other = s.kernel.submit(principal, invoke('agent/leaf'));
    await s.kernel.wait(other.id);
    const p = s.kernel.submit(principal, invoke('agent/parent'));
    await waitFor(() => s.store.run(p.id).status === 'in_progress');
    const parent = s.store.run(p.id),
      binding = s.store.bundle('owner', 'agent/parent').agent.delegates![0]!;
    let submissions = 0;
    const unexpected = (): never => {
      throw new Error('unexpected delegate operation');
    };
    const rt: DelegateRuntime = {
      store: s.store,
      submit: () => {
        submissions++;
        throw new Fault('model_unavailable', 'fixture stopped before dispatch', 503);
      },
      wait: unexpected,
      cancel: unexpected,
      providerKey: () => undefined,
      closing: () => false,
      prioritize: unexpected,
      lendSlot: unexpected,
      reclaimSlot: unexpected,
    };
    const read = s.store.run.bind(s.store);
    t.mock.method(s.store, 'run', (...args: Parameters<typeof read>) => {
      if (args[0] === 'unreadable') throw new Error('fixture read failed');
      return read(...args);
    });
    for (const [childId, effect, expected] of [
      [other.id, 'read', 'effect_outcome_unknown'],
      ['missing-write', 'idempotent-write', 'effect_outcome_unknown'],
      ['unreadable', 'read', 'effect_outcome_unknown'],
      ['missing-read', 'read', 'model_unavailable'],
    ] as const) {
      const call = { id: childId, name: binding.name, arguments: { task: 'fixture' } },
        id = stepIdFor(p.id, parent.checkpoint.turn, call.id);
      s.store.step({
        id,
        runId: p.id,
        callId: call.id,
        name: binding.name,
        effect,
        status: 'pending',
        arguments: call.arguments,
        childRunId: childId,
      });
      await assert.rejects(
        callDelegate(rt, parent, binding, call, new AbortController().signal, {
          progressed: false,
        }),
        { code: expected },
      );
      assert.equal(
        s.store.getStep(id)?.status,
        expected === 'effect_outcome_unknown' ? 'uncertain' : 'failed',
      );
    }
    assert.equal(submissions, 1, 'only a confirmed missing read-only child can be submitted again');
  } finally {
    hold.resolve();
    await s.cleanup();
  }
});
for (const failure of ['link', 'parent_event', 'child_event'] as const)
  test(`delegate: ${failure} write failure creates no child, work, or provisional start notification`, async () => {
    const d = driver(),
      s = await setup(d.model);
    try {
      publish(s);
      const clause = {
        link: "ON steps WHEN json_type(NEW.payload,'$.childRunId')='text'",
        parent_event: "ON events WHEN NEW.type='subagent.started'",
        child_event:
          "ON events WHEN NEW.type='response.created' AND (SELECT agent_id FROM runs WHERE id=NEW.run_id)='agent/leaf'",
      }[failure];
      s.store.db.exec(
        `CREATE TEMP TRIGGER deny BEFORE INSERT ${clause} BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END;`,
      );
      let announced = 0,
        queued = 0;
      s.store.events.on('summary', (e: { agentId: string }) => {
        if (e.agentId === 'agent/leaf') queued++;
      });
      const parent = s.kernel.submit(
        principal,
        invocationSchema.parse({ agent: 'agent/parent', input: 'go', background: true }),
      );
      s.store.events.on(parent.id, (e: { type: string }) => {
        if (e.type === 'subagent.started') announced++;
      });
      const done = await s.kernel.wait(parent.id);
      assert.equal(done.status, 'failed');
      assert.deepEqual(d.calls, ['agent/parent']);
      assert.equal(s.store.allRuns().length, 1);
      assert.equal(queued, 0);
      assert.equal(announced, 0);
      assert.equal(
        s.store.history(parent.id).filter((e) => e.type === 'subagent.started').length,
        0,
      );
      const [step] = s.store.steps(parent.id);
      assert.equal(step?.status, 'failed');
      assert.equal(step.childRunId, undefined);
    } finally {
      await s.cleanup();
    }
  });
for (const outcome of ['committed', 'rolled-back', 'unreadable'] as const)
  test(`delegate: an ambiguous commit is resolved from the unique run or quarantined (${outcome})`, async (t) => {
    const d = driver(),
      s = await setup(d.model);
    try {
      publish(s);
      const db = s.store.db;
      let armed = false,
        lost = false;
      db.function('mark_child', () => {
        armed = true;
        return 1;
      });
      db.exec(
        "CREATE TEMP TRIGGER remember_child AFTER INSERT ON runs WHEN NEW.agent_id='agent/leaf' BEGIN SELECT mark_child(); END;",
      );
      const exec = db.exec.bind(db),
        prepare = s.store.prepare.bind(s.store);
      const io = () =>
        Object.assign(new Error('fixture lost commit acknowledgement'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 10,
        });
      t.mock.method(db, 'exec', (sql: string) => {
        if (armed && sql === 'COMMIT') {
          armed = false;
          exec(outcome === 'rolled-back' ? 'ROLLBACK' : 'COMMIT');
          lost = true;
          throw io();
        }
        return exec(sql);
      });
      t.mock.method(s.store, 'prepare', (sql: string) => {
        if (lost) {
          lost = false;
          if (outcome === 'unreadable') throw io();
        }
        return prepare(sql);
      });
      const p = s.kernel.submit(
        principal,
        invocationSchema.parse({ agent: 'agent/parent', input: 'go', background: true }),
      );
      const done = await s.kernel.wait(p.id);
      const children = s.store.allRuns().filter((r) => r.metadata['oaa.parent_run_id'] === p.id),
        step = s.store.steps(p.id)[0]!;
      if (outcome === 'committed') {
        assert.equal(done.status, 'completed');
        assert.equal(children.length, 1);
        assert.equal(step.childRunId, children[0]!.id);
        assert.equal(d.calls.filter((a) => a === 'agent/leaf').length, 1);
      } else if (outcome === 'rolled-back') {
        assert.equal(done.status, 'failed');
        assert.equal(done.error?.code, 'persistence_failed');
        assert.equal(children.length, 0);
        assert.equal(step.status, 'failed');
        assert.equal(step.childRunId, undefined);
      } else {
        assert.equal(done.status, 'interrupted');
        assert.equal(done.error?.code, 'effect_outcome_unknown');
        assert.equal(children.length, 1);
        assert.equal(children[0]?.status, 'queued');
        assert.equal(step.status, 'uncertain');
        assert.equal(step.childRunId, children[0]!.id);
        assert.equal(d.calls.filter((a) => a === 'agent/leaf').length, 0);
        assert.throws(() => s.kernel.resume(principal, p.id), { code: 'reconciliation_required' });
      }
    } finally {
      await s.cleanup();
    }
  });

for (const mode of [
  'parent',
  'child',
  'legacy-linked',
  'legacy-unlinked',
  'wrong-subject',
] as const)
  test(`delegate: recovery from ${mode} admission preserves authority and executes exactly one child`, async () => {
    const s = await setup();
    let again: Awaited<ReturnType<typeof createGateway>> | undefined;
    try {
      publish(s);
      const grant = s.auth.create(
        principal,
        'scoped',
        ['agent/parent', 'agent/leaf'],
        ['invoke', 'read', 'files'],
        undefined,
        'own',
        'workspace',
      );
      const caller = s.auth.authenticate('Bearer ' + grant.token);
      const project = projects(s.store);
      project.create(principal, 'admission', 'Admission');
      project.put(principal, 'admission', 'notes', 'one', { text: 'delegation checkpoint note' });
      project.grant(principal, 'admission', principalSubject(caller), 'read');
      const config = path.join(s.dir, 'config.json');
      await writeFile(config, JSON.stringify(s.config));
      await s.app.close();
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('dist/test/fixtures/delegate-admission-crash.js'),
          config,
          mode === 'parent' ? 'parent' : 'child',
        ],
        {
          env: { ...process.env, OAA_DELEGATE_FIXTURE_TOKEN: String(grant.token) },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
      assert.equal(result.status, 78, result.stderr);
      const db = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'));
      let parentId: string, childId: string;
      try {
        const load = (agent: string) =>
          JSON.parse(
            String(db.prepare('SELECT payload FROM runs WHERE agent_id=?').get(agent)?.payload),
          ) as Run;
        const parent = load('agent/parent'),
          child = load('agent/leaf');
        parentId = parent.id;
        childId = child.id;
        assert.equal(child.status, 'queued');
        assert.equal(child.subject, parent.subject);
        assert.equal(child.checkpoint.delegationDepth, 1);
        assert.deepEqual(child.checkpoint.grantedAgents, caller.agents);
        assert.equal(child.checkpoint.execution, 'workspace');
        assert.equal(child.checkpoint.keyId, undefined);
        assert.deepEqual(child.checkpoint.project, parent.checkpoint.project);
        assert.equal(child.checkpoint.project?.administrator, false);
        assert.match(
          String(child.checkpoint.messages.at(-1)?.content),
          /delegation checkpoint note/,
        );
        const step = db.prepare('SELECT id,payload FROM steps WHERE run_id=?').get(parent.id)!;
        assert.equal(child.checkpoint.parentStepId, step.id);
        assert.equal(JSON.parse(String(step.payload)).childRunId, child.id);
        const started = db
          .prepare("SELECT id,payload FROM events WHERE run_id=? AND type='subagent.started'")
          .all(parent.id);
        assert.equal(started.length, 1);
        assert.equal(JSON.parse(String(started[0]!.payload)).child_run_id, child.id);
        const created = db
          .prepare("SELECT id FROM events WHERE run_id=? AND type='response.created'")
          .all(child.id);
        assert.equal(created.length, 1);
        assert.ok(Number(started[0]!.id) < Number(created[0]!.id));
        if (mode.startsWith('legacy')) {
          db.prepare(
            "UPDATE runs SET payload=json_remove(payload,'$.checkpoint.parentStepId') WHERE id=?",
          ).run(child.id);
          if (mode === 'legacy-unlinked')
            db.prepare(
              "UPDATE steps SET payload=json_remove(payload,'$.childRunId') WHERE id=?",
            ).run(String(step.id));
        }
        if (mode === 'wrong-subject')
          db.prepare("UPDATE runs SET subject='unrelated-test-caller' WHERE id=?").run(child.id);
      } finally {
        db.close();
      }
      const d = driver();
      again = await createGateway(
        s.config,
        new WorkerRuntime(s.config.localWorker!, new Map(), new Map([['fixture', d.model]])),
      );
      await again.listen();
      const done = await again.kernel.wait(parentId!);
      assert.equal(done.status, 'completed', JSON.stringify(done.error));
      const children = again.store
        .allRuns()
        .filter((r) => r.metadata['oaa.parent_run_id'] === parentId);
      const orphaned = mode === 'legacy-unlinked' || mode === 'wrong-subject';
      assert.equal(children.length, orphaned ? 2 : 1);
      if (orphaned) {
        const orphan = again.store.run(childId!);
        assert.equal(orphan.status, 'cancelled');
        assert.equal(orphan.error?.code, 'parent_interrupted');
        assert.equal(
          again.store.history(childId!).filter((e) => e.type === 'response.in_progress').length,
          0,
        );
      }
      assert.deepEqual(
        d.calls.filter((a) => a === 'agent/leaf'),
        ['agent/leaf'],
      );
      const [completed] = children.filter((c) => c.status === 'completed');
      assert.equal(again.store.steps(parentId!)[0]?.childRunId, completed!.id);
      assert.equal(done.usage?.total_tokens, 45);
      assert.deepEqual(again.auth.keyUsage(caller.keyId), {
        usedRuns: 1,
        usedTokens: 45,
        activeRuns: 0,
      });
    } finally {
      await again?.app.close();
      await s.cleanup();
    }
  });
