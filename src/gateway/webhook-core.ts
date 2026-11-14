/**
 * Run-event webhooks (docs/webhooks.md): the pure parts shared by the dispatcher, the routes and
 * the tests — event names, signatures, the retry schedule, payload shaping and URL / address rules.
 * Nothing here touches the database or the network.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { RunStatus } from '../core/contracts.js';
import { Fault } from '../core/util.js';

/**
 * Webhook event types. Each maps 1:1 to a run status of the kernel state machine
 * (core/run-status.ts) and to the run event the kernel writes when entering it
 * (`run.requires_action`, `response.completed` / `failed` / `cancelled` / `incomplete`,
 * `run.interrupted` in core/events.ts). The names are derived as `run.<status>` so they are not
 * mistaken for run-event literals (they are a separate, outbound namespace).
 */
const WEBHOOK_STATUSES = [
  'requires_action',
  'completed',
  'failed',
  'cancelled',
  'incomplete',
  'interrupted',
] as const satisfies readonly RunStatus[];
export type WebhookEvent = `run.${(typeof WEBHOOK_STATUSES)[number]}`;
const eventOf = (s: (typeof WEBHOOK_STATUSES)[number]): WebhookEvent => `run.${s}`;
export const WEBHOOK_EVENTS = WEBHOOK_STATUSES.map(eventOf) as [WebhookEvent, ...WebhookEvent[]];
/** Sent only by `POST /v1/webhooks/{id}/test`; never subscribed to. */
export const TEST_EVENT = 'webhook.test';

export const STATUS_EVENTS: Partial<Record<RunStatus, WebhookEvent>> = Object.fromEntries(
  WEBHOOK_STATUSES.map((s) => [s, eventOf(s)]),
);

/** Timing knobs; tests shorten them through `webhookTiming` (the gateway never changes them). */
export const webhookTiming = {
  /** Delay before retry n (1-based) in ms; its length + 1 is the attempt budget. */
  backoffMs: [5_000, 30_000, 120_000, 600_000, 1_800_000] as number[],
  /** Each delay is spread by ±jitter (0.2 = ±20 %). */
  jitter: 0.2,
  timeoutMs: 10_000,
};

/** Delay before the retry that follows `attempts` failed attempts, or undefined when exhausted. */
export function retryDelay(
  attempts: number,
  schedule = webhookTiming.backoffMs,
  jitter = webhookTiming.jitter,
  random = Math.random,
): number | undefined {
  const base = schedule[attempts - 1];
  if (base === undefined) return undefined;
  return Math.max(0, Math.round(base * (1 + jitter * (random() * 2 - 1))));
}

