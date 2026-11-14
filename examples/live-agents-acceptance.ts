import { parseArgs } from 'node:util';
import { access, constants, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick } from '../src/core/locale.js';
import { Secrets, type AgentKind, type ScenarioResult } from '../src/client/verify-harness.js';
import { SCENARIOS, scenarioId } from '../src/client/verify-catalog.js';
import type { VerifyTarget } from '../src/client/verify-env.js';
import { runVerification } from '../src/client/verify-run.js';

// End-to-end agent verification (L3). An isolated gateway listening only on a random 127.0.0.1 port
// runs inside this process; its data and the agent's working directories are all under --out. The
// scenarios S1-S12 go through real HTTP. `--agent fixture` runs the same scenarios against the
// repository's fake ACP agent at no cost; claude / codex / antigravity need --confirm-live-cost. Every
// scenario calls the agent once (a few twice), never retries, and has a hard timeout. It reads and
// writes nothing of your own data directory and changes no proxy or network setting.
//
// The scenario code is shared with `oaa verify` (src/client/verify-*.ts); this script keeps its original
// command line and its report format (report.json / report.md in --out).

const USAGE =
  '用法：node dist/examples/live-agents-acceptance.js --agent claude|codex|antigravity|fixture [--executable PATH] --out NEW_DIRECTORY [--confirm-live-cost] [--only S1,S5] [--model default] [--native-env inherit|allowlist] [--scenario-timeout-sec 300] [--agy-mode plan]\nUsage: node dist/examples/live-agents-acceptance.js --agent claude|codex|antigravity|fixture [--executable PATH] --out NEW_DIRECTORY [--confirm-live-cost] [--only S1,S5] [--model default] [--native-env inherit|allowlist] [--scenario-timeout-sec 300] [--agy-mode plan]';
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
const agent = kind as 'claude' | 'codex' | 'antigravity' | 'fixture';
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
const ALL = SCENARIOS.filter((s) => s.acceptance).map((s) => s.id);
const only = values.only
  ? values.only.split(',').map((s) => scenarioId(s) ?? s.trim().toUpperCase())
  : ALL;
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
const agyMode = values['agy-mode'] ?? 'plan';
if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agyMode)) fatal('--agy-mode 只能是简单的模式名。');

// --out must be a new directory: the parent may be created, the target itself must not exist; a
// reservation file (wx) then prevents running twice into the same place.
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

const fixture = fileURLToPath(new URL('../../test/fixtures/acp-live-agent.mjs', import.meta.url));
const target: VerifyTarget =
  agent === 'fixture'
    ? {
        kind: 'fixture',
        label: 'fixture',
        engine: 'adapter/live',
        adapter: {
          name: 'live',
          config: { transport: 'acp', command: process.execPath, args: [fixture] },
        },
      }
    : {
        kind: agent,
        label: agent,
        engine: agent,
        native: { engine: agent, executable: executable! },
      };

const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort());
process.once('SIGTERM', () => interrupt.abort());
const outcome = await runVerification({
  target,
  scenarios: only,
  model,
  timeoutMs,
  workDir: root,
  nativeEnvMode: nativeEnvMode as 'inherit' | 'allowlist',
  platform: true,
  agyMode,
  interrupt: interrupt.signal,
  onResult: (r) =>
    process.stdout.write(
      `${r.id.padEnd(4)} ${r.status.padEnd(11)} ${String(r.elapsed_ms).padStart(7)}ms  调用 ${r.agent_invocations}  ${pick(r.title)}${r.error ? `  [${r.error.code}]` : ''}\n`,
    ),
});
if (outcome.setupError) process.stderr.write(`环境准备失败：${outcome.setupError}\n`);

// The report keeps one language (the process language) so report.json stays plain strings.
const plain = (r: ScenarioResult) => ({
  ...r,
  title: pick(r.title),
  checks: r.checks.map((c) => ({ ...c, name: pick(c.name) })),
  doc_mismatches: r.doc_mismatches.map((m) => pick(m)),
  ...(r.error ? { error: { code: r.error.code, message: pick(r.error.message) } } : {}),
});
const rows = outcome.results.map(plain);
const report: Record<string, unknown> = {
  recorded_at: outcome.startedAt,
  agent,
  agent_id: outcome.agentId,
  executable: executable ?? fixture,
  requested_model: model,
  base_url_host: outcome.baseHost,
  scenarios_requested: only,
  live_cost: agent !== 'fixture',
  automatic_retry: false,
  scenario_timeout_ms: timeoutMs,
  gateway: {
    host: '127.0.0.1',
    port: 'random',
    data_dir: path.join(root, 'gateway'),
    workspace: path.join(root, 'workspace'),
  },
  native_args: outcome.nativeArgs,
  child_env: {
    ...outcome.childEnv,
    note:
      agent === 'claude'
        ? '这是网关交给 Claude Agent SDK 的 env 参数；SDK 启动 CLI 时可能再追加自己的变量（未观测）。'
        : '这是网关启动子进程时传入的环境（OAA_* 已过滤）。',
  },
  ...(outcome.setupError ? { setup_error: outcome.setupError } : {}),
  scenarios: rows,
  agent_invocations_total: rows.reduce((n, r) => n + r.agent_invocations, 0),
  summary: Object.fromEntries(
    ['pass', 'fail', 'unsupported', 'skipped'].map((s) => [
      s,
      rows.filter((r) => r.status === s).length,
    ]),
  ),
};
let json = JSON.stringify(report, null, 2) + '\n';
let md = markdown(report, rows);
// The report itself is checked for secret values once more (safety net): a hit is replaced and noted.
const secrets = new Secrets();
for (const value of outcome.secrets) secrets.add(value);
if (outcome.secrets.some((v) => v.length >= 8 && (json.includes(v) || md.includes(v)))) {
  json = secrets.redact(json);
  md = secrets.redact(md) + '\n> 注意：报告里曾出现秘密值，已替换为 [REDACTED]。\n';
}
await writeFile(path.join(root, 'report.json'), json, { flag: 'wx', mode: 0o600 });
await writeFile(path.join(root, 'report.md'), md, { flag: 'wx', mode: 0o600 });
process.stdout.write(
  `报告：${path.join(root, 'report.json')}\n报告：${path.join(root, 'report.md')}\n`,
);
process.exit(
  outcome.interrupted ? 130 : outcome.setupError || rows.some((r) => r.status === 'fail') ? 1 : 0,
);

function markdown(r: Record<string, unknown>, rows: ReturnType<typeof plain>[]): string {
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
