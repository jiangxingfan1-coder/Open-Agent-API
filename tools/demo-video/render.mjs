// 演示视频的渲染：recording.json → 逐镜渲染 → ffmpeg 合成。
//
//   node tools/demo-video/render.mjs --recording DIR/recording.json --out OUT_DIR
//        [--lang zh|en] [--work DIR] [--jobs 3] [--only open,edit] [--force] [--no-webm] [--no-gif] [--copy FILE]
//   调试：加 --frame edit:9.4,run:8 只把这几个时刻各截一张图到 --work/preview/，不合成。
//
// 确定性：每一帧由 scenes/*.js 里「镜内时间 → DOM 状态」的纯函数决定，页面不读真实时钟。
// 控制台画面：把 recording.json 里的接口快照离线喂给真实的控制台前端（web/）后截图（见 lib/console-shots.mjs）。
// 只用 file:// 与无头 Chrome（通过管道控制，不监听端口）、本机的 ffmpeg；不联网。
// 可断点重跑：已渲染的镜头按内容摘要缓存在 --work/frames/ 下，只有受影响的镜头才重画。
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Chrome } from './lib/chrome.mjs';
import { shootConsole } from './lib/console-shots.mjs';
import { SCREEN_FORBIDDEN, SECRET_SHAPES } from './lib/scrub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FPS = 30;
const USAGE =
  '用法：node tools/demo-video/render.mjs --recording PATH/recording.json --out DIR [--lang zh|en] [--work DIR] [--jobs 3] [--only open,edit] [--force] [--no-webm] [--no-gif] [--copy FILE] [--frame 镜头:秒,镜头:秒]';

const { values } = parseArgs({
  options: {
    recording: { type: 'string' },
    out: { type: 'string' },
    work: { type: 'string' },
    jobs: { type: 'string' },
    only: { type: 'string' },
    force: { type: 'boolean' },
    'no-webm': { type: 'boolean' },
    'no-gif': { type: 'boolean' },
    copy: { type: 'string' },
    lang: { type: 'string' },
    frame: { type: 'string' },
  },
});
const fatal = (message) => {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
};
if (!values.recording || !values.out) fatal('需要 --recording 与 --out。');
const lang = values.lang ?? 'zh';
if (lang !== 'zh' && lang !== 'en') fatal('--lang 只能是 zh 或 en。');
// 文件名：中文版 demo.*，英文版 demo-en.*（与 README 里引用的名字一致）。
const stem = lang === 'en' ? 'demo-en' : 'demo';
const jobs = Math.max(
  1,
  Math.min(6, Number(values.jobs ?? Math.max(2, Math.min(4, cpus().length >> 1)))),
);
const out = path.resolve(values.out);
const work = path.resolve(values.work ?? path.join(out, lang === 'en' ? '.work-en' : '.work'));
const log = (line) => process.stdout.write(`${line}\n`);
const sha = (...parts) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

const recording = JSON.parse(await readFile(path.resolve(values.recording), 'utf8'));
if (recording.schema !== 1) fatal(`不认识的 recording.json 版本：${recording.schema}`);
if (recording.problems?.length)
  log(
    `注意：这份录制带着问题记录（${recording.problems.length} 条），渲染可能缺内容：${recording.problems[0]}`,
  );
if (recording.lang && recording.lang !== lang)
  log(
    `注意：这份录制的提示词与回答是${recording.lang === 'en' ? '英文' : '中文'}的，成片是${lang === 'en' ? '英文' : '中文'}版：` +
      '真实问答原样保留，不翻译（这样的成片只能当草稿，正式版请用与成片同语言的提示词重新录制，见 README）。',
  );
else if (!recording.lang && lang === 'en')
  log(
    '注意：这份录制没有语言标记（旧版 record.mjs 录的，提示词与回答是中文）。英文版草稿里的真实问答会保持中文原样。',
  );
const copy = JSON.parse(
  await readFile(
    path.resolve(values.copy ?? path.join(HERE, lang === 'en' ? 'copy.en.json' : 'copy.json')),
    'utf8',
  ),
);
// 控制台界面里的几处文字：用来定位元素（按钮、行）与判断「输出为空」，随界面语言变化。
const UI = {
  zh: { openRow: (id) => `打开任务 ${id}`, approve: '批准', noOutput: '暂无输出' },
  en: { openRow: (id) => `Open task ${id}`, approve: 'Approve', noOutput: 'No output yet' },
}[lang];
await mkdir(out, { recursive: true });
await mkdir(work, { recursive: true });

