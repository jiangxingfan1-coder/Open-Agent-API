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
const afterCompletion = process.argv[3] === 'completion';
const targetInput = process.argv[4];
gateway.store.events.prependListener('summary', (event: { runId: string; status: string }) => {
  // Exit after the source transaction commits, before the runner can consume its notification.
  if (afterCompletion && event.status === 'completed') process.exit(74);
  if (
    event.status === 'queued' &&
    gateway.store.run(event.runId).metadata['oaa.workflow_execution'] &&
    (!targetInput || gateway.store.run(event.runId).input === targetInput)
  )
    process.exit(73); // Stop after the child is publicly observable, before submit returns to the parent.
});
const response = await gateway.app.inject({
  method: 'POST',
  url: afterCompletion ? '/v1/responses' : '/v1/workflows/probe/run',
  headers: { authorization: `Bearer ${token}` },
  payload: afterCompletion ? { model: 'agent/source', input: 'Complete the source task.' } : {},
});
if (targetInput && response.statusCode === 202)
  await new Promise((resolve) => setTimeout(resolve, 7000));
throw new Error('Child admission crash point was not reached.');
