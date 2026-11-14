/**
 * `oaa status`: one read-only answer to "how is my gateway doing right now?".
 * Address, version, process and uptime, data directory and database size, published agents and whether
 * each can run, agents found on this machine but not connected yet, task counts, recent failures and
 * the number of keys. Every section after the health probe degrades on its own (a key that may not
 * read something produces a note, not a failure). Nothing is changed and no agent is called.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { faultOf } from '../core/util.js';
import { unavailableReason } from '../fabric/runnability.js';
import { isNativeEngine } from '../config/agent-presets.js';
import { exposureHint } from '../config/security-profile.js';
import { GatewayClient } from './client.js';
import { resolveEndpoint, type ConnectionFlags, type Endpoint } from './connection.js';
import { clip, humanBytes, humanDuration, stdoutLine, table, type Out } from './term.js';

type Metrics = {
  runs?: number;
  active?: number;
  queued?: number;
  in_progress?: number;
  requires_action?: number;
  awaiting_caller?: number;
};
type AgentRow = {
  id: string;
  engine: string;
  ready?: boolean;
  dispatchable?: boolean;
  status?: string;
  routes?: { provider?: string }[];
};
type Backend = { engine: string; name?: string; enabled?: boolean; evidence?: string };
type Preset = {
  id: string;
  engine?: string;
  name?: string;
  kind?: string;
  configured?: boolean;
  installed_executable?: string | null;
};
type RunRow = {
  id: string;
  agent: string;
  status: string;
  updated_at?: number;
  created_at?: number;
  error?: { code?: string; message?: string } | null;
};

export type StatusReport = {
  running: boolean;
  url: string;
  version?: string;
  pid?: number;
  uptime_seconds?: number;
  data_dir?: string;
  database_bytes?: number;
  /** Set when the database is larger than `retention.warnDatabaseMb` (default 1024). */
  database_warn_mb?: number;
  keys?: number;
  /** From the local configuration: the security profile and, when it looks exposed while `local`, why. */
  security?: { profile: string; exposure_reasons?: string[] };
  agents?: {
    id: string;
    engine: string;
    runnable: boolean;
    status: string;
    reason?: { zh: string; en: string };
  }[];
  detected?: { name: string; engine: string; connect: string }[];
  tasks?: { active: number; queued: number; running: number; awaiting_approval: number };
  recent_failures?: {
    run_id: string;
    agent: string;
    code: string;
    message: string;
    ago_seconds?: number;
  }[];
  /** Sections that could not be read, with the reason (error code). */
  unavailable: Record<string, string>;
};

const RUNNABLE = new Set(['ready', 'degraded', 'busy']);

/** Seconds since the process started, from `ps` (macOS and Linux) or the pid file's age. */
export async function processUptime(
  pid: number,
  dataDir: string | undefined,
  now = Date.now(),
): Promise<number | undefined> {
  // Windows has no `ps -o etime` (a Git-for-Windows `ps` may be on PATH but differs): use the pid file.
  const etime =
    process.platform === 'win32'
      ? undefined
      : await new Promise<string | undefined>((resolve) =>
          execFile('ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 2000 }, (error, stdout) =>
            resolve(error ? undefined : String(stdout).trim() || undefined),
          ),
        );
  const parsed = etime ? parseEtime(etime) : undefined;
  if (parsed !== undefined) return parsed;
  if (!dataDir) return undefined;
  try {
    const file = path.join(dataDir, 'server.pid');
    if (Number((await readFile(file, 'utf8')).trim()) === pid)
      return Math.max(0, Math.round((now - (await stat(file)).mtimeMs) / 1000));
  } catch {
    // No pid file: the gateway was not started with --detach.
  }
  return undefined;
}

/** `[[dd-]hh:]mm:ss` as printed by `ps -o etime`. */
export function parseEtime(text: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

async function databaseBytes(dataDir: string): Promise<number | undefined> {
  let total = 0;
  let found = false;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += (await stat(path.join(dataDir, `state.sqlite${suffix}`))).size;
      found = true;
    } catch {
      // The file does not exist (yet).
    }
  }
  return found ? total : undefined;
}