// ── 1. 控制台画面 ─────────────────────────────────────────────────────────────
const taskRun = recording.snapshots.tasks?.focus_runs?.[0];
const approvalRun = recording.snapshots.approval_pending?.focus_runs?.[0];
if (!taskRun || !approvalRun)
  fatal('recording.json 里缺少任务快照或审批快照（录制是否完整？见 problems）。');
const stamp = (() => {
  // web/ 里源文件的路径、大小、修改时间：前端改了就重新截图。
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'fonts' || entry.name === 'agents' || entry.name === 'portal') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        files.push(
          `${path.relative(REPO, full)}:${statSync(full).size}:${Math.round(statSync(full).mtimeMs)}`,
        );
    }
  };
  walk(path.join(REPO, 'web'));
  return sha(...files.sort());
})();
log('控制台画面');
const consoleShots = await shootConsole({
  repo: REPO,
  here: HERE,
  work: path.join(work, 'console'),
  recording,
  stamp,
  force: values.force,
  log,
  lang,
  emptyOutputText: UI.noOutput,
  shots: [
    {
      name: 'tasks-list',
      snapshot: 'tasks',
      hash: 'requests',
      rects: { row: `tr[aria-label="${UI.openRow(taskRun)}"]` },
    },
    { name: 'tasks-inspector', snapshot: 'tasks', hash: 'requests', openRun: taskRun },
    {
      name: 'ap-overview',
      snapshot: 'approval_pending',
      hash: 'overview',
      ready: '.attention-row',
      rects: { go: '.attention-row' },
    },
    {
      name: 'ap-inspector',
      snapshot: 'approval_pending',
      hash: 'requests',
      openRun: approvalRun,
      rects: { approve: `.approval-controls button::text(${UI.approve})` },
    },
    { name: 'ap-done', snapshot: 'approval_done', hash: 'requests', openRun: approvalRun },
  ],
});

// ── 2. 渲染页 ────────────────────────────────────────────────────────────────
const pageDir = path.join(work, 'page');
await mkdir(pageDir, { recursive: true });
const { snapshots: _omit, ...rec } = recording;
const demo = {
  lang,
  rec,
  copy,
  forbidden: [...SCREEN_FORBIDDEN, ...SECRET_SHAPES],
  shots: Object.fromEntries(
    Object.entries(consoleShots).map(([name, s]) => [
      name,
      { url: pathToFileURL(s.png).href, width: s.width, height: s.height, rects: s.rects },
    ]),
  ),
};
await writeFile(
  path.join(pageDir, 'data.js'),
  `window.DEMO = ${JSON.stringify(demo).replaceAll('<', '\\u003c')};\n`,
);
const template = (await readFile(path.join(HERE, 'scenes/video.html'), 'utf8'))
  .replaceAll('{{WEB}}', pathToFileURL(path.join(REPO, 'web')).href)
  .replaceAll('{{HERE}}', pathToFileURL(HERE).href)
  .replaceAll('{{LANG}}', lang === 'en' ? 'en' : 'zh-CN');
const pageFile = path.join(pageDir, 'video.html');
await writeFile(pageFile, template);
const pageUrl = pathToFileURL(pageFile).href;

// 镜头清单（时长以页面里的定义为准）。
const probe = await Chrome.launch({ width: 1920, height: 1080 });
let scenes;
try {
  await probe.goto(pageUrl);
  await probe.evaluate('window.__ready');
  scenes = await probe.evaluate('window.__scenes()');
} finally {
  await probe.close();
}
// 调试：只截指定时刻的画面（改版式时用，几秒出图）。
if (values.frame) {
  const previewDir = path.join(work, 'preview');
  await mkdir(previewDir, { recursive: true });
  const chrome = await Chrome.launch({ width: 1920, height: 1080 });
  try {
    await chrome.goto(pageUrl);
    await chrome.evaluate('window.__ready');
    for (const spec of values.frame.split(',')) {
      const [id, t] = spec.split(':');
      if (!scenes.some((s) => s.id === id)) fatal(`没有这一镜：${id}`);
      await chrome.evaluate(`window.__frame(${JSON.stringify(id)}, ${Number(t)})`);
      const file = path.join(previewDir, `${id}-${t}.png`);
      await writeFile(file, await chrome.screenshot());
      log(`预览：${file}`);
    }
  } finally {
    await chrome.close();
  }
  process.exit(0);
}
const only = values.only ? new Set(values.only.split(',').map((s) => s.trim())) : null;
if (only) for (const id of only) if (!scenes.some((s) => s.id === id)) fatal(`没有这一镜：${id}`);

