import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { setup, agent, principal, secondToken, token, waitFor } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import {
  OverviewRevisions,
  OverviewStreams,
  RevisionCache,
  etagMatches,
  overviewEtag,
} from '../src/gateway/overview.js';
import type { Principal } from '../src/core/contracts.js';
import { executableExists, forgetExecutableChecks, sleep } from '../src/core/util.js';

type Injected = {
  stream(): NodeJS.ReadableStream;
  statusCode: number;
  headers: Record<string, unknown>;
};
function sse(response: Injected) {
  let text = '';
  const stream = response.stream();
  const ended = new Promise<void>((resolve) => {
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', () => resolve());
  });
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return {
    text: () => text,
    until: async (pattern: RegExp, timeout = 3_000) => {
      await waitFor(() => pattern.test(text), timeout);
      return text;
    },
    ended,
  };
}
const events = (text: string) =>
  text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('event:'))
    .map((block) => ({
      event: /^event: (.+)$/m.exec(block)![1]!,
      data: JSON.parse(/^data: (.+)$/m.exec(block)![1]!) as {
        revision: number;
        reasons?: string[];
      },
    }));
const revisionOf = (etag: string) => Number(/^W\/"ov\.(\d+)\./.exec(etag)![1]);

test('overview carries a weak ETag and answers matching If-None-Match with 304', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    const first = await s.request('GET', '/v1/overview');
    assert.equal(first.statusCode, 200);
    const etag = String(first.headers.etag);
    assert.match(etag, /^W\/"ov\.\d+\.[a-f0-9]{16}"$/);
    assert.equal(first.json().revision, revisionOf(etag));
    assert.equal(first.json().agents.length, 1);
    for (const match of [etag, `W/"nope", ${etag}`, etag.slice(2), '*']) {
      const cached = await s.request('GET', '/v1/overview', undefined, undefined, {
        'if-none-match': match,
      });
      assert.equal(cached.statusCode, 304, match);
      assert.equal(cached.body, '');
      assert.equal(cached.headers.etag, etag);
    }
    const stale = await s.request('GET', '/v1/overview', undefined, undefined, {
      'if-none-match': 'W/"ov.1.0000000000000000"',
    });
    assert.equal(stale.statusCode, 200);
    // The ETag binds caller identity and the advertised base URL, not only the revision.
    const other = await s.request('GET', '/v1/overview', undefined, undefined, {
      host: '127.0.0.1',
    });
    assert.notEqual(other.headers.etag, etag);
    const p = { ...principal, keyId: 'config:test' };
    assert.notEqual(
      overviewEtag(1, p, 'http://a'),
      overviewEtag(1, { ...p, scopes: ['read'] }, 'http://a'),
    );
    assert.ok(
      etagMatches(`"x", ${overviewEtag(1, p, 'http://a')}`, overviewEtag(1, p, 'http://a')),
    );
    assert.ok(!etagMatches(undefined, 'W/"a"'));
  } finally {
    await s.cleanup();
  }
});

test('overview revision advances for runs, publications, nodes, backend toggles and URL changes', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.config.localWorker!.native.codex = { executable: process.execPath, enabled: false, args: [] };
    s.runtime.config.native.codex = { executable: process.execPath, enabled: false, args: [] };
    const revision = async (token?: string) =>
      (await s.request('GET', '/v1/overview', undefined, token)).json().revision as number;
    let current = await revision();
    const otherOwner = await revision(secondToken);
    const advanced = async (label: string) => {
      const next = await revision();
      assert.ok(next > current, `${label} must advance the revision`);
      current = next;
    };
    s.store.publish('owner', makeBundle(agent({ id: 'agent/second' })));
    await advanced('publication');
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'hello', background: true }),
    );
    await s.kernel.wait(run.id);
    await advanced('run');
    s.hub.addLocal(
      { nodeId: 'extra', owner: 'owner', token: 'local', agents: ['*'], capabilities: ['*'] },
      {
        advertisement: () => ({
          nodeId: 'extra',
          providers: [],
          natives: [],
          capabilities: [],
          warm: [],
          concurrency: 1,
        }),
        install: async () => {},
        execute: async () => ({ text: '', nativeState: {}, usage: null }),
        close: async () => {},
      },
    );
    await advanced('node registration');
    assert.equal(
      (await s.request('POST', '/v1/local/backends/codex', { enabled: true })).statusCode,
      200,
    );
    await advanced('local backend toggle');
    assert.equal(await revision(secondToken), otherOwner, 'other owners are not notified');
    await s.request('POST', '/v1/gateway/public-url', {
      public_base_url: 'https://agents.example.com',
    });
    await advanced('public base URL');
    assert.ok((await revision(secondToken)) > otherOwner, 'URL changes affect every owner');
  } finally {
    await s.cleanup();
  }
});

