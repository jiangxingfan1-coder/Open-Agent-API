import { randomBytes } from 'node:crypto';
import { bi } from '../core/locale.js';
import {
  canTrackProcesses,
  clip,
  descendants,
  errorCode,
  get,
  http,
  nonce,
  sleep,
  waitGone,
  type Ctx,
  type PidTracker,
  type Secrets,
} from './verify-harness.js';
import { ask, type Env } from './verify-env.js';
import { chat } from './verify-wire.js';

// S7-S11: cancel, caller-tool bridging, concurrency, billing, error surfaces. S12 (cleanup) and S13
// (usage, derived from the other scenarios) live in verify-run.ts because they need every scenario's data.

export async function s7(env: Env, ctx: Ctx, pids: PidTracker) {
  const before = new Set((await descendants()).keys());
  ctx.invoked();
  const r = await http(
    env.base,
    'POST',
    '/v1/invoke',
    env.key,
    {
      agent: env.agentId,
      input: '请从 1 开始逐行数到 3000，每行只写一个数字，不要省略、不要使用工具。',
      background: true,
    },
    {},
    ctx.signal,
  );
  const runId = get(r.body, 'id') as string | undefined;
  ctx.track(runId);
  ctx.check(
    bi('后台任务已受理', 'The background task was accepted'),
    r.status === 200 && !!runId,
    r.status,
  );
  if (!runId) return;
  await sleep(3000);
  await pids.sample();
  const started = [...(await descendants()).entries()]
    .filter(([pid]) => !before.has(pid))
    .map(([pid, comm]) => ({ pid, comm }));
  const scenarioPids = [...new Map([...pids.of('S7'), ...started].map((p) => [p.pid, p])).values()];
  ctx.observe('child_processes_at_cancel', scenarioPids);
  const status = (await env.gateway.run(runId)).status;
  ctx.observe('status_before_cancel', status);
  const c = await env.gateway.cancel(runId);
  ctx.check(bi('取消接口返回 200', 'The cancel call returns 200'), c.status === 200, c.status);
  const run = await env.gateway.wait(runId, 30_000);
  ctx.observe('final_status', run.status);
  // docs/adapters.md: after a cancel an external agent turn that already started is `interrupted` (effect_outcome_unknown).
  ctx.check(
    bi('状态为 cancelled 或 interrupted', 'The status is cancelled or interrupted'),
    run.status === 'cancelled' || run.status === 'interrupted',
    run.status,
  );
  ctx.observe('final_error_code', run.error?.code);
  if (!canTrackProcesses) {
    ctx.observe('process_checks', 'skipped: no ps on this platform');
    return;
  }
  ctx.check(
    bi('取消前确实看到了智能体子进程', 'An agent child process was seen before the cancel'),
    scenarioPids.length > 0,
  );
  const left = await waitGone(
    scenarioPids.map((p) => p.pid),
    15_000,
  );
  ctx.observe('still_alive_after_cancel', left);
  ctx.check(
    bi('该运行的智能体子进程都已退出', "The run's agent child processes have all exited"),
    left.length === 0,
    left,
  );
}

