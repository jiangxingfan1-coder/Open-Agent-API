'use strict';

const path = require('node:path');
const strings = require('./strings.cjs');
const { htmlEscape, localConfiguration } = require('./core.cjs');

const SAFE_ID_PATTERN = /^[\w.:-]{1,200}$/;

function isOwnerWaitingRun(run) {
  if (!run || typeof run !== 'object') return false;
  if (run.status !== 'requires_action') return false;
  // Exclude runs waiting solely on caller-side bridged tools (`waiting_on === 'caller'`).
  return (run.waiting_on ?? 'owner') === 'owner';
}

function extractOwnerApprovalRuns(runs) {
  if (!Array.isArray(runs)) return [];
  return runs.filter(isOwnerWaitingRun);
}

function countActiveRuns(overview) {
  if (!overview || typeof overview !== 'object') return 0;
  const metrics = overview.metrics;
  if (metrics && typeof metrics === 'object') {
    const running = Number.isFinite(metrics.in_progress)
      ? metrics.in_progress
      : Number.isFinite(metrics.running)
        ? metrics.running
        : null;
    const queued = Number.isFinite(metrics.queued) ? metrics.queued : 0;
    if (running !== null) return Math.max(0, running + queued);
  }
  if (!Array.isArray(overview.runs)) return 0;
  return overview.runs.filter((r) =>
    ['in_progress', 'running', 'queued'].includes(String(r?.status ?? '')),
  ).length;
}

function summarizeActionPreview(action) {
  const raw =
    typeof action?.detail?.preview === 'string'
      ? action.detail.preview
      : typeof action?.detail === 'string'
        ? action.detail
        : '';
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const tool =
        typeof parsed.tool === 'string'
          ? parsed.tool
          : typeof parsed.command === 'string'
            ? parsed.command
            : typeof parsed.name === 'string'
              ? parsed.name
              : '';
      const reason =
        typeof parsed.reason === 'string'
          ? parsed.reason
          : typeof parsed.description === 'string'
            ? parsed.description
            : '';
      if (tool && reason) return `${tool} — ${reason}`.slice(0, 140);
      if (tool) return tool.slice(0, 140);
    }
  } catch {}
  return raw.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function collectPendingApprovals(runs, actionsByRunId = {}) {
  const ownerRuns = extractOwnerApprovalRuns(runs);
  const items = [];
  for (const run of ownerRuns) {
    if (!run?.id || !SAFE_ID_PATTERN.test(String(run.id))) continue;
    const rawActions = Array.isArray(actionsByRunId[run.id]) ? actionsByRunId[run.id] : [];
    const ownerActions = rawActions.filter(
      (a) =>
        a &&
        typeof a === 'object' &&
        a.kind !== 'client_tool' &&
        SAFE_ID_PATTERN.test(String(a.id ?? '')),
    );
    for (const action of ownerActions) {
      items.push({
        runId: String(run.id),
        actionId: String(action.id),
        agent: String(run.agent ?? 'agent'),
        input: String(run.input ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100),
        kind: action.kind === 'native' ? 'native' : 'tool',
        expiresAt: Number.isFinite(action.expires_at) ? Number(action.expires_at) : null,
        preview: summarizeActionPreview(action),
      });
    }
  }
  return items;
}

