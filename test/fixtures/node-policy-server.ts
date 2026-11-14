import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setup, principal, token } from '../helpers.js';
import { workerSchema } from '../../src/config/config.js';
import { WorkerRuntime } from '../../src/fabric/worker.js';
import { connectWorker } from '../../src/fabric/network.js';
import { waitFor } from '../helpers.js';

const s = await setup();
const nodeId = 'fixture-remote-no-live-model';
const enrolled = s.auth.enroll(principal, nodeId, ['agent/fixture-only'], []);
s.hub.credentials.push(enrolled.credential);
const url = await s.listen();
const tokenFile = path.join(s.dir, 'node.token');
await writeFile(tokenFile, enrolled.token, { mode: 0o600 });
await writeFile(path.join(s.dir, 'console.token'), token, { mode: 0o600 });
const config = workerSchema.parse({
  nodeId,
  owner: 'owner',
  gatewayUrl: url,
  tokenFile,
  dataDir: path.join(s.dir, 'worker-fixture'),
  concurrency: 1,
});
const stop = new AbortController();
const connection = connectWorker(config, stop.signal, new WorkerRuntime(config)).then(
  () => null,
  (error: unknown) => error,
);
await waitFor(() => s.hub.nodes.has(nodeId));
process.stdout.write(
  JSON.stringify({
    url,
    pid: process.pid,
    node: nodeId,
    token_file: path.join(s.dir, 'console.token'),
    live_models: false,
  }) + '\n',
);
let stopping = false;
const close = async () => {
  if (stopping) return;
  stopping = true;
  stop.abort();
  await connection;
  const history = s.auth.nodePolicyHistory(principal, nodeId, 0, 100);
  process.stdout.write(
    JSON.stringify({
      states: history.data.map((event) => event.state),
      model_calls: s.driver.calls,
      stopped: true,
    }) + '\n',
  );
  await s.cleanup();
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
