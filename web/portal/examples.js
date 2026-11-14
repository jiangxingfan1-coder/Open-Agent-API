import { t } from './i18n.js';
import { box, copyButton, el } from './dom.js';
import { endpoints } from './state.js';

let tabSeq = 0;

export function codeBlock(text) {
  const wrap = el('div', undefined, 'code-block');
  const pre = el('pre', text);
  pre.tabIndex = 0;
  const copy = copyButton(() => text);
  copy.classList.add('copy');
  wrap.append(pre, copy);
  return wrap;
}

// [{ label, code }] -> an ARIA tab set. Left/Right/Home/End move between the tabs.
export function codeTabs(items, ariaLabel) {
  const id = ++tabSeq;
  const list = el('div', undefined, 'tablist');
  list.setAttribute('role', 'tablist');
  if (ariaLabel) list.setAttribute('aria-label', ariaLabel);
  const panel = el('div');
  panel.setAttribute('role', 'tabpanel');
  const tabs = items.map((item, i) => {
    const b = el('button', item.label);
    b.type = 'button';
    b.id = `tab-${id}-${i}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', `panel-${id}`);
    b.addEventListener('click', () => select(i));
    list.append(b);
    return b;
  });
  panel.id = `panel-${id}`;
  function select(index, focus = false) {
    tabs.forEach((b, i) => {
      b.setAttribute('aria-selected', String(i === index));
      b.tabIndex = i === index ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', tabs[index].id);
    panel.replaceChildren(codeBlock(items[index].code));
    if (focus) tabs[index].focus();
  }
  list.addEventListener('keydown', (e) => {
    const current = tabs.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const last = tabs.length - 1;
    const next = {
      ArrowRight: current === last ? 0 : current + 1,
      ArrowLeft: current === 0 ? last : current - 1,
      Home: 0,
      End: last,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next, true);
  });
  select(0);
  return box('div', 'code-tabs', list, panel);
}

const q = (s) => JSON.stringify(s);

// The four ways to make the same call, with the agent ID as `model` and a placeholder key.
export function callExamples(agentId) {
  const { origin, openai, responses } = endpoints();
  const prompt = t('example.prompt');
  return [
    {
      label: 'curl',
      code: [
        `curl ${responses} \\`,
        `  -H "Authorization: Bearer $OAA_API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify({ model: agentId, input: prompt }, null, 2).replace(/\n/g, '\n  ')}'`,
      ].join('\n'),
    },
    {
      label: 'Python',
      code: [
        'import os',
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `    base_url=${q(openai)},`,
        '    api_key=os.environ["OAA_API_KEY"],',
        ')',
        '',
        'response = client.responses.create(',
        `    model=${q(agentId)},`,
        `    input=${q(prompt)},`,
        ')',
        'print(response.output_text)',
      ].join('\n'),
    },
    {
      label: 'Node.js',
      code: [
        'import OpenAI from "openai";',
        '',
        'const client = new OpenAI({',
        `  baseURL: ${q(openai)},`,
        '  apiKey: process.env.OAA_API_KEY,',
        '});',
        '',
        'const response = await client.responses.create({',
        `  model: ${q(agentId)},`,
        `  input: ${q(prompt)},`,
        '});',
        'console.log(response.output_text);',
      ].join('\n'),
    },
    {
      label: 'Claude',
      code: [
        'import os',
        'from anthropic import Anthropic',
        '',
        'client = Anthropic(',
        `    base_url=${q(origin)},`,
        '    api_key=os.environ["OAA_API_KEY"],',
        ')',
        '',
        'message = client.messages.create(',
        `    model=${q(agentId)},`,
        '    max_tokens=1024,',
        `    messages=[{"role": "user", "content": ${q(prompt)}}],`,
        ')',
        'print(message.content[0].text)',
      ].join('\n'),
    },
  ];
}

export function streamingExample(agentId) {
  const { openai } = endpoints();
  return [
    'import os',
    'from openai import OpenAI',
    '',
    `client = OpenAI(base_url=${q(openai)}, api_key=os.environ["OAA_API_KEY"])`,
    '',
    'stream = client.responses.create(',
    `    model=${q(agentId)},`,
    `    input=${q(t('example.prompt'))},`,
    '    stream=True,',
    ')',
    'for event in stream:',
    '    if event.type == "response.output_text.delta":',
    '        print(event.delta, end="", flush=True)',
  ].join('\n');
}

export function backgroundExamples(agentId) {
  const { openai, responses } = endpoints();
  const prompt = t('example.prompt_long');
  return [
    {
      label: 'curl',
      code: [
        `# ${t('example.submit')}`,
        `curl ${responses} \\`,
        `  -H "Authorization: Bearer $OAA_API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify({ model: agentId, input: prompt, background: true }).replace(/'/g, "'\\''")}'`,
        '',
        `# ${t('example.poll')}`,
        `curl ${responses}/RESPONSE_ID \\`,
        `  -H "Authorization: Bearer $OAA_API_KEY"`,
      ].join('\n'),
    },
    {
      label: 'Python',
      code: [
        'import os',
        'from openai import OpenAI',
        '',
        `client = OpenAI(base_url=${q(openai)}, api_key=os.environ["OAA_API_KEY"])`,
        '',
        'response = client.responses.create(',
        `    model=${q(agentId)},`,
        `    input=${q(prompt)},`,
        '    background=True,',
        ')',
        '',
        '# ' + t('example.later'),
        'result = client.responses.retrieve(response.id)',
        'print(result.status, result.output_text)',
      ].join('\n'),
    },
  ];
}
