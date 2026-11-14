// README 与展示页里的产品截图：用离线假数据驱动真实的控制台与门户前端（web/），无头 Chrome 截图，
// 裁剪、压成调色板 PNG。不启动网关、不监听端口、不联网：页面是 file://，数据由 console-harness.js /
// portal-harness.js 里的假 fetch 提供（文字在 texts.mjs，中英两套同一份演示数据）。
//
//   node tools/screenshots/shoot.mjs --lang en --out DIR [--site-out DIR]
//        [--only hero,runs,inspector,api-key,portal] [--themes light,dark]
//
// 输出：DIR/<名字>-<light|dark>[-en].png（README 用的尺寸，2 倍像素）；加 --site-out 时再出一套展示页用的尺寸
// （同一张图缩到展示页的宽度）。中文版文件名不带后缀，英文版带 -en。
// 需要：Chrome（见 tools/demo-video/lib/chrome.mjs）、PATH 里的 ffmpeg（压调色板与缩放）、node_modules/lucide。
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Chrome } from '../demo-video/lib/chrome.mjs';
import { TEXTS } from './texts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const WEB = path.join(REPO, 'web');
const USAGE =
  '用法：node tools/screenshots/shoot.mjs --lang zh|en --out DIR [--site-out DIR] [--only hero,runs,inspector,api-key,portal] [--themes light,dark]';
const { values } = parseArgs({
  options: {
    lang: { type: 'string' },
    out: { type: 'string' },
    'site-out': { type: 'string' },
    only: { type: 'string' },
    themes: { type: 'string' },
    colors: { type: 'string' },
  },
});
const fatal = (message) => {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
};
const lang = values.lang;
if (lang !== 'zh' && lang !== 'en') fatal('--lang 必须是 zh 或 en。');
if (!values.out) fatal('需要 --out DIR。');
const themes = (values.themes ?? 'light,dark').split(',');
if (themes.some((t) => t !== 'light' && t !== 'dark')) fatal('--themes 只能是 light、dark。');
const ALL = ['hero', 'runs', 'inspector', 'api-key', 'portal'];
const only = values.only ? values.only.split(',') : ALL;
if (only.some((n) => !ALL.includes(n))) fatal(`--only 只能是：${ALL.join('、')}。`);
const colors = Number(values.colors ?? 160);
const out = path.resolve(values.out);
const siteOut = values['site-out'] ? path.resolve(values['site-out']) : null;
const suffix = lang === 'en' ? '-en' : '';
const work = path.join(out, '.work');
await mkdir(out, { recursive: true });
await mkdir(work, { recursive: true });
if (siteOut) await mkdir(siteOut, { recursive: true });
const log = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (p) => pathToFileURL(p).href;
const LUCIDE = path.join(REPO, 'node_modules/lucide/dist/umd/lucide.js');

// 各张图：视口高度、裁剪（CSS 像素；null 表示取对话框的外框）、展示页里的宽度。
const SPEC = {
  hero: { height: 1000, crop: { x: 0, y: 0, width: 1440, height: 985 }, siteWidth: 2240 },
  runs: { height: 900, crop: { x: 0, y: 0, width: 1440, height: 640 }, siteWidth: null },
  inspector: { height: 1000, crop: { x: 0, y: 0, width: 1440, height: 780 }, siteWidth: 2240 },
  'api-key': { height: 1000, crop: null, siteWidth: 1120 },
  portal: { height: 1000, crop: { x: 0, y: 0, width: 1440, height: 728 }, siteWidth: 2240 },
};

