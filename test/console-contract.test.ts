import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitySchema } from '../src/core/contracts.js';
import { makeBundle } from '../src/lang/bundle.js';
import { agent, FixtureModel, researchBundle, researchFixture, setup, waitFor } from './helpers.js';
import { ADMIN, call, withPlatform } from './platform-http.js';

// The console (web/console.js, web/run-inspector.js) reads exactly these fields. Renaming any of
// them silently empties the operations cockpit, the run timeline or the queue hints, so the
// shapes the browser depends on are pinned here (in-process inject; no sockets, no models).
const CONSOLE_FEATURES = [
  'overview-activity-v1',
  'overview-events-v1',
  'queue-insight-v1',
  'run-timeline-v1',
];
const SPAN_KINDS = new Set([
  'queue',
  'model',
  'tool',
  'approval',
  'subagent',
  'interrupted',
  'native',
]);
const SPAN_STATUSES = new Set([
  'completed',
  'failed',
  'cached',
  'running',
  'waiting',
  'uncertain',
  'cancelled',
]);
const COUNTS = ['started', 'completed', 'failed', 'cancelled', 'interrupted', 'active'];
const BREAKDOWN = ['queue', 'model', 'tools', 'approval', 'other'];

test('console contract: features, overview metrics, activity pulse and run timeline', async () => {
  const s = await setup(researchFixture());
  try {
    s.store.publish('owner', researchBundle());
    const files = [];
    for (let i = 0; i < 3; i++)
      files.push(
        (
          await s.request('POST', '/v1/files', { filename: `source-${i}.txt`, content: `S${i}` })
        ).json().id,
      );
    const r = await s.request('POST', '/v1/responses', {
      model: 'agent/research',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Create a report.' },
            ...files.map((file_id: string) => ({ type: 'input_file', file_id })),
          ],
        },
      ],
    });
    assert.equal(r.json().status, 'completed', r.body);
    const id = r.json().id as string;

    // Capability negotiation replaces 404 probing in the console.
    const health = await s.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    for (const feature of CONSOLE_FEATURES)
      assert.ok(health.json().features.includes(feature), feature);

    // "需要处理" and the Dock badge read requires_action; the KPI note reads the split.
    const overview = (await s.request('GET', '/v1/overview')).json();
    for (const key of ['runs', 'completed', 'active', 'queued', 'in_progress', 'requires_action'])
      assert.equal(typeof overview.metrics[key], 'number', key);
    assert.equal(
      overview.metrics.queued + overview.metrics.in_progress + overview.metrics.requires_action,
      overview.metrics.active,
    );
    const row = overview.runs.find((x: { id: string }) => x.id === id);
    assert.ok(row, 'run listed in overview');
    assert.equal(typeof row.created_at, 'number', 'created_at is epoch ms (local elapsed timer)');
    assert.equal(typeof row.elapsed_ms, 'number');

    for (const [window, count] of [
      ['24h', 24],
      ['7d', 28],
    ] as const) {
      const res = await s.request('GET', `/v1/overview/activity?window=${window}`);
      assert.equal(res.statusCode, 200, res.body);
      const a = res.json();
      assert.equal(a.window, window);
      assert.equal(typeof a.bucket_ms, 'number');
      assert.equal(a.buckets.length, count);
      for (const b of a.buckets) {
        assert.ok(Number.isFinite(Date.parse(b.start)), 'bucket start is an ISO timestamp');
        for (const key of COUNTS) assert.equal(typeof b[key], 'number', key);
      }
      for (const key of COUNTS) assert.equal(typeof a.totals[key], 'number', key);
      const rate = a.totals.success_rate;
      assert.ok(rate === null || (rate >= 0 && rate <= 1), 'success_rate is a ratio');
      for (const key of ['p50', 'p95', 'samples']) assert.ok(key in a.latency_ms, key);
      assert.ok(a.latency_ms.samples >= 1);
      assert.ok(a.breakdown_ms, 'a finished run yields a breakdown');
      for (const key of [...BREAKDOWN, 'runs'])
        assert.equal(typeof a.breakdown_ms[key], 'number', key);
      assert.ok(a.agents.some((x: { agent: string }) => x.agent === 'agent/research'));
      for (const stats of a.agents)
        for (const key of ['agent', 'runs', 'completed', 'failed', 'p50_ms'])
          assert.ok(key in stats, key);
      // The console re-reads with If-None-Match; an unchanged pulse costs a 304.
      const etag = res.headers.etag as string;
      assert.ok(etag);
      const again = await s.request(
        'GET',
        `/v1/overview/activity?window=${window}`,
        undefined,
        undefined,
        { 'if-none-match': etag },
      );
      assert.equal(again.statusCode, 304);
    }

    const tl = (await s.request('GET', `/v1/runs/${id}/timeline`)).json();
    assert.equal(typeof tl.total_ms, 'number');
    assert.equal(typeof tl.critical_path_ms, 'number');
    assert.equal(typeof tl.truncated, 'boolean');
    for (const key of BREAKDOWN) assert.equal(typeof tl.breakdown_ms[key], 'number', key);
    assert.ok(tl.spans.length > 0);
    assert.ok(tl.spans.some((span: { critical: boolean }) => span.critical));
    for (const span of tl.spans) {
      assert.ok(SPAN_KINDS.has(span.kind), span.kind);
      assert.ok(SPAN_STATUSES.has(span.status), span.status);
      assert.equal(typeof span.lane, 'number');
      assert.equal(typeof span.critical, 'boolean');
      assert.ok(Array.isArray(span.depends_on));
      assert.equal(typeof span.ref, 'object');
      assert.ok(span.label === null || typeof span.label === 'string');
      // Offsets are relative to created_at, never epoch timestamps.
      assert.ok(span.start_ms >= 0 && span.start_ms <= tl.total_ms, `${span.id} start_ms`);
      assert.ok(
        span.end_ms === null || (span.end_ms >= span.start_ms && span.end_ms <= tl.total_ms),
        `${span.id} end_ms`,
      );
    }
  } finally {
    await s.cleanup();
  }
});

