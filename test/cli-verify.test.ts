import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gatewaySchema } from '../src/config/config.js';
import { Fault } from '../src/core/util.js';
import { bi } from '../src/core/locale.js';
import { chooseScenarios, planLines, runVerifyCommand } from '../src/client/verify.js';
import { SCENARIOS, deriveUsage } from '../src/client/verify-catalog.js';
import { finalizeReport, type ReportMeta } from '../src/client/verify-report.js';
import { machineContext, makeScrubber } from '../src/client/verify-scrub.js';
import type { RunOutcome } from '../src/client/verify-run.js';
import type { ScenarioResult } from '../src/client/verify-harness.js';

// oaa verify: the whole flow on the repository's offline ACP stand-ins (test/fixtures/acp-live-agent.mjs
// and examples/sample-agent.mjs). No real agent is ever started. The isolated gateway the command
// creates listens on a random 127.0.0.1 port inside src/, so these files contain no listen call.

const run = promisify(execFile);
const fixture = path.resolve('test/fixtures/acp-live-agent.mjs');
const sample = path.resolve('examples/sample-agent.mjs');
const cli = path.resolve('dist/src/cli.js');

type Adapter = { command: string; args: string[] };
/** A data directory whose configuration lists the given ACP adapters (disabled, as `oaa init` writes them). */
async function dataDir(t: test.TestContext, adapters: Record<string, Adapter>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-verify-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'data'),
    port: 1,
    keys: [
      {
        name: 'owner',
        owner: 'owner',
        tokenFile: path.join(dir, 'admin.token'),
        scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      },
    ],
    localWorker: {
      nodeId: 'local',
      dataDir: path.join(dir, 'worker'),
      adapters: Object.fromEntries(
        Object.entries(adapters).map(([name, a]) => [name, { transport: 'acp', ...a }]),
      ),
    },
  });
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}
const lines = () => {
  const out: string[] = [];
  return { out, push: (l: string) => void out.push(l), text: () => out.join('\n') };
};
// A private temp root for verify's work directories (inherited by child processes), so other
// test processes using the shared system temp directory cannot disturb the before/after snapshot.
const verifyTmp = mkdtempSync(path.join(os.tmpdir(), 'oaa-verify-root-'));
process.env.OAA_VERIFY_TMPDIR = verifyTmp;
test.after(() => rmSync(verifyTmp, { recursive: true, force: true }));
const tmpVerifyDirs = () => readdirSync(verifyTmp).filter((n) => n.startsWith('oaa-verify-'));
type ScenarioJson = {
  key: string;
  status: string;
  title: { zh: string; en: string };
  observations: Record<string, unknown>;
  checks: { name: { zh: string; en: string }; ok: boolean }[];
  error?: { code: string };
};
type ReportJson = {
  schema: string;
  gateway: { version: string };
  agent: {
    engine: string;
    kind: string;
    reported_name: string | null;
    reported_version: string | null;
    identity_source: string;
  };
  platform: { os: string; arch: string; node: string };
  request: { automatic_retry: boolean };
  interrupted: boolean;
  summary: Record<string, number>;
  agent_invocations_total: number;
  scenarios: ScenarioJson[];
  [key: string]: unknown;
};
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as ReportJson;

test('verify: scenario choice accepts keys and S-ids, always adds the free cleanup check, rejects the rest', () => {
  const all = chooseScenarios(undefined).map((s) => s.id);
  assert.deepEqual(all, [
    'S1',
    'S2',
    'S3',
    'S4',
    'S5',
    'S6',
    'S7',
    'S8',
    'S9',
    'S11',
    'S12',
    'S13',
  ]);
  assert.deepEqual(
    chooseScenarios('responses, S1').map((s) => s.id),
    ['S1', 'S3', 'S12'],
  );
  for (const bad of ['nope', 'billing', 'S10']) {
    assert.throws(
      () => chooseScenarios(bad),
      (e: unknown) =>
        e instanceof Fault && e.code === 'arguments' && /Available: chat/.test(e.text?.en ?? ''),
    );
  }
  const calls = chooseScenarios(undefined).reduce((n, s) => n + s.calls, 0);
  assert.equal(calls, 14);
  assert.ok(
    SCENARIOS.every((s) => s.title.zh && s.title.en && s.note.zh && s.note.en),
    'every scenario is bilingual',
  );
});