/** `X-OAA-Signature` value: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`. */
export function signature(secret: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/** Receiver-side check (also used by the tests and documented in docs/webhooks.md). */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  now = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const parts = new Map(
    header.split(',').map((p) => {
      const at = p.indexOf('=');
      return [p.slice(0, at).trim(), p.slice(at + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1') ?? '';
  if (!Number.isInteger(t) || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signature(secret, t, body).split('v1=')[1]!, 'hex');
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(v1) ? v1 : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Largest final output carried with `include_output: true` (UTF-8 bytes). */
export const OUTPUT_LIMIT_BYTES = 32 * 1024;

/** Cut `text` to at most `limit` UTF-8 bytes without splitting a character. */
export function truncateOutput(
  text: string,
  limit = OUTPUT_LIMIT_BYTES,
): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= limit) return { text, truncated: false, bytes };
  let cut = Buffer.from(text).subarray(0, limit).toString('utf8');
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return { text: cut, truncated: true, bytes };
}

export type PendingItem = {
  id: string;
  type: string;
  title: string;
  status: string;
  expires_at: number;
};

/** One-line title of an approval's detail (title, tool or name, else a clipped JSON preview). */
export function pendingTitle(detail: Record<string, unknown>): string {
  const pick = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const call =
    detail.toolCall && typeof detail.toolCall === 'object'
      ? (detail.toolCall as Record<string, unknown>)
      : detail;
  const title = pick(call.title) ?? pick(call.tool) ?? pick(call.name) ?? pick(detail.native) ?? '';
  const text = title || JSON.stringify(detail);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export type RunFacts = {
  id: string;
  agentId: string;
  digest: string;
  status: string;
  error: { code: string; message: string } | null;
  usage: unknown;
  keyId?: string | undefined;
  subject?: string | undefined;
  createdAt: number;
  updatedAt: number;
  output?: string | undefined;
};

const seconds = (ms: number) => Math.floor(ms / 1000);

/** The `data` object of a run event: a run summary, never the task input. */
export function runData(
  run: RunFacts,
  status: string,
  options: { pending?: PendingItem[]; includeOutput?: boolean } = {},
): Record<string, unknown> {
  return {
    object: 'run',
    run_id: run.id,
    agent: run.agentId,
    agent_version: run.digest,
    status,
    error: run.error,
    usage: run.usage ?? null,
    key_id: run.keyId ?? null,
    subject: run.subject ?? null,
    created_at: seconds(run.createdAt),
    updated_at: seconds(run.updatedAt),
    ...(options.pending ? { pending_actions: options.pending } : {}),
    ...(options.includeOutput && run.output !== undefined
      ? { output: truncateOutput(run.output) }
      : {}),
  };
}

/** Does an endpoint want this event for this agent? Empty lists mean "all". */
export function wants(
  endpoint: { enabled: boolean; events: string[]; agents: string[] },
  type: string,
  agent: string,
): boolean {
  return (
    endpoint.enabled &&
    (endpoint.events.length === 0 || endpoint.events.includes(type)) &&
    (endpoint.agents.length === 0 || endpoint.agents.includes(agent))
  );
}

// Addresses refused under the `public` security profile unless the endpoint allows them:
// loopback, RFC 1918 / ULA private ranges, link-local (incl. 169.254.169.254 metadata),
// CGNAT (incl. 100.100.100.200 metadata), "this network", and their IPv4-mapped IPv6 forms.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** Strip `[…]` and unwrap IPv4-mapped IPv6 (`::ffff:a.b.c.d`). */
function plainAddress(address: string): string {
  const bare = address.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  return mapped ? mapped[1]! : bare;
}

/** Private, loopback, link-local or metadata address (a literal IP). */
export function isPrivateAddress(address: string): boolean {
  const ip = plainAddress(address);
  const family = isIP(ip);
  if (!family) return false;
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export function isLoopbackHost(host: string): boolean {
  const h = plainAddress(host).toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  return h === '::1';
}

export type TargetPolicy = {
  profile: 'local' | 'public';
  allowInsecureHttp: boolean;
  allowPrivateNetwork: boolean;
};

/** Validate an endpoint URL at creation / update time. Throws `webhook_url_invalid` / `webhook_target_denied`. */
export function checkWebhookUrl(raw: string, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Fault('webhook_url_invalid', 'The webhook URL is not a valid absolute URL.', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Fault('webhook_url_invalid', 'The webhook URL must use http or https.', 400);
  if (url.username || url.password)
    throw new Fault('webhook_url_invalid', 'The webhook URL must not contain credentials.', 400);
  if (url.hash)
    throw new Fault('webhook_url_invalid', 'The webhook URL must not have a #fragment.', 400);
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !policy.allowInsecureHttp)
    throw new Fault(
      'webhook_url_invalid',
      'Only loopback webhook URLs may use plain http; use https or set allow_insecure_http.',
      400,
    );
  checkTarget(url.hostname, policy);
  return url;
}

/**
 * The address rule of the `public` profile, applied to a literal host at configuration time and to
 * every resolved address right before connecting (see the dispatcher's `lookup`).
 */
export function checkTarget(host: string, policy: TargetPolicy): void {
  if (policy.profile !== 'public' || policy.allowPrivateNetwork) return;
  if (isLoopbackHost(host) || isPrivateAddress(host))
    throw new Fault(
      'webhook_target_denied',
      `Webhook target ${host} is a private, loopback, link-local or metadata address; the public security profile refuses it unless the endpoint sets allow_private_network.`,
      400,
    );
}

/** OpenAPI entries for the webhook routes (spread into openapi.ts). */
export const WEBHOOK_OPERATIONS: [string, string, string][] = [
  ['/v1/webhooks', 'get', 'Owner-wide admin: list webhook endpoints with delivery status'],
  [
    '/v1/webhooks',
    'post',
    'Owner-wide admin: create a webhook endpoint; the secret is returned once',
  ],
  ['/v1/webhooks/{id}', 'get', 'Owner-wide admin: read one webhook endpoint'],
  ['/v1/webhooks/{id}', 'patch', 'Owner-wide admin: update a webhook endpoint'],
  ['/v1/webhooks/{id}', 'delete', 'Owner-wide admin: delete an endpoint and its queued deliveries'],
  ['/v1/webhooks/{id}/rotate-secret', 'post', 'Owner-wide admin: replace the signing secret'],
  ['/v1/webhooks/{id}/test', 'post', 'Owner-wide admin: queue a webhook.test event'],
  ['/v1/webhooks/{id}/deliveries', 'get', 'Owner-wide admin: recent deliveries, newest first'],
  [
    '/v1/webhooks/{id}/deliveries/{delivery}/redeliver',
    'post',
    'Owner-wide admin: queue a delivery again (same delivery ID)',
  ],
];
