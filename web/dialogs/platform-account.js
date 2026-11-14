import { STATUS, num } from '../lib/format.js';
import { button, cell, confirmAction, el, empty, table, toast } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { lang, t } from '../lib/i18n.js';
import { formatDateTime } from '../shared/format.js';
import {
  creditsText,
  encode,
  parsePoints,
  pts,
  refreshPlatform,
  signedCreditsText,
  signedPts,
} from './platform-data.js';
import {
  KEEP_OPEN,
  checkPassword,
  field,
  formDialog,
  numberInput,
  passwordField,
  segmented,
  textInput,
} from './platform-dialog.js';

/* ── Developer accounts: create, adjust balance, disable / enable, ledger (password reset is in platform-reset.js) ── */
export function openCreateAccountDialog() {
  const email = textInput({ type: 'email', max: 200, placeholder: 'name@example.com' });
  const name = textInput({ max: 100, placeholder: t('dlg.account.optional') });
  const password = passwordField(t('dlg.account.initial_password'));
  const credits = numberInput({ value: 0 });
  const { ctx, open } = formDialog({
    title: t('dlg.account.create_title'),
    desc: t('dlg.account.create_desc'),
    submit: t('dlg.account.create_submit'),
    symbol: 'user-plus',
    busy: t('dlg.account.creating'),
    async onSubmit() {
      const address = email.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(address)) throw Error(t('dlg.account.err.email'));
      const body = {
        email: address,
        password: checkPassword(password.input.value, t('dlg.account.initial_password')),
      };
      if (name.value.trim()) body.name = name.value.trim();
      const start = parsePoints(credits.value, t('dlg.account.initial_credits'));
      if (start) body.credits = start;
      await api('POST', '/v1/platform/accounts', body);
      toast(t('dlg.account.created', { email: address }));
      await refreshPlatform();
    },
  });
  ctx.body.append(
    field(t('dlg.account.email'), email, t('dlg.account.email_hint')),
    field(t('dlg.account.name'), name),
    password.box,
    field(t('dlg.account.initial_credits'), credits, t('dlg.account.initial_credits_hint')),
  );
  open();
}

export function openCreditDialog(account) {
  const direction = segmented(
    t('dlg.account.direction_label'),
    [
      ['add', t('dlg.account.add')],
      ['sub', t('dlg.account.deduct')],
    ],
    'add',
    () => preview(),
  );
  const amount = numberInput({ min: 0, placeholder: '0' });
  const note = textInput({ max: 200, placeholder: t('dlg.account.note_ph') });
  const reference = textInput({
    max: 200,
    placeholder: t('dlg.account.reference_ph'),
    mono: true,
  });
  const result = el('small');
  const signed = () => {
    const n = parsePoints(amount.value, t('dlg.account.credits')) ?? 0;
    return direction.get() === 'sub' ? -n : n;
  };
  function preview() {
    try {
      const next = Number(account.balance || 0) + signed();
      result.textContent = t('dlg.account.after', { credits: creditsText(next) });
      result.className = next < 0 ? 'text-attention' : '';
    } catch {
      result.textContent = '';
    }
  }
  amount.oninput = preview;
  preview();
  const { ctx, open } = formDialog({
    title: t('dlg.account.adjust_title'),
    desc: t('dlg.account.adjust_desc', {
      email: account.email,
      credits: creditsText(account.balance),
    }),
    submit: t('dlg.account.adjust_submit'),
    symbol: 'coins',
    busy: t('dlg.account.adjusting'),
    async onSubmit() {
      const delta = signed();
      if (!delta) throw Error(t('dlg.account.err.no_credits'));
      if (Number(account.balance || 0) + delta < 0) throw Error(t('dlg.account.err.below_zero'));
      if (!note.value.trim()) throw Error(t('dlg.account.err.no_note'));
      const body = { amount: delta, note: note.value.trim() };
      if (reference.value.trim()) body.reference = reference.value.trim();
      const done = await api('POST', `/v1/platform/accounts/${encode(account.id)}/credit`, body);
      if (done?.duplicate) {
        // One external reference is credited only once: nothing was added or deducted, and the dialog
        // stays open so the operator can check the reference.
        ctx.fail(t('dlg.account.duplicate'));
        return KEEP_OPEN;
      }
      toast(t('dlg.account.adjusted', { email: account.email, delta: signedCreditsText(delta) }));
      await refreshPlatform();
    },
  });
  const grid = el('div', undefined, 'form-grid');
  const side = el('div', undefined, 'field');
  const pick = el('div');
  pick.append(direction.box);
  side.append(el('span', t('dlg.account.direction')), pick);
  grid.append(side, field(t('dlg.account.credits'), amount));
  ctx.body.append(
    grid,
    field(t('dlg.account.note'), note, t('dlg.account.note_hint')),
    field(t('dlg.account.reference'), reference, t('dlg.account.reference_hint')),
    result,
  );
  open();
  amount.focus();
}

