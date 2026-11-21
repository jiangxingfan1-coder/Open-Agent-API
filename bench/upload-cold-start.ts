// Restart the gateway process on the same database. The HTTP client and its probe clock stay outside it.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  cloneCatalog,
  fileResidency,
  observeFallback,
  withholdReader,
} from './upload-fallback-probe.js';

const { values } = parseArgs({
  options: {
    accounts: { type: 'string', default: '8' },
    rows: { type: 'string', default: '64000' },
    restarts: { type: 'string', default: '8' },
    uncapped: { type: 'boolean' },
    compare: { type: 'string' },
    'helper-timeout': { type: 'boolean' },
    'fresh-copy': { type: 'boolean' },
    'page-probe': { type: 'string' },
    out: { type: 'string' },
    root: { type: 'string' },
    round: { type: 'string' },
  },
});
const accounts = Number(values.accounts),
  rows = Number(values.rows),
  restarts = Number(values.restarts);
assert.ok(Number.isInteger(accounts) && accounts >= 2 && accounts <= 32);
assert.ok(Number.isInteger(rows) && rows >= 0 && rows * accounts <= 4_194_304);
assert.ok(Number.isInteger(restarts) && restarts >= 1 && restarts <= 64);
if (values['helper-timeout']) assert.ok(!values.uncapped && rows >= 4096);
const owner = (i: number) => 'cold-fixture-' + i;
const token = (i: number) => 'test-cold-quota-local-fixture-only-' + i;
const bytes = 77,
  content = 'x'.repeat(128),
  probes = 20,
  spacing = 2;
