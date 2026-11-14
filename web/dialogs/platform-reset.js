import { confirmAction, el, icon, toast } from '../lib/dom.js';
import { snippetBlock } from './snippet.js';
import { api } from '../lib/api.js';
import { formatDateTime } from '../shared/format.js';
import { encode } from './platform-data.js';
import { lang, t } from '../lib/i18n.js';
import {
  KEEP_OPEN,
  checkPassword,
  formDialog,
  passwordField,
  segmented,
} from './platform-dialog.js';

/* ── Reset password: two approaches ───────────────────────────
   One-time reset code (recommended): the developer sets a new password on the portal login page, so
   the operator never learns it. Set a password directly: the operator sets it and has to tell the
   developer. See docs/platform.md ("Forgot password") for the contract. */
const CODE_NOTE = t('dlg.reset.code_note');
const PASSWORD_NOTE = t('dlg.reset.password_note');
const expiryText = (ms) => formatDateTime(ms, lang);

export function openResetPasswordDialog(account) {
  const way = segmented(
    t('dlg.reset.way_label'),
    [
      ['code', t('dlg.reset.way_code')],
      ['password', t('dlg.reset.way_password')],
    ],
    'code',
    () => sync(),
  );
  const password = passwordField(t('dlg.reset.new_password'));
  const note = el('p', undefined, 'muted');
  const { ctx, open } = formDialog({
    title: t('dlg.reset.title'),
    desc: t('dlg.reset.desc', { email: account.email }),
    submit: t('dlg.reset.make_code'),
    symbol: 'key-round',
    busy: t('dlg.reset.working'),
    async onSubmit(dialog) {
      if (way.get() === 'code') return generate(dialog, account);
      const next = checkPassword(password.input.value, t('dlg.reset.new_password'));
      const ok = await confirmAction({
        title: t('dlg.reset.confirm_title', { email: account.email }),
        message: t('dlg.reset.confirm_message'),
        accept: t('dlg.reset.confirm_accept'),
        danger: true,
      });
      if (!ok) return KEEP_OPEN;
      await api('POST', `/v1/platform/accounts/${encode(account.id)}/password`, {
        new_password: next,
      });
      toast(t('dlg.reset.done_toast', { email: account.email }));
    },
  });
  const submitLabel = ctx.dlg.querySelector('button[type=submit] span');
  function sync() {
    const byCode = way.get() === 'code';
    note.textContent = byCode ? CODE_NOTE : PASSWORD_NOTE;
    password.box.hidden = byCode;
    submitLabel.textContent = byCode ? t('dlg.reset.make_code') : t('dlg.reset.confirm_accept');
    ctx.fail('');
  }
  const pick = el('div', undefined, 'field');
  const group = el('div');
  group.append(way.box);
  pick.append(group);
  ctx.body.append(pick, note, password.box);
  sync();
  open();
  ctx.dlg.querySelector('button[type=submit]').focus(); // Enter means "Generate reset code"; keep the focus ring off the approach switch
}

async function generate(ctx, account) {
  const ok = await confirmAction({
    title: t('dlg.reset.gen_title', { email: account.email }),
    message: t('dlg.reset.gen_message'),
    accept: t('dlg.reset.make_code'),
    danger: true,
  });
  if (!ok) return KEEP_OPEN;
  const result = await api('POST', `/v1/platform/accounts/${encode(account.id)}/reset-code`);
  showResetCode(ctx, account, result);
  toast(t('dlg.reset.gen_toast'));
  return KEEP_OPEN;
}

// Result page: the plaintext is shown only once and can be copied; the copy on the page is wiped when
// the dialog closes (same approach as the redeem code result page).
function showResetCode(ctx, account, { code, expires_at: expiresAt }) {
  // The subtitle used to say "pick an approach"; the result page has no choice left, so it now says something that fits.
  const desc = ctx.dlg.querySelector('.dialog-desc');
  if (desc) desc.textContent = t('dlg.reset.result_desc');
  const head = el('div', undefined, 'key-success');
  const mark = el('span', undefined, 'key-success-icon');
  mark.append(icon('circle-check'));
  const words = el('div');
  words.append(
    el('strong', t('dlg.reset.result_title', { email: account.email })),
    el('p', t('dlg.reset.result_once')),
  );
  head.append(mark, words);
  const snippet = snippetBlock(t('dlg.reset.snippet_title'), code, t('dlg.reset.copied'));
  const pre = snippet.querySelector('pre');
  const expiry = el('p', undefined, 'muted');
  expiry.textContent = t('dlg.reset.expiry', { time: expiryText(expiresAt) });
  const how = el('p', t('dlg.reset.how'), 'muted');
  const notes = el('div', undefined, 'prose');
  notes.append(expiry, how);
  ctx.setBody(head, snippet, notes);
  ctx.finish(t('dlg.form.done'));
  ctx.dlg.addEventListener('close', () => {
    pre.textContent = '';
  });
}