const ORDER_TOOL = {
  type: 'function',
  function: {
    name: 'get_order_status',
    description: '查询订单状态。',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string', description: '订单号' } },
      required: ['order_id'],
    },
  },
};
export async function s8(env: Env, ctx: Ctx) {
  const orderId = nonce('ORD');
  const status = nonce('SHIPPED');
  const headers = { 'x-oaa-client-tools': 'bridge' };
  const user = {
    role: 'user',
    content: `你必须调用工具 get_order_status 查询订单号 ${orderId} 的状态，不要自己猜，然后把工具返回的状态原样告诉我。`,
  };
  const first = await http(
    env.base,
    'POST',
    '/v1/compat/chat/completions',
    env.key,
    { model: env.agentId, messages: [user], tools: [ORDER_TOOL] },
    headers,
    ctx.signal,
  );
  const code = errorCode(first.body);
  ctx.observe('first_http_status', first.status);
  ctx.observe('first_error_code', code);
  if (first.status === 400 && code === 'client_tools_bridge_unsupported') {
    ctx.unsupported(
      code,
      bi(
        '引擎不支持调用方工具桥接（按文档如实记录）；没有创建运行',
        'The engine does not support caller-tool bridging (recorded as documented); no run was created',
      ),
    );
    if (env.expect?.bridge)
      ctx.mismatch(
        bi(
          'S8 桥接：文档写支持，实际得到 client_tools_bridge_unsupported',
          'S8 bridging: the docs say supported, observed client_tools_bridge_unsupported',
        ),
      );
    return;
  }
  ctx.invoked();
  if (env.expect && !env.expect.bridge)
    ctx.mismatch(
      bi(
        `S8 桥接：文档写不支持，实际得到 HTTP ${first.status}`,
        `S8 bridging: the docs say unsupported, observed HTTP ${first.status}`,
      ),
    );
  const runId = first.headers.get('x-run-id');
  ctx.track(runId);
  const choice = get(first.body, 'choices', 0) as
    | {
        finish_reason?: string;
        message?: { tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
      }
    | undefined;
  ctx.check(
    bi('第一次响应 finish_reason 为 tool_calls', 'The first response has finish_reason tool_calls'),
    choice?.finish_reason === 'tool_calls',
    { status: first.status, finish: choice?.finish_reason, body: clip(first.text) },
  );
  const call = choice?.message?.tool_calls?.[0];
  if (!call) return;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {}
  ctx.observe('tool_call', { name: call.function.name, arguments: args });
  ctx.check(
    bi('调用的是 get_order_status', 'The call is get_order_status'),
    call.function.name === 'get_order_status',
  );
  ctx.check(
    bi('参数里的订单号正确', 'The order ID in the arguments is right'),
    args.order_id === orderId,
    args.order_id,
  );
  const second = await http(
    env.base,
    'POST',
    '/v1/compat/chat/completions',
    env.key,
    {
      model: env.agentId,
      tools: [ORDER_TOOL],
      messages: [
        user,
        { role: 'assistant', content: null, tool_calls: choice!.message!.tool_calls },
        { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status }) },
      ],
    },
    headers,
    ctx.signal,
  );
  const text = String(get(second.body, 'choices', 0, 'message', 'content') ?? '');
  ctx.observe('second_http_status', second.status);
  ctx.observe('final_output', text);
  ctx.check(
    bi('回传后 HTTP 200', 'HTTP 200 after returning the result'),
    second.status === 200,
    second.status,
  );
  ctx.check(
    bi('最终回答含工具结果', 'The final answer contains the tool result'),
    text.includes(status),
    status,
  );
  ctx.check(
    bi('整个往返是同一个运行', 'The whole round trip is one run'),
    !!runId && second.headers.get('x-run-id') === runId,
    { first: runId, second: second.headers.get('x-run-id') },
  );
  if (runId) {
    const run = await env.gateway.wait(runId, 60_000);
    ctx.check(bi('运行 completed', 'The run is completed'), run.status === 'completed', run.status);
  }
}

export async function s9(env: Env, ctx: Ctx) {
  const tokens = [nonce('OAA-A'), nonce('OAA-B'), nonce('OAA-C')];
  ctx.invoked(tokens.length);
  const results = await Promise.allSettled(
    tokens.map((token) => chat(env, ask(token), ctx.signal)),
  );
  const runIds = new Set<string>();
  results.forEach((r, i) => {
    const token = tokens[i]!;
    if (r.status === 'rejected') {
      ctx.check(
        bi(`任务 ${i + 1} 成功`, `Task ${i + 1} succeeds`),
        false,
        clip(String((r.reason as Error)?.message), 300),
      );
      return;
    }
    ctx.track(r.value.runId);
    if (r.value.runId) runIds.add(r.value.runId);
    ctx.observe(`output_${i + 1}`, r.value.text);
    ctx.check(
      bi(`任务 ${i + 1} 含自己的字符串`, `Task ${i + 1} contains its own string`),
      r.value.text.includes(token),
      r.value.status === 200
        ? token
        : { status: r.value.status, body: clip(JSON.stringify(r.value.body)) },
    );
    ctx.check(
      bi(`任务 ${i + 1} 不含别人的字符串`, `Task ${i + 1} contains no other task's string`),
      tokens.every((t) => t === token || !r.value.text.includes(t)),
    );
  });
  ctx.check(
    bi('三个任务是三个不同的运行', 'The three tasks are three different runs'),
    runIds.size === tokens.length,
    runIds.size,
  );
  for (const runId of runIds) {
    const run = await env.gateway.wait(runId, 60_000);
    ctx.check(
      bi(`运行 ${runId} completed`, `Run ${runId} is completed`),
      run.status === 'completed',
      run.status,
    );
  }
}

