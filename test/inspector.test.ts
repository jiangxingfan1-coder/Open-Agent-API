import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { setup, agent, FixtureModel, principal, secondToken, waitFor } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import type { Run } from '../src/core/contracts.js';

test('the authenticated endpoint catalog includes inspection routes and their paging limits', async () => {
  const s = await setup();
  try {
    const result = await s.request('GET', '/openapi.json');
    assert.equal(result.statusCode, 200);
    const spec = result.json();
    for (const [url, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(
        methods as Record<
          string,
          { parameters: { in: string; name: string; required?: boolean }[] }
        >,
      )) {
        assert.ok(
          s.app.hasRoute({
            method: method.toUpperCase() as 'GET' | 'POST',
            url: url.replace(/\{([^}]+)\}/g, ':$1'),
          }),
          url,
        );
        assert.deepEqual(
          operation.parameters
            .filter((p) => p.in === 'path')
            .map((p) => ({ name: p.name, required: p.required })),
          Array.from(url.matchAll(/\{([^}]+)\}/g), ([, name]) => ({ name, required: true })),
        );
      }
    }
    for (const [suffix, maximum] of [
      ['steps', 50],
      ['actions', 10],
      ['artifacts', 20],
    ] as const) {
      const operation = spec.paths[`/v1/runs/{id}/${suffix}`].get;
      assert.equal(
        operation.parameters.find((p: { name: string }) => p.name === 'limit').schema.maximum,
        maximum,
      );
    }
    for (const suffix of [
      'steps/{step}',
      'steps/{step}/content',
      'actions/{action}/content',
      'output.txt',
    ])
      assert.ok(spec.paths[`/v1/runs/{id}/${suffix}`].get);
    // Gemini / Claude model routes: every method of a path is registered, not just the last one
    for (const [url, method] of [
      ['/v1beta/models/*', 'post'],
      ['/v1beta/models/*', 'get'],
      ['/v1beta/models', 'get'],
      ['/v1/models/*', 'post'],
      ['/v1/models/*', 'get'],
      ['/v1/models', 'get'],
    ] as const)
      assert.ok(spec.paths[url]?.[method], `${method} ${url}`);
    const models = spec.paths['/v1/models'].get;
    assert.match(models.summary, /anthropic-version/);
    assert.match(models.summary, /x-goog-api-client/);
    assert.deepEqual(
      models.parameters
        .filter((p: { in: string }) => p.in === 'header')
        .map((p: { name: string }) => p.name)
        .sort(),
      ['anthropic-version', 'x-goog-api-client'],
    );
    assert.match(spec.paths['/v1/models/*'].get.summary, /x-goog-api-client/);
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});

