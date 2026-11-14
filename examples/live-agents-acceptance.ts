import { parseArgs } from 'node:util';
import { access, constants, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { createGateway } from '../src/gateway/server.js';
import { nativeEnvironment } from '../src/engines/process.js';
import { sha } from '../src/core/util.js';
import {
  Gateway,
  PidTracker,
  Secrets,
  get,
  http,
  runScenario,
  scanForSecrets,
  waitGone,
  type AgentKind,
  type Ctx,
  type ScenarioResult,
} from './live-agents/harness.js';
import { EXPECT, s1, s2, s3, s4, s5, s6, type Env } from './live-agents/scenarios-a.js';
import { s7, s8, s9, s10, s11 } from './live-agents/scenarios-b.js';

// 真实智能体端到端验证（L3）。在进程内起一个只监听 127.0.0.1 随机端口的隔离网关，数据与工作目录
// 全在 --out 下，用官方 SDK 与 fetch 经真实 HTTP 跑 S1–S12。`--agent fixture` 用仓库里的假 ACP
// 智能体跑同一套场景，不产生费用；claude / codex 必须带 --confirm-live-cost。每个场景只调用一次
// 智能体、不自动重试、有硬超时。不读写用户真实的数据目录，不改任何代理或网络环境变量。

const USAGE =
  '用法：node dist/examples/live-agents-acceptance.js --agent claude|codex|antigravity|fixture [--executable PATH] --out NEW_DIRECTORY [--confirm-live-cost] [--only S1,S5] [--model default] [--native-env inherit|allowlist] [--scenario-timeout-sec 300] [--agy-mode plan]';
const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    executable: { type: 'string' },
    out: { type: 'string' },
    'confirm-live-cost': { type: 'boolean' },
    only: { type: 'string' },
    model: { type: 'string' },
    'native-env': { type: 'string' },
    'scenario-timeout-sec': { type: 'string' },
    'agy-mode': { type: 'string' },
  },
});
const fatal = (message: string): never => {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
};
const kind = values.agent as AgentKind | undefined;
if (kind !== 'claude' && kind !== 'codex' && kind !== 'antigravity' && kind !== 'fixture')
  fatal('--agent 必须是 claude、codex、antigravity 或 fixture。');
const agent = kind as AgentKind;
if (agent !== 'fixture' && !values['confirm-live-cost'])
  fatal(
    '运行真实智能体会产生费用：必须显式加 --confirm-live-cost（每个场景只调用一次，不自动重试）。',
  );
if (agent !== 'fixture' && !values.executable)
  fatal('--agent claude/codex/antigravity 需要 --executable PATH。');
if (!values.out) fatal('需要 --out NEW_DIRECTORY（必须是不存在的新目录）。');
const nativeEnvMode = values['native-env'] ?? 'inherit';
if (nativeEnvMode !== 'inherit' && nativeEnvMode !== 'allowlist')
  fatal('--native-env 只能是 inherit 或 allowlist。');
const timeoutMs = Number(values['scenario-timeout-sec'] ?? 300) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) fatal('--scenario-timeout-sec 至少 10。');
const ALL = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12'];
const only = values.only ? values.only.split(',').map((s) => s.trim().toUpperCase()) : ALL;
for (const id of only) if (!ALL.includes(id)) fatal(`未知场景 ${id}。`);
const model = values.model ?? 'default';
let executable: string | undefined;
if (agent !== 'fixture') {
  executable = path.resolve(values.executable!);
  try {
    await access(executable, constants.X_OK);
  } catch {
    fatal(`--executable 不可执行：${executable}`);
  }
}