export async function s10(env: Env, ctx: Ctx, secrets: Secrets) {
  const admin = env.gateway.admin;
  const password = randomBytes(18).toString('base64url');
  secrets.add(password);
  const email = `live-${randomBytes(4).toString('hex')}@example.invalid`;
  const made = await http(env.base, 'POST', '/v1/platform/accounts', admin, {
    email,
    password,
    credits: 10,
  });
  const accountId = get(made.body, 'account', 'id') as string | undefined;
  ctx.check(
    bi('建开发者账号并发 10 点', 'Create a developer account with 10 credits'),
    made.status === 201 && !!accountId,
    made.status,
  );
  if (!accountId) return;
  const login = await http(env.base, 'POST', '/v1/portal/login', undefined, { email, password });
  const session = get(login.body, 'session', 'token') as string | undefined;
  secrets.add(session);
  const keyResp = await http(env.base, 'POST', '/v1/portal/keys', session, {
    name: 'live-billing',
  });
  const accountKey = get(keyResp.body, 'token') as string | undefined;
  secrets.add(accountKey);
  ctx.check(
    bi('建账号密钥', 'Create an account key'),
    keyResp.status === 201 && !!accountKey,
    keyResp.status,
  );
  const listing = await http(env.base, 'PUT', '/v1/platform/listings', admin, {
    agent_id: env.agentId,
    price: { per_run: 2 },
  });
  ctx.check(
    bi('上架并定价每任务 2 点', 'List the agent at 2 credits per run'),
    listing.status === 200,
    listing.status,
  );
  const balance = async () =>
    Number(
      get((await http(env.base, 'GET', '/v1/portal/account', session)).body, 'account', 'balance'),
    );
  const runRows = async () => {
    const l = await http(env.base, 'GET', `/v1/platform/accounts/${accountId}/ledger`, admin);
    const rows = (get(l.body, 'data') as { kind: string }[]) ?? [];
    return rows.filter((row) => row.kind === 'run').length;
  };
  const b0 = await balance();
  ctx.observe('balance_before', b0);
  const token = nonce('OAA');
  const paid = await http(
    env.base,
    'POST',
    '/v1/chat/completions',
    accountKey,
    { model: env.agentId, messages: [{ role: 'user', content: ask(token) }] },
    {},
    ctx.signal,
  );
  const paidCode = errorCode(paid.body);
  ctx.observe('paid_http_status', paid.status);
  ctx.observe('paid_error_code', paidCode);
  ctx.track(paid.headers.get('x-run-id'));
  const b1 = await balance();
  const rows1 = await runRows();
  ctx.observe('balance_after_paid', b1);
  ctx.observe('ledger_run_rows_after_paid', rows1);
  if (paid.status === 403 && paidCode === 'isolation_required') {
    // docs/platform.md: an account key is workspace/sandbox level and cannot call native agents or adapters.
    ctx.unsupported(
      paidCode,
      bi(
        '账号密钥（workspace 级）不能调用外部智能体（需要 host 执行等级），未创建运行；按文档如实记录',
        'An account key (workspace level) cannot call an external agent (it needs host execution); no run was created; recorded as documented',
      ),
    );
    ctx.check(bi('被拒绝时不扣点', 'No credits are charged when refused'), b1 === b0, {
      before: b0,
      after: b1,
    });
    ctx.check(
      bi('被拒绝时流水没有运行行', 'The ledger has no run row when refused'),
      rows1 === 0,
      rows1,
    );
  } else {
    ctx.invoked();
    const text = String(get(paid.body, 'choices', 0, 'message', 'content') ?? '');
    ctx.check(
      bi('付费任务成功', 'The paid task succeeds'),
      paid.status === 200 && text.includes(token),
      {
        status: paid.status,
        text: clip(text),
      },
    );
    ctx.check(
      bi('余额恰好减少一次价格', 'The balance drops by exactly one price'),
      Math.abs(b0 - 2 - b1) < 1e-6,
      { before: b0, after: b1 },
    );
    ctx.check(
      bi('流水里有且只有一行运行扣费', 'The ledger has exactly one run charge'),
      rows1 === 1,
      rows1,
    );
  }
  const missing = await http(env.base, 'POST', '/v1/chat/completions', accountKey, {
    model: 'agent/does-not-exist-live',
    messages: [{ role: 'user', content: '你好' }],
  });
  ctx.observe('missing_model_status', missing.status);
  ctx.observe('missing_model_code', errorCode(missing.body));
  ctx.check(
    bi('不存在的模型名被拒绝', 'An unknown model name is refused'),
    missing.status >= 400 && missing.status < 500,
    missing.status,
  );
  const b2 = await balance();
  ctx.check(bi('失败请求不扣点', 'A failed request is not charged'), b2 === b1, {
    before: b1,
    after: b2,
  });
  ctx.check(
    bi('失败请求不新增流水', 'A failed request adds no ledger row'),
    (await runRows()) === rows1,
  );
}