async function seed(root: string) {
  const { Store } = await import('../src/store/store.js');
  const s = new Store(root);
  try {
    const quiet = await s.addFile(
      owner(accounts),
      'quiet',
      Buffer.from('quiet'),
      undefined,
      undefined,
      'config:' + owner(accounts),
    );
    s.db.exec('BEGIN IMMEDIATE');
    const ins = s.prepare('INSERT INTO files(id,owner,subject,payload) VALUES(?,?,?,?)');
    for (let j = 0; j < accounts; j++) {
      const o = owner(j);
      for (let i = 0; i < rows; i++) {
        const hex = (j * rows + i).toString(16),
          id = 'file_' + hex.padStart(32, '0');
        ins.run(
          id,
          o,
          'config:' + o,
          JSON.stringify({
            id,
            owner: o,
            name: 'history',
            bytes,
            sha256: hex.padStart(64, '0'),
            createdAt: 1,
          }),
        );
      }
    }
    s.db.exec('COMMIT');
    return quiet.id;
  } finally {
    if (s.db.isTransaction) s.db.exec('ROLLBACK');
    s.close();
  }
}
async function gateway() {
  assert.ok(values.root);
  const round = Number(values.round);
  const { setup }: typeof import('../test/helpers.js') = values.compare
    ? await import(pathToFileURL(path.resolve(values.compare, 'test/helpers.js')).href)
    : await import('../test/helpers.js');
  const keys = Array.from({ length: accounts + 1 }, (_, i) => {
    const tokenEnv = 'OAA_COLD_FIXTURE_' + i;
    process.env[tokenEnv] = token(i);
    return { name: owner(i), owner: owner(i), scopes: ['files'], tokenEnv, quota: { rpm: 100000 } };
  });
  const start = performance.now();
  const restore = values['helper-timeout'] ? withholdReader() : undefined;
  const s = await setup(undefined, {
    dataDir: values.root,
    keys,
    ...(!values.uncapped && {
      maxStoredBytesPerSubject: rows * bytes + (round + 1) * 2 * content.length,
    }),
  });
  try {
    const disconnected = once(process, 'disconnect');
    process.send!({ base: await s.listen(), ready: performance.now() - start });
    await disconnected;
  } finally {
    restore?.();
    await s.cleanup();
  }
}
const stats = (times: number[]) => {
  if (!times.length) return { count: 0, p50: null, p95: null, p99: null, max: null };
  const a = times.toSorted((x, y) => x - y),
    at = (p: number) => +a[Math.ceil(p * a.length) - 1]!.toFixed(2);
  return { count: a.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};
const sample = () => ({
  uploads: [] as number[],
  quiet: [] as number[],
  lag: [] as number[],
  wave: [] as number[],
  quietGaps: [] as number[],
  lateProbes: 0,
});
const measurements = () => ({
  cold: sample(),
  warm: sample(),
  startup: [] as number[],
  fallback: [] as Awaited<ReturnType<typeof observeFallback>>[],
  residency: [] as Awaited<ReturnType<typeof fileResidency>>[],
  initialResidency: [] as Awaited<ReturnType<typeof fileResidency>>[],
  beforeDeadline: [] as (Awaited<ReturnType<typeof fileResidency>> & { sample_ms: number })[],
  afterCold: [] as Awaited<ReturnType<typeof fileResidency>>[],
});
async function measure() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-cold-quota-'));
  try {
    const quietId = await seed(root),
      current = measurements(),
      prior = measurements(),
      ids = new Set<string>();
    const processes = restarts * (values.compare ? 2 : 1);
    for (let round = 0; round < processes; round++) {
      // AB, BA: each version sees the first and second position equally often.
      const before = !!values.compare && (round % 4 === 0 || round % 4 === 3);
      const {
        cold,
        warm,
        startup,
        fallback,
        residency,
        initialResidency,
        beforeDeadline,
        afterCold,
      } = before ? prior : current;
      if (values['fresh-copy']) await cloneCatalog(root);
      const probePages = values['page-probe']
        ? () => fileResidency(root, values['page-probe']!)
        : undefined;
      if (probePages) initialResidency.push(await probePages());
      const args = [
        '--accounts',
        String(accounts),
        '--rows',
        String(rows),
        '--round',
        String(round),
        '--root',
        root,
      ];
      if (values.uncapped) args.push('--uncapped');
      if (values['helper-timeout']) args.push('--helper-timeout');
      if (before) args.push('--compare', values.compare!);
      const child = fork(import.meta.filename, args, {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const ended = once(child, 'exit');
      try {
        const { base, ready } = await Promise.race([
          once(child, 'message', { signal: AbortSignal.timeout(120000) }).then(
            ([m]) => m as { base: string; ready: number },
          ),
          ended.then(() => {
            throw Error('Gateway exited before listening');
          }),
        ]);
        startup.push(ready);
        const post = (i: number, payload = content) =>
          fetch(base + '/v1/files', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token(i), 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'burst', content: payload }),
            signal: AbortSignal.timeout(30000),
          });
        const read = async () => {
          const r = await fetch(base + '/v1/files/' + quietId + '/content', {
            headers: { authorization: 'Bearer ' + token(accounts) },
            signal: AbortSignal.timeout(30000),
          });
          assert.equal(r.status, 200);
          assert.equal(await r.text(), 'quiet');
        };
        // Establish HTTP connections without checking any measured account's upload quota.
        await Promise.all(Array.from({ length: accounts + probes }, () => read()));
        if (probePages) residency.push(await probePages());
        for (const phase of [cold, warm]) {
          const start = performance.now();
          let finished = Infinity;
          const arrivals: number[] = [];
          const probe = async () => {
            const at = performance.now();
            await read();
            const end = performance.now();
            phase.quiet.push(end - at);
            arrivals.push(end);
          };
          await Promise.all([
            phase === cold && values['helper-timeout'] && probePages
              ? delay(4500).then(async () => {
                  const pages = await probePages();
                  beforeDeadline.push({ ...pages, sample_ms: performance.now() - start });
                })
              : undefined,
            phase === cold && values['helper-timeout']
              ? observeFallback(child, accounts, start, read, () => finished).then((r) =>
                  fallback.push(r),
                )
              : undefined,
            Promise.all(
              Array.from({ length: accounts }, async (_, i) => {
                const t = performance.now(),
                  r = await post(i),
                  j = await r.json();
                assert.equal(r.status, 200, JSON.stringify(j));
                assert.equal(j.bytes, content.length);
                assert.ok(typeof j.id === 'string' && !ids.has(j.id));
                ids.add(j.id);
                phase.uploads.push(performance.now() - t);
              }),
            ).finally(() => {
              finished = performance.now();
              phase.wave.push(finished - start);
            }),
            Promise.all(
              Array.from({ length: probes }, async (_, i) => {
                const target = start + (i + 1) * spacing;
                await delay(Math.max(0, target - performance.now()));
                const t = performance.now();
                phase.lag.push(Math.max(0, t - target));
                await probe();
              }),
            ),
            (async () => {
              await delay(probes * spacing + spacing);
              // Cover slow disks and helper fallback after the initial open-loop burst,
              // without adding unbounded load when the gateway is unable to answer.
              while (finished === Infinity) {
                phase.lateProbes++;
                await probe();
                await delay(5);
              }
            })(),
          ]);
          if (phase === cold && probePages) afterCold.push(await probePages());
          const points = [
            start,
            ...arrivals.filter((n) => n < finished).sort((a, b) => a - b),
            finished,
          ];
          phase.quietGaps.push(Math.max(...points.slice(1).map((n, i) => n - points[i]!)));
        }
        if (!values.uncapped) {
          for (let i = 0; i < accounts; i++) {
            const r = await post(i, 'x');
            assert.equal(r.status, 413);
            assert.equal((await r.json()).error.code, 'storage_quota_exceeded');
          }
        }
      } finally {
        if (child.connected) child.disconnect();
        assert.equal((await ended)[0], 0);
      }
    }
    const db = new DatabaseSync(path.join(root, 'state.sqlite'), { readOnly: true });
    try {
      const all = db.prepare(
        "SELECT count(*) AS n,sum(json_extract(payload,'$.bytes')) AS bytes FROM files WHERE owner=? AND subject=?",
      );
      for (let i = 0; i < accounts; i++) {
        const r = all.get(owner(i), 'config:' + owner(i))!;
        assert.equal(r.n, rows + processes * 2);
        assert.equal(r.bytes, rows * bytes + processes * 2 * content.length);
      }
      assert.equal(db.prepare('SELECT count(*) AS n FROM oaa_inline_inputs').get()!.n, 0);
    } finally {
      db.close();
    }
    const describe = (p: ReturnType<typeof sample>) => ({
      upload_ms: stats(p.uploads),
      other_owner_read_ms: stats(p.quiet),
      wave_ms: stats(p.wave),
      client_timer_lag_ms: stats(p.lag),
      max_quiet_response_gap_per_wave_ms: stats(p.quietGaps),
      late_probes: p.lateProbes,
      wave_samples_ms: p.wave.map((n) => +n.toFixed(2)),
    });
    const summarize = (x: ReturnType<typeof measurements>) => ({
      ready_ms: stats(x.startup),
      cold: describe(x.cold),
      warm: describe(x.warm),
      ...(x.fallback.length
        ? {
            fallback: {
              timeout_observed_ms: stats(x.fallback.map((r) => r.timeout_observed_ms)),
              recount_and_accept_ms: stats(x.fallback.map((r) => r.recount_and_accept_ms)),
              other_owner_read_ms: stats(x.fallback.flatMap((r) => r.read_ms)),
              fixed_cadence_read_ms: stats(x.fallback.flatMap((r) => r.fixed_read_ms)),
              max_quiet_gap_per_wave_ms: stats(x.fallback.map((r) => r.max_quiet_gap_ms)),
              withheld_worker_messages: x.fallback.reduce((n, r) => n + r.withheld, 0),
            },
          }
        : {}),
      ...(x.residency.length
        ? {
            catalog_before_process: x.initialResidency,
            catalog_before_upload: x.residency,
            catalog_after_cold: x.afterCold,
            ...(x.beforeDeadline.length
              ? {
                  catalog_near_timeout: x.beforeDeadline.map((p, i) => ({
                    ...p,
                    before_timeout: p.sample_ms < x.fallback[i]!.timeout_observed_ms,
                  })),
                }
              : {}),
          }
        : {}),
    });
    const report = {
      fixture:
        'Fresh gateway processes, same disk database; synthetic file history, actual HTTP uploads and reads. Host OS disk cache is not flushed. No model calls.',
      node: process.version,
      accounts,
      rows_per_account: rows,
      restarts,
      quota: !values.uncapped,
      forced_helper_timeout: !!values['helper-timeout'],
      fresh_fixture_inode: !!values['fresh-copy'],
      per_wave_probes: probes,
      probe_interval_ms: spacing,
      verified_uploads: ids.size,
      verified_one_byte_rejections: values.uncapped ? 0 : accounts * processes,
      ...(values.compare
        ? { order: 'AB/BA, shared fixture', before: summarize(prior), after: summarize(current) }
        : summarize(current)),
    };
    const data = JSON.stringify(report, null, 2) + '\n';
    if (values.out) await writeFile(values.out, data, { flag: 'wx' });
    process.stdout.write(data);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
if (process.send) await gateway();
else await measure();
