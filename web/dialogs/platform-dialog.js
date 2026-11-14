import { button, el, icon, iconButton, icons, openDialog, withBusy } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

/* ── Dialog shell for the developer platform ──────────────
   index.html only has the console's own few dialogs; the platform page's dialogs are created here
   on demand, with the same structure and class names as in index.html
   (dialog.modal > form > dialog-heading / dialog-actions). */
export const KEEP_OPEN = Symbol('keep-open');
let sequence = 0;

export function field(label, control, hint) {
  const box = el('label', undefined, 'field');
  box.append(el('span', label), control);
  if (hint) box.append(el('small', hint));
  return box;
}
export function textInput({ value = '', type = 'text', placeholder, max, required, mono } = {}) {
  const input = el('input');
  input.type = type;
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  if (max) input.maxLength = max;
  if (required) input.required = true;
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (mono) input.translate = false;
  return input;
}
export function numberInput({ value = '', min = 0, step = 'any', placeholder } = {}) {
  const input = textInput({ value: String(value), type: 'number', placeholder });
  input.min = String(min);
  input.step = String(step);
  input.inputMode = 'decimal';
  return input;
}
export function selectInput(options, value) {
  const select = el('select');
  for (const [v, label] of options) {
    const o = el('option', label);
    o.value = String(v);
    select.append(o);
  }
  if (value !== undefined) select.value = String(value);
  return select;
}
export function checkRow(label, checked) {
  const row = el('label', undefined, 'inline-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  row.append(input, el('span', label));
  return { row, input };
}
// A choice of two (for example "Add / Deduct" or "Credit code / Invite code"): reuses the .segmented button group.
export function segmented(label, choices, value, onChange) {
  const box = el('div', undefined, 'segmented small');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', label);
  let current = value;
  const sync = () => {
    for (const b of box.children) {
      const active = b.dataset.value === current;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    }
  };
  for (const [v, text] of choices) {
    const b = el('button', text);
    b.type = 'button';
    b.dataset.value = v;
    b.onclick = () => {
      current = v;
      sync();
      onChange?.(v);
    };
    box.append(b);
  }
  sync();
  return { box, get: () => current };
}
// Password: used when the operator sets an initial password or resets one. "Generate" fills in a
// random password and shows it, so it is easy to copy to the developer.
export function passwordField(label = t('dlg.form.password'), hint = t('dlg.form.password_hint')) {
  const box = el('div', undefined, 'field');
  const row = el('div', undefined, 'model-custom');
  const input = textInput({ type: 'password', mono: true });
  input.autocomplete = 'new-password';
  input.setAttribute('aria-label', label);
  const make = button(
    t('dlg.form.generate'),
    'dices',
    () => {
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      input.value = btoa(String.fromCharCode(...bytes))
        .replace(/[+/=]/g, '')
        .slice(0, 16);
      input.type = 'text';
      input.focus();
      input.select();
    },
    'subtle small-btn',
  );
  make.title = t('dlg.form.generate_title');
  row.append(input, make);
  box.append(el('span', label), row, el('small', hint));
  return { box, input };
}
export function checkPassword(value, label = t('dlg.form.password')) {
  if (value.length < 8 || value.length > 200)
    throw Error(t('dlg.form.err.password_length', { label }));
  return value;
}

// An error thrown by onSubmit(ctx) shows at the bottom of the dialog; a normal return closes the
// dialog, and returning KEEP_OPEN keeps it open (for example to switch to a "result" page).
// ctx.setBody replaces the form content, ctx.finish swaps in an action bar with just "Done".
export function formDialog({
  title,
  desc,
  wide = false,
  submit,
  symbol = 'check',
  busy,
  onSubmit,
}) {
  const id = `platform-dialog-${++sequence}`;
  const dlg = el('dialog', undefined, `modal${wide ? ' wide-modal' : ''}`);
  dlg.id = id;
  const form = el('form');
  form.noValidate = true;
  const heading = el('div', undefined, 'dialog-heading');
  const text = el('div');
  const h2 = el('h2', title);
  h2.id = `${id}-title`;
  dlg.setAttribute('aria-labelledby', h2.id);
  text.append(h2);
  if (desc) text.append(el('p', desc, 'dialog-desc'));
  const close = iconButton(t('dlg.form.close'), 'x', () => dlg.close());
  close.classList.add('close-dialog'); // Do not focus the close button on open (see openDialog)
  heading.append(text, close);
  const body = el('div');
  const actions = el('div', undefined, 'dialog-actions');
  const failure = el('span', undefined, 'form-error');
  failure.setAttribute('role', 'alert');
  // A dialog without submit is view-only (such as the ledger); ctx.finish swaps its action bar for "Close".
  const go = el('button', undefined, 'primary');
  go.type = 'submit';
  go.append(icon(symbol), el('span', submit ?? ''));
  actions.append(failure);
  if (submit)
    actions.append(
      button(t('dlg.form.cancel'), '', () => dlg.close(), 'subtle'),
      go,
    );
  form.append(heading, body, actions);
  dlg.append(form);
  const fail = (message) => {
    failure.textContent = message;
  };
  const ctx = {
    dlg,
    body,
    fail,
    close: () => dlg.close(),
    setBody(...nodes) {
      body.replaceChildren(...nodes);
      icons();
    },
    finish(label = t('dlg.form.done')) {
      actions.replaceChildren(button(label, '', () => dlg.close(), 'primary'));
    },
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    fail('');
    await withBusy(go, busy ?? t('dlg.form.submitting'), async () => {
      try {
        if ((await onSubmit(ctx)) !== KEEP_OPEN) dlg.close();
      } catch (err) {
        fail(err.message);
      }
    });
  };
  const opener = document.activeElement;
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
  });
  document.body.append(dlg);
  return { ctx, open: () => openDialog(id) };
}
