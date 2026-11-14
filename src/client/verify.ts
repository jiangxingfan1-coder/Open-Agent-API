/**
 * `oaa verify AGENT`: let anyone with an agent installed produce a verification report for it.
 *
 * It runs the scenarios of examples/live-agents-acceptance.ts (src/client/verify-*.ts) against the
 * agent through an isolated gateway that lives inside this process (127.0.0.1, random port, a
 * temporary directory that is deleted afterwards). Your own gateway, data directory and keys are not
 * touched. Every scenario makes real agent calls, so without `--confirm-live-cost` the command only
 * prints what it would do. No automatic retries; a failed scenario never stops the others; Ctrl+C ends
 * the run cleanly (running tasks cancelled, agent processes stopped, a partial report written).
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { Fault } from '../core/util.js';
import { GatewayClient } from './client.js';
import { resolveEndpoint, type ConnectionFlags } from './connection.js';
import { stdoutLine, type Out } from './term.js';
import { finalizeReport, machinePlatform, renderTable } from './verify-report.js';
import { machineContext } from './verify-scrub.js';
import { SCENARIOS, scenarioId, type ScenarioMeta } from './verify-catalog.js';
import { runVerification } from './verify-run.js';
import { agentIdentity, resolveTarget, type Identity } from './verify-target.js';
import type { ScenarioResult } from './verify-harness.js';

export type VerifyFlags = ConnectionFlags & {
  model?: string;
  scenarios?: string;
  out?: string;
  executable?: string;
  'timeout-ms'?: string;
  'confirm-live-cost'?: boolean;
  json?: boolean;
};

export type VerifyIO = {
  out?: Out;
  err?: Out;
  locale?: Locale;
  interrupt?: AbortSignal;
  /** Test hooks. */
  pathEnv?: string;
  cwd?: string;
  now?: () => Date;
};

const DEFAULT_TIMEOUT_MS = 300_000;

/** The scenarios to run, in table order: the chosen ones (or all) and always the free cleanup check. */
export function chooseScenarios(list: string | undefined): ScenarioMeta[] {
  const known = SCENARIOS.filter((s) => s.verify);
  if (!list?.trim()) return known;
  const ids = new Set<string>();
  for (const raw of list.split(',').filter((s) => s.trim())) {
    const id = scenarioId(raw);
    const meta = SCENARIOS.find((s) => s.id === id);
    if (!meta || !meta.verify)
      throw new Fault(
        'arguments',
        bi(
          `未知场景「${raw.trim()}」。可用：${known.map((s) => s.key).join('、')}（也可写 ${known.map((s) => s.id).join(' ')}）。`,
          `Unknown scenario "${raw.trim()}". Available: ${known.map((s) => s.key).join(', ')} (or ${known.map((s) => s.id).join(' ')}).`,
        ),
      );
    ids.add(meta.id);
  }
  ids.add('S12');
  return known.filter((s) => ids.has(s.id));
}

const stamp = (date: Date) =>
  date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

