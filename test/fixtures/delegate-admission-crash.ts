import { readFile } from 'node:fs/promises';
import { gatewaySchema } from '../../src/config/config.js';
import { createGateway } from '../../src/gateway/server.js';
import { WorkerRuntime } from '../../src/fabric/worker.js';
import { invocationSchema } from '../../src/kernel/invocation.js';
import { FixtureModel } from '../helpers.js';

const config = gatewaySchema.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
const driver = new FixtureModel((agent, messages) =>
  agent.id === 'agent/parent' && !messages.some((m) => m.role === 'tool')
    ? {
        calls: [{ id: 'delegate', name: 'ask_leaf', arguments: { task: 'read the project note' } }],
      }
    : { text: 'fixture done' },
);
const g = await createGateway(
  config,
  new WorkerRuntime(config.localWorker!, new Map(), new Map([['fixture', driver]])),
);
await g.app.ready();
if (process.argv[3] === 'child')
  g.store.events.prependListener('summary', (e: { agentId: string; status: string }) => {
    if (e.agentId === 'agent/leaf' && e.status === 'queued') process.exit(78);
  });
const p = g.auth.authenticate('Bearer ' + process.env.OAA_DELEGATE_FIXTURE_TOKEN);
const run = g.kernel.submit(
  p,
  invocationSchema.parse({
    agent: 'agent/parent',
    input: 'delegate',
    background: true,
    metadata: { 'oaa.durable': 'true', 'oaa.project': 'admission' },
  }),
);
if (process.argv[3] === 'parent')
  g.store.events.prependListener(run.id, (e: { type: string }) => {
    if (e.type === 'subagent.started') process.exit(78);
  });
await g.kernel.wait(run.id);
throw Error('Expected to exit at a committed admission notification.');
