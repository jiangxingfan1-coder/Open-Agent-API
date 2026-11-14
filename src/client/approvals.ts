/**
 * `oaa approvals [--watch]`, `oaa approve RUN [--action ID] [--all]`, `oaa deny RUN [--action ID] [--reason TEXT]`.
 *
 * The same API the console uses: `GET /v1/runs` (runs waiting on a person), `GET /v1/runs/{id}/actions`
 * (the pending items, bounded previews) and `POST /v1/runs/{id}/actions/{action}` with
 * `{ decision, response }`. Calls to the caller's own tools (`client_tool`) are not approvals and are
 * never listed or decided here. A run may hold several pending items; a decision without `--action`
 * or `--all` on such a run changes nothing and says which items exist.
 */
import { createInterface } from 'node:readline/promises';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { Fault, faultOf, sleep } from '../core/util.js';
import type { GatewayClient } from './client.js';
import { clip, humanDuration, stdoutLine, table, type Out } from './term.js';

export type PendingApproval = {
  run_id: string;
  agent: string;
  action_id: string;
  kind: string;
  summary: string;
  /** Bounded JSON preview of the requested operation (as returned by the gateway). */
  detail: string;
  detail_truncated: boolean;
  expires_at: number;
  input: string;
};

type RunRow = {
  id: string;
  agent: string;
  status: string;
  waiting_on?: string;
  input?: string;
};
type ActionRow = {
  id: string;
  kind: string;
  expires_at: number;
  detail: { preview: string; truncated: boolean };
};
type ActionPage = { data: ActionRow[]; total: number; next_offset: number | null };

const SCAN_LIMIT = 200;

/** One line describing the requested operation; falls back to compact JSON. */
export function summarizeDetail(preview: string): string {
  let value: unknown;
  try {
    value = JSON.parse(preview);
  } catch {
    return clip(preview, 120);
  }
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  // ACP and native approvals are flat (`title`, `kind`, `input`, `locations`); tool approvals carry `tool`.
  const detail = obj(value);
  const call = obj(detail?.toolCall) ?? detail;
  const title = text(call?.title) ?? text(call?.tool) ?? text(call?.name) ?? text(detail?.native);
  const kind = text(call?.kind);
  const input = obj(call?.input) ?? obj(call?.rawInput) ?? obj(call?.arguments);
  const location = text(obj(Array.isArray(call?.locations) ? call.locations[0] : undefined)?.path);
  const target =
    text(input?.path) ??
    text(input?.file_path) ??
    text(input?.command) ??
    text(input?.url) ??
    location;
  const parts = [
    title,
    target && !title?.includes(target) ? target : undefined,
    kind ? `(${kind})` : undefined,
  ]
    .filter((p): p is string => !!p)
    .join(' ');
  return parts ? clip(parts, 120) : clip(JSON.stringify(value), 120);
}

async function pendingFor(
  client: GatewayClient,
  runId: string,
  signal?: AbortSignal,
): Promise<ActionRow[]> {
  const rows: ActionRow[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const r = await client.request<ActionPage>(
      'GET',
      `/v1/runs/${encodeURIComponent(runId)}/actions?offset=${offset}&limit=10`,
      undefined,
      { signal },
    );
    rows.push(...r.data.filter((a) => a.kind !== 'client_tool'));
    if (r.next_offset === null) break;
    offset = r.next_offset;
  }
  return rows;
}

const toPending = (run: Pick<RunRow, 'id' | 'agent' | 'input'>, a: ActionRow): PendingApproval => ({
  run_id: run.id,
  agent: run.agent,
  action_id: a.id,
  kind: a.kind,
  summary: summarizeDetail(a.detail.preview),
  detail: a.detail.preview,
  detail_truncated: a.detail.truncated,
  expires_at: a.expires_at,
  input: clip(run.input ?? '', 120),
});

/** Every pending approval the key can see, oldest scanned run last. */
export async function listPending(
  client: GatewayClient,
  signal?: AbortSignal,
  skip: ReadonlySet<string> = new Set(),
): Promise<{ pending: PendingApproval[]; truncated: boolean }> {
  const runs = await client.request<{ data: RunRow[] }>(
    'GET',
    `/v1/runs?limit=${SCAN_LIMIT}`,
    undefined,
    {
      signal,
    },
  );
  const pending: PendingApproval[] = [];
  for (const run of runs.data) {
    if (run.status !== 'requires_action' || run.waiting_on !== 'owner') continue;
    for (const a of await pendingFor(client, run.id, signal))
      if (!skip.has(a.id)) pending.push(toPending(run, a));
  }
  return { pending, truncated: runs.data.length >= SCAN_LIMIT };
}

