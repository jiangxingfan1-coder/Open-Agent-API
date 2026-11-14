import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { gatewaySchema, initialize } from '../src/config/config.js';

// The macOS shell (desktop/macos). Its pure logic (language choice, string table, configuration and
// port handling, ownership of a running gateway, the page script that hands the admin key to the
// console) is compiled with the system swiftc together with desktop/macos/tests/main.swift and run
// as a plain command-line program: no window, no app bundle, no network, no port, nothing outside a
// temporary directory. The AppKit part (main.swift) is only type-checked by the packaging step and
// cannot be tested here; the source checks below at least keep it free of hard-coded text.

const SWIFTC = '/usr/bin/swiftc';
const skip =
  process.platform !== 'darwin' || !existsSync(SWIFTC)
    ? 'the macOS shell self-check needs macOS and /usr/bin/swiftc'
    : false;

const MACOS_DIR = path.join('desktop', 'macos');

/**
 * The shell's pure files: every .swift file beside main.swift that does not import a UI framework.
 * (The AppKit files, main.swift and Gateway.swift, only compile together with the whole app.)
 */
async function pureSwiftFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const f of (await readdir(MACOS_DIR)).sort()) {
    if (!f.endsWith('.swift') || f === 'main.swift') continue;
    const text = await readFile(path.join(MACOS_DIR, f), 'utf8');
    if (!/^import (Cocoa|AppKit|WebKit|UserNotifications)\b/m.test(text))
      files.push(path.join(MACOS_DIR, f));
  }
  return files;
}

/** Compiles the shell's pure files with the self-check once and returns the executable. */
let compiled: Promise<{ exe: string; dir: string }> | undefined;
function compileChecks(): Promise<{ exe: string; dir: string }> {
  compiled ??= (async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-shell-checks-'));
    const pure = await pureSwiftFiles();
    const exe = path.join(dir, 'shell-checks');
    const result = spawnSync(
      SWIFTC,
      [
        '-module-cache-path',
        path.join(dir, 'module-cache'),
        ...pure,
        path.join(MACOS_DIR, 'tests', 'main.swift'),
        '-o',
        exe,
      ],
      { encoding: 'utf8', timeout: 100_000 },
    );
    assert.equal(result.status, 0, `swiftc failed:\n${result.stderr}`);
    return { exe, dir };
  })();
  return compiled;
}

test.after(async () => {
  if (compiled) await rm((await compiled).dir, { recursive: true, force: true });
});

