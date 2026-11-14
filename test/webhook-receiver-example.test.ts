// The approval loop of docs/webhooks.md end to end, at zero cost: a gateway on a 127.0.0.1
// ephemeral port with the offline sample agent, examples/webhook-receiver.mjs as the receiver, and
// a task containing "approve". The receiver approves through the API only with --auto-approve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gatewaySchema } from '../src/config/config.js';
import { createGateway } from '../src/gateway/server.js';
import { GatewayClient } from '../src/client/client.js';
import { sampleDefinition } from '../src/client/quickstart.js';
import { makeBundle } from '../src/lang/bundle.js';
import { sampleScript } from './cli-helpers.js';
import { token, waitFor } from './helpers.js';

async function gatewayWithSample(dir: string) {
  process.env.OAA_WEBHOOK_EXAMPLE_TOKEN = token;
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    host: '127.0.0.1',
    port: 0,
    approvalTimeoutMs: 30_000,
    keys: [
      {
        name: 'owner',
        owner: 'owner',
        tokenEnv: 'OAA_WEBHOOK_EXAMPLE_TOKEN',
        scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      },
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
  const address = await gateway.listen();
  const client = new GatewayClient(address, token);
  await client.request('POST', '/v1/agents/publish', makeBundle(sampleDefinition()));
  return { gateway, address, client };
}

function startReceiver(args: string[]) {
  const child = spawn(process.execPath, ['examples/webhook-receiver.mjs', ...args], {
    env: { ...process.env, OAA_LOCALE: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout!.setEncoding('utf8').on('data', (s: string) => output.push(s));
  child.stderr!.setEncoding('utf8').on('data', (s: string) => output.push(s));
  return { child, text: () => output.join('') };
}
const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });

for (const autoApprove of [true, false])
  test(`webhook receiver example: ${autoApprove ? 'approves with --auto-approve' : 'only prints without --auto-approve'}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-webhook-example-'));
    const { gateway, address, client } = await gatewayWithSample(dir);
    let receiver: ReturnType<typeof startReceiver> | undefined;
    try {
      const created = await client.request<{ id: string; secret: string }>('POST', '/v1/webhooks', {
        // The receiver's port is not known yet; the endpoint is pointed at it below.
        url: 'http://127.0.0.1:9/',
        events: ['run.requires_action', 'run.completed', 'run.failed'],
      });
      await writeFile(path.join(dir, 'webhook.secret'), created.secret);
      await writeFile(path.join(dir, 'admin.token'), token);
      receiver = startReceiver([
        '--port',
        '0',
        '--secret-file',
        path.join(dir, 'webhook.secret'),
        '--gateway',
        address,
        '--token-file',
        path.join(dir, 'admin.token'),
        ...(autoApprove ? ['--auto-approve'] : []),
      ]);
      await waitFor(() => /Receiver ready: (http:\S+)/.test(receiver!.text()), 10_000);
      const url = /Receiver ready: (http:\S+)/.exec(receiver.text())![1]!;
      await client.request('PATCH', `/v1/webhooks/${created.id}`, { url });

      const run = await client.request<{ id: string }>('POST', '/v1/invoke', {
        protocol: 'oaa/1',
        agent: 'agent/sample',
        input: 'please approve writing the note',
        background: true,
      });
      await waitFor(() => receiver!.text().includes('run.requires_action'), 15_000);
      if (autoApprove) {
        await waitFor(() => receiver!.text().includes(`run.completed  ${run.id}`), 20_000);
        assert.match(receiver.text(), /approved approval_/);
      } else {
        await waitFor(() => receiver!.text().includes('not approved'), 10_000);
        const state = await client.request<{ status: string }>('GET', `/v1/runs/${run.id}`);
        assert.equal(state.status, 'requires_action');
        await client.request('POST', `/v1/responses/${run.id}/cancel`);
      }
      assert.match(
        receiver.text(),
        new RegExp(`run\\.requires_action {2}${run.id} {2}agent/sample {2}requires_action`),
      );
      assert.match(
        receiver.text(),
        /pending approval_\S+ {2}native {2}.*Write outputs\/sample-note\.txt/,
      );
      process.stdout.write(
        `--- receiver output (${autoApprove ? 'auto-approve' : 'print only'}) ---\n${receiver.text()}`,
      );
    } finally {
      if (receiver) await stop(receiver.child);
      await gateway.app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
