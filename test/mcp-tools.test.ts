import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { workerSchema, type WorkerConfig } from '../src/config/config.js';
import { McpConnections, findMcpTool } from '../src/fabric/mcp-connections.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import {
  inspectMcp,
  prepareMcp,
  preparedTool,
  withToolConfigs,
} from '../src/fabric/tool-import.js';
import { JsonSchemas } from '../src/core/schemas.js';
import { buildBundle, makeBundle, assertPublishableMetadata } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { toolPlacement } from '../src/fabric/placement.js';
import { Fault, sha, sleep } from '../src/core/util.js';
import { agent, FixtureModel, setup, principal, waitFor, token } from './helpers.js';

const fixtureServer = path.resolve('dist/test/fixtures/mcp-tool-server.js');
const exec = promisify(execFile);
async function configuration(dir: string): Promise<WorkerConfig> {
  process.env.OAA_MCP_FIXTURE_AUDIT = path.join(dir, 'audit.jsonl');
  process.env.OAA_MCP_FIXTURE_SOURCE = path.join(dir, 'selected-note.txt');
  process.env.OAA_MCP_FIXTURE_SECRET = 'fixture-secret-not-a-real-account-credential';
  delete process.env.OAA_MCP_FIXTURE_DESCRIPTION;
  await writeFile(process.env.OAA_MCP_FIXTURE_SOURCE, 'Explicitly selected MCP source note.');
  return workerSchema.parse({
    nodeId: 'local',
    owner: 'owner',
    dataDir: path.join(dir, 'worker'),
    mcp: {
      selected: {
        transport: 'stdio',
        command: process.execPath,
        args: [fixtureServer],
        envNames: [
          'OAA_MCP_FIXTURE_AUDIT',
          'OAA_MCP_FIXTURE_SOURCE',
          'OAA_MCP_FIXTURE_SECRET',
          'OAA_MCP_FIXTURE_DESCRIPTION',
        ],
      },
    },
  });
}
async function audit(dir: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(path.join(dir, 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
const result = (value: unknown) => CallToolResultSchema.parse(value).structuredContent!;
const scope = { owner: 'owner', sessionId: 'session-one', digest: 'version-one' };

test('MCP connections reuse a session but isolate versions, sessions and owners', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-mcp-isolation-'));
  const config = await configuration(dir);
  const pool = new McpConnections(config);
  try {
    const invoke = (context: typeof scope, name: string, args: Record<string, unknown> = {}) =>
      pool.use('selected', context, AbortSignal.timeout(5000), async (client) =>
        result(await client.callTool({ name, arguments: args })),
      );
    const first = await invoke(scope, 'set_context', { value: 'private session content' });
    const same = await invoke({ ...scope }, 'get_context');
    assert.equal(same.context, 'private session content');
    assert.equal(same.process, first.process);
    const other = await invoke({ ...scope, sessionId: 'session-two' }, 'get_context');
    const version = await invoke({ ...scope, digest: 'version-two' }, 'get_context');
    assert.equal(other.context, '');
    assert.equal(version.context, '');
    assert.notEqual(other.process, first.process);
    assert.notEqual(version.process, first.process);
    const startsBefore = (await audit(dir)).filter((e) => e.event === 'start').length;
    await assert.rejects(
      () => invoke({ ...scope, owner: 'other' }, 'get_context'),
      /owner does not match/,
    );
    assert.equal((await audit(dir)).filter((e) => e.event === 'start').length, startsBefore);
    await assert.rejects(
      () => pool.use('toString', scope, AbortSignal.timeout(5000), async () => {}),
      /not configured/,
    );
  } finally {
    await pool.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('one MCP domain error does not close another parallel call on the shared session', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-mcp-parallel-'));
  const config = await configuration(dir);
  const inspected = await inspectMcp(config, 'selected', { tool: 'slow' });
  assert.ok('descriptor' in inspected);
  const slow = preparedTool(config, inspected.descriptor as Tool, {
    server: 'selected',
    tool: 'slow',
    capability: 'private/slow',
    out: 'unused',
    effect: 'read',
    approval: 'none',
    exportResult: true,
  });
  const failed = await inspectMcp(config, 'selected', { tool: 'fail' });
  assert.ok('descriptor' in failed);
  const fail = preparedTool(config, failed.descriptor as Tool, {
    server: 'selected',
    tool: 'fail',
    capability: 'private/fail',
    out: 'unused',
    effect: 'read',
    approval: 'none',
    exportResult: true,
  });
  config.tools.push(slow.workerTool, fail.workerTool);
  const runtime = new WorkerRuntime(config);
  try {
    const bundle = makeBundle(agent({ tools: [slow.binding, fail.binding] }));
    await runtime.install(bundle);
    const context = { ...scope, runId: 'run-parallel', digest: bundle.digest, files: [] };
    const running = runtime.execute(
      { kind: 'tool', binding: slow.binding, arguments: {}, context },
      AbortSignal.timeout(5000),
      async () => {},
    );
    await waitFor(async () =>
      (await audit(dir)).some((e) => e.event === 'call' && e.name === 'slow'),
    );
    await assert.rejects(
      () =>
        runtime.execute(
          { kind: 'tool', binding: fail.binding, arguments: {}, context },
          AbortSignal.timeout(5000),
          async () => {},
        ),
      /isError/,
    );
    const success = await running;
    assert.ok('value' in success);
    const log = await audit(dir);
    assert.ok(log.some((e) => e.event === 'result' && e.name === 'slow'));
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP credential rotation retires warm clients without aborting accepted calls; missing credentials fail closed', async () => {
  const gate = Promise.withResolvers<void>();
  let slowStarted = false;
  const observed: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const part of request) body += part;
    const message = JSON.parse(body);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let value: unknown;
    if (message.method === 'initialize')
      value = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'owned-http-fixture', version: '1' },
      };
    else {
      const credential = sha(String(request.headers.authorization));
      observed.push(credential);
      if (message.params?.name === 'slow') {
        slowStarted = true;
        await gate.promise;
      }
      value = { structuredContent: { credential }, content: [{ type: 'text', text: credential }] };
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: value }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OAA_MCP_HTTP_CREDENTIAL = 'fixture-first-credential';
  const config = workerSchema.parse({
    nodeId: 'local',
    dataDir: os.tmpdir(),
    mcp: {
      http: {
        transport: 'http',
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tokenEnv: 'OAA_MCP_HTTP_CREDENTIAL',
      },
    },
  });
  const pool = new McpConnections(config);
  try {
    const first = pool.use('http', scope, AbortSignal.timeout(5000), async (client) =>
      result(await client.callTool({ name: 'slow', arguments: {} })),
    );
    await waitFor(() => slowStarted);
    process.env.OAA_MCP_HTTP_CREDENTIAL = 'fixture-second-credential';
    const second = await pool.use('http', scope, AbortSignal.timeout(5000), async (client) =>
      result(await client.callTool({ name: 'identity', arguments: {} })),
    );
    assert.equal(second.credential, sha('Bearer fixture-second-credential'));
    delete process.env.OAA_MCP_HTTP_CREDENTIAL;
    const requests = observed.length;
    await assert.rejects(
      () => pool.use('http', scope, AbortSignal.timeout(5000), async () => {}),
      /credential environment reference/,
    );
    assert.equal(observed.length, requests);
    gate.resolve();
    assert.equal((await first).credential, sha('Bearer fixture-first-credential'));
  } finally {
    gate.resolve();
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.OAA_MCP_HTTP_CREDENTIAL;
  }
});

test('selected MCP preparation is non-executing, conservative and omits connection credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-mcp-prepare-'));
  const config = await configuration(dir);
  try {
    const out = path.join(dir, 'prepared');
    const prepared = await prepareMcp(config, {
      server: 'selected',
      tool: 'read_note',
      capability: 'private/note',
      out,
    });
    const binding = JSON.parse(await readFile(prepared.binding, 'utf8'));
    const overlay = JSON.parse(await readFile(prepared.worker_tool, 'utf8'));
    assert.equal(binding.capability.effect, 'unknown');
    assert.equal(binding.capability.requiresApproval, true);
    assert.equal(binding.capability.resultExport, false);
    assert.equal(binding.required, true);
    assert.equal(
      binding.capability.inputSchema.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
    assert.ok(!JSON.stringify(binding).includes(process.env.OAA_MCP_FIXTURE_SECRET!));
    assert.ok(!JSON.stringify(binding).includes(fixtureServer));
    assert.equal(overlay.handler.server, 'selected');
    assert.ok(overlay.handler.descriptorSha256);
    assert.equal(
      (await audit(dir)).some((e) => e.event === 'call'),
      false,
    );
    const untouched = JSON.stringify(config);
    const merged = await withToolConfigs(config, [prepared.worker_tool]);
    assert.equal(JSON.stringify(config), untouched);
    assert.equal(merged.tools.length, 1);
    await assert.rejects(() => withToolConfigs(merged, [prepared.worker_tool]), /duplicates/);
    await assert.rejects(
      () => withToolConfigs({ ...config, nodeId: 'other' }, [prepared.worker_tool]),
      /different worker/,
    );
    const startsBefore = (await audit(dir)).filter((e) => e.event === 'start').length;
    await assert.rejects(
      () =>
        prepareMcp(config, {
          server: 'selected',
          tool: 'read_note',
          capability: 'private/note',
          out,
        }),
      /already exists/,
    );
    assert.equal((await audit(dir)).filter((e) => e.event === 'start').length, startsBefore);
    assert.equal(
      (await audit(dir)).some((e) => e.event === 'call'),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prepared tool metadata drift is rejected before a tool call, without silently choosing another tool', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-mcp-drift-'));
  const config = await configuration(dir);
  let runtime: WorkerRuntime | undefined;
  try {
    const prepared = await prepareMcp(config, {
      server: 'selected',
      tool: 'read_note',
      capability: 'private/note',
      out: path.join(dir, 'prepared'),
      effect: 'read',
      approval: 'none',
      exportResult: true,
    });
    const binding = JSON.parse(await readFile(prepared.binding, 'utf8'));
    const merged = await withToolConfigs(config, [prepared.worker_tool]);
    process.env.OAA_MCP_FIXTURE_DESCRIPTION = 'Changed descriptor requires a reviewed publication.';
    runtime = new WorkerRuntime(merged);
    const bundle = makeBundle(agent({ tools: [binding] }));
    await runtime.install(bundle);
    await assert.rejects(
      () =>
        runtime!.execute(
          {
            kind: 'tool',
            binding,
            arguments: { key: 'selected' },
            context: { ...scope, runId: 'drift', digest: bundle.digest, files: [] },
          },
          AbortSignal.timeout(5000),
          async () => {},
        ),
      (e) => e instanceof Fault && e.code === 'mcp_tool_changed',
    );
    assert.equal(
      (await audit(dir)).some((e) => e.event === 'call'),
      false,
    );
  } finally {
    delete process.env.OAA_MCP_FIXTURE_DESCRIPTION;
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI-selected MCP binding reaches the same kernel execution and never copies its private server config', async () => {
  const s = await setup(
    new FixtureModel((_a, m) =>
      m.some((v) => v.role === 'tool')
        ? { text: m.find((v) => v.role === 'tool')!.content }
        : { calls: [{ id: 'lookup', name: 'read_note', arguments: { key: 'selected' } }] },
    ),
  );
  try {
    const config = await configuration(s.dir);
    const workerFile = path.join(s.dir, 'worker.json');
    await writeFile(workerFile, JSON.stringify(config), { mode: 0o600 });
    const out = path.join(s.dir, 'prepared');
    const generated = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            path.resolve('dist/src/cli.js'),
            'mcp',
            'prepare',
            '--config',
            workerFile,
            '--server',
            'selected',
            '--tool',
            'read_note',
            '--capability',
            'private/note',
            '--effect',
            'read',
            '--approval',
            'none',
            '--export-result',
            '--out',
            out,
          ],
          { env: process.env },
        )
      ).stdout,
    );
    const definition = path.join(s.dir, 'agent.json');
    await writeFile(definition, JSON.stringify(agent()));
    const built = path.join(s.dir, 'bundle.json');
    await exec(process.execPath, [
      path.resolve('dist/src/cli.js'),
      'build',
      definition,
      '--tool-binding',
      generated.binding,
      '--out',
      built,
    ]);
    const bundle = await buildBundle(definition, [], [generated.binding]);
    const merged = await withToolConfigs(config, [generated.worker_tool]);
    s.runtime.config.mcp = merged.mcp;
    s.runtime.config.tools = merged.tools;
    assert.ok(!JSON.stringify(bundle).includes(process.env.OAA_MCP_FIXTURE_SECRET!));
    assert.ok(!JSON.stringify(bundle).includes('envNames'));
    const url = await s.listen();
    const tokenFile = path.join(s.dir, 'publish.token');
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(
      definition,
      JSON.stringify(
        agent({ instructions: 'Changed after review; must not replace the reviewed bundle.' }),
      ),
    );
    const publication = JSON.parse(
      (
        await exec(process.execPath, [
          path.resolve('dist/src/cli.js'),
          'publish-bundle',
          built,
          '--url',
          url,
          '--token-file',
          tokenFile,
        ])
      ).stdout,
    );
    assert.equal(publication.version, bundle.digest);
    assert.equal(
      s.store.bundle('owner', 'agent/test').agent.instructions,
      bundle.agent.instructions,
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'Read the selected note.' }),
    );
    const done = await s.kernel.wait(run.id);
    assert.equal(done.status, 'completed');
    assert.match(done.output.at(-1)!.text, /Explicitly selected MCP source note/);
    assert.equal(s.store.steps(run.id)[0]!.nodeId, 'local');
    assert.equal((await audit(s.dir)).filter((e) => e.event === 'call').length, 1);
  } finally {
    await s.cleanup();
  }
});

