import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Catalog, type CatalogEntry } from '../src/gateway/catalog.js';
import { makeBundle } from '../src/lang/bundle.js';
import { createGateway } from '../src/gateway/server.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { openEventStream } from '../src/gateway/streams.js';
import { sha } from '../src/core/util.js';
import { setup, agent, FixtureModel, principal, token, secondToken, waitFor } from './helpers.js';

const exec = promisify(execFile);
const changed = (cursor: string, timeout = 0) =>
  `/v1/catalog/changes?${new URLSearchParams({ cursor, timeout_ms: String(timeout) })}`;
const payload = (raw: unknown) => {
  const result = CallToolResultSchema.parse(raw);
  assert.notEqual(result.isError, true);
  return (
    result.structuredContent ??
    JSON.parse((result.content.find((c) => c.type === 'text') as { text: string }).text)
  );
};
async function stream(url: string, key = token, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, ...headers },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    response,
    async next(): Promise<{ event: string; id?: string; data: Record<string, unknown> } | null> {
      while (true) {
        const at = buffer.indexOf('\n\n');
        if (at >= 0) {
          const lines = buffer.slice(0, at).split('\n');
          buffer = buffer.slice(at + 2);
          const data = lines.find((line) => line.startsWith('data: '));
          if (data)
            return {
              event: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message',
              id: lines.find((line) => line.startsWith('id: '))?.slice(4),
              data: JSON.parse(data.slice(6)),
            };
        } else {
          const chunk = await reader.read();
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

test('catalog cursors page a bounded scoped journal and reset after eviction or generation changes', () => {
  let entries: CatalogEntry[] = [{ agent: 'agent/test', version: '1', state: { ready: false } }];
  const limits = { history: 2, views: 2, subscriptionsPerOwner: 1, pollMs: 1000 };
  const catalog = new Catalog(() => entries, limits);
  const replacement = new Catalog(() => entries, limits);
  try {
    const initial = catalog.page(principal);
    assert.equal(initial.reset, true);
    assert.deepEqual(initial.data, []);
    entries[0]!.state = { ready: true };
    const runtime = catalog.page(principal, initial.cursor);
    assert.equal(runtime.data[0]!.reason, 'runtime');
    entries[0]!.version = '2';
    const first = catalog.page(principal, initial.cursor, 1);
    assert.equal(first.has_more, true);
    assert.equal(first.data[0]!.reason, 'runtime');
    const second = catalog.page(principal, first.cursor, 1);
    assert.equal(second.data[0]!.version, '2');
    assert.equal(second.has_more, false);
    entries[0]!.version = '3';
    assert.equal(catalog.page(principal, initial.cursor).reset, true);
    assert.equal(replacement.page(principal, second.cursor).reset, true);
    assert.throws(() => catalog.page(principal, 'not-a-catalog-cursor'), /catalog cursor/);
    assert.throws(
      () => catalog.page(principal, second.cursor.replace(/\.[0-9]+$/, '.999')),
      /ahead/,
    );
    const other = { ...principal, owner: 'second' };
    assert.equal(catalog.page(other, second.cursor).reset, true);
    const third = { ...principal, owner: 'third' };
    catalog.page(third);
    assert.equal(catalog.page(principal, second.cursor).reset, true);
  } finally {
    catalog.close();
    replacement.close();
  }
});

test('catalog waits release subscription limits on timeout, abort and shutdown', async () => {
  const catalog = new Catalog(() => [], {
    history: 2,
    views: 2,
    subscriptionsPerOwner: 1,
    pollMs: 20,
  });
  try {
    const cursor = catalog.cursor(principal);
    const controller = new AbortController();
    const wait = catalog.wait(principal, cursor, 1, 1000, controller.signal);
    const rejected = assert.rejects(wait);
    await assert.rejects(
      catalog.wait(principal, cursor, 1, 1000, new AbortController().signal),
      /subscriptions/,
    );
    controller.abort();
    await rejected;
    assert.equal(
      (await catalog.wait(principal, cursor, 1, 5, new AbortController().signal)).timed_out,
      true,
    );
    const pending = catalog.wait(principal, cursor, 1, 1000, new AbortController().signal);
    const closed = assert.rejects(pending, /shutting down/);
    catalog.close();
    await closed;
  } finally {
    catalog.close();
  }
});

test('multiple readers share a single scoped metadata refresh instead of rebuilding per subscriber', () => {
  let calls = 0,
    version = '1';
  const catalog = new Catalog(() => {
    calls++;
    return [{ agent: 'agent/test', version, state: {} }];
  });
  try {
    const cursor = catalog.cursor(principal);
    const seen: string[] = [];
    const first = catalog.subscribe(principal, () =>
      seen.push(first.read(cursor).data[0]!.version!),
    );
    const second = catalog.subscribe(principal, () =>
      seen.push(second.read(cursor).data[0]!.version!),
    );
    const before = calls;
    version = '2';
    catalog.cursor(principal);
    assert.equal(calls, before + 1);
    assert.deepEqual(seen, ['2', '2']);
    first.close();
    second.close();
  } finally {
    catalog.close();
  }
});

test('clock/config driven changes wake an active catalog wait without a publication event', async () => {
  let ready = false;
  const catalog = new Catalog(() => [{ agent: 'agent/test', version: '1', state: { ready } }], {
    history: 2,
    views: 2,
    subscriptionsPerOwner: 1,
    pollMs: 10,
  });
  try {
    const cursor = catalog.cursor(principal);
    const waiting = catalog.wait(principal, cursor, 2, 1000, new AbortController().signal);
    ready = true;
    const page = await waiting;
    assert.equal(page.data[0]!.reason, 'runtime');
    page.data[0]!.agent = 'modified reader copy';
    assert.equal(catalog.page(principal, cursor).data[0]!.agent, 'agent/test');
  } finally {
    catalog.close();
  }
});

test('catalog publication discovery is owner/agent scoped without decoding bundle file payloads', async () => {
  const s = await setup();
  try {
    const content = 'Selected bundle file fixture body.\n'.repeat(4000);
    const originalBundle = makeBundle(agent(), [
      {
        path: 'source.txt',
        content: Buffer.from(content).toString('base64'),
        sha256: sha(content),
      },
    ]);
    s.store.publish('owner', originalBundle);
    const scoped = s.auth.create(principal, 'catalog-reader', ['agent/test'], ['read']);
    const original = s.store.agents.bind(s.store);
    s.store.agents = () => {
      throw Error('Discovery must not parse full bundle file payloads.');
    };
    const list = await s.request('GET', '/v1/agents', undefined, String(scoped.token));
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.length, 1);
    assert.ok(list.body.length < 8000);
    assert.ok(!list.body.includes('Selected bundle file fixture body'));
    const cursor = list.json().catalog_cursor;
    s.store.publish('owner', originalBundle);
    s.store.publish('owner', makeBundle(agent({ id: 'agent/hidden' })));
    s.store.publish('second', makeBundle(agent({ instructions: 'Other owner publication' })));
    const unchanged = await s.request('GET', changed(cursor), undefined, String(scoped.token));
    assert.equal(unchanged.json().cursor, cursor);
    assert.deepEqual(unchanged.json().data, []);
    const update = makeBundle(agent({ instructions: 'New version for this owner' }));
    s.store.publish('owner', update);
    const page = await s.request('GET', changed(cursor), undefined, String(scoped.token));
    assert.equal(page.json().data.length, 1);
    assert.deepEqual(page.json().data[0], {
      agent: 'agent/test',
      version: update.digest,
      reason: 'published',
      cursor: page.json().cursor,
    });
    const foreign = await s.request('GET', changed(page.json().cursor), undefined, secondToken);
    assert.equal(foreign.json().reset, true);
    assert.deepEqual(foreign.json().data, []);
    const invokeOnly = s.auth.create(principal, 'invoke-only', ['agent/test'], ['invoke']);
    assert.equal(
      (await s.request('GET', '/v1/catalog/changes', undefined, String(invokeOnly.token)))
        .statusCode,
      403,
    );
    assert.equal(
      (await s.request('GET', '/v1/catalog/events', undefined, String(invokeOnly.token)))
        .statusCode,
      403,
    );
    for (const query of ['limit=33', 'timeout_ms=25001', 'extra=true', 'cursor=bogus'])
      assert.equal((await s.request('GET', `/v1/catalog/changes?${query}`)).statusCode, 400);
    assert.equal(s.driver.calls, 0);
    assert.equal(s.store.allRuns().length, 0);
    s.store.agents = original;
  } finally {
    await s.cleanup();
  }
});

test('SSE catalog reconnect replays changes, retains CORS/security headers and closes on key revocation', async () => {
  const s = await setup(undefined, { allowedOrigins: ['http://client.example'] });
  let live: Awaited<ReturnType<typeof stream>> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const key = s.auth.create(principal, 'catalog-sse', ['agent/test'], ['read']);
    const url = await s.listen();
    live = await stream(url + '/v1/catalog/events', String(key.token), {
      Origin: 'http://client.example',
    });
    assert.equal(live.response.headers.get('access-control-allow-origin'), 'http://client.example');
    assert.equal(live.response.headers.get('cache-control'), 'no-store, no-cache');
    const initial = await live.next();
    assert.equal(initial!.event, 'catalog.reset');
    const next = makeBundle(agent({ instructions: 'Updated version' }));
    s.store.publish('owner', next);
    const change = await live.next();
    assert.equal(change!.event, 'catalog.changed');
    assert.equal(change!.data.version, next.digest);
    await live.close();
    await waitFor(() => s.store.events.listenerCount('authorization') === 0);
    const final = makeBundle(agent({ instructions: 'Update while disconnected' }));
    s.store.publish('owner', final);
    live = await stream(url + '/v1/catalog/events', String(key.token), {
      'Last-Event-ID': change!.id!,
    });
    const replay = await live.next();
    assert.equal(replay!.event, 'catalog.changed');
    assert.equal(replay!.data.version, final.digest);
    const otherKey = s.auth.create(principal, 'different-reader', ['agent/test'], ['read']);
    s.auth.revoke(principal, String(otherKey.id));
    const stillVisible = makeBundle(
      agent({ instructions: 'Unrelated revocation does not disconnect this reader' }),
    );
    s.store.publish('owner', stillVisible);
    assert.equal((await live.next())!.data.version, stillVisible.digest);
    s.auth.revoke(principal, String(key.id));
    assert.equal(await live.next(), null);
    assert.equal(s.store.events.listenerCount('authorization'), 0);
    assert.equal(
      (await s.request('GET', '/v1/catalog/changes', undefined, String(key.token))).statusCode,
      401,
    );
    assert.equal(s.driver.calls, 0);
  } finally {
    await live?.close();
    await s.cleanup();
  }
});

test('catalog wait revocation interrupts delivery without consuming request-rate budget for revalidation', async () => {
  const s = await setup();
  try {
    const key = s.auth.create(principal, 'watch', ['*'], ['read']);
    const cursor = (
      await s.request('GET', '/v1/catalog/changes', undefined, String(key.token))
    ).json().cursor;
    const waiting = s.request('GET', changed(cursor, 20000), undefined, String(key.token));
    await waitFor(() => s.store.events.listenerCount('authorization') === 1);
    for (let i = 0; i < 700; i++) s.auth.revalidate(`Bearer ${key.token}`);
    assert.equal(
      (await s.request('GET', '/v1/agents', undefined, String(key.token))).statusCode,
      200,
    );
    s.auth.revoke(principal, String(key.id));
    assert.equal((await waiting).statusCode, 401);
    assert.equal(s.store.events.listenerCount('authorization'), 0);
  } finally {
    await s.cleanup();
  }
});

test('revoking an invocation stream stops disclosure but does not cancel accepted work', async () => {
  const gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async () => {
      await gate.promise;
      return { text: 'Private result after revoke' };
    }),
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    s.store.publish('owner', makeBundle(agent()));
    const key = s.auth.create(principal, 'invoker', ['agent/test'], ['invoke']);
    const url = await s.listen();
    const response = await fetch(url + '/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'agent/test', input: 'fixture', stream: true }),
      signal: AbortSignal.timeout(5000),
    });
    const runId = response.headers.get('x-run-id')!;
    reader = response.body!.getReader();
    await reader.read();
    await waitFor(() => s.driver.calls === 1);
    s.auth.revoke(principal, String(key.id));
    let after = '';
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      after += Buffer.from(part.value).toString('utf8');
    }
    assert.ok(!after.includes('Private result'));
    assert.equal(s.store.run(runId).status, 'in_progress');
    gate.resolve();
    assert.equal((await s.kernel.wait(runId)).status, 'completed');
    assert.equal(s.store.events.listenerCount('authorization'), 0);
  } finally {
    gate.resolve();
    await reader?.cancel().catch(() => {});
    await s.cleanup();
  }
});

