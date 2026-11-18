import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

interface StringsModule {
  en: Record<string, string>;
  zh: Record<string, string>;
  resolveLocale(preferred: string | string[]): 'zh' | 'en';
  formatText(lang: 'zh' | 'en', key: string, params?: Record<string, string | number>): string;
  placeholders(text: string): string[];
}

interface PortProbeResult {
  state: 'silent' | 'gateway' | 'other';
  pid: number | null;
}

interface LaunchProblem {
  kind: 'homeNotAbsolute' | 'invalidPort' | 'portNeedsHome';
  value?: string;
}

interface StartupProblem {
  kind:
    | 'portHeldByOther'
    | 'portHeldByGateway'
    | 'invalidConfigPort'
    | 'configUnavailable'
    | 'gatewayNotStarted';
  port?: number;
  configPath?: string;
  value?: string;
  dir?: string;
  logPath?: string;
}

interface CoreModule {
  GATEWAY_DEFAULT_PORT: number;
  FIRST_RUN_MARKER: string;
  SAMPLE_AGENT_ID: string;
  ANTIGRAVITY_AGENT_ID: string;
  macosWindowChromeOptions(platform?: string): {
    titleBarStyle?: string;
    trafficLightPosition?: { x: number; y: number };
  };
  dataDirectory(platform?: string, env?: Record<string, string>, home?: string): string;
  validPort(text: string): number | null;
  parseLaunchOptions(opts?: {
    env?: Record<string, string | undefined>;
    argv?: string[];
    platform?: string;
    home?: string;
    isPackaged?: boolean;
  }): {
    dataDir: string | null;
    isolated: boolean;
    port: number | null;
    enableNotifications: boolean;
    problem: LaunchProblem | null;
  };
  portSetting(
    config: Record<string, unknown>,
  ): { kind: 'unset' } | { kind: 'valid'; port: number } | { kind: 'invalid'; value: string };
  prepareConfigForStart(
    input: Record<string, unknown>,
    opts?: {
      isExecutable?: (filePath: string) => boolean;
      sampleScript?: string | null;
      nodeCommand?: string;
      portOverride?: number | null;
    },
  ): {
    json: Record<string, unknown>;
    modified: boolean;
    enabledEngines: string[];
  };
  classifyPortProbe(statusCode: number | null, bodyText: string | null): PortProbeResult;
  commandServesConfig(commandLine: string, configPath: string): boolean;
  isOwnGateway(opts: {
    pid: number | null;
    ownChildPid?: number | null;
    serverPidFromFile?: number | null;
    commandLine?: string | null;
    configPaths?: string[];
  }): boolean;
  judgePortOwnership(opts: {
    probe: PortProbeResult;
    ownChildPid?: number | null;
    serverPidFromFile?: number | null;
    commandLine?: string | null;
    configPaths?: string[];
    port: number;
    configPath: string;
  }):
    | { action: 'wait' }
    | { action: 'attach'; pid: number }
    | { action: 'problem'; problem: StartupProblem };
  logShowsAddressInUse(logTail: string): boolean;
  startupProblemText(problem: StartupProblem, lang?: 'zh' | 'en'): { title: string; body: string };
  launchProblemText(problem: LaunchProblem, lang?: 'zh' | 'en'): { title: string; body: string };
  formatDockBadge(count: number): string;
  enabledEnginesInConfig(
    configJson: Record<string, unknown>,
    isExecutable?: (filePath: string) => boolean,
  ): string[];
  composeFirstRunNotice(opts: { engines?: string[]; published?: string[]; lang?: 'zh' | 'en' }): {
    title: string;
    body: string;
    actionLabel: string;
    dismissLabel: string;
  } | null;
  ensureFirstRunMarker<T>(
    dataDir: string,
    seedWork?: () => Promise<T>,
  ): Promise<{ firstRun: boolean; markerPath: string; result: T | null }>;
  splashHTML(opts?: {
    status?: string;
    problem?: { title: string; body: string } | null;
    lang?: 'zh' | 'en';
  }): string;
}

