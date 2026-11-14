import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { decideApprovals, listPending } from '../src/client/approvals.js';
import { agentSchema } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import {
  gatherStatus,
  parseEtime,
  processUptime,
  renderStatus,
  showStatus,
  type StatusReport,
} from '../src/client/status.js';
import { token } from './helpers.js';
import { BASE, callerToken, injectedGateway, until, type InjectedGateway } from './cli-helpers.js';

// oaa status: read-only; the gateway is reached through app.inject (no port is opened).

const run = promisify(execFile);

async function endpointFor(g: InjectedGateway, key = token) {
  const tokenFile = path.join(g.dir, `${key.slice(0, 8)}.key`);
  await writeFile(tokenFile, key + '\n');
  return { url: BASE, tokenFile, config: g.config, dir: g.dir, source: 'flags' as const };
}

test('parseEtime reads ps elapsed times; the uptime of this very process is plausible', async () => {
  assert.equal(parseEtime('05:09'), 309);
  assert.equal(parseEtime('02:05:09'), 7509);
  assert.equal(parseEtime('3-02:05:09'), 3 * 86400 + 7509);
  assert.equal(parseEtime('garbage'), undefined);
  if (process.platform !== 'win32') {
    const seconds = await processUptime(process.pid, undefined);
    assert.ok(seconds !== undefined && seconds >= 0 && seconds < 3600, String(seconds));
  }
});

test('status: reports a running gateway, agents, tasks, failures and keys, and changes nothing', async (t) => {
  const g = await injectedGateway(t);
  // A published agent whose adapter is not configured on this machine can never run here.
  await g.admin.request(
    'POST',
    '/v1/agents/publish',
    makeBundle(
      agentSchema.parse({
        id: 'agent/ghost',
        description: 'ghost',
        engine: 'adapter/ghost',
        provider: 'native',
        model: 'default',
        instructions: '',
        tools: [],
        allowGraph: false,
        routes: [{ id: 'default', provider: 'native', model: 'default', priority: 0 }],
      }),
    ),
  );
  const start = async () => {
    const r = await g.admin.request<{ id: string }>('POST', '/v1/invoke', {
      protocol: 'oaa/1',
      agent: 'agent/sample',
      input: 'please ask for approval',
      background: true,
    });
    await until(async () => (await listPending(g.admin)).pending.some((a) => a.run_id === r.id));
    return r.id;
  };
  const denied = await start();
  await decideApprovals(g.admin, {
    run: denied,
    decision: 'deny',
    interactive: false,
    out: () => {},
  });
  await g.admin.request('GET', `/v1/runs/${denied}/wait?timeout_ms=15000`);
  const waiting = await start();

  const methods: string[] = [];
  const injected = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return injected(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = injected;
  });
  const before = await g.admin.request<{ data: unknown[] }>('GET', '/v1/runs?limit=50');
  const report = await gatherStatus(await endpointFor(g));
  assert.deepEqual(
    [...new Set(methods)].filter((m) => m !== 'GET'),
    [],
    'status only reads',
  );

  assert.equal(report.running, true);
  assert.match(report.version ?? '', /^\d+\.\d+\.\d+/);
  assert.equal(report.data_dir, g.config.dataDir);
  assert.ok((report.database_bytes ?? 0) > 0);
  assert.equal(report.keys, 2);
  assert.deepEqual(report.tasks, { active: 1, queued: 0, running: 0, awaiting_approval: 1 });
  const sample = report.agents?.find((a) => a.id === 'agent/sample');
  assert.equal(sample?.runnable, true);
  const ghost = report.agents?.find((a) => a.id === 'agent/ghost');
  assert.equal(ghost?.runnable, false);
  assert.match(
    ghost?.reason?.en ?? '',
    /adapter\/ghost.*not configured under localWorker\.adapters/,
  );
  assert.match(ghost?.reason?.zh ?? '', /没有配置/);
  assert.equal(report.recent_failures?.length, 1);
  assert.equal(report.recent_failures?.[0]?.run_id, denied);
  assert.equal(report.recent_failures?.[0]?.code, 'permission_denied');
  assert.deepEqual(report.unavailable, {});

  const text = renderStatus(report, 'en').join('\n');
  assert.match(text, /^Gateway: running/);
  assert.match(text, /Address {2,}http:\/\/127\.0\.0\.1:9/);
  assert.match(text, /Published agents \(2\)/);
  assert.match(text, /agent\/sample\s+adapter\/oaa-sample\s+runnable/);
  assert.match(text, /agent\/ghost\s+adapter\/ghost\s+not runnable \(unavailable\)/);
  assert.match(text, /Tasks: running 0, queued 0, awaiting approval 1 \(oaa approvals\)/);
  assert.match(text, /Recent failed tasks \(1\)/);
  assert.match(renderStatus(report, 'zh').join('\n'), /网关：运行中[\s\S]*待审批 1/);
  assert.ok(!text.includes(token), 'the key is never printed');

  const after = await g.admin.request<{ data: unknown[] }>('GET', '/v1/runs?limit=50');
  assert.equal(after.data.length, before.data.length, 'no task was created');
  assert.equal(
    (await g.admin.request<{ status: string }>('GET', `/v1/runs/${waiting}/state`)).status,
    'requires_action',
  );
});

