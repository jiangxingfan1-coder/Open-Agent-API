// "Webhooks" section of the Endpoints page: full CRUD management for run-event webhooks,
// one-time signing secret reveal, test callback trigger, and recent delivery history.
import { lang, t } from '../lib/i18n.js';
import { formatDate } from '../shared/format.js';
import {
  button,
  cell,
  confirmAction,
  copyButton,
  copyText,
  el,
  empty,
  icon,
  iconButton,
  icons,
  panel,
  table,
  toast,
  withBusy,
} from '../lib/dom.js';
import { api } from '../lib/api.js';

export const WEBHOOK_EVENT_OPTIONS = [
  'run.requires_action',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.incomplete',
  'run.interrupted',
];

// Endpoint state and delivery status -> [dictionary key, status tone].
const ENDPOINT = {
  ok: ['webhooks.ok', 'good'],
  failing: ['webhooks.failing', 'error'],
  disabled: ['webhooks.disabled', 'neutral'],
};
const DELIVERY = {
  succeeded: ['webhooks.succeeded', 'good'],
  pending: ['webhooks.pending', 'queued'],
  failed: ['webhooks.failed', 'error'],
};

const mark = (map, value) => {
  const [key, tone] = map[value] ?? [undefined, 'neutral'];
  return el('span', key ? t(key) : value, `status ${tone}`);
};

function retriesLabel(attempts) {
  const count = Math.max(0, (Number(attempts) || 0) - 1);
  return t('webhooks.retriesCount', { n: count });
}

function latestCell(d) {
  if (!d) return cell(t('webhooks.never'), 'muted');
  const box = el('div', undefined, 'webhook-latest');
  const httpCode = d.http_status != null ? `HTTP ${d.http_status}` : '—';
  box.append(
    mark(DELIVERY, d.status),
    el(
      'small',
      `${d.event_type} · ${httpCode} · ${retriesLabel(d.attempts)} · ${formatDate(d.updated_at, lang)}` +
        (d.last_error ? ` · ${d.last_error}` : ''),
    ),
  );
  return cell(box);
}

