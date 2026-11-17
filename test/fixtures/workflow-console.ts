import { setup, FixtureModel, agent, token } from '../helpers.js';
import { makeBundle } from '../../src/lang/bundle.js';
import { capabilitySchema } from '../../src/core/contracts.js';
import { sleep, writePrivate } from '../../src/core/util.js';

const s = await setup(
  new FixtureModel(async (_agent, messages, signal) => {
    if (messages.some((message) => message.role === 'tool')) return { text: 'FIXTURE_APPROVED' };
    if (messages.at(-1)?.content.includes('APPROVAL_PROBE'))
      return { calls: [{ id: 'guard', name: 'guarded', arguments: {} }] };
    if (messages.at(-1)?.content.includes('SLOW_PROBE')) await sleep(10000, signal);
    return { text: 'Controlled workflow fixture. No live model was called.' };
  }),
  { approvalTimeoutMs: 120000 },
);
const capability = capabilitySchema.parse({
  id: 'fixture/guarded',
  version: '1',
  description: 'Controlled in-memory fixture approval',
  placement: 'host-bound',
  nodeId: 'local',
  effect: 'write',
  requiresApproval: true,
  inputSchema: { type: 'object' },
});
s.runtime.config.tools.push({
  reference: 'guarded',
  capability,
  handler: { kind: 'read_directory', root: s.dir },
});
s.runtime.handlers.set('guarded', async () => ({ value: 'Controlled in-memory approval result.' }));
s.store.publish(
  'owner',
  makeBundle(
    agent({
      id: 'agent/review',
      tools: [{ name: 'guarded', capability, handler: { kind: 'node', reference: 'guarded' } }],
    }),
  ),
);
for (const [id, name, prompt, trigger] of [
  ['approval-flow', 'Approval Review', 'APPROVAL_PROBE', { kind: 'manual' }],
  ['scheduled-flow', 'Scheduled Review', 'FIXTURE', { kind: 'interval', minutes: 60, input: {} }],
  ['slow-flow', 'Cancellable Review', 'SLOW_PROBE', { kind: 'manual' }],
] as const) {
  const result = await s.request('POST', '/v1/workflows', {
    revision: 'new',
    definition: {
      id,
      name,
      enabled: false,
      trigger,
      graph: { steps: [{ id: 'review', tool: 'agent/review', arguments: { input: prompt } }] },
    },
  });
  if (result.statusCode !== 200) throw Error(result.body);
}
await writePrivate(s.dir, 'admin.token', token);
const address = await s.listen();
console.log(JSON.stringify({ address, tokenFile: `${s.dir}/admin.token` }));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void s.cleanup().then(() => process.exit(0));
  });