// 概览「进行中」的小字读 metrics.awaiting_caller（停在调用方工具上的请求数）；「调用地址」页的
// 「调用方自己也是智能体时」一节看 /health 的 features 是否含 client-tools-policy-v1。
test('console contract: overview metrics carry awaiting_caller; health advertises client-tools-policy-v1', async () => {
  const s = await setup(researchFixture());
  try {
    const overview = (await s.request('GET', '/v1/overview')).json();
    assert.equal(typeof overview.metrics.awaiting_caller, 'number');
    const health = await s.app.inject({ method: 'GET', url: '/health' });
    assert.ok(health.json().features.includes('client-tools-policy-v1'));
  } finally {
    await s.cleanup();
  }
});

// 请求列表与概览的 runs 行带 waiting_on：停在调用方工具上是 caller（显示「等待调用方」，不进
// 「需要处理」），等人工审批是 owner；不是 requires_action 时没有这个键。
test('console contract: list and overview rows carry waiting_on for requires_action runs', async () => {
  const s = await setup(
    new FixtureModel((_a, messages) => {
      if (messages.some((m) => m.role === 'tool')) return { text: 'done' };
      if (String(messages.at(-1)?.content ?? '').includes('approve'))
        return { calls: [{ id: 'g', name: 'guarded', arguments: {} }] };
      return { calls: [{ id: 'm1', name: 'edit_file', arguments: { path: 'a.ts' } }] };
    }),
    { approvalTimeoutMs: 10_000 },
  );
  try {
    const capability = capabilitySchema.parse({
      id: 'fixture/guarded',
      version: '1',
      description: 'Approval fixture',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'write',
      requiresApproval: true,
      inputSchema: { type: 'object' },
    });
    s.runtime.config.tools.push({
      reference: 'guarded',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('guarded', async () => ({ value: 'written' }));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/bridge',
          tools: [{ name: 'guarded', capability, handler: { kind: 'node', reference: 'guarded' } }],
        }),
      ),
    );
    const EDIT = {
      type: 'function',
      function: { name: 'edit-file', parameters: { type: 'object', properties: {} } },
    };
    const USER = { role: 'user', content: 'Fix it.' };
    const first = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      { model: 'agent/bridge', tools: [EDIT], messages: [USER] },
      undefined,
      { 'x-oaa-client-tools': 'bridge' },
    );
    assert.equal(first.statusCode, 200, first.body);
    const callerRun = first.headers['x-run-id'] as string;
    const [call] = first.json().choices[0].message.tool_calls;
    const owned = await s.request('POST', '/v1/responses', {
      model: 'agent/bridge',
      input: 'please approve',
      background: true,
    });
    const ownerRun = owned.json().id as string;
    await waitFor(() => s.store.run(ownerRun).status === 'requires_action');
    const rows = async () => {
      const list = (await s.request('GET', '/v1/runs')).json().data as Record<string, unknown>[];
      const overview = (await s.request('GET', '/v1/overview')).json().runs as Record<
        string,
        unknown
      >[];
      return { list, overview };
    };
    const at = (xs: Record<string, unknown>[], id: string) => xs.find((x) => x.id === id)!;
    let { list, overview } = await rows();
    for (const xs of [list, overview]) {
      assert.equal(at(xs, callerRun).status, 'requires_action');
      assert.equal(at(xs, callerRun).waiting_on, 'caller');
      assert.equal(at(xs, ownerRun).status, 'requires_action');
      assert.equal(at(xs, ownerRun).waiting_on, 'owner');
    }
    const before = (await s.request('GET', '/v1/overview')).headers.etag;
    const second = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      {
        model: 'agent/bridge',
        tools: [EDIT],
        messages: [
          USER,
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: 'patched' },
        ],
      },
      undefined,
      { 'x-oaa-client-tools': 'bridge' },
    );
    assert.equal(second.json().choices[0].finish_reason, 'stop', second.body);
    ({ list, overview } = await rows());
    for (const xs of [list, overview]) {
      assert.equal(at(xs, callerRun).status, 'completed');
      assert.equal('waiting_on' in at(xs, callerRun), false);
    }
    assert.notEqual((await s.request('GET', '/v1/overview')).headers.etag, before);
  } finally {
    await s.cleanup();
  }
});

