import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageConfiguration } from '../src/config/usage-monitor.js';
import { UsageMonitor } from '../src/gateway/usage-monitor.js';
import { collectUsageSource } from '../src/engines/usage-collectors.js';
import { parseCodexBar } from '../src/engines/usage-parsers.js';
import { usageSettingsSchema } from '../src/core/usage-monitor.js';
import { Fault } from '../src/core/util.js';
import { setup } from './helpers.js';

test('public gateways do not even open local collector settings', async (t) => {
  let reads = 0;
  t.mock.method(UsageConfiguration.prototype, 'read', async () => {
    reads++;
    return usageSettingsSchema.parse({});
  });
  const s = await setup(undefined, { security: { profile: 'public' } });
  try {
    assert.equal((await s.request('GET', '/v1/local/usage')).statusCode, 403);
    assert.equal(reads, 0);
  } finally {
    await s.cleanup();
  }
});

test('collector configuration revalidates authority before committing', async () => {
  const s = await setup(),
    monitor = new UsageMonitor(path.join(s.dir, 'isolated-monitor'));
  try {
    const before = await monitor.view();
    await assert.rejects(
      monitor.configure(
        { ...before.settings, ccusage: { enabled: false, executable: '/not-used' } },
        before.revision,
        () => {
          throw new Fault('scope_denied', 'Revoked', 403);
        },
      ),
      { code: 'scope_denied' },
    );
    assert.equal((await monitor.view()).revision, before.revision);
  } finally {
    await monitor.close();
    await s.cleanup();
  }
});

test('failed quota refresh retains the old observation without making it current', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const s = await setup(),
    monitor = new UsageMonitor(path.join(s.dir, 'isolated-monitor'));
  try {
    const file = path.join(s.dir, 'snapshot.json');
    await writeFile(
      file,
      JSON.stringify({
        provider: 'codex',
        usage: { updatedAt: new Date(now).toISOString(), primary: { usedPercent: 25 } },
      }),
      { mode: 0o600 },
    );
    const before = await monitor.view();
    await monitor.configure(
      { ...before.settings, codexbar: { ...before.settings.codexbar, enabled: true, file } },
      before.revision,
    );
    await monitor.refresh();
    const first = (await monitor.view()).sources.codexbar.data!.accounts[0]!;
    now += 31000;
    await writeFile(
      file,
      JSON.stringify({ provider: 'codex', error: { message: 'SECRET-MUST-NOT-LEAK' } }),
    );
    await monitor.refresh();
    const failed = (await monitor.view()).sources.codexbar;
    assert.equal(failed.status, 'error');
    assert.equal(failed.data!.accounts[0]!.status, 'stale');
    assert.equal(failed.data!.accounts[0]!.observed_at, first.observed_at);
    assert.equal(failed.data!.accounts[0]!.windows[0]!.remaining_percent, 75);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
  } finally {
    await monitor.close();
    await s.cleanup();
  }
});

test('monetary budget and prepaid balance retain distinct freshness and units', () => {
  const now = Date.now();
  const value = {
    provider: 'grok',
    usage: {
      updatedAt: new Date(now).toISOString(),
      providerCost: {
        used: 12.25,
        limit: 100,
        currencyCode: 'USD',
        balance: 0,
        balanceUpdatedAt: new Date(now - 3600000).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    },
  };
  const row = parseCodexBar(value, now).accounts[0]!;
  assert.equal(row.budget?.remaining, 87.75);
  assert.equal(row.budget?.stale, false);
  assert.equal(row.balance?.remaining, 0);
  assert.equal(row.balance?.stale, true);
  const balanceOnly = parseCodexBar({
    ...value,
    usage: { ...value.usage, providerCost: { ...value.usage.providerCost, used: 0, limit: 0 } },
  }).accounts[0]!;
  assert.equal(balanceOnly.budget, null);
  const unavailable = parseCodexBar({
    ...value,
    usage: {
      ...value.usage,
      providerCost: { ...value.usage.providerCost, balanceIsUnavailable: true },
    },
  }).accounts[0]!;
  assert.equal(unavailable.balance, null);
});

test(
  'collector nonzero JSON preserves valid rows as an explicitly partial report',
  { skip: process.platform === 'win32' },
  async () => {
    const s = await setup();
    try {
      const file = path.join(s.dir, 'collector');
      const result = [
        {
          provider: 'codex',
          usage: { updatedAt: new Date().toISOString(), primary: { usedPercent: 50 } },
        },
        {
          provider: 'codex',
          account: 'second',
          error: { message: 'private credential diagnostic' },
        },
      ];
      await writeFile(
        file,
        `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(result))});process.exitCode=1;`,
      );
      await chmod(file, 0o700);
      const settings = usageSettingsSchema.parse({
        codexbar: {
          enabled: true,
          mode: 'cli',
          source: 'cli',
          providers: ['codex'],
          executable: file,
        },
      });
      const data = await collectUsageSource(
        'codexbar',
        settings,
        s.dir,
        new AbortController().signal,
      );
      assert.equal(data.partial, true);
      assert.equal(data.accounts[0]!.windows[0]!.remaining_percent, 50);
      assert.equal(data.accounts[1]!.status, 'unavailable');
      assert.doesNotMatch(JSON.stringify(data), /private credential/);
    } finally {
      await s.cleanup();
    }
  },
);

test(
  'collector output and process lifetime are bounded without leaking diagnostics',
  { skip: process.platform === 'win32' },
  async () => {
    const s = await setup();
    try {
      const file = path.join(s.dir, 'collector');
      const settings = usageSettingsSchema.parse({ ccusage: { enabled: true, executable: file } });
      await writeFile(
        file,
        `#!${process.execPath}\nprocess.stderr.write('SECRET');process.stdout.write('x'.repeat(2200000));`,
      );
      await chmod(file, 0o700);
      await assert.rejects(
        collectUsageSource('ccusage', settings, s.dir, new AbortController().signal),
        { code: 'output_too_large' },
      );
      await writeFile(file, `#!${process.execPath}\nsetInterval(()=>{},1000);`);
      await assert.rejects(
        collectUsageSource('ccusage', settings, s.dir, AbortSignal.timeout(100)),
        { code: 'cancelled' },
      );
    } finally {
      await s.cleanup();
    }
  },
);