export function openAddWebhookDialog(onCreated) {
  const opener = document.activeElement;
  const dialog = el('dialog', undefined, 'modal wide-modal webhook-modal');
  const head = el('div', undefined, 'dialog-heading');
  const titleGroup = el('div');
  const titleNode = el('h2', t('webhooks.addTitle'));
  const descNode = el('p', t('webhooks.addDesc'), 'dialog-desc');
  titleGroup.append(titleNode, descNode);
  head.append(
    titleGroup,
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );

  const formStep = el('form');
  const urlField = el('label', undefined, 'field');
  urlField.append(el('span', t('webhooks.urlLabel')));
  const urlInput = el('input');
  urlInput.type = 'url';
  urlInput.required = true;
  urlInput.placeholder = 'https://example.com/webhooks/oaa';
  urlInput.translate = false;
  urlField.append(urlInput, el('small', t('webhooks.urlHint')));

  const descField = el('label', undefined, 'field');
  descField.append(el('span', t('webhooks.descLabel')));
  const descInput = el('input');
  descInput.type = 'text';
  descInput.maxLength = 500;
  descInput.placeholder = t('webhooks.descPlaceholder');
  descField.append(descInput);

  const eventsSet = el('fieldset', undefined, 'checkboxes');
  eventsSet.append(el('legend', t('webhooks.eventsLegend')));
  const eventChecks = [];
  for (const evName of WEBHOOK_EVENT_OPTIONS) {
    const lbl = el('label');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.value = evName;
    chk.checked = ['run.requires_action', 'run.completed', 'run.failed'].includes(evName);
    const code = el('code', evName);
    lbl.append(chk, code);
    eventsSet.append(lbl);
    eventChecks.push(chk);
  }
  const eventsHint = el('small', t('webhooks.eventsHint'), 'muted webhook-events-hint');

  const includeLabel = el('label', undefined, 'inline-check');
  const includeCheck = el('input');
  includeCheck.type = 'checkbox';
  includeLabel.append(includeCheck, el('span', t('webhooks.includeOutput')));

  const errNode = el('span', '', 'form-error');
  errNode.setAttribute('role', 'alert');
  const submitBtn = button(t('webhooks.createSubmit'), 'plus', () => {}, 'primary');
  submitBtn.type = 'submit';
  const actionsRow = el('div', undefined, 'dialog-actions');
  actionsRow.append(errNode, submitBtn);
  formStep.append(urlField, descField, eventsSet, eventsHint, includeLabel, actionsRow);

  const secretStep = el('div', undefined, 'webhook-secret-step');
  secretStep.hidden = true;
  const secretNotice = el('div', undefined, 'callout needs-action');
  secretNotice.append(icon('key-round'), el('span', t('webhooks.secretOnce')));
  const secretBox = el('div', undefined, 'key-reveal webhook-secret-reveal');
  const secretCode = el('code', '');
  const copySecretBtn = copyButton(t('webhooks.copySecret'), () =>
    copyText(secretCode.textContent, t('webhooks.secretCopied')),
  );
  secretBox.append(secretCode, copySecretBtn);
  const doneRow = el('div', undefined, 'dialog-actions');
  doneRow.append(button(t('common.done'), 'check', () => dialog.close(), 'primary'));
  secretStep.append(secretNotice, secretBox, doneRow);

  formStep.onsubmit = async (e) => {
    e.preventDefault();
    errNode.textContent = '';
    const selectedEvents = eventChecks.filter((c) => c.checked).map((c) => c.value);
    await withBusy(submitBtn, t('webhooks.creating'), async () => {
      try {
        const created = await api('POST', '/v1/webhooks', {
          url: urlInput.value.trim(),
          events: selectedEvents,
          description: descInput.value.trim(),
          include_output: includeCheck.checked,
        });
        secretCode.textContent = created.secret || '';
        titleNode.textContent = t('webhooks.createdTitle');
        descNode.textContent = created.url || '';
        formStep.hidden = true;
        secretStep.hidden = false;
        icons();
        toast(t('webhooks.createdToast'));
        onCreated?.();
      } catch (err) {
        errNode.textContent = err.message;
      }
    });
  };

  dialog.append(head, formStep, secretStep);
  document.body.append(dialog);
  dialog.showModal();
  icons();
  urlInput.focus();
  dialog.addEventListener(
    'close',
    () => {
      secretCode.textContent = '';
      dialog.remove();
      if (opener && typeof opener.focus === 'function') opener.focus();
    },
    { once: true },
  );
}

