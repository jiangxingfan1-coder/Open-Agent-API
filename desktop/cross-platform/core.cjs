const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
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
function localConfiguration(config) {
  if (
    config.tls ||
    (config.security?.profile ?? 'local') !== 'local' ||
    !['127.0.0.1', 'localhost', '::1'].includes(config.host ?? '127.0.0.1')
  )
    throw Error('The desktop shell requires a private loopback gateway configuration.');
  const port = config.port ?? 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('The gateway port is invalid.');
  return `http://${config.host === '::1' ? '[::1]' : '127.0.0.1'}:${port}`;
}
module.exports = {
  dataDirectory,
  argumentDataDirectory,
  trustedFrame,
  externalURL,
  privateToken,
  localConfiguration,
};