test('inspector pages remain bounded and full records are fetched only through explicit content routes', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'small request' }),
    );
    await s.kernel.wait(run.id);
    const state = await s.request('GET', `/v1/runs/${run.id}/state`);
    assert.equal(state.statusCode, 200, state.body);
    assert.equal(state.json().engine, 'kernel');
    const large = 'private-detail-'.repeat(10000);
    for (let i = 0; i < 31; i++) {
      s.store.step({
        id: `step-${i}`,
        runId: run.id,
        callId: `call-${i}`,
        name: `fixture-${i}`,
        effect: 'write',
        status: i === 30 ? 'uncertain' : 'completed',
        arguments: { content: large },
        result: { value: large },
        nodeId: 'local',
      });
      s.store.approval({
        id: `approval-${i}`,
        runId: run.id,
        owner: 'owner',
        stepId: `step-${i}`,
        kind: 'native',
        status: 'pending',
        detail: { content: large },
        expiresAt: Date.now() + 100000,
      });
    }
    const original = s.store.run.bind(s.store),
      originalSteps = s.store.steps.bind(s.store);
    s.store.run = () => {
      throw new Error('Inspector lists must not read a whole checkpoint.');
    };
    s.store.steps = () => {
      throw new Error('Inspector lists must not parse all step results.');
    };
    try {
      const page = await s.request('GET', `/v1/runs/${run.id}/steps?limit=20`);
      assert.equal(page.statusCode, 200);
      assert.equal(page.json().data.length, 20);
      assert.equal(page.json().next_offset, 20);
      assert.equal(page.json().total, 31);
      assert.ok(page.body.length < 10000);
      const filtered = await s.request('GET', `/v1/runs/${run.id}/steps?status=uncertain`);
      assert.equal(filtered.json().data[0].id, 'step-30');
      const detail = await s.request('GET', `/v1/runs/${run.id}/steps/step-30`);
      assert.equal(detail.json().arguments.truncated, true);
      assert.equal(detail.json().result.truncated, true);
      assert.ok(detail.body.length < 20000);
      const actions = await s.request('GET', `/v1/runs/${run.id}/actions`);
      assert.equal(actions.json().data.length, 5);
      assert.equal(actions.json().next_offset, 5);
      assert.equal(actions.json().data[0].detail.truncated, true);
      assert.ok(actions.body.length < 50000);
      const complete = await s.request('GET', `/v1/runs/${run.id}/steps/step-30/content`);
      assert.equal(complete.json().arguments.content, large);
      assert.equal(complete.headers['content-type'], 'application/json; charset=utf-8');
      assert.match(String(complete.headers['content-disposition']), /attachment/);
      const approval = await s.request('GET', `/v1/runs/${run.id}/actions/approval-0/content`);
      assert.equal(approval.json().detail.content, large);
      const text = await s.request('GET', `/v1/runs/${run.id}/output.txt`);
      assert.equal(text.body, 'Fixture response.');
    } finally {
      s.store.run = original;
      s.store.steps = originalSteps;
    }
    // Observer keys (data_scope 'owner') see other callers' runs, still limited by agent and scope.
    const reader = String(
      s.auth.create(principal, 'reader', ['agent/test'], ['read'], undefined, 'owner').token,
    );
    const otherAgent = String(
      s.auth.create(principal, 'other-agent', ['agent/other'], ['read'], undefined, 'owner').token,
    );
    const noRead = String(
      s.auth.create(principal, 'invoke-only', ['agent/test'], ['invoke'], undefined, 'owner').token,
    );
    // A default key only sees its own caller data.
    const ownOnly = String(s.auth.create(principal, 'own-reader', ['agent/test'], ['read']).token);
    for (const endpoint of [
      'state',
      'steps',
      'steps/step-30',
      'steps/step-30/content',
      'actions',
      'actions/approval-0/content',
      'output.txt',
    ]) {
      const url = `/v1/runs/${run.id}/${endpoint}`;
      for (const [key, expected] of [
        [reader, 200],
        [ownOnly, 404],
        [secondToken, 404],
        [otherAgent, 403],
        [noRead, 403],
      ] as const) {
        const response = await s.request('GET', url, undefined, key);
        assert.equal(response.statusCode, expected, `${endpoint}: ${response.body.slice(0, 200)}`);
      }
    }
    const second = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'second' }),
    );
    await s.kernel.wait(second.id);
    assert.equal(
      (await s.request('GET', `/v1/runs/${second.id}/steps/step-30/content`)).statusCode,
      404,
    );
    assert.equal(
      (await s.request('GET', `/v1/runs/${second.id}/actions/approval-0/content`)).statusCode,
      404,
    );
    assert.equal((await s.request('GET', `/v1/runs/${run.id}/steps?limit=51`)).statusCode, 400);
    assert.equal((await s.request('GET', `/v1/runs/${run.id}/actions?limit=11`)).statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('reconciled outcomes remain visibly marked as operator assertions in inspector records', async () => {
  const s = await setup(new FixtureModel());
  const observer = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'), {
    readOnly: true,
  });
  try {
    const bundle = makeBundle(agent());
    s.store.publish('owner', bundle);
    const run: Run = {
      id: 'resp_uncertain_fixture',
      owner: 'owner',
      agentId: bundle.agent.id,
      digest: bundle.digest,
      sessionId: 'session_uncertain',
      previousId: null,
      status: 'interrupted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      input: 'Controlled fixture only',
      fileIds: [],
      output: [],
      usage: null,
      checkpoint: { messages: [], phase: 'done', turn: 0 },
      error: { code: 'effect_outcome_unknown', message: 'Fixture only' },
      artifactIds: [],
      metadata: {},
      route: { id: 'default', provider: 'fixture', model: 'fixture', mode: 'auto' },
    };
    s.store.createRun(run);
    s.store.step({
      id: 'step_uncertain_fixture',
      runId: run.id,
      callId: 'unknown',
      name: 'fixture_write',
      effect: 'write',
      status: 'uncertain',
      arguments: {},
    });
    const seen: unknown[] = [];
    s.store.events.on(run.id, (event) => {
      if (event.type !== 'step.reconciled') return;
      seen.push({
        inTransaction: s.store.db.isTransaction,
        status: observer
          .prepare("SELECT json_extract(payload,'$.status') AS status FROM steps WHERE id=?")
          .get('step_uncertain_fixture')!.status,
        audits: observer
          .prepare("SELECT count(*) AS n FROM events WHERE run_id=? AND type='step.reconciled'")
          .get(run.id)!.n,
      });
    });
    s.store.db.exec(`CREATE TRIGGER fail_reconciliation_audit BEFORE INSERT ON events
      WHEN NEW.type='step.reconciled' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;`);
    assert.throws(
      () =>
        s.kernel.reconcile(principal, run.id, 'step_uncertain_fixture', 'completed', {
          recorded: true,
        }),
      /fixture audit failure/,
    );
    assert.equal(s.store.getStep('step_uncertain_fixture')!.status, 'uncertain');
    assert.equal(s.store.getStep('step_uncertain_fixture')!.result, undefined);
    assert.equal(s.store.history(run.id).filter((e) => e.type === 'step.reconciled').length, 0);
    assert.deepEqual(seen, []);
    s.store.db.exec('DROP TRIGGER fail_reconciliation_audit');
    s.kernel.reconcile(principal, run.id, 'step_uncertain_fixture', 'completed', {
      recorded: true,
    });
    assert.deepEqual(seen, [{ inTransaction: false, status: 'completed', audits: 1 }]);
    assert.throws(
      () => s.kernel.reconcile(principal, run.id, 'step_uncertain_fixture', 'not_executed', null),
      /No uncertain interrupted step/,
    );
    const details = await s.request('GET', `/v1/runs/${run.id}/steps/step_uncertain_fixture`);
    assert.equal(details.json().reconciliation.evidence, 'operator_assertion');
    assert.equal(details.json().reconciliation.outcome, 'completed');
    assert.equal(details.json().status, 'completed');
    assert.equal(
      (await s.request('GET', `/v1/runs/${run.id}/steps`)).json().data[0].reconciled,
      true,
    );
    assert.equal(s.store.run(run.id).status, 'interrupted');
    assert.equal(s.driver.calls, 0);
  } finally {
    observer.close();
    await s.cleanup();
  }
});

