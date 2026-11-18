'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const strings = require('./strings.cjs');

const GATEWAY_DEFAULT_PORT = 8787;
const FIRST_RUN_MARKER = '.seeded';
const SAMPLE_AGENT_ID = 'agent/sample';
const ANTIGRAVITY_AGENT_ID = 'agent/antigravity';

function macosWindowChromeOptions(platform = process.platform) {
  if (platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 18 },
  };
}

function argumentDataDirectory(argv) {
  const index = argv.indexOf('--oaa-data-dir');
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || !path.isAbsolute(value) || value.includes('\0'))
    throw Error('--oaa-data-dir requires an absolute local path.');
  return value;
}

function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32')
    return paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'OpenAgentAPI');
  if (platform === 'darwin')
    return paths.join(home, 'Library', 'Application Support', 'OpenAgentAPI');
  return paths.join(
    env.XDG_DATA_HOME && paths.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : paths.join(home, '.local', 'share'),
    'OpenAgentAPI',
  );
}

function validPort(text) {
  const raw = String(text ?? '');
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) return null;
  return value;
}

function expandTilde(input, home, paths) {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return paths.join(home, input.slice(2));
  }
  return input;
}

function standardizePath(input, platform, paths) {
  const normalized = paths.normalize(input);
  if (platform === 'win32') {
    const root = paths.parse(normalized).root;
    return normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function parseLaunchOptions({
  env = process.env,
  argv = process.argv,
  platform = process.platform,
  home = os.homedir(),
  isPackaged = false,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let rawHome = env.OAA_DESKTOP_HOME;
  if ((rawHome === undefined || rawHome.trim() === '') && !isPackaged && env.OAA_DESKTOP_DATA_DIR) {
    rawHome = env.OAA_DESKTOP_DATA_DIR;
  }
  let rawPort = env.OAA_DESKTOP_PORT;
  let enableNotifications = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = String(argv[i] ?? '');
    if (arg === '--enable-notifications') {
      enableNotifications = true;
    } else if ((arg === '--home' || arg === '--oaa-data-dir') && i + 1 < argv.length) {
      rawHome = String(argv[++i] ?? '');
    } else if (arg.startsWith('--home=')) {
      rawHome = arg.slice('--home='.length);
    } else if (arg.startsWith('--oaa-data-dir=')) {
      rawHome = arg.slice('--oaa-data-dir='.length);
    } else if (arg === '--port' && i + 1 < argv.length) {
      rawPort = String(argv[++i] ?? '');
    } else if (arg.startsWith('--port=')) {
      rawPort = arg.slice('--port='.length);
    }
  }

  const trimmedHome = typeof rawHome === 'string' ? rawHome.trim() : '';
  const trimmedPort = typeof rawPort === 'string' ? rawPort.trim() : '';

  let isolatedHome = null;
  if (trimmedHome.length > 0) {
    if (trimmedHome.includes('\0')) {
      return {
        dataDir: null,
        isolated: false,
        port: null,
        enableNotifications,
        problem: { kind: 'homeNotAbsolute', value: trimmedHome },
      };
    }
    const expanded = expandTilde(trimmedHome, home, paths);
    if (!paths.isAbsolute(expanded)) {
      return {
        dataDir: null,
        isolated: false,
        port: null,
        enableNotifications,
        problem: { kind: 'homeNotAbsolute', value: trimmedHome },
      };
    }
    isolatedHome = standardizePath(expanded, platform, paths);
  }

  let parsedPort = null;
  if (trimmedPort.length > 0) {
    const portValue = validPort(trimmedPort);
    if (portValue === null) {
      return {
        dataDir: null,
        isolated: isolatedHome !== null,
        port: null,
        enableNotifications,
        problem: { kind: 'invalidPort', value: trimmedPort },
      };
    }
    if (isolatedHome === null) {
      return {
        dataDir: null,
        isolated: false,
        port: null,
        enableNotifications,
        problem: { kind: 'portNeedsHome' },
      };
    }
    parsedPort = portValue;
  }

  return {
    dataDir: isolatedHome ?? dataDirectory(platform, env, home),
    isolated: isolatedHome !== null,
    port: parsedPort,
    enableNotifications,
    problem: null,
  };
}

function trustedFrame(event, window, origin) {
  try {
    return (
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      new URL(event.senderFrame.url).origin === origin
    );
  } catch {
    return false;
  }
}

function externalURL(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      [
        'github.com',
        'openagentapi.pages.dev',
        'www.electronjs.org',
        'platform.openai.com',
        'developers.openai.com',
        'code.claude.com',
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function safeBrowserURL(value, allowLoopbackHttp = false) {
  if (externalURL(value)) return true;
  if (!allowLoopbackHttp) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

async function privateToken(file) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 8192 ||
      (process.platform !== 'win32' && stat.mode & 0o077)
    )
      throw Error('Administrator key file is not private.');
    const value = (await handle.readFile('utf8')).trim();
    if (!/^[\x21-\x7e]{24,4096}$/.test(value)) throw Error('Invalid administrator key file.');
    return value;
  } finally {
    await handle.close();
  }
}

function portSetting(config) {
  if (
    !config ||
    typeof config !== 'object' ||
    !Object.prototype.hasOwnProperty.call(config, 'port')
  ) {
    return { kind: 'unset' };
  }
  const raw = config.port;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 65535) {
    return { kind: 'valid', port: raw };
  }
  const desc = typeof raw === 'string' ? JSON.stringify(raw) : String(raw);
  return { kind: 'invalid', value: desc };
}

function localConfiguration(config) {
  if (
    !config ||
    typeof config !== 'object' ||
    config.tls ||
    (config.security?.profile ?? 'local') !== 'local' ||
    !['127.0.0.1', 'localhost', '::1'].includes(config.host ?? '127.0.0.1')
  )
    throw Error('The desktop shell requires a private loopback gateway configuration.');
  const port = config.port ?? GATEWAY_DEFAULT_PORT;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('The gateway port is invalid.');
  return `http://${config.host === '::1' ? '[::1]' : '127.0.0.1'}:${port}`;
}

function prepareConfigForStart(
  input,
  {
    isExecutable = () => false,
    sampleScript = null,
    nodeCommand = 'node',
    portOverride = null,
  } = {},
) {
  const json = structuredClone(input && typeof input === 'object' ? input : {});
  let modified = false;
  const enabledEngines = [];

  if (Object.prototype.hasOwnProperty.call(json, 'localAgents')) {
    delete json.localAgents;
    modified = true;
  }

  if (json.localWorker && typeof json.localWorker === 'object') {
    const worker = json.localWorker;
    if (worker.native && typeof worker.native === 'object') {
      for (const key of Object.keys(worker.native).sort()) {
        const entry = worker.native[key];
        if (
          entry &&
          typeof entry === 'object' &&
          typeof entry.executable === 'string' &&
          isExecutable(entry.executable) &&
          entry.enabled !== true
        ) {
          entry.enabled = true;
          enabledEngines.push(key);
          modified = true;
        }
      }
    }
    if (sampleScript) {
      const adapters =
        worker.adapters && typeof worker.adapters === 'object' ? worker.adapters : {};
      const existing = adapters['oaa-sample'];
      const matches =
        existing &&
        typeof existing === 'object' &&
        existing.transport === 'acp' &&
        existing.command === nodeCommand &&
        existing.enabled === true &&
        Array.isArray(existing.args) &&
        existing.args.length === 1 &&
        existing.args[0] === sampleScript;
      if (!matches) {
        adapters['oaa-sample'] = {
          transport: 'acp',
          command: nodeCommand,
          args: [sampleScript],
          enabled: true,
        };
        worker.adapters = adapters;
        modified = true;
      }
    }
  }

  if (portOverride !== null && portOverride !== undefined) {
    const current = portSetting(json);
    if (current.kind !== 'valid' || current.port !== portOverride) {
      json.port = portOverride;
      modified = true;
    }
  }

  return { json, modified, enabledEngines };
}

function classifyPortProbe(statusCode, bodyText) {
  if (statusCode === null || statusCode === undefined) {
    return { state: 'silent', pid: null };
  }
  if (statusCode !== 200 || typeof bodyText !== 'string' || !bodyText) {
    return { state: 'other', pid: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { state: 'other', pid: null };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.protocol !== 'oaa/1') {
    return { state: 'other', pid: null };
  }
  const pid =
    typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null;
  return { state: 'gateway', pid };
}

function commandServesConfig(commandLine, configPath) {
  if (typeof commandLine !== 'string' || !configPath) return false;
  const cmd = commandLine.trim();
  if (!cmd) return false;
  for (const marker of [`serve --config "${configPath}"`, `serve --config ${configPath}`]) {
    let from = 0;
    while (from <= cmd.length) {
      const idx = cmd.indexOf(marker, from);
      if (idx < 0) break;
      const beforeOk = idx === 0 || /\s/.test(cmd[idx - 1]);
      const afterIdx = idx + marker.length;
      const afterOk = afterIdx === cmd.length || /\s/.test(cmd[afterIdx]);
      if (beforeOk && afterOk) return true;
      from = idx + 1;
    }
  }
  return false;
}

function isOwnGateway({
  pid,
  ownChildPid = null,
  serverPidFromFile = null,
  commandLine = null,
  configPaths = [],
} = {}) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  if (ownChildPid !== null && pid === ownChildPid) return true;
  if (typeof commandLine === 'string') {
    return configPaths.some((cfg) => commandServesConfig(commandLine, cfg));
  }
  if (commandLine === null && serverPidFromFile !== null && pid === serverPidFromFile) {
    return true;
  }
  return false;
}

function judgePortOwnership({
  probe,
  ownChildPid = null,
  serverPidFromFile = null,
  commandLine = null,
  configPaths = [],
  port,
  configPath,
}) {
  if (!probe || probe.state === 'silent') {
    return { action: 'wait' };
  }
  if (probe.state === 'other') {
    return {
      action: 'problem',
      problem: { kind: 'portHeldByOther', port, configPath },
    };
  }
  if (
    probe.state === 'gateway' &&
    isOwnGateway({
      pid: probe.pid,
      ownChildPid,
      serverPidFromFile,
      commandLine,
      configPaths,
    })
  ) {
    return { action: 'attach', pid: probe.pid };
  }
  return {
    action: 'problem',
    problem: { kind: 'portHeldByGateway', port, configPath },
  };
}

function logShowsAddressInUse(logTail) {
  return String(logTail ?? '').includes('EADDRINUSE');
}

function startupProblemText(problem, lang = 'en') {
  const t = (key, params) => strings.formatText(lang, key, params);
  switch (problem?.kind) {
    case 'portHeldByOther':
      return {
        title: t('problemPortOtherTitle', { port: problem.port }),
        body: t('problemPortOtherBody', { port: problem.port, config: problem.configPath }),
      };
    case 'portHeldByGateway':
      return {
        title: t('problemPortGatewayTitle', { port: problem.port }),
        body: t('problemPortGatewayBody', { port: problem.port, config: problem.configPath }),
      };
    case 'invalidConfigPort':
      return {
        title: t('problemConfigPortTitle'),
        body: t('problemConfigPortBody', { value: problem.value, config: problem.configPath }),
      };
    case 'configUnavailable':
      return {
        title: t('problemConfigTitle'),
        body: t('problemConfigBody', { dir: problem.dir }),
      };
    case 'gatewayNotStarted':
    default:
      return {
        title: t('problemNotStartedTitle'),
        body: t('splashFailed', {
          port: problem?.port ?? GATEWAY_DEFAULT_PORT,
          log: problem?.logPath ?? '',
        }),
      };
  }
}

function launchProblemText(problem, lang = 'en') {
  const t = (key, params) => strings.formatText(lang, key, params);
  switch (problem?.kind) {
    case 'homeNotAbsolute':
      return {
        title: t('problemHomeTitle'),
        body: t('problemHomeBody', { value: problem.value }),
      };
    case 'invalidPort':
      return {
        title: t('problemEnvPortTitle'),
        body: t('problemEnvPortBody', { value: problem.value }),
      };
    case 'portNeedsHome':
    default:
      return {
        title: t('problemNeedsHomeTitle'),
        body: t('problemNeedsHomeBody'),
      };
  }
}

function formatDockBadge(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return '';
  const n = Math.floor(count);
  return n > 99 ? '99+' : String(n);
}

function engineDisplayName(key) {
  switch (key) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude Code';
    case 'antigravity':
      return 'Antigravity (agy)';
    case 'dsh':
      return 'DeepSeek Harness';
    default:
      return key;
  }
}