test('unchanged overview polls reuse cached availability projections', async () => {
  const s = await setup();
  try {
    s.store.publish('owner', makeBundle(agent()));
    let calls = 0;
    const original = s.hub.availability.bind(s.hub);
    s.hub.availability = (...args: Parameters<typeof original>) => {
      calls++;
      return original(...args);
    };
    await s.request('GET', '/v1/overview');
    const afterFirst = calls;
    assert.ok(afterFirst > 0);
    for (let i = 0; i < 5; i++) await s.request('GET', '/v1/overview');
    await s.request('GET', '/v1/agents');
    await s.request('GET', '/v1/models');
    assert.equal(calls, afterFirst, 'no recomputation without a revision change');
    s.store.publish('owner', makeBundle(agent({ id: 'agent/other' })));
    const body = (await s.request('GET', '/v1/overview')).json();
    assert.ok(calls > afterFirst);
    assert.equal(body.agents.length, 2);
  } finally {
    await s.cleanup();
  }
});

test('revision cache re-checks untracked inputs after its max-age and advances only on change', async () => {
  const revisions = new OverviewRevisions();
  try {
    let source = { state: 'a' };
    let computed = 0;
    const reasons: string[] = [];
    revisions.subscribe('owner', (reason) => reasons.push(reason));
    const cache = new RevisionCache<{ state: string }>(revisions, {
      maxAgeMs: 25,
      reason: 'nodes',
      stable: (value) => value.state,
    });
    const read = () =>
      cache.get('owner', 'view', () => {
        computed++;
        return { ...source };
      });
    const start = revisions.revision('owner');
    assert.equal(read().state, 'a');
    source = { state: 'b' };
    assert.equal(read().state, 'a', 'served from cache within max-age');
    assert.equal(computed, 1);
    await sleep(40);
    assert.equal(read().state, 'b');
    assert.equal(revisions.revision('owner'), start + 1);
    assert.deepEqual(reasons, ['nodes']);
    await sleep(40);
    assert.equal(read().state, 'b');
    assert.equal(revisions.revision('owner'), start + 1, 'same content keeps the revision');
    revisions.bump('owner', 'runs');
    read();
    assert.equal(computed, 4);
  } finally {
    revisions.close();
  }
});

test('overview revisions are monotonic, broadcast-aware and advance when cooldowns expire', async () => {
  const revisions = new OverviewRevisions();
  try {
    const a = revisions.revision('a');
    assert.ok(a >= Date.now() * 1000 - 60_000_000, 'starts from a microsecond-scale clock');
    revisions.bump('a', 'runs');
    assert.equal(revisions.revision('a'), a + 1);
    assert.equal(revisions.revision('b'), a);
    revisions.bump(undefined, 'catalog');
    assert.equal(revisions.revision('a'), a + 2);
    assert.equal(revisions.revision('b'), a + 1);
    const seen: string[] = [];
    revisions.subscribe('a', (reason) => seen.push(reason));
    revisions.expireAt('a', Date.now() + 500, 'nodes');
    revisions.expireAt('a', Date.now() + 20, 'nodes');
    revisions.expireAt('a', Date.now() + 1_000, 'nodes');
    await waitFor(() => seen.length === 1, 1_000);
    assert.deepEqual(seen, ['nodes']);
    await sleep(60);
    assert.deepEqual(seen, ['nodes'], 'the earliest expiry replaces later ones');
  } finally {
    revisions.close();
  }
});

