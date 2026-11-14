// 演示视频的素材录制（由人运行；运行真实智能体会产生费用）。
//
// 在进程内起一个只监听 127.0.0.1 随机端口的隔离网关，数据与工作目录都在 --out 下，不读写用户真实的
// 数据目录，不改任何代理或网络环境变量。做三件事：
//   1. 真实部分（最多 3 次智能体调用，不自动重试）：官方 openai SDK、官方 @anthropic-ai/sdk、Gemini
//      线上格式各调用一次；之后把控制台前端会读的接口响应原样导出成快照（密钥与本机路径已遮蔽）。
//   2. 审批部分（不产生费用）：用仓库里的假 ACP 智能体跑「写文件 → 待审批 → 批准 → 完成」，在三个
//      时刻各导出一份快照。当前可用的真实智能体引擎不支持审批桥接，所以这一段永远是替身。
//   3. 写出 --out/recording.json：全部素材与元数据，含「哪一段是真实智能体、哪一段是替身」的标记。
//
// `--agent fixture` 走与真实录制完全相同的网关配置（native.antigravity 引擎、同样的参数与 --model 校验），
// 只是把 agy 可执行文件换成本目录的 placeholder-agy.mjs：不产生费用，用来先跑通整条流水线与自检
// （见 selfcheck.mjs）；渲染器会在画面上把这一版标成「占位素材」。
//
// `--approval-only --merge <已有的 recording.json> --out <新目录>`：不发起任何真实调用、不需要 --confirm-live-cost，
// 只重跑替身驱动的审批段，把结果并入已有录制的副本（写到新目录，不改原文件）。
//
// 需要先 `npm run build`（本脚本读 dist/ 下的编译产物）。
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { access, constants, mkdir, open, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findForbidden,
  makeScrubber,
  PATH_PLACEHOLDER,
  PATH_PLACEHOLDER_EN,
  SCREEN_FORBIDDEN,
  SECRET_SHAPES,
} from './lib/scrub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const USAGE =
  '用法：\n' +
  '  录制：node tools/demo-video/record.mjs --agent antigravity|fixture [--lang zh|en] [--executable PATH] --out NEW_DIRECTORY [--confirm-live-cost] [--model default] [--native-env allowlist|inherit] [--call-timeout-sec 240] [--agy-mode plan] [--placeholder-delay-ms 6500]\n' +
  '  只补录审批段：node tools/demo-video/record.mjs --approval-only --merge RECORDING.json --out NEW_DIRECTORY';

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    lang: { type: 'string' },
    executable: { type: 'string' },
    out: { type: 'string' },
    model: { type: 'string' },
    'confirm-live-cost': { type: 'boolean' },
    'native-env': { type: 'string' },
    'call-timeout-sec': { type: 'string' },
    'agy-mode': { type: 'string' },
    'placeholder-delay-ms': { type: 'string' },
    'approval-only': { type: 'boolean' },
    merge: { type: 'string' },
  },
});
const fatal = (message) => {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
};

const approvalOnly = !!values['approval-only'];
if (!values.out) fatal('需要 --out NEW_DIRECTORY（必须是不存在的新目录）。');
let merged = null;
let kind = values.agent;
if (approvalOnly) {
  if (!values.merge) fatal('--approval-only 需要 --merge <已有的 recording.json>。');
  for (const k of ['agent', 'lang', 'executable', 'confirm-live-cost', 'model', 'agy-mode'])
    if (values[k] !== undefined)
      fatal(`--approval-only 不发起任何智能体调用，不需要也不接受 --${k}。`);
  try {
    merged = JSON.parse(readFileSync(path.resolve(values.merge), 'utf8'));
  } catch (error) {
    fatal(`读不了 --merge 指定的录制：${error.message}`);
  }
  if (merged?.schema !== 1) fatal(`不认识的 recording.json 版本：${merged?.schema}`);
  kind = merged.agent.kind;
} else if (values.merge) fatal('--merge 只能与 --approval-only 一起用。');
else if (kind !== 'antigravity' && kind !== 'fixture')
  fatal('--agent 必须是 antigravity 或 fixture。');
