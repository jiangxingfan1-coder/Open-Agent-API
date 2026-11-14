import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Catalog } from '../src/gateway/catalog.js';
import { GatewayClient } from '../src/client/client.js';
import { createMcpBridge } from '../src/client/mcp.js';
import { makeBundle } from '../src/lang/bundle.js';
import { metadataUri } from '../src/gateway/discovery.js';
import { canonical, sha } from '../src/core/util.js';
import { setup, agent, principal, token, secondToken } from './helpers.js';

const exec = promisify(execFile);
const description = '\u4e2d\u6587\n"\\'.repeat(700);
const body = (raw: unknown) => {
  const result = CallToolResultSchema.parse(raw);
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const parsed =
    result.structuredContent ??
    JSON.parse((result.content.find((c) => c.type === 'text') as { text: string }).text);
  assert.notEqual(parsed.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(parsed)) <= 20000);
  return parsed;
};
function richBundle() {
  const files = Array.from({ length: 100 }, (_, i) => {
    const source = `---\nname: skill-${i}\ndescription: Controlled fixture.\n---\nPRIVATE_SKILL_BODY_FIXTURE_MARKER\n`;
    return {
      path: `skills/skill-${i}/SKILL.md`,
      content: Buffer.from(source).toString('base64'),
      sha256: sha(source),
    };
  });
  const script = 'PRIVATE_SCRIPT_BODY_FIXTURE_MARKER';
  files.push({
    path: 'scripts/fixture.mjs',
    content: Buffer.from(script).toString('base64'),
    sha256: sha(script),
  });
  return makeBundle(
    agent({
      id: 'agent/metadata-fixture',
      description,
      instructions: 'INTERNAL_PROMPT_BODY_FIXTURE_MARKER',
      routes: Array.from({ length: 32 }, (_, i) => ({
        id: `route-${i}`,
        model: `model-${i}-` + '\u4e2d'.repeat(185),
        provider: 'fixture',
        priority: i,
      })),
      skills: Array.from({ length: 100 }, (_, i) => ({
        name: `skill-${i}`,
        description,
        path: files[i]!.path,
      })),
      tools: Array.from({ length: 100 }, (_, i) => ({
        name: `tool_${i}`,
        required: i % 2 === 0,
        capability: {
          id: `fixture/tool-${i}`,
          version: `v${i}`,
          description,
          placement: 'portable',
          effect: i % 2 ? 'read' : 'write',
          requiresApproval: i % 2 === 0,
          resultExport: i % 3 !== 0,
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'Public schema fixture.'.repeat(200) },
            },
          },
        },
        handler:
          i === 0
            ? { kind: 'script', runtime: 'node', path: 'scripts/fixture.mjs' }
            : { kind: 'node', reference: `private-handler-reference-${i}` },
      })),
    }),
    files,
  );
}
async function bridge(url: string, key: string) {
  const server = createMcpBridge(new GatewayClient(url, key));
  const client = new Client({ name: 'discovery-fixture', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('large directory pages preserve every ID and avoid full definition or runtime reads', async () => {
  const s = await setup();
  try {
    const ids = Array.from({ length: 73 }, (_, i) => `agent/item-${String(i).padStart(3, '0')}`);
    for (const id of ids) s.store.publish('owner', makeBundle(agent({ id, description })));
    const originals = {
      agents: s.store.agents,
      agentDefinitions: s.store.agentDefinitions,
      agentDefinition: s.store.agentDefinition,
      bundle: s.store.bundle,
    };
    const noFull = () => {
      throw Error(
        'Summary discovery must not materialize full agent definitions or evaluate readiness.',
      );
    };
    s.store.agents = noFull;
    s.store.agentDefinitions = noFull;
    s.store.agentDefinition = noFull;
    s.store.bundle = noFull;
    try {
      let offset = 0,
        revision: string | undefined;
      const seen: string[] = [];
      while (true) {
        const response = await s.request(
          'GET',
          `/v1/catalog/agents?${new URLSearchParams({ offset: String(offset), limit: '50', ...(revision ? { revision } : {}) })}`,
        );
        assert.equal(response.statusCode, 200, response.body);
        assert.ok(Buffer.byteLength(response.body) <= 20000);
        const result = response.json();
        assert.equal(result.total, ids.length);
        if (revision) assert.equal(result.revision, revision);
        revision = result.revision;
        assert.ok(result.data.length > 0 && result.data.length < 50);
        for (const item of result.data) {
          assert.equal(item.readiness, 'not_evaluated');
          assert.equal(item.description_truncated, true);
          assert.equal(item.routes_count, 1);
          assert.equal(item.tools_count, 0);
          assert.equal(item.routes, undefined);
          seen.push(item.id);
        }
        if (result.next_offset === null) break;
        assert.equal(result.next_offset, offset + result.data.length);
        offset = result.next_offset;
      }
      assert.deepEqual(seen, ids);
      assert.equal(s.driver.calls, 0);
      assert.equal(s.store.allRuns().length, 0);
    } finally {
      Object.assign(s.store, originals);
    }
  } finally {
    await s.cleanup();
  }
});

test('publication revision guards reject mixed pages but ignore unrelated owners and agents', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/other' })));
    const key = String(s.auth.create(principal, 'one-agent', ['agent/test'], ['read']).token);
    const first = (await s.request('GET', '/v1/catalog/agents', undefined, key)).json();
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/other', instructions: 'Other version' })),
    );
    s.store.publish('second', makeBundle(agent({ instructions: 'Other owner' })));
    const continued = await s.request(
      'GET',
      `/v1/catalog/agents?revision=${first.revision}`,
      undefined,
      key,
    );
    assert.equal(continued.statusCode, 200);
    assert.equal(continued.json().revision, first.revision);
    s.store.publish('owner', makeBundle(agent({ instructions: 'Changed visible version' })));
    const stale = await s.request(
      'GET',
      `/v1/catalog/agents?revision=${first.revision}&offset=1`,
      undefined,
      key,
    );
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'catalog_changed');
    assert.equal(
      (
        await s.request(
          'GET',
          `/v1/catalog/agents?revision=${first.revision}`,
          undefined,
          secondToken,
        )
      ).statusCode,
      409,
    );
    assert.equal((await s.request('GET', '/v1/catalog/agents?unknown=true')).statusCode, 400);
    assert.equal((await s.request('GET', '/v1/catalog/agents?limit=51')).statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('summary notification anchors stay cheap and still detect publication changes before the first watch', () => {
  let snapshots = 0,
    version = '1',
    ready = false;
  const catalog = new Catalog(() => {
    snapshots++;
    return [{ agent: 'agent/test', version, state: { ready } }];
  });
  try {
    const cursor = catalog.publicationCursor(principal, [{ id: 'agent/test', digest: version }]);
    assert.equal(snapshots, 0);
    ready = true;
    version = '2';
    const result = catalog.page(principal, cursor);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]!.reason, 'published');
    const old = result.cursor;
    version = '3';
    const anchor = catalog.publicationCursor(principal, [{ id: 'agent/test', digest: version }]);
    assert.equal(anchor, old);
    assert.equal(catalog.page(principal, anchor).data[0]!.version, '3');
  } finally {
    catalog.close();
  }
});

test('model, tool and skill pages preserve complete identifiers and pin every section to one version', async () => {
  const s = await setup();
  try {
    const bundle = richBundle();
    s.store.publish('owner', bundle);
    const inspect = (section: string, offset: number, version?: string) =>
      s.request(
        'GET',
        `/v1/catalog/agent?${new URLSearchParams({ agent: bundle.agent.id, section, offset: String(offset), limit: '50', ...(version ? { agent_version: version } : {}) })}`,
      );
    for (const section of ['routes', 'tools', 'skills']) {
      const collected: Record<string, unknown>[] = [];
      let offset = 0;
      while (true) {
        const response = await inspect(section, offset, bundle.digest);
        assert.equal(response.statusCode, 200, response.body);
        assert.ok(Buffer.byteLength(response.body) <= 20000);
        const page = response.json();
        assert.equal(page.agent_version, bundle.digest);
        collected.push(...page.data);
        if (page.next_offset === null) break;
        assert.ok(page.next_offset > offset);
        offset = page.next_offset;
      }
      if (section === 'routes') {
        assert.deepEqual(collected, bundle.agent.routes);
        continue;
      }
      if (section === 'tools') {
        assert.deepEqual(
          collected.map((item) => item.name),
          bundle.agent.tools.map((tool) => tool.name),
        );
        assert.equal(collected[0]!.requires_approval, true);
        assert.equal(collected[0]!.required, true);
        assert.equal(collected[0]!.result_export, false);
        assert.equal(
          collected[0]!.schema_sha256,
          sha(canonical(bundle.agent.tools[0]!.capability.inputSchema)),
        );
        assert.equal(collected[0]!.description_truncated, true);
        assert.equal(collected[0]!.inputSchema, undefined);
      }
      if (section === 'skills')
        assert.deepEqual(
          collected.map((item) => item.name),
          bundle.agent.skills.map((skill) => skill.name),
        );
    }
    const update = makeBundle(
      agent({ id: bundle.agent.id, description: 'New smaller publication' }),
    );
    s.store.publish('owner', update);
    assert.equal((await inspect('routes', 1)).statusCode, 400);
    assert.equal((await inspect('routes', 1, bundle.digest)).json().data[0].id, 'route-1');
    assert.equal((await inspect('overview', 0)).json().agent_version, update.digest);
    assert.equal(s.driver.calls, 0);
  } finally {
    await s.cleanup();
  }
});

test('full public metadata is explicit, version-bound and excludes prompt, script and private-handler contents', async () => {
  const s = await setup();
  try {
    const bundle = richBundle();
    s.store.publish('owner', bundle);
    const reader = String(s.auth.create(principal, 'reader', [bundle.agent.id], ['read']).token);
    const query = new URLSearchParams({ agent: bundle.agent.id, agent_version: bundle.digest });
    const response = await s.request(
      'GET',
      `/v1/catalog/agent/content?${query}`,
      undefined,
      reader,
    );
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-disposition']), /attachment/);
    assert.equal(response.json().description, description);
    assert.deepEqual(
      response.json().tools[0].inputSchema,
      bundle.agent.tools[0]!.capability.inputSchema,
    );
    for (const excluded of [
      'INTERNAL_PROMPT_BODY_FIXTURE_MARKER',
      'PRIVATE_SCRIPT_BODY_FIXTURE_MARKER',
      'PRIVATE_SKILL_BODY_FIXTURE_MARKER',
      'private-handler-reference',
      'scripts/fixture.mjs',
    ])
      assert.ok(!response.body.includes(excluded), excluded);
    assert.equal(response.json().files, undefined);
    assert.equal(response.json().tools[0].handler, undefined);
    assert.equal(
      (
        await s.request(
          'GET',
          `/v1/agents/definition?agent=${encodeURIComponent(bundle.agent.id)}`,
          undefined,
          reader,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.request(
          'GET',
          `/v1/catalog/agent/content?agent=${encodeURIComponent(bundle.agent.id)}`,
          undefined,
          reader,
        )
      ).statusCode,
      400,
    );
    for (const endpoint of ['/v1/catalog/agent', '/v1/catalog/agent/content']) {
      assert.equal(
        (await s.request('GET', `${endpoint}?${query}`, undefined, secondToken)).statusCode,
        404,
      );
      const unrelated = String(
        s.auth.create(principal, 'unrelated', ['agent/unrelated'], ['read']).token,
      );
      assert.equal(
        (await s.request('GET', `${endpoint}?${query}`, undefined, unrelated)).statusCode,
        403,
      );
      const invokeOnly = String(
        s.auth.create(principal, 'invoke-only', [bundle.agent.id], ['invoke']).token,
      );
      assert.equal(
        (await s.request('GET', `${endpoint}?${query}`, undefined, invokeOnly)).statusCode,
        403,
      );
    }
  } finally {
    await s.cleanup();
  }
});

test('MCP paged discovery never falls back to a broken JSON preview, and its resource is pinned and authorized', async () => {
  const s = await setup();
  let mcp: Awaited<ReturnType<typeof bridge>> | undefined;
  let other: Awaited<ReturnType<typeof bridge>> | undefined;
  try {
    const bundle = richBundle();
    s.store.publish('owner', bundle);
    for (let i = 0; i < 35; i++)
      s.store.publish('owner', makeBundle(agent({ id: `agent/simple-${i}`, description })));
    const url = await s.listen();
    const reader = String(s.auth.create(principal, 'metadata-reader', ['*'], ['read']).token);
    mcp = await bridge(url, reader);
    let offset = 0,
      revision: string | undefined;
    const ids: string[] = [];
    while (true) {
      const page = body(
        await mcp.client.callTool({
          name: 'oaa_list_agents',
          arguments: { limit: 50, offset, ...(revision ? { revision } : {}) },
        }),
      );
      revision = String(page.revision);
      ids.push(...page.data.map((item: { id: string }) => item.id));
      if (page.next_offset === null) break;
      offset = Number(page.next_offset);
    }
    assert.equal(ids.length, 36);
    assert.equal(new Set(ids).size, 36);
    const result = await mcp.client.callTool({
      name: 'oaa_inspect_agent',
      arguments: {
        agent: bundle.agent.id,
        agent_version: bundle.digest,
        section: 'tools',
        limit: 50,
      },
    });
    const inspected = body(result);
    assert.ok(inspected.next_offset !== null);
    const link = CallToolResultSchema.parse(result).content.find(
      (part) => part.type === 'resource_link',
    );
    assert.ok(link && link.type === 'resource_link');
    assert.equal(link.uri, metadataUri(bundle.agent.id, bundle.digest));
    s.store.publish(
      'owner',
      makeBundle(agent({ id: bundle.agent.id, description: 'Changed after inspection' })),
    );
    const resource = await mcp.client.readResource({ uri: link.uri });
    const content = resource.contents[0]!;
    assert.ok('text' in content);
    const full = JSON.parse(String(content.text));
    assert.equal(full.version, bundle.digest);
    assert.equal(full.description, description);
    assert.equal(full.tools.length, 100);
    other = await bridge(url, secondToken);
    await assert.rejects(other.client.readResource({ uri: link.uri }), /not found|不存在/i);
    assert.equal(s.driver.calls, 0);
  } finally {
    await mcp?.close();
    await other?.close();
    await s.cleanup();
  }
});

test('oversized public schemas stay out of tool messages and fail explicitly at the MCP resource limit', async () => {
  const s = await setup();
  let mcp: Awaited<ReturnType<typeof bridge>> | undefined;
  try {
    const schemaDescription = 'x'.repeat(4 * 1024 * 1024 + 4000);
    const bundle = makeBundle(
      agent({
        tools: [
          {
            name: 'large',
            capability: {
              id: 'large/schema',
              version: '1',
              description: 'Large schema fixture',
              placement: 'portable',
              effect: 'read',
              inputSchema: { type: 'object', description: schemaDescription },
            },
            handler: { kind: 'node', reference: 'private-large-schema' },
          },
        ],
      }),
    );
    s.store.publish('owner', bundle);
    const url = await s.listen();
    mcp = await bridge(url, token);
    const page = body(
      await mcp.client.callTool({
        name: 'oaa_inspect_agent',
        arguments: { agent: bundle.agent.id, section: 'tools' },
      }),
    );
    assert.ok(page.data[0].schema_bytes > 4 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4000);
    await assert.rejects(mcp.client.readResource({ uri: page.metadata_uri }), /4 MiB/);
    const response = await s.request('GET', String(page.metadata_url));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tools[0].inputSchema.description.length, schemaDescription.length);
    assert.equal(s.driver.calls, 0);
  } finally {
    await mcp?.close();
    await s.cleanup();
  }
});

test('generated stdio launcher and CLI inspect and download the same immutable public metadata without overwriting', async () => {
  const s = await setup();
  const client = new Client({ name: 'stdio-discovery-fixture', version: '1.0.0' });
  try {
    const bundle = richBundle();
    s.store.publish('owner', bundle);
    const url = await s.listen();
    const file = path.join(s.dir, 'reader.token');
    const reader = String(
      s.auth.create(principal, 'stdio-reader', [bundle.agent.id], ['read']).token,
    );
    await writeFile(file, reader, { mode: 0o600 });
    const cli = path.resolve('dist/src/cli.js'),
      config = path.join(s.dir, 'mcp.json');
    await exec(process.execPath, [
      cli,
      'integration',
      '--out',
      config,
      '--url',
      url,
      '--token-file',
      file,
    ]);
    const launch = JSON.parse(await readFile(config, 'utf8')).mcpServers['open-agent-api'];
    await client.connect(new StdioClientTransport(launch));
    const inspected = body(
      await client.callTool({
        name: 'oaa_inspect_agent',
        arguments: { agent: bundle.agent.id, section: 'routes' },
      }),
    );
    assert.equal(inspected.agent_version, bundle.digest);
    const resource = await client.readResource({ uri: String(inspected.metadata_uri) });
    const content = resource.contents[0]!;
    assert.ok('text' in content);
    assert.equal(JSON.parse(String(content.text)).version, bundle.digest);
    const common = ['--url', url, '--token-file', file];
    const listed = await exec(process.execPath, [cli, 'agents', ...common]);
    assert.equal(JSON.parse(listed.stdout).data[0].version, bundle.digest);
    const queried = await exec(process.execPath, [
      cli,
      'agent',
      bundle.agent.id,
      '--section',
      'tools',
      '--agent-version',
      bundle.digest,
      ...common,
    ]);
    assert.equal(JSON.parse(queried.stdout).section, 'tools');
    const out = path.join(s.dir, 'metadata.json');
    const downloaded = await exec(process.execPath, [
      cli,
      'agent',
      bundle.agent.id,
      '--agent-version',
      bundle.digest,
      '--out',
      out,
      ...common,
    ]);
    assert.equal(JSON.parse(downloaded.stdout).agent_version, bundle.digest);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).version, bundle.digest);
    // Mode bits exist only on POSIX; Windows relies on the ACL (docs/windows.md).
    if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o600);
    await assert.rejects(
      exec(process.execPath, [cli, 'agent', bundle.agent.id, '--out', out, ...common]),
      /EEXIST|exists/,
    );
    assert.equal(s.driver.calls, 0);
  } finally {
    await client.close();
    await s.cleanup();
  }
});