test('verify: without --confirm-live-cost it only prints the plan; nothing starts and nothing is written', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-verify-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A "native agent" that records every start; the dry run must never start it, not even for --version.
  const marker = path.join(dir, 'started.txt');
  const fake = path.join(dir, 'codex');
  await writeFile(fake, `#!/bin/sh\necho started >> '${marker}'\necho codex-cli 9.9.9\n`);
  await chmod(fake, 0o755);
  const before = tmpVerifyDirs();
  const out = lines();
  const code = await runVerifyCommand(
    ['codex'],
    { dir, executable: fake, out: path.join(dir, 'reports') },
    {
      out: out.push,
      locale: 'en',
      cwd: dir,
    },
  );
  assert.equal(code, 0);
  assert.match(out.text(), /Up to 14 real agent calls in total/);
  assert.match(
    out.text(),
    /Nothing was run\. Run the same command again with --confirm-live-cost to start\./,
  );
  assert.match(out.text(), /your own gateway, data directory and keys are not touched/i);
  assert.equal(existsSync(marker), false, 'the agent was never started');
  assert.equal(existsSync(path.join(dir, 'reports')), false, 'no report directory was created');
  assert.deepEqual(tmpVerifyDirs(), before, 'no temporary directory was created');

  const zh = lines();
  await runVerifyCommand(
    ['codex'],
    { dir, executable: fake, scenarios: 'chat,responses' },
    { out: zh.push, locale: 'zh', cwd: dir },
  );
  assert.match(zh.text(), /合计最多 3 次真实的智能体调用/);
  assert.match(zh.text(), /没有运行任何东西/);
  assert.equal(existsSync(marker), false);
});

test('verify: plan wording says what each scenario costs in both languages', () => {
  const chosen = chooseScenarios('concurrency');
  const en = planLines(chosen, { label: 'codex' }, 'default', '/x', 'en', false).join('\n');
  const zh = planLines(chosen, { label: 'codex' }, 'default', '/x', 'zh', true).join('\n');
  assert.match(en, /concurrency\s+3 calls/);
  assert.match(zh, /concurrency\s+3 次调用/);
  assert.match(zh, /已确认费用，开始运行/);
});