// --out 必须是新目录：父目录可以自动建，目标本身已存在就拒绝；再用 wx 占位文件防止重复运行。
const root = path.resolve(values.out!);
await mkdir(path.dirname(root), { recursive: true });
try {
  await mkdir(root, { mode: 0o700 });
} catch (error) {
  fatal(
    (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? `--out 已存在：${root}。为防止重复运行与混淆证据，必须指定一个新目录。`
      : `无法创建 --out：${(error as Error).message}`,
  );
}
await (await open(path.join(root, 'invocation-reserved'), 'wx', 0o600)).close();

const OWNER = 'live-acceptance';
const AGENT_ID = `agent/live-${agent}`;
const workspace = path.join(root, 'workspace');
const fixture = fileURLToPath(new URL('../../test/fixtures/acp-live-agent.mjs', import.meta.url));
// Codex：只在本次调用上用 -c 覆盖（不改 ~/.codex/config.toml），读放行、写需要审批。
const CODEX_ARGS = ['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="read-only"'];
// Antigravity：照 examples/live-native-acceptance.ts（2026-11-02 实测通过的组合）。`--mode` 缺省 plan；
// 仓库里没有记录其它模式名，要让 S6 真的写文件须由运行者按 `agy --help` 自己传 --agy-mode。
const agyMode = values['agy-mode'] ?? 'plan';
if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agyMode)) fatal('--agy-mode 只能是简单的模式名。');
const AGY_ARGS = [
  '--mode',
  agyMode,
  '--sandbox',
  '--effort',
  'low',
  '--print-timeout',
  `${Math.max(30, Math.floor(timeoutMs / 1000) - 15)}s`,
  '--log-file',
  path.join(root, 'agy.log'),
];
const nativeArgs = agent === 'codex' ? CODEX_ARGS : agent === 'antigravity' ? AGY_ARGS : [];
const secrets = new Secrets();
const adminToken = randomBytes(32).toString('base64url');
secrets.add(adminToken);
process.env.OAA_LIVE_ADMIN_TOKEN = adminToken;

const worker = workerSchema.parse({
  nodeId: 'live-acceptance-node',
  owner: OWNER,
  dataDir: workspace,
  concurrency: 4,
  nativeEnv: { mode: nativeEnvMode, allow: [] },
  native: agent === 'fixture' ? {} : { [agent]: { enabled: true, executable, args: nativeArgs } },
  adapters:
    agent === 'fixture'
      ? { live: { transport: 'acp', command: process.execPath, args: [fixture], enabled: true } }
      : {},
});
// 传给智能体子进程的环境（与 native.ts / acp.ts 用的同一个函数）：只记名字。
const childEnv = nativeEnvironment(worker.nativeEnv);
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION/i;
const envSecretNames = Object.keys(childEnv).filter((k) => SECRETISH.test(k));
const envSecrets = new Secrets();
for (const k of envSecretNames) envSecrets.add(childEnv[k]);

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
        name: 'live-admin',
        owner: OWNER,
        tokenEnv: 'OAA_LIVE_ADMIN_TOKEN',
        agents: ['*'],
        scopes: ['read', 'invoke', 'files', 'approve', 'admin', 'billing'],
      },
    ],
    platform: { owner: OWNER, registration: 'closed' },
  }),
);
const pids = new PidTracker();
const results: ScenarioResult[] = [];
const report: Record<string, unknown> = {
  recorded_at: new Date().toISOString(),
  agent,
  agent_id: AGENT_ID,
  executable: executable ?? fixture,
  requested_model: model,
  scenarios_requested: only,
  live_cost: agent !== 'fixture',
  automatic_retry: false,
  scenario_timeout_ms: timeoutMs,
  gateway: { host: '127.0.0.1', port: 'random', data_dir: path.join(root, 'gateway'), workspace },
  native_args: nativeArgs,
  child_env: {
    mode: nativeEnvMode,
    names: Object.keys(childEnv).sort(),
    secret_like_names: envSecretNames.sort(),
    provider_related_names: Object.keys(childEnv)
      .filter((k) => /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|GEMINI|GOOGLE|AWS|AZURE)_|PROXY$/i.test(k))
      .sort(),
    note:
      agent === 'claude'
        ? '这是网关交给 Claude Agent SDK 的 env 参数；SDK 启动 CLI 时可能再追加自己的变量（未观测）。'
        : '这是网关启动子进程时传入的环境（OAA_* 已过滤）。',
  },
};