test('connection retirement bounds idle servers and does not close active leases early', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-mcp-idle-'));
  const config = await configuration(dir);
  const pool = new McpConnections(config, 40, 1);
  const gate = Promise.withResolvers<void>();
  try {
    let active = false;
    const using = pool.use('selected', scope, AbortSignal.timeout(5000), async (client) => {
      active = true;
      await gate.promise;
      return result(await client.callTool({ name: 'identity', arguments: {} }));
    });
    await waitFor(() => active);
    let closed = false;
    const close = pool.close().then(() => {
      closed = true;
    });
    await sleep(60);
    assert.equal(closed, false);
    gate.resolve();
    assert.ok((await using).process);
    await close;
  } finally {
    gate.resolve();
    await pool.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('private credential literals in public manifests are rejected while credential parameter schemas remain valid', () => {
  assert.doesNotThrow(() =>
    assertPublishableMetadata({
      inputSchema: { properties: { api_key: { type: ['string', 'null'], default: null } } },
    }),
  );
  assert.throws(
    () => makeBundle(agent({ instructions: 'sk-proj-' + 'A'.repeat(30) })),
    /credential/,
  );
  assert.throws(
    () =>
      assertPublishableMetadata({
        inputSchema: { properties: { api_key: { type: 'string', default: 'embedded-value' } } },
      }),
    /credential/,
  );
  assert.throws(
    () => assertPublishableMetadata({ authorization: 'Bearer embedded-value-0000000000' }),
    /credential/,
  );
  assert.doesNotThrow(() =>
    assertPublishableMetadata({
      inputSchema: { type: 'object', properties: { api_key: { type: 'string' } } },
    }),
  );
});

test('idle MCP connections expire and abandoned initialization does not poison a replacement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-mcp-cancel-'));
  const config = await configuration(dir);
  config.mcp.stalled = {
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'],
    envNames: [],
  };
  const pool = new McpConnections(config, 50, 1);
  try {
    const controller = new AbortController();
    const pending = pool.use('stalled', scope, controller.signal, async () => {
      throw new Error('Initialization must not finish.');
    });
    const rejected = assert.rejects(pending, /cancelled/);
    await sleep(30);
    controller.abort();
    await rejected;
    config.mcp.stalled = config.mcp.selected!;
    const invoke = () =>
      pool.use('stalled', scope, AbortSignal.timeout(5000), async (client) =>
        result(await client.callTool({ name: 'identity', arguments: {} })),
      );
    const first = await invoke();
    await sleep(15);
    assert.equal((await invoke()).process, first.process);
    await sleep(90);
    assert.notEqual((await invoke()).process, first.process);
  } finally {
    await pool.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing declared MCP credentials block required tools before model use', async () => {
  const s = await setup();
  try {
    delete process.env.OAA_MCP_REQUIRED_BUT_ABSENT;
    s.runtime.config.mcp.missing = {
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp',
      tokenEnv: 'OAA_MCP_REQUIRED_BUT_ABSENT',
    };
    const source: Tool = {
      name: 'private_lookup',
      description: 'Private source',
      inputSchema: { type: 'object' },
    };
    const prepared = preparedTool(s.runtime.config, source, {
      server: 'missing',
      tool: source.name,
      capability: 'private/lookup',
      effect: 'read',
      approval: 'none',
      exportResult: true,
      out: 'unused',
    });
    s.runtime.config.tools.push(prepared.workerTool);
    s.store.publish('owner', makeBundle(agent({ tools: [prepared.binding] })));
    assert.throws(
      () =>
        s.kernel.submit(
          principal,
          invocationSchema.parse({ agent: 'agent/test', input: 'must not run' }),
        ),
      /No authorized healthy model route/,
    );
    assert.equal(s.driver.calls, 0);
    assert.equal(
      s.runtime.advertisement().capabilities.some((c) => c.id === 'private/lookup'),
      false,
    );
  } finally {
    await s.cleanup();
  }
});

