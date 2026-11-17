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
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const strings = require('./strings.cjs');
const text = (key) => strings[app.getLocale().startsWith('zh') ? 'zh' : 'en'][key];
const {
  dataDirectory,
  trustedFrame,
  externalURL,
  privateToken,
  localConfiguration,
  argumentDataDirectory,
} = require('./core.cjs');

app.setName('Open Agent API');
const root = app.isPackaged
  ? path.join(process.resourcesPath, 'gateway')
  : path.resolve(__dirname, '../..');
const node = app.isPackaged
  ? path.join(
      process.resourcesPath,
      'runtime',
      process.platform === 'win32' ? 'node.exe' : 'bin/node',
    )
  : process.env.OAA_DESKTOP_NODE;
const data =
  argumentDataDirectory(process.argv) ??
  (!app.isPackaged && process.env.OAA_DESKTOP_DATA_DIR
    ? path.resolve(process.env.OAA_DESKTOP_DATA_DIR)
    : dataDirectory());
require('node:fs').mkdirSync(path.join(data, 'desktop'), { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') require('node:fs').chmodSync(path.join(data, 'desktop'), 0o700);
app.setPath('userData', path.join(data, 'desktop'));
const icon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(root, 'docs/brand/oaa-app-icon-1024.png');
let window,
  tray,
  origin = '',
  token = '',
  injected = false,
  quitting = false,
  started = false;
let notificationsEnabled = false;

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, 'dist/src/cli.js'), ...args], {
      cwd: root,
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
      reject(Error('Gateway startup timed out.'));
    }, 120000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          Error(
            output.replace(/sk-oaa-[A-Za-z0-9_-]+/g, '[redacted]') || 'Gateway command failed.',
          ),
        );
    });
  });
}
async function health() {
  try {
    return (
      (await (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1500) })).json())
        .protocol === 'oaa/1'
    );
  } catch {
    return false;
  }
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
async function bootstrap() {
  if (!node || !path.isAbsolute(node)) throw Error('The bundled Node runtime is missing.');
  await fs.access(node);
  await fs.mkdir(data, { recursive: true });
  const configFile = path.join(data, 'config.json');
  let config;
  try {
    config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!config) {
    await cli(['quickstart', '--dir', data, '--port', String(await freePort())]);
    started = true;
    config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  }
  origin = localConfiguration(config);
  if (!(await health())) {
    await cli(['quickstart', '--dir', data]);
    started = true;
  }
  if (!(await health())) throw Error('The local gateway did not start.');
  token = await privateToken(path.join(data, 'admin.token'));
  const response = await fetch(`${origin}/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error('The running gateway does not match this private data directory.');
}
function show() {
  if (window) {
    window.show();
    window.focus();
  }
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 700,
    show: false,
    title: 'Open Agent API',
    icon,
    backgroundColor: '#ffffff',
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
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      if (externalURL(url)) void shell.openExternal(url);
    }
  });
  window.on('close', (event) => {
    if (!quitting && tray) {
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
ipcMain.on('oaa:desktop', (event, message) => {
  if (!window || !trustedFrame(event, window, origin) || !message || typeof message !== 'object')
    return;
  if (message.type === 'zoom') {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  } else if (message.type === 'appearance' && ['system', 'light', 'dark'].includes(message.theme))
    nativeTheme.themeSource = message.theme;
  else if (message.type === 'notifications') notificationsEnabled = message.enabled === true;
  else if (message.type === 'badge' && Number.isSafeInteger(message.count) && message.count >= 0) {
    const count = Math.min(999, message.count);
    if (process.platform === 'win32')
      window.setOverlayIcon(
        count ? nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }) : null,
        `${count} pending actions`,
      );
    else app.setBadgeCount(count);
    tray?.setToolTip(count ? `Open Agent API (${count})` : 'Open Agent API');
  } else if (
    message.type === 'notify' &&
    (notificationsEnabled || message.test === true) &&
    typeof message.title === 'string' &&
    typeof message.body === 'string' &&
    Notification.isSupported()
  ) {
    const notification = new Notification({
      title: message.title.slice(0, 200),
      body: message.body.slice(0, 1000),
      icon,
    });
    notification.on('click', show);
    notification.show();
  } else if (message.type === 'action') {
    if (message.name === 'openDataFolder') void shell.openPath(data);
    else if (message.name === 'openInBrowser') void shell.openExternal(origin);
    else if (message.name === 'copyAdminToken') clipboard.writeText(token);
    else if (message.name === 'restartKernel') {
      if (!started) {
        dialog.showErrorBox('Open Agent API', text('foreign'));
        return;
      }
      void cli(['stop', '--dir', data])
        .then(() => cli(['quickstart', '--dir', data]))
        .then(() => window.reload())
        .catch((error) => dialog.showErrorBox('Open Agent API', error.message));
    }
  }
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
  app
    .whenReady()
    .then(async () => {
      await bootstrap();
      const menu = [
        { label: 'Open Agent API', click: show },
        {
          label: text('settings'),
          click: () => {
            show();
            void window.loadURL(`${origin}/#settings`);
          },
        },
        { type: 'separator' },
        ...(started
          ? [
              {
                label: text('stop'),
                click: async () => {
                  try {
                    await cli(['stop', '--dir', data]);
                    quitting = true;
                    app.quit();
                  } catch (error) {
                    dialog.showErrorBox('Open Agent API', error.message);
                  }
                },
              },
            ]
          : []),
        {
          label: text('quit'),
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ];
      try {
        tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 20, height: 20 }));
        tray.setToolTip('Open Agent API');
        tray.setContextMenu(Menu.buildFromTemplate(menu));
        tray.on('click', show);
      } catch {
        tray = null;
      }
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { label: 'Open Agent API', submenu: menu },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      );
      await createWindow();
    })
    .catch((error) => {
      dialog.showErrorBox('Open Agent API', String(error.message).slice(0, 3000));
      quitting = true;
      app.quit();
    });
}