type Shape = 'openai' | 'claude' | 'gemini';
const shapeOk = (shape: Shape, body: unknown) =>
  shape === 'openai'
    ? typeof get(body, 'error', 'message') === 'string' &&
      'code' in ((get(body, 'error') as object) ?? {})
    : shape === 'claude'
      ? get(body, 'type') === 'error' && typeof get(body, 'error', 'type') === 'string'
      : typeof get(body, 'error', 'code') === 'number' &&
        typeof get(body, 'error', 'status') === 'string';

/** Error paths: wrong key, key without access, malformed bodies — on all three wire formats. None reaches the agent. */
export async function s11(env: Env, ctx: Ctx, secrets: Secrets) {
  const wrong = `sk-oaa-${randomBytes(24).toString('base64url')}`;
  secrets.add(wrong);
  const gemini = `/v1/models/${env.agentId}:generateContent`;
  const chatBody = { model: env.agentId, messages: [{ role: 'user', content: '你好' }] };
  const msgBody = {
    model: env.agentId,
    max_tokens: 16,
    messages: [{ role: 'user', content: '你好' }],
  };
  const gemBody = { contents: [{ role: 'user', parts: [{ text: '你好' }] }] };
  const probe = async (
    name: { zh: string; en: string },
    url: string,
    shape: Shape,
    body: unknown,
    auth: Record<string, string>,
    expected: number[],
  ) => {
    const r = await http(env.base, 'POST', url, undefined, body, auth);
    ctx.observe(name.en, {
      status: r.status,
      code: errorCode(r.body) ?? get(r.body, 'error', 'type'),
    });
    ctx.check(
      bi(`${name.zh}：HTTP ${expected.join('/')}`, `${name.en}: HTTP ${expected.join('/')}`),
      expected.includes(r.status),
      r.status,
    );
    ctx.check(
      bi(`${name.zh}：${shape} 错误形状`, `${name.en}: ${shape} error shape`),
      shapeOk(shape, r.body),
      clip(r.text, 300),
    );
    if (r.headers.get('x-run-id'))
      ctx.check(
        bi(`${name.zh}：不应创建运行`, `${name.en}: no run should be created`),
        false,
        r.headers.get('x-run-id'),
      );
  };
  const label = (kind: { zh: string; en: string }, via: string) => ({
    zh: `${kind.zh}·${via}`,
    en: `${kind.en} / ${via}`,
  });
  const wrongKey = bi('错误密钥', 'Wrong key');
  await probe(
    label(wrongKey, 'Chat'),
    '/v1/chat/completions',
    'openai',
    chatBody,
    { authorization: `Bearer ${wrong}` },
    [401],
  );
  await probe(
    label(wrongKey, 'Messages'),
    '/v1/messages',
    'claude',
    msgBody,
    { 'x-api-key': wrong },
    [401],
  );
  await probe(
    label(wrongKey, 'Gemini'),
    gemini,
    'gemini',
    gemBody,
    { 'x-goog-api-key': wrong },
    [401],
  );

  const k = await http(env.base, 'POST', '/v1/keys', env.gateway.admin, {
    name: 'live-no-access',
    agents: ['agent/none-such'],
    scopes: ['invoke', 'read'],
    execution: 'host',
  });
  const narrow = get(k.body, 'token') as string | undefined;
  secrets.add(narrow);
  ctx.check(
    bi('建一个无权访问该智能体的密钥', 'Create a key without access to this agent'),
    !!narrow,
    k.status,
  );
  if (narrow) {
    const noAccess = bi('无权限', 'No access');
    await probe(
      label(noAccess, 'Chat'),
      '/v1/chat/completions',
      'openai',
      chatBody,
      { authorization: `Bearer ${narrow}` },
      [403, 404],
    );
    await probe(
      label(noAccess, 'Messages'),
      '/v1/messages',
      'claude',
      msgBody,
      { 'x-api-key': narrow },
      [403, 404],
    );
    await probe(
      label(noAccess, 'Gemini'),
      gemini,
      'gemini',
      gemBody,
      { 'x-goog-api-key': narrow },
      [403, 404],
    );
  }
  const bearer = { authorization: `Bearer ${env.key}` };
  const malformed = bi('非法请求体', 'Malformed body');
  await probe(
    label(malformed, 'Chat'),
    '/v1/chat/completions',
    'openai',
    { model: env.agentId, messages: 'x' },
    bearer,
    [400],
  );
  await probe(
    label(malformed, 'Messages'),
    '/v1/messages',
    'claude',
    { model: env.agentId, max_tokens: 16 },
    { 'x-api-key': env.key },
    [400],
  );
  await probe(
    label(malformed, 'Gemini'),
    gemini,
    'gemini',
    { contents: 5 },
    { 'x-goog-api-key': env.key },
    [400],
  );
}
