import { portal } from './api.js';
import { t } from './i18n.js';
import { box, el, empty, icon, link, loading, pageWrap } from './dom.js';
import { priceLines } from './format.js';

export const agentHref = (id) => `#/agent/${encodeURIComponent(id)}`;

export function tagList(tags, max = 4, kind) {
  const list = el('div', undefined, 'tags');
  if (kind) list.append(el('span', t(`kind.${kind}`), 'tag kind'));
  for (const tag of (tags ?? []).slice(0, max)) list.append(el('span', tag, 'tag'));
  return list;
}

// The price, one line per part ("每次 0.5 点" over "每千 token 0.02 点"): never wraps mid-phrase.
export const priceBlock = (price, cls = 'price') =>
  box('span', cls, ...priceLines(price).map((line) => el('span', line, 'price-line')));

// One entry of the home-page grid: five parts, always, so a row of cells lines up part by part.
export function agentCell(agent) {
  const a = link(agentHref(agent.id), undefined, 'agent-cell');
  a.append(
    el('h3', agent.title || agent.id),
    el('span', agent.id, 'agent-id'),
    el('p', agent.summary || '', 'summary'),
    tagList(agent.tags, 3, agent.kind),
    priceBlock(agent.price),
  );
  return a;
}

export function agentRow(agent) {
  const a = link(agentHref(agent.id), undefined, 'agent-row');
  a.append(
    box('div', 'agent-name', el('h3', agent.title || agent.id), el('div', agent.id, 'agent-id')),
    box('div', 'agent-body', el('p', agent.summary, 'summary'), tagList(agent.tags, 6, agent.kind)),
    priceBlock(agent.price),
  );
  return a;
}

const haystack = (a) => [a.id, a.title, a.summary, ...(a.tags ?? [])].join(' ').toLocaleLowerCase();

export async function catalog(root) {
  const page = pageWrap(root, loading());
  const { data } = await portal.agents();
  const agents = data ?? [];

  const list = el('div', undefined, 'agent-list');
  const count = el('span', undefined, 'muted');
  count.setAttribute('role', 'status');
  const draw = (query) => {
    const needle = query.trim().toLocaleLowerCase();
    const shown = needle ? agents.filter((a) => haystack(a).includes(needle)) : agents;
    count.textContent = t('catalog.count', { n: shown.length });
    list.replaceChildren(
      ...(shown.length
        ? shown.map(agentRow)
        : [empty(t(agents.length ? 'catalog.no_match' : 'catalog.empty'))]),
    );
  };

  const search = el('input');
  search.type = 'search';
  search.id = 'agent-search';
  search.placeholder = t('catalog.search');
  search.setAttribute('aria-label', t('catalog.search'));
  search.autocomplete = 'off';
  search.addEventListener('input', () => draw(search.value));
  const searchBox = box('div', 'search', icon('search'), search);

  page.replaceChildren(
    box(
      'div',
      'page-head',
      el('h1', t('catalog.title')),
      el('p', t('catalog.lede', { n: agents.length })),
    ),
    box('section', '', box('div', 'catalog-tools', searchBox, count), list),
  );
  draw('');
}
