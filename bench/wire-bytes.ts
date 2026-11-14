// Port-free replica of the wire-size part of bench/protocol-speed.ts: the same workload is sent
// through app.inject, so compatibility stream bytes can be checked without listening on a port.
// Usage: node dist/bench/wire-bytes.js
import { setup, agent, FixtureModel, principal } from '../test/helpers.js';
import { makeBundle } from '../src/lang/bundle.js';

const s = await setup(new FixtureModel(() => ({ text: 'x'.repeat(2048) })));
try {
  s.store.publish('owner', makeBundle(agent()));
  let lastToken = '';
  for (let i = 0; i < 250; i++)
    lastToken = String(s.auth.create(principal, `bench-key-${i}`, ['*'], ['read', 'invoke']).token);
  const headers = { authorization: `Bearer ${lastToken}`, 'content-type': 'application/json' };
  const uap = await s.app.inject({
    method: 'POST',
    url: '/v1/uap',
    headers,
    payload: JSON.stringify({
      uap: '1.0',
      target: 'agent/test',
      input: 'stream test',
      delivery: { stream: true, format: 'uap-ndjson' },
    }),
  });
  const chat = await s.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
    payload: JSON.stringify({
      model: 'agent/test',
      stream: true,
      messages: [{ role: 'user', content: 'stream test' }],
    }),
  });
  process.stdout.write(
    JSON.stringify(
      {
        uap_ndjson_wire_bytes_2k_output: Buffer.byteLength(uap.body),
        openai_chat_sse_wire_bytes_2k_output: Buffer.byteLength(chat.body),
        uap_status: uap.statusCode,
        chat_status: chat.statusCode,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await s.cleanup();
}
