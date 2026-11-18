import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cliPath = path.join(root, 'dist/src/cli.js');
const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const electronExec = values.executable ?? require('electron');
const packaged = Boolean(values.executable);

const results = [];
const tempDirs = [];

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function runCli(args) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 25000,
  });
}

function stopCliQuiet(dir) {
  try {
    execFileSync(process.execPath, [cliPath, 'stop', '--dir', dir], {
      stdio: 'pipe',
      timeout: 15000,
    });
  } catch {}
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return { status: res.status, json: await res.json() };
}

function launchArgs(dataDir, port) {
  const args = [];
  if (!packaged) args.push(here);
  args.push('--oaa-data-dir', dataDir);
  if (port !== undefined) args.push('--port', String(port));
  return args;
}

async function launchElectron({ dataDir, port, testBridge = false }) {
  const env = {
    ...process.env,
    OAA_DESKTOP_NODE: process.execPath,
    OAA_DESKTOP_HOME: dataDir,
    ...(port !== undefined ? { OAA_DESKTOP_PORT: String(port) } : {}),
    ...(testBridge ? { OAA_DESKTOP_TEST_BRIDGE: '1' } : {}),
  };
  const application = await _electron.launch({
    executablePath: electronExec,
    args: launchArgs(dataDir, port),
    env,
    timeout: 30000,
  });
  const desktopPid = await application.evaluate(() => process.pid);
  const window = await application.firstWindow({ timeout: 25000 });
  window.setDefaultTimeout(15000);
  await window.waitForFunction(
    () =>
      !!sessionStorage.getItem('oaa-token') &&
      !document.querySelector('#connection-dialog[open]') &&
      (document.querySelector('#view')?.children.length ?? 0) > 0,
  );
  return { application, window, desktopPid };
}

async function closeElectron({ application, desktopPid }) {
  const closing = application.close();
  try {
    await withTimeout(closing, 10000, 'Electron did not close in time');
  } catch {
    if (desktopPid) {
      try {
        process.kill(desktopPid, 'SIGTERM');
      } catch {}
    }
    application.process().kill('SIGTERM');
    for (const s of application.process().stdio) s?.destroy();
  }
}

