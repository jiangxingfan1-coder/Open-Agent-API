import { performance } from 'node:perf_hooks';
import { setup, agent, FixtureModel, principal } from '../test/helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { detectProtocolDialect } from '../src/gateway/uap.js';

async function main() {
  const s = await setup(new FixtureModel(() => ({ text: 'x'.repeat(2048) })));
  try {
    s.store.publish('owner', makeBundle(agent()));

    // 1. Seed 250 dynamic API keys and measure Auth O(1) verification speed
    let lastToken = '';
    for (let i = 0; i < 250; i++) {
      const created = s.auth.create(principal, `bench-key-${i}`, ['*'], ['read', 'invoke']);
      lastToken = String(created.token);
    }
    const authHeader = `Bearer ${lastToken}`;
    const authIterations = 20_000;
    const authStart = performance.now();
    for (let i = 0; i < authIterations; i++) {
      s.auth.revalidate(authHeader);
    }
    const authMs = performance.now() - authStart;

    // 2. Measure O(1) Protocol Auto-Detector throughput
    const payloads = [
      { uap: '1.0', target: 'agent/test', input: 'hello' },
      { protocol: 'oaa/1', agent: 'agent/test', input: 'hello' },
      { model: 'agent/test', input: 'hello' },
      { model: 'agent/test', messages: [{ role: 'user', content: 'hello' }] },
      { model: 'agent/test', max_tokens: 512, messages: [{ role: 'user', content: 'hello' }] },
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    ];
    const detectIterations = 100_000;
    const detectStart = performance.now();
    for (let i = 0; i < detectIterations; i++) {
      detectProtocolDialect(payloads[i % payloads.length]);
    }
    const detectMs = performance.now() - detectStart;

    // 3. Compare HotEventRing recentHistory() vs SQLite history() and UAP-NDJSON vs SSE wire size
    const url = await s.listen();

    const uapRes = await fetch(`${url}/v1/uap`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uap: '1.0',
        target: 'agent/test',
        input: 'stream test',
        delivery: { stream: true, format: 'uap-ndjson' },
      }),
    });
    const runId = uapRes.headers.get('x-run-id')!;
    const uapWireBytes = Buffer.byteLength(await uapRes.text());

    const chatRes = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'agent/test',
        stream: true,
        messages: [{ role: 'user', content: 'stream test' }],
      }),
    });
    const chatWireBytes = Buffer.byteLength(await chatRes.text());

    const replayIterations = 2_000;
    const ringStart = performance.now();
    for (let i = 0; i < replayIterations; i++) {
      s.store.recentHistory(runId, 0, 1000);
    }
    const ringMs = performance.now() - ringStart;

    const sqliteStart = performance.now();
    for (let i = 0; i < replayIterations; i++) {
      s.store.history(runId, 0, 1000);
    }
    const sqliteMs = performance.now() - sqliteStart;

    const summary = {
      auth_o1_revalidate_ops_per_sec: Math.round((authIterations / authMs) * 1000),
      protocol_autodetect_ops_per_sec: Math.round((detectIterations / detectMs) * 1000),
      uap_ndjson_wire_bytes_2k_output: uapWireBytes,
      openai_chat_sse_wire_bytes_2k_output: chatWireBytes,
      wire_byte_reduction_percent: Number(((1 - uapWireBytes / chatWireBytes) * 100).toFixed(1)),
      hot_event_ring_replay_ms_2000_iters: Number(ringMs.toFixed(2)),
      sqlite_history_replay_ms_2000_iters: Number(sqliteMs.toFixed(2)),
      replay_speedup_factor: Number((sqliteMs / Math.max(0.01, ringMs)).toFixed(1)),
    };

    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } finally {
    await s.cleanup();
  }
}

void main();
