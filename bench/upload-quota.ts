// The HTTP clock runs outside the gateway. Only the pre-existing file metadata is synthetic.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { setup, secondToken, token } from '../test/helpers.js';

const { values } = parseArgs({
  options: {
    rows: { type: 'string', default: '128000' },
    samples: { type: 'string', default: '192' },
    clients: { type: 'string', default: '6' },
    uncapped: { type: 'boolean' },
    out: { type: 'string' },
  },
});
const rows = Number(values.rows),
  samples = Number(values.samples),
  clients = Number(values.clients);
assert.ok(Number.isSafeInteger(rows) && rows >= 0 && rows <= 1_000_000);
assert.ok(Number.isSafeInteger(samples) && samples >= 32 && samples <= 8192);
assert.ok(Number.isSafeInteger(clients) && clients >= 1 && clients <= 32);
const warmup = 24,
  content = 'x'.repeat(128),
  existingBytes = 77;
const limit = rows * existingBytes + (1 + warmup + samples) * content.length;
type Fixture = { base: string; quiet: string };

async function serve() {
  const s = await setup(undefined, {
    ...(!values.uncapped && { maxStoredBytesPerSubject: limit }),
    keys: [
      {
        name: 'test',
        owner: 'owner',
        tokenEnv: 'OAA_TEST_TOKEN',
        scopes: ['files'],
        quota: { rpm: 100000 },
      },
      {
        name: 'second',
        owner: 'second',
        tokenEnv: 'OAA_SECOND_TOKEN',
        scopes: ['files'],
        quota: { rpm: 100000 },
      },
    ],
  });
  try {
    const empty = await s.request('POST', '/v1/files', { filename: 'scope', content: '' });
    const quiet = await s.request(
      'POST',
      '/v1/files',
      { filename: 'quiet', content: 'quiet' },
      secondToken,
    );
    assert.equal(empty.statusCode, 200);
    assert.equal(quiet.statusCode, 200);
    const { subject } = s.store
      .prepare('SELECT subject FROM files WHERE id=?')
      .get(empty.json().id)!;
    assert.ok(typeof subject === 'string');
    const history = new DatabaseSync(path.join(s.store.root, 'state.sqlite'));
    try {
      history.exec('BEGIN IMMEDIATE');
      const insert = history.prepare('INSERT INTO files(id,owner,subject,payload) VALUES(?,?,?,?)');
      for (let i = 0; i < rows; i++) {
        const id = 'file_' + i.toString(16).padStart(32, '0');
        insert.run(
          id,
          'owner',
          subject,
          JSON.stringify({
            id,
            owner: 'owner',
            name: 'seed',
            bytes: existingBytes,
            sha256: i.toString(16).padStart(64, '0'),
            createdAt: 1,
          }),
        );
      }
      history.exec('COMMIT');
    } finally {
      history.close();
    }
    const disconnected = once(process, 'disconnect');
    process.send!({ base: await s.listen(), quiet: quiet.json().id } satisfies Fixture);
    await disconnected;
  } finally {
    await s.cleanup();
  }
}

const stats = (ms: number[]) => {
  const sorted = ms.toSorted((a, b) => a - b);
  const at = (p: number) => Number(sorted[Math.ceil(sorted.length * p) - 1]!.toFixed(2));
  return { count: ms.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};
async function measure(n: number, uncapped: boolean) {
  const args = ['--rows', String(n), '--samples', String(samples), '--clients', String(clients)];
  if (uncapped) args.push('--uncapped');
  const child = fork(import.meta.filename, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const { base, quiet } = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(120000) }).then(([m]) => m as Fixture),
      exited.then(() => {
        throw new Error('Fixture exited before listening');
      }),
    ]);
    const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    const upload = (filename: string) =>
      fetch(base + '/v1/files', {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename, content }),
        signal: AbortSignal.timeout(30000),
      });
    const ids = new Set<string>();
    const accepted = async () => {
      const start = performance.now(),
        r = await upload('measured'),
        f = await r.json();
      assert.equal(r.status, 200, JSON.stringify(f));
      assert.equal(f.bytes, content.length);
      assert.ok(typeof f.id === 'string' && !ids.has(f.id));
      ids.add(f.id);
      return performance.now() - start;
    };
    const first = await accepted();
    for (let i = 0; i < warmup; i++) await accepted();
    const uploadMs: number[] = [],
      quietMs: number[] = [];
    let remaining = samples,
      done = false;
    const start = performance.now();
    await Promise.all([
      Promise.all(
        Array.from({ length: clients }, async () => {
          while (remaining-- > 0) uploadMs.push(await accepted());
        }),
      ).finally(() => {
        done = true;
      }),
      (async () => {
        do {
          const t = performance.now(),
            r = await fetch(base + '/v1/files/' + quiet + '/content', {
              headers: { authorization: 'Bearer ' + secondToken },
              signal: AbortSignal.timeout(30000),
            });
          assert.equal(r.status, 200);
          assert.equal(await r.text(), 'quiet');
          quietMs.push(performance.now() - t);
          await delay(3);
        } while (!done);
      })(),
    ]);
    const elapsed = performance.now() - start;
    assert.equal(uploadMs.length, samples);
    const overLimit: number[] = [];
    let extras = uncapped ? 1 : samples;
    await Promise.all(
      Array.from({ length: clients }, async () => {
        while (extras-- > 0) {
          const at = performance.now(),
            extra = await upload('one-more'),
            body = await extra.json();
          assert.equal(extra.status, uncapped ? 200 : 413, JSON.stringify(body));
          if (!uncapped) assert.equal(body.error.code, 'storage_quota_exceeded');
          overLimit.push(performance.now() - at);
        }
      }),
    );
    return {
      rows: n,
      quota: !uncapped,
      first_upload_ms: +first.toFixed(2),
      upload_ms: stats(uploadMs),
      other_owner_read_ms: stats(quietMs),
      uploads_per_second: +((1000 * samples) / elapsed).toFixed(2),
      extra_status: uncapped ? 200 : 413,
      rejected_ms: uncapped ? null : stats(overLimit),
    };
  } finally {
    if (child.connected) child.disconnect();
    const [code] = await exited;
    assert.equal(code, 0);
  }
}
if (process.send) await serve();
else {
  const cases = [];
  for (const [n, uncapped] of [
    [0, false],
    [rows, true],
    [rows, false],
  ] as const)
    cases.push(await measure(n, uncapped));
  const result =
    JSON.stringify(
      {
        fixture:
          'Isolated disk-backed gateway, loopback HTTP, synthetic historical metadata, no real models or providers.',
        node: process.version,
        samples,
        clients,
        warmup,
        bytes_per_upload: content.length,
        cases,
      },
      null,
      2,
    ) + '\n';
  if (values.out) await writeFile(values.out, result, { flag: 'wx' });
  process.stdout.write(result);
}
