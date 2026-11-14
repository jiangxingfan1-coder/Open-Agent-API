import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import type { Run, RunEvent } from '../src/core/contracts.js';
import { Store } from '../src/store/store.js';
import { finishOutput, type EventInput } from '../src/store/output.js';
import { invocationSchema, responseObject } from '../src/gateway/protocol.js';
import { makeBundle } from '../src/lang/bundle.js';
import { Fault, sleep } from '../src/core/util.js';
import { setup, agent, FixtureModel, principal, token, waitFor } from './helpers.js';

function runFixture(overrides: Partial<Run> = {}): Run {
  return {
    id: 'resp_stream',
    owner: 'owner',
    agentId: 'agent/test',
    digest: 'a'.repeat(64),
    sessionId: 'session_stream',
    previousId: null,
    status: 'in_progress',
    createdAt: 1000,
    updatedAt: 2000,
    input: 'private input',
    fileIds: [],
    output: [],
    usage: null,
    checkpoint: { messages: [], turn: 0, phase: 'model' },
    error: null,
    artifactIds: [],
    metadata: {},
    route: { id: 'default', provider: 'fixture', model: 'fixture', mode: 'auto' },
    ...overrides,
  };
}
const added = (id = 'msg_stream', index = 0): EventInput => ({
  type: 'response.output_item.added',
  data: {
    output_index: index,
    item: { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
  },
});
const delta = (text: string, id = 'msg_stream', index = 0): EventInput => ({
  type: 'response.output_text.delta',
  data: { item_id: id, output_index: index, content_index: 0, delta: text, logprobs: [] },
});
const completed = (run: Run): EventInput => ({
  type: 'response.completed',
  data: { response: responseObject(run) },
});

test('output is committed before delivery and replayed without snapshot writes or cache aliasing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-output-'));
  let store = new Store(root);
  try {
    const run = runFixture();
    store.createRun(run, 'same-request', 'same-fingerprint');
    const snapshot = store.db.prepare('SELECT payload FROM runs WHERE id=?').get(run.id)!.payload;
    let observed = 0;
    const observations: boolean[] = [];
    store.events.on(run.id, (event: RunEvent) => {
      observations.push(!store.db.isTransaction);
      observations.push(store.history(run.id, event.id - 1)[0]!.id === event.id);
      if (event.type === 'response.output_text.delta') {
        observed++;
        observations.push(store.run(run.id).output[0]!.text === run.output[0]!.text);
      }
    });
    store.recordOutput(run, [added()]);
    const chunks = ['one ', '\u4e2d\u6587 ', '\ud83d', '\ude00', ' end'];
    for (const chunk of chunks) store.recordOutput(run, [delta(chunk)]);
    assert.equal(observed, chunks.length);
    assert.ok(observations.every(Boolean));
    assert.equal(
      store.db.prepare('SELECT payload FROM runs WHERE id=?').get(run.id)!.payload,
      snapshot,
    );
    const text = chunks.join('');
    const read = store.run(run.id, 'owner');
    assert.equal(read.output[0]!.text, text);
    read.output[0]!.text = 'must not poison cache';
    read.output.push({ id: 'fake', text: 'wrong' });
    assert.equal(store.run(run.id).output.length, 1);
    assert.equal(store.run(run.id).output[0]!.text, text);
    assert.equal(
      store.createRun(run, 'same-request', 'same-fingerprint').run.output[0]!.text,
      text,
    );
    assert.throws(() => store.run(run.id, 'other-owner'), /Response not found/);
    const cursor = store.history(run.id)[2]!.id;
    assert.equal(
      store
        .history(run.id, cursor)
        .map((e) => e.data.delta ?? '')
        .join(''),
      chunks.slice(2).join(''),
    );
    store.close();
    store = new Store(root);
    assert.equal(store.run(run.id).output[0]!.text, text);
    assert.equal(store.run(run.id).output[0]!.status, 'in_progress');
    store.recover();
    const recovered = store.run(run.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.output[0]!.status, 'incomplete');
    assert.equal(recovered.output[0]!.text, text);
    assert.equal(recovered.metadata['oaa.usage_complete'], 'false');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint, final output, summary and terminal event commit or roll back together', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-atomic-'));
  const store = new Store(root);
  try {
    const run = runFixture();
    store.createRun(run);
    store.recordOutput(run, [added(), delta('durable text')]);
    const before = store.run(run.id);
    const cursor = store.history(run.id).at(-1)!.id;
    let delivered = 0;
    store.events.on(run.id, () => delivered++);
    store.db.exec(
      `CREATE TEMP TRIGGER fail_terminal BEFORE INSERT ON main.events WHEN NEW.type='response.completed' BEGIN SELECT RAISE(ABORT,'injected disk error'); END;`,
    );
    run.status = 'completed';
    run.checkpoint.phase = 'done';
    assert.throws(
      () => store.checkpoint(run, finishOutput(run.output[0]!, 0, 'completed'), completed),
      /injected disk error/,
    );
    assert.deepEqual(store.run(run.id), before);
    assert.deepEqual(store.history(run.id, cursor), []);
    assert.equal(store.summaries('owner', ['*'])[0]!.status, 'in_progress');
    assert.equal(delivered, 0);
    store.db.exec('DROP TRIGGER fail_terminal');
    store.checkpoint(run, finishOutput(run.output[0]!, 0, 'completed'), completed);
    assert.equal(store.run(run.id).status, 'completed');
    assert.equal(store.run(run.id).output[0]!.status, 'completed');
    assert.equal(store.metrics('owner', ['*']).completed, 1);
    assert.equal(store.history(run.id).at(-1)!.type, 'response.completed');
    assert.equal(delivered, 4);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid or uncommitted deltas cannot reach readers or event observers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-delta-'));
  const store = new Store(root);
  try {
    const run = runFixture();
    store.createRun(run);
    store.recordOutput(run, [added()]);
    let delivered = 0;
    store.events.on(run.id, () => delivered++);
    const cursor = store.history(run.id).at(-1)!.id;
    assert.throws(
      () => store.emit(run.id, delta('bypass').type, delta('bypass').data),
      /durable output writer/,
    );
    assert.throws(
      () => store.recordOutput(run, [delta('wrong item', 'missing')]),
      /Invalid output event/,
    );
    store.db.exec(
      `CREATE TEMP TRIGGER fail_delta BEFORE INSERT ON main.events WHEN NEW.type='response.output_text.delta' BEGIN SELECT RAISE(ABORT,'injected delta error'); END;`,
    );
    assert.throws(() => store.recordOutput(run, [delta('not durable')]), /injected delta error/);
    assert.equal(store.run(run.id).output[0]!.text, '');
    assert.equal(run.output[0]!.text, '');
    assert.equal(delivered, 0);
    assert.deepEqual(store.history(run.id, cursor), []);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('v1 migration preserves output, events, usage and timestamps without replaying text twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-migrate-'));
  const file = path.join(root, 'state.sqlite');
  const old = new DatabaseSync(file);
  const original = runFixture({
    status: 'completed',
    output: [{ id: 'msg_stream', text: 'legacy output' }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
  const oldEvents = [
    added(),
    delta('legacy output'),
    ...finishOutput(original.output[0]!, 0, 'completed'),
  ];
  old.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY,owner TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,idem TEXT,fingerprint TEXT,UNIQUE(owner,idem));
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),type TEXT NOT NULL,time INTEGER NOT NULL,payload TEXT NOT NULL);
    PRAGMA user_version=1;`);
  old
    .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)')
    .run(
      original.id,
      original.owner,
      original.agentId,
      original.sessionId,
      original.status,
      JSON.stringify(original),
      null,
      null,
    );
  for (const event of oldEvents)
    old
      .prepare('INSERT INTO events(run_id,type,time,payload) VALUES(?,?,?,?)')
      .run(original.id, event.type, 1700, JSON.stringify(event.data));
  const eventsBefore = old.prepare('SELECT * FROM events').all();
  old.close();
  let store = new Store(root);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.deepEqual(store.run(original.id), { ...original, subject: 'legacy' });
    assert.deepEqual(store.db.prepare('SELECT * FROM events').all(), eventsBefore);
    assert.equal(
      JSON.parse(store.db.prepare('SELECT payload FROM runs').get()!.payload as string).output
        .length,
      0,
    );
    assert.equal(store.metrics('owner', ['*']).total_tokens, 5);
    store.close();
    store = new Store(root);
    assert.deepEqual(store.run(original.id), { ...original, subject: 'legacy' });
    assert.deepEqual(store.db.prepare('SELECT * FROM events').all(), eventsBefore);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('newer database schemas are rejected without modifying their schema or taking a lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-future-'));
  const file = path.join(root, 'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=99; CREATE TABLE future_state(value TEXT);');
  const before = db.prepare('SELECT * FROM sqlite_master').all();
  db.close();
  try {
    assert.throws(() => new Store(root), /requires a newer gateway/);
    const check = new DatabaseSync(file);
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 99);
      assert.deepEqual(check.prepare('SELECT * FROM sqlite_master').all(), before);
    } finally {
      check.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed legacy migrations roll back every changed row and leave no gateway lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-migrate-rollback-'));
  const db = new DatabaseSync(path.join(root, 'state.sqlite'));
  db.exec(
    `CREATE TABLE runs (id TEXT PRIMARY KEY,owner TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,idem TEXT,fingerprint TEXT,UNIQUE(owner,idem)); PRAGMA user_version=1;`,
  );
  const original = runFixture({
    status: 'completed',
    output: [{ id: 'legacy', text: 'retained' }],
  });
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run(
    original.id,
    original.owner,
    original.agentId,
    original.sessionId,
    original.status,
    JSON.stringify(original),
    null,
    null,
  );
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run(
    'resp_bad',
    'owner',
    'agent/test',
    'session_bad',
    'completed',
    '{broken fixture JSON',
    null,
    null,
  );
  const schemaBefore = db.prepare('SELECT * FROM sqlite_master').all();
  const runsBefore = db.prepare('SELECT * FROM runs').all();
  db.close();
  try {
    assert.throws(() => new Store(root), SyntaxError);
    const check = new DatabaseSync(path.join(root, 'state.sqlite'));
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 1);
      assert.deepEqual(check.prepare('SELECT * FROM sqlite_master').all(), schemaBefore);
      assert.deepEqual(check.prepare('SELECT * FROM runs').all(), runsBefore);
    } finally {
      check.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('projection cache eviction and scoped summaries preserve ownership without loading checkpoints', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 132; i++) {
      const run = runFixture({
        id: `resp_${i}`,
        sessionId: `session_${i}`,
        owner: i === 131 ? 'second' : 'owner',
        agentId: i === 130 ? 'agent/secret' : 'agent/test',
        status: 'completed',
        input: 'x'.repeat(300),
      });
      s.store.createRun(run);
      s.store.recordOutput(run, [added(), delta(`output ${i}`)]);
      s.store.checkpoint(run, finishOutput(run.output[0]!, 0, 'completed'));
    }
    assert.equal(s.store.run('resp_0').output[0]!.text, 'output 0');
    assert.equal(s.store.run('resp_0').output[0]!.status, 'completed');
    assert.equal(s.store.metrics('owner', ['agent/test']).runs, 130);
    assert.equal(s.store.metrics('owner', []).runs, 0);
    assert.equal(s.store.summaries('second', ['*'])[0]!.id, 'resp_131');
    assert.equal(s.store.summaries('owner', ['agent/test'], 1)[0]!.id, 'resp_129');
    assert.equal(s.store.summaries('owner', ['agent/test'], 1)[0]!.input.length, 200);
    const original = s.store.run.bind(s.store);
    s.store.run = () => {
      throw new Error('Summary routes must not deserialize run checkpoints.');
    };
    try {
      const overview = await s.request('GET', '/v1/overview');
      assert.equal(overview.statusCode, 200);
      assert.equal(overview.json().metrics.runs, 131);
      const list = await s.request('GET', '/v1/runs?limit=2');
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().data.length, 2);
    } finally {
      s.store.run = original;
    }
  } finally {
    await s.cleanup();
  }
});

test('a broken event observer is detached without undoing committed output or starving other observers', async () => {
  const s = await setup();
  try {
    const run = runFixture();
    s.store.createRun(run);
    let brokenCalls = 0;
    const broken = () => {
      brokenCalls++;
      throw new Error('private observer failure');
    };
    let healthyCalls = 0;
    s.store.events.on(run.id, broken);
    s.store.events.on(run.id, () => healthyCalls++);
    s.store.recordOutput(run, [added(), delta('committed')]);
    assert.equal(brokenCalls, 1);
    assert.equal(healthyCalls, 2);
    assert.equal(s.store.events.listeners(run.id).includes(broken), false);
    assert.equal(s.store.run(run.id).output[0]!.text, 'committed');
  } finally {
    await s.cleanup();
  }
});

test('long-context streaming writes checkpoints rather than one snapshot per delta', async () => {
  const text = 'a'.repeat(8192);
  const s = await setup(new FixtureModel(() => ({ text })));
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.db.exec(
      `CREATE TEMP TABLE writes(n INTEGER); CREATE TEMP TRIGGER snapshot_count AFTER UPDATE OF payload ON main.runs BEGIN INSERT INTO writes VALUES(1); END;`,
    );
    const run = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'b'.repeat(65536) }),
    );
    const result = await s.kernel.wait(run.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.output[0]!.text, text);
    assert.equal(result.output[0]!.status, 'completed');
    const writes = Number(s.store.db.prepare('SELECT count(*) AS n FROM writes').get()!.n);
    assert.ok(writes <= 5, `Unexpected snapshot count: ${writes}`);
    assert.equal(s.store.events.listenerCount(run.id), 0);
    let cursor = 0;
    let replay = '';
    while (true) {
      const events = s.store.history(run.id, cursor, 73);
      if (!events.length) break;
      for (const event of events) {
        assert.ok(event.id > cursor);
        cursor = event.id;
        if (event.type === 'response.output_text.delta') replay += event.data.delta;
      }
    }
    assert.equal(replay, text);
  } finally {
    await s.cleanup();
  }
});

test('reentrant observers cannot reorder a committed event batch or cause cursor clients to miss text', async () => {
  const s = await setup();
  try {
    const run = runFixture();
    s.store.createRun(run);
    const delivered: number[] = [];
    s.store.events.on(run.id, (event: RunEvent) => {
      if (event.type === 'response.output_item.added')
        s.store.emit(run.id, 'observer.followup' as EventInput['type'], {});
    });
    s.store.events.on(run.id, (event: RunEvent) => {
      delivered.push(event.id);
    });
    s.store.recordOutput(run, [added(), delta('in order')]);
    assert.deepEqual(
      delivered,
      s.store.history(run.id).map((e) => e.id),
    );
  } finally {
    await s.cleanup();
  }
});

test('the kernel stops generation when a delta cannot be persisted and never reports success', async () => {
  const s = await setup(
    new FixtureModel(() => ({ text: 'This text must not escape a failed write.' })),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    s.store.db.exec(
      `CREATE TEMP TRIGGER fail_output BEFORE INSERT ON main.events WHEN NEW.type='response.output_text.delta' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END;`,
    );
    const response = await s.request('POST', '/v1/responses', {
      model: 'agent/test',
      input: 'persist first',
      stream: true,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes('response.output_text.delta'));
    assert.ok(!response.body.includes('response.completed'));
    const run = s.store.allRuns()[0]!;
    assert.equal(run.status, 'failed');
    assert.equal(run.error?.code, 'persistence_failed');
    assert.equal(run.output[0]?.text, '');
    assert.equal(run.output[0]?.status, 'incomplete');
  } finally {
    await s.cleanup();
  }
});

test('cancelled, failed and truncated generations keep partial messages incomplete', async () => {
  for (const outcome of ['cancel', 'error', 'length'] as const) {
    const driver = new FixtureModel();
    driver.call = async (_a, _messages, signal, emit) => {
      emit('partial text');
      if (outcome === 'length')
        return {
          text: 'partial text',
          calls: [],
          finish: 'length',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        };
      if (outcome === 'error') throw new Fault('fixture_failure', 'Fixture stream failed.', 502);
      await sleep(10000, signal);
      throw new Error('Expected cancellation.');
    };
    const s = await setup(driver);
    try {
      s.store.publish('owner', makeBundle(agent()));
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({ agent: 'agent/test', input: outcome }),
      );
      if (outcome === 'cancel') {
        await waitFor(() => s.store.run(run.id).output[0]?.text === 'partial text');
        await s.kernel.cancel(principal, run.id);
      }
      const result = await s.kernel.wait(run.id);
      assert.equal(
        result.status,
        outcome === 'cancel' ? 'cancelled' : outcome === 'length' ? 'incomplete' : 'failed',
      );
      assert.equal(result.output[0]!.status, 'incomplete');
      const final = s.store.history(run.id).at(-1)!.data.response as {
        output: { status: string }[];
      };
      assert.equal(final.output[0]!.status, 'incomplete');
      if (outcome !== 'length') assert.equal(result.metadata['oaa.usage_complete'], 'false');
    } finally {
      await s.cleanup();
    }
  }
});

test('waiters do not poll checkpoints and release queued listeners on gateway shutdown', async () => {
  const s = await setup(
    new FixtureModel(async (_a, _m, signal) => {
      await sleep(10000, signal);
      return { text: 'late' };
    }),
    { maxActiveRuns: 1 },
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const first = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'first' }),
    );
    await waitFor(() => s.driver.calls === 1);
    const queued = s.kernel.submit(
      principal,
      invocationSchema.parse({ agent: 'agent/test', input: 'second' }),
    );
    const original = s.store.run.bind(s.store);
    let reads = 0;
    s.store.run = (...args) => {
      reads++;
      return original(...args);
    };
    const firstWait = s.kernel.wait(first.id);
    const queuedWait = assert.rejects(s.kernel.wait(queued.id), /shutting down/);
    await sleep(95);
    assert.equal(reads, 2, 'Waiting should read once per subscriber, not every 30 ms.');
    await s.app.close();
    assert.equal((await firstWait).status, 'interrupted');
    await queuedWait;
    assert.equal(s.store.events.listenerCount(first.id), 0);
    assert.equal(s.store.events.listenerCount(queued.id), 0);
  } finally {
    await s.cleanup();
  }
});

test('Chat streaming includes requested usage without per-token checkpoint reads or fabricated totals', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'stream '.repeat(600) })));
  try {
    s.store.publish('owner', makeBundle(agent()));
    const url = await s.listen();
    const client = new OpenAI({ apiKey: token, baseURL: url + '/v1', maxRetries: 0 });
    const original = s.store.run.bind(s.store);
    let reads = 0;
    s.store.run = (...args) => {
      reads++;
      return original(...args);
    };
    const stream = await client.chat.completions.create({
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const event of stream) chunks.push(event);
    assert.equal(
      chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''),
      'stream '.repeat(600),
    );
    assert.deepEqual(chunks.at(-1)!.choices, []);
    assert.deepEqual(chunks.at(-1)!.usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    assert.ok(chunks.slice(0, -1).every((c) => c.usage === null));
    assert.ok(reads <= 8, `Unexpected whole-run reads: ${reads}`);
    s.store.run = original;
    s.driver.call = async (_a, _m, _signal, emit) => {
      emit('unknown usage');
      return { text: 'unknown usage', calls: [], finish: 'stop', usage: null };
    };
    const unknown = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const data = unknown.body
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)));
    assert.equal(data.at(-1).usage, null);
    const invalid = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/test',
      messages: [{ role: 'user', content: 'hello' }],
      stream_options: { include_usage: true },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await s.cleanup();
  }
});

test('a hard-killed gateway preserves every acknowledged delta without a graceful checkpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-crash-output-'));
  const child = fork(new URL('./fixtures/stream-crash.js', import.meta.url), [root], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
  });
  let store: Store | undefined;
  try {
    const message = await new Promise<{ runId: string; cursor: number; text: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Crash fixture did not become ready: ${stderr}`)),
          5000,
        );
        child.once('message', (value) => {
          clearTimeout(timer);
          resolve(value as never);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Crash fixture exited: ${stderr}`));
        });
      },
    );
    child.kill('SIGKILL');
    await exited;
    store = new Store(root);
    const before = store.run(message.runId);
    assert.equal(before.status, 'in_progress');
    assert.equal(before.output[0]!.text, message.text);
    assert.equal(before.checkpoint.turn, 0, 'No model completion checkpoint was returned.');
    assert.equal(store.history(message.runId, message.cursor - 1)[0]!.id, message.cursor);
    store.recover();
    const result = store.run(message.runId);
    assert.equal(result.status, 'interrupted');
    assert.equal(result.output[0]!.text, message.text);
    assert.equal(result.output[0]!.status, 'incomplete');
    const replay = store
      .history(message.runId)
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.data.delta)
      .join('');
    assert.equal(replay, message.text);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
