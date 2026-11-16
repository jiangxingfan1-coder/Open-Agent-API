import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCodexBar, parseCcusage } from '../src/engines/usage-parsers.js';
import { collectUsageSource } from '../src/engines/usage-collectors.js';
import { usageSettingsSchema } from '../src/core/usage-monitor.js';
import { UsageMonitor } from '../src/gateway/usage-monitor.js';
import { usageReport } from '../src/store/usage-monitor.js';
import { makeBundle } from '../src/lang/bundle.js';
import { setup, agent, FixtureModel, principal, secondToken } from './helpers.js';

const quota = (now = Date.now()) => ({
  provider: 'codex',
  source: 'oauth',
  usage: {
    updatedAt: new Date(now).toISOString(),
    primary: {
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: new Date(now + 3600000).toISOString(),
    },
    identity: { accountEmail: 'person@example.test', accountID: 'private-account' },
  },
  credits: { remaining: 0 },
  diagnostic: 'private-secret',
  openaiDashboard: { signedInEmail: 'person@example.test' },
  token: 'private-secret',
});

test('quota normalization preserves measured zero and never exposes raw identity or diagnostics', () => {
  const row = parseCodexBar([quota()]).accounts[0]!;
  assert.equal(row.windows[0]!.remaining_percent, 75);
  assert.equal(row.balance?.remaining, 0);
  assert.equal(row.balance?.unit, 'credits');
  assert.equal(row.account, 'pe***@example.test');
  assert.equal(row.status, 'reported');
  assert.doesNotMatch(JSON.stringify(row), /private-secret|private-account|person@example/);
});
test('synthetic and unknown quota windows never turn into a fabricated full allowance', () => {
  const value = quota();
  const usage = {
    ...value.usage,
    primary: { usedPercent: 0, isSyntheticPlaceholder: true },
    secondary: { usedPercent: 0 },
    extraRateWindows: [
      {
        id: 'later',
        title: 'Later window',
        usageKnown: false,
        window: { usedPercent: 0, resetsAt: new Date(Date.now() + 60000).toISOString() },
      },
    ],
  };
  const row = parseCodexBar({ ...value, usage }).accounts[0]!;
  assert.equal(row.windows.length, 2);
  assert.equal(row.windows[0]!.remaining_percent, 100);
  assert.equal(row.windows[1]!.remaining_percent, null);
  assert.equal(row.windows[1]!.label, 'Later window');
});
test('quota data expires by observation/reset time, not by the time it was imported', () => {
  const now = Date.now();
  assert.equal(parseCodexBar(quota(now - 3600000), now).accounts[0]!.status, 'stale');
  assert.equal(parseCodexBar(quota(now + 120000), now).accounts[0]!.observed_at, null);
  assert.equal(
    parseCodexBar({ provider: 'qoder', error: { message: 'secret cookie' } }, now).accounts[0]!
      .status,
    'unavailable',
  );
  assert.throws(() => parseCodexBar([quota(), quota()]));
  assert.throws(() => parseCodexBar({ credentials: { token: 'secret' } }));
});

test('offline derived history is not a quota and estimates remain explicitly labeled', () => {
  const value = quota();
  const offline = parseCodexBar({ ...value, source: 'offline' }).accounts[0]!;
  assert.equal(offline.status, 'unavailable');
  assert.deepEqual(offline.windows, []);
  assert.equal(offline.balance, null);
  const estimated = parseCodexBar({
    ...value,
    source: 'agent-cli',
    usage: { ...value.usage, dataConfidence: 'estimated' },
  }).accounts[0]!;
  assert.equal(estimated.confidence, 'estimated');
  assert.equal(estimated.source, 'cli');
});

