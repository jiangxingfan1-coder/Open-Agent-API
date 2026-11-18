import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capabilitySchema, type ModelMessage } from '../src/core/contracts.js';
import { workerSchema } from '../src/config/config.js';
import { makeBundle } from '../src/lang/bundle.js';
import { agent, FixtureModel, setup, token, waitFor } from './helpers.js';

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const webUrl = (rel: string) => new URL(`../../web/${rel}`, import.meta.url).href;

function stubBrowserGlobals() {
  const storage = new Map<string, string>();
  const dummyEl = () => ({
    addEventListener: () => {},
    classList: { toggle: () => {} },
    hidden: false,
    open: false,
  });
  Object.assign(globalThis, {
    document: {
      documentElement: { lang: 'zh-CN', dataset: {} },
      getElementById: dummyEl,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: { origin: 'http://127.0.0.1:8787', hash: '#workbench' },
    window: {
      matchMedia: () => ({ matches: true, addEventListener: () => {} }),
      addEventListener: () => {},
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', platform: 'MacIntel' },
    configurable: true,
  });
}

test('console workbench assets return 200 with strict MIME and CSP on console host only', async () => {
  const CONSOLE = 'console.example.com';
  const API = 'api.example.com';
  const s = await setup(undefined, {
    allowedHosts: [CONSOLE, API, 'localhost'],
    consoleHosts: [CONSOLE],
  });
  try {
    const htmlRes = await s.app.inject({ method: 'GET', url: '/', headers: { host: CONSOLE } });
    assert.equal(htmlRes.statusCode, 200);
    assert.match(htmlRes.body, /href="#workbench"\s+data-view="workbench"/);
    assert.doesNotMatch(htmlRes.body, /\sstyle="/);
    assert.match(String(htmlRes.headers['content-security-policy']), /script-src 'self'/);

    const jsAssets = [
      '/views/workbench.js',
      '/views/workbench-sidebar.js',
      '/views/workbench-turns.js',
      '/views/workbench-stream.js',
      '/views/workbench-code.js',
      '/views/webhooks.js',
      '/lib/messages-views-workbench-zh.js',
      '/lib/messages-views-workbench-en.js',
    ];
    for (const url of jsAssets) {
      const ok = await s.app.inject({ method: 'GET', url, headers: { host: CONSOLE } });
      assert.equal(ok.statusCode, 200, url);
      assert.equal(ok.headers['content-type'], 'text/javascript; charset=utf-8', url);
      assert.match(String(ok.headers['content-security-policy']), /default-src 'self'/, url);

      const denied = await s.app.inject({ method: 'GET', url, headers: { host: API } });
      assert.equal(denied.statusCode, 404, `${url} must be hidden on API host`);
    }

    const cssRes = await s.app.inject({
      method: 'GET',
      url: '/styles/workbench.css',
      headers: { host: CONSOLE },
    });
    assert.equal(cssRes.statusCode, 200);
    assert.equal(cssRes.headers['content-type'], 'text/css; charset=utf-8');
    assert.match(String(cssRes.headers['content-security-policy']), /style-src 'self'/);
  } finally {
    await s.cleanup();
  }
});

test('workbench and webhooks scripts use safe DOM APIs and aligned bilingual dictionaries', async () => {
  const { zhWorkbench } = (await import(webUrl('lib/messages-views-workbench-zh.js'))) as {
    zhWorkbench: Record<string, string>;
  };
  const { enWorkbench } = (await import(webUrl('lib/messages-views-workbench-en.js'))) as {
    enWorkbench: Record<string, string>;
  };
  const { zh: coreZh } = (await import(webUrl('lib/messages-core-zh.js'))) as {
    zh: Record<string, string>;
  };
  const { en: coreEn } = (await import(webUrl('lib/messages-core-en.js'))) as {
    en: Record<string, string>;
  };

  assert.equal(coreZh['view.workbench.title'], '对话工作台');
  assert.equal(coreEn['view.workbench.title'], 'Workbench');
  assert.deepEqual(Object.keys(zhWorkbench).sort(), Object.keys(enWorkbench).sort());
  assert.ok(Object.keys(zhWorkbench).length >= 70);

  const files = [
    'web/views/workbench.js',
    'web/views/workbench-sidebar.js',
    'web/views/workbench-turns.js',
    'web/views/workbench-stream.js',
    'web/views/workbench-code.js',
    'web/views/webhooks.js',
  ];
  for (const file of files) {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/, file);
    assert.doesNotMatch(code, /\.style\b/, file);
  }

  stubBrowserGlobals();
  const createdNodes: { tag: string; textContent: string; className: string }[] = [];
  (globalThis.document as unknown as Record<string, unknown>).createElement = (tag: string) => {
    const node = {
      tag,
      textContent: '',
      className: '',
      translate: true,
      dataset: {} as Record<string, string>,
      children: [] as unknown[],
      append(...items: unknown[]) {
        node.children.push(...items);
      },
      replaceChildren(...items: unknown[]) {
        node.children = [...items];
      },
    };
    createdNodes.push(node);
    return node;
  };
  const { renderSafeText } = (await import(webUrl('views/workbench-turns.js'))) as {
    renderSafeText: (
      box: { replaceChildren: () => void; append: (...xs: unknown[]) => void },
      text: string,
    ) => void;
  };
  const container = {
    nodes: [] as { tag: string; textContent: string; className: string }[],
    replaceChildren() {
      this.nodes = [];
    },
    append(...xs: unknown[]) {
      this.nodes.push(...(xs as { tag: string; textContent: string; className: string }[]));
    },
  };
  renderSafeText(
    container,
    'Hello <img src=x onerror=alert(1)>\n\n```ts\nconst x = "<script>evil()</script>";\n```',
  );
  assert.equal(container.nodes.length, 2);
  assert.equal(container.nodes[0]!.tag, 'p');
  assert.equal(container.nodes[0]!.textContent, 'Hello <img src=x onerror=alert(1)>');
  assert.equal(container.nodes[1]!.tag, 'pre');
  assert.equal(container.nodes[1]!.textContent, 'const x = "<script>evil()</script>";');
  assert.equal(
    createdNodes.some((n) => n.tag === 'script' || n.tag === 'img'),
    false,
    'user or model HTML strings never instantiate DOM elements',
  );
});

test('workbench snippet generator produces valid curl, OpenAI, Claude and Gemini SDK code', async () => {
  stubBrowserGlobals();
  const codeMod = (await import(webUrl('views/workbench-code.js'))) as {
    CLIENT_TOOL_TEMPLATES: { name: string; parameters: Record<string, unknown> }[];
    buildWorkbenchSnippet: (dialect: string, cfg: Record<string, unknown>) => string;
  };
  assert.deepEqual(
    codeMod.CLIENT_TOOL_TEMPLATES.map((t) => t.name),
    ['get_workspace_status', 'apply_patch'],
  );

  const cfg = {
    originBase: 'http://127.0.0.1:8787',
    baseUrl: 'http://127.0.0.1:8787/v1',
    agentId: 'agent/coder',
    route: '@fast',
    prompt: 'Check status',
    images: [{ name: 'dot.png', mime: 'image/png', dataUrl: TINY_PNG }],
    toolMode: 'bridge',
    clientTools: codeMod.CLIENT_TOOL_TEMPLATES,
    project: 'proj-demo',
    recommend: true,
    previousResponseId: 'run_prev123',
  };

  const curl = codeMod.buildWorkbenchSnippet('curl', cfg);
  assert.match(curl, /\/v1\/compat\/responses/);
  assert.match(curl, /X-OAA-Client-Tools: bridge/);
  assert.match(curl, /"model": "agent\/coder@fast"/);
  assert.match(curl, /"previous_response_id": "run_prev123"/);
  assert.match(curl, /"get_workspace_status"/);
  assert.match(curl, /"input_image"/);

  const py = codeMod.buildWorkbenchSnippet('openai-py', cfg);
  assert.match(py, /from openai import OpenAI/);
  assert.match(py, /client\.responses\.create/);
  assert.match(py, /previous_response_id="run_prev123"/);

  const node = codeMod.buildWorkbenchSnippet('openai-node', cfg);
  assert.match(node, /import OpenAI from 'openai'/);
  assert.match(node, /"oaa\.orchestration_action": "recommend"/);

  const claude = codeMod.buildWorkbenchSnippet('claude', cfg);
  assert.match(claude, /import Anthropic from '@anthropic-ai\/sdk'/);
  assert.match(claude, /"input_schema"/);

  const gemini = codeMod.buildWorkbenchSnippet('gemini', cfg);
  assert.match(gemini, /GoogleGenAI/);
  assert.match(gemini, /functionDeclarations/);
});

test('workbench protocol contract: multi-turn streaming, image input, bridge continuation and owner approval', async () => {
  stubBrowserGlobals();
  const streamMod = (await import(webUrl('views/workbench-stream.js'))) as {
    parseSseFrames: (buf: string) => {
      frames: { event: string; id: string | null; data: Record<string, unknown> }[];
      rest: string;
    };
    buildResponsesRequest: (opts: Record<string, unknown>) => {
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
  };
  const { CLIENT_TOOL_TEMPLATES } = (await import(webUrl('views/workbench-code.js'))) as {
    CLIENT_TOOL_TEMPLATES: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[];
  };

  const seenHistory: ModelMessage[][] = [];
  const driver = new FixtureModel((_a, messages) => {
    seenHistory.push(messages.map((m) => ({ ...m })));
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    const lastText = String(messages.at(-1)?.content ?? '');
    if (lastText.includes('CALL_BRIDGE') && !toolMsgs.length) {
      return {
        text: 'Checking workspace.',
        calls: [{ id: 'c1', name: 'get_workspace_status', arguments: { include_untracked: true } }],
      };
    }
    if (lastText.includes('NEED_OWNER_APPROVAL') && !toolMsgs.length) {
      return { calls: [{ id: 'g1', name: 'guarded_write', arguments: {} }] };
    }
    if (toolMsgs.length) {
      return { text: `Bridge result: ${toolMsgs.map((m) => m.content).join('|')}` };
    }
    return { text: `Turn ${seenHistory.length} ok` };
  });

  const s = await setup(driver, { approvalTimeoutMs: 10_000 });
  try {
    s.runtime.config.providers.fixture = workerSchema.parse({
      nodeId: 'local',
      dataDir: s.dir,
      providers: { fixture: { kind: 'openai-responses', imageInput: 'inline' } },
    }).providers.fixture!;
    const guardedCap = capabilitySchema.parse({
      id: 'fixture/guarded_write',
      version: '1',
      description: 'Guarded tool for workbench approval test',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'write',
      requiresApproval: true,
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'guarded_write',
      capability: guardedCap,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('guarded_write', async () => ({ value: 'approved-ok' }));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/wb',
          tools: [
            {
              name: 'guarded_write',
              capability: guardedCap,
              handler: { kind: 'node', reference: 'guarded_write' },
            },
          ],
        }),
      ),
    );

    // 1. Turn 1 with inline PNG image + Turn 2 with previous_response_id
    const turn1Req = streamMod.buildResponsesRequest({
      agentId: 'agent/wb',
      route: 'auto',
      input: 'First turn with image',
      imageParts: [{ type: 'input_image', image_url: TINY_PNG }],
      toolMode: 'auto',
    });
    const r1 = await s.request('POST', '/v1/responses', turn1Req.body, token, turn1Req.headers);
    assert.equal(r1.statusCode, 200, r1.body);
    const run1Id = r1.headers['x-run-id'] as string;
    const frames1 = streamMod.parseSseFrames(r1.body).frames;
    assert.ok(frames1.some((f) => f.event === 'response.output_text.delta'));
    assert.ok(frames1.some((f) => f.event === 'response.completed'));

    const turn2Req = streamMod.buildResponsesRequest({
      agentId: 'agent/wb',
      route: 'auto',
      input: 'Second turn follow-up',
      previousResponseId: run1Id,
    });
    const r2 = await s.request('POST', '/v1/responses', turn2Req.body, token, turn2Req.headers);
    assert.equal(r2.statusCode, 200, r2.body);
    assert.ok(
      seenHistory.at(-1)!.some((m) => m.content.includes('Turn 1 ok')),
      'second turn carries previous_response_id context',
    );

    // 2. Caller bridge tool pause (waiting_on === 'caller') and tool_outputs continuation
    const bridgeReq1 = streamMod.buildResponsesRequest({
      agentId: 'agent/wb',
      route: 'auto',
      input: 'Please CALL_BRIDGE now',
      toolMode: 'bridge',
      clientTools: CLIENT_TOOL_TEMPLATES,
    });
    const b1 = await s.request('POST', '/v1/responses', bridgeReq1.body, token, bridgeReq1.headers);
    assert.equal(b1.statusCode, 200, b1.body);
    const bridgeRunId = b1.headers['x-run-id'] as string;
    const b1Frames = streamMod.parseSseFrames(b1.body).frames;
    const completedFrame = b1Frames.find((f) => f.event === 'response.completed')!;
    const completedResp = completedFrame.data.response as {
      metadata: Record<string, string>;
      output: { type: string; call_id?: string; name?: string }[];
    };
    assert.equal(completedResp.metadata['oaa.status'], 'requires_action');
    const fnCall = completedResp.output.find((o) => o.type === 'function_call')!;
    assert.equal(fnCall.name, 'get_workspace_status');
    assert.ok(fnCall.call_id);

    const bridgeReq2 = streamMod.buildResponsesRequest({
      agentId: 'agent/wb',
      route: 'auto',
      toolMode: 'bridge',
      clientTools: CLIENT_TOOL_TEMPLATES,
      previousResponseId: bridgeRunId,
      toolOutputs: [{ call_id: fnCall.call_id, output: '{"branch":"feat/wb","clean":true}' }],
    });
    const b2 = await s.request('POST', '/v1/responses', bridgeReq2.body, token, bridgeReq2.headers);
    assert.equal(b2.statusCode, 200, b2.body);
    assert.equal(b2.headers['x-run-id'], bridgeRunId, 'continues on the exact same run');
    const b2Deltas = streamMod
      .parseSseFrames(b2.body)
      .frames.filter((f) => f.event === 'response.output_text.delta')
      .map((f) => String(f.data.delta))
      .join('');
    assert.match(b2Deltas, /feat\/wb/);

    // 3. Owner approval pause (waiting_on === 'owner') and inline Approve resolution
    const approvalRun = await s.request('POST', '/v1/responses', {
      model: 'agent/wb',
      input: 'Please NEED_OWNER_APPROVAL',
      background: true,
    });
    const ownerRunId = approvalRun.json().id as string;
    await waitFor(() => s.store.run(ownerRunId).status === 'requires_action');
    const actionsRes = await s.request('GET', `/v1/runs/${ownerRunId}/actions?offset=0&limit=10`);
    assert.equal(actionsRes.statusCode, 200);
    const pendingAction = actionsRes.json().data[0] as { id: string; kind: string };
    assert.ok(pendingAction && pendingAction.kind !== 'client_tool');

    const decided = await s.request(
      'POST',
      `/v1/runs/${ownerRunId}/actions/${encodeURIComponent(pendingAction.id)}`,
      { decision: 'approve', response: {} },
    );
    assert.equal(decided.statusCode, 200);
    await waitFor(() => s.store.run(ownerRunId).status === 'completed');
  } finally {
    await s.cleanup();
  }
});

test('webhooks CRUD UI contract: create with one-time secret, list, test, deliveries and delete', async () => {
  const s = await setup();
  try {
    const emptyList = await s.request('GET', '/v1/webhooks');
    assert.equal(emptyList.statusCode, 200);
    assert.deepEqual(emptyList.json().data, []);

    const created = await s.request('POST', '/v1/webhooks', {
      url: 'https://hooks.example.com/oaa-events',
      events: ['run.requires_action', 'run.completed', 'run.failed'],
      description: 'Workbench webhook contract test',
      include_output: true,
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = created.json() as {
      id: string;
      secret: string;
      url: string;
      events: string[];
      description: string;
    };
    assert.ok(createdBody.id);
    assert.ok(typeof createdBody.secret === 'string' && createdBody.secret.length >= 16);
    assert.equal(createdBody.description, 'Workbench webhook contract test');

    const listed = await s.request('GET', '/v1/webhooks');
    assert.equal(listed.statusCode, 200);
    const row = listed.json().data[0] as Record<string, unknown>;
    assert.equal(row.id, createdBody.id);
    assert.equal('secret' in row, false, 'secret is never returned again after creation');

    const testDelivery = await s.request(
      'POST',
      `/v1/webhooks/${encodeURIComponent(createdBody.id)}/test`,
      {},
    );
    assert.equal(testDelivery.statusCode, 202, testDelivery.body);
    assert.equal(testDelivery.json().event_type, 'webhook.test');

    const deliveries = await s.request(
      'GET',
      `/v1/webhooks/${encodeURIComponent(createdBody.id)}/deliveries?limit=6`,
    );
    assert.equal(deliveries.statusCode, 200);
    const items = deliveries.json().data as Record<string, unknown>[];
    assert.equal(items.length, 1);
    for (const field of ['id', 'event_type', 'status', 'attempts', 'http_status', 'updated_at']) {
      assert.ok(field in items[0]!, `delivery missing ${field}`);
    }

    const removed = await s.request('DELETE', `/v1/webhooks/${encodeURIComponent(createdBody.id)}`);
    assert.equal(removed.statusCode, 204);

    const afterDelete = await s.request('GET', '/v1/webhooks');
    assert.deepEqual(afterDelete.json().data, []);
  } finally {
    await s.cleanup();
  }
});
