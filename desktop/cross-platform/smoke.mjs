import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { _electron } from 'playwright';
import lifecycle from './smoke-lifecycle.cjs';

const { withTimeout, waitForProcessExit } = lifecycle;

const require = createRequire(import.meta.url),
  here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, '../..');
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
if (values.executable && !path.isAbsolute(values.executable))
  throw Error('The packaged desktop executable must be an absolute path.');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'oaa-desktop-smoke-'));
const env = { ...process.env, OAA_DESKTOP_NODE: process.execPath, OAA_DESKTOP_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let application, closing, failure, port, desktopPid;
try {
  application = await _electron.launch({
    executablePath: values.executable ?? require('electron'),
    args: values.executable ? ['--oaa-data-dir', data] : [here],
    env,
    timeout: 30000,
  });
  const window = await application.firstWindow({ timeout: 20000 });
  desktopPid = await application.evaluate(() => process.pid);
  window.setDefaultTimeout(10000);
  await window.waitForFunction(() => !!sessionStorage.getItem('oaa-token'));
  assert.equal(await window.evaluate(() => typeof require), 'undefined');
  assert.equal(
    await window.evaluate(() => localStorage.getItem('oaa-token')),
    null,
    'Admin token must never persist in localStorage.',
  );
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      const pref = win.webContents.getLastWebPreferences();
      if (!pref.sandbox || !pref.contextIsolation || pref.nodeIntegration) {
        throw new Error('Every desktop window must enforce sandbox + contextIsolation.');
      }
    }
    const value = windows[0].webContents.getLastWebPreferences();
    return {
      sandbox: value.sandbox,
      contextIsolation: value.contextIsolation,
      nodeIntegration: value.nodeIntegration,
    };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await fs.access(path.join(data, '.seeded'));
  await window.locator('a[data-view="projects"]').click();
  await window.getByRole('button', { name: /New project|新建项目/ }).click();
  await window
    .getByRole('textbox', { name: /Project ID|项目 ID/, exact: true })
    .fill('desktop-smoke');
  await window.getByRole('textbox', { name: /Name|名称/, exact: true }).fill('Desktop Smoke');
  await window
    .locator('dialog[open]')
    .getByRole('button', { name: /Save|保存/, exact: true })
    .click();
  await window.getByText('Desktop Smoke', { exact: true }).waitFor();
  await window.locator('a[data-view="workflows"]').click();
  await window.getByRole('button', { name: /New workflow|新建工作流/, exact: true }).click();
  await window.getByRole('textbox', { name: /Workflow ID|工作流 ID/, exact: true }).fill('smoke');
  await window.getByRole('textbox', { name: /Name|名称/, exact: true }).fill('Smoke Workflow');
  await window.getByRole('button', { name: /Add stage|添加阶段/, exact: true }).click();
  const argumentsInput = window.getByRole('textbox', {
    name: /Arguments \(JSON\)|参数（JSON）/,
    exact: true,
  });
  const validArguments = await argumentsInput.inputValue();
  const save = window.locator('dialog[open]').getByRole('button', {
    name: /Save|保存/,
    exact: true,
  });
  for (const invalid of ['{', 'null']) {
    await argumentsInput.fill(invalid);
    assert.equal(await save.isDisabled(), true, 'Invalid arguments must not save stale values.');
  }
  await argumentsInput.fill(validArguments);
  assert.equal(await save.isEnabled(), true);
  await window.getByRole('button', { name: 'JSON', exact: true }).click();
  assert.equal(await save.isDisabled(), true);
  await window.getByRole('button', { name: /Apply|应用/, exact: true }).click();
  assert.equal(await save.isEnabled(), true);
  await window
    .locator('dialog[open]')
    .getByRole('button', { name: /Close|关闭/, exact: true })
    .click();
  await window.locator('a[data-view="projects"]').click();
  await window.getByText('Desktop Smoke', { exact: true }).waitFor();
  const config = JSON.parse(await fs.readFile(path.join(data, 'config.json'), 'utf8'));
  port = config.port;
  const reportDir = path.join(root, 'output', `desktop-smoke-${process.platform}-${process.arch}`);
  await fs.mkdir(reportDir, { recursive: true });
  await window.screenshot({ path: path.join(reportDir, 'projects.png'), scale: 'css' });
  console.log('[desktop-smoke] UI checks passed; requesting desktop quit.');
  // Playwright waits for stdio to close, which can outlive Electron while the gateway survives.
  // Verify the actual desktop PID first; drain the automation transport after stopping the gateway.
  closing = application.close();
  void closing.catch(() => {});
  await waitForProcessExit(desktopPid);
  console.log('[desktop-smoke] Desktop process exited.');
  assert.equal(
    (
      await (
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) })
      ).json()
    ).protocol,
    'oaa/1',
    'Quitting the desktop must not stop its accepted gateway work.',
  );
  const report = {
    platform: process.platform,
    arch: process.arch,
    packaged: !!values.executable,
    automaticConnection: true,
    firstRunSeeded: true,
    noPersistentTokenLeak: true,
    renderer: preferences,
    projectCreated: true,
    workflowArgumentsValidated: true,
    gatewaySurvivedDesktopExit: true,
  };
  await fs.writeFile(path.join(reportDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  failure = error;
} finally {
  if (application && !closing) {
    closing = application.close();
    void closing.catch(() => {});
  }
  try {
    await fs.access(path.join(data, 'config.json'));
    execFileSync(process.execPath, [path.join(root, 'dist/src/cli.js'), 'stop', '--dir', data], {
      stdio: 'pipe',
      timeout: 15000,
    });
    await fs.rm(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  } catch (error) {
    if (!failure) failure = error;
  }
  if (closing) {
    try {
      await withTimeout(closing, 10000, 'Desktop automation transport did not close.');
    } catch (error) {
      if (!failure) failure = error;
      if (desktopPid) {
        try {
          process.kill(desktopPid, 'SIGTERM');
        } catch {}
      }
      application.process().kill('SIGTERM');
      for (const stream of application.process().stdio) stream?.destroy();
    }
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
}