test('revocation cancels a pending run observation without cancelling its execution', async () => {
  const gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async () => {
      await gate.promise;
      return { text: 'completed' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    await waitFor(() => s.driver.calls === 1);
    // An observer key: it reads another caller's run (schema v4 data_scope 'owner').
    const reader = s.auth.create(
      principal,
      'run-reader',
      ['agent/test'],
      ['read'],
      undefined,
      'owner',
    );
    const waiting = s.request('GET', `/v1/runs/${run.id}/wait`, undefined, String(reader.token));
    await waitFor(() => s.store.events.listenerCount('authorization') === 1);
    s.auth.revoke(principal, String(reader.id));
    assert.equal((await waiting).statusCode, 401);
    assert.equal(s.store.run(run.id).status, 'in_progress');
    gate.resolve();
    assert.equal((await s.kernel.wait(run.id)).status, 'completed');
    assert.equal(s.store.events.listenerCount(run.id), 0);
    assert.equal(s.store.events.listenerCount('authorization'), 0);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('revoking a synchronous caller ends its wait rather than returning later private output', async () => {
  const gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async () => {
      await gate.promise;
      return { text: 'Private completed output' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const key = s.auth.create(principal, 'sync-caller', ['agent/test'], ['invoke']);
    const pending = s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/test', input: 'fixture' },
      String(key.token),
    );
    await waitFor(() => s.driver.calls === 1);
    s.auth.revoke(principal, String(key.id));
    const response = await pending;
    assert.equal(response.statusCode, 401);
    assert.ok(!response.body.includes('Private completed output'));
    const run = s.store.allRuns()[0]!;
    assert.equal(run.status, 'in_progress');
    assert.equal(s.store.events.listenerCount(run.id), 0);
    gate.resolve();
    assert.equal((await s.kernel.wait(run.id)).status, 'completed');
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('the bounded SSE writer closes a slow-reader fixture and releases authorization listeners', async () => {
  const s = await setup();
  class Raw extends EventEmitter {
    writableLength = 65537;
    ended = false;
    written = 0;
    writeHead() {}
    flushHeaders() {}
    write() {
      this.written++;
    }
    end() {
      this.ended = true;
      this.emit('close');
    }
  }
  const raw = new Raw();
  let opened: ReturnType<typeof openEventStream> | undefined;
  try {
    const request = { headers: { authorization: `Bearer ${token}` }, principal } as FastifyRequest;
    const reply = { raw, getHeaders: () => ({}), hijack: () => {} } as unknown as FastifyReply;
    opened = openEventStream(request, reply, s.auth, {}, 65536);
    let cleaned = 0;
    opened.onClose(() => cleaned++);
    assert.equal(s.store.events.listenerCount('authorization'), 1);
    assert.equal(opened.write('data: {}\n\n'), false);
    assert.equal(raw.ended, true);
    assert.equal(raw.written, 0);
    opened.close();
    assert.equal(cleaned, 1);
    assert.equal(s.store.events.listenerCount('authorization'), 0);
  } finally {
    opened?.close();
    await s.cleanup();
  }
});

test('actual worker registration, advertisement changes and disconnection invalidate only its authorized catalog', async () => {
  const s = await setup();
  let peer: WebSocket | undefined;
  try {
    const enrollment = s.auth.enroll(principal, 'remote-catalog', ['agent/remote'], ['*']);
    s.hub.credentials.push(enrollment.credential);
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/remote',
          provider: 'remote-provider',
          allowedNodes: ['remote-catalog'],
        }),
      ),
    );
    s.store.publish('owner', makeBundle(agent()));
    const other = s.auth.create(principal, 'unrelated', ['agent/test'], ['read']);
    const unrelated = (await s.request('GET', '/v1/agents', undefined, String(other.token))).json()
      .catalog_cursor;
    const list = (await s.request('GET', '/v1/agents')).json();
    let cursor = list.catalog_cursor;
    assert.equal(list.data.find((a: { id: string }) => a.id === 'agent/remote').ready, false);
    const url = await s.listen();
    peer = new WebSocket(url.replace('http:', 'ws:') + '/v1/nodes/connect', {
      headers: { Authorization: `Bearer ${enrollment.token}`, 'X-OAA-Node-ID': 'remote-catalog' },
    });
    const advertisement = {
      nodeId: 'remote-catalog',
      providers: ['remote-provider'],
      natives: [],
      capabilities: [],
      warm: [],
      concurrency: 2,
    };
    await new Promise<void>((resolve, reject) => {
      peer!.once('open', resolve);
      peer!.once('error', reject);
    });
    peer.send(JSON.stringify({ type: 'hello', protocol: 'oaa/1', advertisement }));
    await waitFor(() => s.hub.nodes.has('remote-catalog'));
    let page = (await s.request('GET', changed(cursor, 2000))).json();
    assert.deepEqual(
      page.data.map((event: { agent: string }) => event.agent),
      ['agent/remote'],
    );
    cursor = page.cursor;
    assert.equal(
      (await s.request('GET', changed(unrelated), undefined, String(other.token))).json().data
        .length,
      0,
    );
    peer.send(
      JSON.stringify({ type: 'advertisement', advertisement: { ...advertisement, providers: [] } }),
    );
    await waitFor(
      () => s.hub.nodes.get('remote-catalog')!.executor.advertisement().providers.length === 0,
    );
    page = (await s.request('GET', changed(cursor, 2000))).json();
    assert.equal(page.data[0].reason, 'runtime');
    cursor = page.cursor;
    peer.terminate();
    await waitFor(() => !s.hub.nodes.has('remote-catalog'));
    page = (await s.request('GET', changed(cursor, 2000))).json();
    assert.equal(page.data[0].agent, 'agent/remote');
    assert.equal(s.driver.calls, 0);
    assert.equal(s.store.allRuns().length, 0);
  } finally {
    peer?.terminate();
    await s.cleanup();
  }
});

test('active load and local adapter changes wake catalog readers without extra model calls', async () => {
  const gate = Promise.withResolvers<void>();
  const s = await setup(
    new FixtureModel(async () => {
      await gate.promise;
      return { text: 'fixture' };
    }),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    let cursor = (await s.request('GET', '/v1/agents')).json().catalog_cursor;
    const waiting = s.request('GET', changed(cursor, 2000));
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'fixture' }),
    );
    await waitFor(() => s.driver.calls === 1);
    const busy = (await waiting).json();
    assert.equal(busy.data[0].reason, 'runtime');
    gate.resolve();
    await s.kernel.wait(run.id);
    const idle = (await s.request('GET', changed(busy.cursor, 2000))).json();
    assert.equal(idle.data[0].reason, 'runtime');
    s.config.localWorker!.native.codex = { executable: process.execPath, enabled: false, args: [] };
    s.runtime.config.native.codex = { executable: process.execPath, enabled: false, args: [] };
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/native-fixture', engine: 'codex', model: 'default' })),
    );
    cursor = (await s.request('GET', '/v1/agents')).json().catalog_cursor;
    await s.request('POST', '/v1/local/backends/codex', { enabled: true });
    const enabled = (await s.request('GET', changed(cursor, 2000))).json();
    assert.ok(
      enabled.data.some((event: { agent: string }) => event.agent === 'agent/native-fixture'),
    );
    assert.equal(s.driver.calls, 1);
  } finally {
    gate.resolve();
    await s.cleanup();
  }
});

