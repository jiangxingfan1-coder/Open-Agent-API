'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  shell,
  dialog,
  Notification,
  clipboard,
  nativeTheme,
  screen,
} = require('electron');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const strings = require('./strings.cjs');
const {
  SAMPLE_AGENT_ID,
  ANTIGRAVITY_AGENT_ID,
  macosWindowChromeOptions,
  parseLaunchOptions,
  trustedFrame,
  externalURL,
  safeBrowserURL,
  privateToken,
  portSetting,
  localConfiguration,
  prepareConfigForStart,
  classifyPortProbe,
  judgePortOwnership,
  logShowsAddressInUse,
  startupProblemText,
  launchProblemText,
  formatDockBadge,
  enabledEnginesInConfig,
  composeFirstRunNotice,
  ensureFirstRunMarker,
  splashHTML,
} = require('./core.cjs');
const {
  extractOwnerApprovalRuns,
  countActiveRuns,
  collectPendingApprovals,
  diffFreshOwnerApprovals,
  buildApprovalDecisionRequest,
  resolveLoginItemState,
  updateLoginItemState,
  createTrayController,
} = require('./tray-panel.cjs');

app.setName('Open Agent API');

const currentLang = () => strings.resolveLocale(app.getLocale?.() || 'en');
const text = (key, params) => strings.formatText(currentLang(), key, params);

class StartupProblemError extends Error {
  constructor(problem) {
    const localized = startupProblemText(problem, 'en');
    super(`${localized.title}\n\n${localized.body}`);
    this.problem = problem;
  }
}

const launchOptions = parseLaunchOptions({
  env: process.env,
  argv: process.argv,
  platform: process.platform,
  home: os.homedir(),
  isPackaged: app.isPackaged,
});

function resolveGatewayRoot() {
  if (!app.isPackaged) return path.resolve(__dirname, '../..');
  const candidates = [
    path.join(process.resourcesPath, 'gateway'),
    path.join(process.resourcesPath, 'app'),
    path.resolve(process.resourcesPath, '../../app'),
  ];
  for (const dir of candidates) {
    if (fsSync.existsSync(path.join(dir, 'dist/src/cli.js'))) return dir;
  }
  return candidates[0];
}

function isExecutableSync(filePath) {
  try {
    fsSync.accessSync(
      filePath,
      process.platform === 'win32' ? fsSync.constants.F_OK : fsSync.constants.X_OK,
    );
    return fsSync.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveNodeExecutable() {
  const exeSubpath = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  if (app.isPackaged) {
    const candidates = [
      path.join(process.resourcesPath, 'runtime', exeSubpath),
      path.join(process.resourcesPath, 'node', exeSubpath),
      path.resolve(process.resourcesPath, '../../runtime', exeSubpath),
    ];
    for (const candidate of candidates) {
      if (isExecutableSync(candidate)) return candidate;
    }
    return candidates[0];
  }
  if (process.env.OAA_DESKTOP_NODE) return process.env.OAA_DESKTOP_NODE;
  const home = os.homedir();
  const localCandidates =
    process.platform === 'win32'
      ? []
      : [
          path.join(home, '.local/bin/node'),
          '/opt/homebrew/bin/node',
          '/usr/local/bin/node',
          path.join(home, '.nvm/current/bin/node'),
          path.join(home, '.volta/bin/node'),
        ];
  for (const candidate of localCandidates) {
    if (isExecutableSync(candidate)) return candidate;
  }
  return process.env.OAA_DESKTOP_NODE;
}

const root = resolveGatewayRoot();
const node = resolveNodeExecutable();
const data = launchOptions.dataDir;

if (!launchOptions.problem && data) {
  const desktopUserData = path.join(data, 'desktop');
  fsSync.mkdirSync(desktopUserData, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fsSync.chmodSync(desktopUserData, 0o700);
    } catch {}
  }
  app.setPath('userData', desktopUserData);
}

const icon = app.isPackaged
  ? fsSync.existsSync(path.join(process.resourcesPath, 'icon.png'))
    ? path.join(process.resourcesPath, 'icon.png')
    : path.resolve(process.resourcesPath, '../../OpenAgentAPI.png')
  : path.join(root, 'docs/brand/oaa-app-icon-1024.png');

const statusTemplateCandidate = app.isPackaged
  ? path.join(process.resourcesPath, 'StatusTemplate.png')
  : path.join(root, 'release/macos/Open Agent API.app/Contents/Resources/StatusTemplate.png');
const hasStatusTemplate =
  process.platform === 'darwin' && fsSync.existsSync(statusTemplateCandidate);

let window = null;
let trayController = null;
let origin = '';
let token = '';
let injected = false;
let quitting = false;
let started = false;
let attachedPid = null;
let notificationsEnabled = true;
let dockBadgeEnabled = true;
let pendingFirstRunNotice = null;
let pollTimer = null;
let pollingBusy = false;
let lastOverviewEtag = null;
let cachedRunningCount = 0;
let cachedApprovals = [];
let seenApprovalRunIds = new Set();
let approvalsPrimed = false;

function gatewayEnvironment() {
  const env = { ...process.env };
  if (process.platform !== 'win32') {
    const home = os.homedir();
    const extra = [
      path.join(home, '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
    const existing = (env.PATH || '/usr/bin:/bin').split(':').filter(Boolean);
    env.PATH = [...new Set([...extra, ...existing])].join(':');
  }
  return env;
}

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, 'dist/src/cli.js'), ...args], {
      cwd: root,
      env: gatewayEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-16384);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Gateway startup timed out.'));
    }, 120000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else
        reject(
          new Error(
            output.replace(/sk-oaa-[A-Za-z0-9_-]+/g, '[redacted]') || 'Gateway command failed.',
          ),
        );
    });
  });
}