/** Panel filled once GET /v1/webhooks and recent deliveries answer. */
export function webhooksPanel() {
  const box = panel(t('webhooks.title'));
  const headActions = el('div', undefined, 'webhook-head-actions');
  const slot = el('div');
  const deliveriesSlot = el('div', undefined, 'webhook-deliveries-section');

  const reload = () => {
    slot.replaceChildren(empty(t('webhooks.loading'), '', { icon: 'webhook', compact: true }));
    deliveriesSlot.replaceChildren();
    api('GET', '/v1/webhooks')
      .then(async ({ data }) => {
        if (!data.length) {
          slot.replaceChildren(
            empty(t('webhooks.none'), t('webhooks.noneHint'), {
              icon: 'webhook',
              compact: true,
              action: button(
                t('webhooks.addBtn'),
                'plus',
                () => openAddWebhookDialog(reload),
                'subtle',
              ),
            }),
          );
          icons();
          return;
        }
        slot.replaceChildren(
          table(
            [
              { text: t('webhooks.colUrl'), min: 220 },
              { text: t('webhooks.colEvents'), min: 150 },
              { text: t('webhooks.colState'), width: 104 },
              { text: t('webhooks.colLatest'), min: 220 },
              { text: '', align: 'actions', width: 148 },
            ],
            data.map((w) => {
              const tr = el('tr');
              const urlWrap = el('div', undefined, 'webhook-url-cell');
              urlWrap.append(el('code', w.url, 'endpoint-url'));
              if (w.description) urlWrap.append(el('small', w.description, 'muted'));

              const rowActions = el('div', undefined, 'row-action webhook-row-actions');
              const testBtn = button(
                t('webhooks.testBtn'),
                'send',
                async () => {
                  await withBusy(testBtn, t('webhooks.testing'), async () => {
                    try {
                      await api('POST', `/v1/webhooks/${encodeURIComponent(w.id)}/test`, {});
                      toast(t('webhooks.testSent'));
                      setTimeout(reload, 250);
                    } catch (err) {
                      toast(err.message);
                    }
                  });
                },
                'subtle small-btn',
              );
              const delBtn = iconButton(t('webhooks.deleteBtn'), 'trash-2', async () => {
                const ok = await confirmAction({
                  title: t('webhooks.deleteTitle'),
                  message: t('webhooks.deleteMsg', { url: w.url }),
                  accept: t('webhooks.deleteBtn'),
                  danger: true,
                });
                if (!ok) return;
                try {
                  await api('DELETE', `/v1/webhooks/${encodeURIComponent(w.id)}`);
                  toast(t('webhooks.deleted'));
                  reload();
                } catch (err) {
                  toast(err.message);
                }
              });
              rowActions.append(testBtn, delBtn);

              tr.append(
                cell(urlWrap),
                cell(w.events.length ? w.events.join(', ') : t('webhooks.allEvents')),
                cell(mark(ENDPOINT, w.status.state)),
                latestCell(w.status.latest_delivery),
                cell(rowActions, 'nowrap'),
              );
              return tr;
            }),
          ),
        );
        icons();

        const lists = await Promise.all(
          data.map((w) =>
            api('GET', `/v1/webhooks/${encodeURIComponent(w.id)}/deliveries?limit=6`)
              .then((r) => (r.data || []).map((d) => ({ ...d, endpointUrl: w.url })))
              .catch(() => []),
          ),
        );
        const recent = lists
          .flat()
          .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
          .slice(0, 12);
        if (recent.length) {
          deliveriesSlot.replaceChildren(
            el('h3', t('webhooks.deliveriesTitle'), 'webhook-subhead'),
            table(
              [
                { text: t('webhooks.colDeliveryStatus'), width: 112 },
                { text: t('webhooks.colEvent'), min: 140 },
                { text: t('webhooks.colUrl'), min: 180 },
                { text: t('webhooks.colHttp'), width: 96 },
                { text: t('webhooks.colRetries'), width: 108 },
                { text: t('webhooks.colUpdated'), min: 140 },
              ],
              recent.map((d) => {
                const tr = el('tr');
                const httpText = d.http_status != null ? String(d.http_status) : '—';
                const timeText =
                  formatDate(d.updated_at, lang) + (d.last_error ? ` · ${d.last_error}` : '');
                tr.append(
                  cell(mark(DELIVERY, d.status)),
                  cell(el('code', d.event_type)),
                  cell(el('code', d.endpointUrl, 'endpoint-url')),
                  cell(httpText),
                  cell(retriesLabel(d.attempts)),
                  cell(el('small', timeText, 'muted')),
                );
                return tr;
              }),
            ),
          );
          icons();
        }
      })
      .catch((err) => {
        slot.replaceChildren(el('p', `${t('webhooks.error')} ${err.message ?? ''}`, 'callout'));
      });
  };

  headActions.append(
    iconButton(t('common.refresh'), 'refresh-cw', reload),
    button(t('webhooks.addBtn'), 'plus', () => openAddWebhookDialog(reload), 'primary small-btn'),
  );
  box.box.querySelector('.panel-head').append(headActions);
  box.body.append(el('p', t('webhooks.hint'), 'callout'), slot, deliveriesSlot);
  reload();
  return box;
}
