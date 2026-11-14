import { gatewaySchema, workerSchema } from '../../src/config/config.js';
import { createGateway } from '../../src/gateway/server.js';
import { WorkerRuntime } from '../../src/fabric/worker.js';
import { makeBundle } from '../../src/lang/bundle.js';
import { invocationSchema } from '../../src/gateway/protocol.js';
import { sleep } from '../../src/core/util.js';
import type { RunEvent } from '../../src/core/contracts.js';
import { FixtureModel, agent, principal, token } from '../helpers.js';
import path from 'node:path';

const root = process.argv[2]!;
process.env.OAA_CRASH_FIXTURE_TOKEN = token;
const driver = new FixtureModel();
driver.call = async (_a, _m, signal, emit) => {
  emit('persisted before crash');
  await sleep(60_000, signal);
  throw new Error('This owned fixture is expected to be killed by its parent.');
};
const worker = workerSchema.parse({ nodeId: 'local', dataDir: path.join(root, 'worker') });
const gateway = await createGateway(
  gatewaySchema.parse({
    dataDir: root,
    port: 0,
    localWorker: worker,
    keys: [
      {
        name: 'fixture',
        owner: 'owner',
        tokenEnv: 'OAA_CRASH_FIXTURE_TOKEN',
        scopes: principal.scopes,
      },
    ],
  }),
  new WorkerRuntime(worker, new Map(), new Map([['fixture', driver]])),
);
await gateway.app.ready();
gateway.store.publish('owner', makeBundle(agent()));
const run = gateway.kernel.submit(
  principal,
  invocationSchema.parse({ agent: 'agent/test', input: 'hard crash fixture' }),
);
gateway.store.events.on(run.id, (event: RunEvent) => {
  if (event.type === 'response.output_text.delta')
    process.send!({ runId: run.id, cursor: event.id, text: event.data.delta });
});