interface PendingApprovalItem {
  runId: string;
  actionId: string;
  agent: string;
  input: string;
  kind: 'native' | 'tool';
  expiresAt: number | null;
  preview: string;
}

interface TrayPanelModule {
  extractOwnerApprovalRuns(runs: Record<string, unknown>[]): Record<string, unknown>[];
  countActiveRuns(overview: Record<string, unknown>): number;
  collectPendingApprovals(
    runs: Record<string, unknown>[],
    actionsByRunId: Record<string, Record<string, unknown>[]>,
  ): PendingApprovalItem[];
  diffFreshOwnerApprovals(
    runs: Record<string, unknown>[],
    seenRunIds: Set<string>,
    primed: boolean,
    lang?: 'zh' | 'en',
  ): {
    shouldNotify: boolean;
    primed: boolean;
    freshRuns: Record<string, unknown>[];
    notification: { runId: string; title: string; body: string } | null;
    seenRunIds: Set<string>;
  };
  buildApprovalDecisionRequest(opts: {
    origin: string;
    token: string;
    runId: string;
    actionId: string;
    decision: string;
    response?: Record<string, unknown>;
  }): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  resolveLoginItemState(opts: {
    app?: { getLoginItemSettings?: () => { openAtLogin?: boolean } } | null;
    isolated?: boolean;
  }): { openAtLogin: boolean; enabled: boolean; reason: string | null };
  updateLoginItemState(opts: {
    app?: {
      getLoginItemSettings?: () => { openAtLogin?: boolean };
      setLoginItemSettings?: (s: { openAtLogin: boolean }) => void;
    } | null;
    isolated?: boolean;
    openAtLogin?: boolean;
  }): { ok: boolean; openAtLogin: boolean; enabled: boolean; reason: string | null };
  buildTrayContextMenuTemplate(opts: {
    state: Record<string, unknown>;
    lang?: 'zh' | 'en';
    callbacks?: Record<string, (...args: unknown[]) => void>;
  }): Array<Record<string, unknown>>;
  computePanelBounds(opts: {
    trayBounds?: { x: number; y: number; width: number; height: number } | null;
    workArea?: { x: number; y: number; width: number; height: number };
    width?: number;
    height?: number;
    platform?: string;
  }): { x: number; y: number; width: number; height: number };
  renderTrayPanelHTML(opts?: { lang?: 'zh' | 'en' }): string;
  createTrayController(opts: Record<string, unknown>): {
    init(): unknown;
    updateState(patch: Record<string, unknown>): void;
    togglePanel(): void;
    ensurePanelWindow(): { webPreferences: Record<string, unknown> };
    getState(): Record<string, unknown>;
    hasTray(): boolean;
    destroy(): void;
  };
}

const strings = require('../../desktop/cross-platform/strings.cjs') as StringsModule;
const core = require('../../desktop/cross-platform/core.cjs') as CoreModule;
const tray = require('../../desktop/cross-platform/tray-panel.cjs') as TrayPanelModule;

test('macOS native chrome & bilingual string table parity across English and Chinese', async () => {
  assert.deepEqual(core.macosWindowChromeOptions('darwin'), {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 18 },
  });
  assert.deepEqual(core.macosWindowChromeOptions('win32'), {});
  assert.deepEqual(core.macosWindowChromeOptions('linux'), {});

  assert.equal(strings.resolveLocale(['zh-Hans-CN', 'en']), 'zh');
  assert.equal(strings.resolveLocale(['zh-TW']), 'zh');
  assert.equal(strings.resolveLocale('ZH-cn'), 'zh');
  assert.equal(strings.resolveLocale(['en-US', 'zh-CN']), 'en');
  assert.equal(strings.resolveLocale('ja-JP'), 'en');
  assert.equal(strings.resolveLocale([]), 'zh');

  const enKeys = Object.keys(strings.en).sort();
  const zhKeys = Object.keys(strings.zh).sort();
  assert.deepEqual(enKeys, zhKeys, 'en and zh dictionaries must define identical keys');

  const cjk = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;
  for (const key of enKeys) {
    const enText = strings.en[key]!;
    const zhText = strings.zh[key]!;
    assert.ok(enText.length > 0 && zhText.length > 0, `${key} must be non-empty`);
    assert.notEqual(enText, zhText, `${key} must be localized in both languages`);
    assert.doesNotMatch(enText, cjk, `${key}: English text must not contain CJK characters`);
    assert.deepEqual(
      strings.placeholders(enText),
      strings.placeholders(zhText),
      `${key}: placeholder sets must match`,
    );
  }

  assert.equal(
    strings.formatText('en', 'statusBadgeMany', { count: 3 }),
    'Open Agent API · 3 requests awaiting approval',
  );
  assert.equal(
    strings.formatText('zh', 'statusBadgeMany', { count: 3 }),
    'Open Agent API · 3 个请求等待审批',
  );

  const splash = core.splashHTML({
    problem: { title: 'Port <8787>', body: '/Users/a&b/"config.json"' },
    lang: 'zh',
  });
  assert.match(splash, /<html lang="zh-CN">/);
  assert.match(splash, /Port &lt;8787&gt;/);
  assert.match(splash, /\/Users\/a&amp;b\/&quot;config\.json&quot;/);
  assert.doesNotMatch(splash, /<p>/);
});

