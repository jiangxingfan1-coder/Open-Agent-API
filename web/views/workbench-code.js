import { sdkBaseUrl, state } from '../lib/state.js';
import { copyButton, copyText, el, iconButton, icons } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

export const CLIENT_TOOL_TEMPLATES = [
  {
    name: 'get_workspace_status',
    description: 'Read git branch and modified file status from the caller workspace.',
    parameters: {
      type: 'object',
      properties: {
        include_untracked: {
          type: 'boolean',
          description: 'Whether untracked files should be listed.',
        },
      },
    },
    sampleResult: '{"branch":"main","clean":false,"modified":["src/index.ts"]}',
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff patch to a file in the caller workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        diff: { type: 'string', description: 'Unified diff patch to apply.' },
      },
      required: ['path', 'diff'],
    },
    sampleResult: '{"applied":true,"hunks":1}',
  },
];

export function targetModelName(agentId, route) {
  const base = agentId || 'agent/example';
  if (!route || route === 'auto') return base;
  return `${base}@${String(route).replace(/^@/, '')}`;
}

function splitDataUrl(dataUrl) {
  const comma = String(dataUrl || '').indexOf(',');
  if (comma < 0) return { mime: 'image/png', data: '' };
  const head = dataUrl.slice(5, comma);
  const mime = head.split(';')[0] || 'image/png';
  return { mime, data: dataUrl.slice(comma + 1) };
}

function buildMetadata({ project, recommend, handoff }) {
  const meta = {};
  if (project) meta['oaa.project'] = project;
  if (recommend) meta['oaa.orchestration_action'] = 'recommend';
  if (handoff) meta['oaa.handoff'] = 'true';
  return meta;
}

export function buildWorkbenchSnippet(dialect, config) {
  const originBase =
    config.originBase ||
    state.data?.endpoints?.base_url ||
    state.data?.public_base_url ||
    (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:8787');
  const v1Base = config.baseUrl || sdkBaseUrl();
  const compatBase = state.data?.endpoints?.openai_compat_base_url || `${originBase}/v1/compat`;
  const model = targetModelName(config.agentId, config.route);
  const prompt = (config.prompt || '').trim() || t('wb.code.samplePrompt');
  const images = Array.isArray(config.images) ? config.images : [];
  const tools = Array.isArray(config.clientTools) ? config.clientTools : [];
  const toolMode = config.toolMode || 'auto';
  const hasTools = tools.length > 0;
  const meta = buildMetadata(config);
  const hasMeta = Object.keys(meta).length > 0;
  const openAiBase = hasTools ? compatBase : v1Base;
  const responsesInput = images.length
    ? [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            ...images.map((img) => ({ type: 'input_image', image_url: img.dataUrl })),
          ],
        },
      ]
    : prompt;
  const responsesTools = tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters || { type: 'object', properties: {} },
  }));

  if (dialect === 'curl') {
    const endpoint = hasTools ? `${compatBase}/responses` : `${v1Base}/responses`;
    const payload = {
      model,
      input: responsesInput,
      stream: true,
      ...(config.previousResponseId ? { previous_response_id: config.previousResponseId } : {}),
      ...(hasTools ? { tools: responsesTools } : {}),
      ...(hasMeta ? { metadata: meta } : {}),
    };
    const headerLines = [
      `curl ${endpoint} \\`,
      '  -H "Authorization: Bearer $OAA_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -H "X-OAA-Progress: reasoning" \\',
    ];
    if (hasTools || toolMode !== 'auto') {
      headerLines.push(`  -H "X-OAA-Client-Tools: ${toolMode}" \\`);
    }
    const json = JSON.stringify(payload, null, 2).replace(/'/g, "'\\''");
    return `${headerLines.join('\n')}\n  -d '${json}'`;
  }

  if (dialect === 'openai-py') {
    const headers = {
      'X-OAA-Progress': 'reasoning',
      ...(hasTools || toolMode !== 'auto' ? { 'X-OAA-Client-Tools': toolMode } : {}),
    };
    const args = [
      `    model=${JSON.stringify(model)},`,
      `    input=${JSON.stringify(responsesInput)},`,
      ...(config.previousResponseId
        ? [`    previous_response_id=${JSON.stringify(config.previousResponseId)},`]
        : []),
      ...(hasTools ? [`    tools=${JSON.stringify(responsesTools)},`] : []),
      ...(hasMeta ? [`    metadata=${JSON.stringify(meta)},`] : []),
      '    stream=True,',
    ];
    return [
      'import os',
      'from openai import OpenAI',
      '',
      'client = OpenAI(',
      `    base_url=${JSON.stringify(openAiBase)},`,
      '    api_key=os.environ["OAA_API_KEY"],',
      `    default_headers=${JSON.stringify(headers)},`,
      ')',
      '',
      'stream = client.responses.create(',
      ...args,
      ')',
      'for event in stream:',
      '    if event.type == "response.output_text.delta":',
      '        print(event.delta, end="", flush=True)',
    ].join('\n');
  }

  if (dialect === 'openai-node') {
    const headers = {
      'X-OAA-Progress': 'reasoning',
      ...(hasTools || toolMode !== 'auto' ? { 'X-OAA-Client-Tools': toolMode } : {}),
    };
    const body = {
      model,
      input: responsesInput,
      ...(config.previousResponseId ? { previous_response_id: config.previousResponseId } : {}),
      ...(hasTools ? { tools: responsesTools } : {}),
      ...(hasMeta ? { metadata: meta } : {}),
      stream: true,
    };
    return [
      "import OpenAI from 'openai';",
      '',
      'const client = new OpenAI({',
      `  baseURL: ${JSON.stringify(openAiBase)},`,
      '  apiKey: process.env.OAA_API_KEY,',
      `  defaultHeaders: ${JSON.stringify(headers)},`,
      '});',
      '',
      `const stream = await client.responses.create(${JSON.stringify(body, null, 2)});`,
      'for await (const event of stream) {',
      "  if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);",
      '}',
    ].join('\n');
  }

  if (dialect === 'claude') {
    const claudeHeaders = {
      ...(hasTools || toolMode !== 'auto' ? { 'X-OAA-Client-Tools': toolMode } : {}),
    };
    const claudeContent = images.length
      ? [
          ...images.map((img) => {
            const { mime, data } = splitDataUrl(img.dataUrl);
            return { type: 'image', source: { type: 'base64', media_type: mime, data } };
          }),
          { type: 'text', text: prompt },
        ]
      : prompt;
    const claudeTools = tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters || { type: 'object', properties: {} },
    }));
    const reqObj = {
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: claudeContent }],
      ...(hasTools ? { tools: claudeTools } : {}),
      stream: true,
    };
    return [
      "import Anthropic from '@anthropic-ai/sdk';",
      '',
      'const client = new Anthropic({',
      `  baseURL: ${JSON.stringify(originBase)},`,
      '  apiKey: process.env.OAA_API_KEY,',
      ...(Object.keys(claudeHeaders).length
        ? [`  defaultHeaders: ${JSON.stringify(claudeHeaders)},`]
        : []),
      '});',
      '',
      `const stream = await client.messages.create(${JSON.stringify(reqObj, null, 2)});`,
      'for await (const event of stream) {',
      "  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {",
      '    process.stdout.write(event.delta.text);',
      '  }',
      '}',
    ].join('\n');
  }

  // Gemini SDK (@google/genai)
  const geminiParts = [
    ...images.map((img) => {
      const { mime, data } = splitDataUrl(img.dataUrl);
      return { inlineData: { mimeType: mime, data } };
    }),
    { text: prompt },
  ];
  const geminiTools = hasTools
    ? [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parametersJsonSchema: tool.parameters || { type: 'object', properties: {} },
          })),
        },
      ]
    : undefined;
  const geminiHeaders = {
    'X-OAA-Progress': 'reasoning',
    ...(hasTools || toolMode !== 'auto' ? { 'X-OAA-Client-Tools': toolMode } : {}),
  };
  return [
    "import { GoogleGenAI } from '@google/genai';",
    '',
    'const ai = new GoogleGenAI({',
    '  apiKey: process.env.OAA_API_KEY,',
    `  httpOptions: { baseUrl: ${JSON.stringify(originBase)}, headers: ${JSON.stringify(geminiHeaders)} },`,
    '});',
    '',
    'const response = await ai.models.generateContentStream({',
    `  model: ${JSON.stringify(model)},`,
    `  contents: [{ role: 'user', parts: ${JSON.stringify(geminiParts)} }],`,
    ...(geminiTools ? [`  config: { tools: ${JSON.stringify(geminiTools)} },`] : []),
    '});',
    'for await (const chunk of response) {',
    '  if (chunk.text) process.stdout.write(chunk.text);',
    '}',
  ].join('\n');
}

