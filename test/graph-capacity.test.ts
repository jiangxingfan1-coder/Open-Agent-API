import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOaaLang } from '../src/lang/lang.js';
import { parseGraph, parsePublishedGraph } from '../src/lang/graph.js';
import { validateTaskWorkflow } from '../src/lang/task-workflow.js';
import { makeBundle } from '../src/lang/bundle.js';
import { graphTool } from '../src/providers/models.js';
import { setup, FixtureModel, waitFor } from './helpers.js';

const source = (size: number) => `agent "agent/macro" {
 model = "fixture" provider = "fixture"
 flow count {
   step s0 = $transform(v = 0)
   ${Array.from({ length: size - 1 }, (_, i) => `step s${i + 1} = $transform(v = $(s${i}.v + 1))`).join('\n')}
   return $s${size - 1}.v
 }
}`;

test('64 authored steps compile, publish and run through both named and durable workflow entry points', async () => {
  const compiled = compileOaaLang(source(64));
  assert.equal(compiled.workflowPlans.count!.criticalPathDepth, 64);
  const s = await setup(
    new FixtureModel((_a, messages) => {
      const result = messages.find((m) => m.role === 'tool');
      return result
        ? { text: result.content }
        : { calls: [{ id: 'go', name: 'count', arguments: {} }] };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(compiled.agent));
    const r = await s.request('POST', '/v1/responses', { model: 'agent/macro', input: 'count' });
    assert.equal(r.json().status, 'completed', r.body);
    assert.match(r.json().output.at(-1).content[0].text, /^63$/);
    const wf = compiled.agent.workflows![0]!;
    const saved = await s.request('POST', '/v1/workflows', {
      revision: 'new',
      definition: { id: 'count', name: 'Count', graph: { steps: wf.steps, output: wf.output } },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const started = await s.request('POST', '/v1/workflows/count/run', {});
    assert.equal(started.statusCode, 202, started.body);
    await waitFor(
      async () =>
        (await s.request('GET', '/v1/workflow-runs/' + started.json().id)).json().output === 63,
    );
    assert.equal(s.driver.calls, 2, 'pure workflow nodes do not turn into agent calls');
  } finally {
    await s.cleanup();
  }
});

test('authored capacity does not increase model-generated graph, per-map or total expansion budgets', () => {
  const steps = Array.from({ length: 65 }, (_, i) => ({
    id: 's' + i,
    tool: '$transform',
    arguments: {},
  }));
  assert.equal(graphTool.parameters.properties.steps.maxItems, 32);
  assert.equal(parseGraph({ steps: steps.slice(0, 32) }, new Set()).length, 32);
  assert.throws(() => parseGraph({ steps: steps.slice(0, 33) }, new Set()));
  assert.throws(() => compileOaaLang(source(65)));
  assert.throws(() =>
    validateTaskWorkflow({ id: 'large', name: 'large', graph: { steps } }, new Set()),
  );
  const maps = steps
    .slice(0, 32)
    .map((s) => ({ ...s, foreach: { $ref: '$input', max_items: 32 } }));
  assert.equal(parsePublishedGraph({ steps: maps }, new Set()).length, 32);
  assert.throws(() => parsePublishedGraph({ steps: [...maps, steps[32]] }, new Set()), /1024/);
  assert.throws(() =>
    parsePublishedGraph(
      { steps: [{ ...steps[0], foreach: { $ref: '$input', max_items: 33 } }] },
      new Set(),
    ),
  );
});
