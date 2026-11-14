import test from 'node:test';
import assert from 'node:assert/strict';
import { readSseStream, readResponseText } from '../src/providers/http-stream.js';
import { Fault } from '../src/core/util.js';
import { probeA2A, runA2A } from '../src/engines/a2a.js';
import { workerSchema } from '../src/config/config.js';
import { agent } from './helpers.js';

const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}
function response(text: string, size = 1, close = true) {
  const bytes = Buffer.from(text);
  let offset = 0,
    cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      } else if (close) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    cancelled: () => cancelled,
    body,
  };
}

for (const newline of ['\n', '\r\n', '\r'])
  test(`SSE handles ${JSON.stringify(newline)} at every byte boundary without changing payload spaces`, async () => {
    const text =
      '\ufeff' +
      [
        'event: result',
        ': comment',
        'data:  保留 空格',
        'data:\tsecond',
        '',
        'data',
        '',
        'data: unfinished',
      ].join(newline);
    const source = response(text);
    const events = await collect(readSseStream(source.response, signal()));
    assert.deepEqual(
      events.map(({ event, data }) => ({ event, data })),
      [
        { event: 'result', data: ' 保留 空格\n\tsecond' },
        { event: 'message', data: '' },
      ],
    );
    assert.equal(source.body.locked, false);
  });

test('EOF never dispatches an unfinished terminal frame, even with a final newline', async () => {
  for (const tail of ['data: {"completed":true}', 'data: {"completed":true}\n']) {
    assert.deepEqual(await collect(readSseStream(response(tail, 100).response, signal())), []);
  }
});

test('SSE bounds unfinished lines, multi-line events, single-chunk events and total wire bytes', async () => {
  for (const wire of [
    'data: ' + 'x'.repeat(80),
    'data: ' + 'x'.repeat(40) + '\ndata: ' + 'x'.repeat(40),
    'data: ' + 'x'.repeat(80) + '\n\n',
    'data: ' + '界'.repeat(30) + '\n\n',
  ]) {
    for (const chunkSize of [1, 1024]) {
      const source = response(wire, chunkSize, false);
      await assert.rejects(
        collect(readSseStream(source.response, signal(), { maxEventBytes: 64 })),
        (error) => error instanceof Fault && error.code === 'upstream_output_limit',
      );
      assert.equal(source.cancelled(), true);
      assert.equal(source.body.locked, false);
    }
  }
  const source = response('data: x\n\n'.repeat(10), 10, false);
  await assert.rejects(
    collect(
      readSseStream(source.response, signal(), { maxBytes: 50, limitCode: 'adapter_output_limit' }),
    ),
    (error) => error instanceof Fault && error.code === 'adapter_output_limit',
  );
  assert.equal(source.cancelled(), true);
});

test('reader cancellation interrupts a stalled read and releases the stream lock', async () => {
  const controller = new AbortController();
  const source = response('', 1, false);
  const task = collect(readSseStream(source.response, controller.signal));
  const rejected = assert.rejects(
    task,
    (error) => error instanceof Fault && error.code === 'cancelled',
  );
  await tick();
  controller.abort();
  await rejected;
  assert.equal(source.cancelled(), true);
  assert.equal(source.body.locked, false);
});

test('consumer early return cancels the response instead of retaining its connection', async () => {
  const source = response('data: ready\n\n', 2, false);
  for await (const event of readSseStream(source.response, signal())) {
    assert.equal(event.data, 'ready');
    break;
  }
  assert.equal(source.cancelled(), true);
  assert.equal(source.body.locked, false);
});

test('a bare-CR terminal event dispatches without waiting for EOF or another chunk', async () => {
  const source = response('data: ready\r\r', 100, false);
  const stream = readSseStream(source.response, signal());
  const guard = setTimeout(() => {}, 500);
  try {
    assert.equal((await stream.next()).value?.data, 'ready');
  } finally {
    clearTimeout(guard);
    await stream.return(undefined);
  }
  assert.equal(source.cancelled(), true);
});

test('non-streaming response limits count UTF-8 bytes before collecting the complete body', async () => {
  const source = response('界'.repeat(30), 1, false);
  await assert.rejects(
    readResponseText(source.response, signal(), {
      maxBytes: 64,
      limitCode: 'adapter_output_limit',
    }),
    (error) => error instanceof Fault && error.code === 'adapter_output_limit',
  );
  assert.equal(source.cancelled(), true);
  assert.equal(source.body.locked, false);
  assert.equal(await readResponseText(response('保留 utf8', 1).response, signal()), '保留 utf8');
});

