// 控制台画面：把 recording.json 里的接口快照离线喂给真实的控制台前端（web/），逐个镜头截图。
// 每个镜头一张 PNG（2 倍像素，推移时依然清晰）加一份 JSON（页面里关键元素的位置，供光标对准）。
// 页面以 file:// 打开：index.html 里的绝对路径改写成 web/ 的 file URL，其余照原样加载，
// 所以截到的是产品当前的真实界面，不是仿制品。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from './chrome.mjs';
import { findForbidden } from './scrub.mjs';

export const CONSOLE_VIEWPORT = { width: 1280, height: 720, scale: 2 };

/**
 * @typedef {{
 *   name: string, snapshot: string, hash?: string, openRun?: string,
 *   rects?: Record<string, string>, ready?: string
 * }} ConsoleShot
 */

const sha = (...parts) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

async function buildPage({ repo, here, work, label, snapshot, lang }) {
  const web = path.join(repo, 'web');
  const url = (p) => pathToFileURL(p).href;
  let html = await readFile(path.join(web, 'index.html'), 'utf8');
  html = html.replace(/(href|src)="\/([^"]*)"/g, (_m, attr, p) => {
    const target =
      p === 'icons.js'
        ? path.join(repo, 'node_modules/lucide/dist/umd/lucide.js')
        : path.join(web, p);
    return `${attr}="${url(target)}"`;
  });
  const boot = `<script src="${url(path.join(web, 'boot.js'))}"></script>`;
  if (!html.includes(boot))
    throw new Error('web/index.html 里找不到 boot.js 的引用，回放注入点失效。');
  const replay = {
    snapshot: { captured_at: snapshot.captured_at, routes: snapshot.routes },
    lang,
    webBase: url(web).replace(/\/$/, ''),
  };
  html = html.replace(
    boot,
    `<script>window.__REPLAY=${JSON.stringify(replay).replaceAll('<', '\\u003c')}</script>\n` +
      `<script src="${url(path.join(here, 'scenes/console-replay.js'))}"></script>\n${boot}`,
  );
  // 录制画面不需要对话框的淡入与背景模糊（模糊在无头模式下偶尔会带来逐帧差异）。
  html = html.replace(
    '</head>',
    // 过长的任务 ID 不成为画面焦点：在检查器标题与审批卡片里自然截断（只有回放页这样，产品本身不变）。
    '<style>*{animation:none!important;transition:none!important}dialog::backdrop{backdrop-filter:none!important}' +
      '#run-title{display:block;max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.approval-row summary code{display:inline-block;max-width:18ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}' +
      '</style></head>',
  );
  const file = path.join(work, `console-${label}.html`);
  await writeFile(file, html);
  return file;
}

/**
 * 逐个截图。已存在且输入没变（快照、web/ 之外的脚本、镜头定义）的结果直接沿用。
 * @param {{repo:string, here:string, work:string, recording:any, shots:ConsoleShot[], stamp?:string, force?:boolean, log?:(s:string)=>void, lang?:'zh'|'en', emptyOutputText?:string}} o
 */