function enabledEnginesInConfig(configJson, isExecutable = () => false) {
  const native = configJson?.localWorker?.native;
  if (!native || typeof native !== 'object') return [];
  const known = ['codex', 'claude', 'antigravity', 'dsh'];
  const keys = Object.keys(native).sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    const ra = ia < 0 ? known.length : ia;
    const rb = ib < 0 ? known.length : ib;
    return ra === rb ? a.localeCompare(b) : ra - rb;
  });
  return keys.filter((key) => {
    const entry = native[key];
    return (
      entry &&
      typeof entry === 'object' &&
      entry.enabled === true &&
      typeof entry.executable === 'string' &&
      isExecutable(entry.executable)
    );
  });
}

function composeFirstRunNotice({ engines = [], published = [], lang = 'en' } = {}) {
  if (engines.length === 0 && published.length === 0) return null;
  const t = (key, params) => strings.formatText(lang, key, params);
  const lines = [];
  if (published.includes(SAMPLE_AGENT_ID)) {
    lines.push(t('firstRunSample', { agent: SAMPLE_AGENT_ID }));
  }
  if (published.includes(ANTIGRAVITY_AGENT_ID)) {
    lines.push(t('firstRunAntigravity', { agent: ANTIGRAVITY_AGENT_ID }));
  }
  if (engines.length === 0) {
    lines.push(t('firstRunNoEngines'));
  } else {
    const names = engines.map(engineDisplayName).join(t('listSeparator'));
    lines.push(t('firstRunEngines', { engines: names }));
  }
  return {
    title: t('firstRunTitle'),
    body: `${lines.join('\n')}\n\n${t('firstRunFooter')}`,
    actionLabel: t('firstRunOpenMachines'),
    dismissLabel: t('buttonOK'),
  };
}

