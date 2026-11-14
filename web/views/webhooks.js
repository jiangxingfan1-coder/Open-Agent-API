// "Webhooks" section of the Endpoints page: read-only visibility of the configured run-event
// webhooks and their latest delivery (docs/webhooks.md). Adding and changing endpoints goes
// through `oaa webhook` and the /v1/webhooks API.
import { t } from '../lib/i18n.js';
import { formatDate } from '../shared/format.js';
import { cell, el, empty, panel, table } from '../lib/dom.js';
import { api } from '../lib/api.js';

// Endpoint state and delivery status -> [dictionary key, status tone]. A failing endpoint uses the
// error tone, not cinnabar: nothing waits on a person's decision there.
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

function latestCell(d) {
  if (!d) return cell(t('webhooks.never'), 'muted');
  const box = el('div', undefined, 'webhook-latest');
  box.append(
    mark(DELIVERY, d.status),
    el(
      'small',
      `${d.event_type} · ${d.http_status ?? '—'} · ${formatDate(d.updated_at)}` +
        (d.last_error ? ` · ${d.last_error}` : ''),
    ),
  );
  return cell(box);
}

/** Panel filled once GET /v1/webhooks answers. */
export function webhooksPanel() {
  const box = panel(t('webhooks.title'));
  box.body.append(el('p', t('webhooks.hint'), 'callout'));
  const slot = el('div');
  slot.append(empty(t('webhooks.loading'), '', { icon: 'webhook', compact: true }));
  box.body.append(slot);
  api('GET', '/v1/webhooks')
    .then(({ data }) => {
      slot.replaceChildren(
        data.length
          ? table(
              [
                { text: t('webhooks.colUrl'), min: 220 },
                { text: t('webhooks.colEvents'), min: 160 },
                { text: t('webhooks.colState'), width: 108 },
                { text: t('webhooks.colLatest'), min: 220 },
              ],
              data.map((w) => {
                const tr = el('tr');
                const url = el('code', w.url, 'endpoint-url');
                tr.append(
                  cell(url),
                  cell(w.events.length ? w.events.join(', ') : t('webhooks.allEvents')),
                  cell(mark(ENDPOINT, w.status.state)),
                  latestCell(w.status.latest_delivery),
                );
                return tr;
              }),
            )
          : empty(t('webhooks.none'), t('webhooks.noneHint'), { icon: 'webhook', compact: true }),
      );
    })
    .catch((error) => {
      slot.replaceChildren(el('p', `${t('webhooks.error')} ${error.message ?? ''}`, 'callout'));
    });
  return box;
}
