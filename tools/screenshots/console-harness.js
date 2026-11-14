/*
 * 离线假网关：只在截图流水线里使用，不属于产品。shoot.mjs 在页面 <head> 里于 boot.js 之前注入它，
 * 由 window.__SHOT = { lang, text } 提供语言与演示文字（见 texts.mjs）。它做几件事：
 *   1. 预置一个假的连接令牌与外观偏好（主题由 __SHOT.theme 决定）、界面语言（__SHOT.lang）；
 *   2. 冻结时钟（2026-11-12 08:30 UTC，显示为本地 16:30），相对时间（「1 分钟前」）因此可重复；
 *   3. 用一套固定的演示数据替换 fetch：概览、活动、任务列表与任务详情、密钥；
 *   4. 把 /agents/*.svg 的图片指向仓库里的 web/agents/。
 * 数据都是编出来的示例：example.com 域名、明显的假密钥，不含真实密钥与个人信息。
 */
(() => {
  const { lang, text: T, theme, webBase } = window.__SHOT;
  try {
    sessionStorage.setItem('oaa-token', 'sk-oaa-harness');
    localStorage.setItem('oaa.console.lang', lang);
    localStorage.setItem(
      'oaa.prefs.v1',
      JSON.stringify({
        theme,
        palette: 'black',
        density: 'comfortable',
        sidebar: 'expanded',
        checklist: 'hidden',
        activityWindow: '24h',
        refresh: 0,
        motion: 'reduce',
      }),
    );
  } catch {}

  const FIXED = Date.UTC(2026, 10, 12, 8, 30);
  const RealDate = Date;
  window.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(FIXED);
    }
    static now() {
      return FIXED;
    }
  };
  const now = FIXED;
  const M = 60e3;
  const H = 3600e3;
  const D = 24 * H;

  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    set(v) {
      desc.set.call(this, String(v).startsWith('/agents/') ? webBase + v : v);
    },
    get() {
      return desc.get.call(this);
    },
  });

  const conv = (tier) => ({
    tier,
    access: 'kernel',
    streaming: tier === 'basic' ? 'final' : 'token',
    approvals: tier === 'interactive' ? 'bridged' : 'denied',
    cancel: 'cooperative',
    resume: 'none',
    tool_events: 'tool',
    usage: 'reported',
    artifacts: true,
  });
  const rt = (id, model) => ({ id, model, available: true });
  const tool = (name, placement) => ({ name, placement });
  const skills = (names) => names.map((name) => ({ name }));
  const agentDefs = [
    [
      'agent/research',
      [rt('default', 'standard'), rt('fast', 'fast'), rt('deep', 'deep')],
      [
        tool('web.search', 'portable'),
        tool('fs.read', 'host-bound'),
        tool('http.fetch', 'portable'),
      ],
      skills(T.skills.research),
      'interactive',
    ],
    ['agent/writer', [rt('default', 'standard')], [], skills(T.skills.writer), 'interactive'],
    [
      'agent/coder',
      [rt('default', 'standard'), rt('fast', 'fast')],
      [
        tool('fs.read', 'host-bound'),
        tool('fs.write', 'host-bound'),
        tool('shell.exec', 'host-bound'),
      ],
      [],
      'interactive',
    ],
    [
      'agent/reviewer',
      [rt('default', 'standard')],
      [tool('fs.read', 'host-bound')],
      skills(T.skills.reviewer),
      'interactive',
    ],
    ['agent/translate', [rt('default', 'fast')], [], skills(T.skills.translate), 'basic'],
    [
      'agent/finance-recon',
      [rt('default', 'standard'), rt('deep', 'deep')],
      [tool('a', 'portable')],
      [],
      'interactive',
    ],
    ['agent/sql', [rt('default', 'standard')], [], [], 'interactive'],
  ];
  const agents = agentDefs.map(([id, routes, tools, skillList, tier]) => ({
    id,
    engine: 'kernel',
    description: T.agents[id],
    status: 'ready',
    ready: true,
    routes,
    tools,
    skills: skillList,
    approvals: 'owner',
    preset: null,
    conversion: conv(tier),
    version: 'v3.2.1-9f2c4e1a7b',
    workflows: [],
    delegates: [],
  }));

  const run = (id, agent, input, status, ago, ms, extra = {}) => ({
    id,
    agent,
    input,
    status,
    created_at: now - ago,
    elapsed_ms: ms,
    model: 'default',
    ...extra,
  });
  const R = T.runs;
  const runs = [
    run('run_8f2a91c04e7b', 'agent/coder', R.coder_login, 'requires_action', 90e3, 41e3),
    run('run_77c0de8a2c4d', 'agent/research', R.research_pricing, 'requires_action', 4 * M, 120e3, {
      waiting_on: 'caller',
    }),
    run('run_a1c2e49b7d3f', 'agent/reviewer', R.reviewer_orders, 'interrupted', 22 * M, 600e3),
    run('run_3d5e91c0b8a7', 'agent/writer', R.writer_board, 'in_progress', 40e3, 38e3),
    run('run_c0ffee5a1b2c', 'agent/translate', R.translate_notes, 'queued', 5e3, 0, {
      queue: { position: 3, estimated_start_ms: 28e3 },
    }),
    run('run_0001a2b3c4d5', 'agent/research', R.research_quotes, 'completed', 12 * M, 84e3, {
      model: 'standard',
    }),
    run('run_0002a2b3c4d5', 'agent/research', R.research_feedback, 'completed', 50 * M, 143e3, {
      model: 'standard',
    }),
    run('run_0003a2b3c4d5', 'agent/coder', R.coder_ci, 'failed', 2 * H, 7200, {
      model: 'standard',
    }),
    run('run_0004a2b3c4d5', 'agent/finance-recon', R.finance_q3, 'completed', 3 * H, 5 * M + 12e3, {
      model: 'deep',
    }),
    run('run_0005a2b3c4d5', 'agent/writer', '', 'cancelled', 5 * H, 3100),
    run('run_0006a2b3c4d5', 'agent/sql', R.sql_paid_at, 'completed', 9 * H, 31e3, {
      model: 'standard',
    }),
    run(
      'run_0007a2b3c4d5',
      'agent/research',
      R.research_compare,
      'completed',
      1 * D + 2 * H,
      66e3,
      {
        model: 'standard',
      },
    ),
    run('run_0008a2b3c4d5', 'agent/translate', R.translate_contract, 'completed', 2 * D, 9400, {
      model: 'fast',
    }),
    run('run_0009a2b3c4d5', 'agent/coder', R.coder_pagination, 'completed', 3 * D, 4 * M + 3e3, {
      model: 'standard',
    }),
  ];
  const nodes = [
    {
      nodeId: 'workstation-01',
      active: 2,
      concurrency: 4,
      accepting: true,
      local: true,
      admission_state: 'active',
      warm: ['agent/research', 'agent/coder', 'agent/writer'],
      providers: ['anthropic', 'openai'],
      natives: ['codex', 'claude'],
      capabilities: [{ id: 'fs.read' }, { id: 'shell.exec' }],
    },
    {
      nodeId: 'build-01.internal.example.com',
      active: 7,
      concurrency: 8,
      accepting: true,
      local: false,
      admission_state: 'active',
      warm: ['agent/research'],
      providers: ['openai'],
      natives: [],
      capabilities: [{ id: 'browser' }, { id: 'docker' }, { id: 'fs.read' }, { id: 'fs.write' }],
    },
    {
      nodeId: 'laptop-guest',
      active: 0,
      concurrency: 1,
      accepting: false,
      local: false,
      admission_state: 'draining',
      warm: [],
      providers: [],
      natives: ['gemini'],
      capabilities: [],
    },
  ];
  const keys = [
    {
      id: 'k1',
      name: T.keys.prod,
      managed: true,
      revoked: false,
      scopes: ['read', 'invoke', 'files'],
      agents: ['agent/research', 'agent/writer'],
      usage: { usedRuns: 18234, usedTokens: 482000000 },
      quota: { expiresAt: now + 60 * D },
    },
    {
      id: 'k2',
      name: 'staging',
      managed: true,
      revoked: false,
      scopes: ['read', 'invoke'],
      agents: ['*'],
      usage: { usedRuns: 12, usedTokens: 3400 },
      quota: {},
    },
    {
      id: 'k3',
      name: T.keys.long,
      managed: true,
      revoked: false,
      scopes: ['read', 'invoke', 'files', 'approve'],
      agents: ['agent/coder', 'agent/reviewer', 'agent/translate', 'agent/sql'],
      usage: { usedRuns: 0, usedTokens: 0 },
      quota: { expiresAt: now - 3 * D },
    },
    {
      id: 'k4',
      name: 'admin.token',
      managed: false,
      revoked: false,
      scopes: ['read', 'invoke', 'files', 'approve', 'admin'],
      agents: ['*'],
      usage: null,
      quota: {},
    },
  ];
  const BASE = 'https://api.example.com';
  const overview = {
    principal: {
      name: 'owner-admin',
      owner: 'owner',
      scopes: ['read', 'invoke', 'files', 'approve', 'admin'],
      agents: ['*'],
    },
    agents,
    runs: runs.slice(0, 9),
    nodes,
    metrics: {
      runs: 2418,
      completed: 2290,
      active: 4,
      queued: 1,
      in_progress: 1,
      requires_action: 2,
      awaiting_caller: 1,
      total_tokens: 1820000000,
    },
    endpoints: {
      base_url: BASE,
      openai_sdk_base_url: `${BASE}/v1`,
      responses_endpoint: `${BASE}/v1/responses`,
      chat_completions_endpoint: `${BASE}/v1/chat/completions`,
      openai_compat_base_url: `${BASE}/v1/compat`,
      claude_messages_endpoint: `${BASE}/v1/messages`,
      gemini_models_prefix: `${BASE}/v1beta/models`,
      uap_endpoint: `${BASE}/v1/uap`,
      universal_endpoint: `${BASE}/v1/universal`,
      worker_connect_ws: 'wss://api.example.com/v1/nodes/connect',
    },
    public_base_url: BASE,
  };
  const buckets = (n, ms) =>
    Array.from({ length: n }, (_, i) => {
      const started = Math.max(
        0,
        Math.round(
          14 + 12 * Math.sin(i / 2.3) + (i % 5) * 3 + (i > n - 4 ? 20 : 0) - (i < 3 ? 14 : 0),
        ),
      );
      const failed = started > 18 && i % 4 === 0 ? 3 : 0;
      const cancelled = i % 7 === 0 ? 1 : 0;
      const interrupted = i % 11 === 0 && started ? 1 : 0;
      const active = i === n - 1 ? 4 : 0;
      return {
        start: new Date(now - (n - i) * ms).toISOString(),
        started,
        completed: Math.max(0, started - failed - cancelled - interrupted - active),
        failed,
        cancelled,
        interrupted,
        active,
      };
    });
  const activity = (w) => {
    const b = w === '7d' ? buckets(28, 6 * H) : buckets(24, H);
    const sum = (k) => b.reduce((a, x) => a + x[k], 0);
    return {
      window: w,
      bucket_ms: w === '7d' ? 6 * H : H,
      buckets: b,
      totals: {
        started: sum('started'),
        completed: sum('completed'),
        failed: sum('failed'),
        cancelled: sum('cancelled'),
        interrupted: sum('interrupted'),
        active: sum('active'),
        success_rate: 0.943,
      },
      latency_ms: { samples: 312, p50: 41e3, p95: 612e3 },
      breakdown_ms: {
        model: 5.2e6,
        tools: 3.1e6,
        queue: 0.4e6,
        approval: 2.2e6,
        other: 0.3e6,
        runs: 312,
      },
      agents: agentDefs.map(([id], i) => ({
        agent: id,
        runs: 120 - i * 11,
        completed: 100 - i * 10,
        failed: i % 3,
        p50_ms: 20e3 + i * 7e3,
      })),
    };
  };

  const detail = {
    run_8f2a91c04e7b: {
      status: 'requires_action',
      agent: 'agent/coder',
      model: 'standard',
      steps: 6,
      actions: [
        {
          id: 'act_91a0c7e2',
          kind: 'tool',
          expires_at: now + 8 * M,
          detail: {
            bytes: 118,
            truncated: false,
            preview: JSON.stringify(
              { tool: 'shell.exec', command: 'npm test -- --run auth', cwd: '/workspace/webapp' },
              null,
              2,
            ),
          },
        },
      ],
    },
  };
  const detailFor = (id) =>
    detail[id] ?? { status: 'completed', agent: 'agent/research', model: 'standard', steps: 4 };
  const json = (data, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const notFound = (method, path) =>
    json({ error: { code: 'route_not_found', message: `harness: ${method} ${path}` } }, 404);

  window.fetch = async (input, opts = {}) => {
    const url = new URL(String(input), 'http://harness.local');
    const path = url.pathname;
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (path === '/v1/overview') return json(overview);
    if (path === '/health')
      return json({
        status: 'ok',
        version: '0.6.5',
        features: [
          'overview-events-v1',
          'error-codes-v1',
          'error-catalog-v1',
          'overview-activity-v1',
          'run-timeline-v1',
          'local-backends-v1',
          'conversion-profile-v1',
          'client-tools-policy-v1',
          'platform-setup-v1',
        ],
      });
    if (path === '/v1/overview/activity')
      return json(activity(url.searchParams.get('window') || '24h'));
    if (path === '/v1/keys' && method === 'GET') return json({ data: keys });
    if (path === '/v1/keys' && method === 'POST')
      return json(
        {
          id: 'k9',
          token: 'sk-oaa-exampleexampleexampleexampleexampleexample000000',
          name: body.name,
          scopes: body.scopes,
          agents: body.agents,
          models: body.models,
          base_url: `${BASE}/v1`,
        },
        201,
      );
    if (path === '/v1/runs' && method === 'GET') return json({ data: runs });
    const m = /^\/v1\/runs\/([^/]+)\/(state|steps|actions|artifacts|timeline|output)$/.exec(path);
    if (m) {
      const [, id, what] = m;
      const d = detailFor(id);
      if (what === 'state')
        return json({
          id,
          status: d.status,
          agent: d.agent,
          engine: 'kernel',
          route: { model: d.model },
          usage: { total_tokens: 482310 },
          usage_complete: true,
          error: null,
          output: { characters: T.outputCoder.length },
          steps: { total: d.steps, uncertain: 0 },
          artifact_count: 0,
          pending_actions: (d.actions ?? []).map((a) => ({ kind: a.kind })),
          queue: null,
        });
      if (what === 'steps') {
        const names = ['fs.read', 'fs.read', 'fs.read', 'fs.write', 'fs.read', 'fs.write'];
        const list = Array.from({ length: d.steps }, (_, i) => ({
          id: `step_${i + 1}`,
          name: names[i % names.length],
          node_id: 'workstation-01',
          status: 'completed',
          reconciled: false,
        }));
        return json({ data: list, total: list.length, next_offset: null });
      }
      if (what === 'actions') {
        const a = d.actions ?? [];
        return json({ data: a, total: a.length, next_offset: null });
      }
      if (what === 'artifacts') return json({ data: [], total: 0, next_offset: null });
      if (what === 'timeline') return notFound(method, path);
      if (what === 'output')
        return json({
          text: T.outputCoder,
          done: false,
          waiting_for_output: false,
          next_cursor: null,
        });
    }
    return notFound(method, path);
  };
})();
