import { state } from '../lib/state.js';
import { el, toast } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { encode, parsePoints, platform, refreshPlatform } from './platform-data.js';
import {
  checkRow,
  field,
  formDialog,
  numberInput,
  selectInput,
  textInput,
} from './platform-dialog.js';

/* ── Listings and pricing ─────────────────────────────────── */
const shortName = (id) => String(id).split('/').pop() || String(id);
const parseTags = (text) => [
  ...new Set(
    String(text)
      .split(/[,\uFF0C\u3001\n]/) // ASCII comma, fullwidth comma, ideographic comma
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];

// With no listing: pick a published, not-yet-listed agent to list; otherwise edit this listing.
export function openListingDialog(listing) {
  const editing = !!listing;
  const taken = new Set((platform.listings ?? []).map((l) => l.agent_id));
  const choices = (state.data?.agents ?? []).filter((a) => !taken.has(a.id));
  if (!editing && !choices.length) {
    toast(
      state.data?.agents?.length ? t('dlg.listing.all_listed') : t('dlg.listing.none_published'),
    );
    return;
  }
  const agent = editing
    ? Object.assign(textInput({ value: listing.agent_id, mono: true }), { readOnly: true })
    : selectInput(choices.map((a) => [a.id, a.id]));
  agent.translate = false;
  const title = textInput({
    value: listing?.title ?? '',
    max: 80,
    placeholder: t('dlg.listing.title_ph'),
  });
  const summary = el('textarea');
  summary.rows = 3;
  summary.maxLength = 300;
  summary.value = listing?.summary ?? '';
  summary.placeholder = t('dlg.listing.summary_ph');
  const tags = textInput({
    value: (listing?.tags ?? []).join(t('dlg.listing.tag_sep')),
    placeholder: t('dlg.listing.tags_ph'),
  });
  const perRun = numberInput({ value: listing?.price?.per_run ?? 0 });
  const perTokens = numberInput({ value: listing?.price?.per_1k_tokens ?? 0 });
  const live = checkRow(t('dlg.listing.live'), listing?.enabled ?? true);
  // When listing a new agent, the title follows the chosen agent until it has been edited.
  let touched = false;
  title.oninput = () => (touched = true);
  if (!editing) {
    const suggest = () => {
      if (!touched) title.value = shortName(agent.value);
    };
    agent.onchange = suggest;
    suggest();
  }
  const { ctx, open } = formDialog({
    title: editing
      ? t('dlg.listing.edit_title', { id: listing.agent_id })
      : t('dlg.listing.new_title'),
    desc: t('dlg.listing.desc'),
    wide: true,
    submit: editing ? t('dlg.listing.save') : t('dlg.listing.list'),
    symbol: 'store',
    busy: t('dlg.listing.saving'),
    async onSubmit() {
      const name = title.value.trim();
      if (!name) throw Error(t('dlg.listing.err.no_title'));
      const body = {
        agent_id: agent.value,
        title: name,
        summary: summary.value.trim(),
        tags: parseTags(tags.value),
        price: {
          per_run: parsePoints(perRun.value, t('dlg.listing.price_run')) ?? 0,
          per_1k_tokens: parsePoints(perTokens.value, t('dlg.listing.price_1k')) ?? 0,
        },
        enabled: live.input.checked,
      };
      await api('PUT', '/v1/platform/listings', body);
      toast(editing ? t('dlg.listing.saved') : t('dlg.listing.listed', { id: body.agent_id }));
      await refreshPlatform();
    },
  });
  const grid = el('div', undefined, 'form-grid');
  const note = el('div', undefined, 'field');
  note.append(el('small', t('dlg.listing.token_note')));
  const liveBox = el('div');
  liveBox.append(live.row);
  grid.append(
    field(t('dlg.listing.per_run'), perRun, t('dlg.listing.per_run_hint')),
    field(t('dlg.listing.per_1k'), perTokens, t('dlg.listing.per_1k_hint')),
  );
  ctx.body.append(
    field(
      t('dlg.listing.agent'),
      agent,
      editing ? t('dlg.listing.agent_hint_edit') : t('dlg.listing.agent_hint_new'),
    ),
    field(t('dlg.listing.title'), title),
    field(t('dlg.listing.summary'), summary),
    field(t('dlg.listing.tags'), tags, t('dlg.listing.tags_hint')),
    grid,
    note,
    liveBox,
  );
  open();
}

// Unlisting / relisting only changes enabled; every other field is kept as is.
export async function setListingEnabled(listing, enabled) {
  await api('PUT', '/v1/platform/listings', { agent_id: listing.agent_id, enabled });
  toast(t(enabled ? 'dlg.listing.relisted' : 'dlg.listing.unlisted', { id: listing.agent_id }));
  await refreshPlatform();
}
export async function removeListing(listing) {
  await api('DELETE', `/v1/platform/listings?agent_id=${encode(listing.agent_id)}`);
  toast(t('dlg.listing.removed', { id: listing.agent_id }));
  await refreshPlatform();
}
