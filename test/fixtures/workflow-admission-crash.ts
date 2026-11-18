import { readFile } from 'node:fs/promises';
import { createGateway } from '../../src/gateway/server.js';
import { gatewaySchema } from '../../src/config/config.js';
import { WorkerRuntime } from '../../src/fabric/worker.js';
import { FixtureModel, token } from '../helpers.js';

const config = gatewaySchema.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
const gateway = await createGateway(
  config,
  new WorkerRuntime(config.localWorker!, new Map(), new Map([['fixture', new FixtureModel()]])),
);
gateway.store.events.on('summary', (event: { runId: string; status: string }) => {
  if (
    event.status === 'queued' &&
    gateway.store.run(event.runId).metadata['oaa.workflow_execution']
  )
    process.exit(73); // Stop after the child is publicly observable, before submit returns to the parent.
});
await gateway.app.inject({
  method: 'POST',
  url: '/v1/workflows/probe/run',
  headers: { authorization: `Bearer ${token}` },
  payload: {},
});
throw new Error('Child admission crash point was not reached.');