test('three-state port ownership verification distinguishes free port, own orphan gateway and foreign services', () => {
  assert.deepEqual(core.classifyPortProbe(null, null), { state: 'silent', pid: null });
  assert.deepEqual(
    core.classifyPortProbe(200, JSON.stringify({ status: 'ok', protocol: 'oaa/1', pid: 4242 })),
    { state: 'gateway', pid: 4242 },
  );
  assert.deepEqual(
    core.classifyPortProbe(200, JSON.stringify({ status: 'ok', protocol: 'oaa/1', pid: true })),
    { state: 'gateway', pid: null },
  );
  assert.deepEqual(core.classifyPortProbe(200, JSON.stringify({ status: 'ok' })), {
    state: 'other',
    pid: null,
  });
  assert.deepEqual(core.classifyPortProbe(200, '<html>foreign</html>'), {
    state: 'other',
    pid: null,
  });
  assert.deepEqual(core.classifyPortProbe(403, JSON.stringify({ protocol: 'oaa/1', pid: 10 })), {
    state: 'other',
    pid: null,
  });

  const cfg = '/Users/me/Library/Application Support/OpenAgentAPI/config.json';
  assert.equal(core.commandServesConfig(`/opt/node cli.js serve --config "${cfg}"`, cfg), true);
  assert.equal(
    core.commandServesConfig(`node cli.js serve --config ${cfg} --tool-config /tmp/t.json`, cfg),
    true,
  );
  assert.equal(core.commandServesConfig(`node cli.js serve --config ${cfg}.bak`, cfg), false);
  assert.equal(
    core.commandServesConfig('node cli.js serve --config /other/dir/config.json', cfg),
    false,
  );

  // State 1: silent -> wait & start own gateway
  assert.deepEqual(
    core.judgePortOwnership({
      probe: { state: 'silent', pid: null },
      port: 8787,
      configPath: cfg,
    }),
    { action: 'wait' },
  );

  // State 2: non-OAA service -> portHeldByOther
  assert.deepEqual(
    core.judgePortOwnership({
      probe: { state: 'other', pid: null },
      port: 8787,
      configPath: cfg,
    }),
    {
      action: 'problem',
      problem: { kind: 'portHeldByOther', port: 8787, configPath: cfg },
    },
  );

  // State 3a: verified orphan gateway from the same data directory (or symlinked path) -> attach
  assert.deepEqual(
    core.judgePortOwnership({
      probe: { state: 'gateway', pid: 888 },
      commandLine: 'node dist/src/cli.js serve --config /private/var/oaa/config.json',
      configPaths: ['/var/oaa/config.json', '/private/var/oaa/config.json'],
      port: 8787,
      configPath: '/var/oaa/config.json',
    }),
    { action: 'attach', pid: 888 },
  );

  // Fallback when ps commandLine is unavailable (e.g. Windows) but server.pid matches
  assert.deepEqual(
    core.judgePortOwnership({
      probe: { state: 'gateway', pid: 999 },
      serverPidFromFile: 999,
      commandLine: null,
      configPaths: [cfg],
      port: 8787,
      configPath: cfg,
    }),
    { action: 'attach', pid: 999 },
  );

  // State 3b: foreign OAA gateway from another data folder -> portHeldByGateway
  const foreignDecision = core.judgePortOwnership({
    probe: { state: 'gateway', pid: 888 },
    commandLine: 'node dist/src/cli.js serve --config /someone/else/config.json',
    configPaths: [cfg],
    port: 8787,
    configPath: cfg,
  });
  assert.deepEqual(foreignDecision, {
    action: 'problem',
    problem: { kind: 'portHeldByGateway', port: 8787, configPath: cfg },
  });

  assert.equal(
    core.logShowsAddressInUse('Error: listen EADDRINUSE: address already in use 127.0.0.1:8787'),
    true,
  );
  assert.equal(core.logShowsAddressInUse('Gateway listening on 127.0.0.1:8787'), false);

  for (const lang of ['en', 'zh'] as const) {
    for (const kind of [
      'portHeldByOther',
      'portHeldByGateway',
      'invalidConfigPort',
      'configUnavailable',
      'gatewayNotStarted',
    ] as const) {
      const msg = core.startupProblemText(
        {
          kind,
          port: 18787,
          configPath: cfg,
          value: '"bad"',
          dir: '/tmp/oaa',
          logPath: '/tmp/oaa/server.log',
        },
        lang,
      );
      assert.ok(msg.title.length > 0 && msg.body.length > 0);
      assert.ok(!msg.title.includes('{') && !msg.body.includes('{'));
    }
  }
});

