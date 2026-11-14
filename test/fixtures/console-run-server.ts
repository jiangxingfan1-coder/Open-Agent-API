import { setup, FixtureModel, agent, principal, token } from '../helpers.js';
import { makeBundle, builtin } from '../../src/lang/bundle.js';
import { capabilitySchema } from '../../src/core/contracts.js';
import { invocationSchema } from '../../src/gateway/protocol.js';
import { Fault, sleep } from '../../src/core/util.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const longText =
  'LONG_OUTPUT_START\n' +
  Array.from(
    { length: 1800 },
    (_, i) =>
      `Line ${String(i + 1).padStart(4, '0')}: Controlled console fixture; no live model or external account.\n`,
  ).join('') +
  'LONG_OUTPUT_END';
const driver = new FixtureModel(async (definition, messages, signal) => {
  if (definition.id === 'agent/console-running') {
    await sleep(600000, signal);
    return { text: 'Late fixture response', usage: null };
  }
  if (definition.id === 'agent/console-uncertain')
    return messages.some((message) => message.role === 'tool')
      ? { text: 'Fixture reconciliation complete.', usage: null }
      : {
          calls: [
            {
              id: 'uncertain',
              name: 'uncertain_write',
              arguments: { payload: 'No external action is performed by this fixture.' },
            },
          ],
          usage: null,
        };
  if (messages.some((message) => message.role === 'tool')) return { text: longText, usage: null };
  return {
    calls: Array.from({ length: 32 }, (_, i) => ({
      id: `report-${i}`,
      name: 'write_file',
      arguments: {
        path: `fixture-report-${String(i + 1).padStart(2, '0')}.md`,
        content: `Report ${i + 1}: local console verification only.`,
      },
    })),
    usage: null,
  };
});
const s = await setup(driver, { approvalTimeoutMs: 600000 });
const originalCall = driver.call.bind(driver);
driver.call = async (definition, messages, signal, emit) => {
  if (
    definition.id === 'agent/console-long' &&
    messages.some((message) => message.role === 'tool')
  ) {
    driver.calls++;
    emit(longText);
    return { text: longText, calls: [], usage: null, finish: 'stop' };
  }
  return originalCall(definition, messages, signal, emit);
};
const requests: { method: string; url: string }[] = [];
s.app.server.on('request', (request) => {
  requests.push({ method: request.method ?? 'GET', url: (request.url ?? '/').split('?')[0]! });
});
const capability = capabilitySchema.parse({
  id: 'fixture/uncertain-write',
  version: '1',
  description: 'Controlled fixture only; no external side effect occurs.',
  placement: 'host-bound',
  nodeId: 'local',
  effect: 'write',
  inputSchema: { type: 'object' },
});
s.runtime.config.tools.push({
  reference: 'uncertain',
  capability,
  handler: { kind: 'read_directory', root: s.dir },
});
s.runtime.handlers.set('uncertain', async () => {
  throw new Fault(
    'execution_failed',
    'Fixture interruption: no external operation was performed.',
    502,
    true,
  );
});
s.store.publish(
  'owner',
  makeBundle(
    agent({
      id: 'agent/console-long',
      description: 'Console fixture: long output and 32 artifacts; no live model.',
      tools: [builtin('write_file')],
    }),
  ),
);
s.store.publish(
  'owner',
  makeBundle(
    agent({
      id: 'agent/console-running',
      description: 'Console fixture: cancellable wait; no live model.',
    }),
  ),
);
s.store.publish(
  'owner',
  makeBundle(
    agent({
      id: 'agent/console-uncertain',
      description: 'Console fixture: manual reconciliation; no external write.',
      tools: [
        { name: 'uncertain_write', capability, handler: { kind: 'node', reference: 'uncertain' } },
      ],
    }),
  ),
);
s.hub.addLocal(
  {
    nodeId: 'console-fixture',
    owner: 'owner',
    token: 'fixture',
    agents: ['*'],
    capabilities: ['*'],
  },
  {
    advertisement: () => ({
      nodeId: 'console-fixture',
      providers: [],
      natives: ['adapter/console-fixture'],
      capabilities: [],
      warm: [],
      concurrency: 1,
    }),
    install: async () => {},
    close: async () => {},
    execute: async (_work, _signal, emit) => {
      const reply = await emit({
        type: 'approval',
        data: {
          native: 'console-fixture',
          method: 'item/tool/requestUserInput',
          question: 'Fixture only: enter a JSON reply.',
          large_preview: 'fixture detail '.repeat(3000),
        },
      });
      if (reply?.decision !== 'approve')
        throw new Fault('permission_denied', 'Fixture approval denied.', 403);
      return {
        text: `Recorded fixture reply: ${JSON.stringify(reply)}`,
        nativeState: {},
        usage: null,
      };
    },
  },
);
s.store.publish(
  'owner',
  makeBundle(
    agent({
      id: 'agent/console-review',
      engine: 'adapter/console-fixture',
      model: 'default',
      description: 'Console fixture: approval reply editing; no live model.',
    }),
  ),
);
const submit = (id: string, input: string) =>
  s.kernel.submit(principal, invocationSchema.parse({ agent: id, input, background: true }));
const large = submit('agent/console-long', 'Fixture: long output and paginated artifacts');
await s.kernel.wait(large.id);
const uncertain = submit('agent/console-uncertain', 'Fixture: outcome reconciliation');
await s.kernel.wait(uncertain.id);
const review = submit('agent/console-review', 'Fixture: approval draft preservation');
await s.kernel.wait(review.id, true);
const running = submit(
  'agent/console-running',
  'Fixture: cancel without affecting another request',
);
await writeFile(path.join(s.dir, 'console.token'), token, { mode: 0o600 });
const url = await s.listen();
process.stdout.write(
  JSON.stringify({
    url,
    pid: process.pid,
    token_file: path.join(s.dir, 'console.token'),
    runs: { large: large.id, uncertain: uncertain.id, review: review.id, running: running.id },
    live_models: false,
  }) + '\n',
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const counts: Record<string, number> = {};
  for (const request of requests) {
    const key = `${request.method} ${request.url}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  process.stdout.write(
    JSON.stringify({
      counts,
      full_run_reads: requests.filter(
        (request) => request.method === 'GET' && /^\/v1\/runs\/resp_[^/]+$/.test(request.url),
      ).length,
      stopped: true,
    }) + '\n',
  );
  await s.cleanup();
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
