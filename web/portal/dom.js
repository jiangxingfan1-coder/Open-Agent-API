import { t } from './i18n.js';

// DOM helpers in the console's style: build nodes, never splice user data into HTML.
export const $ = (id) => document.getElementById(id);
export const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (tag === 'code' || tag === 'pre') n.translate = false;
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
};
// el() plus children, for compact tree building.
export const box = (tag, cls, ...children) => {
  const n = el(tag, undefined, cls);
  n.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return n;
};
export const icon = (name) => {
  const node = document.createElement('i');
  node.dataset.lucide = name;
  return node;
};
// Replace the <i data-lucide> placeholders with lucide's SVG (icons.js defines window.lucide).
export function icons() {
  const lucide = window.lucide;
  if (!lucide?.createElement) return;
  for (const node of document.querySelectorAll('i[data-lucide]')) {
    const name = node.dataset.lucide;
    const def = lucide.icons[name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())];
    if (!def) continue;
    node.replaceWith(
      lucide.createElement(def, {
        class: ['lucide', `lucide-${name}`, ...node.classList].join(' '),
        'aria-hidden': 'true',
      }),
    );
  }
}
export const link = (href, text, cls) => {
  const a = el('a', text, cls);
  a.href = href;
  return a;
};
export function button(label, cls, onClick, symbol) {
  const b = el('button');
  b.type = 'button';
  if (cls) b.className = cls;
  if (symbol) b.append(icon(symbol));
  if (label) b.append(el('span', label));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
// A button that is working: spinner and a short label, disabled. busy(button, false) restores it.
export function busy(btn, on, text) {
  if (on) {
    btn._idle = [...btn.childNodes];
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    btn.replaceChildren(el('span', undefined, 'spinner'), el('span', text ?? t('common.working')));
  } else {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    if (btn._idle) btn.replaceChildren(...btn._idle);
    btn._idle = null;
  }
}
export function toast(message) {
  const n = $('toast');
  n.textContent = message;
  n.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (n.hidden = true), 3200);
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('common.copied'));
  } catch {
    toast(t('common.copy_failed'));
  }
}
export function copyButton(getText, cls = 'quiet small') {
  const b = button(t('common.copy'), cls, () => copyText(getText()), 'copy');
  return b;
}

// Show (or clear, with '') a field's validation message under it.
export function fieldError(input, message) {
  const slot = input.closest('.field')?.querySelector('.field-error');
  if (!slot) return;
  slot.textContent = message;
  slot.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  const ids = (input.getAttribute('aria-describedby') || '')
    .split(' ')
    .filter((x) => x && x !== slot.id);
  if (message) ids.push(slot.id);
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
  else input.removeAttribute('aria-describedby');
}
// Our own validation messages, in the page's language and style (the browser's bubbles are
// neither). Marks every invalid field, focuses the first, returns whether the form may be sent.
export function validateForm(form) {
  let first = null;
  for (const input of form.querySelectorAll('input, textarea, select')) {
    if (input.disabled || input.checkValidity()) continue;
    const v = input.validity;
    const message = v.valueMissing
      ? t('form.required')
      : v.typeMismatch
        ? t('form.email')
        : v.tooShort
          ? t('form.min', { n: input.getAttribute('minlength') })
          : input.validationMessage;
    fieldError(input, message);
    first ??= input;
  }
  first?.focus();
  return !first;
}
// Password input with a quiet eye button that shows or hides what was typed.
function withReveal(input) {
  const wrap = el('div', undefined, 'input-wrap');
  const toggle = button(null, 'quiet small pw-toggle');
  toggle.append(icon('eye'), icon('eye-off'));
  toggle.setAttribute('aria-label', t('common.show_password'));
  toggle.setAttribute('aria-pressed', 'false');
  toggle.addEventListener('click', () => {
    const shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(shown));
    toggle.setAttribute('aria-label', t(shown ? 'common.hide_password' : 'common.show_password'));
  });
  wrap.append(input, toggle);
  return wrap;
}
// A labelled field: <label for> + input (+ hint) + a slot for its validation message.
// A password field gets a show / hide toggle. Returns { field, input }.
export function field(id, label, attrs = {}, hint) {
  const wrap = el('div', undefined, 'field');
  const lab = el('label', label);
  lab.htmlFor = id;
  const input = el('input');
  input.id = id;
  input.name = id;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === true) input.setAttribute(k, '');
    else if (v !== false && v !== undefined) input.setAttribute(k, v);
  }
  wrap.append(lab, attrs.type === 'password' ? withReveal(input) : input);
  if (hint) {
    const small = el('small', hint);
    small.id = `${id}-hint`;
    input.setAttribute('aria-describedby', small.id);
    wrap.append(small);
  }
  const error = el('small', undefined, 'field-error');
  error.id = `${id}-error`;
  error.hidden = true;
  wrap.append(error);
  input.addEventListener('input', () => fieldError(input, ''));
  return { field: wrap, input };
}
// A labelled <select>; `options` is [[value, text], …]. Returns { field, input }.
export function selectField(id, label, options, value) {
  const wrap = el('div', undefined, 'field');
  const lab = el('label', label);
  lab.htmlFor = id;
  const select = el('select');
  select.id = id;
  select.name = id;
  for (const [optionValue, text] of options) {
    const option = el('option', text);
    option.value = optionValue;
    select.append(option);
  }
  if (value !== undefined) select.value = value;
  wrap.append(lab, box('div', 'input-wrap select-wrap', select, icon('chevron-down')));
  return { field: wrap, input: select };
}
// A labelled <textarea>. Returns { field, input }.
export function textareaField(id, label, attrs = {}) {
  const wrap = el('div', undefined, 'field');
  const lab = el('label', label);
  lab.htmlFor = id;
  const area = el('textarea');
  area.id = id;
  area.name = id;
  for (const [k, v] of Object.entries(attrs))
    if (v !== false && v !== undefined) area.setAttribute(k, v);
  wrap.append(lab, area);
  const error = el('small', undefined, 'field-error');
  error.id = `${id}-error`;
  error.hidden = true;
  wrap.append(error);
  area.addEventListener('input', () => fieldError(area, ''));
  return { field: wrap, input: area };
}
export const notice = (text, tone = '') => {
  const n = el('div', text, `notice ${tone}`.trim());
  if (tone === 'error' || tone === 'warn') n.setAttribute('role', 'alert');
  return n;
};
export const empty = (title, message) =>
  box('div', 'empty', title ? el('strong', title) : null, message ? el('span', message) : null);
export const loading = () => el('div', t('common.loading'), 'loading');
export const sectionHead = (title, aside) =>
  box('div', 'section-head', el('h2', title), aside ? aside : null);
export const pageWrap = (root, ...children) => {
  const page = box('div', 'wrap page', ...children);
  root.replaceChildren(page);
  return page;
};
