import { parseArgs } from 'node:util';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { agentSchema } from '../src/core/contracts.js';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { createGateway } from '../src/gateway/server.js';
import { makeBundle } from '../src/lang/bundle.js';
import { GatewayClient } from '../src/client/client.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    executable: { type: 'string' },
    out: { type: 'string' },
    'confirm-live-cost': { type: 'boolean' },
  },
});
if (!values['confirm-live-cost'] || !values.model || !values.executable || !values.out)
  throw new Error(
    'Requires --confirm-live-cost --model EXACT_MODEL_ID --executable PATH --out NEW_DIRECTORY. One native invocation only; no automatic retry.',
  );
const root = path.resolve(values.out);
await mkdir(root, { recursive: true, mode: 0o700 });
const guard = await open(path.join(root, 'invocation-reserved'), 'wx', 0o600);
await guard.close();
process.env.OAA_ACCEPTANCE_TOKEN = randomBytes(32).toString('base64url');
const worker = workerSchema.parse({
  nodeId: 'acceptance-node',
  owner: 'acceptance',
  dataDir: path.join(root, 'worker'),
  concurrency: 1,
  native: {
    antigravity: {
      enabled: true,
      executable: values.executable,
      args: [
        '--mode',
        'plan',
        '--sandbox',
        '--effort',
        'low',
        '--print-timeout',
        '75s',
        '--log-file',
        path.join(root, 'agy.log'),
      ],
    },
  },
});
const gateway = await createGateway(
  gatewaySchema.parse({
    dataDir: path.join(root, 'gateway'),
    port: 0,
    maxActiveRuns: 1,
    localWorker: worker,
    keys: [
      {
        name: 'acceptance-only',
        owner: 'acceptance',
        tokenEnv: 'OAA_ACCEPTANCE_TOKEN',
        agents: ['agent/acceptance-agy'],
        scopes: ['read', 'invoke', 'files', 'admin'],
      },
    ],
  }),
);
const report: Record<string, unknown> = {
  recorded_at: new Date().toISOString(),
  scope: 'one authorized native-agent acceptance task on loopback',
  engine: 'antigravity',
  requested_model: values.model,
  native_invocations: 0,
  provider_request_count: 'not_exposed',
  provider_cost: 'not_reported',
  main_gateway_configuration_changed: false,
  live_model_calls: 'unknown_until_invocation',
};
let responseId: string | undefined;
try {
  const url = await gateway.listen();
  const client = new GatewayClient(url, process.env.OAA_ACCEPTANCE_TOKEN);
  const nonce = randomBytes(6).toString('hex');
  const source = `name,value\nalpha,17\nbeta,29\ngamma,43\n`;
  const adjustments = `deduction=11\nverification_marker=${nonce}\n`;
  const a = await client.request<{ id: string }>('POST', '/v1/files', {
    filename: 'figures.csv',
    content: source,
    encoding: 'utf8',
    allowed_nodes: ['acceptance-node'],
  });
  const b = await client.request<{ id: string }>('POST', '/v1/files', {
    filename: 'adjustments.txt',
    content: adjustments,
    encoding: 'utf8',
    allowed_nodes: ['acceptance-node'],
  });
  const definition = agentSchema.parse({
    id: 'agent/acceptance-agy',
    engine: 'antigravity',
    provider: 'native',
    model: values.model,
    description: 'One authorized Gemini 3.8 Flash acceptance test; not a public agent.',
    instructions:
      'Read only the two provided input files in this task workspace. Do not inspect other directories, fetch URLs, invoke other agents, install software, or write files. Return the requested JSON answer directly after reading the files.',
    allowedNodes: ['acceptance-node'],
    tools: [],
    allowGraph: false,
    limits: {
      maxTurns: 3,
      maxOutputTokens: 256,
      maxTotalTokens: 3000,
      timeoutMs: 90000,
      toolConcurrency: 1,
    },
  });
  const bundle = makeBundle(definition);
  gateway.store.publish('acceptance', bundle);
  report.preview = await client.request('POST', '/v1/agents/preview', {
    agent: definition.id,
    model: values.model,
    agent_version: bundle.digest,
    file_ids: [a.id, b.id],
  });
  report.budget_boundary =
    'One native task; 75s CLI / 90s platform deadline. Native provider request/token/cost caps are not claimed to be enforceable by the kernel.';
  report.native_invocations = 1;
  report.live_model_calls = 'native_invocation_attempted_provider_count_not_exposed';
  const start = performance.now();
  const response = await client.request<{ id: string }>(
    'POST',
    '/v1/invoke',
    {
      protocol: 'oaa/1',
      agent: definition.id,
      agent_version: bundle.digest,
      model: values.model,
      input:
        'Read figures.csv and adjustments.txt from the supplied input paths. Sum the value column, subtract deduction, and return only a compact JSON object with net_total, verification_marker copied from adjustments.txt, and sources containing the two filenames. Do not invent the marker. This is a read-only verification task, not an implementation or planning request.',
      file_ids: [a.id, b.id],
      background: true,
    },
    { idempotencyKey: 'single-native-acceptance-v1' },
  );
  responseId = response.id;
  const run = await gateway.kernel.wait(response.id, true);
  const output = run.output.map((m) => m.text).join('\n\n');
  const events = gateway.store.history(run.id, 0, 10000);
  report.elapsed_ms = performance.now() - start;
  report.response_id = run.id;
  report.status = run.status;
  report.error = run.error;
  report.route = run.route;
  report.usage = run.usage;
  report.output_text = output;
  report.native_state = run.checkpoint.nativeState;
  report.first_event_at = events[0]?.time;
  report.first_text_at = events.find((e) => e.type === 'response.output_text.delta')?.time ?? null;
  report.source_check = {
    expected_net_total: 78,
    marker_matches: output.includes(nonce),
    filenames_present: output.includes('figures.csv') && output.includes('adjustments.txt'),
  };
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {}
  report.semantic_pass =
    run.status === 'completed' &&
    parsed?.net_total === 78 &&
    parsed.verification_marker === nonce &&
    Array.isArray(parsed.sources) &&
    parsed.sources.includes('figures.csv') &&
    parsed.sources.includes('adjustments.txt');
  report.protocol_events = events.map((e) => ({ id: e.id, type: e.type, time: e.time }));
  await writeFile(path.join(root, 'output.txt'), output, { flag: 'wx', mode: 0o600 });
} catch (error) {
  report.status = 'acceptance_error';
  report.error = { message: error instanceof Error ? error.message : String(error) };
} finally {
  if (responseId) {
    const run = gateway.store.run(responseId);
    if (['queued', 'in_progress', 'requires_action'].includes(run.status))
      await gateway.kernel.cancel(
        {
          owner: 'acceptance',
          name: 'acceptance-only',
          agents: ['agent/acceptance-agy'],
          scopes: ['invoke'],
        },
        responseId,
      );
  }
  await gateway.app.close();
  delete process.env.OAA_ACCEPTANCE_TOKEN;
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
process.stdout.write(
  JSON.stringify(
    {
      receipt: path.join(root, 'receipt.json'),
      status: report.status,
      semantic_pass: report.semantic_pass ?? false,
      elapsed_ms: report.elapsed_ms,
      error: report.error,
    },
    null,
    2,
  ) + '\n',
);