function diffFreshOwnerApprovals(runs, seenRunIds, primed, lang = 'en') {
  const seen = seenRunIds instanceof Set ? seenRunIds : new Set(seenRunIds ?? []);
  const ownerRuns = extractOwnerApprovalRuns(runs);
  const freshRuns = [];
  for (const run of ownerRuns) {
    const id = String(run?.id ?? '');
    if (!id || !SAFE_ID_PATTERN.test(id)) continue;
    if (!seen.has(id)) {
      seen.add(id);
      freshRuns.push(run);
    }
  }
  if (!primed) {
    return {
      shouldNotify: false,
      primed: true,
      freshRuns: [],
      notification: null,
      seenRunIds: seen,
    };
  }
  if (freshRuns.length === 0) {
    return {
      shouldNotify: false,
      primed: true,
      freshRuns: [],
      notification: null,
      seenRunIds: seen,
    };
  }
  const t = (key, params) => strings.formatText(lang, key, params);
  const firstId = String(freshRuns[0].id);
  const title =
    freshRuns.length > 1 ? t('notifyTitleMany', { count: freshRuns.length }) : t('notifyTitleOne');
  const body =
    freshRuns.length > 1
      ? t('notifyBodyMany', {
          agents: freshRuns
            .slice(0, 3)
            .map((r) => String(r.agent ?? 'agent'))
            .join(t('listSeparator')),
        })
      : t('notifyBodyOne', { agent: String(freshRuns[0].agent ?? 'agent') });
  return {
    shouldNotify: true,
    primed: true,
    freshRuns,
    notification: {
      runId: firstId,
      title,
      body,
    },
    seenRunIds: seen,
  };
}

