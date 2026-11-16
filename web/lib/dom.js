import { state } from './state.js';
import { t } from './i18n.js';
import { LOCAL_ERROR_TEXT, errorText } from './api.js';
import { buildTable } from '../shared/table.js';
import { modelBrand } from './model-brand.js';
import {
  AGENT_ICONS,
  AGENT_MONO_ICONS,
  MARK_PATHS,
  MARK_VIEWBOX,
  STATUS,
  engineKey,
} from './format.js';

export const $ = (id) => document.getElementById(id);
export const SVG_NS = 'http://www.w3.org/2000/svg';

export const icon = (name) => {
  const node = document.createElement('i');
  node.dataset.lucide = name;
  return node;
};
export const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (tag === 'code' || tag === 'pre') n.translate = false;
  if (text !== undefined) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
};
// Replace only the <i data-lucide> placeholders. lucide.createIcons() would also re-create
// every SVG it made before (they keep data-lucide), rebuilding hundreds of icons per poll.
export const icons = () => {
  const lucide = window.lucide;
  if (!lucide?.createElement) return;
  for (const node of document.querySelectorAll('i[data-lucide]')) {
    const name = node.dataset.lucide;
    const def = lucide.icons[name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())];
    if (!def) continue;
    const svg = lucide.createElement(def, {
      class: ['lucide', `lucide-${name}`, ...node.classList].join(' '),
      'aria-hidden': 'true',
    });
    node.replaceWith(svg);
  }
};
// A dot and a word. The capsule (`pill`) is only ever drawn for a state that waits for a person
// (tone `warn`); asking for it on any other state changes nothing.
export const status = (s, pill = false) => {
  const [label, tone] = STATUS[s] ?? [s, 'neutral'];
  return el('span', label, `status ${tone}${pill && tone === 'warn' ? ' pill' : ''}`);
};
export function brandMark() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', MARK_VIEWBOX);
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  const g = document.createElementNS(SVG_NS, 'g');
  for (const d of MARK_PATHS) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    g.append(p);
  }
  svg.append(g);
  return svg;
}
export function initials(engine) {
  const key = engineKey(engine).replace(/[^a-z0-9]/gi, '');
  return el('span', (key.slice(0, 2) || 'AG').toUpperCase(), 'initials');
}
export function agentGlyph(engine, size = '', preset) {
  const box = el('span', undefined, `agent-glyph ${size}`.trim());
  const key = preset || engineKey(engine);
  if (engine === 'kernel') box.append(brandMark());
  else if (AGENT_ICONS.has(key)) {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.onerror = () => img.replaceWith(initials(engine));
    img.src = `/agents/${key}.svg`;
    if (AGENT_MONO_ICONS.has(key)) box.classList.add('mono');
    box.append(img);
  } else box.append(initials(engine));
  return box;
}
export function modelGlyph(model, displayName = model) {
  const key = modelBrand(model) ?? modelBrand(displayName);
  const box = el('span', undefined, 'model-glyph');
  box.setAttribute('aria-hidden', 'true');
  if (!key) box.append(icon('cpu'));
  else {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.src = `/agents/model-${key}.svg`;
    if (['openai', 'grok', 'zai'].includes(key)) box.classList.add('mono');
    img.onerror = () => {
      box.replaceChildren(icon('cpu'));
      icons();
    };
    box.append(img);
  }
  return box;
}
export function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (box.hidden = true), 3500);
}
// These errors have one way out: reconnect with a valid key. They are recognised by their text
// (the banner only receives a message): the local copy, the error catalog's and the HTTP 401 line.
const reconnectTexts = () =>
  [
    LOCAL_ERROR_TEXT.unauthorized,
    LOCAL_ERROR_TEXT.key_expired,
    errorText('unauthorized'),
    errorText('key_expired'),
    t('error.http401'),
  ].filter(Boolean);