test('gateway restart requests a catalog resync while retaining authoritative publications', async () => {
  const s = await setup();
  let next: Awaited<ReturnType<typeof createGateway>> | undefined;
  try {
    const bundle = makeBundle(agent());
    s.store.publish('owner', bundle);
    const previous = (await s.request('GET', '/v1/agents')).json().catalog_cursor;
    await s.app.close();
    next = await createGateway(
      s.config,
      new WorkerRuntime(s.runtime.config, new Map(), new Map([['fixture', new FixtureModel()]])),
    );
    const page = await next.app.inject({
      method: 'GET',
      url: changed(previous),
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(page.json().reset, true);
    assert.equal(next.store.bundle('owner', 'agent/test').digest, bundle.digest);
  } finally {
    await next?.app.close();
    await s.cleanup();
  }
});

test('generated stdio MCP launcher and CLI share the catalog cursor and cancellable wait contract', async () => {
  const s = await setup();
  const client = new Client({ name: 'catalog-fixture', version: '1.0.0' });
  try {
    s.store.publish('owner', makeBundle(agent()));
    const url = await s.listen();
    const tokenFile = path.join(s.dir, 'reader.token');
    await writeFile(tokenFile, token, { mode: 0o600 });
    const config = path.join(s.dir, 'mcp.json');
    const cli = path.resolve('dist/src/cli.js');
    await exec(process.execPath, [
      cli,
      'integration',
      '--out',
      config,
      '--url',
      url,
      '--token-file',
      tokenFile,
    ]);
    const { readFile } = await import('node:fs/promises');
    const launch = JSON.parse(await readFile(config, 'utf8')).mcpServers['open-agent-api'];
    await client.connect(new StdioClientTransport(launch));
    const list = payload(await client.callTool({ name: 'oaa_list_agents', arguments: {} }));
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'oaa_watch_catalog', arguments: { cursor: list.catalog_cursor } },
      undefined,
      { signal: controller.signal },
    );
    const cancelled = assert.rejects(pending);
    await waitFor(() => s.store.events.listenerCount('authorization') === 1);
    controller.abort();
    await cancelled;
    await waitFor(() => s.store.events.listenerCount('authorization') === 0);
    const watching = client.callTool({
      name: 'oaa_watch_catalog',
      arguments: { cursor: list.catalog_cursor, timeout_ms: 2000 },
    });
    const bundle = makeBundle(agent({ instructions: 'MCP observed publication' }));
    s.store.publish('owner', bundle);
    const update = payload(await watching);
    assert.equal(update.data[0].version, bundle.digest);
    const command = await exec(process.execPath, [
      cli,
      'catalog',
      '--url',
      url,
      '--token-file',
      tokenFile,
      '--cursor',
      String(update.cursor),
      '--timeout-ms',
      '10',
    ]);
    assert.equal(JSON.parse(command.stdout).timed_out, true);
    assert.equal(s.driver.calls, 0);
    assert.equal(s.store.allRuns().length, 0);
  } finally {
    await client.close();
    await s.cleanup();
  }
});
