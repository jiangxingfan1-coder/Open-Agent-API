import { t } from '../lib/i18n.js';
import { formatWhen, num } from '../lib/format.js';
import { agentGlyph, button, cell, confirmAction, el, empty, table, toast } from '../lib/dom.js';
import { agentById } from './common.js';
import { badge, day, loadMoreAccounts, platform, pts } from '../dialogs/platform-data.js';
import {
  openListingDialog,
  removeListing,
  setListingEnabled,
} from '../dialogs/platform-listing.js';
import {
  openCreateAccountDialog,
  openCreditDialog,
  openLedgerDialog,
  toggleAccount,
} from '../dialogs/platform-account.js';
import { openResetPasswordDialog } from '../dialogs/platform-reset.js';
import { CODE_KIND, openCodeDialog, revokeCode } from '../dialogs/platform-code.js';
import { rowMenu } from '../dialogs/platform-menu.js';

/* ── The three main developer platform tables: listings and pricing, developers, redeem codes ──
   One table per tab, with no sideways scrolling at 1024 wide: secondary information goes on a
   second line under the name, one primary action stays in the row, and the rest fold into a
   "More" menu. */

// When an action fails, only tell the user; never let the page crash.
export const attempt = (run) => async () => {
  try {
    await run();
  } catch (e) {
    toast(e.message);
  }
};
// The line at the top of a tab: a sentence on the left, this page's primary action on the right.
export function tabHead(description, ...actions) {
  const head = el('div', undefined, 'tab-head');
  head.append(el('p', description, 'muted'));
  if (actions.length) {
    const box = el('div', undefined, 'tab-head-actions');
    box.append(...actions);
    head.append(box);
  }
  return head;
}
const subLine = (text) => {
  const line = el('div', text, 'node-detail cell-sub');
  line.title = text;
  return line;
};

/* ── Listings and pricing ───────────────────────────────── */
export function renderListings(body, filter) {
  body.append(
    tabHead(
      t('platform.listingsHint'),
      button(t('platform.listAgent'), 'plus', () => openListingDialog(), 'primary'),
    ),
  );
  const all = platform.listings ?? [];
  const rows = all.filter((l) =>
    `${l.agent_id} ${l.title} ${l.summary ?? ''} ${(l.tags ?? []).join(' ')}`
      .toLowerCase()
      .includes(filter),
  );
  if (!rows.length) {
    body.append(
      all.length
        ? empty(t('platform.noListingMatch'), t('common.tryKeyword'), {
            icon: 'search',
            compact: true,
          })
        : empty(t('platform.noListings'), t('platform.noListingsHint'), {
            icon: 'store',
            compact: true,
          }),
    );
    return;
  }
  body.append(
    table(
      [
        { text: t('platform.colAgent'), min: 190 },
        { text: t('platform.colPerTask'), align: 'num', width: 84 },
        { text: t('platform.colPer1k'), align: 'num', width: 104 },
        { text: t('platform.colStatus'), width: 140 },
        { text: '', align: 'actions', width: 132 },
      ],
      rows.map((l) => {
        const tr = el('tr');
        const agent = agentById(l.agent_id);
        const title = el('div', undefined, 'cell-title');
        const text = el('div');
        const name = el('div', l.title || l.agent_id, 'row-title');
        name.title = l.title || l.agent_id;
        const tags = (l.tags ?? []).length ? ` · ${l.tags.join(' / ')}` : '';
        const id = subLine(`${l.agent_id}${tags}`);
        id.translate = false;
        text.append(name, id);
        title.append(agentGlyph(agent?.engine ?? l.agent_id, 'small', agent?.preset), text);
        const actions = el('div', undefined, 'row-action');
        const live = l.enabled && l.agent_exists !== false;
        actions.append(
          button(t('platform.edit'), '', () => openListingDialog(l), 'subtle small-btn'),
          rowMenu(t('platform.moreActions', { name: l.agent_id }), [
            l.enabled
              ? {
                  label: t('platform.unlist'),
                  icon: 'eye-off',
                  run: attempt(async () => {
                    if (
                      !(await confirmAction({
                        title: t('platform.unlistTitle', { id: l.agent_id }),
                        message: t('platform.unlistMessage'),
                        accept: t('platform.unlist'),
                        danger: true,
                      }))
                    )
                      return;
                    await setListingEnabled(l, false);
                  }),
                }
              : {
                  label: t('platform.relist'),
                  icon: 'eye',
                  run: attempt(() => setListingEnabled(l, true)),
                },
            {
              label: t('platform.removeListing'),
              icon: 'trash-2',
              danger: true,
              run: attempt(async () => {
                if (
                  !(await confirmAction({
                    title: t('platform.removeTitle', { id: l.agent_id }),
                    message: t('platform.removeMessage'),
                    accept: t('platform.remove'),
                    danger: true,
                  }))
                )
                  return;
                await removeListing(l);
              }),
            },
          ]),
        );
        actions.firstElementChild.setAttribute(
          'aria-label',
          t('platform.editListing', { id: l.agent_id }),
        );
        tr.append(
          cell(title),
          cell(pts(l.price?.per_run), 'num'),
          cell(pts(l.price?.per_1k_tokens), 'num'),
          // A removed agent is not something waiting on a person, so it is neutral; it just can no
          // longer be called.
          cell(
            l.agent_exists === false
              ? badge(t('platform.agentRemoved'), 'neutral')
              : live
                ? badge(t('platform.listed'), 'good')
                : badge(t('platform.unlisted'), 'neutral'),
          ),
          cell(actions),
        );
        return tr;
      }),
    ),
  );
}