test('verify: a full run on the ACP stand-in passes, writes both reports and leaves nothing behind', async (t) => {
  const dir = await dataDir(t, { live: { command: process.execPath, args: [fixture] } });
  const before = tmpVerifyDirs();
  const out = lines();
  const outDir = path.join(dir, 'reports', 'full');
  const code = await runVerifyCommand(
    ['live'],
    { dir, out: outDir, 'confirm-live-cost': true, 'timeout-ms': '60000' },
    { out: out.push, locale: 'en' },
  );
  assert.equal(code, 0, out.text());
  const text = out.text();
  assert.match(text, /The agent reports itself as: oaa-live-fixture 1\.0\.0/);
  assert.match(text, /\[1\/12\] chat\s+pass/);
  assert.match(text, /SCENARIO\s+RESULT\s+TIME\s+CALLS\s+NOTE/);
  assert.match(text, /Total: 12 pass, 0 failed, 0 unsupported, 0 skipped; 14 agent calls/);
  const report = await readJson(path.join(outDir, 'report.json'));
  assert.equal(report.schema, 'oaa-verify-report/1');
  assert.equal(report.gateway.version, '0.0.64');
  assert.equal(report.agent.reported_name, 'oaa-live-fixture');
  assert.equal(report.agent.identity_source, 'acp-handshake');
  assert.match(report.platform.os, /^(darwin|linux|win32|freebsd|openbsd|aix|sunos)$/);
  assert.ok(report.platform.arch && report.platform.node);
  assert.equal(report.request.automatic_retry, false);
  assert.equal(report.interrupted, false);
  assert.deepEqual(report.summary, { pass: 12, fail: 0, unsupported: 0, skipped: 0 });
  assert.deepEqual(
    report.scenarios.map((s) => s.key),
    [
      'chat',
      'chat-stream',
      'responses',
      'claude-messages',
      'gemini',
      'approvals',
      'cancel',
      'client-tools',
      'concurrency',
      'errors',
      'cleanup',
      'usage',
    ],
  );
  assert.equal(report.scenarios[0]?.title.zh, 'OpenAI Chat 非流式');
  assert.equal(report.scenarios[0]?.title.en, 'OpenAI Chat, non-streaming');
  const md = await readFile(path.join(outDir, 'report.md'), 'utf8');
  assert.match(md, /^# Open Agent API agent verification report: adapter\/live/);
  assert.match(md, /\| Gateway \| Open Agent API 0\.0\.64 \|/);
  assert.match(md, /oaa-live-fixture 1\.0\.0/);
  assert.match(md, /\| `approvals` Approvals: approve and deny \| pass \|/);
  assert.match(md, /## Differences from the docs\n\n- No observation differs/);
  // The wire-level checks really ran against the stand-in: approvals approved a write and denied another.
  const approvals = report.scenarios.find((s) => s.key === 'approvals')!;
  assert.equal(approvals.observations.approve_final_status, 'completed');
  assert.equal(approvals.observations.deny_error_code, 'permission_denied');
  assert.deepEqual(tmpVerifyDirs(), before, 'the temporary work directory was removed');
});

test('verify: failing scenarios do not stop the others and are reported with their reasons', async (t) => {
  // The offline sample agent does not echo the test strings, so most scenarios fail; errors and cleanup still pass.
  const dir = await dataDir(t, { sample: { command: process.execPath, args: [sample] } });
  const out = lines();
  const outDir = path.join(dir, 'reports', 'partial');
  const code = await runVerifyCommand(
    ['sample'],
    {
      dir,
      out: outDir,
      'confirm-live-cost': true,
      'timeout-ms': '15000',
      scenarios: 'chat,gemini,approvals,errors',
    },
    { out: out.push, locale: 'en' },
  );
  assert.equal(code, 1, 'exit code 1 when a scenario failed');
  const report = await readJson(path.join(outDir, 'report.json'));
  const by = Object.fromEntries(report.scenarios.map((s) => [s.key, s])) as Record<
    string,
    ScenarioJson
  >;
  assert.deepEqual(Object.keys(by), ['chat', 'gemini', 'approvals', 'errors', 'cleanup']);
  assert.equal(by.chat!.status, 'fail');
  assert.equal(by.gemini!.status, 'fail');
  assert.equal(by.approvals!.status, 'unsupported');
  assert.equal(by.approvals!.error?.code, 'approval_not_requested');
  assert.equal(by.errors!.status, 'pass', 'later scenarios still ran');
  assert.equal(by.cleanup!.status, 'pass');
  const failedCheck = by.chat!.checks.find((c) => !c.ok);
  assert.equal(failedCheck?.name.en, 'The answer contains the agreed string');
  assert.equal(report.summary.fail, 2);
  const md = await readFile(path.join(outDir, 'report.md'), 'utf8');
  assert.match(md, /\| `chat` OpenAI Chat, non-streaming \| FAIL \|/);
  assert.match(
    md,
    /## Failure details[\s\S]*### `chat` — OpenAI Chat, non-streaming\n\n- The answer contains the agreed string/,
  );
  assert.match(md, /approval_not_requested/);
  assert.match(out.text(), /chat\s+FAIL\s+[\d.]+s\s+1\s+The answer contains the agreed string/);
});

test('verify: a native agent is resolved from --executable, read with --version only, and never prompted by the errors scenario', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-verify-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.txt');
  // Windows has no shebangs: the same stand-in as a node script (run through node by launchPlan).
  const windows = process.platform === 'win32';
  const fake = path.join(dir, windows ? 'codex.mjs' : 'codex');
  await writeFile(
    fake,
    windows
      ? `import { appendFileSync } from 'node:fs';\nimport path from 'node:path';\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log('fake-codex 1.2.3 (' + path.join(process.cwd(), 'secret-place') + ')');\n`
      : `#!/bin/sh\necho "$@" >> '${log}'\necho "fake-codex 1.2.3 ($PWD/secret-place)"\n`,
  );
  await chmod(fake, 0o755);
  const out = lines();
  const outDir = path.join(dir, 'reports');
  const code = await runVerifyCommand(
    ['codex'],
    {
      dir: path.join(dir, 'none'),
      executable: fake,
      out: outDir,
      scenarios: 'errors',
      'confirm-live-cost': true,
    },
    { out: out.push, locale: 'en', cwd: dir },
  );
  assert.equal(code, 0, out.text());
  assert.equal(
    (await readFile(log, 'utf8')).trim(),
    '--version',
    'the only start was the --version read',
  );
  const report = await readJson(path.join(outDir, 'report.json'));
  assert.equal(report.agent.engine, 'codex');
  assert.equal(report.agent.kind, 'codex');
  assert.equal(report.agent.identity_source, 'version-flag');
  assert.match(report.agent.reported_version ?? '', /^fake-codex 1\.2\.3 /);
  assert.equal(report.agent_invocations_total, 0);
  assert.ok(!JSON.stringify(report).includes(dir), 'the version line is scrubbed of local paths');
});

test('verify: refuses an existing --out, an unknown agent and a missing name', async (t) => {
  const dir = await dataDir(t, { live: { command: process.execPath, args: [fixture] } });
  await mkdir(path.join(dir, 'taken'));
  await assert.rejects(
    runVerifyCommand(
      ['live'],
      { dir, out: path.join(dir, 'taken') },
      { out: () => {}, locale: 'en' },
    ),
    (e: unknown) => e instanceof Fault && e.code === 'output_exists',
  );
  await assert.rejects(
    runVerifyCommand(['no-such-agent-xyz'], { dir }, { out: () => {}, pathEnv: '' }),
    (e: unknown) =>
      e instanceof Fault && e.code === 'backend_unavailable' && /oaa doctor/.test(e.text?.en ?? ''),
  );
  await assert.rejects(
    runVerifyCommand([], { dir }, { out: () => {} }),
    (e: unknown) => e instanceof Fault && e.code === 'arguments',
  );
  await assert.rejects(
    runVerifyCommand(['codex'], { dir, executable: path.join(dir, 'missing') }, { out: () => {} }),
    (e: unknown) => e instanceof Fault && e.code === 'native_not_installed',
  );
  await assert.rejects(
    runVerifyCommand(['live'], { dir, 'timeout-ms': '5' }, { out: () => {} }),
    (e: unknown) => e instanceof Fault && e.code === 'arguments',
  );
});

test(
  'verify: Ctrl+C ends the run cleanly: exit 130, partial report, no agent process or work directory left',
  {
    // child.kill('SIGINT') is TerminateProcess on Windows; a console Ctrl+C cannot be sent to a child.
    skip: process.platform === 'win32' ? 'Windows cannot deliver SIGINT to a child process' : false,
  },
  async (t) => {
    const marker = `oaa-verify-marker-${Date.now()}`;
    const dir = await dataDir(t, { live: { command: process.execPath, args: [fixture, marker] } });
    const before = tmpVerifyDirs();
    const outDir = path.join(dir, 'reports', 'interrupted');
    const child = spawn(
      process.execPath,
      [cli, 'verify', 'live', '--dir', dir, '--out', outDir, '--confirm-live-cost'],
      { env: { ...process.env, OAA_LOCALE: 'en', OAA_TOKEN_FILE: '', OAA_GATEWAY_URL: '' } },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    // The cancel scenario sleeps three seconds after the approvals scenario: interrupt inside it.
    for (let i = 0; i < 600 && !/\[6\/12\] approvals/.test(stdout); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(stdout, /\[6\/12\] approvals/);
    child.kill('SIGINT');
    assert.equal(await exited, 130);
    const report = await readJson(path.join(outDir, 'report.json'));
    assert.equal(report.interrupted, true);
    const status = Object.fromEntries(report.scenarios.map((s) => [s.key, s.status]));
    assert.equal(status.chat, 'pass', 'finished scenarios keep their results');
    assert.equal(status.cancel, 'skipped', 'the running scenario is marked skipped');
    assert.equal(status.concurrency, 'skipped');
    assert.equal(status.cleanup, 'skipped');
    assert.equal(report.scenarios.find((s) => s.key === 'cancel')?.error?.code, 'interrupted');
    const alive = (await run('ps', ['-A', '-o', 'command='])).stdout
      .split('\n')
      .filter((l) => l.includes(marker));
    assert.deepEqual(alive, [], 'no agent process survived');
    assert.deepEqual(tmpVerifyDirs(), before, 'the temporary work directory was removed');
    assert.match(stdout, /Total: \d+ pass/);
  },
);

test('verify: S13 usage is derived from earlier responses without another call', () => {
  const mk = (
    id: string,
    observations: Record<string, unknown>,
    status: ScenarioResult['status'] = 'pass',
  ): ScenarioResult => ({
    id,
    key: id,
    title: bi(id, id),
    status,
    elapsed_ms: 1,
    agent_invocations: 1,
    observations,
    checks: [],
    run_ids: [],
    doc_mismatches: [],
  });
  const reported = deriveUsage([
    mk('S1', { usage: { prompt_tokens: 3, total_tokens: 5 } }),
    mk('S5', { usage: null }),
  ]);
  assert.equal(reported.status, 'pass');
  assert.deepEqual(reported.observations.reported_by, ['S1']);
  assert.equal(reported.agent_invocations, 0);
  const none = deriveUsage([
    mk('S1', { usage: { total_tokens: 0 } }),
    mk('S4', { sync_usage: null }),
  ]);
  assert.equal(none.status, 'unsupported');
  assert.equal(none.error?.code, 'usage_not_reported');
  assert.equal(deriveUsage([mk('S6', {})]).status, 'skipped');
  assert.equal(
    deriveUsage([mk('S1', { usage: { total_tokens: 9 } }, 'skipped')]).status,
    'skipped',
  );
});

// ---- scrubbing ----

const ctx = {
  homeDir: '/Users/alice',
  user: 'alice',
  host: 'alice-mbp.local',
  workDir: '/private/var/folders/ab/cdef/T/oaa-verify-QWERTY',
  secrets: ['super-secret-admin-token-0123456789'],
};

test('scrub: secrets, user and host names, home and work paths, e-mail and LAN addresses never survive', () => {
  const scrub = makeScrubber(ctx);
  const dirty = [
    'key sk-oaa-AbCdEfGhIjKlMnOp0123 and super-secret-admin-token-0123456789',
    'Authorization: Bearer abcdefghijklmnop1234567890',
    'provider sk-ant-api03-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123',
    'home /Users/alice/Projects/client-x/src/a.ts and ~/Documents/notes.txt and file:///Users/alice/x',
    'work /private/var/folders/ab/cdef/T/oaa-verify-QWERTY/workspace/sessions/s1 and /var/folders/ab/cdef/T/oaa-verify-QWERTY/x',
    'tools /opt/homebrew/bin/codex /usr/local/bin/claude /home/bob/.config/x /Volumes/Data/secret',
    'windows C:\\Users\\alice\\AppData and JSON-escaped C:\\\\Users\\\\alice\\\\x and \\\\fileserver\\share\\y',
    'user alice at alice-mbp.local (alice-mbp) mail alice@example.com lan 192.168.1.20 10.0.0.7',
    'server http://127.0.0.1:54321/v1/chat/completions',
  ].join('\n');
  const clean = scrub.text(dirty);
  for (const forbidden of [
    'sk-oaa-AbCd',
    'super-secret',
    'abcdefghijklmnop1234',
    'sk-ant-api03',
    'ghp_',
    '/Users/alice',
    'alice',
    '/private/var',
    '/var/folders',
    '/opt/',
    '/usr/',
    '/home/',
    '/Volumes/',
    'C:\\',
    'fileserver',
    'alice-mbp',
    'example.com',
    '192.168',
    '10.0.0.7',
    ':54321',
    'client-x',
  ])
    assert.ok(!clean.includes(forbidden), `${forbidden} survived:\n${clean}`);
  assert.deepEqual(scrub.leaks(clean), []);
  assert.match(clean, /<workdir>\/workspace\/sessions\/s1/);
  assert.match(clean, /127\.0\.0\.1:<port>\/v1\/chat\/completions/);
  // Ordinary report text is left alone.
  const fine =
    'agent/live-codex ran POST /v1/chat/completions: run resp_0123 completed in 12.5 s (usage 5 tokens).';
  assert.equal(scrub.text(fine), fine);
});

test('scrub: a three-letter user name does not mangle other words, and deep values are scrubbed including keys', () => {
  const scrub = makeScrubber({ user: 'hzq', host: 'Mac', homeDir: '/Users/hzq' });
  assert.equal(scrub.text('hzqx and xhzq stay, hzq goes'), 'hzqx and xhzq stay, <user> goes');
  assert.equal(scrub.text('Machine stays, Mac goes'), 'Machine stays, <host> goes');
  assert.deepEqual(scrub.deep({ '/Users/hzq/a': ['/Users/hzq/b', { n: 1, ok: true }] }), {
    '<path>': ['<path>', { n: 1, ok: true }],
  });
});

function fakeOutcome(observation: string): RunOutcome {
  return {
    agentId: 'agent/live-x',
    results: [
      {
        id: 'S1',
        key: 'chat',
        title: bi('OpenAI Chat 非流式', 'OpenAI Chat, non-streaming'),
        status: 'fail',
        elapsed_ms: 1500,
        agent_invocations: 1,
        observations: { output: observation },
        checks: [
          {
            name: bi('回答含约定字符串', 'The answer contains the agreed string'),
            ok: false,
            detail: observation,
          },
        ],
        run_ids: ['resp_1'],
        error: { code: 'exception', message: bi(observation, observation) },
        doc_mismatches: [bi(observation, observation)],
      },
    ],
    interrupted: false,
    gatewayVersion: '0.0.64',
    nativeArgs: [],
    childEnv: { mode: 'inherit', names: [], secret_like_names: [], provider_related_names: [] },
    secrets: ['an-environment-secret-value-42'],
    startedAt: '2026-11-14T00:00:00.000Z',
    finishedAt: '2026-11-14T00:00:02.000Z',
  };
}
const meta: ReportMeta = {
  requested: 'x',
  label: 'x',
  kind: 'acp',
  engine: 'adapter/x',
  identity: { source: 'none' },
  model: 'default',
  timeoutMs: 1000,
  platform: { os: 'linux', release: '6.1', arch: 'x64', node: 'v24.0.0' },
};

test('scrub: both report files are clean for this very machine (home, user name, host name, work directory, secrets)', () => {
  const machine = machineContext({ workDir: path.join(os.tmpdir(), 'oaa-verify-ZZZ') });
  const dirty =
    `cwd ${os.homedir()}/projects/private-app, tmp ${machine.workDir}/workspace, ` +
    `user ${machine.user} host ${machine.host} key sk-oaa-0123456789abcdef an-environment-secret-value-42 ` +
    `mail someone@example.org`;
  const final = finalizeReport(fakeOutcome(dirty), meta, machine, 'en');
  assert.deepEqual(final.leaks, []);
  for (const text of [final.json, final.md]) {
    assert.ok(!text.includes(os.homedir()), 'home directory');
    assert.ok(!text.includes('private-app'), 'path tail below the home directory');
    assert.ok(!text.includes('sk-oaa-0123456789abcdef'), 'key');
    assert.ok(!text.includes('an-environment-secret-value-42'), 'environment secret');
    assert.ok(!text.includes('someone@example.org'), 'e-mail');
    assert.ok(!text.includes(String(machine.workDir)), 'work directory');
    if ((machine.user ?? '').length >= 3)
      assert.ok(
        !new RegExp(`(?<![A-Za-z0-9_])${machine.user}(?![A-Za-z0-9_])`).test(text),
        'user name',
      );
    if ((machine.host ?? '').length >= 3 && machine.host!.toLowerCase() !== 'localhost')
      assert.ok(!text.includes(machine.host!), 'host name');
  }
  assert.match(final.json, /<path>/);
  assert.match(final.md, /FAIL/);
  assert.match(final.md, /\| `chat` OpenAI Chat, non-streaming \| FAIL \| 1\.5 s \| 1 \|/);
  JSON.parse(final.json);
});

test('verify: acceptance script keeps its command line and report format and reuses the shared scenarios', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-acc-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.resolve('dist/examples/live-agents-acceptance.js');
  const refused = await run(process.execPath, [
    script,
    '--agent',
    'codex',
    '--executable',
    process.execPath,
    '--out',
    path.join(dir, 'x'),
  ]).catch((e: { code: number; stderr: string }) => e);
  assert.equal((refused as { code: number }).code, 2, 'a real agent needs --confirm-live-cost');
  assert.match((refused as { stderr: string }).stderr, /--confirm-live-cost/);
  assert.equal(existsSync(path.join(dir, 'x')), false, 'nothing was created');
  const outDir = path.join(dir, 'acc');
  const { stdout } = await run(
    process.execPath,
    [script, '--agent', 'fixture', '--only', 'S1,S2,S11,S12', '--out', outDir],
    {
      env: { ...process.env, OAA_LOCALE: 'en' },
    },
  );
  assert.match(stdout, /^S1 {2,}pass {2,}\s*\d+ms {2}调用 1 {2}OpenAI Chat, non-streaming/m);
  const report = await readJson(path.join(outDir, 'report.json'));
  assert.equal(report.agent, 'fixture');
  assert.deepEqual(report.scenarios_requested, ['S1', 'S2', 'S11', 'S12']);
  assert.deepEqual(report.summary, { pass: 4, fail: 0, unsupported: 0, skipped: 0 });
  const acceptanceFirst = report.scenarios[0] as unknown as {
    title: unknown;
    checks: { name: unknown }[];
  };
  assert.equal(typeof acceptanceFirst.title, 'string');
  assert.equal(typeof acceptanceFirst.checks[0]?.name, 'string');
  assert.ok(existsSync(path.join(outDir, 'report.md')));
});
