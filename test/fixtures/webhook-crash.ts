import { readFile } from 'node:fs/promises';
import { gatewaySchema } from '../../src/config/config.js';
import { WorkerRuntime } from '../../src/fabric/worker.js';
import { createGateway } from '../../src/gateway/server.js';
import { FixtureModel, token } from '../helpers.js';

const mode = process.argv[3];
const config = gatewaySchema.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
const gateway = await createGateway(
  config,
  new WorkerRuntime(config.localWorker!, new Map(), new Map([['fixture', new FixtureModel()]])),
);
if (mode === 'fallback')
  gateway.store.db.exec(
    "CREATE TEMP TRIGGER fail_primary BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT,'fixture queue unavailable'); END",
  );
if (mode !== 'await-ack') {
  gateway.store.events.prependListener('summary', (event: { status: string }) => {
    // Exit at the first public notification: the store has committed, observers haven't run.
    if (event.status === (mode === 'cold-recovery' ? 'in_progress' : 'completed')) process.exit(74);
  });
}
await gateway.listen();
await gateway.app.inject({
  method: 'POST',
  url: '/v1/responses',
  headers: { authorization: 'Bearer ' + token },
  payload: { model: 'agent/source', input: 'Complete the source task.' },
});
if (mode !== 'await-ack') throw new Error('Did not reach the expected committed checkpoint.');