test('isolated launch options parsing and Launch at Login isolation protection', () => {
  const exe = '/Applications/Open Agent API.app/Contents/MacOS/OpenAgentAPI';

  const normal = core.parseLaunchOptions({
    env: {},
    argv: [exe],
    platform: 'darwin',
    home: '/Users/alice',
  });
  assert.equal(normal.isolated, false);
  assert.equal(normal.port, null);
  assert.equal(normal.problem, null);
  assert.equal(normal.dataDir, '/Users/alice/Library/Application Support/OpenAgentAPI');

  const envIsolated = core.parseLaunchOptions({
    env: { OAA_DESKTOP_HOME: '~/oaa-iso/', OAA_DESKTOP_PORT: '18787' },
    argv: [exe],
    platform: 'darwin',
    home: '/Users/alice',
    isPackaged: true,
  });
  assert.equal(envIsolated.isolated, true);
  assert.equal(envIsolated.dataDir, '/Users/alice/oaa-iso');
  assert.equal(envIsolated.port, 18787);
  assert.equal(envIsolated.problem, null);

  const cliWins = core.parseLaunchOptions({
    env: { OAA_DESKTOP_HOME: '/tmp/from-env', OAA_DESKTOP_PORT: '18787' },
    argv: [exe, '--enable-notifications', '--oaa-data-dir', '/tmp/from-cli', '--port=19001'],
    platform: 'linux',
    home: '/home/alice',
    isPackaged: true,
  });
  assert.equal(cliWins.isolated, true);
  assert.equal(cliWins.dataDir, '/tmp/from-cli');
  assert.equal(cliWins.port, 19001);
  assert.equal(cliWins.enableNotifications, true);

  const winIsolated = core.parseLaunchOptions({
    env: { OAA_DESKTOP_HOME: 'C:\\Temp\\OAA\\', OAA_DESKTOP_PORT: '9090' },
    argv: ['C:\\App\\open-agent-api.exe'],
    platform: 'win32',
    home: 'C:\\Users\\Alice',
  });
  assert.equal(winIsolated.isolated, true);
  assert.equal(winIsolated.dataDir, 'C:\\Temp\\OAA');
  assert.equal(winIsolated.port, 9090);

  // Relative home path is rejected
  const relProblem = core.parseLaunchOptions({
    env: { OAA_DESKTOP_HOME: 'relative/folder' },
    argv: [exe],
    platform: 'darwin',
    home: '/Users/alice',
  });
  assert.deepEqual(relProblem.problem, { kind: 'homeNotAbsolute', value: 'relative/folder' });

  // Invalid port is rejected
  for (const bad of ['0', '65536', '-1', '8787.5', 'abc']) {
    const p = core.parseLaunchOptions({
      env: { OAA_DESKTOP_HOME: '/tmp/oaa', OAA_DESKTOP_PORT: bad },
      argv: [exe],
      platform: 'darwin',
      home: '/Users/alice',
    });
    assert.deepEqual(p.problem, { kind: 'invalidPort', value: bad });
  }

  // Port without isolated home is rejected so default config.json is never mutated
  const orphanPort = core.parseLaunchOptions({
    env: { OAA_DESKTOP_PORT: '18787' },
    argv: [exe],
    platform: 'darwin',
    home: '/Users/alice',
  });
  assert.deepEqual(orphanPort.problem, { kind: 'portNeedsHome' });

  // Launch at Login: strictly disabled in isolated mode, mutable only when explicitly toggled in normal mode
  let loginFlag = false;
  let calls = 0;
  const fakeApp = {
    getLoginItemSettings: () => ({ openAtLogin: loginFlag }),
    setLoginItemSettings: ({ openAtLogin }: { openAtLogin: boolean }) => {
      calls++;
      loginFlag = openAtLogin;
    },
  };
  assert.deepEqual(tray.resolveLoginItemState({ app: fakeApp, isolated: true }), {
    openAtLogin: false,
    enabled: false,
    reason: 'isolated',
  });
  const deniedUpdate = tray.updateLoginItemState({
    app: fakeApp,
    isolated: true,
    openAtLogin: true,
  });
  assert.equal(deniedUpdate.ok, false);
  assert.equal(calls, 0, 'isolated run must never touch OS login items');

  const enabledUpdate = tray.updateLoginItemState({
    app: fakeApp,
    isolated: false,
    openAtLogin: true,
  });
  assert.equal(enabledUpdate.ok, true);
  assert.equal(enabledUpdate.openAtLogin, true);
  assert.equal(calls, 1);
});