async function probeLocalHealth(targetOrigin) {
  try {
    const res = await fetch(`${targetOrigin}/health`, {
      signal: AbortSignal.timeout(1800),
      headers: { 'Cache-Control': 'no-cache' },
    });
    const bodyText = await res.text();
    return classifyPortProbe(res.status, bodyText);
  } catch {
    return classifyPortProbe(null, null);
  }
}

async function isTcpPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(600);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function readProcessCommandLine(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  try {
    return execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

async function readServerPidFile(dataDir) {
  try {
    const textValue = (await fs.readFile(path.join(dataDir, 'server.pid'), 'utf8')).trim();
    const parsed = Number(textValue);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function configPathVariants(configFile) {
  try {
    const real = await fs.realpath(configFile);
    return real === configFile ? [configFile] : [configFile, real];
  } catch {
    return [configFile];
  }
}

async function readLogTail(dataDir) {
  for (const name of ['server.log', 'oaa-desktop.log']) {
    try {
      const content = await fs.readFile(path.join(dataDir, name), 'utf8');
      if (content) return content.slice(-8192);
    } catch {}
  }
  return '';
}

async function verifyAdminIdentity(targetOrigin, tokenValue) {
  try {
    const response = await fetch(`${targetOrigin}/v1/me`, {
      headers: { Authorization: `Bearer ${tokenValue}` },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function bootstrap() {
  if (!node || !path.isAbsolute(node)) throw new Error('The bundled Node runtime is missing.');
  await fs.access(node);
  await fs.mkdir(data, { recursive: true, mode: 0o700 });

  const configFile = path.join(data, 'config.json');
  let config = null;
  try {
    config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new StartupProblemError({ kind: 'configUnavailable', dir: data });
    }
  }

  let initialPortOverride = launchOptions.port;
  if (!config) {
    if (launchOptions.isolated && initialPortOverride === null) {
      initialPortOverride = await freePort();
    }
    await cli(['init', '--dir', data]);
    try {
      config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    } catch {
      throw new StartupProblemError({ kind: 'configUnavailable', dir: data });
    }
  }

  const pSetting = portSetting(config);
  if (pSetting.kind === 'invalid' && initialPortOverride === null) {
    throw new StartupProblemError({
      kind: 'invalidConfigPort',
      value: pSetting.value,
      configPath: configFile,
    });
  }

  const sampleScriptCandidate = path.join(root, 'examples/sample-agent.mjs');
  const patch = prepareConfigForStart(config, {
    isExecutable: isExecutableSync,
    sampleScript: fsSync.existsSync(sampleScriptCandidate) ? sampleScriptCandidate : null,
    nodeCommand: node,
    portOverride: initialPortOverride,
  });
  if (patch.modified) {
    config = patch.json;
    await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  origin = localConfiguration(config);
  const port = Number(new URL(origin).port || 8787);
  const variants = await configPathVariants(configFile);
  const recordedServerPid = await readServerPidFile(data);

  const initialProbe = await probeLocalHealth(origin);
  const decision = judgePortOwnership({
    probe: initialProbe,
    ownChildPid: null,
    serverPidFromFile: recordedServerPid,
    commandLine: initialProbe.pid ? readProcessCommandLine(initialProbe.pid) : null,
    configPaths: variants,
    port,
    configPath: configFile,
  });

  if (decision.action === 'problem') {
    throw new StartupProblemError(decision.problem);
  }

  if (decision.action === 'attach') {
    const candidateToken = await privateToken(path.join(data, 'admin.token'));
    if (!(await verifyAdminIdentity(origin, candidateToken))) {
      throw new StartupProblemError({
        kind: 'portHeldByGateway',
        port,
        configPath: configFile,
      });
    }
    token = candidateToken;
    attachedPid = decision.pid;
    started = false;
  } else {
    if (await isTcpPortOpen(port)) {
      throw new StartupProblemError({
        kind: 'portHeldByOther',
        port,
        configPath: configFile,
      });
    }
    try {
      await cli(['quickstart', '--dir', data]);
      started = true;
      attachedPid = null;
    } catch (error) {
      const tail = `${error.message || ''}\n${await readLogTail(data)}`;
      if (logShowsAddressInUse(tail)) {
        throw new StartupProblemError({
          kind: 'portHeldByOther',
          port,
          configPath: configFile,
        });
      }
      throw new StartupProblemError({
        kind: 'gatewayNotStarted',
        port,
        logPath: path.join(data, 'server.log'),
      });
    }

    const postProbe = await probeLocalHealth(origin);
    if (postProbe.state !== 'gateway') {
      throw new StartupProblemError({
        kind: 'gatewayNotStarted',
        port,
        logPath: path.join(data, 'server.log'),
      });
    }
    token = await privateToken(path.join(data, 'admin.token'));
    if (!(await verifyAdminIdentity(origin, token))) {
      throw new StartupProblemError({
        kind: 'portHeldByGateway',
        port,
        configPath: configFile,
      });
    }
  }

  await runFirstLaunchSeedingIfNeeded(config);
}

async function runFirstLaunchSeedingIfNeeded(config) {
  const tokenFile = path.join(data, 'admin.token');
  const seeded = await ensureFirstRunMarker(data, async () => {
    const published = [];
    const sampleJson = path.join(root, 'examples/sample-agent.json');
    if (started && fsSync.existsSync(sampleJson)) {
      // `oaa quickstart` already published `agent/sample` idempotently.
      published.push(SAMPLE_AGENT_ID);
    } else if (fsSync.existsSync(sampleJson)) {
      try {
        await cli([
          'publish',
          sampleJson,
          '--if-absent',
          '--url',
          origin,
          '--token-file',
          tokenFile,
        ]);
        published.push(SAMPLE_AGENT_ID);
      } catch {}
    }
    const enginesNow = enabledEnginesInConfig(config, isExecutableSync);
    const agyExample = path.join(root, 'examples/agy-gemini-3.8-flash.oaa');
    if (enginesNow.includes('antigravity') && fsSync.existsSync(agyExample)) {
      try {
        await cli([
          'publish',
          agyExample,
          '--if-absent',
          '--url',
          origin,
          '--token-file',
          tokenFile,
        ]);
        published.push(ANTIGRAVITY_AGENT_ID);
      } catch {}
    }
    return { engines: enginesNow, published };
  });

  if (seeded.firstRun && seeded.result) {
    pendingFirstRunNotice = composeFirstRunNotice({
      engines: seeded.result.engines,
      published: seeded.result.published,
      lang: currentLang(),
    });
  }
}

function show() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

function openRunInConsole(runId) {
  show();
  if (
    !window ||
    window.isDestroyed() ||
    typeof runId !== 'string' ||
    !/^[\w.:-]{1,200}$/.test(runId)
  ) {
    return;
  }
  const encoded = JSON.stringify(runId);
  void window.webContents.mainFrame
    .executeJavaScript(
      `window.oaaShell && window.oaaShell.openRun && window.oaaShell.openRun(${encoded})`,
    )
    .catch(() => {});
}

function applyBadgeCount(rawCount) {
  const count = dockBadgeEnabled
    ? Math.max(0, Math.min(999, Math.floor(Number(rawCount) || 0)))
    : 0;
  if (process.platform === 'darwin') {
    app.dock?.setBadge(formatDockBadge(count));
    app.setBadgeCount(count);
  } else if (process.platform === 'win32' && window && !window.isDestroyed()) {
    window.setOverlayIcon(
      count ? nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }) : null,
      count ? `${count} pending approvals` : '',
    );
  } else {
    app.setBadgeCount(count);
  }
}

function emitApprovalNotification({ runId, title, body, test = false }) {
  if (!Notification.isSupported()) return;
  if (!test && !notificationsEnabled) return;
  if (!test && window && !window.isDestroyed() && window.isVisible() && window.isFocused()) {
    return;
  }
  const notification = new Notification({
    title: String(title || 'Open Agent API').slice(0, 200),
    body: String(body || '').slice(0, 1000),
    icon,
  });
  notification.on('click', () => {
    if (runId && runId !== 'test') openRunInConsole(runId);
    else show();
  });
  notification.show();
}

async function decideApprovalFromDesktop({ runId, actionId, decision }) {
  const req = buildApprovalDecisionRequest({
    origin,
    token,
    runId,
    actionId,
    decision,
    response: {},
  });
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || errBody?.message || `HTTP ${res.status}`);
  }
  lastOverviewEtag = null;
  await pollGatewayState();
}

async function pollGatewayState() {
  if (pollingBusy || quitting || !origin || !token) return;
  pollingBusy = true;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    if (lastOverviewEtag) headers['If-None-Match'] = lastOverviewEtag;
    const res = await fetch(`${origin}/v1/overview`, {
      headers,
      signal: AbortSignal.timeout(3500),
    });

    if (res.status === 304) {
      trayController?.updateState({
        online: true,
        attached: Boolean(attachedPid) && !started,
        address: new URL(origin).host,
        runningCount: cachedRunningCount,
        pendingCount: cachedApprovals.length,
        approvals: cachedApprovals,
        canStopGateway: started || Boolean(attachedPid),
      });
      return;
    }

    if (!res.ok) {
      trayController?.updateState({ online: false });
      return;
    }

    lastOverviewEtag = res.headers.get('ETag');
    const overview = await res.json();
    const runs = Array.isArray(overview?.runs) ? overview.runs : [];
    cachedRunningCount = countActiveRuns(overview);

    const ownerRuns = extractOwnerApprovalRuns(runs).slice(0, 10);
    const actionsByRunId = {};
    await Promise.all(
      ownerRuns.map(async (run) => {
        try {
          const actRes = await fetch(
            `${origin}/v1/runs/${encodeURIComponent(run.id)}/actions?limit=10`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(3000),
            },
          );
          if (actRes.ok) {
            const page = await actRes.json();
            actionsByRunId[run.id] = Array.isArray(page?.data) ? page.data : [];
          }
        } catch {}
      }),
    );

    cachedApprovals = collectPendingApprovals(runs, actionsByRunId);
    const pendingCount = Math.max(cachedApprovals.length, ownerRuns.length);
    applyBadgeCount(pendingCount);

    const diff = diffFreshOwnerApprovals(runs, seenApprovalRunIds, approvalsPrimed, currentLang());
    seenApprovalRunIds = diff.seenRunIds;
    approvalsPrimed = diff.primed;
    if (diff.shouldNotify && diff.notification) {
      emitApprovalNotification(diff.notification);
    }

    trayController?.updateState({
      online: true,
      attached: Boolean(attachedPid) && !started,
      address: new URL(origin).host,
      runningCount: cachedRunningCount,
      pendingCount,
      approvals: cachedApprovals,
      canStopGateway: started || Boolean(attachedPid),
    });
  } catch {
    trayController?.updateState({ online: false });
  } finally {
    pollingBusy = false;
  }
}

function startBackgroundPolling() {
  if (pollTimer) clearInterval(pollTimer);
  void pollGatewayState();
  pollTimer = setInterval(() => {
    void pollGatewayState();
  }, 3000);
}

async function restartManagedGateway() {
  if (!started && !attachedPid) {
    dialog.showErrorBox('Open Agent API', text('foreign'));
    return;
  }
  try {
    if (window && !window.isDestroyed()) {
      const splash = splashHTML({ status: text('splashRestarting'), lang: currentLang() });
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splash)}`);
    }
    await cli(['stop', '--dir', data]).catch(() => {});
    await cli(['quickstart', '--dir', data]);
    started = true;
    attachedPid = null;
    token = await privateToken(path.join(data, 'admin.token'));
    injected = false;
    lastOverviewEtag = null;
    if (window && !window.isDestroyed()) {
      await window.loadURL(origin);
    }
    await pollGatewayState();
    rebuildApplicationMenu();
  } catch (error) {
    dialog.showErrorBox('Open Agent API', error.message || String(error));
  }
}

async function stopGatewayAndQuit() {
  try {
    await cli(['stop', '--dir', data]);
    quitting = true;
    app.quit();
  } catch (error) {
    dialog.showErrorBox('Open Agent API', error.message || String(error));
  }
}

function rebuildApplicationMenu() {
  const loginState = resolveLoginItemState({ app, isolated: launchOptions.isolated });
  const appSubmenu = [
    {
      label: text('about'),
      click: () => {
        void dialog.showMessageBox({
          type: 'info',
          title: 'Open Agent API',
          message: `Open Agent API ${app.getVersion()}`,
          detail: text('aboutBody', { url: origin || 'http://127.0.0.1:8787', dir: data }),
          buttons: [text('buttonOK')],
        });
      },
    },
    { type: 'separator' },
    {
      label: text('settings'),
      accelerator: 'CmdOrCtrl+,',
      click: () => {
        show();
        if (window && !window.isDestroyed() && origin) {
          void window.webContents.mainFrame
            .executeJavaScript(
              "window.oaaShell ? window.oaaShell.openSettings() : (location.hash = 'settings')",
            )
            .catch(() => {});
        }
      },
    },
    {
      label:
        loginState.reason === 'isolated' ? text('launchAtLoginIsolated') : text('launchAtLogin'),
      type: 'checkbox',
      checked: Boolean(loginState.openAtLogin),
      enabled: Boolean(loginState.enabled),
      click: (item) => {
        updateLoginItemState({
          app,
          isolated: launchOptions.isolated,
          openAtLogin: Boolean(item.checked),
        });
        trayController?.updateState({});
        rebuildApplicationMenu();
      },
    },
    { type: 'separator' },
    {
      label: text('reloadConsole'),
      accelerator: 'CmdOrCtrl+R',
      click: () => {
        if (window && !window.isDestroyed() && origin) {
          injected = false;
          void window.loadURL(origin);
        }
      },
    },
    {
      label: text('restartGateway'),
      click: () => {
        void restartManagedGateway();
      },
    },
    ...(started || attachedPid
      ? [
          {
            label: text('stop'),
            click: () => {
              void stopGatewayAndQuit();
            },
          },
        ]
      : []),
    { type: 'separator' },
    ...(process.platform === 'darwin'
      ? [
          { role: 'hide', label: text('hide') },
          { role: 'hideOthers', label: text('hideOthers') },
          { role: 'unhide', label: text('showAll') },
          { type: 'separator' },
        ]
      : []),
    {
      label: text('quit'),
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];

  const viewSubmenu = [
    {
      label: text('commandPalette'),
      accelerator: 'CmdOrCtrl+K',
      click: () => {
        show();
        if (window && !window.isDestroyed()) {
          void window.webContents.mainFrame
            .executeJavaScript('window.oaaShell && window.oaaShell.openCommand()')
            .catch(() => {});
        }
      },
    },
    {
      label: text('toggleSidebar'),
      accelerator: 'CmdOrCtrl+\\',
      click: () => {
        show();
        if (window && !window.isDestroyed()) {
          void window.webContents.mainFrame
            .executeJavaScript('window.oaaShell && window.oaaShell.toggleSidebar()')
            .catch(() => {});
        }
      },
    },
    { type: 'separator' },
    { role: 'togglefullscreen', label: text('fullScreen') },
  ];

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Open Agent API', submenu: appSubmenu },
      { role: 'editMenu', label: text('editMenu') },
      { label: text('viewMenu'), submenu: viewSubmenu },
      { role: 'windowMenu', label: text('windowMenu') },
    ]),
  );
}

async function createWindow() {
  const windowTitle = launchOptions.isolated
    ? text('windowTitleIsolated', { title: 'Open Agent API' })
    : 'Open Agent API';
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 700,
    show: false,
    title: windowTitle,
    icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ece9e1',
    ...macosWindowChromeOptions(process.platform),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (externalURL(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('data:text/html')) return;
    try {
      if (new URL(url).origin !== origin) {
        event.preventDefault();
        if (externalURL(url)) void shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && origin && url.startsWith(origin)) {
      injected = false;
    }
  });
  if (process.platform === 'darwin') {
    window.webContents.on('did-finish-load', () => {
      void window.webContents
        .insertCSS(
          '[data-drag-region] { -webkit-app-region: drag; }\n' +
            '[data-drag-region] :is(button, a, input, select, textarea, summary, label, [role="button"], kbd) { -webkit-app-region: no-drag; }',
        )
        .catch(() => {});
    });
  }
  window.on('close', (event) => {
    if (!quitting && trayController?.hasTray()) {
      event.preventDefault();
      window.hide();
    }
  });
  window.once('ready-to-show', show);
  await window.loadURL(origin);
}

ipcMain.handle('oaa:bootstrap', (event) => {
  if (!window || !trustedFrame(event, window, origin) || injected) return null;
  injected = true;
  return token;
});

ipcMain.handle('oaa:first-run-notice', (event) => {
  if (!window || !trustedFrame(event, window, origin)) return null;
  const notice = pendingFirstRunNotice;
  pendingFirstRunNotice = null;
  return notice;
});

ipcMain.on('oaa:desktop', (event, message) => {
  if (!window || !trustedFrame(event, window, origin) || !message || typeof message !== 'object')
    return;
  if (message.type === 'zoom') {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  } else if (message.type === 'appearance' && ['system', 'light', 'dark'].includes(message.theme)) {
    nativeTheme.themeSource = message.theme;
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#191919' : '#ece9e1');
  } else if (message.type === 'notifications') {
    notificationsEnabled = message.enabled === true;
    if (notificationsEnabled) {
      const status = Notification.isSupported() ? 'granted' : 'unavailable';
      void window.webContents.mainFrame
        .executeJavaScript(
          `window.oaaShell && window.oaaShell.notificationStatus && window.oaaShell.notificationStatus(${JSON.stringify(status)})`,
        )
        .catch(() => {});
    }
  } else if (
    message.type === 'badge' &&
    Number.isSafeInteger(message.count) &&
    message.count >= 0
  ) {
    if (message.count === 0 && cachedApprovals.length > 0) {
      dockBadgeEnabled = false;
    } else if (message.count > 0) {
      dockBadgeEnabled = true;
    }
    applyBadgeCount(message.count);
    trayController?.updateState({ pendingCount: message.count });
  } else if (
    message.type === 'notify' &&
    (notificationsEnabled || message.test === true) &&
    typeof message.title === 'string' &&
    typeof message.body === 'string'
  ) {
    const runId = typeof message.id === 'string' ? message.id.slice(0, 200) : '';
    if (runId && runId !== 'test') seenApprovalRunIds.add(runId);
    emitApprovalNotification({
      runId,
      title: message.title,
      body: message.body,
      test: message.test === true,
    });
  } else if (message.type === 'action') {
    if (message.name === 'openDataFolder') void shell.openPath(data);
    else if (message.name === 'openInBrowser' && safeBrowserURL(origin, true))
      void shell.openExternal(origin);
    else if (message.name === 'copyCompatUrl' && origin) clipboard.writeText(`${origin}/v1/compat`);
    else if (message.name === 'copyAdminToken' && token) clipboard.writeText(token);
    else if (message.name === 'restartKernel') void restartManagedGateway();
  }
});

function presentStartupError(title, body, problem = null) {
  const reportFile = process.env.OAA_DESKTOP_ERROR_REPORT;
  if (reportFile) {
    try {
      fsSync.mkdirSync(path.dirname(reportFile), { recursive: true });
      fsSync.writeFileSync(
        reportFile,
        JSON.stringify({ kind: problem?.kind || null, title, body }, null, 2),
        'utf8',
      );
      return;
    } catch {}
  }
  dialog.showErrorBox(title, body);
}

if (launchOptions.problem) {
  app.whenReady().then(() => {
    const msg = launchProblemText(launchOptions.problem, currentLang());
    presentStartupError(msg.title, msg.body, launchOptions.problem);
    quitting = true;
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', show);
  app.on('activate', () => {
    if (window && !window.isDestroyed()) show();
  });
  app.on('before-quit', () => {
    quitting = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    trayController?.destroy();
  });
  app.on('window-all-closed', () => {
    if (!trayController?.hasTray()) app.quit();
  });

  app
    .whenReady()
    .then(async () => {
      if (launchOptions.enableNotifications) {
        notificationsEnabled = true;
      }
      await bootstrap();

      const sharedCallbacks = {
        onOpenConsole: show,
        onOpenInBrowser: () => {
          if (safeBrowserURL(origin, true)) void shell.openExternal(origin);
        },
        onOpenSettings: () => {
          show();
          if (window && !window.isDestroyed() && origin) {
            void window.loadURL(`${origin}/#settings`);
          }
        },
        onInspectRun: (runId) => openRunInConsole(runId),
        onCopyAdminKey: () => {
          if (token) clipboard.writeText(token);
        },
        onCopyBaseUrl: () => {
          if (origin) clipboard.writeText(`${origin}/v1`);
        },
        onOpenDataFolder: () => {
          void shell.openPath(data);
        },
        onRestartGateway: () => {
          void restartManagedGateway();
        },
        onStopAndQuit: () => {
          void stopGatewayAndQuit();
        },
        onQuit: () => {
          quitting = true;
          app.quit();
        },
      };

      trayController = createTrayController({
        app,
        BrowserWindow,
        Menu,
        Tray,
        nativeImage,
        ipcMain,
        screen,
        trayIconPath: hasStatusTemplate ? statusTemplateCandidate : icon,
        isTemplateIcon: hasStatusTemplate,
        getLang: currentLang,
        isIsolated: () => launchOptions.isolated,
        onDecideApproval: decideApprovalFromDesktop,
        onRefreshRequested: pollGatewayState,
        callbacks: sharedCallbacks,
      });
      trayController.init();
      if (!app.isPackaged && process.env.OAA_DESKTOP_TEST_BRIDGE === '1') {
        globalThis.__oaaTestBridge = {
          toggleTrayPanel: () => trayController?.togglePanel(),
          getTrayState: () => trayController?.getState(),
          pollNow: () => pollGatewayState(),
          attachedPid: () => attachedPid,
          started: () => started,
        };
      }
      rebuildApplicationMenu();
      await createWindow();
      if (launchOptions.enableNotifications) {
        emitApprovalNotification({
          runId: 'test',
          title: 'Open Agent API',
          body: text('notificationTestBody'),
          test: true,
        });
      }
      startBackgroundPolling();
    })
    .catch(async (error) => {
      const problem = error instanceof StartupProblemError ? error.problem : null;
      const localized = problem
        ? startupProblemText(problem, currentLang())
        : {
            title: 'Open Agent API',
            body: String(error?.message || error).slice(0, 3000),
          };
      presentStartupError(localized.title, localized.body, problem);
      quitting = true;
      app.quit();
    });
}