// 提示词语言：zh（默认）或 en。补录审批段时沿用原录制的语言（旧录制没有这个字段，都是中文）。
const lang = approvalOnly ? (merged.lang ?? 'zh') : (values.lang ?? 'zh');
if (lang !== 'zh' && lang !== 'en') fatal('--lang 只能是 zh 或 en。');
const live = !approvalOnly && kind !== 'fixture';
if (live && !values['confirm-live-cost'])
  fatal('运行真实智能体会产生费用：必须显式加 --confirm-live-cost（最多 3 次调用，不自动重试）。');
if (live && !values.executable) fatal('--agent antigravity 需要 --executable PATH。');
const nativeEnvMode = values['native-env'] ?? 'allowlist';
if (nativeEnvMode !== 'inherit' && nativeEnvMode !== 'allowlist')
  fatal('--native-env 只能是 inherit 或 allowlist。');
const callTimeoutMs = Number(values['call-timeout-sec'] ?? 240) * 1000;
if (!Number.isFinite(callTimeoutMs) || callTimeoutMs < 10_000)
  fatal('--call-timeout-sec 至少 10。');
const agyMode = values['agy-mode'] ?? 'plan';
if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agyMode)) fatal('--agy-mode 只能是简单的模式名。');
const placeholderDelay = Number(values['placeholder-delay-ms'] ?? 6500);
if (!Number.isFinite(placeholderDelay) || placeholderDelay < 0 || placeholderDelay > 60_000)
  fatal('--placeholder-delay-ms 需要 0 到 60000 之间的数。');
const model = values.model ?? 'default';
let executable;
if (live) {
  executable = path.resolve(values.executable);
  try {
    await access(executable, constants.X_OK);
  } catch {
    fatal(`--executable 不可执行：${executable}`);
  }
}

// 编译产物：与 examples/live-agents-acceptance.ts 用同一套内核与测试部件。
const distFile = (rel) => path.join(REPO, 'dist', rel);
let kernel;
try {
  kernel = {
    ...(await import(distFile('src/config/config.js'))),
    ...(await import(distFile('src/gateway/server.js'))),
    ...(await import(distFile('src/engines/process.js'))),
    ...(await import(distFile('examples/live-agents/harness.js'))),
  };
} catch (error) {
  fatal(`读不到 dist/ 下的编译产物（${error.code ?? error.message}）。请先运行 npm run build。`);
}
const { gatewaySchema, workerSchema, createGateway, Secrets, PidTracker, http, get, waitGone } =
  kernel;
const OpenAI = (await import('openai')).default;
const Anthropic = approvalOnly ? null : (await import('@anthropic-ai/sdk')).default;
const sdkVersion = (name) =>
  JSON.parse(readFileSync(path.join(REPO, 'node_modules', name, 'package.json'), 'utf8')).version;

// --out 必须是新目录：父目录可以自动建，目标本身已存在就拒绝；再用 wx 占位文件防止重复运行。
const root = path.resolve(values.out);
await mkdir(path.dirname(root), { recursive: true });
try {
  await mkdir(root, { mode: 0o700 });
} catch (error) {
  fatal(
    error.code === 'EEXIST'
      ? `--out 已存在：${root}。为防止重复运行与混淆素材，必须指定一个新目录。`
      : `无法创建 --out：${error.message}`,
  );
}
await (await open(path.join(root, 'invocation-reserved'), 'wx', 0o600)).close();

