// Separate event loop and process: slow gateway SQL must be visible to the HTTP clock.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifySignature } from '../src/gateway/webhook-core.js';

type Command = { base: string; token: string; secret: string; samples: number; clients: number };
type Receipt = { at: number; delivery: string };
const receipts = new Map<string, Receipt>(),
  arrived = new EventEmitter();
let secret = '',
  invalid = 0,
  duplicates = 0;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const body = Buffer.concat(chunks).toString('utf8');
  const event = JSON.parse(body),
    runId = event.data?.run_id,
    delivery = String(req.headers['x-oaa-delivery'] ?? '');
  if (
    req.url !== '/quiet' ||
    event.type !== 'run.completed' ||
    typeof runId !== 'string' ||
    !delivery ||
    !verifySignature(secret, String(req.headers['x-oaa-signature']), body)
  )
    invalid++;
  else if (receipts.has(runId)) duplicates++;
  else {
    receipts.set(runId, { at: performance.now(), delivery });
    arrived.emit(runId);
  }
  res.writeHead(204).end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.once('disconnect', () => {
  server.close();
  server.closeAllConnections();
});
process.on('message', async (cmd: Command) => {
  try {
    secret = cmd.secret;
    receipts.clear();
    invalid = 0;
    duplicates = 0;
    const submit: number[] = [],
      notice: number[] = [],
      ids = new Set<string>();
    let next = 0;
    await Promise.all(
      Array.from({ length: cmd.clients }, async () => {
        while (next++ < cmd.samples) {
          const started = performance.now();
          const response = await fetch(cmd.base + '/v1/responses', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + cmd.token, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'agent/test', input: 'fixture', background: true }),
            signal: AbortSignal.timeout(30000),
          });
          const run = await response.json();
          if (!response.ok || !run.id)
            throw new Error(
              `Fixture submission failed: ${response.status} ${run.error?.code ?? ''}`,
            );
          submit.push(performance.now() - started);
          if (!receipts.has(run.id))
            await once(arrived, run.id, { signal: AbortSignal.timeout(30000) });
          const receipt = receipts.get(run.id)!;
          ids.add(receipt.delivery);
          notice.push(receipt.at - started);
        }
      }),
    );
    assert.deepEqual(
      [submit.length, receipts.size, ids.size, invalid, duplicates],
      [cmd.samples, cmd.samples, cmd.samples, 0, 0],
    );
    const percentiles = (xs: number[]) => {
      const sorted = xs.toSorted((a, b) => a - b);
      const at = (p: number) => Number(sorted[Math.ceil(p * sorted.length) - 1]!.toFixed(3));
      return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
    };
    process.send!({
      verified: receipts.size,
      submit_ms: percentiles(submit),
      notification_ms: percentiles(notice),
    });
  } catch (error) {
    process.send!({ error: String(error) });
  }
});
process.send!({ receiver: 'http://127.0.0.1:' + (server.address() as AddressInfo).port });