test('host capability versions can coexist when their private references are distinct', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-tool-versions-'));
  const config = await configuration(dir);
  try {
    const descriptor: Tool = {
      name: 'read_note',
      description: 'Versioned fixture source',
      inputSchema: { type: 'object' },
    };
    config.mcp.second = config.mcp.selected!;
    const first = preparedTool(config, descriptor, {
      server: 'selected',
      tool: descriptor.name,
      capability: 'private/note',
      version: '1',
      effect: 'read',
      approval: 'none',
      exportResult: true,
      out: 'unused',
    });
    const second = preparedTool(config, descriptor, {
      server: 'second',
      tool: descriptor.name,
      capability: 'private/note',
      version: '2',
      effect: 'read',
      approval: 'none',
      exportResult: true,
      out: 'unused',
    });
    config.tools.push(first.workerTool);
    const overlay = path.join(dir, 'second.json');
    await writeFile(overlay, JSON.stringify(second.workerTool));
    const merged = await withToolConfigs(config, [overlay]);
    assert.equal(merged.tools.length, 2);
    assert.throws(
      () =>
        workerSchema.parse({
          ...merged,
          tools: [
            first.workerTool,
            { ...second.workerTool, reference: first.workerTool.reference },
          ],
        }),
      /Duplicate worker tool reference/,
    );
    assert.deepEqual(
      toolPlacement(
        { owner: 'owner', agent: agent({ tools: [second.binding] }), files: [] },
        {
          credential: {
            nodeId: 'local',
            owner: 'owner',
            token: 'fixture',
            agents: ['*'],
            capabilities: ['*'],
          },
          advertisement: {
            nodeId: 'local',
            providers: [],
            natives: [],
            concurrency: 1,
            warm: [],
            capabilities: [first.binding.capability, second.binding.capability],
          },
        },
        second.binding,
      ),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSON schema versions remain isolated and MCP 2020-12 constraints are enforced', () => {
  const schemas = new JsonSchemas();
  const modern = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.test/contract',
    type: 'object',
    allOf: [{ properties: { value: { type: 'integer' } } }],
    unevaluatedProperties: false,
  };
  assert.equal(schemas.validate(modern, { value: 1 }), true);
  assert.equal(schemas.validate(modern, { value: 1, unexpected: true }), false);
  assert.equal(
    schemas.validate(
      { ...modern, allOf: [{ properties: { value: { type: 'string' } } }] },
      { value: 'new version' },
    ),
    true,
  );
  assert.equal(
    schemas.validate({ $schema: 'https://json-schema.org/draft-07/schema#', type: 'integer' }, 1),
    true,
  );
  assert.equal(schemas.validate(modern, { value: 'wrong old version' }), false);
  assert.equal(
    schemas.validate(
      { type: 'array', items: [{ type: 'string' }, { type: 'integer' }], additionalItems: false },
      ['legacy tuple', 1],
    ),
    true,
  );
  assert.throws(() => schemas.compile({ $async: true, type: 'object' }), /Asynchronous/);
  assert.throws(
    () => schemas.compile({ $ref: 'https://example.test/missing-remote-schema' }),
    /unavailable external schema/,
  );
});

test('MCP task-required metadata is rejected rather than advertised as an ordinary callable tool', () => {
  const config = workerSchema.parse({ nodeId: 'local', dataDir: '/unused' });
  assert.throws(
    () =>
      preparedTool(
        config,
        {
          name: 'task_only',
          inputSchema: { type: 'object' },
          execution: { taskSupport: 'required' },
        },
        { server: 'selected', tool: 'task_only', capability: 'private/task', out: '/unused' },
      ),
    /task-augmented/,
  );
});

test('publication rejects unsupported schemas before any model use and ignores inherited argument properties', () => {
  assert.throws(
    () => makeBundle(agent({ outputSchema: { $async: true, type: 'object' } })),
    /Asynchronous/,
  );
  assert.throws(
    () => makeBundle(agent({ outputSchema: { $ref: 'https://example.test/not-downloaded' } })),
    /unavailable external schema/,
  );
  const schemas = new JsonSchemas();
  const contract = { type: 'object', properties: { toString: {} }, required: ['toString'] };
  assert.equal(schemas.validate(contract, {}), false);
  assert.equal(schemas.validate(contract, { toString: 'explicit' }), true);
});