// ── 分镜里的文案与调用（渲染器从 recording.json 读，不在别处重复）──────────────
const OWNER = 'demo-recording';
const WORKSPACE = path.join(root, 'workspace');
const APPROVAL_FIXTURE = path.join(REPO, 'test/fixtures/acp-live-agent.mjs');
const PLACEHOLDER_AGY = path.join(HERE, 'placeholder-agy.mjs');
// 随语言变化的文字：三次调用的提示词、审批提示词、智能体的显示名、录制里的说明。
// 中文版的内容与之前的版本逐字相同；英文版是为英文成片准备的一套提示词（回答由智能体按提示词的语言给出）。
const APPROVAL_LINE = 'RELEASE-OK';
const TEXT = {
  zh: {
    task: '整理成带 P1/P2/P3 的清单，每项一行，不要解释：订咖啡豆；周五前回报价；修登录页 bug',
    shortPrompt: '用一句话介绍你自己，不超过 20 个字。',
    approvalPrompt: `请在当前工作目录创建文件 note.txt，内容只有一行：${APPROVAL_LINE}。不要做其它任何事，完成后只回复 DONE。`,
    placeholderName: '占位智能体',
    approvalName: '本地替身（审批演示）',
    liveNote: '真实智能体：本机的 Antigravity（agy），每个调用点只调用一次，不自动重试。',
    placeholderNote:
      '占位素材：智能体是本地替身（tools/demo-video/placeholder-agy.mjs，走与真实录制相同的 antigravity 配置），回答是固定文本，不是任何模型的输出。',
    gatewayNote:
      '画面里展示产品默认端口 8787；录制时网关只监听 127.0.0.1 的随机端口，数据与工作目录都在录制目录下。',
    approvalNote:
      '此段模型为本地替身；审批流程为产品真实行为。当前可用的真实智能体引擎不支持审批桥接，所以这一段永远用替身驱动。',
    mergedNote:
      '审批段是之后单独补录的：用网关里只有审批演示智能体的一次干净录制，不含前面真实调用的任务记录。',
    titles: {
      openai: '官方 openai SDK · chat.completions.create（非流式）',
      anthropic: '官方 @anthropic-ai/sdk · messages.create（非流式）',
      gemini: 'Gemini 线上格式 · POST /v1/models/{agent}:generateContent',
    },
    placeholder: PATH_PLACEHOLDER,
  },
  en: {
    task: 'Turn this into a P1/P2/P3 list, one item per line, no explanations: order coffee beans; send the quote by Friday; fix the login page bug',
    shortPrompt: 'Introduce yourself in one sentence, under 12 words.',
    approvalPrompt: `Create a file named note.txt in the current working directory, containing exactly one line: ${APPROVAL_LINE}. Do nothing else, and reply with just DONE when you are finished.`,
    placeholderName: 'Placeholder agent',
    approvalName: 'Local stand-in (approval demo)',
    liveNote:
      'A real agent: Antigravity (agy) on this machine, called once per call site, with no automatic retry.',
    placeholderNote:
      'Placeholder cut: the agent is a local stand-in (tools/demo-video/placeholder-agy.mjs, run through the same antigravity configuration as a real recording). Its answers are fixed text, not model output.',
    gatewayNote:
      "The screen shows the product's default port 8787; while recording, the gateway listened only on a random 127.0.0.1 port, with its data and working directory under the recording directory.",
    approvalNote:
      'The model in this segment is a local stand-in; the approval flow is real product behavior. The real agent engine available today cannot bridge approvals, so this segment is always driven by a stand-in.',
    mergedNote:
      'The approval segment was recorded separately afterwards, on a clean gateway that holds only the approval demo agent, so it has no task records from the real calls before it.',
    titles: {
      openai: 'Official openai SDK · chat.completions.create (non-streaming)',
      anthropic: 'Official @anthropic-ai/sdk · messages.create (non-streaming)',
      gemini: 'Gemini wire format · POST /v1/models/{agent}:generateContent',
    },
    placeholder: PATH_PLACEHOLDER_EN,
  },
}[lang];
const MAIN_AGENT = {
  id: live ? 'agent/antigravity' : 'agent/placeholder',
  display: live ? 'Antigravity' : TEXT.placeholderName,
};
const APPROVAL_AGENT = { id: 'agent/demo-approval', display: TEXT.approvalName };
// 画面里展示的服务地址：产品默认端口 8787。录制时实际用的是随机端口，见 gateway.actual_port。
const DISPLAY_BASE_URL = 'http://127.0.0.1:8787';
const TASK = TEXT.task;
const SHORT_PROMPT = TEXT.shortPrompt;
const APPROVAL_PROMPT = TEXT.approvalPrompt;
// 提示词太长放不进一行时（英文版），在空格处折成几段，用 + 连接；中文版的提示词一行放得下，原样不变。
const taskLines = (() => {
  const one = `const task = '${TASK}';`;
  if (one.length <= 80) return [one];
  const LIMIT = 76;
  const colon = TASK.indexOf(': ');
  let parts;
  if (colon > 0 && colon + 2 <= LIMIT && TASK.length - colon - 2 <= LIMIT) {
    // 说明在前、内容在后：在第一个「: 」后断开。
    parts = [TASK.slice(0, colon + 2), TASK.slice(colon + 2)];
  } else {
    parts = [];
    let current = '';
    for (const word of TASK.split(' ')) {
      if (current && `${current} ${word}`.length > LIMIT) {
        parts.push(`${current} `);
        current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    parts.push(current);
  }
  return [
    'const task =',
    ...parts.map((part, i) => `  '${part}'${i < parts.length - 1 ? ' +' : ';'}`),
  ];
})();
const snippet = (baseURL, modelName) =>
  [
    "import OpenAI from 'openai';",
    '',
    ...taskLines,
    '',
    'const client = new OpenAI({',
    `  baseURL: '${baseURL}',`,
    '  apiKey: process.env.OPENAI_API_KEY,',
    '});',
    '',
    'const resp = await client.chat.completions.create({',
    `  model: '${modelName}',`,
    "  messages: [{ role: 'user', content: task }],",
    '});',
    'console.log(resp.choices[0].message.content);',
  ].join('\n');

// ── 网关 ─────────────────────────────────────────────────────────────────────
const secrets = new Secrets();
const adminToken = randomBytes(32).toString('base64url');
secrets.add(adminToken);
process.env.OAA_DEMO_ADMIN_TOKEN = adminToken;

// 真实录制与占位录制共用这一份配置：唯一的差别是 agy 可执行文件（以及占位时多一个 --delay-ms）。
const AGY_ARGS = [
  '--mode',
  agyMode,
  '--sandbox',
  '--effort',
  'low',
  '--print-timeout',
  `${Math.max(30, Math.floor(callTimeoutMs / 1000) - 15)}s`,
  '--log-file',
  path.join(root, 'agy.log'),
];
const antigravity = live
  ? { enabled: true, executable, args: AGY_ARGS }
  : {
      enabled: true,
      executable: process.execPath,
      args: [PLACEHOLDER_AGY, '--delay-ms', String(placeholderDelay), ...AGY_ARGS],
    };
const worker = workerSchema.parse({
  nodeId: 'demo-recording-node',
  owner: OWNER,
  dataDir: WORKSPACE,
  concurrency: 4,
  nativeEnv: { mode: nativeEnvMode, allow: [] },
  native: approvalOnly ? {} : { antigravity },
  adapters: {
    approval: {
      transport: 'acp',
      command: process.execPath,
      args: [APPROVAL_FIXTURE],
      enabled: true,
    },
  },
});
const gateway = await createGateway(
  gatewaySchema.parse({
    host: '127.0.0.1',
    port: 0,
    dataDir: path.join(root, 'gateway'),
    maxActiveRuns: 8,
    approvalTimeoutMs: 600_000,
    localWorker: worker,
    keys: [
      {
        name: 'demo-admin',
        owner: OWNER,
        tokenEnv: 'OAA_DEMO_ADMIN_TOKEN',
        agents: ['*'],
        scopes: ['read', 'invoke', 'files', 'approve', 'admin', 'billing'],
      },
    ],
    platform: { owner: OWNER, registration: 'closed' },
  }),
);

// ── 工具函数 ─────────────────────────────────────────────────────────────────
const pids = new PidTracker();
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clipText = (text, n = 4000) => (typeof text === 'string' ? text.slice(0, n) : text);
let actualPort = null;
/** 导出的 JSON 里不允许出现密钥值与本机路径：先遮蔽，导出前再整体检查一遍。 */
const scrub = makeScrubber({
  redact: (text) => secrets.redact(text),
  masks: [
    [root, '/demo'],
    [REPO, '/repo'],
    [homedir(), '~'],
  ],
  port: () => actualPort,
  placeholder: TEXT.placeholder,
});
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted', 'expired'];

const report = approvalOnly
  ? scrub(merged)
  : {
      schema: 1,
      lang,
      recorded_at: new Date().toISOString(),
      agent: {
        kind,
        real: live,
        id: MAIN_AGENT.id,
        display: MAIN_AGENT.display,
        requested_model: model,
        executable_name: live ? path.basename(executable) : 'placeholder-agy.mjs',
        mode: agyMode,
        note: live ? TEXT.liveNote : TEXT.placeholderNote,
      },
      gateway: {
        display_base_url: DISPLAY_BASE_URL,
        actual_host: '127.0.0.1',
        actual_port: null,
        note: TEXT.gatewayNote,
      },
      native_env: nativeEnvMode,
      live_cost: live,
      automatic_retry: false,
      code: {
        sdk: `openai@${sdkVersion('openai')}`,
        task: TASK,
        before: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
        after: { baseURL: `${DISPLAY_BASE_URL}/v1`, model: MAIN_AGENT.id },
        snippet_before: snippet('https://api.openai.com/v1', 'gpt-4o'),
        snippet_after: snippet(`${DISPLAY_BASE_URL}/v1`, MAIN_AGENT.id),
      },
      calls: {},
      approval: null,
      snapshots: {},
      agent_invocations: { main: 0, approval: 0 },
      child_processes: {},
      problems: [],
    };
if (approvalOnly) {
  // 并入已有录制：旧录制里与审批段有关的问题记录作废（这次会重新判定），其余保留。
  report.problems = (report.problems ?? []).filter((p) => !/审批/.test(p));
  report.merged = {
    approval_only: true,
    original_recorded_at: merged.recorded_at,
    note: TEXT.mergedNote,
  };
  delete report.snapshots.approval_pending;
  delete report.snapshots.approval_approved;
  delete report.snapshots.approval_done;
}
report.approval = {
  real: false,
  kind: 'fixture',
  agent: { id: APPROVAL_AGENT.id, display: APPROVAL_AGENT.display },
  note: TEXT.approvalNote,
  prompt: APPROVAL_PROMPT,
  recorded_at: new Date().toISOString(),
};

let exitCode = 1;
try {
  const base = await gateway.listen();
  actualPort = Number(new URL(base).port);
  if (!approvalOnly) report.gateway.actual_port = actualPort;
  pids.start();
  const publish = async (agent, engine, models) => {
    const r = await http(base, 'POST', '/v1/agents/publish-native', adminToken, {
      id: agent,
      engine,
      models,
    });
    if (r.status !== 200) throw new Error(`发布智能体 ${agent} 失败：HTTP ${r.status}`);
  };
  if (!approvalOnly) await publish(MAIN_AGENT.id, 'antigravity', [model]);
  // 审批演示智能体是 ACP 适配器，不声明可选模型：只能发布成 default，否则任务会以 model_not_supported
  // 失败、永远到不了「待审批」（见 README「审批段为什么不用 --model」）。
  await publish(APPROVAL_AGENT.id, 'adapter/approval', ['default']);
  const made = await http(base, 'POST', '/v1/keys', adminToken, {
    name: 'demo-caller',
    agents: approvalOnly ? [APPROVAL_AGENT.id] : [MAIN_AGENT.id, APPROVAL_AGENT.id],
    scopes: ['invoke', 'read', 'files'],
    execution: 'host',
  });
  const key = get(made.body, 'token');
  if (!key?.startsWith('sk-oaa-')) throw new Error(`建 sk-oaa- 密钥失败：HTTP ${made.status}`);
  secrets.add(key);

  // ── 快照：控制台前端读的接口响应，原样导出 ──────────────────────────────────
  const errors = await http(base, 'GET', '/v1/errors', adminToken);
  const capture = async (label, runIds) => {
    const routes = {};
    const read = async (route, token = adminToken) => {
      const r = await http(base, 'GET', route, token);
      routes[route] = { status: r.status, body: r.body };
    };
    await read('/health', undefined);
    for (const route of [
      '/v1/overview',
      '/v1/overview/activity?window=24h',
      '/v1/overview/activity?window=7d',
      '/v1/runs?limit=100',
      '/v1/keys',
    ])
      await read(route);
    routes['/v1/errors'] = { status: errors.status, body: errors.body };
    for (const id of runIds) {
      const b = `/v1/runs/${encodeURIComponent(id)}`;
      for (const route of [
        `${b}/state`,
        `${b}/steps?offset=0&limit=20`,
        `${b}/actions?offset=0&limit=5`,
        `${b}/artifacts?offset=0&limit=10`,
        `${b}/output?max_bytes=8000`,
        `${b}/timeline`,
      ])
        await read(route);
    }
    report.snapshots[label] = scrub({
      captured_at: Date.now(),
      focus_runs: runIds,
      routes,
    });
  };
  /** 等任务进入 accept 里的状态；途中若到了别的终止状态就立刻报错（带上网关给的错误码与说明），不傻等。 */
  const waitRun = async (runId, accept, what, ms = 60_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = await http(base, 'GET', `/v1/runs/${encodeURIComponent(runId)}`, adminToken);
      const status = get(r.body, 'status');
      if (accept.includes(status)) return r;
      if (TERMINAL.includes(status)) {
        const e = get(r.body, 'error');
        throw new Error(
          `${what}：任务 ${runId} 结束于 ${status}（${e?.code ?? '无错误码'}：${String(e?.message ?? '').slice(0, 200)}）`,
        );
      }
      if (Date.now() > deadline) throw new Error(`${what}：等待超时（任务停在 ${status}）`);
      await sleepMs(150);
    }
  };

  // ── 一、真实部分：最多 3 次智能体调用 ───────────────────────────────────────
  const openai = new OpenAI({
    baseURL: `${base}/v1`,
    apiKey: key,
    maxRetries: 0,
    timeout: callTimeoutMs,
  });
  if (!approvalOnly) {
    const anthropic = new Anthropic({
      baseURL: base,
      apiKey: key,
      maxRetries: 0,
      timeout: callTimeoutMs,
    });
    const calls = [
      [
        'openai',
        TEXT.titles.openai,
        async (signal) => {
          const { data, response } = await openai.chat.completions
            .create(
              { model: MAIN_AGENT.id, messages: [{ role: 'user', content: TASK }] },
              { signal },
            )
            .withResponse();
          return {
            http_status: response.status,
            run_id: response.headers.get('x-run-id'),
            text: data.choices[0]?.message.content ?? '',
            finish_reason: data.choices[0]?.finish_reason ?? null,
            usage: data.usage ?? null,
            request: { model: MAIN_AGENT.id, messages: [{ role: 'user', content: TASK }] },
          };
        },
      ],
      [
        'anthropic',
        TEXT.titles.anthropic,
        async (signal) => {
          const { data, response } = await anthropic.messages
            .create(
              {
                model: MAIN_AGENT.id,
                max_tokens: 256,
                messages: [{ role: 'user', content: SHORT_PROMPT }],
              },
              { signal },
            )
            .withResponse();
          return {
            http_status: response.status,
            run_id: response.headers.get('x-run-id'),
            text: data.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
            finish_reason: data.stop_reason ?? null,
            usage: data.usage ?? null,
            request: {
              model: MAIN_AGENT.id,
              max_tokens: 256,
              messages: [{ role: 'user', content: SHORT_PROMPT }],
            },
          };
        },
      ],
      [
        'gemini',
        TEXT.titles.gemini,
        async (signal) => {
          const body = { contents: [{ role: 'user', parts: [{ text: SHORT_PROMPT }] }] };
          const r = await http(
            base,
            'POST',
            `/v1/models/${MAIN_AGENT.id}:generateContent`,
            undefined,
            body,
            { 'x-goog-api-key': key },
            signal,
          );
          return {
            http_status: r.status,
            run_id: r.headers.get('x-run-id'),
            text: (get(r.body, 'candidates', 0, 'content', 'parts') ?? [])
              .map((p) => p.text ?? '')
              .join(''),
            finish_reason: get(r.body, 'candidates', 0, 'finishReason') ?? null,
            usage: get(r.body, 'usageMetadata') ?? null,
            request: { model: MAIN_AGENT.id, ...body },
          };
        },
      ],
    ];
    const mainRuns = [];
    let liveFailed = false;
    for (const [id, title, run] of calls) {
      if (liveFailed) {
        report.calls[id] = { title, skipped: '前面的调用失败，为避免白白花钱，没有继续。' };
        continue;
      }
      pids.scenario = id;
      report.agent_invocations.main += 1;
      const started = performance.now();
      try {
        const result = await run(AbortSignal.timeout(callTimeoutMs));
        const elapsed = performance.now() - started;
        const ok = result.http_status === 200 && result.text.trim().length > 0;
        report.calls[id] = {
          title,
          ok,
          elapsed_ms: Math.round(elapsed),
          ...scrub({ ...result, text: clipText(result.text) }),
        };
        if (result.run_id) mainRuns.push(result.run_id);
        if (!ok) throw new Error(`HTTP ${result.http_status}，回答为空或状态异常`);
        process.stdout.write(
          `${id.padEnd(10)} ${(elapsed / 1000).toFixed(1).padStart(6)} 秒  运行 ${result.run_id}\n`,
        );
      } catch (error) {
        liveFailed = true;
        const message = secrets.redact(String(error?.message ?? error)).slice(0, 400);
        report.calls[id] = {
          ...(report.calls[id] ?? { title }),
          ok: false,
          elapsed_ms: report.calls[id]?.elapsed_ms ?? Math.round(performance.now() - started),
          error: { status: error?.status ?? null, code: error?.code ?? null, message },
        };
        report.problems.push(`调用 ${id} 失败：${message}`);
        process.stderr.write(`调用 ${id} 失败：${message}\n`);
      }
    }
    // 任务列表那一镜用的快照：只含真实调用产生的运行；第一个任务（改一行那次）是焦点。
    if (mainRuns.length) await capture('tasks', mainRuns.slice(0, 1));
  }

  // ── 二、审批部分：替身驱动，写文件 → 待审批 → 批准 → 完成 ────────────────────
  pids.scenario = 'approval';
  const waiting = await openai.chat.completions
    .create({ model: APPROVAL_AGENT.id, messages: [{ role: 'user', content: APPROVAL_PROMPT }] })
    .withResponse()
    .then(
      ({ data, response }) => ({
        status: response.status,
        runId: response.headers.get('x-run-id'),
        data,
      }),
      (error) => ({
        status: error.status,
        runId: error.headers?.get?.('x-run-id') ?? null,
        code: error.code,
        message: error.message,
      }),
    );
  report.agent_invocations.approval = 1;
  if (waiting.status !== 422 || !waiting.runId)
    throw new Error(
      `审批演示任务没有停在待审批：HTTP ${waiting.status}（${waiting.code ?? '无错误码'}）`,
    );
  const runId = waiting.runId;
  const parked = await waitRun(runId, ['requires_action'], '等待「待审批」');
  const pending =
    (await http(base, 'GET', `/v1/runs/${encodeURIComponent(runId)}/actions`, adminToken)).body
      ?.data ?? [];
  if (!pending.length) throw new Error('任务在待审批，但没有列出待审批项');
  await capture('approval_pending', [runId]);
  // 在待审批上停两秒再批准：任务时间线上的「等待审批」这一段才看得出来（这是真实的等待，不是画上去的）。
  await sleepMs(2000);
  const decided = [];
  for (const action of pending) {
    const r = await http(
      base,
      'POST',
      `/v1/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(action.id)}`,
      adminToken,
      { decision: 'approve' },
    );
    decided.push({ id: action.id, kind: action.kind, http_status: r.status });
    if (r.status !== 200) throw new Error(`批准失败：HTTP ${r.status}`);
  }
  await capture('approval_approved', [runId]);
  const finalRun = await waitRun(runId, ['completed'], '等待审批后的任务完成');
  await capture('approval_done', [runId]);
  Object.assign(report.approval, {
    run_id: runId,
    parked_http_status: waiting.status,
    parked_status: get(parked.body, 'status'),
    pending_actions: scrub(pending.map((a) => ({ id: a.id, kind: a.kind, detail: a.detail }))),
    decisions: decided,
    final_status: get(finalRun.body, 'status'),
  });

  exitCode = report.problems.length ? 1 : 0;
} catch (error) {
  report.problems.push(secrets.redact(String(error?.message ?? error)).slice(0, 500));
  process.stderr.write(`录制失败：${report.problems.at(-1)}\n`);
} finally {
  pids.stop();
  await pids.sample();
  const seen = [...pids.seen.keys()];
  await gateway.app.close();
  delete process.env.OAA_DEMO_ADMIN_TOKEN;
  const left = await waitGone(seen, 15_000);
  const procs = { seen: seen.length, left_running: left.length };
  if (approvalOnly) report.child_processes_approval = procs;
  else report.child_processes = procs;
  if (left.length) report.problems.push(`有 ${left.length} 个子进程没有退出`);

  const finished = scrub(report);
  let json = JSON.stringify(finished, null, 2) + '\n';
  const leak = findForbidden(json, [...SCREEN_FORBIDDEN, ...SECRET_SHAPES]);
  if (leak) {
    finished.problems.push(
      `导出内容里仍有疑似密钥或本机路径，已拒绝写出快照：${leak.pattern} 附近「${leak.context}」`,
    );
    json = JSON.stringify({ ...finished, snapshots: '（因泄漏检查未通过而清空）' }, null, 2) + '\n';
    exitCode = 1;
  }
  await writeFile(path.join(root, 'recording.json'), json, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`素材：${path.join(root, 'recording.json')}\n`);
  if (finished.problems.length)
    process.stderr.write(`问题：\n- ${finished.problems.join('\n- ')}\n`);
}
process.exit(exitCode);