/** The plan printed before anything runs (and the whole output without --confirm-live-cost). */
export function planLines(
  chosen: ScenarioMeta[],
  target: { label: string },
  model: string,
  outDir: string,
  locale: Locale,
  confirmed: boolean,
): string[] {
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  const calls = chosen.reduce((n, s) => n + s.calls, 0);
  return [
    t(
      `将验证智能体 ${target.label}（模型 ${model}）`,
      `About to verify the agent ${target.label} (model ${model})`,
    ),
    '',
    ...chosen.map(
      (s) =>
        `  ${s.key.padEnd(16)} ${String(s.calls).padStart(2)} ${t('次调用', s.calls === 1 ? 'call ' : 'calls')}  ${pick(s.title, locale)} — ${pick(s.note, locale)}`,
    ),
    '',
    t(
      `合计最多 ${calls} 次真实的智能体调用。每次都会用到该智能体自己的登录与额度（可能收费），不自动重试。`,
      `Up to ${calls} real agent calls in total. Each uses the agent's own sign-in and quota (it may cost money); nothing is retried.`,
    ),
    t(
      '运行方式：在本进程里起一个只监听 127.0.0.1 随机端口的隔离网关，数据与智能体的工作目录都在一个临时目录里，结束后删除；不读写你自己的网关、数据目录与密钥；不改任何网络或代理设置。智能体以你在这台机器上的权限运行，「审批」场景会让它在临时目录里创建一个文件。',
      'How: an isolated gateway listening only on a random 127.0.0.1 port runs inside this process, with its data and the agent working directories in a temporary directory that is deleted afterwards. Your own gateway, data directory and keys are not touched, and no network or proxy setting changes. The agent runs with your permissions on this machine; the approvals scenario has it create one file in the temporary directory.',
    ),
    t(
      '开始前会先以不带提示词的方式启动一次该智能体，读取它自报的名称与版本（不调用模型）。',
      'Before the scenarios the agent is started once without a prompt to read its self-reported name and version (no model call).',
    ),
    t(
      `报告会写到：${outDir}（report.json 与 report.md，已去除密钥、用户名、主机名与本机路径）`,
      `Reports go to: ${outDir} (report.json and report.md, with keys, user name, host name and local paths removed)`,
    ),
    '',
    confirmed
      ? t(
          '已确认费用，开始运行。Ctrl+C 可随时干净地结束。',
          'Cost confirmed; starting. Ctrl+C ends the run cleanly at any time.',
        )
      : t(
          '没有运行任何东西。确认后重新运行并加上 --confirm-live-cost。',
          'Nothing was run. Run the same command again with --confirm-live-cost to start.',
        ),
  ];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Resolves to the exit code: 0 all fine (or a plan only), 1 a scenario failed or setup failed, 130 interrupted. */
export async function runVerifyCommand(
  args: string[],
  flags: VerifyFlags,
  io: VerifyIO = {},
): Promise<number> {
  const locale = io.locale ?? processLocale();
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  const out = flags.json
    ? (io.err ?? ((l: string) => void process.stderr.write(l + '\n')))
    : (io.out ?? stdoutLine);
  const agent = args[0];
  if (!agent)
    throw new Fault(
      'arguments',
      bi(
        'verify 需要智能体名称，例如：oaa verify codex --confirm-live-cost',
        'verify needs an agent name, for example: oaa verify codex --confirm-live-cost',
      ),
    );
  const chosen = chooseScenarios(flags.scenarios);
  const timeoutMs =
    flags['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(flags['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000)
    throw new Fault(
      'arguments',
      bi(
        '--timeout-ms 至少 10000（每个场景的硬超时，毫秒）。',
        '--timeout-ms must be at least 10000 (the hard timeout of each scenario, in milliseconds).',
      ),
    );
  const model = flags.model?.trim() || 'default';

  const endpoint = await resolveEndpoint(flags);
  const published = async (id: string): Promise<string | undefined> => {
    if (!endpoint.tokenFile) return undefined;
    try {
      const client = new GatewayClient(
        endpoint.url,
        (await readFile(endpoint.tokenFile, 'utf8')).trim(),
      );
      const list = await client.request<{ data: { id: string; engine: string }[] }>(
        'GET',
        '/v1/agents',
        undefined,
        { timeoutMs: 3000 },
      );
      return list.data.find((a) => a.id === id)?.engine;
    } catch {
      return undefined;
    }
  };
  const target = await resolveTarget({
    agent,
    config: endpoint.config,
    executable: flags.executable,
    pathEnv: io.pathEnv,
    publishedEngine: published,
  });
  const cwd = io.cwd ?? process.cwd();
  const short = target.label.replace(/^adapter\//, '').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outDir = path.resolve(
    cwd,
    flags.out ?? `oaa-verify-${short}-${stamp((io.now ?? (() => new Date()))())}`,
  );
  if (await exists(outDir))
    throw new Fault(
      'output_exists',
      bi(
        `${outDir} 已存在。为避免覆盖旧报告，--out 必须是一个新目录。`,
        `${outDir} already exists. --out must be a new directory so an old report is never overwritten.`,
      ),
    );
  const confirmed = flags['confirm-live-cost'] === true;
  for (const line of planLines(chosen, target, model, outDir, locale, confirmed)) out(line);
  if (!confirmed) return 0;

  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'oaa-verify-'));
  const startedAt = Date.now();
  let done = 0;
  const ids = chosen.map((s) => s.id);
  const progress = (r: ScenarioResult) =>
    out(
      `  [${++done}/${ids.length}] ${r.key.padEnd(16)} ${pick(
        {
          pass: bi('通过', 'pass'),
          fail: bi('失败', 'FAIL'),
          unsupported: bi('不支持', 'unsupported'),
          skipped: bi('跳过', 'skipped'),
        }[r.status],
        locale,
      )} (${(r.elapsed_ms / 1000).toFixed(1)}s)`,
    );
  try {
    const identity: Identity = await agentIdentity(target);
    out(
      identity.version
        ? t(
            `智能体自报：${identity.name ?? target.label} ${identity.version}`,
            `The agent reports itself as: ${identity.name ?? target.label} ${identity.version}`,
          )
        : t('没有读到智能体自报的版本。', "The agent's self-reported version could not be read."),
    );
    const outcome = await runVerification({
      target,
      scenarios: ids,
      model,
      timeoutMs,
      workDir,
      interrupt: io.interrupt,
      onResult: progress,
    });
    const meta = {
      requested: agent,
      label: target.label,
      kind: target.kind,
      engine: target.engine,
      identity,
      model,
      timeoutMs,
      platform: machinePlatform(),
    };
    const final = finalizeReport(outcome, meta, machineContext({ workDir }), locale);
    if (final.leaks.length)
      out(
        t(
          `注意：报告里有 ${final.leaks.join('、')} 经过二次替换。`,
          `Note: ${final.leaks.join(', ')} survived the first scrub and was replaced again.`,
        ),
      );
    await writeFile(path.join(outDir, 'report.json'), final.json, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(outDir, 'report.md'), final.md, { flag: 'wx', mode: 0o600 });
    if (flags.json) (io.out ?? stdoutLine)(final.json.trimEnd());
    else {
      out('');
      for (const line of renderTable(final.report, locale)) out(line);
      out('');
      out(
        t(
          `报告：${path.join(outDir, 'report.md')}（可直接贴进 GitHub issue）`,
          `Report: ${path.join(outDir, 'report.md')} (paste it into a GitHub issue)`,
        ),
      );
      out(
        t(
          `报告：${path.join(outDir, 'report.json')}`,
          `Report: ${path.join(outDir, 'report.json')}`,
        ),
      );
      out(
        t(
          `用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`,
          `Took ${Math.round((Date.now() - startedAt) / 1000)} s`,
        ),
      );
    }
    if (outcome.setupError)
      out(t(`环境准备失败：${outcome.setupError}`, `Setup failed: ${outcome.setupError}`));
    if (outcome.interrupted) return 130;
    return outcome.setupError || final.report.summary.fail > 0 ? 1 : 0;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