const common = ['common.js', 'boot.js', 'video.css', 'video.html'].map((f) =>
  path.join(HERE, 'scenes', f),
);
const sceneFile = {
  open: 's1-open.js',
  edit: 's2-edit.js',
  run: 's3-run.js',
  tasks: 's4-tasks.js',
  approval: 's5-approval.js',
  protocols: 's6-protocols.js',
  close: 's7-close.js',
};
const dataKey = sha(JSON.stringify(demo));
const framesDir = path.join(work, 'frames');
for (const scene of scenes) {
  scene.frames = Math.round(scene.duration * FPS);
  const files = [...common, path.join(HERE, 'scenes', sceneFile[scene.id])];
  scene.key = sha(dataKey, ...(await Promise.all(files.map((f) => readFile(f, 'utf8')))));
  scene.dir = path.join(framesDir, scene.id);
  const keyFile = path.join(scene.dir, 'key.txt');
  const have = existsSync(scene.dir)
    ? (await readdir(scene.dir)).filter((f) => f.endsWith('.png')).length
    : 0;
  const valid =
    have === scene.frames && existsSync(keyFile) && (await readFile(keyFile, 'utf8')) === scene.key;
  // --only 的镜头无条件重画；其余镜头缓存有效就沿用，无效也得补画（合成需要全部帧）。
  scene.cached = valid && !values.force && !only?.has(scene.id);
}

// ── 3. 逐帧渲染（多个无头 Chrome 并行）──────────────────────────────────────
const todo = scenes.filter((s) => !s.cached);
for (const s of scenes)
  log(
    `镜头 ${s.id.padEnd(9)} ${String(s.frames).padStart(4)} 帧  ${todo.includes(s) ? '渲染' : '沿用缓存'}`,
  );
if (todo.length) {
  for (const s of todo) {
    await rm(s.dir, { recursive: true, force: true });
    await mkdir(s.dir, { recursive: true });
  }
  const queue = todo.flatMap((s) => Array.from({ length: s.frames }, (_v, i) => [s, i]));
  const total = queue.length;
  let next = 0;
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    const chrome = await Chrome.launch({ width: 1920, height: 1080 });
    try {
      await chrome.goto(pageUrl);
      await chrome.evaluate('window.__ready');
      for (;;) {
        const job = queue[next++];
        if (!job) return;
        const [scene, i] = job;
        await chrome.evaluate(`window.__frame(${JSON.stringify(scene.id)}, ${i / FPS})`);
        const png = await chrome.screenshot();
        await writeFile(path.join(scene.dir, `${String(i).padStart(5, '0')}.png`), png);
        done++;
        if (done % 120 === 0 || done === total)
          log(`  已渲染 ${done}/${total} 帧（${((Date.now() - started) / 1000).toFixed(0)} 秒）`);
      }
    } finally {
      await chrome.close();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, total) }, worker));
  for (const s of todo) await writeFile(path.join(s.dir, 'key.txt'), s.key);
}

