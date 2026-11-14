import { portal } from './api.js';
import { t } from './i18n.js';
import { box, copyButton, el, empty, icon, link, loading, pageWrap } from './dom.js';
import { dateOnly, priceLines } from './format.js';
import { callExamples, codeTabs } from './examples.js';
import { state } from './state.js';

const paragraphs = (text) =>
  box(
    'div',
    'prose',
    ...String(text ?? '')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => el('p', p)),
  );

const row = (dl, label, content) => {
  const dd = el('dd');
  dd.append(content instanceof Node ? content : document.createTextNode(content));
  dl.append(el('dt', label), dd);
};

// The primary action sits under the title, where the eye lands, not at the foot of the side column.
function headActions(agent) {
  const closed = state.site?.registration === 'closed';
  if (state.account)
    return box(
      'div',
      'actions',
      link(
        `#/playground?agent=${encodeURIComponent(agent.id)}`,
        t('detail.try'),
        'link-button primary',
      ),
      link('#/keys', t('detail.get_key'), 'link-button'),
    );
  return box(
    'div',
    'actions',
    link(
      closed ? '#/login' : '#/signup',
      t(closed ? 'home.cta.login' : 'detail.signup'),
      'link-button primary',
    ),
    link('#/docs', t('title.docs'), 'link-button'),
  );
}

// `conversion` is the gateway's conversion profile. Only fields it actually carries are shown.
function behaviour(conversion) {
  if (!conversion) return null;
  const dl = el('dl', undefined, 'kv');
  const known = (group, value) => {
    const key = `conv.${group}.${value}`;
    return t(key) === key ? null : t(key);
  };
  const add = (label, group, value) => {
    const text = known(group, value);
    if (text) row(dl, label, text);
  };
  add(t('conv.client_tools'), 'client_tools', conversion.client_tools);
  add(t('conv.streaming'), 'streaming', conversion.streaming);
  add(t('conv.approvals'), 'approvals', conversion.approvals);
  add(t('conv.resume'), 'resume', conversion.resume);
  if (typeof conversion.artifacts === 'boolean')
    row(dl, t('conv.artifacts'), t(conversion.artifacts ? 'conv.yes' : 'conv.no'));
  if (!dl.childElementCount) return null;
  const note = known('client_tools_note', conversion.client_tools);
  return box(
    'section',
    '',
    el('h2', t('detail.behaviour'), 'minor'),
    dl,
    note ? el('p', note, 'muted note') : null,
  );
}

export async function agentDetail(root, ctx) {
  const page = pageWrap(root, loading());
  const back = link('#/agents', undefined, 'crumb');
  back.append(icon('arrow-left'), el('span', t('detail.back')));
  let agent;
  try {
    agent = await portal.agent(ctx.param);
  } catch (err) {
    if (err.code !== 'agent_not_found') throw err;
    page.replaceChildren(back, empty(t('detail.missing.title'), t('detail.missing.text')));
    return;
  }
  document.title = `${agent.title || agent.id} · ${state.site?.site_name ?? ''}`;

  const head = box(
    'header',
    'detail-head',
    back,
    el('h1', agent.title || agent.id, 'title-page'),
    box(
      'div',
      'agent-id',
      el('span', agent.id),
      copyButton(() => agent.id, 'quiet small'),
    ),
    agent.summary ? el('p', agent.summary, 'lede') : null,
    headActions(agent),
  );

  const facts = el('dl', undefined, 'kv');
  row(facts, t('detail.kind'), t(`kind.${agent.kind}`));
  row(
    facts,
    t('detail.price'),
    box('div', 'price-lines', ...priceLines(agent.price).map((line) => el('span', line))),
  );
  if (agent.models?.length) {
    const models = box('div', 'tags');
    for (const m of agent.models) models.append(el('span', m, 'tag'));
    row(facts, t('detail.models'), models);
  }
  if (agent.tags?.length) {
    const tags = box('div', 'tags');
    for (const tag of agent.tags) tags.append(el('span', tag, 'tag'));
    row(facts, t('detail.tags'), tags);
  }
  row(facts, t('detail.updated'), dateOnly(agent.updated_at));

  const price = agent.price ?? {};
  const billing =
    price.per_run || price.per_1k_tokens ? t('detail.billing') : t('detail.billing_free');

  const main = box(
    'div',
    'stack',
    agent.description
      ? box('section', '', el('h2', t('detail.about'), 'minor'), paragraphs(agent.description))
      : null,
    box(
      'section',
      '',
      el('h2', t('detail.call'), 'minor'),
      el('p', t('detail.call_text', { id: agent.id }), 'muted lead-note'),
      box('div', '', codeTabs(callExamples(agent.id), t('detail.call'))),
    ),
  );

  const side = box(
    'aside',
    'side',
    box('section', '', el('h2', t('detail.facts')), facts, el('p', billing, 'muted note')),
    behaviour(agent.conversion),
  );
  page.replaceChildren(head, box('div', 'detail-grid', main, side));
}