async function ensureFirstRunMarker(dataDir, seedWork) {
  const markerPath = path.join(dataDir, FIRST_RUN_MARKER);
  const legacyMarker = path.join(dataDir, '.seeded-v2');
  try {
    await fs.access(markerPath);
    return { firstRun: false, markerPath, result: null };
  } catch {}
  try {
    await fs.access(legacyMarker);
    await fs.writeFile(markerPath, 'ok\n', { mode: 0o600 });
    return { firstRun: false, markerPath, result: null };
  } catch {}

  const result = typeof seedWork === 'function' ? await seedWork() : null;
  await fs.writeFile(markerPath, 'ok\n', { mode: 0o600 });
  return { firstRun: true, markerPath, result };
}

function htmlEscape(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function splashHTML({ status = '', problem = null, lang = 'en' } = {}) {
  const htmlLang = lang === 'zh' ? 'zh-CN' : 'en';
  const tagline = htmlEscape(strings.formatText(lang, 'splashTagline'));
  const detail = problem
    ? `<div class="problem"><h2>${htmlEscape(problem.title)}</h2><pre>${htmlEscape(problem.body)}</pre></div>`
    : `<p>${htmlEscape(status)}</p>`;
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8" />
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #191919;
      color: #efefef;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      cursor: default;
    }
    .drag { position: fixed; inset: 0 0 auto 0; height: 52px; -webkit-app-region: drag; }
    .mark { width: 92px; height: 89px; margin-bottom: 22px; }
    .mark g { fill: none; stroke: currentColor; stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; }
    h1 { margin: 0; font: italic 400 34px/1.1 "Instrument Serif", "Iowan Old Style", Georgia, serif; letter-spacing: -0.01em; }
    .sub { margin: 10px 0 28px 0; color: #b0b0b0; font-size: 13px; letter-spacing: 0.24em; }
    p { display: flex; align-items: center; gap: 8px; margin: 0; color: #bcbcbc; font: 12px ui-monospace, "SF Mono", Menlo, monospace; }
    p::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #81d8d0; animation: tide 1.4s ease-in-out infinite; }
    @keyframes tide { 50% { opacity: 0.3; } }
    .problem { max-width: 560px; padding: 0 28px; text-align: center; }
    .problem h2 { margin: 0 0 12px 0; font-size: 15px; font-weight: 600; }
    .problem pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: #bcbcbc; font: 12px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; user-select: text; cursor: text; }
    @media (prefers-color-scheme: light) {
      body { background: #ece9e1; color: #132220; }
      .sub { color: #66726e; }
      p, .problem pre { color: #5b6864; }
    }
  </style>
</head>
<body>
  <div class="drag"></div>
  <svg class="mark" viewBox="40.11 43 175.78 170" aria-hidden="true"><g><path d="M209.89 207L150.11 49L108.57 155"/><path d="M94.7 190.38L88.19 207"/><path d="M143.36 106.65A50 50 0 1 1 119.1 78.6"/></g></svg>
  <h1>Open Agent API</h1>
  <div class="sub">${tagline}</div>
  ${detail}
</body>
</html>`;
}

module.exports = {
  GATEWAY_DEFAULT_PORT,
  FIRST_RUN_MARKER,
  SAMPLE_AGENT_ID,
  ANTIGRAVITY_AGENT_ID,
  macosWindowChromeOptions,
  dataDirectory,
  argumentDataDirectory,
  validPort,
  parseLaunchOptions,
  trustedFrame,
  externalURL,
  safeBrowserURL,
  privateToken,
  portSetting,
  localConfiguration,
  prepareConfigForStart,
  classifyPortProbe,
  commandServesConfig,
  isOwnGateway,
  judgePortOwnership,
  logShowsAddressInUse,
  startupProblemText,
  launchProblemText,
  formatDockBadge,
  engineDisplayName,
  enabledEnginesInConfig,
  composeFirstRunNotice,
  ensureFirstRunMarker,
  htmlEscape,
  splashHTML,
};