test('status: a key that may not read admin data still gets the rest, with notes', async (t) => {
  const g = await injectedGateway(t);
  const report = await gatherStatus(await endpointFor(g, callerToken));
  assert.equal(report.running, true);
  assert.ok(report.agents?.some((a) => a.id === 'agent/sample'));
  assert.equal(report.keys, undefined);
  assert.equal(report.unavailable.keys, 'scope_denied');
  assert.equal(report.unavailable.local_backends, 'scope_denied');
  const text = renderStatus(report, 'en').join('\n');
  assert.match(text, /Published agents/);
});

test('status: no key at all shows only what needs none; JSON output parses and has no secrets', async (t) => {
  const g = await injectedGateway(t);
  const lines: string[] = [];
  const running = await showStatus(
    { dir: path.join(g.dir, 'none'), url: BASE },
    { json: true, out: (l) => lines.push(l) },
  );
  assert.equal(running, true);
  const parsed = JSON.parse(lines.join('\n')) as StatusReport;
  assert.equal(parsed.running, true);
  assert.equal(parsed.unavailable.key, 'token_required');
  assert.equal(parsed.agents, undefined);
  assert.match(renderStatus(parsed, 'en').join('\n'), /No usable key was found/);
});

test('status: a gateway that is not running gives a clear message, not a stack trace', async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'oaa-status-'));
  try {
    const lines: string[] = [];
    const running = await showStatus(
      { dir: empty, url: 'http://127.0.0.1:9' },
      { out: (l) => lines.push(l), locale: 'en' },
    );
    assert.equal(running, false);
    assert.match(lines.join('\n'), /^Gateway: not running \(http:\/\/127\.0\.0\.1:9\)/);
    assert.match(lines.join('\n'), /oaa quickstart/);
    const cli = path.resolve('dist/src/cli.js');
    const env = { ...process.env, OAA_LOCALE: 'zh', OAA_TOKEN_FILE: '', OAA_GATEWAY_URL: '' };
    const failed = await run(
      process.execPath,
      [cli, 'status', '--dir', empty, '--url', 'http://127.0.0.1:9'],
      {
        env,
      },
    ).catch((e: { stdout: string; stderr: string; code: number }) => e);
    assert.equal((failed as { code: number }).code, 1, 'exit code 1 when the gateway is down');
    assert.match((failed as { stdout: string }).stdout, /^网关：没有在运行/);
    assert.equal((failed as { stderr: string }).stderr, '');
    const json = await run(
      process.execPath,
      [cli, 'status', '--json', '--dir', empty, '--url', 'http://127.0.0.1:9'],
      { env },
    ).catch((e: { stdout: string }) => e);
    assert.equal((JSON.parse((json as { stdout: string }).stdout) as StatusReport).running, false);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('status: agents found on the machine but not connected are listed with their connect command', () => {
  const report: StatusReport = {
    running: true,
    url: 'http://127.0.0.1:8787',
    unavailable: {},
    agents: [],
    detected: [{ name: 'Codex', engine: 'codex', connect: 'oaa connect codex' }],
  };
  const text = renderStatus(report, 'en').join('\n');
  assert.match(text, /Detected on this machine, not connected\n {2}Codex: oaa connect codex/);
});

test('status: shows the security profile, and warns when the gateway looks exposed while it is still local', () => {
  const base: StatusReport = {
    running: true,
    url: 'http://0.0.0.0:8787',
    unavailable: {},
    agents: [],
  };
  const plain = renderStatus({ ...base, security: { profile: 'local' } }, 'en').join('\n');
  assert.match(plain, /Security profile: local\n/);
  assert.doesNotMatch(plain, /Warning: the gateway may be reachable/);
  const exposed = renderStatus(
    { ...base, security: { profile: 'local', exposure_reasons: ['host=0.0.0.0'] } },
    'en',
  ).join('\n');
  assert.match(
    exposed,
    /Security profile: local\n {2}Warning: the gateway may be reachable from outside \(host=0\.0\.0\.0\)/,
  );
  assert.match(
    renderStatus(
      { ...base, security: { profile: 'local', exposure_reasons: ['publicBaseUrl'] } },
      'zh',
    ).join('\n'),
    /安全档位：local\n {2}提示：网关看起来可能对外暴露（publicBaseUrl）/,
  );
  assert.match(
    renderStatus({ ...base, running: false, security: { profile: 'public' } }, 'en').join('\n'),
    /Security profile: public/,
  );
});

test('status: the security profile comes from the local configuration', async (t) => {
  const g = await injectedGateway(t);
  const report = await gatherStatus(await endpointFor(g));
  assert.deepEqual(report.security, { profile: 'local' });
});