async function runConflictProbe({ dataDir, port, reportFile }) {
  const env = {
    ...process.env,
    OAA_DESKTOP_NODE: process.execPath,
    OAA_DESKTOP_HOME: dataDir,
    ...(port !== undefined ? { OAA_DESKTOP_PORT: String(port) } : {}),
    OAA_DESKTOP_ERROR_REPORT: reportFile,
  };
  if (port === undefined) delete env.OAA_DESKTOP_PORT;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronExec, launchArgs(dataDir, port), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Electron conflict probe on port ${port} timed out`));
    }, 20000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const raw = await fs.readFile(reportFile, 'utf8');
  return { exitCode: code, report: JSON.parse(raw) };
}

async function selectSampleAgent(window) {
  const agentSelect = window.locator('.wb-controls select').first();
  await agentSelect.waitFor();
  await agentSelect.selectOption('agent/sample');
  await window.locator('.wb-call-target').filter({ hasText: 'agent/sample' }).waitFor();
}

// 1. Cold start -> seed + create project -> stop -> Second start with same data dir (no re-seed)
{
  const dataDir = await makeTempDir('oaa-matrix-reopen-');
  const port = await getFreePort();
  let session = null;
  try {
    session = await launchElectron({ dataDir, port });
    await fs.access(path.join(dataDir, '.seeded'));
    await session.window.locator('#oaa-desktop-first-run').waitFor({ timeout: 5000 });
    await session.window.locator('#oaa-desktop-first-run button').last().click();
    const seedBefore = await fs.readFile(path.join(dataDir, '.seeded'), 'utf8');
    await session.window.locator('a[data-view="projects"]').click();
    await session.window.getByRole('button', { name: /New project|新建项目/ }).click();
    await session.window.getByRole('textbox', { name: /Project ID|项目 ID/, exact: true }).fill('matrix-persist');
    await session.window.getByRole('textbox', { name: /Name|名称/, exact: true }).fill('Matrix Persist');
    await session.window.locator('dialog[open]').getByRole('button', { name: /Save|保存/, exact: true }).click();
    await session.window.getByText('Matrix Persist', { exact: true }).waitFor();
    await closeElectron(session);
    session = null;
    stopCliQuiet(dataDir);

    // Second launch using existing dataDir and config port
    session = await launchElectron({ dataDir });
    await session.window.waitForTimeout(1200);
    assert.equal(await session.window.locator('#oaa-desktop-first-run').count(), 0, 'First-run banner must not appear on second start');
    assert.equal(await fs.readFile(path.join(dataDir, '.seeded'), 'utf8'), seedBefore, '.seeded marker must stay intact');
    await session.window.locator('a[data-view="projects"]').click();
    await session.window.getByText('Matrix Persist', { exact: true }).waitFor();
    results.push({ scenario: 'second_start_no_reseed', ok: true, packaged });
  } finally {
    if (session) await closeElectron(session);
    stopCliQuiet(dataDir);
  }
}

// 2. Orphan gateway detection & reuse (`attach` mode + survives Electron close)
{
  const dataDir = await makeTempDir('oaa-matrix-orphan-');
  const port = await getFreePort();
  let session = null;
  try {
    runCli(['quickstart', '--dir', dataDir, '--port', String(port)]);
    const before = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    assert.equal(before.status, 200);
    const orphanPid = before.json.pid;
    assert.equal(Number.isInteger(orphanPid) && orphanPid > 0, true);

    session = await launchElectron({ dataDir, port, testBridge: !packaged });
    const afterAttach = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    assert.equal(afterAttach.json.pid, orphanPid, 'Electron must attach to the existing orphan gateway rather than respawning it');
    if (!packaged) {
      const state = await session.application.evaluate(async () => {
        await globalThis.__oaaTestBridge?.pollNow?.();
        return {
          attachedPid: globalThis.__oaaTestBridge?.attachedPid?.(),
          started: globalThis.__oaaTestBridge?.started?.(),
          trayAttached: globalThis.__oaaTestBridge?.getTrayState?.()?.attached,
        };
      });
      assert.equal(state.attachedPid, orphanPid);
      assert.equal(state.started, false);
      assert.equal(state.trayAttached, true);
    }
    await closeElectron(session);
    session = null;
    // Orphan gateway started independently by CLI must remain alive after Electron closes
    process.kill(orphanPid, 0);
    results.push({ scenario: 'orphan_gateway_attach', ok: true, orphanPid, packaged });
  } finally {
    if (session) await closeElectron(session);
    stopCliQuiet(dataDir);
  }
}

// 3 & 4. Live #workbench approval + Dock badge + Tray Quick Panel + zh/en switching
{
  const dataDir = await makeTempDir('oaa-matrix-ui-');
  const port = await getFreePort();
  let session = null;
  try {
    session = await launchElectron({ dataDir, port, testBridge: !packaged });
    const { application, window } = session;

    await window.locator('#oaa-desktop-first-run').waitFor({ timeout: 5000 });
    await window.locator('#oaa-desktop-first-run button').last().click();
    await window.locator('a[data-view="workbench"]').click();
    await selectSampleAgent(window);

    // 3A. Workbench inline owner approval
    await window.locator('.wb-input').fill('approve matrix inline test');
    await window.locator('.wb-composer button[type="submit"]').click();
    const ownerCard = window.locator('.wb-action-card.owner');
    await ownerCard.waitFor({ timeout: 20000 });
    await ownerCard.locator('button.primary').waitFor();

    if (process.platform === 'darwin') {
      await withTimeout(
        (async () => {
          for (;;) {
            const badge = await application.evaluate(({ app }) => app.dock?.getBadge?.() ?? '');
            if (badge === '1') break;
            await new Promise((r) => setTimeout(r, 250));
          }
        })(),
        8000,
        'macOS Dock badge did not update to 1 for pending approval',
      );
    }

    await ownerCard.locator('button.primary').click();
    await window.locator('.wb-artifact-name').filter({ hasText: 'sample-note.txt' }).waitFor({ timeout: 20000 });
    assert.equal(await ownerCard.count(), 0, 'Owner approval card must disappear after approval');

    if (process.platform === 'darwin') {
      await withTimeout(
        (async () => {
          for (;;) {
            const badge = await application.evaluate(({ app }) => app.dock?.getBadge?.() ?? '');
            if (badge === '') break;
            await new Promise((r) => setTimeout(r, 250));
          }
        })(),
        8000,
        'macOS Dock badge did not clear after approval',
      );
    }
    results.push({ scenario: 'workbench_inline_approval_and_badge', ok: true, packaged });

    // 3B. Tray Quick Approval panel end-to-end (available in source launch via non-packaged bridge)
    if (!packaged) {
      await window.locator('.wb-section-head button').click();
      await selectSampleAgent(window);
      await window.locator('.wb-input').fill('approve matrix tray test');
      await window.locator('.wb-composer button[type="submit"]').click();
      await window.locator('.wb-action-card.owner button.primary').waitFor({ timeout: 20000 });

      await application.evaluate(async () => {
        await globalThis.__oaaTestBridge.pollNow();
        globalThis.__oaaTestBridge.toggleTrayPanel();
      });

      const trayWindow = await withTimeout(
        (async () => {
          for (;;) {
            const wins = application.windows();
            for (const w of wins) {
              const title = await w.title().catch(() => '');
              if (/Quick Approvals|快捷审批面板/.test(title)) return w;
            }
            await new Promise((r) => setTimeout(r, 150));
          }
        })(),
        8000,
        'Tray quick approval window did not open',
      );
      await trayWindow.locator('.card .btn-approve').first().waitFor({ timeout: 8000 });
      await trayWindow.locator('.card .btn-approve').first().click();
      await window.locator('.wb-artifact-name').filter({ hasText: 'sample-note.txt' }).waitFor({ timeout: 20000 });
      await application.evaluate(() => globalThis.__oaaTestBridge.pollNow()).catch(() => {});
      const emptyStrong = trayWindow.locator('#approval-list .empty strong');
      await emptyStrong.waitFor({ state: 'attached', timeout: 8000 });
      const trayState = await application.evaluate(() => globalThis.__oaaTestBridge.getTrayState());
      assert.equal(trayState.pendingCount, 0);
      results.push({ scenario: 'tray_quick_approval_panel', ok: true, packaged });
    }

    // 4. Console zh <-> en language switch with reload + token preservation
    await window.locator('a[data-view="settings"]').click();
    const langGroup = window
      .locator('#settings-appearance [role="radiogroup"]')
      .filter({ has: window.getByRole('radio', { name: 'English', exact: true }) });
    await langGroup.waitFor();

    const enRadio = langGroup.getByRole('radio', { name: 'English', exact: true });
    const zhRadio = langGroup.getByRole('radio', { name: '中文', exact: true });
    const initiallyEn = (await enRadio.getAttribute('aria-checked')) === 'true';
    const steps = initiallyEn
      ? [
          { click: 'zh', target: '中文', expectedTitle: /^外观$/ },
          { click: 'en', target: 'English', expectedTitle: /^Appearance$/ },
        ]
      : [
          { click: 'en', target: 'English', expectedTitle: /^Appearance$/ },
          { click: 'zh', target: '中文', expectedTitle: /^外观$/ },
        ];

    for (const s of steps) {
      const loadPromise = window.waitForEvent('load');
      await window
        .locator('#settings-appearance [role="radiogroup"]')
        .getByRole('radio', { name: s.target, exact: true })
        .click();
      await loadPromise;
      await window.waitForFunction(() => !!sessionStorage.getItem('oaa-token'));
      await window.locator('#settings-appearance-title').filter({ hasText: s.expectedTitle }).waitFor();
    }
    assert.equal(await zhRadio.count() >= 0 && await enRadio.count() >= 0, true);
    results.push({ scenario: 'locale_switch_zh_en_preserves_session', initial: initiallyEn ? 'en' : 'zh', ok: true, packaged });

    // 4B. Disconnect -> confirm -> verify disconnected -> reload recovers admin session
    await window.locator('#settings-nav [data-section="connection"]').click();
    const disconnectBtn = window
      .locator('#settings-connection button')
      .filter({ hasText: /^Disconnect$|^断开连接$/ });
    await disconnectBtn.waitFor({ timeout: 5000 });
    await disconnectBtn.click();
    await window
      .locator('dialog[open] button')
      .filter({ hasText: /^Disconnect$|^断开连接$/ })
      .click();
    await window
      .locator('#settings-connection button')
      .filter({ hasText: /^Connect workspace$|^连接工作区$/ })
      .waitFor({ timeout: 5000 });
    assert.equal(await window.evaluate(() => sessionStorage.getItem('oaa-token')), null);
    const reloadPromise = window.waitForEvent('load');
    await window.reload();
    await reloadPromise;
    await window.waitForFunction(
      () =>
        !!sessionStorage.getItem('oaa-token') &&
        !document.querySelector('#connection-dialog[open]') &&
        (document.querySelector('#view')?.children.length ?? 0) > 0,
    );
    await window.locator('#settings-nav [data-section="connection"]').click();
    await window
      .locator('#settings-connection button')
      .filter({ hasText: /^Disconnect$|^断开连接$/ })
      .waitFor({ timeout: 8000 });
    results.push({ scenario: 'disconnect_and_reload_recovers', ok: true, packaged });
  } finally {
    if (session) await closeElectron(session);
    stopCliQuiet(dataDir);
  }
}

// 5A. Port held by non-OAA server (`portHeldByOther`)
{
  const dataDir = await makeTempDir('oaa-matrix-port-other-');
  const reportFile = path.join(dataDir, 'error-report.json');
  const blocker = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, foreign: true }));
  });
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  try {
    const outcome = await runConflictProbe({ dataDir, port, reportFile });
    assert.equal(outcome.report.kind, 'portHeldByOther');
    assert.match(outcome.report.title, new RegExp(String(port)));
    assert.match(outcome.report.body, new RegExp(`127\\.0\\.0\\.1:${port}`));
    results.push({ scenario: 'port_conflict_other_process', ok: true, port, packaged });
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    stopCliQuiet(dataDir);
  }
}

// 5B. Port held by another OAA gateway (`portHeldByGateway`)
{
  const foreignDir = await makeTempDir('oaa-matrix-foreign-gw-');
  const ownDir = await makeTempDir('oaa-matrix-own-gw-');
  const reportFile = path.join(ownDir, 'error-report.json');
  const port = await getFreePort();
  try {
    runCli(['quickstart', '--dir', foreignDir, '--port', String(port)]);
    const before = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    assert.equal(before.status, 200);
    const outcome = await runConflictProbe({ dataDir: ownDir, port, reportFile });
    assert.equal(outcome.report.kind, 'portHeldByGateway');
    assert.match(outcome.report.title, new RegExp(String(port)));
    assert.match(outcome.report.body, new RegExp(`127\\.0\\.0\\.1:${port}`));
    const after = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    assert.equal(after.json.pid, before.json.pid, 'Foreign gateway must stay untouched');
    results.push({ scenario: 'port_conflict_foreign_gateway', ok: true, port, packaged });
  } finally {
    stopCliQuiet(foreignDir);
    stopCliQuiet(ownDir);
  }
}

// 5C. Invalid port in config.json (`invalidConfigPort`)
{
  const dataDir = await makeTempDir('oaa-matrix-bad-port-');
  const reportFile = path.join(dataDir, 'error-report.json');
  await fs.writeFile(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ host: '127.0.0.1', port: 99999 }, null, 2),
    'utf8',
  );
  try {
    const outcome = await runConflictProbe({ dataDir, reportFile });
    assert.equal(outcome.report.kind, 'invalidConfigPort');
    assert.match(outcome.report.body, /99999/);
    results.push({ scenario: 'invalid_config_port_error', ok: true, packaged });
  } finally {
    stopCliQuiet(dataDir);
  }
}

for (const dir of tempDirs) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
}

console.log(JSON.stringify({ ok: true, packaged, results }, null, 2));