/* ── Developers ──────────────────────────────────────────── */
export function renderAccounts(body) {
  body.append(
    tabHead(
      t('platform.accountsHint'),
      button(t('platform.newAccount'), 'user-plus', openCreateAccountDialog, 'primary'),
    ),
  );
  const rows = platform.accounts ?? [];
  if (!rows.length) {
    body.append(
      platform.query
        ? empty(t('platform.noAccountMatch'), t('platform.noAccountMatchHint'), {
            icon: 'search',
            compact: true,
          })
        : empty(t('platform.noAccounts'), t('platform.noAccountsHint'), {
            icon: 'users',
            compact: true,
          }),
    );
    return;
  }
  body.append(
    table(
      [
        { text: t('platform.colDeveloper'), min: 190 },
        { text: t('platform.colBalance'), align: 'num', width: 120 },
        { text: t('platform.colSpent'), align: 'num', width: 116 },
        { text: t('platform.colActive'), width: 124 },
        { text: '', align: 'actions', width: 132 },
      ],
      rows.map((a) => {
        const tr = el('tr');
        const disabled = a.status === 'disabled';
        const who = el('div');
        const mail = el('div', a.email, 'row-title');
        mail.translate = false;
        mail.title = a.email;
        const detail = subLine(
          [a.name, t('platform.keysCount', { n: num(a.keys) })].filter(Boolean).join(' · '),
        );
        if (disabled) {
          // A disabled account gets a neutral mark before its name; a normal account gets nothing.
          const line = el('div', undefined, 'cell-line');
          line.append(badge(t('platform.accountDisabled'), 'neutral'), detail);
          who.append(mail, line);
        } else who.append(mail, detail);
        const spent = el('div', undefined, 'cell-stack');
        spent.append(
          el('span', pts(a.spent)),
          el('span', t('platform.runsCount', { n: num(a.runs) }), 'node-detail'),
        );
        const balance = el('span', pts(a.balance));
        // An enabled account with a zero (or overdrawn) balance cannot call paid agents: the
        // operator should take a look.
        if (!disabled && Number(a.balance) <= 0) balance.className = 'balance-empty';
        const actions = el('div', undefined, 'row-action');
        actions.append(
          button(t('platform.adjustBalance'), '', () => openCreditDialog(a), 'subtle small-btn'),
          rowMenu(t('platform.moreActions', { name: a.email }), [
            {
              label: t('platform.viewLedger'),
              icon: 'receipt-text',
              run: () => openLedgerDialog(a),
            },
            {
              label: t('platform.resetPassword'),
              icon: 'key-round',
              run: () => openResetPasswordDialog(a),
            },
            disabled
              ? {
                  label: t('platform.enableAccount'),
                  icon: 'user-check',
                  run: () => toggleAccount(a),
                }
              : {
                  label: t('platform.disableAccount'),
                  icon: 'user-x',
                  danger: true,
                  run: () => toggleAccount(a),
                },
          ]),
        );
        actions.firstElementChild.setAttribute(
          'aria-label',
          t('platform.adjustFor', { email: a.email }),
        );
        tr.append(
          cell(who),
          cell(balance, 'num'),
          cell(spent, 'num'),
          cell(a.last_active_at ? formatWhen(a.last_active_at) : '—', 'nowrap'),
          cell(actions),
        );
        tr.id = `account-${a.id}`;
        return tr;
      }),
    ),
  );
  if (platform.cursor) body.append(moreRow(rows.length));
}
// The row under the table: how many are shown and a restrained text button; the button greys
// out while reading.
function moreRow(shown) {
  const row = el('div', undefined, 'table-more');
  const more = el('button', t('platform.loadMore'));
  more.type = 'button';
  more.onclick = async () => {
    more.disabled = true;
    more.textContent = t('platform.loading');
    try {
      await loadMoreAccounts();
    } catch (e) {
      more.disabled = false;
      more.textContent = t('platform.loadMore');
      toast(e.message);
    }
  };
  row.append(el('span', t('platform.shown', { n: num(shown) })), more);
  return row;
}