let exitCode = 1;
try {
  const base = await gateway.listen();
  report.base_url_host = new URL(base).hostname;
  const gw = new Gateway(base, adminToken);
  pids.start();
  const published = await http(base, 'POST', '/v1/agents/publish-native', adminToken, {
    id: AGENT_ID,
    engine: agent === 'fixture' ? 'adapter/live' : agent,
    models: [model],
  });
  if (published.status !== 200) throw new Error(`发布智能体失败：HTTP ${published.status}`);
  const made = await http(base, 'POST', '/v1/keys', adminToken, {
    name: 'live-caller',
    agents: [AGENT_ID],
    scopes: ['invoke', 'read', 'files'],
    execution: 'host',
  });
  const key = get(made.body, 'token') as string | undefined;
  if (!key?.startsWith('sk-oaa-')) throw new Error(`建 sk-oaa- 密钥失败：HTTP ${made.status}`);
  secrets.add(key);
  const sessionOf = (runId: string) => {
    try {
      return gateway.store.run(runId).sessionId;
    } catch {
      return undefined;
    }
  };
  const env: Env = {
    kind: agent,
    agentId: AGENT_ID,
    base,
    key,
    gateway: gw,
    sessionOf,
    workspaceOf: (runId) => {
      const s = sessionOf(runId);
      return s ? path.join(workspace, 'sessions', sha(OWNER).slice(0, 16), s) : undefined;
    },
    expect: EXPECT[agent],
  };
  const plan: [string, string, (ctx: Ctx) => Promise<void>][] = [
    ['S1', 'OpenAI Chat 非流式', (c) => s1(env, c)],
    ['S2', 'OpenAI Chat 流式', (c) => s2(env, c)],
    ['S3', 'OpenAI Responses 与 previous_response_id 续接', (c) => s3(env, c)],
    ['S4', 'Claude Messages 非流式与流式', (c) => s4(env, c)],
    ['S5', 'Gemini generateContent', (c) => s5(env, c)],
    ['S6', '审批：批准与拒绝', (c) => s6(env, c)],
    ['S7', '取消', (c) => s7(env, c, pids)],
    ['S8', '调用方工具桥接', (c) => s8(env, c)],
    ['S9', '并发 3 个任务', (c) => s9(env, c)],
    ['S10', '计费', (c) => s10(env, c, secrets)],
    ['S11', '错误面', (c) => s11(env, c, secrets)],
    [
      'S12',
      '收尾检查：残留子进程与秘密泄漏',
      async (c) => {
        await pids.sample();
        const all = [...pids.seen].map(([pid, v]) => ({ pid, ...v }));
        c.observe('child_processes_seen', all.length);
        c.observe('child_commands', [...new Set(all.map((p) => p.comm))]);
        const left = await waitGone(
          all.map((p) => p.pid),
          15_000,
        );
        c.check('脚本记录的子进程全部已退出', left.length === 0, left);
        const fixtureEnv = await fixtureEnvNames(workspace);
        if (fixtureEnv.length) c.observe('fixture_observed_env_names', fixtureEnv);
        const scan = await scanForSecrets([root], secrets.list());
        const envScan = await scanForSecrets(
          [path.join(root, 'gateway'), path.join(root, 'agy.log')],
          envSecrets.list(),
        );
        c.observe('files_scanned', scan.files);
        c.observe('secret_values_checked', secrets.list().length);
        c.observe('env_secret_values_checked', envSecrets.list().length);
        c.check(
          '数据与工作目录中没有管理密钥、sk-oaa- 密钥、账号密钥或会话令牌',
          scan.hits.length === 0,
          scan.hits.map((h) => path.relative(root, h.file)),
        );
        c.check(
          '网关数据目录中没有子进程环境里的秘密值',
          envScan.hits.length === 0,
          envScan.hits.map((h) => path.relative(root, h.file)),
        );
      },
    ],
  ];
  for (const [id, title, body] of plan) {
    if (!only.includes(id)) continue;
    const r = await runScenario(
      id,
      title,
      id === 'S7' ? Math.min(timeoutMs, 120_000) : timeoutMs,
      gw,
      secrets,
      pids,
      body,
    );
    results.push(r);
    process.stdout.write(
      `${id.padEnd(4)} ${r.status.padEnd(11)} ${String(r.elapsed_ms).padStart(7)}ms  调用 ${r.agent_invocations}  ${title}${r.error ? `  [${r.error.code}]` : ''}\n`,
    );
  }
  exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
} catch (error) {
  report.setup_error = secrets.redact(String((error as Error).message ?? error)).slice(0, 500);
  process.stderr.write(`环境准备失败：${report.setup_error}\n`);
} finally {
  pids.stop();
  await gateway.app.close();
  delete process.env.OAA_LIVE_ADMIN_TOKEN;
  report.scenarios = results;
  report.agent_invocations_total = results.reduce((n, r) => n + r.agent_invocations, 0);
  report.summary = Object.fromEntries(
    ['pass', 'fail', 'unsupported', 'skipped'].map((s) => [
      s,
      results.filter((r) => r.status === s).length,
    ]),
  );
  let json = JSON.stringify(report, null, 2) + '\n';
  let md = markdown(report, results);
  // 报告本身也过一遍秘密值（保险）：命中就替换，并在报告里注明。
  const leaked = [...secrets.list(), ...envSecrets.list()].some(
    (v) => json.includes(v) || md.includes(v),
  );
  if (leaked) {
    json = envSecrets.redact(secrets.redact(json));
    md =
      envSecrets.redact(secrets.redact(md)) +
      '\n> 注意：报告里曾出现秘密值，已替换为 [REDACTED]。\n';
  }
  await writeFile(path.join(root, 'report.json'), json, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(root, 'report.md'), md, { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    `报告：${path.join(root, 'report.json')}\n报告：${path.join(root, 'report.md')}\n`,
  );
}
process.exit(exitCode);

async function fixtureEnvNames(dir: string): Promise<string[]> {
  const names = new Set<string>();
  const visit = async (p: string): Promise<void> => {
    if (!existsSync(p)) return;
    for (const entry of await readdir(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name === '.live-fixture-env.json')
        for (const n of (JSON.parse(await readFile(full, 'utf8')) as { names: string[] }).names)
          names.add(n);
    }
  };
  await visit(dir);
  return [...names].sort();
}

function markdown(r: Record<string, unknown>, rows: ScenarioResult[]): string {
  const label = {
    pass: '通过',
    fail: '失败',
    unsupported: '引擎不支持（如实记录）',
    skipped: '跳过',
  };
  const cell = (s: unknown) =>
    String(s ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
  const lines = [
    `# 真实智能体端到端验证：${r.agent}`,
    '',
    `- 记录时间：${r.recorded_at}`,
    `- 智能体：\`${r.agent_id}\`（${r.agent === 'fixture' ? '仓库里的假 ACP 智能体，无费用' : '真实智能体，已确认费用'}），模型：\`${r.requested_model}\``,
    `- 网关：只监听 127.0.0.1 随机端口；数据与工作目录都在本次 --out 下；不自动重试；每场景硬超时 ${Number(r.scenario_timeout_ms) / 1000} 秒`,
    `- 智能体调用合计：${r.agent_invocations_total}`,
    r.setup_error ? `- 环境准备失败：${cell(r.setup_error)}` : '',
    '',
    '| 场景 | 内容 | 结果 | 用时 | 智能体调用 | 运行 ID | 未通过的检查 / 错误码 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (s) =>
        `| ${s.id} | ${cell(s.title)} | ${label[s.status]} | ${(s.elapsed_ms / 1000).toFixed(1)} 秒 | ${s.agent_invocations} | ${cell(s.run_ids.join(' '))} | ${cell(
          [
            ...s.checks.filter((c) => !c.ok).map((c) => c.name),
            s.error ? `${s.error.code}：${s.error.message}` : '',
          ]
            .filter(Boolean)
            .join('；'),
        )} |`,
    ),
    '',
    '## 与文档不一致之处',
    '',
    ...(rows.some((s) => s.doc_mismatches.length)
      ? rows.flatMap((s) => s.doc_mismatches.map((m) => `- ${m}`))
      : ['- 本次运行没有发现与 docs/adapters.md、docs/harness.md 写法不一致的观测。']),
    '',
    '## 传给智能体子进程的环境变量（只有名字）',
    '',
    `模式 \`${(r.child_env as { mode: string }).mode}\`。与模型提供方或代理相关的：${(r.child_env as { provider_related_names: string[] }).provider_related_names.map((n) => `\`${n}\``).join('、') || '无'}。完整名单见 report.json 的 \`child_env.names\`。`,
    '',
    '每个场景的观测值（智能体输出只保留前 300 个字符）见 report.json。',
    '',
  ];
  return lines.join('\n');
}
