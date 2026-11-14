import { parseArgs } from 'node:util';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { workerSchema, gatewaySchema } from '../src/config/config.js';
import { buildBundle } from '../src/lang/bundle.js';
import { prepareMcp, withToolConfigs } from '../src/fabric/tool-import.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { createGateway } from '../src/gateway/server.js';
import { GatewayClient } from '../src/client/client.js';
import { sha } from '../src/core/util.js';
import { FixtureModel } from '../test/helpers.js';

const { values } = parseArgs({ options: { skill: { type: 'string' }, out: { type: 'string' } } });
if (!values.skill || !values.out)
  throw new Error('Use --skill EXPLICIT_DIRECTORY --out NEW_DIRECTORY. No live model is called.');
const root = path.resolve(values.out);
await mkdir(root, { recursive: true, mode: 0o700 });
const guard = await open(path.join(root, 'acceptance-reserved'), 'wx', 0o600);
await guard.close();
const selectedSource = path.resolve('src/fabric/mcp-connections.ts');
process.env.OAA_MCP_FIXTURE_SOURCE = selectedSource;
process.env.OAA_MCP_FIXTURE_AUDIT = path.join(root, 'mcp-audit.jsonl');
process.env.OAA_LOCAL_CAPABILITY_TOKEN = randomBytes(32).toString('base64url');
const worker = workerSchema.parse({
  nodeId: 'selected-local',
  owner: 'local-acceptance',
  dataDir: path.join(root, 'worker'),
  mcp: {
    selected_reader: {
      transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('../test/fixtures/mcp-tool-server.js', import.meta.url))],
      envNames: ['OAA_MCP_FIXTURE_SOURCE', 'OAA_MCP_FIXTURE_AUDIT'],
    },
  },
});
const prepared = await prepareMcp(worker, {
  server: 'selected_reader',
  tool: 'read_note',
  capability: 'private/selected-source',
  effect: 'read',
  approval: 'none',
  exportResult: true,
  out: path.join(root, 'prepared'),
});
const definition = path.join(root, 'agent.json');
await writeFile(
  definition,
  JSON.stringify(
    {
      id: 'agent/local-capability-check',
      description:
        'Local-only deterministic wiring check for an explicitly selected skill and source reader.',
      engine: 'kernel',
      provider: 'fixture',
      model: 'fixture',
      allowedNodes: ['selected-local'],
      instructions:
        'Read the selected skill and source. Produce a wiring-verification artifact only; do not claim a model quality evaluation. Do not expand referenced archives or use external services.',
      tools: ['write_file'],
      files: [],
    },
    null,
    2,
  ),
  { flag: 'wx', mode: 0o600 },
);
const bundle = await buildBundle(definition, [values.skill], [prepared.binding]);
await writeFile(path.join(root, 'bundle.json'), JSON.stringify(bundle, null, 2), {
  flag: 'wx',
  mode: 0o600,
});
const skill = bundle.agent.skills[0]!;
const reference = bundle.files.find(
  (file) => file.path.startsWith(`skills/${skill.name}/references/`) && file.path.endsWith('.md'),
);
const model = new FixtureModel((_agent, messages) => {
  const result = (callId: string) =>
    messages.find((message) => message.role === 'tool' && message.tool_call_id === callId);
  if (!result('skill'))
    return {
      usage: null,
      calls: [
        { id: 'skill', name: 'read_skill', arguments: { path: skill.path } },
        { id: 'source', name: 'read_note', arguments: { key: 'selected' } },
      ],
    };
  if (reference && !result('reference'))
    return {
      usage: null,
      calls: [{ id: 'reference', name: 'read_skill', arguments: { path: reference.path } }],
    };
  if (!result('report')) {
    const loaded = JSON.parse(result('skill')!.content) as { text: string };
    const source = JSON.parse(result('source')!.content) as { note: string };
    const content = {
      evidence: 'local deterministic protocol check, not model quality',
      skill: skill.name,
      loaded_skill_sha256: sha(loaded.text),
      selected_source_sha256: sha(source.note),
      reference: reference
        ? {
            path: reference.path,
            sha256: sha((JSON.parse(result('reference')!.content) as { text: string }).text),
          }
        : null,
      package_files: bundle.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        bytes: Buffer.from(file.content, 'base64').length,
      })),
      external_archives_expanded: false,
      live_model_calls: 0,
    };
    return {
      usage: null,
      calls: [
        {
          id: 'report',
          name: 'write_file',
          arguments: { path: 'capability-check.json', content: JSON.stringify(content, null, 2) },
        },
      ],
    };
  }
  return {
    usage: null,
    text: 'Selected skill and host-bound source reader verified. Local fixture only; no live model was called.',
  };
});
const runtime = new WorkerRuntime(
  await withToolConfigs(worker, [prepared.worker_tool]),
  new Map(),
  new Map([['fixture', model]]),
);
const gateway = await createGateway(
  gatewaySchema.parse({
    dataDir: path.join(root, 'gateway'),
    port: 0,
    localWorker: runtime.config,
    keys: [
      {
        name: 'local-capability-only',
        owner: 'local-acceptance',
        tokenEnv: 'OAA_LOCAL_CAPABILITY_TOKEN',
        agents: [bundle.agent.id],
        scopes: ['admin', 'invoke', 'read', 'files'],
      },
    ],
  }),
  runtime,
);
try {
  const url = await gateway.listen();
  const client = new GatewayClient(url, process.env.OAA_LOCAL_CAPABILITY_TOKEN);
  await client.request('POST', '/v1/agents/publish', bundle);
  const run = await client.request<{ id: string }>(
    'POST',
    '/v1/invoke',
    {
      agent: bundle.agent.id,
      agent_version: bundle.digest,
      input: 'Verify the selected local capability package.',
      background: true,
    },
    { idempotencyKey: 'selected-local-check' },
  );
  const state = await client.request<{ status: string; error: unknown }>(
    'GET',
    `/v1/runs/${run.id}/wait?timeout_ms=25000`,
  );
  if (state.status !== 'completed')
    throw new Error(`Local check did not complete: ${JSON.stringify(state.error)}`);
  const artifacts = await client.request<{ data: { id: string }[] }>(
    'GET',
    `/v1/runs/${run.id}/artifacts`,
  );
  const bytes = await client.download(artifacts.data[0]!.id);
  await writeFile(path.join(root, 'capability-check.json'), bytes, { flag: 'wx', mode: 0o600 });
  const evidence = JSON.parse(bytes.toString('utf8'));
  if (
    evidence.loaded_skill_sha256 !==
      bundle.files.find((file) => file.path === skill.path)!.sha256 ||
    evidence.selected_source_sha256 !== sha(await readFile(selectedSource))
  )
    throw new Error('The observed data did not match the explicitly selected sources.');
  const receipt = {
    recorded_at: new Date().toISOString(),
    source_skill: path.resolve(values.skill),
    selected_source: selectedSource,
    response_id: run.id,
    status: state.status,
    version: bundle.digest,
    skill_files: bundle.files.length,
    skill_bytes: bundle.files.reduce(
      (sum, file) => sum + Buffer.from(file.content, 'base64').length,
      0,
    ),
    source_digests_match: true,
    live_model_calls: 0,
    fixture_turns: model.calls,
    main_gateway_configuration_changed: false,
    global_skill_modified: false,
    external_resource_archives_expanded: false,
    boundary:
      'Host-bound local check. Referenced personal archive paths are not resolved or copied; this does not prove live model skill quality or a third-party MCP account integration.',
  };
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({ receipt: path.join(root, 'receipt.json'), ...receipt }, null, 2) + '\n',
  );
} finally {
  await gateway.app.close();
  delete process.env.OAA_LOCAL_CAPABILITY_TOKEN;
  delete process.env.OAA_MCP_FIXTURE_SOURCE;
  delete process.env.OAA_MCP_FIXTURE_AUDIT;
}
