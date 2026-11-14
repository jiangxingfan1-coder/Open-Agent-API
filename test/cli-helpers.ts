import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gatewaySchema } from '../src/config/config.js';
import { createGateway } from '../src/gateway/server.js';
import { GatewayClient } from '../src/client/client.js';
import { sampleDefinition } from '../src/client/quickstart.js';
import { makeBundle } from '../src/lang/bundle.js';
import { token } from './helpers.js';

// Shared by the CLI command tests: a gateway with the offline sample agent, reached through
// `app.inject` by routing the global fetch to it (no port is opened). Restored when the test ends.

export const BASE = 'http://127.0.0.1:9';
export const callerToken = 'test-caller-key-not-a-provider-credential-0000001';
export const sampleScript = path.resolve('examples/sample-agent.mjs');

export type InjectedGateway = Awaited<ReturnType<typeof injectedGateway>>;

export async function injectedGateway(
  t: test.TestContext,
  options: { approvalTimeoutMs?: number; extraKeys?: Record<string, unknown>[] } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-cli-'));
  process.env.OAA_CLI_TEST_TOKEN = token;
  process.env.OAA_CLI_CALLER_TOKEN = callerToken;
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    port: 0,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 30_000,
    keys: [
      {
        name: 'owner',
        owner: 'owner',
        tokenEnv: 'OAA_CLI_TEST_TOKEN',
        scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      },
      // A caller key: may run and read agents but may not decide approvals.
      {
        name: 'caller',
        owner: 'owner',
        tokenEnv: 'OAA_CLI_CALLER_TOKEN',
        scopes: ['invoke', 'read'],
      },
      ...(options.extraKeys ?? []),
    ],
    localWorker: {
      nodeId: 'local',
      dataDir: path.join(dir, 'worker'),
      adapters: {
        'oaa-sample': {
          transport: 'acp',
          command: process.execPath,
          args: [sampleScript],
          enabled: true,
        },
      },
    },
  });
  const gateway = await createGateway(config);
  await gateway.app.ready();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await gateway.app.inject({
      method: (init.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      payload: typeof init.body === 'string' ? init.body : undefined,
    });
    // A 204 answer must not carry a body (the Response constructor rejects one).
    return new Response(response.statusCode === 204 ? null : response.body, {
      status: response.statusCode,
      headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') },
    });
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await gateway.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const admin = new GatewayClient(BASE, token);
  await admin.request('POST', '/v1/agents/publish', makeBundle(sampleDefinition()));
  return { gateway, dir, admin, caller: new GatewayClient(BASE, callerToken), config };
}

export async function until(
  check: () => Promise<boolean> | boolean,
  ms = 10_000,
  step = 25,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  throw new Error('condition not met in time');
}