test('overview events: ready, one coalesced changed event, and close on key revocation', async () => {
  const s = await setup();
  try {
    s.config.localWorker!.native.codex = { executable: process.execPath, enabled: false, args: [] };
    s.runtime.config.native.codex = { executable: process.execPath, enabled: false, args: [] };
    const key = (
      await s.request('POST', '/v1/keys', { name: 'console', agents: ['*'], scopes: ['read'] })
    ).json() as { id: string; token: string };
    const response = (await s.app.inject({
      method: 'GET',
      url: '/v1/overview/events',
      headers: { authorization: `Bearer ${key.token}` },
      payloadAsStream: true,
    })) as unknown as Injected;
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/event-stream/);
    const feed = sse(response);
    await feed.until(/event: ready/);
    const ready = events(feed.text())[0]!;
    assert.equal(ready.event, 'ready');
    const overview = await s.request('GET', '/v1/overview', undefined, key.token);
    assert.equal(ready.data.revision, overview.json().revision);
    s.store.publish('owner', makeBundle(agent()));
    await s.request('POST', '/v1/local/backends/codex', { enabled: true });
    await feed.until(/event: changed/);
    await sleep(350);
    const changed = events(feed.text()).filter((e) => e.event === 'changed');
    assert.equal(changed.length, 1, 'changes within the window are coalesced');
    assert.deepEqual(changed[0]!.data.reasons, ['catalog', 'nodes']);
    const latest = await s.request('GET', '/v1/overview', undefined, key.token);
    assert.equal(changed[0]!.data.revision, latest.json().revision);
    assert.ok(changed[0]!.data.revision > ready.data.revision);
    s.store.publish('second', makeBundle(agent({ id: 'agent/tenant' })));
    await sleep(350);
    assert.equal(events(feed.text()).filter((e) => e.event === 'changed').length, 1);
    assert.equal((await s.request('DELETE', `/v1/keys/${key.id}`)).statusCode, 204);
    await Promise.race([
      feed.ended,
      sleep(2_000).then(() => assert.fail('stream must close after revocation')),
    ]);
    const unauthenticated = await s.app.inject({ method: 'GET', url: '/v1/overview/events' });
    assert.equal(unauthenticated.statusCode, 401);
  } finally {
    await s.cleanup();
  }
});