// ── 4. 合成 ──────────────────────────────────────────────────────────────────
const ffmpeg = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg 失败（${code}）：${err.slice(-600)}`)),
    );
  });
const probeFile = (file) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ]);
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('close', (code) =>
      code === 0 ? resolve(JSON.parse(text)) : reject(new Error('ffprobe 失败')),
    );
  });

/** 把一串帧文件按顺序链接成 %05d.png，供 ffmpeg 读取。 */
async function sequence(dir, files) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let n = 0;
  for (const f of files) await symlink(f, path.join(dir, `${String(n++).padStart(5, '0')}.png`));
  return n;
}
const frameFile = (scene, i) => path.join(scene.dir, `${String(i).padStart(5, '0')}.png`);
const allFiles = scenes.flatMap((s) =>
  Array.from({ length: s.frames }, (_v, i) => frameFile(s, i)),
);
const missing = allFiles.filter((f) => !existsSync(f));
if (missing.length)
  fatal(
    `有 ${missing.length} 帧不存在（${path.basename(path.dirname(missing[0]))} 没渲染过？），无法合成。`,
  );

const seq = path.join(work, 'seq');
const count = await sequence(seq, allFiles);
const mp4 = path.join(out, `${stem}.mp4`);
const COLOR = [
  '-vf',
  'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
];
let crf = 20;
for (;;) {
  log(`编码 ${stem}.mp4（CRF ${crf}）`);
  await ffmpeg([
    '-framerate',
    String(FPS),
    '-i',
    path.join(seq, '%05d.png'),
    ...COLOR,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    String(crf),
    '-profile:v',
    'high',
    '-r',
    String(FPS),
    '-movflags',
    '+faststart',
    mp4,
  ]);
  const size = (await stat(mp4)).size;
  if (size <= 8 * 1024 * 1024 || crf >= 30) break;
  log(`  ${(size / 1048576).toFixed(1)} MiB 超过 8 MiB，提高 CRF 重编`);
  crf += 2;
}
if (!values['no-webm']) {
  log(`编码 ${stem}.webm`);
  await ffmpeg([
    '-framerate',
    String(FPS),
    '-i',
    path.join(seq, '%05d.png'),
    '-vf',
    'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '34',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-cpu-used',
    '4',
    '-r',
    String(FPS),
    path.join(out, `${stem}.webm`),
  ]);
}

// 封面：copy.json 里指定的镜头与时间。
const posterScene = scenes.find((s) => s.id === copy.poster.scene);
await copyFile(
  frameFile(posterScene, Math.min(posterScene.frames - 1, Math.round(copy.poster.t * FPS))),
  path.join(out, `${stem}-poster.png`),
);

// GIF：copy.json 里指定的几段（默认是「改一行 → 真实调用拿到回答」），超过上限就整体略微加速。
if (!values['no-gif']) {
  const chromeTimes = await (async () => {
    const c = await Chrome.launch({ width: 1920, height: 1080 });
    try {
      await c.goto(pageUrl);
      await c.evaluate('window.__ready');
      return await c.evaluate('window.__runTimes()');
    } finally {
      await c.close();
    }
  })();
  const files = [];
  let seconds = 0;
  for (const seg of copy.gif.segments) {
    const scene = scenes.find((s) => s.id === seg.scene);
    const to =
      typeof seg.to === 'string'
        ? chromeTimes.answer + Number(seg.to.replace('answer', ''))
        : seg.to;
    const a = Math.round(seg.from * FPS);
    const b = Math.min(scene.frames, Math.round(to * FPS));
    for (let i = a; i < b; i++) files.push(frameFile(scene, i));
    seconds += (b - a) / FPS;
  }
  const speed = Math.max(1, seconds / copy.gif.max_seconds);
  const gifSeq = path.join(work, 'gifseq');
  await sequence(gifSeq, files);
  const gif = path.join(out, `${stem}.gif`);
  let fps = copy.gif.fps;
  let colors = 256;
  for (;;) {
    log(
      `编码 ${stem}.gif（${seconds.toFixed(1)} 秒 ÷ ${speed.toFixed(2)} 倍速，${fps} fps，${colors} 色）`,
    );
    const chain = `setpts=PTS/${speed.toFixed(4)},fps=${fps},scale=${copy.gif.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    await ffmpeg([
      '-framerate',
      String(FPS),
      '-i',
      path.join(gifSeq, '%05d.png'),
      '-filter_complex',
      chain,
      '-loop',
      '0',
      gif,
    ]);
    if ((await stat(gif)).size <= 4 * 1024 * 1024 || fps <= 10) break;
    fps = fps > 12 ? 12 : 10;
    colors = 160;
  }
}

// ── 5. 报告 ──────────────────────────────────────────────────────────────────
const summary = {};
for (const name of [`${stem}.mp4`, `${stem}.webm`, `${stem}.gif`, `${stem}-poster.png`]) {
  const file = path.join(out, name);
  if (!existsSync(file)) continue;
  const info = await probeFile(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  summary[name] = {
    bytes: (await stat(file)).size,
    duration: Number(info.format.duration ?? 0) || null,
    bit_rate: Number(info.format.bit_rate ?? 0) || null,
    size: `${v.width}x${v.height}`,
    codec: v.codec_name,
    pix_fmt: v.pix_fmt,
    fps: v.avg_frame_rate,
  };
}
const report = {
  rendered_at: new Date().toISOString(),
  recording: {
    agent: recording.agent,
    recorded_at: recording.recorded_at,
    lang: recording.lang ?? 'zh',
  },
  lang,
  frames: count,
  scenes: scenes.map((s) => ({
    id: s.id,
    seconds: s.duration,
    frames: s.frames,
    start: scenes.slice(0, scenes.indexOf(s)).reduce((n, x) => n + x.duration, 0),
  })),
  outputs: summary,
};
await writeFile(
  path.join(out, lang === 'en' ? 'render-report-en.json' : 'render-report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
for (const [name, s] of Object.entries(summary))
  log(
    `${name.padEnd(16)} ${(s.bytes / 1048576).toFixed(2)} MiB  ${s.duration?.toFixed(1) ?? '-'} 秒  ${s.size}`,
  );
log(`完成：${out}`);