export async function toggleAccount(account) {
  const disabling = account.status !== 'disabled';
  if (
    disabling &&
    !(await confirmAction({
      title: t('dlg.account.disable_title', { email: account.email }),
      message: t('dlg.account.disable_message'),
      accept: t('dlg.account.disable_accept'),
      danger: true,
    }))
  )
    return;
  try {
    await api('POST', `/v1/platform/accounts/${encode(account.id)}/status`, {
      status: disabling ? 'disabled' : 'active',
    });
    toast(t(disabling ? 'dlg.account.disabled' : 'dlg.account.enabled', { email: account.email }));
    await refreshPlatform();
  } catch (e) {
    toast(e.message);
  }
}

/* ── Ledger ──────────────────────────────────────────────── */
const LEDGER_KIND = {
  run: t('dlg.account.kind.run'),
  redeem: t('dlg.account.kind.redeem'),
  grant: t('dlg.account.kind.grant'),
  adjust: t('dlg.account.kind.adjust'),
};
const ledgerDetail = (e) =>
  [
    e.agent,
    e.tokens ? t('dlg.plat.tokens', { n: num(e.tokens) }) : null,
    e.status ? (STATUS[e.status]?.[0] ?? e.status) : null,
    e.note,
  ]
    .filter(Boolean)
    .join(' · ');
// Details column: text on top, the external reference (if any) below in small type.
function ledgerNote(e) {
  const text = ledgerDetail(e);
  if (!e.reference) return text || '—';
  const box = el('div');
  if (text) box.append(el('div', text));
  // An external reference is one long identifier: one line, the full value on hover.
  const ref = el('div', t('dlg.account.reference_line', { ref: e.reference }), 'row-sub');
  ref.title = e.reference;
  ref.translate = false;
  box.append(ref);
  return box;
}

export function openLedgerDialog(account) {
  const { ctx, open } = formDialog({
    title: t('dlg.account.ledger_title'),
    desc: t('dlg.account.ledger_desc', {
      email: account.email,
      credits: creditsText(account.balance),
    }),
    wide: true,
    async onSubmit() {},
  });
  ctx.finish(t('dlg.account.close'));
  const view = { entries: null, cursor: null, busy: false, failure: '' };
  const draw = () => {
    const nodes = [];
    if (view.failure) nodes.push(el('p', view.failure, 'form-error'));
    if (!view.entries) {
      if (!view.failure)
        nodes.push(
          empty(t('dlg.account.ledger_loading'), t('dlg.account.please_wait'), {
            icon: 'receipt-text',
            compact: true,
          }),
        );
    } else if (!view.entries.length) {
      nodes.push(
        empty(t('dlg.account.ledger_empty'), t('dlg.account.ledger_empty_hint'), {
          icon: 'receipt-text',
          compact: true,
        }),
      );
    } else {
      nodes.push(
        table(
          [
            { text: t('dlg.account.col.time'), width: 116 },
            { text: t('dlg.account.col.type'), width: 100 },
            { text: t('dlg.account.col.credits'), align: 'num', width: 116 },
            { text: t('dlg.account.col.balance'), align: 'num', width: 116 },
            { text: t('dlg.account.col.note'), min: 200 },
          ],
          view.entries.map((e) => {
            const tr = el('tr');
            tr.append(
              cell(formatDateTime(e.created_at, lang), 'nowrap'),
              cell(LEDGER_KIND[e.kind] ?? e.kind),
              cell(signedPts(e.amount), 'num'),
              cell(pts(e.balance_after), 'num'),
              cell(ledgerNote(e)),
            );
            return tr;
          }),
        ),
      );
    }
    if (view.failure)
      nodes.push(button(t('dlg.account.retry'), 'refresh-cw', () => more(), 'subtle block-btn'));
    else if (view.cursor) {
      // Same pattern as "Load more" under tables: how many are shown, plus a text button.
      const row = el('div', undefined, 'table-more');
      const next = el('button', view.busy ? t('dlg.account.loading') : t('dlg.account.load_more'));
      next.type = 'button';
      next.disabled = view.busy;
      next.onclick = () => more();
      row.append(el('span', t('dlg.account.shown', { n: view.entries?.length ?? 0 })), next);
      nodes.push(row);
    }
    ctx.setBody(...nodes);
  };
  async function more() {
    if (view.busy) return;
    view.busy = true;
    view.failure = '';
    draw();
    try {
      const page = await api(
        'GET',
        `/v1/platform/accounts/${encode(account.id)}/ledger?limit=50${view.cursor ? `&cursor=${encode(view.cursor)}` : ''}`,
      );
      view.entries = [...(view.entries ?? []), ...(page.data ?? [])];
      view.cursor = page.next_cursor ?? null;
    } catch (e) {
      view.failure = e.message;
      view.entries ??= null;
    }
    view.busy = false;
    draw();
  }
  draw();
  open();
  void more();
}
