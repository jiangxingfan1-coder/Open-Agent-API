// Real upgrade check: an older released `oaa` creates and uses a data directory, then the current
// build (dist/src/cli.js) takes it over, then the older release opens it again.
//
//   npm run upgrade-check -- --old "/path/Open Agent API.app/Contents/Resources/oaa" [--dir DIR]
//        [--fixture-out test/fixtures/upgrade-0.0.64.sqlite]
//
// Everything runs with a temporary HOME and data directory on a free 127.0.0.1 port; no real agent,
// model or network is used (the offline sample agent answers). With --fixture-out it also writes a
// small copy of the older release's database (VACUUM INTO, after the older gateway stopped) for
// test/upgrade.test.ts. Exit code 1 when a check fails.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    old: { type: 'string' },
    dir: { type: 'string' },
    'fixture-out': { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
if (!values.old) throw new Error('Pass --old with the path of an older release `oaa` launcher.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const current = path.join(repo, 'dist', 'src', 'cli.js');
const root = values.dir
  ? path.resolve(values.dir)
  : await mkdtemp(path.join(os.tmpdir(), 'oaa-upgrade-'));
await rm(root, { recursive: true, force: true });
const home = path.join(root, 'home');
const dir = path.join(root, 'oaa');
await mkdir(home, { recursive: true });
const port = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const env = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  checks.push({ name, ok, detail: text });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${text ? ` — ${text}` : ''}\n`);
};
async function oaa(which: 'old' | 'new', ...args: string[]) {
  const [cmd, pre] = which === 'old' ? [values.old!, []] : [process.execPath, [current]];
  try {
    const r = await run(cmd, [...pre, ...args], { env, cwd: root, timeout: 90_000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
async function http(method: string, url: string, token: string, body?: unknown) {
  const r = await fetch(base + url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: r.status, json };
}
async function waitStatus(id: string, token: string, want: string[], ms = 20_000) {
  const end = Date.now() + ms;
  let status = '';
  while (Date.now() < end) {
    status = String((await http('GET', `/v1/runs/${id}`, token)).json.status);
    if (want.includes(status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return status;
}
const health = async () =>
  fetch(`${base}/health`)
    .then((r) => r.json() as Promise<{ version?: string }>)
    .catch(() => undefined);

// ---------- 1. the older release creates and uses the data directory ----------
const quick = await oaa('old', 'quickstart', '--dir', dir, '--port', String(port));
check('old: quickstart succeeds', quick.code === 0, quick.code ? quick.out.slice(-400) : '');
const oldVersion = (await health())?.version;
check('old: gateway is up', !!oldVersion, `version ${oldVersion}`);
// Enable the developer platform so a portal account can be created, then restart the old gateway.
const configFile = path.join(dir, 'config.json');
const config = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
config.platform = { owner: 'owner', registration: 'open' };
await writeFile(configFile, JSON.stringify(config, null, 2));
await oaa('old', 'stop', '--dir', dir);
const restarted = await oaa('old', 'serve', '--detach', '--dir', dir);
check('old: restarts with the platform enabled', restarted.code === 0, restarted.out.slice(-300));
const admin = (await readFile(path.join(dir, 'admin.token'), 'utf8')).trim();
const quickKey = (await readFile(path.join(dir, 'keys', 'quickstart.key'), 'utf8')).trim();
const created = await http('POST', '/v1/keys', admin, {
  name: 'upgrade-check',
  agents: ['*'],
  scopes: ['invoke', 'read'],
});
const managedKey = String(created.json.token ?? '');
check('old: managed key created', created.status === 200 && !!managedKey, created.status);
const done = await http('POST', '/v1/responses', managedKey, {
  model: 'agent/sample',
  input: 'hello before the upgrade',
});
check('old: a run completes', done.json.status === 'completed', done.json.status);
const completedId = String(done.json.id);
const pending = await http('POST', '/v1/responses', admin, {
  model: 'agent/sample',
  input: 'please approve a file write',
  background: true,
});
const pendingId = String(pending.json.id);
check(
  'old: an approval is pending',
  (await waitStatus(pendingId, admin, ['requires_action'])) === 'requires_action',
);
const approved = await http('POST', '/v1/responses', admin, {
  model: 'agent/sample',
  input: 'approve this one',
  background: true,
});
const approvedId = String(approved.json.id);
await waitStatus(approvedId, admin, ['requires_action']);
const actions = await http('GET', `/v1/runs/${approvedId}/actions`, admin);
const action = (actions.json.data as { id: string }[] | undefined)?.[0]?.id;
await http('POST', `/v1/runs/${approvedId}/actions/${action}`, admin, { decision: 'approve' });
check(
  'old: an approved run completes',
  (await waitStatus(approvedId, admin, ['completed'])) === 'completed',
);
const email = `upgrade-${Date.now()}@example.test`;
const password = `test-only-${Date.now()}-password`;
const signup = await http('POST', '/v1/portal/signup', '', { email, password });
check('old: portal account created', signup.status === 201, signup.status);
await oaa('old', 'stop', '--dir', dir);
check('old: stopped', !(await health()));
const runsBefore = (() => {
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'), { readOnly: true });
  try {
    return db
      .prepare('SELECT id,status FROM runs ORDER BY rowid')
      .all()
      .map((r) => ({ id: String(r.id), status: String(r.status) }));
  } finally {
    db.close();
  }
})();
process.stdout.write(`runs left by the old release: ${JSON.stringify(runsBefore)}\n`);
if (values['fixture-out']) {
  const out = path.resolve(values['fixture-out']);
  await rm(out, { force: true });
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  db.prepare('VACUUM INTO ?').run(out);
  db.close();
  // Keep machine paths and live session hashes out of the committed fixture.
  const fixture = new DatabaseSync(out);
  fixture.exec(
    `UPDATE local_backends SET executable='node'; DELETE FROM platform_sessions; VACUUM`,
  );
  fixture.close();
  process.stdout.write(`fixture written: ${out}\n`);
}
const preUpgrade = path.join(root, 'state-before-upgrade.sqlite');
await copyFile(path.join(dir, 'state.sqlite'), preUpgrade);

// ---------- 2. the current build takes over the same data directory ----------
const up = await oaa('new', 'serve', '--detach', '--dir', dir);
check('new: starts on the old data directory', up.code === 0, up.out.slice(-300));
check('new: reports the current version', !!(await health())?.version, (await health())?.version);
const runsAfter = await http('GET', '/v1/runs?limit=50', admin);
const listed = ((runsAfter.json.data as { id: string; status: string }[] | undefined) ?? []).map(
  (r) => ({ id: r.id, status: r.status }),
);
check(
  'new: every run of the old release is listed',
  runsBefore.every((r) => listed.some((l) => l.id === r.id)),
  `${listed.length}/${runsBefore.length}`,
);
check(
  'new: completed runs are still completed',
  [completedId, approvedId].every((id) => listed.find((l) => l.id === id)?.status === 'completed'),
);
const pendingNow = await http('GET', `/v1/runs/${pendingId}`, admin);
check(
  'new: the run that was waiting for approval at shutdown is interrupted (explicit resume)',
  pendingNow.json.status === 'interrupted',
  pendingNow.json.status,
);
for (const [name, key] of [
  ['quickstart key', quickKey],
  ['managed key', managedKey],
] as const) {
  const r = await http('GET', '/v1/models', key);
  check(`new: the ${name} still authenticates`, r.status === 200, r.status);
}
// The sample agent cannot continue an ACP session (native_resume_unsupported, as in 0.0.64), so
// check a new run with the old key instead.
const fresh = await http('POST', '/v1/responses', managedKey, {
  model: 'agent/sample',
  input: 'hello after the upgrade',
});
check('new: the old managed key runs a new task', fresh.json.status === 'completed', fresh.status);
const login = await http('POST', '/v1/portal/login', '', { email, password });
check('new: the portal account can sign in', login.status === 200, login.status);
for (const url of ['/v1/overview', `/v1/runs/${completedId}/timeline`, '/v1/overview/activity']) {
  const r = await http('GET', url, admin);
  check(
    `new: console endpoint ${url.replace(completedId, ':id')} answers`,
    r.status === 200,
    r.status,
  );
}
const backups = await readdir(path.join(dir, 'backups')).catch(() => [] as string[]);
check(
  'new: same schema version, so no migration backup is written',
  backups.length === 0,
  backups.join(','),
);
await oaa('new', 'stop', '--dir', dir);
check('new: stopped', !(await health()));

// ---------- 3. the older release opens the directory again (downgrade) ----------
const back = await oaa('old', 'serve', '--detach', '--dir', dir);
check(
  'old again: starts on the directory used by the current build',
  back.code === 0,
  back.out.slice(-200),
);
if (back.code === 0) {
  const r = await http('GET', `/v1/runs/${completedId}`, admin);
  check('old again: data written by the current build is readable', r.status === 200, r.status);
  await oaa('old', 'stop', '--dir', dir);
}
// A database from a future schema must be refused, not modified.
const future = new DatabaseSync(path.join(dir, 'state.sqlite'));
future.exec('PRAGMA user_version=99');
future.close();
const refused = await oaa('old', 'serve', '--dir', dir);
const log = refused.out;
check(
  'old: a newer-schema database is refused with a clear message',
  refused.code !== 0 && /newer gateway|schema_too_new/.test(log),
  log.trim().split('\n').slice(-2).join(' '),
);
const stillFuture = new DatabaseSync(path.join(dir, 'state.sqlite'));
check(
  'old: the refused database is left unchanged',
  Number(stillFuture.prepare('PRAGMA user_version').get()!.user_version) === 99,
);
stillFuture.exec('PRAGMA user_version=4');
stillFuture.close();
// A config written for the current build (retention) is refused by the older one.
config.retention = { runsDays: 30 };
await writeFile(configFile, JSON.stringify(config, null, 2));
const strict = await oaa('old', 'serve', '--dir', dir);
check(
  'old: a config with fields it does not know is refused before touching data',
  strict.code !== 0,
  (strict.out.match(/[^\n]*retention[^\n]*/)?.[0] ?? strict.out.trim().split('\n')[0] ?? '').slice(
    0,
    200,
  ),
);

const pass = checks.every((c) => c.ok);
await writeFile(
  path.join(root, 'upgrade-report.json'),
  JSON.stringify({ old_version: oldVersion, pass, checks }, null, 2),
);
process.stdout.write(`\nUpgrade check ${pass ? 'PASSED' : 'FAILED'} (${oldVersion} -> current)\n`);
if (!values.keep) await rm(path.join(root, 'oaa'), { recursive: true, force: true });
process.exitCode = pass ? 0 : 1;