export async function shootConsole({
  repo,
  here,
  work,
  recording,
  shots,
  stamp = '',
  force = false,
  log = () => {},
  lang = 'zh',
  emptyOutputText = '暂无输出',
}) {
  await mkdir(work, { recursive: true });
  const replayScript =
    (await readFile(path.join(here, 'scenes/console-replay.js'), 'utf8')) +
    (await readFile(new URL(import.meta.url), 'utf8'));
  const out = {};
  const pages = new Map();
  let chrome = null;
  try {
    for (const shot of shots) {
      const snapshot = recording.snapshots[shot.snapshot];
      if (!snapshot || typeof snapshot !== 'object')
        throw new Error(`recording.json 里没有快照 ${shot.snapshot}（镜头 ${shot.name}）。`);
      const key = sha(
        JSON.stringify(shot),
        JSON.stringify(snapshot),
        replayScript,
        stamp,
        ...(lang === 'zh' ? ['v1'] : ['v1', lang]),
      );
      const png = path.join(work, `${shot.name}.png`);
      const meta = path.join(work, `${shot.name}.json`);
      if (!force && existsSync(png) && existsSync(meta)) {
        const cached = JSON.parse(await readFile(meta, 'utf8'));
        if (cached.key === key) {
          out[shot.name] = { png, ...cached };
          log(`  控制台 ${shot.name}：沿用缓存`);
          continue;
        }
      }
      chrome ??= await Chrome.launch(CONSOLE_VIEWPORT);
      if (!pages.has(shot.snapshot))
        pages.set(
          shot.snapshot,
          await buildPage({ repo, here, work, label: shot.snapshot, snapshot, lang }),
        );
      const page = pages.get(shot.snapshot);
      await chrome.goto(`${pathToFileURL(page).href}${shot.hash ? `#${shot.hash}` : ''}`);
      // 等前端把首屏画出来：目标元素出现 + 字体就绪。
      const ready = shot.ready ?? '.main .list-row, .main table, .main .empty-state';
      await chrome.evaluate(`(async () => {
        const until = Date.now() + 15000;
        while (!document.querySelector(${JSON.stringify(ready)})) {
          if (Date.now() > until) throw new Error('控制台首屏没有出现：' + ${JSON.stringify(ready)});
          await new Promise((r) => setTimeout(r, 50));
        }
        await document.fonts.ready;
      })()`);
      if (shot.openRun) {
        const id = shot.openRun;
        await chrome.evaluate(`(async () => {
          window.oaaShell.openRun(${JSON.stringify(id)});
          const until = Date.now() + 15000;
          const done = () => document.getElementById('run-dialog').open &&
            document.getElementById('run-output').textContent.trim() !== '' &&
            document.getElementById('run-output').textContent !== ${JSON.stringify(emptyOutputText)} ||
            document.getElementById('run-dialog').open && document.querySelector('#run-actions .action-card, #run-actions button');
          while (!done()) {
            if (Date.now() > until) throw new Error('任务检查器没有打开：${id}');
            await new Promise((r) => setTimeout(r, 50));
          }
          await new Promise((r) => setTimeout(r, 400));
        })()`);
      }
      await chrome.evaluate(
        'document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))',
      );
      // 兜底：画面上不得出现本机路径、file:// 链接或密钥；命中就拒绝，并指出是哪个镜头、哪段文字。
      const visible = await chrome.evaluate('document.body.innerText');
      const bad = findForbidden(visible);
      if (bad)
        throw new Error(
          `控制台镜头 ${shot.name}（快照 ${shot.snapshot}）的画面文字里有不该上镜的内容：${bad.pattern} 附近「${bad.context}」。` +
            '请检查 recording.json 里对应的数据（录制导出时本应已遮蔽）。',
        );
      const rects = await chrome.evaluate(`(() => {
        const out = {};
        for (const [name, selector] of Object.entries(${JSON.stringify(shot.rects ?? {})})) {
          // 「选择器::text(文字)」：在匹配的元素里挑文字包含该串的第一个（如按钮的名字）。
          const m = /^(.*)::text\\((.*)\\)$/.exec(selector);
          const node = m
            ? [...document.querySelectorAll(m[1])].find((n) => n.textContent.includes(m[2]))
            : document.querySelector(selector);
          if (!node) { out[name] = null; continue; }
          const r = node.getBoundingClientRect();
          out[name] = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return out;
      })()`);
      const bytes = await chrome.screenshot();
      await writeFile(png, bytes);
      const record = { key, width: CONSOLE_VIEWPORT.width, height: CONSOLE_VIEWPORT.height, rects };
      await writeFile(meta, JSON.stringify(record, null, 2));
      out[shot.name] = { png, ...record };
      log(`  控制台 ${shot.name}：已截图（${(bytes.length / 1024).toFixed(0)} KiB）`);
    }
  } finally {
    await chrome?.close();
  }
  return out;
}