const ffmpeg = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg 失败（${code}）：${err.slice(-400)}`)),
    );
  });
/** 全彩 PNG → 调色板 PNG（不抖动），可选缩到指定宽度。 */
async function palette(src, dest, width) {
  const scale = width ? `scale=${width}:-2:flags=lanczos,` : '';
  await ffmpeg([
    '-i',
    src,
    '-filter_complex',
    `[0:v]${scale}split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full[p];[b][p]paletteuse=dither=none`,
    '-frames:v',
    '1',
    dest,
  ]);
}

async function waitFor(chrome, expression, what, ms = 15000) {
  await chrome.evaluate(`(async () => {
    const until = Date.now() + ${ms};
    while (!(${expression})) {
      if (Date.now() > until) throw new Error('等不到：' + ${JSON.stringify(what)});
      await new Promise((r) => setTimeout(r, 50));
    }
  })()`);
}
const settle = (chrome) =>
  chrome.evaluate(
    'document.fonts.ready.then(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 700)))',
  );
async function setViewport(chrome, height) {
  await chrome.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
}

// ── 页面 ─────────────────────────────────────────────────────────────────────
const harness = {
  console: await readFile(path.join(HERE, 'console-harness.js'), 'utf8'),
  portal: await readFile(path.join(HERE, 'portal-harness.js'), 'utf8'),
};
/** 控制台：index.html 里的绝对路径改成 web/ 的 file URL，在 boot.js 之前注入假网关。 */
async function consolePage(theme) {
  let html = await readFile(path.join(WEB, 'index.html'), 'utf8');
  html = html.replace(
    /(href|src)="\/([^"]*)"/g,
    (_m, attr, p) => `${attr}="${url(p === 'icons.js' ? LUCIDE : path.join(WEB, p))}"`,
  );
  const boot = `<script src="${url(path.join(WEB, 'boot.js'))}"></script>`;
  if (!html.includes(boot)) throw new Error('web/index.html 里找不到 boot.js 的引用，注入点失效。');
  const shot = { lang, text: TEXTS[lang], theme, webBase: url(WEB).replace(/\/$/, '') };
  html = html.replace(
    boot,
    `<script>window.__SHOT=${JSON.stringify(shot).replaceAll('<', '\\u003c')}</script>\n<script>${harness.console}</script>\n${boot}`,
  );
  html = html.replace(
    '</head>',
    '<style>*,*::before,*::after{animation:none!important;transition:none!important}dialog::backdrop{backdrop-filter:none!important}</style></head>',
  );
  const file = path.join(work, `console-${lang}-${theme}.html`);
  await writeFile(file, html);
  return file;
}
/**
 * 门户：模块脚本里有 ./shared/…（线上由网关映射到 web/shared/），字体在 ../fonts/（同样的映射），
 * 所以在工作目录里拼一棵与线上同样形状的目录树（符号链接），把假网关注入 app.js 之前。
 */
async function portalPage() {
  const site = path.join(work, 'portal-site');
  await rm(site, { recursive: true, force: true });
  await mkdir(site, { recursive: true });
  const dir = path.join(WEB, 'portal');
  for (const entry of await readdir(dir)) {
    if (entry !== 'index.html') await symlink(path.join(dir, entry), path.join(site, entry));
  }
  await symlink(path.join(WEB, 'shared'), path.join(site, 'shared'));
  await symlink(path.join(WEB, 'fonts'), path.join(site, 'fonts'));
  await symlink(LUCIDE, path.join(site, 'icons.js'));
  let html = await readFile(path.join(dir, 'index.html'), 'utf8');
  const app = '<script type="module" src="./app.js"></script>';
  if (!html.includes(app))
    throw new Error('web/portal/index.html 里找不到 app.js 的引用，注入点失效。');
  const shot = { lang, text: TEXTS[lang] };
  html = html.replace(
    app,
    `<script>window.__SHOT=${JSON.stringify(shot).replaceAll('<', '\\u003c')}</script>\n<script>${harness.portal}</script>\n${app}`,
  );
  html = html.replace(
    '</head>',
    '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>',
  );
  const file = path.join(site, 'index.html');
  await writeFile(file, html);
  return file;
}

// ── 截图 ─────────────────────────────────────────────────────────────────────
const raw = (name, theme) => path.join(work, `${name}-${theme}-raw.png`);
const bad = [];
async function capture(chrome, name, theme, clip) {
  // 英文版的画面里不该有汉字（演示数据本身就是英文的）：有就记下来，最后以非零退出码结束。
  if (lang === 'en') {
    const han = await chrome.evaluate(
      `(document.body.innerText.match(/[\\u3400-\\u9fff\\uff00-\\uffef\\u3000-\\u303f]+/g) || []).join(' | ')`,
    );
    // 语言切换按钮的文字「中文」是界面本来就有的（用各自的语言写语言名），不算。
    const extra = han.split(' | ').filter((t) => t && t !== '中文');
    if (extra.length) bad.push(`${name}-${theme}：${extra.join(' | ').slice(0, 120)}`);
  }
  const png = await chrome.screenshot({ clip });
  const file = raw(name, theme);
  await writeFile(file, png);
  return file;
}
async function finish(name, theme) {
  const src = raw(name, theme);
  const file = `${name}-${theme}${suffix}.png`;
  await palette(src, path.join(out, file));
  if (siteOut && SPEC[name].siteWidth)
    await palette(src, path.join(siteOut, file), SPEC[name].siteWidth);
  log(`  ${file}`);
}

const chrome = await Chrome.launch({ width: 1440, height: 1000, scale: 2 });
process.on('unhandledRejection', async (error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  await chrome.close().catch(() => {});
  process.exit(1);
});
try {
  // 时区固定为 UTC+8：画面上的「更新于 16:30」不随本机时区变化。
  await chrome.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
  await chrome
    .send('Emulation.setLocaleOverride', { locale: lang === 'zh' ? 'zh-CN' : 'en-US' })
    .catch(() => {});
  for (const theme of themes) {
    log(`${lang} · ${theme}`);
    const page = await consolePage(theme);
    const open = async (hash, ready, height) => {
      await setViewport(chrome, height);
      await chrome.goto(`${url(page)}#${hash}`);
      await waitFor(chrome, `document.querySelector(${JSON.stringify(ready)})`, ready);
      await settle(chrome);
    };
    if (only.includes('hero')) {
      await open('overview', '.attention-row', SPEC.hero.height);
      await capture(chrome, 'hero', theme, SPEC.hero.crop);
    }
    if (only.includes('runs')) {
      await open('requests', '.main table tbody tr', SPEC.runs.height);
      await capture(chrome, 'runs', theme, SPEC.runs.crop);
    }
    if (only.includes('inspector')) {
      await open('requests', '.main table tbody tr', SPEC.inspector.height);
      await chrome.evaluate(`void window.oaaShell.openRun('run_8f2a91c04e7b')`);
      await waitFor(
        chrome,
        `document.getElementById('run-dialog')?.open && document.querySelector('#run-actions .approval-row') && document.getElementById('run-output').textContent.trim().length > 20`,
        'inspector',
      );
      await settle(chrome);
      await capture(chrome, 'inspector', theme, SPEC.inspector.crop);
    }
    if (only.includes('api-key')) {
      await open('keys', '#primary-action', SPEC['api-key'].height);
      await chrome.evaluate(`document.querySelector('#primary-action').click()`);
      await waitFor(chrome, `document.querySelector('#key-agent-list .key-agent')`, 'key dialog');
      await chrome.evaluate(`(async () => {
        document.querySelector('#key-agent-list .key-agent').click();
        await new Promise((r) => setTimeout(r, 300));
        document.querySelector('#key-name').value = ${JSON.stringify(TEXTS[lang].keys.prod)};
        document.querySelector('#key-form').requestSubmit();
      })()`);
      await waitFor(
        chrome,
        `document.querySelector('dialog[open]') && /sk-oaa-/.test(document.querySelector('dialog[open]').innerText)`,
        'key result',
      );
      await settle(chrome);
      const r = await chrome.evaluate(
        `(() => { const b = document.querySelector('dialog[open]').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`,
      );
      await capture(chrome, 'api-key', theme, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    }
    if (only.includes('portal')) {
      await chrome.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      });
      await setViewport(chrome, SPEC.portal.height);
      await chrome.goto(`${url(await portalPage())}#/`);
      await waitFor(chrome, `document.querySelector('#main h1')`, 'portal home');
      await settle(chrome);
      await capture(chrome, 'portal', theme, SPEC.portal.crop);
    }
    for (const name of only) await finish(name, theme);
  }
  if (chrome.pageErrors.length)
    log(`页面报错（${chrome.pageErrors.length}）：${chrome.pageErrors.slice(0, 3).join(' | ')}`);
} finally {
  await chrome.close();
}
if (bad.length) {
  process.stderr.write(`英文版截图里有汉字：\n- ${bad.join('\n- ')}\n`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
log(`完成：${out}${siteOut ? `（展示页尺寸：${siteOut}）` : ''}`);
