/*
 * 离线回放：把 recording.json 里的接口快照喂给真实的控制台前端（web/）。
 * 只在渲染流水线里使用，不属于产品。它做四件事：
 *   1. 用快照里的响应替换 fetch（路由对不上就回 404，让前端走它自己的「旧网关」分支）；
 *   2. 冻结时钟，并把快照里所有时间整体平移到一个中性的钟点（本地时间 10:00）：「3 分钟前」「已等待 12 秒」
 *      之类的相对时间不变且可重复，右上角的「更新于 HH:MM」与「到期」时刻也不再暴露录制时的本机时间；
 *   3. 预置一个假的连接令牌与外观偏好（浅色，隐藏新手清单），前端不会弹连接对话框；
 *   4. 把 /agents/*.svg 的图片指向仓库里的 web/agents/。
 * 由 console-shots.mjs 在页面 <head> 里于 boot.js 之前注入；快照与目录由 window.__REPLAY 提供。
 */
(() => {
  const { snapshot, webBase, lang = 'zh' } = window.__REPLAY;
  const RealDate = Date;
  const FIXED = new RealDate(2026, 10, 14, 10, 0, 0).getTime();
  const DELTA = FIXED - snapshot.captured_at;
  // 毫秒时间戳（数字）与 ISO 时间串一并平移；其余字段（如 revision 这种更大的数）不动。
  const shift = (v) => {
    if (typeof v === 'number') return v >= 1e12 && v < 4e12 ? v + DELTA : v;
    if (typeof v === 'string')
      return /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)
        ? new RealDate(RealDate.parse(v) + DELTA).toISOString()
        : v;
    if (Array.isArray(v)) return v.map(shift);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
    return v;
  };
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(FIXED);
    }
    static now() {
      return FIXED;
    }
  }
  window.Date = FrozenDate;

  try {
    sessionStorage.setItem('oaa-token', 'sk-oaa-demo-replay');
    // The console language is whatever the cut asks for, whatever language the headless browser reports.
    localStorage.setItem('oaa.console.lang', lang);
    localStorage.setItem(
      'oaa.prefs.v1',
      JSON.stringify({
        theme: 'light',
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

  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    set(value) {
      descriptor.set.call(
        this,
        String(value).startsWith('/agents/') ? webBase + String(value) : value,
      );
    },
    get() {
      return descriptor.get.call(this);
    },
  });

  const routes = shift(snapshot.routes);
  const find = (url) => {
    const u = new URL(url, 'http://replay.invalid');
    const full = u.pathname + u.search;
    if (routes[full]) return routes[full];
    // 分页参数在回放里不起作用：同一路径只录了一页。
    if (u.pathname.startsWith('/v1/overview/activity')) return routes[`${u.pathname}?window=24h`];
    const prefix = Object.keys(routes).find((key) => key.split('?')[0] === u.pathname);
    return prefix ? routes[prefix] : undefined;
  };
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url, 'http://replay.invalid').pathname === '/v1/overview/events')
      return new Response('', { status: 404 });
    const hit = find(url);
    if (!hit) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'not recorded' } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response(
      hit.status === 204
        ? null
        : typeof hit.body === 'string'
          ? hit.body
          : JSON.stringify(hit.body),
      { status: hit.status, headers: { 'content-type': 'application/json' } },
    );
  };
})();
