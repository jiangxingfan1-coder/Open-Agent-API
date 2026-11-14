import { portal } from './api.js';
import { t } from './i18n.js';
import { box, copyButton, el, empty, link, pageWrap, sectionHead } from './dom.js';
import { agentCell, agentRow } from './catalog.js';
import { endpoints, state } from './state.js';

function endpointLine() {
  const url = endpoints().openai;
  return box(
    'div',
    'endpoint',
    el('span', t('home.endpoint'), 'endpoint-label'),
    el('code', url),
    copyButton(() => url, 'quiet small'),
  );
}

function differences() {
  const items = [1, 2, 3].map((n) =>
    box(
      'div',
      '',
      el('span', `0${n}`, 'num'),
      el('h3', t(`home.diff${n}.title`)),
      el('p', t(`home.diff${n}.text`)),
    ),
  );
  return box('section', '', sectionHead(t('home.diff.title')), box('div', 'diff', ...items));
}

// A grid only when it can be filled: one or two agents are a short list, four make two by two,
// everything else three across (up to two rows). A lone card never stretches across the page.
function agentsBlock(agents) {
  const shown = agents.slice(0, 6);
  if (!shown.length) return empty(t('home.agents.empty'));
  if (shown.length < 3) return box('div', 'agent-list', ...shown.map(agentRow));
  const cols = shown.length === 4 ? 2 : 3;
  return box('div', 'agent-grid', box('div', `cells cols-${cols}`, ...shown.map(agentCell)));
}

export async function home(root) {
  const page = pageWrap(root);
  let agents = [];
  try {
    agents = (await portal.agents()).data ?? [];
  } catch {
    // The catalog is a nice-to-have on the landing page; the section shows its empty state.
  }
  const signedIn = Boolean(state.account);
  const closed = state.site?.registration === 'closed';
  const primary = signedIn
    ? link('#/dashboard', t('home.cta.dashboard'), 'link-button primary')
    : link(
        closed ? '#/login' : '#/signup',
        t(closed ? 'home.cta.login' : 'home.cta.signup'),
        'link-button primary',
      );
  const hero = box(
    'section',
    'hero',
    el('span', t('home.eyebrow'), 'eyebrow'),
    el('h1', t('home.title'), 'display'),
    el('p', t('home.lede'), 'lede'),
    endpointLine(),
    box('div', 'actions', primary, link('#/agents', t('home.cta.browse'), 'link-button')),
  );

  const catalog = box(
    'section',
    '',
    sectionHead(
      t('home.agents.title'),
      agents.length
        ? link('#/agents', t('home.agents.all', { n: agents.length }), 'text-link')
        : null,
    ),
    agentsBlock(agents),
  );
  page.replaceChildren(hero, differences(), catalog);
}