test('macOS shell: the Swift self-check passes', { skip }, async () => {
  const { exe } = await compileChecks();
  const run = spawnSync(exe, [], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const summary = /shell checks: (\d+) run, (\d+) failed/.exec(run.stdout);
  assert.ok(summary, run.stdout);
  assert.ok(Number(summary[1]) > 50, `expected a real set of checks, saw ${summary[1]}`);
});

test('macOS shell: no Chinese text outside the string table', async () => {
  // Every user-visible string goes through Strings.swift; comments are English.
  const cjk = /[　-〿一-鿿＀-￯]/;
  const problems: string[] = [];
  for (const file of await readdir(MACOS_DIR)) {
    if (!file.endsWith('.swift') || file === 'Strings.swift') continue;
    const lines = (await readFile(path.join(MACOS_DIR, file), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (cjk.test(line)) problems.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(problems, []);
});

test('macOS shell: its default port is the gateway default and init writes the port it reads', async () => {
  const constant = /^let gatewayDefaultPort = (\d+)$/m.exec(
    await readFile(path.join(MACOS_DIR, 'ShellCore.swift'), 'utf8'),
  );
  assert.ok(constant, 'ShellCore.swift declares gatewayDefaultPort');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-shell-init-'));
  try {
    const file = await initialize(dir);
    const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    // `oaa init` writes the port explicitly, so the shell never has to guess it.
    assert.equal(typeof config.port, 'number');
    delete config.port;
    assert.equal(gatewaySchema.parse(config).port, Number(constant[1]));
    if (skip) return;
    const { exe } = await compileChecks();
    const read = spawnSync(exe, ['config-port', file], { encoding: 'utf8' });
    assert.equal(read.stdout.trim(), `valid(${Number(constant[1])})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A minimal Web Storage. */
class FakeStorage {
  readonly items = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.items.set(k, v);
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

interface PageState {
  /** What the console's own code (web/lib/state.js) takes as its key when the page loads. */
  consoleToken: string;
  session: Record<string, string>;
  local: Record<string, string>;
}

let stateLoads = 0;
/**
 * Loads a console page the way the shell does: the injected script runs first (at document start),
 * then the real web/lib/state.js is evaluated against the same storages.
 */
async function loadConsole(opts: {
  script: string | undefined;
  origin: string;
  session?: Record<string, string>;
  local?: Record<string, string>;
}): Promise<PageState> {
  const session = new FakeStorage(opts.session);
  const local = new FakeStorage(opts.local);
  if (opts.script !== undefined)
    vm.runInNewContext(opts.script, {
      sessionStorage: session,
      localStorage: local,
      location: { origin: opts.origin },
    });
  const names = ['sessionStorage', 'localStorage', 'window', 'document'] as const;
  const saved = names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const);
  const matchMedia = () => ({ matches: false, addEventListener: () => undefined });
  Object.assign(globalThis, {
    sessionStorage: session,
    localStorage: local,
    window: { matchMedia },
    document: { documentElement: { dataset: {} } },
  });
  try {
    const state = (await import(
      `${pathToFileURL(path.resolve('web/lib/state.js')).href}?load=${++stateLoads}`
    )) as { state: { token: string } };
    return {
      consoleToken: state.state.token,
      session: Object.fromEntries(session.items),
      local: Object.fromEntries(local.items),
    };
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

function shellScript(token: string, origin: string): string {
  const run = spawnSync(compiledExe(), ['token-script', token, origin], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

let compiledPath = '';
const compiledExe = () => compiledPath;

const ORIGIN = 'http://127.0.0.1:8787';
const LEGACY_LOCAL = { 'oaa-token': 'old', oaa_token: 'old', oaa_admin_token: 'old' };

test(
  'console key: the shell injects it into sessionStorage and the console picks it up',
  { skip },
  async () => {
    compiledPath = (await compileChecks()).exe;
    const page = await loadConsole({ script: shellScript('sk-oaa-fresh', ORIGIN), origin: ORIGIN });
    assert.equal(page.consoleToken, 'sk-oaa-fresh');
    assert.deepEqual(page.session, { 'oaa-token': 'sk-oaa-fresh' });
    assert.deepEqual(page.local, {}, 'nothing reaches persistent storage');
  },
);

test(
  'console key: copies that old versions left in localStorage are removed, not used',
  { skip },
  async () => {
    compiledPath = (await compileChecks()).exe;
    const settings = { 'oaa.console.lang': 'en', 'oaa.prefs.v1': '{"theme":"dark"}' };
    const page = await loadConsole({
      script: shellScript('sk-oaa-new', ORIGIN),
      origin: ORIGIN,
      session: { oaa_token: 'old' },
      local: { ...LEGACY_LOCAL, ...settings },
    });
    assert.equal(page.consoleToken, 'sk-oaa-new', 'the new key wins');
    assert.deepEqual(page.session, { 'oaa-token': 'sk-oaa-new' });
    assert.deepEqual(page.local, settings, 'only the key copies go; language and preferences stay');
  },
);

test(
  'console key: the console ignores a localStorage copy, so a missing key means not connected',
  { skip },
  async () => {
    compiledPath = (await compileChecks()).exe;
    // Without a key to inject the shell still cleans up, and the console starts disconnected.
    const page = await loadConsole({
      script: shellScript('', ORIGIN),
      origin: ORIGIN,
      local: { ...LEGACY_LOCAL },
    });
    assert.equal(page.consoleToken, '');
    assert.deepEqual(page.local, {});
    // And the same page without the shell's script (a plain browser tab) never reads localStorage.
    const plain = await loadConsole({
      script: undefined,
      origin: ORIGIN,
      local: { ...LEGACY_LOCAL },
    });
    assert.equal(plain.consoleToken, '');
  },
);

test('console key: a page on another origin gets nothing', { skip }, async () => {
  compiledPath = (await compileChecks()).exe;
  const page = await loadConsole({
    script: shellScript('sk-oaa-secret', ORIGIN),
    origin: 'https://example.com',
    local: { unrelated: '1' },
  });
  assert.deepEqual(page.session, {});
  assert.deepEqual(page.local, { unrelated: '1' });
  assert.equal(page.consoleToken, '');
});

test('console key: awkward characters survive the injection exactly', { skip }, async () => {
  compiledPath = (await compileChecks()).exe;
  const awkward = `a'b"c\\d\n</script>é \u{1F511}`;
  const page = await loadConsole({ script: shellScript(awkward, ORIGIN), origin: ORIGIN });
  assert.equal(page.consoleToken, awkward);
});

test('console key: no console code reads or writes the key in localStorage', async () => {
  const problems: string[] = [];
  for (const entry of await readdir('web', { recursive: true })) {
    if (!entry.endsWith('.js') || entry.startsWith('vendor')) continue;
    const text = await readFile(path.join('web', entry), 'utf8');
    if (/localStorage[^;]*['"`]oaa[-_](admin_)?token/.test(text)) problems.push(entry);
  }
  assert.deepEqual(problems, []);
  assert.match(
    await readFile('web/lib/state.js', 'utf8'),
    /sessionStorage\.getItem\('oaa-token'\)/,
  );
});

test('macOS shell: the page scripts run in the main frame only', async () => {
  const main = await readFile(path.join(MACOS_DIR, 'main.swift'), 'utf8');
  assert.doesNotMatch(main, /forMainFrameOnly:\s*false/);
  assert.match(main, /ConsoleBridge\.tokenScript/);
  assert.doesNotMatch(main, /localStorage\.setItem/);
});

test('macOS shell: the gateway reports the protocol and pid that the ownership check relies on', async () => {
  const server = await readFile('src/gateway/server.ts', 'utf8');
  const payload = /const healthPayload = [\s\S]*?\}\);/.exec(server)?.[0] ?? '';
  assert.match(payload, /protocol: 'oaa\/1'/);
  assert.match(payload, /isLocalProbe\(req\) \? \{ pid: process\.pid \}/);
  // The command line the check looks for in `ps` is the one the shell starts and `oaa serve --detach` starts.
  const gateway = await readFile('desktop/macos/Gateway.swift', 'utf8');
  assert.match(gateway, /"serve", "--config", configPath/);
  assert.match(await readFile('src/client/onboarding.ts', 'utf8'), /'serve',\s+'--config',\s+file/);
});
