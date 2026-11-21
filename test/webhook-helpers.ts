import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { webhookTiming } from '../src/gateway/webhook-core.js';
import { FixtureModel, agent, setup, token, waitFor as waitUntil } from './helpers.js';

// Bounded waits with room for a slow, loaded CI machine (the condition is polled every 10 ms).
export const waitFor = (check: () => boolean | Promise<boolean>, ms = 20_000) =>
  waitUntil(check, ms);

type Hit = {
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
  path?: string;
};

/** A receiver whose answer per request comes from `respond` (status code, or 'hang'). */
export async function receiver(respond: (n: number) => number | 'hang' = () => 200) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      hits.push({ headers: req.headers, body, json: JSON.parse(body), path: req.url });
      const answer = respond(hits.length);
      if (answer === 'hang') return;
      res.writeHead(answer).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    url: `http://127.0.0.1:${port}/hook`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function useWebhookTimings() {
  const saved = { ...webhookTiming, backoffMs: [...webhookTiming.backoffMs] };
  test.beforeEach(() => {
    webhookTiming.backoffMs = [50, 100, 150];
    webhookTiming.jitter = 0;
    webhookTiming.timeoutMs = 2_000;
  });
  test.after(() => Object.assign(webhookTiming, saved));
}

/** The approval-gated writer from approval-outcomes.test.ts. */
export async function writerGateway(extra: Record<string, unknown> = {}) {
  const tool = builtin('write_file');
  tool.capability.requiresApproval = true;
  const s = await setup(
    new FixtureModel((_a, m) =>
      m.some((x) => x.role === 'tool')
        ? { text: 'written and done' }
        : { calls: [{ id: 'w', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }] },
    ),
    { approvalTimeoutMs: 30_000, ...extra },
  );
  s.store.publish('owner', makeBundle(agent({ tools: [tool] })));
  return s;
}

export async function addEndpoint(
  s: Awaited<ReturnType<typeof setup>>,
  body: Record<string, unknown>,
): Promise<{ id: string; secret: string }> {
  const r = await s.request('POST', '/v1/webhooks', body);
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}

type Inject = (o: {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
}) => Promise<{ json(): { data: { status: string }[] } }>;
export type DeliveryRow = {
  id: string;
  status: string;
  http_status: number | null;
  attempts: number;
  last_error: string | null;
};

/**
 * Wait until the endpoint has at least `count` deliveries and none of them is pending any more.
 * The receiver records a request before it answers, and the gateway records the outcome only after
 * the answer arrives, so "the receiver saw it" is not yet "the delivery is settled".
 */
export async function settled(
  app: { inject: Inject },
  endpointId: string,
  count: number,
): Promise<DeliveryRow[]> {
  let rows: DeliveryRow[] = [];
  await waitFor(async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${endpointId}/deliveries`,
      headers: { authorization: `Bearer ${token}` },
    });
    rows = r.json().data as DeliveryRow[];
    return rows.length >= count && rows.every((d) => d.status !== 'pending');
  }, 20_000);
  return rows;
}

export async function start(s: Awaited<ReturnType<typeof setup>>, input = 'write') {
  const r = await s.request('POST', '/v1/responses', {
    model: 'agent/test',
    input,
    background: true,
  });
  return r.json().id as string;
}