async function probe(url: string): Promise<{ version?: string; pid?: number } | undefined> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { version?: unknown; pid?: unknown };
    return {
      version: typeof body.version === 'string' ? body.version : undefined,
      pid: typeof body.pid === 'number' ? body.pid : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function gatherStatus(endpoint: Endpoint, now = Date.now()): Promise<StatusReport> {
  const report: StatusReport = { running: false, url: endpoint.url, unavailable: {} };
  const dataDir = endpoint.config?.dataDir;
  if (dataDir) {
    report.data_dir = dataDir;
    report.database_bytes = await databaseBytes(dataDir);
    const warnMb = endpoint.config?.retention?.warnDatabaseMb ?? 1024;
    if ((report.database_bytes ?? 0) > warnMb * 1024 * 1024) report.database_warn_mb = warnMb;
  }
  if (endpoint.config) {
    const exposure = exposureHint(endpoint.config);
    report.security = {
      profile: endpoint.config.security.profile,
      ...(exposure ? { exposure_reasons: exposure.reasons } : {}),
    };
  }
  const health = await probe(endpoint.url);
  if (!health) return report;
  report.running = true;
  report.version = health.version;
  report.pid = health.pid;
  if (health.pid !== undefined)
    report.uptime_seconds = await processUptime(health.pid, dataDir, now);
  if (!endpoint.tokenFile) {
    report.unavailable.key = 'token_required';
    return report;
  }
  let client: GatewayClient;
  try {
    client = new GatewayClient(endpoint.url, (await readFile(endpoint.tokenFile, 'utf8')).trim());
  } catch (error) {
    report.unavailable.key =
      faultOf(error).code === 'invalid_url' ? 'invalid_url' : 'key_unreadable';
    return report;
  }
  const get = async <T>(section: string, endpointPath: string): Promise<T | undefined> => {
    try {
      return await client.request<T>('GET', endpointPath);
    } catch (error) {
      report.unavailable[section] = faultOf(error).code;
      return undefined;
    }
  };
  const [agents, backends, overview, runs, keys] = await Promise.all([
    get<{ data: AgentRow[] }>('agents', '/v1/agents'),
    get<{ data: Backend[]; presets?: Preset[] }>('local_backends', '/v1/local/backends'),
    get<{ metrics?: Metrics }>('tasks', '/v1/overview'),
    get<{ data: RunRow[] }>('recent_failures', '/v1/runs?limit=200'),
    get<{ data: unknown[] }>('keys', '/v1/keys'),
  ]);
  if (keys) report.keys = keys.data.length;
  if (overview?.metrics) {
    const m = overview.metrics;
    report.tasks = {
      active: m.active ?? 0,
      queued: m.queued ?? 0,
      running: m.in_progress ?? 0,
      awaiting_approval: m.requires_action ?? 0,
    };
  }
  if (runs)
    report.recent_failures = runs.data
      .filter((r) => r.status === 'failed')
      .slice(0, 5)
      .map((r) => ({
        run_id: r.id,
        agent: r.agent,
        code: r.error?.code ?? 'unknown',
        message: clip(r.error?.message ?? '', 160),
        ...(r.updated_at
          ? { ago_seconds: Math.max(0, Math.round((now - r.updated_at) / 1000)) }
          : {}),
      }));
  if (agents) {
    // The gateway's own live state decides; the configuration only explains why (the same
    // not_runnable_here wording as at publish time), with the live enabled flags laid over it.
    const live = new Map((backends?.data ?? []).map((b) => [b.engine, b]));
    const worker = endpoint.config?.localWorker
      ? structuredClone(endpoint.config.localWorker)
      : undefined;
    if (worker)
      for (const [engine, backend] of live) {
        if (isNativeEngine(engine) && worker.native[engine])
          worker.native[engine].enabled = backend.enabled === true;
        const adapter = engine.startsWith('adapter/')
          ? worker.adapters[engine.slice('adapter/'.length)]
          : undefined;
        if (adapter) adapter.enabled = backend.enabled === true;
      }
    report.agents = agents.data.map((a) => {
      const runnable = a.dispatchable === true && RUNNABLE.has(a.status ?? '');
      const external = isNativeEngine(a.engine) || a.engine.startsWith('adapter/');
      const reason =
        !runnable && external
          ? unavailableReason(worker, {
              id: a.id,
              engine: a.engine,
              provider: 'native',
              routes: [],
            })
          : undefined;
      return {
        id: a.id,
        engine: a.engine,
        runnable,
        status: a.status ?? 'unknown',
        ...(reason ? { reason: { zh: reason.zh, en: reason.en } } : {}),
      };
    });
    const published = new Set(agents.data.map((a) => a.engine));
    const detected: NonNullable<StatusReport['detected']> = [];
    for (const preset of backends?.presets ?? []) {
      if (!preset.installed_executable) continue;
      const engine =
        preset.engine ?? (preset.kind === 'native' ? preset.id : `adapter/${preset.id}`);
      if (published.has(engine)) continue;
      detected.push({
        name: preset.name ?? preset.id,
        engine,
        connect: `oaa connect ${preset.id === 'antigravity' ? 'agy' : preset.id}`,
      });
    }
    report.detected = detected;
  }
  return report;
}

export function renderStatus(
  r: StatusReport,
  locale: Locale = processLocale(),
  prefix = 'oaa',
): string[] {
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  const lines: string[] = [];
  const kv = (rows: [string, string][]) => table(rows.map(([k, v]) => [`  ${k}`, v]));
  const securityLines = (): string[] => [
    ...(r.database_warn_mb !== undefined
      ? [
          t(
            `  提示：数据库已超过 ${r.database_warn_mb} MB；运行 ${prefix} prune --older-than 30d --dry-run 查看能清理多少，或设置 retention.runsDays（docs/stability.md）`,
            `  Note: the database is larger than ${r.database_warn_mb} MB; run ${prefix} prune --older-than 30d --dry-run to see what can be removed, or set retention.runsDays (docs/stability.md)`,
          ),
        ]
      : []),
    ...(r.security
      ? [
          t(`安全档位：${r.security.profile}`, `Security profile: ${r.security.profile}`),
          ...(r.security.exposure_reasons
            ? [
                t(
                  `  提示：网关看起来可能对外暴露（${r.security.exposure_reasons.join('、')}），安全档位仍是 local；对外开放前设置 "security": {"profile": "public"}，见 docs/security-model.md`,
                  `  Warning: the gateway may be reachable from outside (${r.security.exposure_reasons.join(', ')}) but the profile is still local; before exposing it set "security": {"profile": "public"}, see docs/security-model.md`,
                ),
              ]
            : []),
        ]
      : []),
  ];
  if (!r.running) {
    lines.push(
      t(`网关：没有在运行（${r.url}）`, `Gateway: not running (${r.url})`),
      ...kv([
        ...(r.data_dir
          ? ([[t('数据目录', 'Data directory'), r.data_dir]] as [string, string][])
          : []),
        ...(r.database_bytes !== undefined
          ? ([[t('数据库', 'Database'), humanBytes(r.database_bytes)]] as [string, string][])
          : []),
      ]),
      ...securityLines(),
      '',
      t(
        `启动：${prefix} quickstart（首次使用），或 ${prefix} serve --detach`,
        `Start it with: ${prefix} quickstart (first time) or ${prefix} serve --detach`,
      ),
    );
    return lines;
  }
  lines.push(
    t('网关：运行中', 'Gateway: running'),
    ...kv([
      [t('地址', 'Address'), r.url],
      [t('版本', 'Version'), r.version ?? t('未知', 'unknown')],
      [t('进程号', 'Process ID'), r.pid !== undefined ? String(r.pid) : t('未知', 'unknown')],
      [
        t('已运行', 'Uptime'),
        r.uptime_seconds !== undefined
          ? humanDuration(r.uptime_seconds * 1000)
          : t('未知', 'unknown'),
      ],
      ...(r.data_dir
        ? ([
            [
              t('数据目录', 'Data directory'),
              r.database_bytes !== undefined
                ? `${r.data_dir}  (${t('数据库', 'database')} ${humanBytes(r.database_bytes)})`
                : r.data_dir,
            ],
          ] as [string, string][])
        : []),
      ...(r.keys !== undefined
        ? ([[t('密钥', 'Keys'), String(r.keys)]] as [string, string][])
        : []),
    ]),
    ...securityLines(),
  );
  const note = (section: string) =>
    r.unavailable[section]
      ? [`  ${t('（无法读取：', '(unavailable: ')}${r.unavailable[section]}${t('）', ')')}`]
      : [];
  if (r.unavailable.key)
    lines.push(
      '',
      t(
        '没有找到可用的密钥，只显示了不需要密钥的信息。用 --token-file 指定，或在数据目录里运行。',
        'No usable key was found, so only information that needs no key is shown. Pass --token-file or run in the data directory.',
      ),
    );
  if (r.agents) {
    lines.push(
      '',
      t(`已发布的智能体（${r.agents.length}）`, `Published agents (${r.agents.length})`),
    );
    if (!r.agents.length)
      lines.push(
        `  ${t('还没有。oaa quickstart 会发布一个离线示例。', 'None yet. oaa quickstart publishes an offline sample.')}`,
      );
    else
      lines.push(
        ...table(
          r.agents.map((a) => [
            `  ${a.id}`,
            a.engine,
            a.runnable
              ? t('可运行', 'runnable')
              : t(`不可运行（${a.status}）`, `not runnable (${a.status})`),
          ]),
        ),
      );
    for (const a of r.agents.filter((x) => x.reason))
      lines.push(`  ${a.id}: ${clip(pick(a.reason!, locale), 300)}`);
  } else lines.push(...note('agents'));
  if (r.detected?.length) {
    lines.push('', t('本机检测到、还没接入', 'Detected on this machine, not connected'));
    for (const d of r.detected)
      lines.push(`  ${d.name}: ${prefix} ${d.connect.replace(/^oaa /, '')}`);
  }
  lines.push('');
  if (r.tasks)
    lines.push(
      t(
        `任务：进行中 ${r.tasks.running}，排队 ${r.tasks.queued}，待审批 ${r.tasks.awaiting_approval}${r.tasks.awaiting_approval ? `（${prefix} approvals）` : ''}`,
        `Tasks: running ${r.tasks.running}, queued ${r.tasks.queued}, awaiting approval ${r.tasks.awaiting_approval}${r.tasks.awaiting_approval ? ` (${prefix} approvals)` : ''}`,
      ),
    );
  else lines.push(t('任务：', 'Tasks:'), ...note('tasks'));
  if (r.recent_failures) {
    lines.push(
      t(
        `最近失败的任务（${r.recent_failures.length}）`,
        `Recent failed tasks (${r.recent_failures.length})`,
      ),
    );
    if (r.recent_failures.length)
      lines.push(
        ...table(
          r.recent_failures.map((f) => [
            `  ${f.run_id}`,
            f.agent,
            f.code,
            f.ago_seconds !== undefined
              ? t(
                  `${humanDuration(f.ago_seconds * 1000)}前`,
                  `${humanDuration(f.ago_seconds * 1000)} ago`,
                )
              : '',
            f.message,
          ]),
        ),
      );
  }
  return lines;
}

export type StatusOptions = { out?: Out; locale?: Locale; json?: boolean; prefix?: string };

/** Prints the report; resolves to whether the gateway is running (the command exits 1 when not). */
export async function showStatus(flags: ConnectionFlags, options: StatusOptions = {}) {
  const out = options.out ?? stdoutLine;
  const report = await gatherStatus(await resolveEndpoint(flags));
  if (options.json) out(JSON.stringify(report, null, 2));
  else for (const line of renderStatus(report, options.locale, options.prefix)) out(line);
  return report.running;
}
