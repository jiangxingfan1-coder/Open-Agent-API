import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { setup, agent, FixtureModel, waitFor } from './helpers.js';
import { capabilitySchema } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { createHash } from 'node:crypto';
import { RemoteExecutor } from '../src/fabric/network.js';

test('separate worker process executes a host-bound tool and transfers a 12 MiB artifact over certificate-verified WSS', async () => {
  const certDir = await mkdtemp(path.join(os.tmpdir(), 'oaa-tls-'));
  let s: Awaited<ReturnType<typeof setup>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    const key = path.join(certDir, 'key.pem'),
      cert = path.join(certDir, 'cert.pem'),
      conf = path.join(certDir, 'cert.cnf');
    await writeFile(
      conf,
      '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:true\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n',
    );
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-config',
      conf,
    ]);
    process.env.OAA_PROCESS_NODE = 'test-process-node-credential-123456789012345';
    const cap = capabilitySchema.parse({
      id: 'private/process-read',
      version: '1',
      description: 'An explicitly permitted source in a separate worker process.',
      placement: 'host-bound',
      nodeId: 'process-node',
      effect: 'read',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    });
    s = await setup(
      new FixtureModel((_a, m) => {
        const r = m.find((x) => x.role === 'tool');
        return r
          ? { text: JSON.parse(r.content).text }
          : { calls: [{ id: 'remote', name: 'source', arguments: { path: 'source.txt' } }] };
      }),
      {
        tls: { keyFile: key, certFile: cert },
        nodeKeys: [
          {
            nodeId: 'process-node',
            owner: 'owner',
            tokenEnv: 'OAA_PROCESS_NODE',
            agents: ['agent/test', 'agent/export'],
            capabilities: [cap.id, 'native/adapter/export'],
          },
        ],
      },
    );
    const url = await s.listen();
    await writeFile(path.join(s.dir, 'source.txt'), 'Certificate-verified WSS process result.');
    await writeFile(path.join(s.dir, 'node.token'), process.env.OAA_PROCESS_NODE, { mode: 0o600 });
    const cfg = {
      nodeId: 'process-node',
      owner: 'owner',
      dataDir: path.join(s.dir, 'child-worker'),
      gatewayUrl: url,
      tokenFile: path.join(s.dir, 'node.token'),
      adapters: {
        export: {
          transport: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [path.resolve('test/fixtures/large-native-output.mjs')],
        },
      },
      tools: [
        { reference: 'source', capability: cap, handler: { kind: 'read_directory', root: s.dir } },
      ],
    };
    const configFile = path.join(s.dir, 'worker.json');
    await writeFile(configFile, JSON.stringify(cfg), { mode: 0o600 });
    child = spawn(
      process.execPath,
      [path.resolve('dist/src/cli.js'), 'node', 'join', '--config', configFile],
      { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    exited = once(child, 'exit');
    await waitFor(() => s!.hub.nodes.has('process-node'), 10_000);
    assert.notEqual(child.pid, process.pid);
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          tools: [
            { name: 'source', capability: cap, handler: { kind: 'node', reference: 'source' } },
          ],
        }),
      ),
    );
    const response = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'Read source on the enrolled worker.',
    });
    assert.equal(response.json().status, 'completed', response.body);
    assert.match(response.json().output.at(-1).content[0].text, /Certificate-verified WSS/);
    assert.equal(s.store.steps(response.json().id)[0]?.nodeId, 'process-node');
    const remote = s.hub.nodes.get('process-node')!.executor;
    assert.ok(remote instanceof RemoteExecutor);
    let chunkBytes = 0,
      chunks = 0,
      manifests = 0;
    remote.socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'artifact_chunk') {
        chunks++;
        chunkBytes += Buffer.byteLength(msg.data, 'base64');
      }
      if (msg.type === 'result' && msg.result?.artifacts?.length) {
        const file = msg.result.artifacts[0];
        assert.equal(file.localPath, undefined);
        assert.equal(file.content, '');
        assert.equal(file.transferIndex, 0);
        manifests++;
      }
    });
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/export',
          engine: 'adapter/export',
          model: 'default',
          allowedNodes: ['process-node'],
        }),
      ),
    );
    const exported = await s.request('POST', '/v1/responses', {
      model: 'agent/export',
      input: 'Prepare the report.',
    });
    assert.equal(exported.json().status, 'completed', exported.body);
    const run = s.store.run(exported.json().id, 'owner');
    assert.equal(run.artifactIds.length, 1);
    assert.ok(chunks > 1);
    assert.equal(chunkBytes, 12 * 1024 * 1024);
    assert.equal(manifests, 1);
    const fetched = await s.request('GET', `/v1/files/${run.artifactIds[0]}/content`);
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.rawPayload.length, chunkBytes);
    assert.equal(
      createHash('sha256').update(fetched.rawPayload).digest('hex'),
      createHash('sha256').update(Buffer.alloc(chunkBytes, 55)).digest('hex'),
    );
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 2500);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    await s?.cleanup();
    await rm(certDir, { recursive: true, force: true });
    delete process.env.OAA_PROCESS_NODE;
  }
});