test('overview event streams send pings and are limited per API key', async () => {
  const s = await setup();
  const revisions = new OverviewRevisions();
  const app = Fastify({ logger: false });
  try {
    const streams = new OverviewStreams(s.auth, revisions, {
      perKey: 1,
      heartbeatMs: 40,
      coalesceMs: 10,
    });
    app.decorateRequest('principal');
    app.addHook('onRequest', async (req) => {
      req.principal = s.auth.authenticate(req.headers.authorization);
    });
    app.get('/events', async (req, reply) => {
      streams.open(req, reply, () => {});
    });
    const controller = new AbortController();
    const first = sse(
      (await app.inject({
        method: 'GET',
        url: '/events',
        headers: { authorization: `Bearer ${token}` },
        payloadAsStream: true,
        signal: controller.signal,
      })) as unknown as Injected,
    );
    await first.until(/: ping\n\n/, 2_000);
    revisions.bump('owner', 'runs');
    await first.until(/event: changed/);
    assert.deepEqual(events(first.text()).at(-1)!.data.reasons, ['runs']);
    const second = await app.inject({
      method: 'GET',
      url: '/events',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(second.statusCode, 429);
    assert.match(second.body, /too_many_streams/);
    const p: Principal = s.auth.authenticate(`Bearer ${token}`);
    assert.equal(streams.openCount(p), 1);
    controller.abort();
    await waitFor(() => streams.openCount(p) === 0, 2_000);
  } finally {
    revisions.close();
    await app.close();
    await s.cleanup();
  }
});

test('framework and routing failures use stable error codes', async () => {
  const s = await setup();
  try {
    const raw = (opts: {
      method: 'GET' | 'POST' | 'DELETE';
      url: string;
      payload?: string;
      headers?: Record<string, string>;
    }) => s.app.inject(opts);
    const auth = { authorization: `Bearer ${token}` };
    const cases: [string, Awaited<ReturnType<typeof raw>>, number, string][] = [
      [
        'malformed JSON',
        await raw({
          method: 'POST',
          url: '/v1/responses',
          payload: '{"model":',
          headers: { ...auth, 'content-type': 'application/json' },
        }),
        400,
        'invalid_json',
      ],
      [
        'empty JSON body',
        await raw({
          method: 'POST',
          url: '/v1/responses',
          payload: '',
          headers: { ...auth, 'content-type': 'application/json' },
        }),
        400,
        'invalid_json',
      ],
      [
        'unsupported media type',
        await raw({
          method: 'POST',
          url: '/v1/responses',
          payload: '<x/>',
          headers: { ...auth, 'content-type': 'application/xml' },
        }),
        415,
        'unsupported_media_type',
      ],
      [
        'oversized body',
        await raw({
          method: 'POST',
          url: '/v1/responses',
          payload: JSON.stringify({ model: 'x', input: 'a'.repeat(25 * 1024 * 1024) }),
          headers: { ...auth, 'content-type': 'application/json' },
        }),
        413,
        'payload_too_large',
      ],
      [
        'unknown route',
        await raw({ method: 'GET', url: '/v1/does-not-exist?x=1', headers: auth }),
        404,
        'route_not_found',
      ],
      [
        'unsupported method',
        await raw({ method: 'DELETE', url: '/v1/overview', headers: auth }),
        404,
        'route_not_found',
      ],
      [
        'malformed multipart',
        await raw({
          method: 'POST',
          url: '/v1/files',
          payload: 'x',
          headers: { ...auth, 'content-type': 'multipart/form-data' },
        }),
        400,
        'invalid_multipart',
      ],
    ];
    for (const [label, response, status, code] of cases) {
      assert.equal(response.statusCode, status, `${label}: ${response.body}`);
      const body = response.json() as { error: { code: string; message: string; type: string } };
      assert.equal(body.error.code, code, label);
      assert.equal(body.error.type, 'invalid_request_error', label);
      assert.equal(typeof body.error.message, 'string');
    }
    assert.ok(!cases[4]![1].body.includes('x=1'), 'query strings are not echoed');
    s.config.localWorker!.native.dsh = {
      executable: path.join(s.dir, 'missing'),
      enabled: false,
      args: [],
    };
    const missing = await s.request('POST', '/v1/local/backends/dsh', { enabled: true });
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().error.code, 'backend_unavailable');
  } finally {
    await s.cleanup();
  }
});

test('every gateway error code in the source is documented in docs/protocol.md', async () => {
  const ts = createRequire(path.resolve('package.json'))(
    'typescript',
  ) as typeof import('typescript');
  const docs = await readFile(path.resolve('docs/protocol.md'), 'utf8');
  const codes = new Set<string>([
    // Codes assigned outside `new Fault(...)`: run errors and framework mappings.
    'gateway_restarted',
    'run_timeout',
    'effect_outcome_unknown',
    'invalid_json',
    'unsupported_media_type',
    'invalid_url',
    'route_not_found',
  ]);
  const literals = (node: import('typescript').Node): string[] =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? [node.text]
      : ts.isConditionalExpression(node)
        ? [...literals(node.whenTrue), ...literals(node.whenFalse)]
        : ts.isParenthesizedExpression(node)
          ? literals(node.expression)
          : [];
  for (const file of (await readdir(path.resolve('src'), { recursive: true })).filter((f) =>
    f.endsWith('.ts'),
  )) {
    const source = ts.createSourceFile(
      file,
      await readFile(path.resolve('src', file), 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    );
    const visit = (node: import('typescript').Node) => {
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(source) === 'Fault' &&
        node.arguments?.[0]
      )
        for (const code of literals(node.arguments[0])) codes.add(code);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(codes.size > 150, `expected the full code inventory, found ${codes.size}`);
  const missing = [...codes].filter((code) => !docs.includes(`\`${code}\``)).sort();
  assert.deepEqual(missing, [], `document these error codes: ${missing.join(', ')}`);
});

test('executable checks are memoized briefly and refreshed for explicit owner actions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-exec-'));
  try {
    const file = path.join(dir, 'tool');
    if (process.platform !== 'win32') {
      // POSIX only: a file without the execute bit is not executable (Windows has no mode bits).
      await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      forgetExecutableChecks();
      assert.equal(executableExists(file), false);
      await rm(file);
    }
    forgetExecutableChecks();
    assert.equal(executableExists(file), false, 'missing');
    await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(file, 0o755);
    assert.equal(executableExists(file), false, 'cached within the TTL');
    assert.equal(executableExists(file, { fresh: true }), true, 'owner actions re-check');
    assert.equal(executableExists(file), true, 'the fresh result refreshes the cache');
    await rm(file);
    forgetExecutableChecks();
    assert.equal(executableExists(file), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
