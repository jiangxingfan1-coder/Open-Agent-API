import { portal } from './api.js';
import { errorMessage, t } from './i18n.js';
import {
  box,
  busy,
  button,
  el,
  empty,
  field,
  icons,
  link,
  loading,
  notice,
  pageWrap,
  sectionHead,
  validateForm,
} from './dom.js';
import { integer, points, signedPoints } from './format.js';
import { emit, state } from './state.js';
import { runHref, timeCell } from './runs.js';
import { stackedTable } from './stack.js';

const PAGE_SIZE = 20;

function entryNote(entry) {
  if (entry.kind === 'run') {
    const parts = [entry.agent || t('ledger.run_unknown')];
    if (entry.tokens) parts.push(t('ledger.tokens', { n: integer(entry.tokens) }));
    return parts.join(' · ');
  }
  if (entry.kind === 'redeem')
    return t(/^invite\b/.test(entry.note ?? '') ? 'ledger.note.invite' : 'ledger.note.code');
  if (entry.kind === 'grant') {
    const key = { signup: 'ledger.note.signup', operator: 'ledger.note.operator' }[entry.note];
    return t(key ?? 'ledger.note.grant');
  }
  // Only an operator adjustment carries free text written by a person.
  return entry.note || t('ledger.note.adjust');
}

function entryStatus(entry) {
  if (entry.kind !== 'run' || !entry.status) return null;
  const key = `run.${entry.status}`;
  return t(key) === key ? entry.status : t(key);
}

function ledgerTable(entries) {
  if (!entries.length) return empty(t('ledger.empty.title'), t('ledger.empty.text'));
  const trs = entries.map((e) => {
    const detail = el('td');
    // A run line opens that run's page (the run itself may have been cleaned up; the page copes).
    if (e.kind === 'run' && e.run_id)
      detail.append(link(runHref(e.run_id), entryNote(e), 'row-link'));
    else detail.append(document.createTextNode(entryNote(e)));
    const status = entryStatus(e);
    if (status) detail.append(el('span', status, 'sub'));
    const kind = t(`ledger.kind.${e.kind}`);
    const tr = el('tr');
    tr.append(
      timeCell(e.created_at),
      el('td', kind === `ledger.kind.${e.kind}` ? e.kind : kind, 'nowrap'),
      detail,
      // A task still running has not been charged yet: no figure rather than a "0".
      el('td', e.kind === 'run' && e.status === 'in_progress' ? '—' : signedPoints(e.amount)),
      el('td', points(e.balance_after)),
    );
    return tr;
  });
  return stackedTable(
    'ledger',
    [
      { text: t('ledger.col.time'), width: 160 },
      { text: t('ledger.col.kind'), width: 110 },
      { text: t('ledger.col.detail'), min: 200 },
      { text: t('ledger.col.amount'), align: 'num', width: 120 },
      { text: t('ledger.col.balance'), align: 'num', width: 120 },
    ],
    trs,
  );
}

function redeemForm(onRedeemed) {
  const code = field('redeem-code', t('billing.code'), {
    type: 'text',
    required: true,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: t('billing.code_ph'),
  });
  const submit = button(t('billing.redeem'), 'primary');
  submit.type = 'submit';
  const message = el('div');
  message.setAttribute('aria-live', 'polite');
  const form = el('form', undefined, 'form-row');
  form.noValidate = true;
  form.append(code.field, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.replaceChildren();
    if (!validateForm(form)) return;
    busy(submit, true);
    try {
      const result = await portal.redeem(code.input.value.trim());
      state.account = result.account;
      emit('portal:auth');
      code.input.value = '';
      message.replaceChildren(
        notice(
          t('billing.redeemed', {
            n: points(result.credited),
            balance: points(result.account.balance),
          }),
          'ok',
        ),
      );
      onRedeemed();
    } catch (err) {
      message.replaceChildren(notice(errorMessage(err), 'error'));
    }
    busy(submit, false);
  });
  return box('div', 'redeem section-body', form, message);
}

export async function billing(root) {
  const page = pageWrap(root, loading());
  const account = (await portal.account()).account;
  state.account = account;
  emit('portal:auth');

  // Cursor paging: `cursors[i]` is the cursor that opens page i.
  const cursors = [undefined];
  let index = 0;
  const ledger = el('div', undefined, 'section-body');
  const balance = el('span', undefined, 'muted');
  const showBalance = () =>
    (balance.textContent = t('billing.balance', { n: points(state.account.balance) }));

  async function load() {
    ledger.replaceChildren(loading());
    try {
      const result = await portal.ledger(PAGE_SIZE, cursors[index]);
      const next = result.next_cursor ?? null;
      const prev = button(t('common.prev'), 'small', () => {
        index -= 1;
        load();
      });
      prev.disabled = index === 0;
      const forward = button(t('common.next'), 'small', () => {
        cursors[index + 1] = next;
        index += 1;
        load();
      });
      forward.disabled = !next;
      ledger.replaceChildren(
        ledgerTable(result.data ?? []),
        box(
          'div',
          'pager',
          el('span', t('common.page', { n: index + 1 })),
          box('div', 'actions', prev, forward),
        ),
      );
    } catch (err) {
      ledger.replaceChildren(notice(errorMessage(err), 'error'));
    }
    icons();
  }

  page.replaceChildren(
    box('div', 'page-head', el('h1', t('billing.title')), el('p', t('billing.lede'))),
    box(
      'section',
      '',
      sectionHead(t('billing.redeem_title'), balance),
      redeemForm(() => {
        showBalance();
        index = 0;
        cursors.length = 1;
        load();
      }),
    ),
    box('section', '', sectionHead(t('billing.ledger')), ledger),
  );
  showBalance();
  await load();
}