function buildApprovalDecisionRequest({
  origin,
  token,
  runId,
  actionId,
  decision,
  response = {},
} = {}) {
  if (typeof origin !== 'string' || !origin) {
    throw new Error('Gateway origin is required.');
  }
  const parsedOrigin = new URL(origin);
  const normalizedHost = parsedOrigin.hostname === '[::1]' ? '::1' : parsedOrigin.hostname;
  const validatedOrigin = localConfiguration({
    host: normalizedHost,
    port: parsedOrigin.port ? Number(parsedOrigin.port) : 80,
    tls: parsedOrigin.protocol === 'https:' ? {} : undefined,
    security: { profile: 'local' },
  });
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) {
    throw new Error('Valid administrator token is required.');
  }
  if (typeof runId !== 'string' || !SAFE_ID_PATTERN.test(runId)) {
    throw new Error('Invalid run identifier.');
  }
  if (typeof actionId !== 'string' || !SAFE_ID_PATTERN.test(actionId)) {
    throw new Error('Invalid approval action identifier.');
  }
  if (decision !== 'approve' && decision !== 'deny') {
    throw new Error('Decision must be "approve" or "deny".');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Decision response payload must be a JSON object.');
  }
  return {
    url: `${validatedOrigin}/v1/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ decision, response }),
  };
}

function resolveLoginItemState({ app, isolated = false } = {}) {
  if (isolated) {
    return {
      openAtLogin: false,
      enabled: false,
      reason: 'isolated',
    };
  }
  if (!app || typeof app.getLoginItemSettings !== 'function') {
    return {
      openAtLogin: false,
      enabled: false,
      reason: 'unsupported',
    };
  }
  try {
    const settings = app.getLoginItemSettings();
    return {
      openAtLogin: Boolean(settings?.openAtLogin),
      enabled: true,
      reason: null,
    };
  } catch {
    return {
      openAtLogin: false,
      enabled: false,
      reason: 'unavailable',
    };
  }
}

function updateLoginItemState({ app, isolated = false, openAtLogin = false } = {}) {
  if (isolated) {
    return {
      ok: false,
      openAtLogin: false,
      enabled: false,
      reason: 'isolated',
    };
  }
  if (!app || typeof app.setLoginItemSettings !== 'function') {
    return {
      ok: false,
      openAtLogin: false,
      enabled: false,
      reason: 'unsupported',
    };
  }
  const desired = Boolean(openAtLogin);
  app.setLoginItemSettings({ openAtLogin: desired });
  const current = resolveLoginItemState({ app, isolated: false });
  return {
    ok: true,
    openAtLogin: current.openAtLogin,
    enabled: current.enabled,
    reason: current.reason,
  };
}

function buildTrayContextMenuTemplate({ state, lang = 'en', callbacks = {} } = {}) {
  const t = (key, params) => strings.formatText(lang, key, params);
  const online = Boolean(state?.online);
  const address = state?.address || '127.0.0.1:8787';
  const runningCount = Number(state?.runningCount ?? 0);
  const approvals = Array.isArray(state?.approvals) ? state.approvals : [];
  const pendingCount = Number(state?.pendingCount ?? approvals.length);
  const loginItem = state?.loginItem ?? { openAtLogin: false, enabled: false, reason: null };

  const statusLabel = online
    ? state?.attached
      ? `● ${t('gatewayAttached', { address })}`
      : `● ${t('gatewayOnline', { address })}`
    : `○ ${t('gatewayOffline')}`;

  const summaryLabel = `${t('metricRunning')}: ${runningCount} · ${t('metricPending')}: ${pendingCount}`;

  const approvalItems =
    approvals.length > 0
      ? [
          { type: 'separator' },
          { label: `${t('pendingHeading')} (${approvals.length})`, enabled: false },
          ...approvals.slice(0, 8).map((item) => ({
            label: `${item.agent} · ${item.preview || item.actionId}`.slice(0, 64),
            submenu: [
              {
                label: `✓ ${t('approve')}`,
                click: () => callbacks.onDecide?.(item.runId, item.actionId, 'approve'),
              },
              {
                label: `✕ ${t('deny')}`,
                click: () => callbacks.onDecide?.(item.runId, item.actionId, 'deny'),
              },
              { type: 'separator' },
              {
                label: t('viewInConsole'),
                click: () => callbacks.onInspectRun?.(item.runId),
              },
            ],
          })),
        ]
      : [];

  return [
    { label: statusLabel, enabled: false },
    { label: summaryLabel, enabled: false },
    {
      label: t('openQuickPanel'),
      click: () => callbacks.onTogglePanel?.(),
    },
    ...approvalItems,
    { type: 'separator' },
    {
      label: t('openConsole'),
      click: () => callbacks.onOpenConsole?.(),
    },
    {
      label: t('openInBrowser'),
      click: () => callbacks.onOpenInBrowser?.(),
    },
    {
      label: t('settings'),
      click: () => callbacks.onOpenSettings?.(),
    },
    { type: 'separator' },
    {
      label: loginItem.reason === 'isolated' ? t('launchAtLoginIsolated') : t('launchAtLogin'),
      type: 'checkbox',
      checked: Boolean(loginItem.openAtLogin),
      enabled: Boolean(loginItem.enabled),
      click: (menuItem) => callbacks.onToggleLoginItem?.(Boolean(menuItem.checked)),
    },
    { type: 'separator' },
    {
      label: t('copyAdminKey'),
      click: () => callbacks.onCopyAdminKey?.(),
    },
    {
      label: t('copyBaseUrl'),
      click: () => callbacks.onCopyBaseUrl?.(),
    },
    {
      label: t('openDataFolder'),
      click: () => callbacks.onOpenDataFolder?.(),
    },
    { type: 'separator' },
    {
      label: t('restartGateway'),
      click: () => callbacks.onRestartGateway?.(),
    },
    ...(state?.canStopGateway
      ? [
          {
            label: t('stop'),
            click: () => callbacks.onStopAndQuit?.(),
          },
        ]
      : []),
    {
      label: t('quit'),
      click: () => callbacks.onQuit?.(),
    },
  ];
}

function computePanelBounds({
  trayBounds,
  workArea,
  width = 368,
  height = 472,
  platform = process.platform,
} = {}) {
  const area = workArea || { x: 0, y: 0, width: 1440, height: 900 };
  if (!trayBounds || (trayBounds.x === 0 && trayBounds.y === 0 && trayBounds.width === 0)) {
    return {
      x: Math.round(area.x + area.width - width - 16),
      y: Math.round(platform === 'win32' ? area.y + area.height - height - 16 : area.y + 12),
      width,
      height,
    };
  }
  const centerX = trayBounds.x + trayBounds.width / 2;
  const unclampedX = Math.round(centerX - width / 2);
  const x = Math.max(area.x + 8, Math.min(unclampedX, area.x + area.width - width - 8));
  const trayInBottomHalf = trayBounds.y > area.y + area.height / 2;
  const unclampedY = trayInBottomHalf
    ? trayBounds.y - height - 8
    : trayBounds.y + trayBounds.height + 6;
  const y = Math.max(
    area.y + 8,
    Math.min(Math.round(unclampedY), area.y + area.height - height - 8),
  );
  return { x, y, width, height };
}

function trustedPanelFrame(event, panelWindow) {
  try {
    return (
      Boolean(panelWindow) &&
      !panelWindow.isDestroyed() &&
      event.sender === panelWindow.webContents &&
      event.senderFrame === panelWindow.webContents.mainFrame
    );
  } catch {
    return false;
  }
}

function renderTrayPanelHTML({ lang = 'en' } = {}) {
  const htmlLang = lang === 'zh' ? 'zh-CN' : 'en';
  const dict = lang === 'zh' ? strings.zh : strings.en;
  const i18nJson = JSON.stringify(dict).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;" />
  <title>${htmlEscape(dict.panelTitle)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #171919;
      --surface: rgba(34, 38, 38, 0.88);
      --surface-hover: rgba(44, 50, 49, 0.95);
      --border: rgba(255, 255, 255, 0.09);
      --fg: #eef1ef;
      --muted: #9aa4a1;
      --accent: #7fd4cb;
      --accent-ink: #0c2220;
      --danger-bg: rgba(224, 108, 95, 0.14);
      --danger-fg: #f09388;
      --danger-border: rgba(224, 108, 95, 0.32);
      --ok: #6fd1a5;
      --warn: #e5b567;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #efece4;
        --surface: rgba(255, 253, 248, 0.88);
        --surface-hover: rgba(255, 255, 255, 0.98);
        --border: rgba(19, 34, 32, 0.11);
        --fg: #152321;
        --muted: #5c6a67;
        --accent: #166a62;
        --accent-ink: #f7f9f8;
        --danger-bg: rgba(185, 64, 52, 0.09);
        --danger-fg: #a5352a;
        --danger-border: rgba(185, 64, 52, 0.25);
        --ok: #1b7f5a;
        --warn: #b07419;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: radial-gradient(120% 90% at 15% 0%, rgba(127, 212, 203, 0.09), transparent 55%), var(--bg);
      color: var(--fg);
      font: 12.5px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .header {
      padding: 14px 16px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .mark {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
    }
    .mark g {
      fill: none;
      stroke: currentColor;
      stroke-width: 11;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .title-box strong {
      display: block;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .status-line {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--muted);
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
    }
    .dot.online {
      background: var(--ok);
      box-shadow: 0 0 0 3px rgba(111, 209, 165, 0.18);
    }
    .icon-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--fg);
      border-radius: 7px;
      padding: 5px 9px;
      font-size: 11px;
      cursor: pointer;
      transition: background 140ms ease, transform 100ms ease;
    }
    .icon-btn:hover { background: var(--surface-hover); }
    .icon-btn:active { transform: scale(0.97); }
    .metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 10px 16px;
    }
    .metric-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 8px 11px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .metric-card span {
      font-size: 11px;
      color: var(--muted);
    }
    .metric-card b {
      font-size: 18px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .metric-card.has-pending b {
      color: var(--warn);
    }
    .section-title {
      padding: 2px 16px 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .list {
      flex: 1;
      overflow-y: auto;
      padding: 0 16px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .empty {
      margin: auto 0;
      text-align: center;
      padding: 24px 14px;
      color: var(--muted);
    }
    .empty strong {
      display: block;
      color: var(--fg);
      font-size: 13px;
      margin-bottom: 4px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 11px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color 150ms ease;
    }
    .card:hover {
      border-color: rgba(127, 212, 203, 0.35);
    }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .agent-tag {
      font-weight: 600;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .kind-badge {
      font-size: 10.5px;
      color: var(--muted);
      padding: 1px 6px;
      border-radius: 99px;
      border: 1px solid var(--border);
      flex-shrink: 0;
    }
    .preview {
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 11px;
      color: var(--muted);
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
    }
    .btn {
      appearance: none;
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: opacity 140ms ease, transform 100ms ease, background 140ms ease;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .btn-approve {
      background: var(--accent);
      color: var(--accent-ink);
      flex: 1;
    }
    .btn-approve:hover:not(:disabled) { opacity: 0.92; }
    .btn-deny {
      background: var(--danger-bg);
      color: var(--danger-fg);
      border-color: var(--danger-border);
      flex: 1;
    }
    .btn-deny:hover:not(:disabled) { opacity: 0.88; }
    .btn-inspect {
      background: transparent;
      color: var(--muted);
      border-color: var(--border);
    }
    .btn-inspect:hover:not(:disabled) {
      color: var(--fg);
      background: var(--surface-hover);
    }
    .toast {
      padding: 6px 16px;
      font-size: 11px;
      color: var(--accent);
      min-height: 22px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toast.error { color: var(--danger-fg); }
    .footer {
      border-top: 1px solid var(--border);
      padding: 9px 16px 11px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--surface);
    }
    .login-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11.5px;
      color: var(--fg);
    }
    .login-row.disabled {
      color: var(--muted);
    }
    .login-row input {
      accent-color: var(--accent);
      cursor: pointer;
    }
    .login-row.disabled input {
      cursor: not-allowed;
    }
    .footer-actions {
      display: flex;
      gap: 6px;
    }
    .footer-actions .icon-btn {
      flex: 1;
      text-align: center;
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="brand-row">
      <svg class="mark" viewBox="40.11 43 175.78 170" aria-hidden="true">
        <g>
          <path d="M209.89 207L150.11 49L108.57 155" />
          <path d="M94.7 190.38L88.19 207" />
          <path d="M143.36 106.65A50 50 0 1 1 119.1 78.6" />
        </g>
      </svg>
      <div class="title-box">
        <strong>Open Agent API</strong>
        <div class="status-line">
          <span id="status-dot" class="dot"></span>
          <span id="status-text"></span>
        </div>
      </div>
    </div>
    <button id="refresh-btn" type="button" class="icon-btn"></button>
  </header>

  <section class="metrics">
    <div class="metric-card">
      <span id="label-running"></span>
      <b id="val-running">0</b>
    </div>
    <div id="pending-card" class="metric-card">
      <span id="label-pending"></span>
      <b id="val-pending">0</b>
    </div>
  </section>

  <div id="heading-pending" class="section-title"></div>
  <main id="approval-list" class="list" role="list"></main>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <footer class="footer">
    <label id="login-row" class="login-row">
      <span id="login-label"></span>
      <input id="login-toggle" type="checkbox" />
    </label>
    <div class="footer-actions">
      <button id="open-console-btn" type="button" class="icon-btn"></button>
      <button id="open-settings-btn" type="button" class="icon-btn"></button>
    </div>
  </footer>

  <script>
    (() => {
      const DICT = ${i18nJson};
      const fmt = (key, params = {}) =>
        String(DICT[key] || key).replace(/\\{(\\w+)\\}/g, (m, k) =>
          Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
        );
      const $ = (id) => document.getElementById(id);
      const busy = new Set();

      $('refresh-btn').textContent = fmt('refresh');
      $('label-running').textContent = fmt('metricRunning');
      $('label-pending').textContent = fmt('metricPending');
      $('heading-pending').textContent = fmt('pendingHeading');
      $('open-console-btn').textContent = fmt('openConsole');
      $('open-settings-btn').textContent = fmt('settings');

      const showToast = (msg, isError = false) => {
        const node = $('toast');
        node.textContent = msg || '';
        node.classList.toggle('error', Boolean(isError));
      };

      function render(state) {
        if (!state) return;
        const online = Boolean(state.online);
        const address = state.address || '127.0.0.1:8787';
        $('status-dot').classList.toggle('online', online);
        $('status-text').textContent = online
          ? fmt(state.attached ? 'gatewayAttached' : 'gatewayOnline', { address })
          : fmt('gatewayOffline');

        $('val-running').textContent = String(state.runningCount ?? 0);
        const approvals = Array.isArray(state.approvals) ? state.approvals : [];
        const pendingCount = Number(state.pendingCount ?? approvals.length);
        $('val-pending').textContent = String(pendingCount);
        $('pending-card').classList.toggle('has-pending', pendingCount > 0);

        const login = state.loginItem || { openAtLogin: false, enabled: false, reason: null };
        $('login-label').textContent =
          login.reason === 'isolated' ? fmt('launchAtLoginIsolated') : fmt('launchAtLogin');
        $('login-toggle').checked = Boolean(login.openAtLogin);
        $('login-toggle').disabled = !login.enabled;
        $('login-row').classList.toggle('disabled', !login.enabled);

        const list = $('approval-list');
        list.replaceChildren();
        if (approvals.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          const title = document.createElement('strong');
          title.textContent = fmt('pendingEmptyTitle');
          const body = document.createElement('div');
          body.textContent = fmt('pendingEmptyBody');
          empty.append(title, body);
          list.append(empty);
          return;
        }

        for (const item of approvals) {
          const key = item.runId + ':' + item.actionId;
          const card = document.createElement('div');
          card.className = 'card';
          card.setAttribute('role', 'listitem');

          const head = document.createElement('div');
          head.className = 'card-head';
          const agent = document.createElement('span');
          agent.className = 'agent-tag';
          agent.textContent = item.agent;
          const badge = document.createElement('span');
          badge.className = 'kind-badge';
          badge.textContent = fmt(item.kind === 'native' ? 'actionKindNative' : 'actionKindTool');
          head.append(agent, badge);

          const preview = document.createElement('div');
          preview.className = 'preview';
          preview.textContent = item.preview || item.input || item.actionId;

          const controls = document.createElement('div');
          controls.className = 'controls';

          const makeDecisionButton = (decision) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn ' + (decision === 'approve' ? 'btn-approve' : 'btn-deny');
            btn.disabled = busy.has(key);
            btn.textContent = fmt(decision === 'approve' ? 'approve' : 'deny');
            btn.onclick = async () => {
              if (busy.has(key)) return;
              busy.add(key);
              btn.textContent = fmt(decision === 'approve' ? 'approving' : 'denying');
              for (const b of controls.querySelectorAll('button')) b.disabled = true;
              try {
                const res = await window.oaaTray.decide({
                  runId: item.runId,
                  actionId: item.actionId,
                  decision,
                });
                if (!res || !res.ok) {
                  throw new Error((res && res.error) || 'Request failed');
                }
                showToast(
                  fmt(decision === 'approve' ? 'decisionApproved' : 'decisionDenied', {
                    id: item.actionId.slice(0, 12),
                  }),
                  false
                );
              } catch (err) {
                showToast(fmt('decisionFailed', { error: err.message || String(err) }), true);
                for (const b of controls.querySelectorAll('button')) b.disabled = false;
                btn.textContent = fmt(decision === 'approve' ? 'approve' : 'deny');
              } finally {
                busy.delete(key);
              }
            };
            return btn;
          };

          const inspectBtn = document.createElement('button');
          inspectBtn.type = 'button';
          inspectBtn.className = 'btn btn-inspect';
          inspectBtn.textContent = fmt('viewInConsole');
          inspectBtn.onclick = () => window.oaaTray.action('inspectRun', { runId: item.runId });

          controls.append(makeDecisionButton('approve'), makeDecisionButton('deny'), inspectBtn);
          card.append(head, preview, controls);
          list.append(card);
        }
      }

      $('refresh-btn').onclick = () => {
        showToast('');
        void window.oaaTray.refresh();
      };
      $('login-toggle').onchange = async (e) => {
        const res = await window.oaaTray.setLoginItem(e.target.checked);
        if (!res || !res.ok) e.target.checked = false;
      };
      $('open-console-btn').onclick = () => window.oaaTray.action('openConsole');
      $('open-settings-btn').onclick = () => window.oaaTray.action('openSettings');

      window.oaaTray.onState(render);
      void window.oaaTray.getState().then(render);
    })();
  </script>
</body>
</html>`;
}