for (const decision of ['approve', 'deny'] as const)
  test(`approval ${decision} and its audit commit before observers can dispatch work`, async () => {
    const tool = builtin('write_file');
    tool.capability.requiresApproval = true;
    const model = new FixtureModel((_agent, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: 'Fixture finished after a committed approval.' }
        : {
            calls: [
              {
                id: 'write',
                name: 'write_file',
                arguments: { path: 'approved.txt', content: 'local fixture' },
              },
            ],
          },
    );
    const s = await setup(model, { approvalTimeoutMs: 30000 });
    const observer = new DatabaseSync(path.join(s.config.dataDir, 'state.sqlite'), {
      readOnly: true,
    });
    try {
      s.store.publish('owner', makeBundle(agent({ tools: [tool] })));
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({ agent: 'agent/test', input: 'Fixture approval atomicity' }),
      );
      await waitFor(() => !!s.store.run(run.id).checkpoint.suspension);
      const action = s.store.approvals(run.id)[0]!;
      const notifications: unknown[] = [];
      const auditEvents: string[] = [];
      s.store.events.on(run.id, (event) => {
        if (event.type === 'approval.resolved') auditEvents.push(event.type);
      });
      s.store.events.on(`approval:${action.id}`, () => {
        notifications.push({
          inTransaction: s.store.db.isTransaction,
          status: observer
            .prepare("SELECT json_extract(payload,'$.status') AS status FROM approvals WHERE id=?")
            .get(action.id)!.status,
          audits: observer
            .prepare("SELECT count(*) AS n FROM events WHERE run_id=? AND type='approval.resolved'")
            .get(run.id)!.n,
        });
      });
      s.store.db.exec(`CREATE TRIGGER fail_approval_audit BEFORE INSERT ON events
        WHEN NEW.type='approval.resolved' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;`);
      assert.throws(
        () => s.kernel.decide(principal, run.id, action.id, decision, { confirmed: true }),
        /fixture audit failure/,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(s.store.getApproval(action.id, 'owner').status, 'pending');
      assert.equal(s.store.getApproval(action.id, 'owner').response, undefined);
      assert.equal(s.store.run(run.id).status, 'requires_action');
      assert.equal(s.store.steps(run.id)[0]!.status, 'pending');
      assert.equal(model.calls, 1);
      assert.deepEqual(notifications, []);
      assert.deepEqual(auditEvents, []);
      s.store.db.exec('DROP TRIGGER fail_approval_audit');
      s.kernel.decide(principal, run.id, action.id, decision, { confirmed: true });
      assert.deepEqual(notifications, [
        { inTransaction: false, status: decision === 'approve' ? 'approved' : 'denied', audits: 1 },
      ]);
      assert.deepEqual(auditEvents, ['approval.resolved']);
      const done = await s.kernel.wait(run.id);
      assert.equal(done.status, decision === 'approve' ? 'completed' : 'failed');
      assert.equal(done.artifactIds.length, decision === 'approve' ? 1 : 0);
      assert.throws(
        () => s.kernel.decide(principal, run.id, action.id, decision),
        /no longer pending/,
      );
      assert.equal(s.store.history(run.id).filter((e) => e.type === 'approval.resolved').length, 1);
    } finally {
      observer.close();
      await s.cleanup();
    }
  });