const DIALECT_TABS = [
  ['curl', 'cURL'],
  ['openai-py', 'OpenAI Python'],
  ['openai-node', 'OpenAI Node.js'],
  ['claude', 'Claude SDK'],
  ['gemini', 'Gemini SDK'],
];

export function openWorkbenchCodeDialog(config) {
  const opener = document.activeElement;
  const dialog = el('dialog', undefined, 'modal wide-modal wb-code-modal');
  const header = el('div', undefined, 'dialog-heading');
  const titleWrap = el('div');
  titleWrap.append(el('h2', t('wb.code.title')), el('p', t('wb.code.desc'), 'dialog-desc'));
  header.append(
    titleWrap,
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );

  let activeDialect = 'curl';
  const bar = el('div', undefined, 'snippet-head');
  const tabs = el('div', undefined, 'segmented small');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', t('wb.code.langAria'));
  const pre = el('pre', '', 'code wb-code-pre');
  const copyBtn = copyButton(t('wb.code.copyLabel'), () =>
    copyText(pre.textContent, t('wb.code.copied')),
  );

  const renderCode = () => {
    for (const btn of tabs.querySelectorAll('button')) {
      const active = btn.dataset.dialect === activeDialect;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    pre.textContent = buildWorkbenchSnippet(activeDialect, config);
  };

  for (const [id, label] of DIALECT_TABS) {
    const btn = el('button', label);
    btn.type = 'button';
    btn.dataset.dialect = id;
    btn.translate = false;
    btn.onclick = () => {
      activeDialect = id;
      renderCode();
    };
    tabs.append(btn);
  }

  bar.append(tabs, copyBtn);
  const metaRow = el('div', undefined, 'wb-code-meta');
  metaRow.append(
    el('span', targetModelName(config.agentId, config.route), 'tag tide'),
    el('span', `X-OAA-Client-Tools: ${config.toolMode || 'auto'}`, 'tag'),
  );
  if (config.previousResponseId) {
    metaRow.append(el('span', `previous_response_id: ${config.previousResponseId}`, 'tag'));
  }
  if (config.clientTools?.length) {
    metaRow.append(el('span', t('wb.tools.countBadge', { n: config.clientTools.length }), 'tag'));
  }

  dialog.append(header, metaRow, bar, pre);
  document.body.append(dialog);
  renderCode();
  dialog.showModal();
  icons();
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      if (opener && typeof opener.focus === 'function') opener.focus();
    },
    { once: true },
  );
}