function createTrayController({
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  screen,
  trayIconPath,
  isTemplateIcon = false,
  getLang,
  isIsolated,
  onDecideApproval,
  onRefreshRequested,
  callbacks,
}) {
  let tray = null;
  let panelWindow = null;
  let latestState = {
    online: false,
    attached: false,
    address: '127.0.0.1:8787',
    runningCount: 0,
    pendingCount: 0,
    approvals: [],
    canStopGateway: false,
    loginItem: resolveLoginItemState({ app, isolated: isIsolated() }),
  };

  function ensurePanelWindow() {
    if (panelWindow && !panelWindow.isDestroyed()) return panelWindow;
    panelWindow = new BrowserWindow({
      width: 368,
      height: 472,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: false,
      backgroundColor: '#171919',
      webPreferences: {
        preload: path.join(__dirname, 'tray-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    panelWindow.webContents.session.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    panelWindow.webContents.session.setPermissionCheckHandler(() => false);
    panelWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panelWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('data:text/html')) event.preventDefault();
    });
    panelWindow.on('blur', () => {
      if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
        panelWindow.hide();
      }
    });
    const html = renderTrayPanelHTML({ lang: getLang() });
    void panelWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return panelWindow;
  }

  function rebuildContextMenu() {
    if (!tray) return;
    const template = buildTrayContextMenuTemplate({
      state: latestState,
      lang: getLang(),
      callbacks: {
        ...callbacks,
        onTogglePanel: () => togglePanel(),
        onDecide: async (runId, actionId, decision) => {
          await onDecideApproval({ runId, actionId, decision });
        },
        onToggleLoginItem: (checked) => {
          updateLoginItemState({ app, isolated: isIsolated(), openAtLogin: checked });
          latestState = {
            ...latestState,
            loginItem: resolveLoginItemState({ app, isolated: isIsolated() }),
          };
          rebuildContextMenu();
          pushPanelState();
        },
      },
    });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  function pushPanelState() {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send('oaa:tray:state', latestState);
    }
  }

  function togglePanel() {
    const win = ensurePanelWindow();
    if (win.isVisible()) {
      win.hide();
      return;
    }
    const trayBounds = tray ? tray.getBounds() : null;
    const display =
      trayBounds && screen
        ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
        : screen?.getPrimaryDisplay();
    const bounds = computePanelBounds({
      trayBounds,
      workArea: display?.workArea,
      platform: process.platform,
    });
    win.setBounds(bounds, false);
    pushPanelState();
    win.show();
    win.focus();
  }

  function registerIpc() {
    ipcMain.removeHandler('oaa:tray:get-state');
    ipcMain.removeHandler('oaa:tray:refresh');
    ipcMain.removeHandler('oaa:tray:decide');
    ipcMain.removeHandler('oaa:tray:set-login-item');

    ipcMain.handle('oaa:tray:get-state', (event) => {
      if (!trustedPanelFrame(event, panelWindow)) return null;
      latestState = {
        ...latestState,
        loginItem: resolveLoginItemState({ app, isolated: isIsolated() }),
      };
      return latestState;
    });

    ipcMain.handle('oaa:tray:refresh', async (event) => {
      if (!trustedPanelFrame(event, panelWindow)) return null;
      await onRefreshRequested?.();
      return latestState;
    });

    ipcMain.handle('oaa:tray:decide', async (event, payload) => {
      if (!trustedPanelFrame(event, panelWindow) || !payload || typeof payload !== 'object') {
        return { ok: false, error: 'Untrusted request.' };
      }
      try {
        await onDecideApproval({
          runId: String(payload.runId ?? ''),
          actionId: String(payload.actionId ?? ''),
          decision:
            payload.decision === 'approve' ? 'approve' : payload.decision === 'deny' ? 'deny' : '',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    ipcMain.handle('oaa:tray:set-login-item', (event, openAtLogin) => {
      if (!trustedPanelFrame(event, panelWindow)) return { ok: false };
      const res = updateLoginItemState({
        app,
        isolated: isIsolated(),
        openAtLogin: Boolean(openAtLogin),
      });
      latestState = {
        ...latestState,
        loginItem: resolveLoginItemState({ app, isolated: isIsolated() }),
      };
      rebuildContextMenu();
      pushPanelState();
      return res;
    });

    ipcMain.on('oaa:tray:action', (event, message) => {
      if (!trustedPanelFrame(event, panelWindow) || !message || typeof message !== 'object') return;
      if (message.name === 'openConsole') {
        panelWindow?.hide();
        callbacks?.onOpenConsole?.();
      } else if (message.name === 'openSettings') {
        panelWindow?.hide();
        callbacks?.onOpenSettings?.();
      } else if (message.name === 'inspectRun' && message.payload?.runId) {
        panelWindow?.hide();
        callbacks?.onInspectRun?.(String(message.payload.runId));
      }
    });
  }

  function init() {
    registerIpc();
    try {
      let image = nativeImage.createFromPath(trayIconPath);
      if (process.platform === 'darwin') {
        image = image.resize({ width: 18, height: 18 });
        if (isTemplateIcon) image.setTemplateImage(true);
      } else {
        image = image.resize({ width: 20, height: 20 });
      }
      tray = new Tray(image);
      tray.setToolTip(strings.formatText(getLang(), 'statusTooltip'));
      if (process.platform === 'darwin') {
        // Left-click toggles the quick approval panel; right-click opens native context menu.
        tray.on('click', () => togglePanel());
        tray.on('right-click', () => {
          rebuildContextMenu();
          tray.popUpContextMenu();
        });
      } else {
        rebuildContextMenu();
        tray.on('click', () => togglePanel());
      }
    } catch {
      tray = null;
    }
    return tray;
  }

  function updateState(patch) {
    latestState = {
      ...latestState,
      ...patch,
      loginItem: resolveLoginItemState({ app, isolated: isIsolated() }),
    };
    const count = Math.max(0, Number(latestState.pendingCount ?? 0));
    const badgeLabel = count > 99 ? '99+' : count > 0 ? String(count) : '';
    if (tray) {
      const lang = getLang();
      const tooltip =
        count > 0
          ? strings.formatText(lang, count === 1 ? 'statusBadgeOne' : 'statusBadgeMany', {
              count: badgeLabel,
            })
          : strings.formatText(lang, 'statusTooltip');
      tray.setToolTip(tooltip);
      if (process.platform === 'darwin') {
        tray.setTitle(badgeLabel);
      }
      if (process.platform !== 'darwin') {
        rebuildContextMenu();
      }
    }
    pushPanelState();
  }

  function destroy() {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.destroy();
    }
    panelWindow = null;
    if (tray) {
      tray.destroy();
      tray = null;
    }
  }

  return {
    init,
    updateState,
    togglePanel,
    ensurePanelWindow,
    getState: () => latestState,
    hasTray: () => Boolean(tray),
    destroy,
  };
}

module.exports = {
  isOwnerWaitingRun,
  extractOwnerApprovalRuns,
  countActiveRuns,
  summarizeActionPreview,
  collectPendingApprovals,
  diffFreshOwnerApprovals,
  buildApprovalDecisionRequest,
  resolveLoginItemState,
  updateLoginItemState,
  buildTrayContextMenuTemplate,
  computePanelBounds,
  renderTrayPanelHTML,
  createTrayController,
};
