/**
 * `oaa webhook add|list|remove|test|deliveries` (docs/webhooks.md). Needs an owner-wide admin key.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { GatewayClient } from './client.js';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { Fault, sleep, writePrivate } from '../core/util.js';

export type WebhookFlags = {
  /** `webhook add`: write the signing secret to this new private file instead of printing it. */
  out?: string;
  event?: string[];
  agent?: string[];
  'include-output'?: boolean;
  limit?: string;
  json?: boolean;
};

type Delivery = {
  id: string;
  event_type: string;
  run_id: string | null;
  status: string;
  attempts: number;
  http_status: number | null;
  duration_ms: number | null;
  last_error: string | null;
  created_at: number;
};
type Endpoint = {
  id: string;
  url: string;
  events: string[];
  agents: string[];
  include_output: boolean;
  enabled: boolean;
  description: string;
  secret?: string;
  status: {
    state: string;
    consecutive_failures: number;
    pending: number;
    latest_delivery: Delivery | null;
  };
};

const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function deliveryLine(d: Delivery, locale: Locale): string {
  const http = d.http_status === null ? '—' : String(d.http_status);
  const took = d.duration_ms === null ? '' : ` ${d.duration_ms}ms`;
  const tries = pick(bi(`尝试 ${d.attempts} 次`, `${d.attempts} attempt(s)`), locale);
  const error = d.last_error ? `  ${d.last_error}` : '';
  return `${d.id}  ${time(d.created_at)}  ${d.event_type}  ${d.status}  HTTP ${http}${took}  ${tries}${error}`;
}

export function renderEndpoints(list: Endpoint[], locale: Locale = processLocale()): string[] {
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  if (!list.length) return [t('还没有事件回调端点。', 'No webhook endpoints yet.')];
  return list.flatMap((e) => [
    `${e.id}  ${e.url}  ${e.status.state}`,
    `  ${t('事件', 'events')}: ${e.events.length ? e.events.join(', ') : t('全部', 'all')}` +
      `  ${t('智能体', 'agents')}: ${e.agents.length ? e.agents.join(', ') : t('全部', 'all')}` +
      (e.include_output ? `  ${t('带输出', 'with output')}` : '') +
      (e.description ? `  ${t('备注', 'note')}: ${e.description}` : ''),
    `  ${t('排队', 'queued')}: ${e.status.pending}  ${t('连续失败', 'consecutive failures')}: ${e.status.consecutive_failures}` +
      (e.status.latest_delivery
        ? `  ${t('最近一次', 'latest')}: ${deliveryLine(e.status.latest_delivery, locale)}`
        : ''),
  ]);
}

export async function runWebhookCommand(
  client: GatewayClient,
  args: string[],
  flags: WebhookFlags,
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  locale: Locale = processLocale(),
): Promise<void> {
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  const [sub, target] = args;
  const json = (v: unknown) => out(JSON.stringify(v, null, 2));
  const needId = () => {
    if (!target)
      throw new Fault(
        'arguments',
        bi(`webhook ${sub} 需要端点编号（wh_…）。`, `webhook ${sub} needs an endpoint ID (wh_…).`),
      );
    return encodeURIComponent(target);
  };
  if (sub === 'add') {
    if (!target)
      throw new Fault(
        'arguments',
        bi('webhook add 需要回调地址 URL。', 'webhook add needs a URL.'),
      );
    // Refuse an existing --out file before creating anything, so the secret is never lost.
    if (
      flags.out &&
      (await access(flags.out).then(
        () => true,
        () => false,
      ))
    )
      throw new Fault(
        'output_exists',
        bi(`${flags.out} 已存在，不会覆盖。`, `${flags.out} already exists; not overwritten.`),
      );
    const created = await client.request<Endpoint>('POST', '/v1/webhooks', {
      url: target,
      events: flags.event ?? [],
      agents: flags.agent ?? [],
      include_output: flags['include-output'] === true,
    });
    if (flags.out) {
      const file = path.resolve(flags.out);
      await writePrivate(path.dirname(file), path.basename(file), `${created.secret}\n`, true);
      delete created.secret;
    }
    if (flags.json)
      return json(flags.out ? { ...created, secret_file: path.resolve(flags.out) } : created);
    out(t(`已添加事件回调端点 ${created.id}`, `Added webhook endpoint ${created.id}`));
    out(renderEndpoints([created], locale)[1]!);
    if (flags.out)
      out(
        t(
          `签名密钥已写入 ${path.resolve(flags.out)}（权限 0600）`,
          `Signing secret written to ${path.resolve(flags.out)} (mode 0600)`,
        ),
      );
    else
      out(
        `${t('签名密钥（只显示这一次，请妥善保存；用 --out FILE 可改为写入私有文件）', 'Signing secret (shown only once; keep it safe; --out FILE writes it to a private file instead)')}: ${created.secret}`,
      );
    return;
  }
  if (sub === 'list') {
    const { data } = await client.request<{ data: Endpoint[] }>('GET', '/v1/webhooks');
    if (flags.json) return json(data);
    for (const line of renderEndpoints(data, locale)) out(line);
    return;
  }
  if (sub === 'remove') {
    await client.request('DELETE', `/v1/webhooks/${needId()}`);
    if (flags.json) return json({ id: target, deleted: true });
    out(
      t(
        `已删除 ${target}，队列里未发出的投递一并删除。`,
        `Deleted ${target} and its queued deliveries.`,
      ),
    );
    return;
  }
  if (sub === 'test') {
    const queued = await client.request<Delivery>('POST', `/v1/webhooks/${needId()}/test`);
    // Wait briefly for the first attempt so the result can be shown.
    let latest = queued;
    for (let i = 0; i < 60 && latest.attempts === 0; i++) {
      await sleep(250);
      const { data } = await client.request<{ data: Delivery[] }>(
        'GET',
        `/v1/webhooks/${needId()}/deliveries?limit=20`,
      );
      latest = data.find((d) => d.id === queued.id) ?? latest;
    }
    if (flags.json) return json(latest);
    out(deliveryLine(latest, locale));
    if (latest.attempts === 0)
      out(
        t(
          '还没有发出（端点停用或前面有排队的投递）。',
          'Not sent yet (endpoint disabled or deliveries queued ahead of it).',
        ),
      );
    else if (latest.status !== 'succeeded') process.exitCode = 1;
    return;
  }
  if (sub === 'deliveries') {
    const limit = flags.limit ? `?limit=${encodeURIComponent(flags.limit)}` : '';
    const { data } = await client.request<{ data: Delivery[] }>(
      'GET',
      `/v1/webhooks/${needId()}/deliveries${limit}`,
    );
    if (flags.json) return json(data);
    if (!data.length) out(t('还没有投递记录。', 'No deliveries yet.'));
    for (const d of data) out(deliveryLine(d, locale));
    return;
  }
  throw new Fault(
    'arguments',
    bi(
      '用法：oaa webhook add URL | list | remove ID | test ID | deliveries ID',
      'Usage: oaa webhook add URL | list | remove ID | test ID | deliveries ID',
    ),
  );
}