// The console's "开发者平台" page (web/views/platform.js, web/dialogs/platform-*.js) reads and
// sends exactly these fields (docs/platform.md "Endpoint overview"). The requests below are the ones the
// page makes, with the bodies it builds; the response fields are the ones it renders.
const hasFields = (row: object, fields: string[], where: string) => {
  for (const field of fields) assert.ok(field in row, `${where}: missing ${field}`);
};
const numberOrNull = (value: unknown) => value === null || typeof value === 'number';

test('console contract: the developer-platform page reads and sends the documented fields', async () => {
  await withPlatform({ registration: 'invite' }, async (s) => {
    // Feature gate and the data the listing dialog and the portal link come from.
    const health = (await call(s, 'GET', '/health')).json();
    assert.ok(health.features.includes('platform-v1'));
    const overview = (await call(s, 'GET', '/v1/overview', undefined, ADMIN)).json();
    hasFields(
      overview.agents.find((a: { id: string }) => a.id === 'agent/paid'),
      ['id', 'engine'],
      'overview agent',
    );
    assert.equal(typeof overview.endpoints.base_url, 'string');
    assert.equal(
      typeof (await call(s, 'GET', '/v1/me', undefined, ADMIN)).json().principal.owner,
      'string',
    );

    // 上架与定价: the dialog's full body, the row toggles and the encoded delete.
    const put = await call(
      s,
      'PUT',
      '/v1/platform/listings',
      {
        agent_id: 'agent/paid',
        title: 'Paid',
        summary: '',
        tags: ['a'],
        price: { per_run: 1.5, per_1k_tokens: 0.25 },
        enabled: true,
      },
      ADMIN,
    );
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(
      (
        await call(
          s,
          'PUT',
          '/v1/platform/listings',
          { agent_id: 'agent/paid', enabled: false },
          ADMIN,
        )
      ).statusCode,
      200,
    );
    await call(
      s,
      'PUT',
      '/v1/platform/listings',
      { agent_id: 'agent/free', title: 'Free', price: { per_run: 0, per_1k_tokens: 0 } },
      ADMIN,
    );
    const listings = (await call(s, 'GET', '/v1/platform/listings', undefined, ADMIN)).json().data;
    const paid = listings.find((l: { agent_id: string }) => l.agent_id === 'agent/paid');
    hasFields(
      paid,
      [
        'agent_id',
        'title',
        'summary',
        'tags',
        'price',
        'enabled',
        'agent_exists',
        'host_execution',
        'callable',
        'requires_host',
        'blocked_by',
      ],
      'listing',
    );
    hasFields(paid.price, ['per_run', 'per_1k_tokens'], 'listing price');
    assert.ok(Array.isArray(paid.tags));
    assert.equal(typeof paid.enabled, 'boolean');
    assert.equal(typeof paid.agent_exists, 'boolean');
    assert.equal(paid.price.per_1k_tokens, 0.25);
    const removed = await call(
      s,
      'DELETE',
      `/v1/platform/listings?agent_id=${encodeURIComponent('agent/free')}`,
      undefined,
      ADMIN,
    );
    assert.equal(removed.statusCode, 204);

    // 兑换码: the dialog's bodies for both kinds; plaintext only in `data[].code`.
    const credit = await call(
      s,
      'POST',
      '/v1/platform/codes',
      {
        kind: 'credit',
        max_uses: 1,
        count: 2,
        credits: 10,
        expires_at: Date.now() + 7 * 86_400_000,
        note: 'launch',
      },
      ADMIN,
    );
    assert.equal(credit.statusCode, 201, credit.body);
    assert.ok(credit.json().data.every((c: { code?: string }) => typeof c.code === 'string'));
    const invite = await call(
      s,
      'POST',
      '/v1/platform/codes',
      { kind: 'invite', max_uses: 5, count: 1 },
      ADMIN,
    );
    assert.equal(invite.statusCode, 201, invite.body);
    const codes = (await call(s, 'GET', '/v1/platform/codes', undefined, ADMIN)).json().data;
    for (const row of codes) {
      hasFields(
        row,
        [
          'id',
          'kind',
          'credits',
          'max_uses',
          'used',
          'expires_at',
          'note',
          'revoked',
          'created_at',
        ],
        'code',
      );
      assert.ok(['credit', 'invite'].includes(row.kind));
      assert.equal(typeof row.revoked, 'boolean');
      assert.ok(numberOrNull(row.expires_at));
    }
    assert.equal(
      (
        await call(
          s,
          'DELETE',
          `/v1/platform/codes/${encodeURIComponent(codes[0].id)}`,
          undefined,
          ADMIN,
        )
      ).statusCode,
      204,
    );

    // 开发者: create, list (search + paging parameters), credit, status, password, ledger.
    const made = await call(
      s,
      'POST',
      '/v1/platform/accounts',
      { email: 'ann@x.io', password: 'password1', name: 'Ann', credits: 3 },
      ADMIN,
    );
    assert.equal(made.statusCode, 201, made.body);
    const id = made.json().account.id as string;
    const accounts = await call(
      s,
      'GET',
      '/v1/platform/accounts?limit=50&query=ann',
      undefined,
      ADMIN,
    );
    assert.equal(accounts.statusCode, 200, accounts.body);
    assert.ok('next_cursor' in accounts.json());
    const row = accounts.json().data[0];
    hasFields(
      row,
      ['id', 'email', 'name', 'status', 'balance', 'keys', 'runs', 'spent', 'last_active_at'],
      'account',
    );
    assert.ok(numberOrNull(row.last_active_at));
    assert.ok(['active', 'disabled'].includes(row.status));
    const amountDialog = await call(
      s,
      'POST',
      `/v1/platform/accounts/${encodeURIComponent(id)}/credit`,
      { amount: -1.5, note: 'offline order' },
      ADMIN,
    );
    assert.equal(amountDialog.statusCode, 200, amountDialog.body);
    assert.equal(amountDialog.json().account.balance, 1.5);
    assert.equal(
      (await call(s, 'POST', `/v1/platform/accounts/${id}/status`, { status: 'disabled' }, ADMIN))
        .statusCode,
      200,
    );
    assert.equal(
      (await call(s, 'POST', `/v1/platform/accounts/${id}/status`, { status: 'active' }, ADMIN))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await call(
          s,
          'POST',
          `/v1/platform/accounts/${id}/password`,
          { new_password: 'password2' },
          ADMIN,
        )
      ).statusCode,
      204,
    );
    const ledger = await call(
      s,
      'GET',
      `/v1/platform/accounts/${id}/ledger?limit=50`,
      undefined,
      ADMIN,
    );
    assert.equal(ledger.statusCode, 200, ledger.body);
    assert.ok('next_cursor' in ledger.json());
    for (const entry of ledger.json().data)
      hasFields(
        entry,
        ['created_at', 'kind', 'amount', 'balance_after', 'agent', 'tokens', 'status', 'note'],
        'ledger entry',
      );
    assert.deepEqual(
      ledger.json().data.map((e: { kind: string }) => e.kind),
      ['adjust', 'grant'],
      'the page maps adjust and grant to labels',
    );

    // 概况.
    const summary = (await call(s, 'GET', '/v1/platform/summary', undefined, ADMIN)).json();
    hasFields(
      summary,
      [
        'site_name',
        'registration',
        'accounts',
        'balance_total',
        'spent_total',
        'tokens_total',
        'runs_total',
        'listings',
      ],
      'summary',
    );
    hasFields(summary.accounts, ['total', 'active', 'disabled'], 'summary.accounts');
    assert.equal(summary.registration, 'invite');
  });
});

// The platform page's "启用" panel (shown while the platform is off) reads GET /v1/platform/setup
// and sends PUT with exactly these fields; the gateway answers both whether or not it is on.
test('console contract: the platform setup panel reads and sends the documented fields', async () => {
  const s = await setup();
  try {
    const health = (await call(s, 'GET', '/health')).json();
    assert.ok(health.features.includes('platform-setup-v1'));
    const fields = [
      'enabled',
      'source',
      'managed_by_config',
      'pending_restart',
      'owner',
      'settings',
      'desired',
    ];
    hasFields(
      (await call(s, 'GET', '/v1/platform/setup', undefined, ADMIN)).json(),
      fields,
      'setup',
    );
    const saved = await call(
      s,
      'PUT',
      '/v1/platform/setup',
      { enabled: true, site_name: '站点', registration: 'invite', signup_credits: 1 },
      ADMIN,
    );
    assert.equal(saved.statusCode, 200, saved.body);
    hasFields(saved.json(), fields, 'setup after PUT');
    hasFields(saved.json().settings, ['site_name', 'registration', 'signup_credits'], 'settings');
    assert.equal(saved.json().pending_restart, true);
  } finally {
    await s.cleanup();
  }
});
