import { portal } from './api.js';
import { errorMessage, t } from './i18n.js';
import {
  box,
  busy,
  button,
  copyButton,
  el,
  empty,
  field,
  icons,
  link,
  loading,
  notice,
  pageWrap,
  sectionHead,
  toast,
  validateForm,
} from './dom.js';
import { dateOnly, integer } from './format.js';
import { endpoints } from './state.js';
import { stackedTable } from './stack.js';

// A fresh key is shown once, here, and only here. Leaving the page forgets it.
function revealBox(created, dismiss) {
  const token = el('code', created.token);
  return box(
    'div',
    'reveal',
    el('strong', t('keys.created', { name: created.name })),
    el('p', t('keys.once')),
    box(
      'div',
      'token-line',
      token,
      copyButton(() => created.token, 'small'),
    ),
    box('div', 'actions', button(t('keys.saved'), 'small', dismiss)),
  );
}

// "每分钟 60 次" over "并发 2": the two limits, one under the other.
function quotaCell(quota) {
  const td = el('td');
  const parts = [];
  if (quota?.rpm) parts.push(t('keys.rpm', { n: integer(quota.rpm) }));
  if (quota?.maxConcurrentRuns) parts.push(t('keys.concurrent', { n: quota.maxConcurrentRuns }));
  if (!parts.length) td.textContent = '—';
  parts.forEach((p, i) => td.append(i ? el('span', p, 'sub') : document.createTextNode(p)));
  return td;
}

// Deleting is final, so the row asks again in place (no native dialog).
function deleteCell(key, onDone) {
  const cell = el('td');
  const show = () => {
    const ask = button(t('keys.delete'), 'small', arm);
    ask.setAttribute('aria-label', `${t('keys.delete')} ${key.name}`);
    cell.replaceChildren(ask);
  };
  function arm() {
    const confirm = button(t('keys.delete_confirm'), 'small danger', async () => {
      busy(confirm, true);
      try {
        await portal.deleteKey(key.id);
        toast(t('keys.deleted_toast'));
        onDone();
      } catch (err) {
        toast(errorMessage(err));
        show();
      }
    });
    const cancel = button(t('common.cancel'), 'quiet small', show);
    const wrap = box(
      'span',
      'confirm-inline',
      el('span', t('keys.delete_ask'), 'ask'),
      box('span', 'confirm-buttons', confirm, cancel),
    );
    cell.replaceChildren(wrap);
    confirm.focus();
  }
  show();
  return cell;
}

function keyTable(all, onChange) {
  // 删除的密钥不再出现在列表里；较早版本的网关仍会返回已撤销的行，这里一并略去。
  const keys = all.filter((k) => !k.revoked);
  if (!keys.length) return empty(t('keys.empty.title'), t('keys.empty.text'));
  const trs = keys.map((key) => {
    const tr = el('tr');
    const name = el('td');
    name.append(
      el('strong', key.name),
      el('span', `${key.id} · ${dateOnly(key.created_at)}`, 'sub mono'),
    );
    const state = el('td');
    state.append(el('span', t('keys.status.active'), 'status good'));
    const used = el('td', undefined, 'nowrap');
    used.append(
      document.createTextNode(t('keys.runs', { n: integer(key.usage?.used_runs ?? 0) })),
      el('span', t('keys.tokens', { n: integer(key.usage?.used_tokens ?? 0) }), 'sub'),
    );
    tr.append(name, state, used, quotaCell(key.quota), deleteCell(key, onChange));
    return tr;
  });
  return stackedTable(
    'keys',
    [
      { text: t('keys.col.name'), min: 200 },
      { text: t('keys.col.status'), width: 100 },
      { text: t('keys.col.usage'), width: 150 },
      { text: t('keys.col.limits'), width: 140 },
      { text: t('keys.col.actions'), align: 'actions', width: 120 },
    ],
    trs,
  );
}

export async function keys(root) {
  const page = pageWrap(root, loading());
  const { data } = await portal.keys();
  let created = null;

  const message = el('div');
  message.setAttribute('aria-live', 'polite');
  const name = field('key-name', t('keys.name'), {
    type: 'text',
    required: true,
    maxlength: 60,
    placeholder: t('keys.name_ph'),
    autocomplete: 'off',
  });
  const submit = button(t('keys.create'), 'primary', null, 'plus');
  submit.type = 'submit';
  const form = el('form', undefined, 'form-row');
  form.noValidate = true;
  form.append(name.field, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.replaceChildren();
    if (!validateForm(form)) return;
    busy(submit, true);
    try {
      created = await portal.createKey(name.input.value.trim());
      refreshList();
    } catch (err) {
      message.replaceChildren(notice(errorMessage(err), 'error'));
      busy(submit, false);
    }
  });

  const slot = el('div', undefined, 'stack section-body');
  async function refreshList() {
    try {
      const fresh = await portal.keys();
      draw(fresh.data);
    } catch (err) {
      message.replaceChildren(notice(errorMessage(err), 'error'));
    }
  }
  const count = el('p');
  function draw(list) {
    count.textContent = t('keys.count', { n: list.filter((k) => !k.revoked).length });
    busy(submit, false);
    name.input.value = '';
    slot.replaceChildren(
      ...(created
        ? [
            revealBox(created, () => {
              created = null;
              draw(list);
            }),
          ]
        : []),
      keyTable(list, refreshList),
    );
    icons();
  }
  page.replaceChildren(
    box(
      'div',
      'page-head',
      el('h1', t('keys.title')),
      el('p', t('keys.lede')),
      box(
        'div',
        'endpoint',
        el('span', t('home.endpoint'), 'endpoint-label'),
        el('code', endpoints().openai),
        copyButton(() => endpoints().openai, 'quiet small'),
      ),
    ),
    box(
      'section',
      '',
      sectionHead(t('keys.new'), count),
      box('div', 'section-body', form, message),
    ),
    box('section', '', sectionHead(t('keys.list')), slot),
    box('p', 'muted', t('keys.docs_pre'), link('#/docs', t('title.docs'), 'text-link')),
  );
  draw(data);
}