/* ── Redeem codes ───────────────────────────────────────── */
function codeState(c) {
  if (c.revoked) return [t('platform.codeRevoked'), 'neutral'];
  if (c.max_uses && c.used >= c.max_uses) return [t('platform.codeUsedUp'), 'neutral'];
  if (c.expires_at && c.expires_at <= Date.now()) return [t('status.expired'), 'neutral'];
  return [t('platform.codeValid'), 'good'];
}
export function renderCodes(body, filter) {
  body.append(
    tabHead(
      t('platform.codesHint'),
      button(t('platform.createCode'), 'ticket', openCodeDialog, 'primary'),
    ),
  );
  const all = platform.codes ?? [];
  const rows = all.filter((c) =>
    `${c.note ?? ''} ${c.id} ${CODE_KIND[c.kind] ?? c.kind}`.toLowerCase().includes(filter),
  );
  if (!rows.length) {
    body.append(
      all.length
        ? empty(t('platform.noCodeMatch'), t('platform.noCodeMatchHint'), {
            icon: 'search',
            compact: true,
          })
        : empty(t('platform.noCodes'), t('platform.noCodesHint'), {
            icon: 'ticket',
            compact: true,
          }),
    );
    return;
  }
  body.append(
    table(
      [
        { text: t('platform.colType'), width: 108 },
        { text: t('platform.colUsed'), align: 'num', width: 108 },
        { text: t('platform.colExpires'), width: 116 },
        { text: t('platform.colNote'), min: 170 },
        { text: t('platform.colStatus'), width: 96 },
        { text: '', align: 'actions', width: 88 },
      ],
      rows.map((c) => {
        const tr = el('tr');
        const [label, tone] = codeState(c);
        const kind = el('div');
        kind.append(
          el('div', CODE_KIND[c.kind] ?? c.kind, 'row-title'),
          el(
            'div',
            c.kind === 'credit' && c.credits ? t('platform.credits', { n: pts(c.credits) }) : '—',
            'node-detail',
          ),
        );
        const note = el('div');
        const name = el('div', c.note || '—', 'row-title');
        name.title = c.note || '';
        // The full ID is too long: only the first 13 characters are shown, the full one in the
        // title; the creation date goes on the same line.
        const id = subLine(
          t('platform.codeId', {
            id: c.id.length > 13 ? `${c.id.slice(0, 13)}…` : c.id,
            date: day(c.created_at),
          }),
        );
        id.translate = false;
        id.title = c.id;
        note.append(name, id);
        const actions = el('div', undefined, 'row-action');
        if (!c.revoked)
          actions.append(
            button(
              t('platform.revoke'),
              '',
              attempt(async () => {
                if (
                  !(await confirmAction({
                    title: t('platform.revokeTitle'),
                    message: t('platform.revokeMessage'),
                    accept: t('platform.revoke'),
                    danger: true,
                  }))
                )
                  return;
                await revokeCode(c);
              }),
              'subtle small-btn',
            ),
          );
        actions.firstElementChild?.setAttribute(
          'aria-label',
          t('platform.revokeCode', { name: c.note || c.id }),
        );
        tr.append(
          cell(kind),
          cell(`${num(c.used)} / ${c.max_uses ? num(c.max_uses) : t('platform.unlimited')}`, 'num'),
          cell(c.expires_at ? day(c.expires_at) : t('platform.never'), 'nowrap'),
          cell(note),
          cell(badge(label, tone)),
          cell(actions),
        );
        return tr;
      }),
    ),
  );
}
