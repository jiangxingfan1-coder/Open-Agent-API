/*
 * 开发者门户的离线假网关：只在截图流水线里使用，不属于产品。shoot.mjs 在页面 <head> 里于 app.js 之前注入，
 * 由 window.__SHOT = { lang, text } 提供语言与演示文字（见 texts.mjs）。固定时钟、假登录会话、固定的演示数据。
 */
(() => {
  const { lang, text: T } = window.__SHOT;
  try {
    localStorage.setItem('oaa.portal.session.v1', 'oas_harness');
    localStorage.setItem('oaa.portal.lang', lang);
  } catch {}
  const NOW = Date.UTC(2026, 10, 12, 8, 30);
  const RealDate = Date;
  window.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(NOW);
    }
    static now() {
      return NOW;
    }
  };
  const D = 86400e3;
  const BASE = 'https://api.example.com';
  const keys = [
    {
      id: 'key_a1b2c3',
      name: T.keys.prod,
      created_at: NOW - 40 * D,
      revoked: false,
      usage: { used_runs: 18234, used_tokens: 48200000 },
      quota: { rpm: 60, maxConcurrentRuns: 2 },
    },
    {
      id: 'key_d4e5f6',
      name: 'staging',
      created_at: NOW - 12 * D,
      revoked: false,
      usage: { used_runs: 12, used_tokens: 3400 },
      quota: {},
    },
  ];
  const json = (data, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  window.fetch = async (input, opts = {}) => {
    const url = new URL(String(input), 'http://harness.local');
    const path = url.pathname;
    const method = (opts.method || 'GET').toUpperCase();
    if (path === '/v1/portal/site')
      return json({
        site_name: 'Open Agent API',
        registration: 'open',
        version: '0.6.5',
        base_url: BASE,
        endpoints: {
          openai_sdk_base_url: `${BASE}/v1`,
          responses_endpoint: `${BASE}/v1/responses`,
        },
      });
    if (path === '/v1/portal/account')
      return json({
        account: {
          id: 'acc_1',
          email: 'dev@example.com',
          name: 'Dev',
          balance: 1280.5,
          created_at: NOW - 60 * D,
        },
      });
    if (path === '/v1/portal/keys' && method === 'GET') return json({ data: keys });
    if (path === '/v1/portal/agents')
      return json({
        data: T.portalAgents.map(([id, title, description, price]) => ({
          id,
          title,
          description,
          engine: 'kernel',
          price,
        })),
      });
    return json({ error: { code: 'route_not_found', message: `harness: ${method} ${path}` } }, 404);
  };
})();
