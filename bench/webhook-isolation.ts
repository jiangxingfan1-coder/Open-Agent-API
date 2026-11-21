// One noisy owner, another owner making real loopback requests. No external model, URL or key.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { sha } from '../src/core/util.js';
import { WebhookDb, MAX_PENDING_DELIVERIES } from '../src/gateway/webhook-db.js';
import { makeBundle } from '../src/lang/bundle.js';
import { agent, token, setup, waitFor } from '../test/helpers.js';

const { values } = parseArgs({
  options: {
    samples: { type: 'string', default: '256' },
    depth: { type: 'string', default: '4000' },
    out: { type: 'string' },
  },
});
const samples = Number(values.samples),
  depth = Number(values.depth),
  clients = 4,
  endpoints = 8;
assert.ok(
  Number.isSafeInteger(samples) &&
    samples >= clients &&
    Number.isSafeInteger(depth) &&
    depth > 0 &&
    2 * depth <= MAX_PENDING_DELIVERIES,
);
type Mode = 'empty' | 'backoff' | 'recovering';
const schema = {
  events: ['run.completed'],
  agents: [],
  include_output: false,
  enabled: true,
  description: '',
  allow_insecure_http: false,
  allow_private_network: false,
};

function seed(db: WebhookDb, url: string, mode: Mode) {
  if (mode === 'empty') return;
  const until = Date.now() + 3600000,
    now = Date.now();
  const ids = Array.from(
    { length: endpoints },
    () => db.create('second', { ...schema, url }).endpoint.id,
  );
  const materialize = db.db.prepare(`INSERT INTO webhook_deliveries
    (id,endpoint_id,owner,event_id,event_type,run_id,dedupe,status,next_at,seed,created_at,updated_at)
    VALUES(?,?,'second',?,'run.completed',?,?,'pending',?,?,?,?)`);
  const stage = db.db.prepare(
    'INSERT INTO webhook_outbox(owner,source_seq,endpoint_id,dedupe,input,created_at,retry_at) VALUES(?,?,?,?,?,?,?)',
  );
  db.db.exec('BEGIN IMMEDIATE');
  try {
    const hash = sha(url);
    for (let i = 0; i < 2 * depth; i++) {
      const runId = 'bulk_run_' + i,
        eventId = 'evt_' + i,
        dedupe = runId + ':run.completed';
      const data = {
        run_id: runId,
        agent: 'agent/noisy',
        target_hash: hash,
        snapshot: { run_id: runId, status: 'completed' },
      };
      for (const ep of ids) {
        if (i < depth)
          materialize.run(
            ep + '_' + i,
            ep,
            eventId,
            runId,
            dedupe,
            until,
            JSON.stringify(data),
            now,
            now,
          );
        else
          stage.run(
            'second',
            i + 1,
            ep,
            dedupe,
            JSON.stringify({
              owner: 'second',
              endpointId: ep,
              eventId,
              eventType: 'run.completed',
              runId,
              dedupe,
              createdAt: now,
              seed: data,
            }),
            now,
            mode === 'backoff' ? until : 0,
          );
      }
    }
    db.db.exec('COMMIT');
  } catch (e) {
    db.db.exec('ROLLBACK');
    throw e;
  }
}
function headTimes(db: WebhookDb) {
  const median = (f: () => unknown) => {
    const times: number[] = [];
    for (let i = 0; i < 35; i++) {
      const t = performance.now();
      f();
      if (i >= 5) times.push(performance.now() - t);
    }
    return Number(times.sort((a, b) => a - b)[15]!.toFixed(4));
  };
  return { capture_ms: median(() => db.stageHeads(16)), delivery_ms: median(() => db.heads()) };
}
type Reply = {
  receiver?: string;
  error?: string;
  verified?: number;
  submit_ms?: unknown;
  notification_ms?: unknown;
};
function reply(child: ChildProcess) {
  return new Promise<Reply>((resolve, reject) => {
    const timeout = setTimeout(() => end(new Error('Fixture client stopped answering')), 90000);
    const message = (value: Reply) => end(value.error ? new Error(value.error) : null, value);
    const exit = () => end(new Error('Fixture client exited before reporting'));
    const end = (error: Error | null, value?: Reply) => {
      clearTimeout(timeout);
      child.off('message', message);
      child.off('exit', exit);
      child.off('error', end);
      if (error) reject(error);
      else resolve(value!);
    };
    child.once('message', message);
    child.once('exit', exit);
    child.once('error', end);
  });
}
async function measure(mode: Mode) {
  const s = await setup();
  const child = fork(new URL('./webhook-isolation-client.js', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let monitor: NodeJS.Timeout | undefined;
  try {
    const { receiver } = await reply(child);
    assert.ok(receiver);
    s.store.publish('owner', makeBundle(agent()));
    const ep = await s.request('POST', '/v1/webhooks', {
      url: receiver + '/quiet',
      events: ['run.completed'],
    });
    assert.equal(ep.statusCode, 201);
    const { secret, id } = ep.json(),
      base = await s.listen(),
      db = new WebhookDb(s.store.db);
    const sample = async (n: number) => {
      const result = reply(child);
      child.send({ base, token, secret, samples: n, clients });
      return result;
    };
    await sample(24);
    await waitFor(() => db.pendingCount(id) === 0);
    seed(db, receiver + '/noisy', mode);
    const query = headTimes(db);
    const started = performance.now();
    let recoveryMs: number | null = null;
    if (mode === 'recovering')
      monitor = setInterval(() => {
        if (!db.hasStagedOwner('second')) {
          recoveryMs = Number((performance.now() - started).toFixed(1));
          clearInterval(monitor);
        }
      }, 10);
    const measured = await sample(samples);
    const loadMs = Number((performance.now() - started).toFixed(1));
    await waitFor(() => db.pendingCount(id) === 0);
    const count = (table: 'webhook_outbox' | 'webhook_deliveries') =>
      Number(
        db.db.prepare('SELECT count(*) AS n FROM ' + table + " WHERE owner='second'").get()!.n,
      );
    const staged = count('webhook_outbox'),
      ready = count('webhook_deliveries'),
      initial = mode === 'empty' ? 0 : endpoints * depth;
    assert.equal(staged + ready, 2 * initial);
    if (mode === 'backoff') assert.equal(staged, initial);
    if (mode === 'recovering') {
      assert.ok(staged < initial);
      await waitFor(() => recoveryMs !== null, 120000);
      assert.equal(
        count('webhook_deliveries'),
        2 * initial,
        'the complete recovery backlog was transferred',
      );
    }
    return {
      mode,
      initial_staged: initial,
      initial_materialized: initial,
      staged_at_end: staged,
      quiet_load_ms: loadMs,
      full_promotion_ms: recoveryMs,
      head_query: query,
      ...measured,
    };
  } finally {
    clearInterval(monitor);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      if (child.connected) child.disconnect();
      await exited;
    }
    await s.cleanup();
  }
}
const cases = [];
for (const mode of ['empty', 'backoff', 'recovering'] as const) cases.push(await measure(mode));
const report = {
  format: 'oaa.webhook-isolation.v1',
  node: process.version,
  fixture_model: true,
  external_requests: 0,
  samples_per_case: samples,
  warmup: 24,
  clients,
  noisy_endpoints: endpoints,
  depth_per_queue: depth,
  db_source_sha256: sha(await readFile('src/gateway/webhook-db.ts', 'utf8')),
  scheduler_source_sha256: sha(await readFile('src/gateway/webhook-outbox.ts', 'utf8')),
  workload_sha256: sha(
    (await readFile('bench/webhook-isolation.ts', 'utf8')) +
      (await readFile('bench/webhook-isolation-client.ts', 'utf8')),
  ),
  cases,
};
const result = JSON.stringify(report, null, 2) + '\n';
if (values.out) await writeFile(values.out, result, { flag: 'wx' });
process.stdout.write(result);
