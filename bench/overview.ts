// Console polling benchmark for GET /v1/overview (in-process app.inject; no sockets, no models).
// Usage: node dist/bench/overview.js --label NAME --out NEW_REPORT.json
// The same compiled file runs against an older build: copy it next to that build's bench/ folder.
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setup, agent, FixtureModel, principal, token } from '../test/helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import type { NodeAdvertisement } from '../src/core/contracts.js';

const { values } = parseArgs({
  options: { out: { type: 'string' }, label: { type: 'string' } },
});
if (!values.out || !values.label)
  throw new Error(
    'Use --label NAME --out NEW_REPORT.json. Existing reports are never overwritten.',
  );
const workload = {
  format: 'oaa.overview-benchmark.v1',
  kernelAgents: 20,
  adapterAgents: 20,
  routesPerAgent: 2,
  enabledLocalBackends: 16,
  extraNodes: 3,
  completedRuns: 300,
  polls: 300,
  warmups: 20,
};
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return {
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    mean_ms: values.reduce((n, v) => n + v, 0) / values.length,
  };
};
// The benchmark key gets an explicit high request quota; the gateway default (600 rpm) is unchanged.
const s = await setup(new FixtureModel(() => ({ text: 'Fixture overview result.' })), {
  keys: [
    {
      name: 'test',
      owner: 'owner',
      tokenEnv: 'OAA_TEST_TOKEN',
      scopes: principal.scopes,
      quota: { rpm: 100_000 },
    },
  ],
});
try {
  for (const engine of ['codex', 'claude', 'antigravity', 'dsh'] as const)
    s.runtime.config.native[engine] = { executable: process.execPath, enabled: true, args: [] };
  for (let i = 0; i < workload.enabledLocalBackends - 4; i++)
    s.runtime.config.adapters[`acp${i}`] = {
      transport: 'stdio',
      command: process.execPath,
      args: [],
      enabled: true,
    };
  for (let n = 0; n < workload.extraNodes; n++) {
    const advertisement: NodeAdvertisement = {
      nodeId: `bench-node-${n}`,
      providers: ['fixture'],
      natives: Array.from({ length: 8 }, (_, i) => `adapter/acp${i}`),
      capabilities: [],
      warm: [],
      concurrency: 4,
      execution: {
        builtins: [],
        scripts: [],
        toolSelection: true,
        nativeModels: Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`adapter/acp${i}`, { mode: 'declared' as const }]),
        ),
      },
    };
    s.hub.addLocal(
      {
        nodeId: advertisement.nodeId,
        owner: 'owner',
        token: 'local',
        agents: ['*'],
        capabilities: ['*'],
      },
      {
        advertisement: () => advertisement,
        install: async () => {},
        execute: async () => {
          throw new Error('Benchmark nodes never execute work.');
        },
        close: async () => {},
      },
    );
  }
  const routes = (provider: string) =>
    Array.from({ length: workload.routesPerAgent }, (_, i) => ({
      id: `route-${i}`,
      provider,
      model: i === 0 ? (provider === 'native' ? 'default' : 'fixture') : `model-${i}`,
      priority: i,
    }));
  for (let i = 0; i < workload.kernelAgents; i++)
    s.store.publish(
      'owner',
      makeBundle(agent({ id: `agent/kernel-${i}`, routes: routes('fixture') })),
    );
  for (let i = 0; i < workload.adapterAgents; i++)
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: `agent/adapter-${i}`,
          engine: `adapter/acp${i % 12}`,
          provider: 'native',
          model: 'default',
          instructions: '',
          routes: routes('native'),
        }),
      ),
    );
  for (let i = 0; i < workload.completedRuns; i++) {
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({
        agent: `agent/kernel-${i % workload.kernelAgents}`,
        input: `fixture ${i}`,
        background: true,
      }),
    );
    const done = await s.kernel.wait(run.id);
    if (done.status !== 'completed') throw new Error(JSON.stringify(done.error));
  }
  const headers = { authorization: `Bearer ${token}` };
  const poll = async (extra: Record<string, string> = {}) => {
    const start = performance.now();
    const response = await s.app.inject({
      method: 'GET',
      url: '/v1/overview',
      headers: { ...headers, ...extra },
    });
    const ms = performance.now() - start;
    if (response.statusCode !== 200 && response.statusCode !== 304)
      throw new Error(`Unexpected status ${response.statusCode}: ${response.body.slice(0, 300)}`);
    return {
      ms,
      status: response.statusCode,
      etag: response.headers.etag as string | undefined,
      bytes: response.body.length,
    };
  };
  const first = await poll();
  const body = JSON.parse(
    (await s.app.inject({ method: 'GET', url: '/v1/overview', headers })).body,
  ) as { agents: unknown[]; nodes: unknown[]; runs: unknown[] };
  if (body.agents.length !== workload.kernelAgents + workload.adapterAgents)
    throw new Error('Benchmark agents are not all visible.');
  for (let i = 0; i < workload.warmups; i++) await poll();
  const full: number[] = [];
  for (let i = 0; i < workload.polls; i++) full.push((await poll()).ms);
  const conditional: number[] = [];
  const conditionalStatus = new Map<number, number>();
  for (let i = 0; i < workload.polls; i++) {
    const latest = await poll();
    const result = await poll(latest.etag ? { 'if-none-match': latest.etag } : {});
    conditional.push(result.ms);
    conditionalStatus.set(result.status, (conditionalStatus.get(result.status) ?? 0) + 1);
  }
  // Polls interleaved with real state changes (a run completing between every poll).
  const changing: number[] = [];
  for (let i = 0; i < 40; i++) {
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/kernel-0', input: `change ${i}`, background: true }),
    );
    await s.kernel.wait(run.id);
    changing.push((await poll()).ms);
  }
  const report = {
    recorded_at: new Date().toISOString(),
    label: values.label,
    workload,
    node: process.version,
    evidence: 'in-process app.inject polling of GET /v1/overview; deterministic fixtures only',
    live_model_calls: false,
    sockets: false,
    response: {
      bytes: first.bytes,
      etag: first.etag ?? null,
      agents: body.agents.length,
      nodes: body.nodes.length,
      runs: body.runs.length,
    },
    unchanged_full_poll: stats(full),
    conditional_poll: {
      ...stats(conditional),
      statuses: Object.fromEntries(conditionalStatus),
    },
    poll_after_each_change: stats(changing),
  };
  const out = path.resolve(values.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await s.cleanup();
}