test('collector settings reject fan-out aliases, duplicate providers and browser sources', () => {
  for (const providers of [['all'], ['both'], ['codex', 'codex']])
    assert.throws(() => usageSettingsSchema.parse({ codexbar: { providers } }));
  for (const source of ['web', 'auto'])
    assert.throws(() => usageSettingsSchema.parse({ codexbar: { source } }));
});
test('ccusage uses per-agent rows once and retains missing cache counts as unknown', () => {
  const result = parseCcusage({
    daily: [
      {
        period: '2026-11-16',
        totalTokens: 300,
        agents: [
          { agent: 'codex', inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          {
            agent: 'claude',
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            cacheReadTokens: 0,
          },
        ],
      },
    ],
    totals: { totalTokens: 300 },
    sessions: [{ prompt: 'private' }],
  });
  assert.equal(
    result.daily.reduce((n, r) => n + r.total!, 0),
    300,
  );
  assert.equal(result.daily[0]!.cache_read, null);
  assert.equal(result.daily[1]!.cache_read, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|sessions/);
  for (const period of ['2026-99-01', '2026-02-30', 'secret'])
    assert.throws(() => parseCcusage({ daily: [{ period }] }));
});
test('OAA ledger deducts settled child totals before grouping agent usage', async () => {
  const s = await setup(
    new FixtureModel((a, messages) =>
      a.id === 'agent/child' || messages.some((m) => m.role === 'tool')
        ? { text: 'Done' }
        : { calls: [{ id: 'helper-call', name: 'helper', arguments: { task: 'Synthetic task' } }] },
    ),
  );
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/child' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          delegates: [
            {
              name: 'helper',
              agent: 'agent/child',
              description: 'fixture',
              timeoutMs: 1000,
              forwardFiles: false,
            },
          ],
        }),
      ),
    );
    const reply = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'Offline delegation',
    });
    assert.equal(reply.statusCode, 200, reply.body);
    const report = usageReport(s.store, 'owner', 7);
    assert.equal(report.totals.total, 45);
    assert.equal(report.totals.runs, 2);
    assert.equal(report.totals.requests, 1);
    assert.equal(report.agents.find((a) => a.agent === 'agent/child')?.total, 15);
    assert.equal(report.agents.find((a) => a.agent === 'agent/test')?.total, 30);
    assert.equal(usageReport(s.store, 'another-owner', 7).totals.total, 0);
  } finally {
    await s.cleanup();
  }
});
test('monitor exposes unknown usage separately from measured zero and key quota zero', async () => {
  const s = await setup(
    new FixtureModel((a) => ({
      text: 'Done',
      usage:
        a.id === 'agent/unknown' ? null : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    })),
  );
  try {
    for (const id of ['agent/unknown', 'agent/zero']) {
      s.store.publish('owner', makeBundle(agent({ id })));
      await s.request('POST', '/v1/responses', { model: id, input: 'Fixture' });
    }
    const key = await s.request('POST', '/v1/keys', {
      name: 'zero-budget',
      agents: ['agent/zero'],
      scopes: ['read', 'invoke'],
      quota: { maxRuns: 1 },
    });
    assert.equal(key.statusCode, 200, key.body);
    const consumed = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/zero', input: 'Consume one fixture run' },
      key.json().token,
    );
    assert.equal(consumed.statusCode, 200, consumed.body);
    const response = await s.request('GET', '/v1/local/usage?days=7');
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.ledger.totals.total, 0);
    assert.equal(data.ledger.totals.unknown, 1);
    assert.equal(
      data.keys.find((k: { name: string }) => k.name === 'zero-budget').remaining_runs,
      0,
    );
    assert.doesNotMatch(response.body, new RegExp(key.json().token));
    assert.equal(
      (await s.request('GET', '/v1/local/usage', undefined, key.json().token)).statusCode,
      403,
    );
    assert.equal((await s.request('GET', '/v1/local/usage?days=91')).statusCode, 400);
  } finally {
    await s.cleanup();
  }
});
test('usage routes reject remote, forwarded, cross-origin and foreign owner access', async () => {
  const s = await setup();
  try {
    assert.equal(
      (await s.request('GET', '/v1/local/usage', undefined, secondToken)).statusCode,
      403,
    );
    const cases: Record<string, string>[] = [
      { 'x-forwarded-for': '127.0.0.1' },
      { origin: 'https://evil.invalid' },
    ];
    for (const headers of cases) {
      const r = await s.request('GET', '/v1/local/usage', undefined, undefined, headers);
      assert.equal(r.statusCode, 403);
    }
    const r = await s.app.inject({
      method: 'GET',
      url: '/v1/local/usage',
      remoteAddress: '203.0.113.4',
      headers: { authorization: 'Bearer ' + process.env.OAA_TEST_TOKEN },
    });
    assert.equal(r.statusCode, 403);
  } finally {
    await s.cleanup();
  }
});
test('collector settings are opt-in, private, revision checked and recover on restart', async () => {
  const s = await setup();
  let monitor: UsageMonitor | undefined;
  try {
    const first = (await s.request('GET', '/v1/local/usage')).json().collectors;
    assert.equal(first.settings.ccusage.enabled, false);
    assert.equal(first.settings.codexbar.enabled, false);
    const settings = first.settings;
    settings.codexbar.providers = ['codex'];
    const response = await s.request('POST', '/v1/local/usage/settings', {
      settings,
      revision: first.revision,
      confirmed: true,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      (
        await s.request('POST', '/v1/local/usage/settings', {
          settings,
          revision: first.revision,
          confirmed: true,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await s.request('POST', '/v1/local/usage/settings', {
          settings,
          revision: response.json().revision,
        })
      ).statusCode,
      400,
    );
    const file = path.join(s.config.dataDir, 'usage-monitor/settings.json');
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    monitor = new UsageMonitor(s.config.dataDir);
    assert.deepEqual((await monitor.view()).settings.codexbar.providers, ['codex']);
  } finally {
    await monitor?.close();
    await s.cleanup();
  }
});
test('cache collector reads only the configured private snapshot and does not mutate it', async () => {
  const s = await setup();
  try {
    const file = path.join(s.dir, 'quota.json'),
      raw = JSON.stringify({ entries: [quota()] });
    await writeFile(file, raw, { mode: 0o600 });
    const settings = usageSettingsSchema.parse({ codexbar: { enabled: true, file } });
    const data = await collectUsageSource(
      'codexbar',
      settings,
      s.dir,
      new AbortController().signal,
    );
    assert.equal(data.accounts[0]!.windows[0]!.remaining_percent, 75);
    assert.equal(await readFile(file, 'utf8'), raw);
    await assert.rejects(
      collectUsageSource('ccusage', settings, s.dir, new AbortController().signal),
      { code: 'scope_denied' },
    );
  } finally {
    await s.cleanup();
  }
});
test(
  'collector CLI arguments stay read-only and gateway secrets are not inherited',
  { skip: process.platform === 'win32' },
  async () => {
    const s = await setup();
    try {
      const file = path.join(s.dir, 'collector'),
        argsFile = path.join(s.dir, 'arguments.json');
      await writeFile(
        file,
        `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify({args:process.argv.slice(2),hasGatewaySecret:!!process.env.OAA_TEST_TOKEN,keychain:process.env.CODEXBAR_DISABLE_KEYCHAIN_ACCESS}));console.log(JSON.stringify({daily:[]}));`,
      );
      await chmod(file, 0o700);
      const settings = usageSettingsSchema.parse({ ccusage: { enabled: true, executable: file } });
      const data = await collectUsageSource(
        'ccusage',
        settings,
        s.dir,
        new AbortController().signal,
      );
      assert.equal(data.daily.length, 0);
      const record = JSON.parse(await readFile(argsFile, 'utf8'));
      assert.ok(record.args.includes('--offline'));
      assert.ok(record.args.includes('--no-cost'));
      assert.ok(record.args.includes('--by-agent'));
      assert.equal(record.hasGatewaySecret, false);
      assert.equal(record.keychain, '1');
    } finally {
      await s.cleanup();
    }
  },
);
test('JSON imports retain aggregates only and do not enable recurring collection', async () => {
  const s = await setup();
  try {
    const r = await s.request('POST', '/v1/local/usage/import', {
      collector: 'codexbar',
      snapshot: [quota()],
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().settings.codexbar.enabled, false);
    assert.doesNotMatch(r.body, /private-secret|private-account/);
    const current = await s.request('GET', '/v1/local/usage');
    assert.equal(current.json().collectors.sources.codexbar.data.accounts.length, 1);
  } finally {
    await s.cleanup();
  }
});
