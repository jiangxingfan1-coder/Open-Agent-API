import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store } from '../../src/store/store.js';
import type { ExecutionStep, Run, RunEvent } from '../../src/core/contracts.js';

const [directory, phase] = process.argv.slice(2);
if (!directory || !['inside', 'after'].includes(phase!))
  throw Error('Expected an owned fixture directory and crash phase.');
const store = new Store(directory);
const run: Run = {
  id: 'resp_crash',
  owner: 'owner',
  agentId: 'agent/test',
  digest: 'a'.repeat(64),
  sessionId: 'session_crash',
  previousId: null,
  status: 'in_progress',
  createdAt: 1,
  updatedAt: 1,
  input: 'fixture',
  fileIds: [],
  output: [],
  usage: null,
  checkpoint: { messages: [], phase: 'tools', turn: 1 },
  error: null,
  artifactIds: [],
  metadata: {},
  route: { id: 'default', model: 'fixture', provider: 'fixture', mode: 'auto' },
};
store.createRun(run);
const step: ExecutionStep = {
  id: 'step_crash',
  runId: run.id,
  name: 'fixture_write',
  callId: 'write',
  arguments: {},
  effect: 'write',
  status: 'running',
  nodeId: 'local',
};
store.step(step, { type: 'tool.started', data: { step_id: step.id } });
const file = await store.addFile(
  run.owner,
  'report.txt',
  Buffer.from('crash fixture artifact'),
  ['local'],
  run.id,
);
const crash = () => {
  writeFileSync(
    path.join(directory, 'checkpoint.json'),
    JSON.stringify({ transaction: store.db.isTransaction }),
    { flag: 'wx', mode: 0o600 },
  );
  process.kill(process.pid, 'SIGKILL');
};
if (phase === 'inside') {
  const write = store.step.bind(store);
  store.step = (value, event) => {
    write(value, event);
    if (value.status === 'completed') crash();
  };
} else
  store.events.on(run.id, (event: RunEvent) => {
    if (event.type === 'tool.completed') crash();
  });
store.checkpointStep(
  run,
  { ...step, status: 'completed', result: { value: { artifacts: [{ id: file.id }] } } },
  { type: 'tool.completed', data: { step_id: step.id } },
  [file.id],
);
throw Error('Crash injection was not reached.');