export function error(message) {
  const banner = $('error-banner');
  banner.replaceChildren();
  if (message) {
    banner.append(icon('circle-alert'), el('span', message));
    // A rejected, expired or revoked key: the banner offers to reconnect right there.
    if (reconnectTexts().includes(message)) {
      const again = button(t('common.reconnect'), 'plug', () => openDialog('connection-dialog'));
      again.classList.add('banner-action');
      banner.append(again);
    }
    icons();
  }
  banner.hidden = !message;
}
export async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast(t('common.clipboardFailed'));
  }
}
export function button(label, symbol, action, cls = 'subtle') {
  const b = el('button', undefined, cls);
  b.type = 'button';
  if (label) {
    b.setAttribute('aria-label', label);
    b.title = label;
  }
  if (symbol) b.append(icon(symbol));
  if (label) b.append(el('span', label));
  b.onclick = (e) => {
    e.stopPropagation();
    action();
  };
  return b;
}
// The one copy button: icon and the word "Copy", outlined; `label` says what is copied (for screen
// readers and the tooltip). Put it in a .snippet beside a .code block and it sits above the code.
export function copyButton(label, action) {
  const b = el('button', undefined, 'subtle small-btn copy-btn');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon('copy'), el('span', t('common.copy')));
  b.onclick = (e) => {
    e.stopPropagation();
    action();
  };
  return b;
}
export function iconButton(label, symbol, action) {
  if (symbol === 'copy') return copyButton(label, action);
  const b = button('', symbol, action, 'icon-button');
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}
// `page: true` for a state that is the whole page (centred vertically); `compact` inside a panel.
export function empty(title, message, options = {}) {
  const box = el(
    'div',
    undefined,
    `empty${options.compact ? ' compact' : ''}${options.page ? ' page' : ''}`,
  );
  const badge = el('span', undefined, 'empty-icon');
  badge.append(icon(options.icon || (state.token ? 'inbox' : 'lock-keyhole')));
  box.append(badge, el('strong', title), el('span', message));
  if (options.action) box.append(options.action);
  return box;
}
export function connectPrompt() {
  return empty(t('connect.prompt.title'), t('connect.prompt.text'), {
    icon: 'lock-keyhole',
    page: true,
    action: button(
      t('common.connectWorkspace'),
      'plug',
      () => openDialog('connection-dialog'),
      'primary',
    ),
  });
}
export function panel(title, link) {
  const box = el('section', undefined, 'panel');
  const head = el('div', undefined, 'panel-head');
  head.append(el('h2', title));
  if (link) {
    const a = el('a', link.label, 'link');
    a.href = link.href;
    head.append(a);
  }
  const body = el('div', undefined, 'panel-body');
  box.append(head, body);
  return { box, body };
}
// A table is described by its columns ({ text, align, width, min }): see web/shared/table.js,
// shared with the portal. Wrapped in the console's bordered card.
export function table(columns, rows) {
  const card = el('div', undefined, 'table-card');
  card.append(buildTable(columns, rows));
  return card;
}
export function cell(content, cls) {
  const td = el('td', undefined, cls);
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
  return td;
}
export function clickableRow(id, label, open) {
  const tr = el('tr');
  tr.dataset.id = id;
  tr.tabIndex = 0;
  tr.setAttribute('aria-label', label);
  tr.onclick = open;
  tr.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  return tr;
}
export const dialogTriggers = new WeakMap();
export function openDialog(id) {
  const dlg = $(id);
  if (document.activeElement && document.activeElement !== document.body)
    dialogTriggers.set(dlg, document.activeElement);
  dlg.showModal();
  icons();
  const focusable = dlg.querySelector(
    'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not(.close-dialog):not([disabled])',
  );
  if (focusable) focusable.focus();
}
document
  .querySelectorAll('.close-dialog')
  .forEach((b) => (b.onclick = () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('close', () => {
    const trigger = dialogTriggers.get(d);
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  });
});
// In-page confirmation: WKWebView (the macOS app) has no native confirm() panel.
// The buttons settle the answer directly; the close event only covers Esc.
export let confirmSettle = null;
export function settleConfirm(value) {
  const settle = confirmSettle;
  confirmSettle = null;
  if ($('confirm-dialog').open) $('confirm-dialog').close();
  settle?.(value);
}
export function confirmAction({ title, message, accept = t('common.confirm'), danger = false }) {
  settleConfirm(false);
  const dlg = $('confirm-dialog');
  if (document.activeElement && document.activeElement !== document.body)
    dialogTriggers.set(dlg, document.activeElement);
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  const ok = $('confirm-accept');
  ok.textContent = accept;
  ok.classList.toggle('danger', danger);
  return new Promise((resolve) => {
    confirmSettle = resolve;
    dlg.showModal();
    $('confirm-cancel').focus();
  });
}
$('confirm-form').onsubmit = (e) => {
  e.preventDefault();
  settleConfirm(true);
};
$('confirm-cancel').onclick = () => settleConfirm(false);
$('confirm-dialog').addEventListener('close', () => settleConfirm(false));

export async function withBusy(button, busyText, fn) {
  if (!button) return fn();
  const previousDisabled = button.disabled;
  const previousContent = Array.from(button.childNodes).map((n) => n.cloneNode(true));
  button.disabled = true;
  button.replaceChildren(document.createTextNode(busyText));
  try {
    return await fn();
  } finally {
    button.disabled = previousDisabled;
    button.replaceChildren(...previousContent);
    icons();
  }
}
