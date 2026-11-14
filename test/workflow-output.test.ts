import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitySchema, type Effect, type ToolBinding } from '../src/core/contracts.js';
import { executeGraph, parseGraph, projectGraphOutput } from '../src/lang/graph.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import type { LocalHandler } from '../src/fabric/worker.js';
import { agent, FixtureModel, principal, setup, waitFor } from './helpers.js';

function tool(
  s: Awaited<ReturnType<typeof setup>>,
  name: string,
  effect: Effect,
  handler: LocalHandler,
  approval = false,
): ToolBinding {
  const capability = capabilitySchema.parse({
    id: `fixture/${name}`,
    version: '1',
    description: 'Owned workflow fixture',
    placement: 'host-bound',
    nodeId: 'local',
    effect,
    requiresApproval: approval,
    inputSchema: { type: 'object' },
  });
  s.runtime.config.tools.push({
    reference: name,
    capability,
    handler: { kind: 'read_directory', root: s.dir },
  });
  s.runtime.handlers.set(name, handler);
  return { name, capability, handler: { kind: 'node', reference: name } };
}
const submit = (s: Awaited<ReturnType<typeof setup>>) =>
  s.kernel.submit(principal, invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }));

test('graph projections preserve falsey results and validate references without pruning any step', async () => {
  const definition = {
    steps: [
      { id: 'a', tool: 'read', arguments: {} },
      { id: 'write', tool: 'write', arguments: {} },
    ],
    output: { $ref: 'a#/amount' },
  };
  const called: string[] = [];
  const steps = parseGraph(definition, new Set(['read', 'write']));
  const results = await executeGraph(steps, 2, new AbortController().signal, async (step) => {
    called.push(step.id);
    return { amount: 42 };
  });
  assert.deepEqual(called.sort(), ['a', 'write']);
  assert.equal(projectGraphOutput(definition.output, results), 42);
  assert.equal(projectGraphOutput(undefined, results), results);
  for (const value of [null, false, 0, '', []])
    assert.deepEqual(projectGraphOutput(value, results), value);
  assert.throws(
    () => parseGraph({ ...definition, output: { $ref: 'missing' } }, new Set(['read', 'write'])),
    /output references/,
  );
  assert.throws(
    () => parseGraph({ ...definition, output: { $expr: '$item + 1' } }, new Set(['read', 'write'])),
    /output references/,
  );
});

test('dynamic graph output reduces model context while keeping writes and complete leaf evidence', async () => {
  let writes = 0,
    reads = 0,
    returnedBytes = 0;
  const s = await setup(
    new FixtureModel((_definition, messages) => {
      const result = messages.find((message) => message.role === 'tool');
      if (result) {
        returnedBytes = Buffer.byteLength(result.content);
        assert.deepEqual(JSON.parse(result.content), { total: 3 });
        return { text: result.content };
      }
      return {
        calls: [
          {
            id: 'graph',
            name: 'execute_graph',
            arguments: {
              steps: [
                { id: 'a', tool: 'read', arguments: { amount: 1 } },
                { id: 'b', tool: 'read', arguments: { amount: 2 } },
                { id: 'audit', tool: 'write', arguments: {} },
              ],
              output: { total: { $expr: 'a#/amount + b#/amount' } },
            },
          },
        ],
      };
    }),
  );
  try {
    const read = tool(s, 'read', 'read', async (args) => {
      reads++;
      return { value: { amount: args.amount, evidence: 'x'.repeat(60000) } };
    });
    const write = tool(s, 'write', 'write', async () => ({ value: ++writes }));
    s.store.publish('owner', makeBundle(agent({ tools: [read, write] })));
    const run = submit(s);
    assert.equal((await s.kernel.wait(run.id)).status, 'completed');
    assert.equal(reads, 2);
    assert.equal(writes, 1);
    assert.equal(s.driver.calls, 2);
    assert.ok(returnedBytes < 32);
    const steps = s.store.steps(run.id);
    assert.equal(steps.length, 3);
    assert.ok(Buffer.byteLength(JSON.stringify(steps)) > 120000);
  } finally {
    await s.cleanup();
  }
});

