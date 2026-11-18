import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha } from '../src/core/util.js';
import * as current from '../src/lang/graph.js';

// Pass a compiled baseline graph.js to alternate baseline/current in the same process.
const baseline = process.argv[2];
const versions: [string, typeof current][] = baseline
  ? [
      ['baseline', await import(pathToFileURL(path.resolve(baseline)).href)],
      ['current', current],
    ]
  : [['current', current]];
const input = Array.from({ length: 32 }, (_, i) => i),
  definition = {
    steps: input.map((i) => ({
      id: 'b' + i,
      tool: 'read',
      arguments: { value: { $ref: '$item' } },
      foreach: { $ref: '$input', max_items: 32 },
    })),
  };
const expected = sha(JSON.stringify(Object.fromEntries(input.map((i) => ['b' + i, input]))));
const runners = versions.map(([name, api]) => {
  const steps = api.parseGraph(definition, new Set(['read']), undefined, new Set(['$input']));
  return {
    name,
    async run(width: number) {
      let active = 0,
        peak = 0,
        calls = 0;
      const start = performance.now();
      const values = await api.executeGraph(
        steps,
        width,
        new AbortController().signal,
        async (step, args) => {
          peak = Math.max(peak, ++active);
          calls++;
          if (step.id === 'b0_0') await new Promise<void>((ok) => setImmediate(ok));
          else await Promise.resolve();
          active--;
          return args.value;
        },
        undefined,
        { $input: input },
      );
      const ms = performance.now() - start;
      assert.equal(calls, 1024);
      assert.equal(active, 0);
      assert.equal(peak, width);
      assert.equal(sha(JSON.stringify(values)), expected);
      return ms;
    },
  };
});
const report: {
  implementation: string;
  width: number;
  medianMs: number;
  p95Ms: number;
  promises?: number;
}[] = [];
for (const width of [4, 16, 32]) {
  const samples = new Map(runners.map((r) => [r.name, [] as number[]]));
  for (let round = 0; round < 30; round++) {
    for (const r of round % 2 ? [...runners].reverse() : runners) {
      const ms = await r.run(width);
      if (round >= 6) samples.get(r.name)!.push(ms);
    }
  }
  for (const r of runners) {
    const s = samples.get(r.name)!.sort((a, b) => a - b);
    report.push({
      implementation: r.name,
      width,
      medianMs: +((s[11]! + s[12]!) / 2).toFixed(3),
      p95Ms: +s[22]!.toFixed(3),
    });
  }
}
for (const row of report) {
  let n = 0;
  const hook = createHook({
    init: (_id, type) => {
      if (type === 'PROMISE') n++;
    },
  });
  hook.enable();
  try {
    await runners.find((r) => r.name === row.implementation)!.run(row.width);
  } finally {
    hook.disable();
  }
  row.promises = n;
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      workload: '32 maps x 32 items, one delayed leaf, no I/O or model',
      warmSamples: 24,
      resultHash: expected,
      rows: report,
    },
    null,
    2,
  ),
);
