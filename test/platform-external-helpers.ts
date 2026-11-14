import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { createGateway } from '../src/gateway/server.js';
import { makeBundle } from '../src/lang/bundle.js';
import { FixtureModel, agent, principal, token } from './helpers.js';

// Shared by the platform external-agent tests (not a test file itself).

const SAMPLE = path.resolve('examples/sample-agent.mjs');
type Gateway = Awaited<ReturnType<typeof createGateway>>;
export type Ctx = { gw: Gateway; dir: string; worker: ReturnType<typeof workerSchema.parse> };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export async function withExternal(
  fn: (c: Ctx) => Promise<void>,
  platform: Record<string, unknown> = {},
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-platform-ext-'));
  const worker = workerSchema.parse({
    nodeId: 'local',
    dataDir: path.join(dir, 'worker'),
    adapters: {
      'oaa-sample': {
        transport: 'acp',
        command: process.execPath,
        args: [SAMPLE],
        enabled: true,
      },
    },
  });
  const runtime = new WorkerRuntime(worker, new Map(), new Map([['fixture', new FixtureModel()]]));
  process.env.OAA_TEST_TOKEN = token;
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    port: 0,
    keys: [{ name: 'test', owner: 'owner', tokenEnv: 'OAA_TEST_TOKEN', scopes: principal.scopes }],
    localWorker: worker,
    approvalTimeoutMs: 20_000,
    platform: { owner: 'owner', registration: 'open', ...platform },
  });
  const gw = await createGateway(config, runtime);
  await gw.app.ready();
  try {
    gw.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/sample',
          engine: 'adapter/oaa-sample',
          provider: 'native',
          model: 'default',
          instructions: '',
          routes: [{ id: 'default', provider: 'native', model: 'default', priority: 0 }],
        }),
      ),
    );
    gw.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/boss', delegates: [{ name: 'ask_sample', agent: 'agent/sample' }] }),
      ),
    );
    await fn({ gw, dir, worker });
  } finally {
    await gw.app.close();
    await rm(dir, { recursive: true, force: true });
  }
}
export function call(c: Ctx, method: Method, url: string, payload?: unknown, bearer = token) {
  return c.gw.app.inject({
    method,
    url,
    payload: payload as never,
    headers: { authorization: `Bearer ${bearer}` },
  });
}
export const listing = async (c: Ctx, body: Record<string, unknown>) => {
  const r = await call(c, 'PUT', '/v1/platform/listings', body);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
/** Signs a developer up through the portal, redeems `credits` and creates an account key. */
export async function developer(c: Ctx, credits: number, email = 'dev@x.io') {
  const signup = await call(c, 'POST', '/v1/portal/signup', { email, password: 'password1' }, '');
  assert.equal(signup.statusCode, 201, signup.body);
  const session = signup.json().session.token as string;
  if (credits > 0) await redeem(c, session, credits);
  const key = await call(c, 'POST', '/v1/portal/keys', { name: 'k' }, session);
  assert.equal(key.statusCode, 201, key.body);
  return { session, key: key.json().token as string, id: signup.json().account.id as string };
}
export async function redeem(c: Ctx, session: string, credits: number) {
  const codes = await call(c, 'POST', '/v1/platform/codes', { kind: 'credit', credits });
  assert.equal(codes.statusCode, 201, codes.body);
  const r = await call(
    c,
    'POST',
    '/v1/portal/redeem',
    { code: codes.json().data[0].code },
    session,
  );
  assert.equal(r.statusCode, 200, r.body);
}
export const balance = async (c: Ctx, session: string) =>
  (await call(c, 'GET', '/v1/portal/account', undefined, session)).json().account.balance as number;
export const chat = (c: Ctx, key: string, model = 'agent/sample', content = 'hello') =>
  call(c, 'POST', '/v1/chat/completions', { model, messages: [{ role: 'user', content }] }, key);
export const auditRows = async (c: Ctx) =>
  ((await call(c, 'GET', '/v1/audit?limit=200')).json().data as Record<string, unknown>[]).filter(
    (e) => e.code === 'platform_listing_host_execution',
  );