test('compile, publish and invoke APIs share the flow return and output contract', async () => {
  const source = `agent "agent/test" {
    model = "fixture" provider = "fixture"
    flow "summarize" {
      params { label: string }
      step hidden = $transform(raw = "kept outside the next model prompt", amount = 7)
      output_schema { label: string amount: integer }
      return { label: $input.label, amount: $hidden.amount }
    }
  }`;
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: messages.find((m) => m.role === 'tool')!.content }
        : { calls: [{ id: 'flow', name: 'summarize', arguments: { label: 'verified' } }] },
    ),
  );
  try {
    const compiled = await s.request('POST', '/v1/lang/compile', { source });
    assert.equal(compiled.json().valid, true, compiled.body);
    const health = (await s.request('GET', '/health')).json();
    assert.ok(health.features.includes('workflow-output-v1'));
    assert.ok(health.features.includes('oaa-lang-roundtrip-v1'));
    const published = await s.request('POST', '/v1/agents/publish-oaa', { source });
    assert.equal(published.statusCode, 200, published.body);
    const run = submit(s);
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(JSON.parse(done.output.at(-1)!.text), { label: 'verified', amount: 7 });
    assert.equal(s.driver.calls, 2);
  } finally {
    await s.cleanup();
  }
});

test('invalid projection bindings and invalid schemas are refused at publication', () => {
  for (const change of [
    { output: { $ref: 'missing' } },
    { output: { $ref: '$item' } },
    { outputSchema: { type: 'not-a-json-schema-type' } },
  ])
    assert.throws(() =>
      makeBundle(
        agent({
          workflows: [
            {
              name: 'flow',
              steps: [{ id: 'a', tool: '$transform', arguments: { amount: 1 } }],
              ...change,
            },
          ],
        }),
      ),
    );
});

test('a workflow output-contract failure cannot claim completion, advance the model, or repeat a committed write', async () => {
  let writes = 0;
  const s = await setup(
    new FixtureModel(() => ({ calls: [{ id: 'flow', name: 'flow', arguments: {} }] })),
  );
  try {
    const write = tool(s, 'write', 'write', async () => ({ value: ++writes }));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [write],
          workflows: [
            {
              name: 'flow',
              steps: [{ id: 'a', tool: 'write', arguments: {} }],
              output: { $ref: 'a' },
              outputSchema: { type: 'string' },
            },
          ],
        }),
      ),
    );
    const run = submit(s);
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error?.code, 'workflow_output_contract');
    assert.equal(writes, 1);
    assert.equal(s.driver.calls, 1);
    assert.equal(s.store.steps(run.id)[0]?.status, 'completed');
    assert.ok(!s.store.history(run.id).some((event) => event.type === 'workflow.completed'));
  } finally {
    await s.cleanup();
  }
});

test('projected workflows retain approvals and reuse completed steps after readmission', async () => {
  let reads = 0,
    writes = 0;
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: messages.find((m) => m.role === 'tool')!.content }
        : { calls: [{ id: 'flow', name: 'flow', arguments: {} }] },
    ),
    { approvalTimeoutMs: 5000 },
  );
  try {
    const read = tool(s, 'read', 'read', async () => ({ value: ++reads }));
    const write = tool(s, 'write', 'write', async () => ({ value: ++writes }), true);
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [read, write],
          workflows: [
            {
              name: 'flow',
              steps: [
                { id: 'read', tool: 'read', arguments: {} },
                { id: 'write', tool: 'write', arguments: {} },
              ],
              output: { confirmed: { $ref: 'write' } },
              outputSchema: { type: 'object' },
            },
          ],
        }),
      ),
    );
    const run = submit(s);
    await waitFor(() => !!s.store.run(run.id).checkpoint.suspension);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    s.kernel.decide(principal, run.id, s.store.approvals(run.id)[0]!.id, 'approve');
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(JSON.parse(done.output.at(-1)!.text), { confirmed: 1 });
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.equal(s.driver.calls, 2);
  } finally {
    await s.cleanup();
  }
});

test('output projection does not remove durable artifact references from the run', async () => {
  const s = await setup(
    new FixtureModel((_a, messages) =>
      messages.some((m) => m.role === 'tool')
        ? { text: messages.find((m) => m.role === 'tool')!.content }
        : { calls: [{ id: 'flow', name: 'flow', arguments: {} }] },
    ),
  );
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [builtin('write_file')],
          workflows: [
            {
              name: 'flow',
              steps: [
                {
                  id: 'write',
                  tool: 'write_file',
                  arguments: { path: 'report.txt', content: 'verified' },
                },
              ],
              output: { ok: true },
            },
          ],
        }),
      ),
    );
    const run = submit(s);
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(JSON.parse(done.output.at(-1)!.text), { ok: true });
    assert.equal(done.artifactIds.length, 1);
    const payload = await s.store.filePayload(done.artifactIds[0]!, 'owner');
    assert.equal(Buffer.from(payload.content, 'base64').toString(), 'verified');
  } finally {
    await s.cleanup();
  }
});
