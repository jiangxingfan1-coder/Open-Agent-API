import { portal } from './api.js';
import { t } from './i18n.js';
import { box, el, link, pageWrap } from './dom.js';
import {
  backgroundExamples,
  callExamples,
  codeBlock,
  codeTabs,
  streamingExample,
} from './examples.js';
import { state } from './state.js';

const section = (id, title, ...children) => {
  const h = el('h2', title);
  h.tabIndex = -1;
  const s = box('section', 'doc-section', h, ...children);
  s.id = id;
  return s;
};

export async function docs(root) {
  const page = pageWrap(root);
  // Use a real listed agent in the examples when there is one.
  let sample = 'agent/research';
  try {
    const { data } = await portal.agents();
    if (data?.[0]?.id) sample = data[0].id;
  } catch {
    // Placeholder ID is fine.
  }
  const closed = state.site?.registration === 'closed';
  // The three steps are also the way into the sections below: a click scrolls there.
  const steps = [1, 2, 3].map((n) => {
    const a = link('#/docs', undefined, 'step-link');
    a.append(
      el('span', `0${n}`, 'num'),
      el('h3', t(`docs.step${n}.title`)),
      el('p', t(`docs.step${n}.text`)),
    );
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(`docs-s${n}`);
      target?.scrollIntoView({ block: 'start' });
      target?.querySelector('h2')?.focus({ preventScroll: true });
    });
    return box('li', '', a);
  });
  const stepList = box('ol', 'steps', ...steps);

  page.replaceChildren(
    box('div', 'page-head', el('h1', t('docs.title')), el('p', t('docs.lede'))),
    stepList,
    section(
      'docs-s1',
      t('docs.s1.title'),
      el('p', t(closed ? 'docs.s1.text_closed' : 'docs.s1.text')),
      box(
        'div',
        'actions',
        state.account
          ? link('#/keys', t('docs.s1.keys'), 'link-button primary')
          : link(
              closed ? '#/login' : '#/signup',
              t(closed ? 'home.cta.login' : 'docs.s1.signup'),
              'link-button primary',
            ),
      ),
    ),
    section(
      'docs-s2',
      t('docs.s2.title'),
      el('p', t('docs.s2.text')),
      box('div', 'actions', link('#/agents', t('docs.s2.browse'), 'link-button')),
    ),
    section(
      'docs-s3',
      t('docs.s3.title'),
      el('p', t('docs.s3.text', { id: sample })),
      codeTabs(callExamples(sample), t('docs.s3.title')),
    ),
    section(
      'docs-stream',
      t('docs.stream.title'),
      el('p', t('docs.stream.text')),
      box('div', 'code-solo', codeBlock(streamingExample(sample))),
    ),
    section(
      'docs-bg',
      t('docs.bg.title'),
      el('p', t('docs.bg.text')),
      codeTabs(backgroundExamples(sample), t('docs.bg.title')),
    ),
    section('docs-billing', t('docs.billing.title'), el('p', t('docs.billing.text'))),
  );
}
