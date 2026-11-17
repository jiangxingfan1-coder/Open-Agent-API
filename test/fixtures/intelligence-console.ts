import { setup, FixtureModel, agent, token } from '../helpers.js';
import { makeBundle } from '../../src/lang/bundle.js';
import { writePrivate } from '../../src/core/util.js';
import { ModelEvaluations } from '../../src/store/model-evaluations.js';
import { evaluationCases } from '../../src/core/model-evaluation.js';
import { evaluationRevision } from '../../src/kernel/model-evaluation.js';
import { workerSchema } from '../../src/config/config.js';
import { whichSync } from '../../src/core/which.js';
import { taskWorkflowSchema } from '../../src/lang/task-workflow.js';

const driver = new FixtureModel((a, messages) => {
  const input = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  if (input.startsWith('Create a workflow definition'))
    return {
      text: JSON.stringify(
        taskWorkflowSchema.parse({
          id: 'generated',
          name: 'Generated fixture',
          enabled: false,
          graph: {
            steps: [
              {
                id: 'execute',
                tool: a.id,
                arguments: {
                  input: { $ref: 'input#/task', $default: 'Fixture task' },
                  model: 'accurate',
                },
              },
            ],
          },
        }),
      ),
    };
  if (input.startsWith('Plan this task;'))
    return {
      text: JSON.stringify({
        stages: [
          {
            id: 'execute',
            role: 'execute',
            agent: a.id,
            model: 'accurate',
            task: 'Return the requested result.',
          },
        ],
      }),
    };
  if (input.includes('A store starts with')) {
    const n = [...input.matchAll(/\d+/g)].map((m) => Number(m[0]));
    return { text: JSON.stringify({ answer: n[0]! * n[1]! - n[2]! + n[3]! * n[4]! }) };
  }
  return { text: 'Controlled local fixture response. No live model was called.' };
});
const s = await setup(driver);
const a = agent({
  id: 'agent/intelligence',
  description: 'Controlled fixture for model selection and evaluation.',
  model: 'quick',
  orchestration: { enabled: true, scope: 'agent' },
  access: {
    modes: ['managed', 'client', 'hybrid'],
    defaultMode: 'managed',
    approval: 'auto',
    trust: 'private',
  },
  routes: [
    { id: 'quick', model: 'quick', provider: 'fixture', priority: 0 },
    { id: 'accurate', model: 'accurate', provider: 'fixture', priority: 1 },
  ],
});
s.store.publish('owner', makeBundle(a));
const records = new ModelEvaluations(s.store);
const revision = evaluationRevision(s.hub, 'owner', a);
for (const route of a.routes)
  for (const [i, sample] of evaluationCases('ui').entries())
    records.save({
      owner: 'owner',
      agent: a.id,
      revision,
      route: route.id,
      epoch: 0,
      caseId: sample.id,
      dimension: sample.dimension,
      runId: 'ui-fixture',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      elapsedMs: route.id === 'accurate' ? 1200 : 500,
      passed: route.id === 'accurate' || i < 5,
    });

// Live probes are explicitly separate: only the isolated worker uses installed programs.
if (process.env.OAA_PROBE_LIVE === '1') {
  for (const [engine, command] of [
    ['codex', 'codex'],
    ['claude', 'claude'],
    ['antigravity', 'agy'],
  ] as const) {
    const executable = whichSync(command);
    if (!executable) continue;
    const config = workerSchema.shape.native.parse({
      [engine]: { executable, enabled: true, args: [] },
    });
    Object.assign(s.config.localWorker!.native, config);
    Object.assign(s.runtime.config.native, config);
    const native = agent({
      id: `agent/live-${engine}`,
      engine,
      provider: 'native',
      model: 'default',
      instructions:
        'Work only inside the current isolated task directory. Do not read credentials or other directories. Do not access the network or change global settings.',
      approvals: engine === 'antigravity' ? 'ask' : 'auto',
      allowGraph: false,
      limits: { maxTurns: 8, maxOutputTokens: 2048, maxTotalTokens: 20000, timeoutMs: 120000 },
    });
    s.store.publish('owner', makeBundle(native));
  }
}
await writePrivate(s.dir, 'admin.token', token);
const address = await s.listen();
console.log(JSON.stringify({ address, tokenFile: `${s.dir}/admin.token`, dataDir: s.dir }));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void s.cleanup().then(() => process.exit(0));
  });
