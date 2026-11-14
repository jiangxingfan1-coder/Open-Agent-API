import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FixtureOracle, workload } from '../bench/paired/workload.js';
import { isolatedEnvironment, summarize } from '../bench/paired/run.js';
import { RuntimeDiagnostics } from '../bench/paired/diagnostics.js';

const exec = promisify(execFile);
const request = (
  shape: keyof typeof workload.tasks,
  observations: { id: string; value: unknown }[] = [],
) => ({
  input: workload.tasks[shape],
  system: workload.base_prompt,
  tools: [workload.tool],
  observations,
});

test('opt-in runtime diagnostics preserve return values, errors and method receivers', async () => {
  const diagnostics = new RuntimeDiagnostics();
  const object = {
    value: 2,
    add(n: number) {
      this.value += n;
      return this.value;
    },
    async fail() {
      throw Error('fixture failure');
    },
  };
  diagnostics.wrap(object, 'add', 'add');
  diagnostics.wrap(object, 'fail', 'fail');
  diagnostics.start();
  assert.equal(object.add(3), 5);
  await assert.rejects(object.fail(), /fixture failure/);
  const result = diagnostics.stop();
  assert.equal(result.data.add!.calls, 1);
  assert.equal(result.data.fail!.calls, 1);
  assert.ok(result.data.add!.total_ms >= 0);
  assert.equal(object.add(1), 6);
  assert.deepEqual(diagnostics.stop().data, {});
});
test('paired oracle rejects unissued, replayed and forged tool work instead of rewarding canned final text', async () => {
  const oracle = new FixtureOracle('parallel', 'fixture', false);
  await assert.rejects(oracle.tool({ source_id: 'a' }), /Unissued/);
  const plan = await oracle.model(request('parallel'));
  assert.equal(plan.calls.length, 3);
  const results = [];
  for (const call of plan.calls)
    results.push({ id: call.id, value: await oracle.tool(call.arguments) });
  await assert.rejects(oracle.tool(plan.calls[0]!.arguments), /repeated/);
  await assert.rejects(
    oracle.model(request('parallel', [{ id: 'call_a', value: { forged: true } }])),
    /unconfirmed/,
  );
  assert.throws(
    () => oracle.verify(JSON.stringify(oracle.expected()), workload.fixture_usage),
    /trace parity/,
  );
});

test('paired oracle enforces tool-schema parity, dependencies and its model-call budget', async () => {
  const mismatch = new FixtureOracle('simple', 'fixture', false);
  await assert.rejects(mismatch.model({ ...request('simple'), tools: [] }), /schema parity/);
  const oracle = new FixtureOracle('dependent', 'fixture', false);
  oracle.records[0]!.amount = 15;
  const observations = [];
  for (let i = 0; i < 3; i++) {
    const answer = await oracle.model(request('dependent', observations));
    assert.equal(answer.calls.length, 1);
    const call = answer.calls[0]!;
    if (i > 0) {
      assert.equal(call.arguments.previous_proof, oracle.records[i - 1]!.proof);
    }
    observations.push({ id: call.id, value: await oracle.tool(call.arguments) });
  }
  const final = await oracle.model(request('dependent', observations));
  assert.equal(JSON.parse(final.text).total, 81);
  oracle.verify(final.text, { input_tokens: 256, output_tokens: 64, total_tokens: 320 });
  const wrong = new FixtureOracle('dependent', 'fixture', false);
  const first = (await wrong.model(request('dependent'))).calls[0]!;
  const value = await wrong.tool(first.arguments);
  const next = (await wrong.model(request('dependent', [{ id: first.id, value }]))).calls[0]!;
  await assert.rejects(
    wrong.tool({ ...next.arguments, previous_proof: 'wrong-proof' }),
    /Unissued/,
  );
  const budget = new FixtureOracle('simple', 'fixture', false);
  for (let i = 0; i < workload.max_model_calls; i++) await budget.model(request('simple'));
  await assert.rejects(budget.model(request('simple')), /budget/);
});

test('benchmark aggregation separates cold/failed samples and child environments never inherit provider credentials', () => {
  const base: Parameters<typeof summarize>[0][number] = {
    profile: 'oaa-parallel',
    shape: 'simple',
    sample: 0,
    cold: true,
    status: 'completed',
    first_event_ms: 1,
    first_event_type: 'fixture',
    first_text_ms: 2,
    final_ms: 1000,
    output_verified: true,
    model_calls: 1,
    tool_calls: 0,
    peak_tools: 0,
    system_hashes: [],
    reported_fixture_usage: null,
    error: null,
  };
  const result = summarize([
    base,
    { ...base, sample: 1, cold: false, final_ms: 10 },
    { ...base, sample: 2, cold: false, final_ms: 20 },
    { ...base, sample: 3, cold: false, final_ms: 999, status: 'failed', error: 'fixture' },
  ])[0]!;
  assert.equal(result.attempted, 4);
  assert.equal(result.successful, 3);
  assert.equal(result.warm_p50_final_ms, 15);
  assert.equal(result.cold!.final_ms, 1000);
  const environment = isolatedEnvironment('/owned/fixture-home');
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'PYTHONPATH',
    'NODE_OPTIONS',
    'HTTPS_PROXY',
  ])
    assert.equal(environment[key], undefined);
  assert.equal(environment.HOME, '/owned/fixture-home');
  assert.equal(environment.OTEL_SDK_DISABLED, 'true');
});

test('paired CLI validates real OAA serial/parallel traces without requiring Python and never overwrites reports', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-paired-test-'));
  try {
    const out = path.join(dir, 'result.json');
    const script = path.resolve('dist/bench/paired/run.js');
    await exec(process.execPath, [
      script,
      '--out',
      out,
      '--samples',
      '1',
      '--profiles',
      'oaa-serial,oaa-parallel',
    ]);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.status, 'completed');
    assert.equal(report.trials.length, 12);
    assert.equal(report.pairing_verified, true);
    assert.equal(report.independent_framework_tested, false);
    assert.equal(report.live_models_tested, false);
    assert.equal(report.target_30_percent_proven, false);
    assert.ok(report.source_hashes['dist/bench/paired/oaa.js']);
    assert.ok(report.trials.every((trial: { output_verified: boolean }) => trial.output_verified));
    assert.equal(
      report.trials.find(
        (trial: { shape: string; profile: string }) =>
          trial.shape === 'parallel' && trial.profile === 'oaa-parallel',
      ).peak_tools,
      3,
    );
    const old = await readFile(out, 'utf8');
    await assert.rejects(
      exec(process.execPath, [script, '--out', out, '--profiles', 'oaa-serial']),
      /EEXIST/,
    );
    assert.equal(await readFile(out, 'utf8'), old);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing independent framework is recorded as failure, never substituted with a fixture-labelled imitation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-paired-missing-'));
  try {
    const out = path.join(dir, 'missing.json');
    await assert.rejects(
      exec(process.execPath, [
        path.resolve('dist/bench/paired/run.js'),
        '--out',
        out,
        '--samples',
        '1',
        '--profiles',
        'agentscope-parallel',
        '--python',
        path.join(dir, 'not-installed'),
      ]),
    );
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.independent_framework_tested, false);
    assert.equal(report.trials.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