test('first-run .seeded marker idempotency and config preparation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-unified-seed-'));
  try {
    let seedRuns = 0;
    const first = await core.ensureFirstRunMarker(dir, async () => {
      seedRuns++;
      return { engines: ['codex'], published: ['agent/sample'] };
    });
    assert.equal(first.firstRun, true);
    assert.equal(seedRuns, 1);

    const second = await core.ensureFirstRunMarker(dir, async () => {
      seedRuns++;
      return { engines: [], published: [] };
    });
    assert.equal(second.firstRun, false);
    assert.equal(second.result, null);
    assert.equal(seedRuns, 1, 'second launch must skip seeding idempotently');

    const zhNotice = core.composeFirstRunNotice({
      engines: ['codex', 'claude'],
      published: ['agent/sample'],
      lang: 'zh',
    });
    assert.ok(zhNotice);
    assert.match(zhNotice.body, /Codex、Claude Code/);
    assert.match(zhNotice.body, /agent\/sample/);

    const enNotice = core.composeFirstRunNotice({
      engines: ['codex', 'claude'],
      published: ['agent/sample', 'agent/antigravity'],
      lang: 'en',
    });
    assert.ok(enNotice);
    assert.match(enNotice.body, /Codex, Claude Code/);
    assert.match(enNotice.body, /agent\/antigravity/);
    assert.equal(core.composeFirstRunNotice({ engines: [], published: [] }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const prepared = core.prepareConfigForStart(
    {
      port: 8787,
      localAgents: ['legacy'],
      localWorker: {
        native: {
          codex: { executable: '/usr/local/bin/codex', enabled: false },
          dsh: { executable: '/missing/dsh', enabled: false },
        },
      },
    },
    {
      isExecutable: (p) => p !== '/missing/dsh',
      sampleScript: '/app/examples/sample-agent.mjs',
      nodeCommand: '/runtime/bin/node',
      portOverride: 18787,
    },
  );
  assert.equal(prepared.modified, true);
  assert.equal('localAgents' in prepared.json, false);
  assert.deepEqual(prepared.enabledEngines, ['codex']);
  assert.equal(prepared.json.port, 18787);

  const secondPass = core.prepareConfigForStart(prepared.json, {
    isExecutable: (p) => p !== '/missing/dsh',
    sampleScript: '/app/examples/sample-agent.mjs',
    nodeCommand: '/runtime/bin/node',
    portOverride: 18787,
  });
  assert.equal(secondPass.modified, false);
});

test('tray quick panel pending owner approvals, notifications, badges and decision request builder', () => {
  assert.equal(core.formatDockBadge(0), '');
  assert.equal(core.formatDockBadge(-3), '');
  assert.equal(core.formatDockBadge(1), '1');
  assert.equal(core.formatDockBadge(99), '99');
  assert.equal(core.formatDockBadge(145), '99+');

  const runs = [
    {
      id: 'run_owner_1',
      agent: 'agent/codex',
      status: 'requires_action',
      waiting_on: 'owner',
      input: 'Deploy service',
    },
    {
      id: 'run_caller_1',
      agent: 'agent/bridge',
      status: 'requires_action',
      waiting_on: 'caller',
      input: 'Read local file',
    },
    { id: 'run_active_1', agent: 'agent/sample', status: 'in_progress', input: 'Summarize' },
  ];

  const ownerOnly = tray.extractOwnerApprovalRuns(runs);
  assert.deepEqual(
    ownerOnly.map((r) => r.id),
    ['run_owner_1'],
    'caller tool waits must not appear as manual owner approvals',
  );

  const items = tray.collectPendingApprovals(runs, {
    run_owner_1: [
      {
        id: 'act_1',
        kind: 'native',
        expires_at: Date.now() + 60_000,
        detail: { preview: JSON.stringify({ tool: 'bash', reason: 'Run migrations' }) },
      },
      {
        id: 'act_caller_ignored',
        kind: 'client_tool',
        expires_at: Date.now() + 60_000,
        detail: { preview: '{}' },
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.actionId, 'act_1');
  assert.equal(items[0]?.kind, 'native');
  assert.match(items[0]?.preview ?? '', /bash — Run migrations/);

  // Notification priming & fresh detection
  const seen = new Set<string>();
  const firstDiff = tray.diffFreshOwnerApprovals(runs, seen, false, 'zh');
  assert.equal(
    firstDiff.shouldNotify,
    false,
    'initial prime must not spam historical notifications',
  );
  assert.equal(firstDiff.primed, true);

  const nextRuns = [
    ...runs,
    { id: 'run_owner_2', agent: 'agent/claude', status: 'requires_action', waiting_on: 'owner' },
  ];
  const secondDiff = tray.diffFreshOwnerApprovals(nextRuns, firstDiff.seenRunIds, true, 'zh');
  assert.equal(secondDiff.shouldNotify, true);
  assert.equal(secondDiff.notification?.runId, 'run_owner_2');
  assert.match(secondDiff.notification?.body ?? '', /agent\/claude/);

  const thirdDiff = tray.diffFreshOwnerApprovals(nextRuns, secondDiff.seenRunIds, true, 'zh');
  assert.equal(thirdDiff.shouldNotify, false, 'already notified run must not alert twice');

  // Decision HTTP request builder (/v1/runs/:id/actions/:actionId)
  const approveReq = tray.buildApprovalDecisionRequest({
    origin: 'http://127.0.0.1:8787',
    token: 'sk-oaa-local-admin-token-123456',
    runId: 'run:123',
    actionId: 'act:456',
    decision: 'approve',
  });
  assert.equal(approveReq.method, 'POST');
  assert.equal(approveReq.url, 'http://127.0.0.1:8787/v1/runs/run%3A123/actions/act%3A456');
  assert.equal(approveReq.headers.Authorization, 'Bearer sk-oaa-local-admin-token-123456');
  assert.deepEqual(JSON.parse(approveReq.body), { decision: 'approve', response: {} });

  const denyReq = tray.buildApprovalDecisionRequest({
    origin: 'http://127.0.0.1:8787',
    token: 'sk-oaa-local-admin-token-123456',
    runId: 'run_1',
    actionId: 'act_1',
    decision: 'deny',
  });
  assert.deepEqual(JSON.parse(denyReq.body), { decision: 'deny', response: {} });

  // Reject unsafe origins, decisions, or path traversal IDs
  assert.throws(() =>
    tray.buildApprovalDecisionRequest({
      origin: 'https://evil.example.com',
      token: 'sk-oaa-local-admin-token-123456',
      runId: 'run_1',
      actionId: 'act_1',
      decision: 'approve',
    }),
  );
  assert.throws(() =>
    tray.buildApprovalDecisionRequest({
      origin: 'http://127.0.0.1:8787',
      token: 'sk-oaa-local-admin-token-123456',
      runId: '../etc/passwd',
      actionId: 'act_1',
      decision: 'approve',
    }),
  );
  assert.throws(() =>
    tray.buildApprovalDecisionRequest({
      origin: 'http://127.0.0.1:8787',
      token: 'sk-oaa-local-admin-token-123456',
      runId: 'run_1',
      actionId: 'act_1',
      decision: 'maybe',
    }),
  );

  // Tray menu template & strict CSP panel HTML
  const menu = tray.buildTrayContextMenuTemplate({
    state: {
      online: true,
      attached: false,
      address: '127.0.0.1:8787',
      runningCount: 2,
      pendingCount: 1,
      approvals: items,
      canStopGateway: true,
      loginItem: { openAtLogin: false, enabled: true, reason: null },
    },
    lang: 'zh',
  });
  assert.ok(menu.some((m) => String(m.label ?? '').includes('127.0.0.1:8787')));
  assert.ok(
    menu.some((m) => m.type === 'checkbox' && String(m.label ?? '').includes('开机自动启动')),
  );

  const html = tray.renderTrayPanelHTML({ lang: 'zh' });
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /sk-oaa-/);
});

test('desktop security invariants & tray controller sandboxed IPC frame verification', async () => {
  const mainSource = await readFile('desktop/cross-platform/main.cjs', 'utf8');
  const traySource = await readFile('desktop/cross-platform/tray-panel.cjs', 'utf8');
  for (const src of [mainSource, traySource]) {
    assert.match(src, /nodeIntegration:\s*false/);
    assert.match(src, /contextIsolation:\s*true/);
    assert.match(src, /sandbox:\s*true/);
  }
  const macReadme = await readFile('desktop/macos/README.md', 'utf8');
  assert.match(macReadme, /desktop\/cross-platform/);

  // Simulate tray quick panel lifecycle & IPC security boundary without real Electron GUI
  const handlers = new Map<
    string,
    (event: unknown, payload?: unknown) => Promise<unknown> | unknown
  >();
  const decisions: Array<{ runId: string; actionId: string; decision: string }> = [];
  const mainFrame = { id: 'panel-main-frame' };
  const webContents = {
    mainFrame,
    session: {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
    },
    setWindowOpenHandler: () => undefined,
    on: () => undefined,
    send: () => undefined,
  };

  class MockBrowserWindow {
    webPreferences: Record<string, unknown>;
    webContents = webContents;
    visible = false;
    destroyed = false;
    constructor(opts: { webPreferences: Record<string, unknown> }) {
      this.webPreferences = opts.webPreferences;
    }
    on() {}
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    setBounds() {}
    show() {
      this.visible = true;
    }
    focus() {}
    hide() {
      this.visible = false;
    }
    destroy() {
      this.destroyed = true;
    }
  }

  class MockTray {
    setToolTip() {}
    setTitle() {}
    setContextMenu() {}
    on() {}
    getBounds() {
      return { x: 1100, y: 0, width: 22, height: 22 };
    }
    destroy() {}
  }

  const controller = tray.createTrayController({
    app: {
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => undefined,
    },
    BrowserWindow: MockBrowserWindow,
    Menu: { buildFromTemplate: (tpl: unknown) => tpl },
    Tray: MockTray,
    nativeImage: {
      createFromPath: () => ({
        resize: () => ({ setTemplateImage: () => undefined }),
      }),
    },
    ipcMain: {
      removeHandler: (ch: string) => handlers.delete(ch),
      handle: (ch: string, fn: (e: unknown, p?: unknown) => unknown) => handlers.set(ch, fn),
      on: () => undefined,
    },
    screen: {
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 876 } }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 876 } }),
    },
    trayIconPath: '/tmp/icon.png',
    isTemplateIcon: true,
    getLang: () => 'zh',
    isIsolated: () => true,
    onDecideApproval: async (d: { runId: string; actionId: string; decision: string }) => {
      decisions.push(d);
    },
    callbacks: {},
  });

  controller.init();
  const win = controller.ensurePanelWindow();
  assert.equal(win.webPreferences.sandbox, true);
  assert.equal(win.webPreferences.contextIsolation, true);
  assert.equal(win.webPreferences.nodeIntegration, false);

  const decideHandler = handlers.get('oaa:tray:decide')!;
  // Untrusted frame must be rejected
  const spoofed = (await decideHandler(
    { sender: {}, senderFrame: mainFrame },
    { runId: 'r1', actionId: 'a1', decision: 'approve' },
  )) as { ok: boolean };
  assert.equal(spoofed.ok, false);
  assert.equal(decisions.length, 0);

  // Trusted panel mainFrame succeeds
  const accepted = (await decideHandler(
    { sender: webContents, senderFrame: mainFrame },
    { runId: 'r1', actionId: 'a1', decision: 'approve' },
  )) as { ok: boolean };
  assert.equal(accepted.ok, true);
  assert.deepEqual(decisions, [{ runId: 'r1', actionId: 'a1', decision: 'approve' }]);

  controller.destroy();
});