const expiry = (a: PendingApproval, now: number, locale: Locale) =>
  a.expires_at > now
    ? pick(
        bi(`${humanDuration(a.expires_at - now)} 后`, `in ${humanDuration(a.expires_at - now)}`),
        locale,
      )
    : pick(bi('已过期', 'expired'), locale);

export function renderPending(
  pending: PendingApproval[],
  locale: Locale,
  now = Date.now(),
): string[] {
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  if (!pending.length) return [t('当前没有待审批项。', 'No pending approvals.')];
  const rows = [
    [
      t('运行', 'RUN'),
      t('智能体', 'AGENT'),
      t('审批项', 'ACTION'),
      t('到期', 'EXPIRES'),
      t('请求的操作', 'OPERATION'),
    ],
    ...pending.map((a) => [a.run_id, a.agent, a.action_id, expiry(a, now, locale), a.summary]),
  ];
  return [
    t(`待审批项：${pending.length}`, `Pending approvals: ${pending.length}`),
    ...table(rows),
    '',
    t(
      '批准：oaa approve 运行编号 [--action 审批项] [--all]；拒绝：oaa deny 运行编号 [--action 审批项] [--reason 原因]',
      'Approve: oaa approve RUN [--action ACTION] [--all]; deny: oaa deny RUN [--action ACTION] [--reason TEXT]',
    ),
  ];
}

export type ListOptions = {
  json?: boolean;
  watch?: boolean;
  out?: Out;
  locale?: Locale;
  signal?: AbortSignal;
  /** Poll interval for --watch (default 2 s). */
  intervalMs?: number;
};

/** `oaa approvals`. With `watch`, runs until aborted and prints each newly pending item once. */
export async function showApprovals(
  client: GatewayClient,
  options: ListOptions = {},
): Promise<void> {
  const out = options.out ?? stdoutLine;
  const locale = options.locale ?? processLocale();
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  const first = await listPending(client, options.signal);
  if (!options.watch) {
    if (options.json)
      out(JSON.stringify({ pending: first.pending, truncated: first.truncated }, null, 2));
    else {
      for (const line of renderPending(first.pending, locale)) out(line);
      if (first.truncated)
        out(
          t(
            `注意：只检查了最近的 ${SCAN_LIMIT} 个运行，更早的待审批项可能没有列出。`,
            `Note: only the newest ${SCAN_LIMIT} runs were checked; older pending items may not be listed.`,
          ),
        );
    }
    return;
  }
  const seen = new Set<string>();
  const emit = (items: PendingApproval[]) => {
    for (const a of items) {
      seen.add(a.action_id);
      if (options.json) out(JSON.stringify(a));
      else
        for (const line of table([
          [
            t('新的待审批项', 'NEW'),
            a.run_id,
            a.agent,
            a.action_id,
            expiry(a, Date.now(), locale),
            a.summary,
          ],
        ]))
          out(line);
    }
  };
  if (!options.json)
    out(t('等待待审批项（Ctrl+C 退出）…', 'Waiting for pending approvals (Ctrl+C to stop)…'));
  emit(first.pending);
  let failures = 0;
  while (!options.signal?.aborted) {
    await sleep(options.intervalMs ?? 2000, options.signal).catch(() => {});
    if (options.signal?.aborted) break;
    try {
      emit((await listPending(client, options.signal, seen)).pending);
      failures = 0;
    } catch (error) {
      if (options.signal?.aborted) break;
      // A gateway restart or a slow moment must not end the watch; give up after about 30 s of failures.
      if (++failures >= 15) throw error;
      if (failures === 1)
        process.stderr.write(
          `${t('暂时无法读取网关，稍后重试：', 'Cannot reach the gateway for now, retrying: ')}${faultOf(error).code}\n`,
        );
    }
  }
}

export type DecideOptions = {
  run: string;
  decision: 'approve' | 'deny';
  action?: string;
  all?: boolean;
  reason?: string;
  yes?: boolean;
  json?: boolean;
  out?: Out;
  locale?: Locale;
  /** Test hook: how to ask for confirmation; defaults to the terminal when both ends are a TTY. */
  confirm?: (question: string) => Promise<boolean>;
  interactive?: boolean;
};

export type DecisionResult = {
  run_id: string;
  action_id: string;
  decision: string;
  ok: boolean;
  error?: string;
};

const scopeHint = bi(
  '这把密钥没有审批权限（scope approve）或无权访问这个智能体。用管理员密钥（--token-file .oaa/admin.token），或用 oaa key create --approve 生成带审批权限的密钥。',
  'This key lacks the approve scope or access to this agent. Use the admin key (--token-file .oaa/admin.token), or create a key with oaa key create --approve.',
);

