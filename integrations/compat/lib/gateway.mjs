// Starts an isolated Open Agent API gateway for the compatibility lab: 127.0.0.1 on a random port,
// a throw-away data directory, three published agents and one caller key. It calls no model service:
// `agent/sample` is the offline sample agent and `agent/fixture` is driven by the deterministic
// fixture model. Needs `npm run build` first (it imports the compiled gateway from dist/).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FixtureModel, TextOnlyModel } from './fixture-model.mjs';

// COMPAT_GATEWAY_ROOT: run the lab against another build of the gateway (for example an older
// release, to see which findings a fix closed). Default: this checkout.
const REPO = process.env.COMPAT_GATEWAY_ROOT ?? path.resolve(import.meta.dirname, '..', '..', '..');
const OWN = path.resolve(import.meta.dirname, '..', '..', '..');
const load = (p) => import(pathToFileURL(path.join(REPO, 'dist', p)).href);

export async function startLabGateway(options = {}) {
  const [{ gatewaySchema, workerSchema }, { WorkerRuntime }, { createGateway }, bundle, contracts, keys] =
    await Promise.all([
      load('src/config/config.js'),
      load('src/fabric/worker.js'),
      load('src/gateway/server.js'),
      load('src/lang/bundle.js'),
      load('src/core/contracts.js'),
      load('src/gateway/api-key.js'),
    ]);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-compat-'));
  const token = keys.generateApiKey();
  const tokenEnv = 'OAA_COMPAT_LAB_TOKEN';
  // Only this process sees the variable; the lab never changes the environment of the machine.
  process.env[tokenEnv] = token;
  // The deterministic answer for a response-format instruction comes from the replay engine (dist/test).
  const { answerForRequirement } = await import(
    pathToFileURL(path.join(OWN, 'dist', 'test', 'compat-replay.js')).href
  );
  const model = new FixtureModel(answerForRequirement);
  const workerConfig = workerSchema.parse({
    nodeId: 'local',
    dataDir: path.join(dir, 'worker'),
    adapters: {
      'oaa-sample': {
        transport: 'acp',
        command: process.execPath,
        args: [path.join(REPO, 'examples', 'sample-agent.mjs')],
        enabled: true,
      },
      // ACP stand-in that calls the caller's tools through the MCP relay (a scripted prompt decides which).
      'oaa-caller': {
        transport: 'acp',
        command: process.execPath,
        args: [path.join(REPO, 'test', 'fixtures', 'acp-caller-agent.mjs')],
        enabled: true,
      },
    },
  });
  const runtime = new WorkerRuntime(
    workerConfig,
    new Map(),
    new Map([
      ['fixture', model],
      ['fixture-text', new TextOnlyModel()],
    ]),
  );
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    host: '127.0.0.1',
    port: 0,
    keys: [
      {
        name: 'compat-lab',
        owner: 'owner',
        tokenEnv,
        scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      },
    ],
    localWorker: workerConfig,
    approvalTimeoutMs: 5000,
    // Browser-direct clients (Chatbox web, NextChat custom endpoint, ...) need their Origin allowed.
    allowedOrigins: options.allowedOrigins ?? [],
  });
  const gateway = await createGateway(config, runtime);
  const { store, app } = gateway;
  store.publish(
    'owner',
    bundle.makeBundle(
      contracts.agentSchema.parse({
        id: 'agent/sample',
        description: 'Offline sample agent (calls no model).',
        engine: 'adapter/oaa-sample',
        provider: 'native',
        model: 'default',
        instructions: '',
        tools: [],
        allowGraph: false,
        routes: [{ id: 'default', provider: 'native', model: 'default', priority: 0 }],
      }),
    ),
  );
  store.publish(
    'owner',
    bundle.makeBundle(
      contracts.agentSchema.parse({
        id: 'agent/fixture',
        description: 'Deterministic fixture agent for the compatibility lab (no model service).',
        instructions: 'You are the compatibility lab fixture agent.',
        model: 'fixture',
        provider: 'fixture',
      }),
    ),
  );
  store.publish(
    'owner',
    bundle.makeBundle(
      contracts.agentSchema.parse({
        id: 'agent/acp',
        description: 'ACP stand-in agent that calls the caller tools (no model, no network).',
        engine: 'adapter/oaa-caller',
        provider: 'native',
        model: 'default',
        instructions: '',
        tools: [],
        allowGraph: false,
        routes: [{ id: 'default', provider: 'native', model: 'default', priority: 0 }],
      }),
    ),
  );
  // An agent that runs its own tool loop (a native engine that is not enabled here, so it never starts):
  // it cannot take caller tools over, which the lab uses to check the refusal. 
  store.publish(
    'owner',
    bundle.makeBundle(
      contracts.agentSchema.parse({
        id: 'agent/native',
        description: 'Stand-in for an agent that runs its own tool loop (never started).',
        engine: 'codex',
        provider: 'native',
        model: 'default',
        instructions: '',
        tools: [],
        allowGraph: false,
        routes: [{ id: 'default', provider: 'native', model: 'default', priority: 0 }],
      }),
    ),
  );
  store.publish(
    'owner',
    bundle.makeBundle(
      contracts.agentSchema.parse({
        id: 'agent/text-only',
        description: 'Fixture agent without image input (images are refused clearly).',
        instructions: 'You are the compatibility lab text-only fixture agent.',
        model: 'fixture',
        provider: 'fixture-text',
      }),
    ),
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: token,
    agents: { sample: 'agent/sample', fixture: 'agent/fixture', native: 'agent/native', acp: 'agent/acp', textOnly: 'agent/text-only' },
    store,
    model,
    async stop() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
      delete process.env[tokenEnv];
    },
  };
}