test('unified packaging pipeline --dry-run covers macOS, Windows and Linux without swiftc or host writes', async () => {
  for (const [platform, arch] of [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['linux', 'x64'],
  ] as const) {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        'desktop/cross-platform/build.mjs',
        '--platform',
        platform,
        '--arch',
        arch,
        '--node-version',
        process.versions.node,
        '--dry-run',
      ],
      { timeout: 20_000 },
    );
    const plan = JSON.parse(stdout) as {
      dryRun: boolean;
      shell: string;
      platform: string;
      arch: string;
      shellFiles: string[];
      installed: boolean;
    };
    assert.equal(plan.dryRun, true);
    assert.equal(plan.shell, 'electron-unified');
    assert.equal(plan.platform, platform);
    assert.equal(plan.arch, arch);
    assert.ok(plan.shellFiles.includes('tray-panel.cjs'));
    assert.ok(plan.shellFiles.includes('tray-preload.cjs'));
    assert.equal(plan.installed, false);
  }

  const fakeNodeDir = await mkdtemp(path.join(os.tmpdir(), 'oaa-unified-node-'));
  try {
    await mkdir(path.join(fakeNodeDir, 'bin'), { recursive: true });
    await writeFile(path.join(fakeNodeDir, 'bin', 'node'), 'stub');
    await writeFile(path.join(fakeNodeDir, 'node.exe'), 'stub');
    await writeFile(path.join(fakeNodeDir, 'LICENSE'), 'MIT');

    for (const [target, arch] of [
      ['mac', 'arm64'],
      ['mac', 'x64'],
      ['win', 'x64'],
      ['linux', 'x64'],
    ] as const) {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          'scripts/package-all.mjs',
          target,
          '--release',
          '--arch',
          arch,
          '--node-dir',
          fakeNodeDir,
          '--node-version',
          process.versions.node,
          '--dry-run',
        ],
        { timeout: 30_000, maxBuffer: 4_000_000 },
      );
      assert.doesNotMatch(stdout, /swiftc/, `${target}-${arch} must not invoke swiftc`);
      assert.match(
        stdout,
        /desktop[/\\]cross-platform[/\\]build\.mjs/,
        `${target}-${arch} must delegate desktop shell build to cross-platform Electron`,
      );
      assert.doesNotMatch(stdout, /-> .*[/\\]Applications[/\\]Open Agent API\.app/);
    }
  } finally {
    await rm(fakeNodeDir, { recursive: true, force: true });
  }
});