async function askTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** `oaa approve` / `oaa deny`. Returns the per-item results; throws only when nothing could be decided. */
export async function decideApprovals(
  client: GatewayClient,
  o: DecideOptions,
): Promise<DecisionResult[]> {
  const out = o.out ?? stdoutLine;
  const locale = o.locale ?? processLocale();
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  if (o.all && o.action)
    throw new Fault(
      'arguments',
      bi('--all 与 --action 不能同时使用。', 'Use either --all or --action, not both.'),
    );
  // Fail before showing anything when the key cannot approve at all (the gateway still has the last word).
  const me = await client.request<{ principal?: { scopes?: string[] } }>('GET', '/v1/me');
  const scopes = me.principal?.scopes ?? [];
  if (!scopes.includes('approve') && !scopes.includes('admin'))
    throw new Fault('scope_denied', scopeHint, 403);
  const pending = await pendingFor(client, o.run);
  if (!pending.length)
    throw new Fault(
      'approval_not_found',
      bi(
        `运行 ${o.run} 没有待审批项（可能已处理、已过期，或它在等调用方回传工具结果）。`,
        `Run ${o.run} has no pending approvals (they may be decided or expired, or the run waits for the caller's tool result).`,
      ),
      404,
    );
  const target = o.action ? pending.filter((a) => a.id === o.action) : pending;
  if (o.action && !target.length)
    throw new Fault(
      'approval_not_found',
      bi(
        `运行 ${o.run} 没有待审批项 ${o.action}。现有：${pending.map((a) => a.id).join('、')}`,
        `Run ${o.run} has no pending approval ${o.action}. Pending: ${pending.map((a) => a.id).join(', ')}`,
      ),
      404,
    );
  if (!o.action && !o.all && pending.length > 1)
    throw new Fault(
      'approval_ambiguous',
      bi(
        `运行 ${o.run} 有 ${pending.length} 个待审批项，没有任何一项被处理。用 --action ID 指定一项，或用 --all 处理全部：\n${pending.map((a) => `  ${a.id}  ${summarizeDetail(a.detail.preview)}`).join('\n')}`,
        `Run ${o.run} has ${pending.length} pending approvals; none was decided. Pass --action ID for one, or --all for every item:\n${pending.map((a) => `  ${a.id}  ${summarizeDetail(a.detail.preview)}`).join('\n')}`,
      ),
      400,
    );
  const verb = o.decision === 'approve' ? t('批准', 'Approve') : t('拒绝', 'Deny');
  // Show exactly what is being decided before it happens (stderr keeps --json output clean).
  const show = o.json ? (line: string) => void process.stderr.write(line + '\n') : out;
  for (const a of target) {
    show(`${verb}: ${a.id} (${a.kind}, ${t('运行', 'run')} ${o.run})`);
    for (const line of a.detail.preview.split('\n').slice(0, 40)) show(`  ${line}`);
    if (a.detail.truncated || a.detail.preview.split('\n').length > 40)
      show(
        t(
          `  …（内容已截断，完整内容：GET /v1/runs/${o.run}/actions/${a.id}/content）`,
          `  … (truncated; full content: GET /v1/runs/${o.run}/actions/${a.id}/content)`,
        ),
      );
  }
  const interactive =
    o.interactive ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
  if (o.decision === 'approve' && interactive && !o.yes) {
    const ask = o.confirm ?? askTerminal;
    const question = t(
      `确认批准以上 ${target.length} 项？[y/N] `,
      `Approve the ${target.length} item(s) above? [y/N] `,
    );
    if (!(await ask(question)))
      throw new Fault(
        'approval_declined',
        bi('已取消，没有批准任何项。', 'Cancelled; nothing was approved.'),
        400,
      );
  }
  const results: DecisionResult[] = [];
  for (const a of target) {
    try {
      await client.request(
        'POST',
        `/v1/runs/${encodeURIComponent(o.run)}/actions/${encodeURIComponent(a.id)}`,
        {
          decision: o.decision,
          response: o.decision === 'deny' && o.reason ? { reason: o.reason.slice(0, 500) } : {},
        },
      );
      results.push({ run_id: o.run, action_id: a.id, decision: o.decision, ok: true });
    } catch (error) {
      const fault = faultOf(error);
      const message = fault.code === 'scope_denied' ? pick(scopeHint, locale) : fault.message;
      results.push({
        run_id: o.run,
        action_id: a.id,
        decision: o.decision,
        ok: false,
        error: `${fault.code}: ${message}`,
      });
    }
  }
  if (o.json) out(JSON.stringify({ results }, null, 2));
  else
    for (const r of results)
      out(
        r.ok
          ? o.decision === 'approve'
            ? t(`已批准 ${r.action_id}`, `Approved ${r.action_id}`)
            : t(`已拒绝 ${r.action_id}`, `Denied ${r.action_id}`)
          : t(`失败 ${r.action_id}：${r.error}`, `Failed ${r.action_id}: ${r.error}`),
      );
  return results;
}