const a2aConfig = workerSchema.parse({
  nodeId: 'fixture',
  dataDir: '/tmp/unused-oaa-stream-test',
  adapters: { peer: { transport: 'a2a', enabled: true, url: 'https://fixture.invalid/rpc' } },
});
const a2aAgent = agent({ engine: 'adapter/peer', instructions: '' });
const wire = [
  { result: { artifactUpdate: { taskId: 't', artifact: { parts: [{ text: 'answer' }] } } } },
  { result: { statusUpdate: { taskId: 't', status: { state: 'TASK_STATE_COMPLETED' } } } },
]
  .map((value) => `data: ${JSON.stringify(value)}\n\n`)
  .join('');

test('A2A waits for output persistence before returning completion', async () => {
  const gate = Promise.withResolvers<void>();
  const source = response(wire, 4096, false);
  let settled = false;
  const task = runA2A(
    a2aAgent,
    a2aConfig,
    'fixture',
    signal(),
    async () => {
      await gate.promise;
    },
    undefined,
    (async () => source.response) as typeof fetch,
  ).finally(() => {
    settled = true;
  });
  try {
    await tick();
    assert.equal(settled, false);
  } finally {
    gate.resolve();
  }
  assert.equal((await task).text, 'answer');
  assert.equal(source.cancelled(), true);
});

test('A2A never swallows output persistence failures or trusts an unterminated final frame', async () => {
  const source = response(wire, 4096, false);
  const failure = new Fault('persistence_failed', 'Fixture store failure', 500);
  await assert.rejects(
    runA2A(
      a2aAgent,
      a2aConfig,
      'fixture',
      signal(),
      async () => {
        throw failure;
      },
      undefined,
      (async () => source.response) as typeof fetch,
    ),
    (error) => error === failure,
  );
  assert.equal(source.cancelled(), true);
  await assert.rejects(
    runA2A(
      a2aAgent,
      a2aConfig,
      'fixture',
      signal(),
      async () => {},
      undefined,
      (async () => response(wire.trimEnd(), 10).response) as typeof fetch,
    ),
    (error) => error instanceof Fault && error.code === 'native_incomplete',
  );
});

test('A2A handshake rejects malformed cards and bounds UTF-8 bytes before decoding JSON', async () => {
  const adapter = a2aConfig.adapters.peer!;
  assert.equal(adapter.transport, 'a2a');
  if (adapter.transport !== 'a2a') throw new Error('fixture');
  for (const body of ['not-json', '{}', '{"name":""}']) {
    await assert.rejects(
      probeA2A(adapter, (async () => new Response(body)) as typeof fetch),
      (error) => error instanceof Fault && error.code === 'invalid_protocol',
    );
  }
  const large = response('界'.repeat(3 * 1024 * 1024), 65536, false);
  await assert.rejects(
    probeA2A(adapter, (async () => large.response) as typeof fetch),
    (error) => error instanceof Fault && error.code === 'adapter_output_limit',
  );
  assert.equal(large.cancelled(), true);
});

test('自研 SSE 解析器遵循事件流规则：注释、多行 data、冒号后只去一个空格、无 data 不派发', async () => {
  const text = [
    ': keep-alive comment',
    'event: first',
    'data: line one',
    'data:line two',
    'data:  two leading spaces',
    'id: 7',
    'retry: 3000',
    'unknown: ignored',
    '',
    'event: no-data-is-not-dispatched',
    '',
    'data',
    '',
    'data: default event name',
    'id: bad\u0000id',
    '',
    'data: unfinished frame at EOF',
  ].join('\n');
  for (const size of [1, 3, 7, 1000]) {
    const events = await collect(readSseStream(response(text, size).response, signal()));
    assert.deepEqual(
      events,
      [
        { id: '7', event: 'first', data: 'line one\nline two\n two leading spaces' },
        { event: 'message', data: '' },
        { event: 'message', data: 'default event name' },
      ],
      `chunk size ${size}`,
    );
  }
  // CR 与 CRLF 行结束符等价于 LF，即使 CRLF 被拆在两个分片里。
  const crlf = 'data: a\r\n\r\ndata: b\r\rdata: c\n\n';
  for (const size of [1, 2, 5, 100])
    assert.deepEqual(
      (await collect(readSseStream(response(crlf, size).response, signal()))).map((e) => e.data),
      ['a', 'b', 'c'],
      `chunk size ${size}`,
    );
});
