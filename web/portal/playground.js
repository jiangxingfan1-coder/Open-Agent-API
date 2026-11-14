import { ApiError, portal } from './api.js';
import { errorMessage, t } from './i18n.js';
import {
  box,
  busy,
  button,
  copyButton,
  el,
  empty,
  field,
  icon,
  icons,
  link,
  loading,
  notice,
  pageWrap,
  selectField,
  textareaField,
  validateForm,
} from './dom.js';
import { priceText } from './format.js';
import { readSse } from './sse.js';
import { runHref } from './runs.js';

// The API key lives only in this module variable: never in localStorage, sessionStorage or the
// URL. It survives a language switch (a re-render) and is dropped, and any stream aborted, the
// moment the visitor leaves this page.
const blank = () => ({ agent: '', model: 'auto', key: '', prompt: '' });
let draft = blank();
let live = null;
window.addEventListener('hashchange', () => {
  if (/^#\/playground(\?|$)/.test(location.hash)) return;
  live?.abort();
  live = null;
  draft = blank();
});

const label = (a) => (a.title ? `${a.title} · ${a.id}` : a.id);
const failure = async (res) => {
  const data = await res.json().catch(() => null);
  return new ApiError(res.status, data?.error?.code || `http_${res.status}`, data?.error?.message);
};

const STATE_TONE = { streaming: 'run', done: 'good', aborted: 'neutral', failed: 'error' };

export async function playground(root, ctx) {
  live?.abort();
  live = null;
  const page = pageWrap(root, loading());
  const agents = (await portal.agents()).data ?? [];
  const head = box('div', 'page-head', el('h1', t('play.title')), el('p', t('play.lede')));
  if (!agents.length) {
    page.replaceChildren(head, empty(t('play.no_agents')));
    return;
  }
  const byId = (id) => agents.find((a) => a.id === id) ?? agents[0];
  const first = byId(ctx.query.get('agent') || draft.agent);
  draft.agent = first.id;

  const agentSel = selectField(
    'play-agent',
    t('play.agent'),
    agents.map((a) => [a.id, label(a)]),
    first.id,
  );
  const modelSel = selectField('play-model', t('play.model'), [['auto', 'auto']], 'auto');
  modelSel.field.append(el('small', t('play.model_hint')));
  const key = field('play-key', t('play.key'), {
    type: 'password',
    required: true,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'sk-oaa-…',
  });
  key.input.value = draft.key;
  key.field.append(
    el('small', t('play.key_hint')),
    box('small', '', `${t('play.key_none')} `, link('#/keys', t('play.key_link'), 'text-link')),
  );
  const prompt = textareaField('play-prompt', t('play.prompt'), {
    rows: 6,
    required: true,
    placeholder: t('play.prompt_ph'),
  });
  prompt.input.value = draft.prompt;
  const billing = el('p', undefined, 'muted note');
  const send = button(t('play.send'), 'primary', null, 'send');
  send.type = 'submit';
  const stop = button(t('play.stop'), '', null, 'square');
  stop.disabled = true;
  const form = el('form', undefined, 'form play-form');
  form.noValidate = true;
  form.append(
    agentSel.field,
    modelSel.field,
    key.field,
    prompt.field,
    box('div', 'actions play-actions', send, stop),
    billing,
  );

  const out = el('pre');
  out.tabIndex = 0;
  out.setAttribute('aria-label', t('play.output'));
  const status = el('span');
  status.setAttribute('role', 'status');
  const problem = el('div');
  problem.setAttribute('aria-live', 'polite');
  const after = el('div', undefined, 'play-after');
  // The empty box says why it is empty: nothing yet, nothing came back, or it was stopped first.
  const idle = (why = 'idle') => {
    out.className = 'output is-empty';
    out.textContent = t(`play.${why}`);
  };
  idle();
  const setState = (name) =>
    status.replaceChildren(
      ...(name ? [el('span', t(`play.state.${name}`), `status ${STATE_TONE[name]}`)] : []),
    );

  // The agent decides the model lines and the price shown under the form.
  const syncAgent = () => {
    const agent = byId(agentSel.input.value);
    const models = agent.models?.length ? agent.models : ['auto'];
    modelSel.input.replaceChildren(
      ...models.map((m) => {
        const option = el('option', m);
        option.value = m;
        return option;
      }),
    );
    modelSel.input.value = models.includes(draft.model)
      ? draft.model
      : models.includes('auto')
        ? 'auto'
        : models[0];
    draft.agent = agent.id;
    draft.model = modelSel.input.value;
    billing.textContent = t('play.billing', { price: priceText(agent.price) });
  };
  syncAgent();
  agentSel.input.addEventListener('change', syncAgent);
  modelSel.input.addEventListener('change', () => (draft.model = modelSel.input.value));
  key.input.addEventListener('input', () => (draft.key = key.input.value));
  prompt.input.addEventListener('input', () => (draft.prompt = prompt.input.value));
  prompt.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !send.disabled) form.requestSubmit();
  });

  const working = (on) => {
    if (on) busy(send, true, t('play.sending'));
    else busy(send, false);
    stop.disabled = !on;
    agentSel.input.disabled = on;
    modelSel.input.disabled = on;
  };

  async function run() {
    const apiKey = key.input.value.trim();
    const text = prompt.input.value.trim();
    problem.replaceChildren();
    after.replaceChildren();
    const route = modelSel.input.value;
    const body = {
      model: agentSel.input.value,
      stream: true,
      messages: [{ role: 'user', content: text }],
    };
    if (route && route !== 'auto') body.metadata = { 'oaa.model': route };
    const controller = new AbortController();
    live = controller;
    working(true);
    const node = document.createTextNode('');
    out.className = 'output';
    out.replaceChildren(node);
    setState('streaming');
    let runId = '';
    const note = (chunk) => {
      if (chunk.error) throw new ApiError(0, chunk.error.code, chunk.error.message);
      if (!runId && typeof chunk.id === 'string') runId = chunk.id.replace(/^chatcmpl_/, '');
    };
    const append = (piece) => {
      const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
      node.appendData(piece);
      if (stick) out.scrollTop = out.scrollHeight;
    };
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw await failure(res);
      const type = res.headers.get('content-type') || '';
      if (type.includes('json')) {
        // A gateway that ignored `stream`: show the whole answer at once.
        const data = await res.json();
        note(data);
        append(data.choices?.[0]?.message?.content ?? '');
      } else {
        for await (const data of readSse(res.body)) {
          if (data === '[DONE]') break;
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          note(chunk);
          const piece = chunk.choices?.[0]?.delta?.content;
          if (piece) append(piece);
        }
      }
      setState('done');
    } catch (err) {
      if (controller.signal.aborted) setState('aborted');
      else {
        // fetch() rejects with a TypeError when the connection fails or drops mid-stream.
        const e = err instanceof ApiError ? err : new ApiError(0, 'connection_failed');
        problem.replaceChildren(
          notice(errorMessage(e), 'error'),
          e.code === 'insufficient_balance'
            ? box('div', 'actions', link('#/billing', t('play.top_up'), 'link-button'))
            : null,
        );
        setState('failed');
      }
    } finally {
      if (live === controller) live = null;
      working(false);
      if (!node.length)
        idle(
          controller.signal.aborted
            ? 'empty_aborted'
            : problem.firstChild
              ? 'empty_failed'
              : 'idle',
        );
      const pieces = [];
      if (runId)
        pieces.push(
          (() => {
            const a = link(runHref(runId), undefined, 'link-button');
            a.append(el('span', t('play.view_run')), icon('arrow-right'));
            return a;
          })(),
        );
      if (node.length) pieces.push(copyButton(() => node.data, 'quiet small'));
      after.replaceChildren(...pieces);
      icons();
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (validateForm(form)) run();
  });
  stop.addEventListener('click', () => live?.abort());

  const outHead = box('div', 'out-head', el('h2', t('play.output'), 'out-label'), status);
  page.replaceChildren(
    head,
    box(
      'div',
      'play-grid',
      form,
      box('section', 'play-out', outHead, box('div', 'output-block', out), problem, after),
    ),
  );
}
