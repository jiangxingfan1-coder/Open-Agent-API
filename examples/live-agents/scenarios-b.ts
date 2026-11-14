import { randomBytes } from 'node:crypto';
import OpenAI from 'openai';
import {
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
} from './harness.js';
import type { Env } from './scenarios-a.js';

// S7–S11：取消、调用方工具桥接、并发、计费、错误面。S12 在主文件里（需要全部场景的 PID 记录）。

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
  ctx.check('后台任务已受理', r.status === 200 && !!runId, r.status);
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
  ctx.check('取消接口返回 200', c.status === 200, c.status);
  const run = await env.gateway.wait(runId, 30_000);
  ctx.observe('final_status', run.status);
  // docs/adapters.md：取消后已经开始的外部智能体回合记为 interrupted（effect_outcome_unknown）。
  ctx.check(
    '状态为 cancelled 或 interrupted',
    run.status === 'cancelled' || run.status === 'interrupted',
    run.status,
  );
  ctx.observe('final_error_code', run.error?.code);
  ctx.check('取消前确实看到了智能体子进程', scenarioPids.length > 0);
  const left = await waitGone(
    scenarioPids.map((p) => p.pid),
    15_000,
  );
  ctx.observe('still_alive_after_cancel', left);
  ctx.check('该运行的智能体子进程都已退出', left.length === 0, left);
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
    ctx.unsupported(code, '引擎不支持调用方工具桥接（按文档如实记录）；没有创建运行');
    if (env.expect.bridge)
      ctx.mismatch('S8 桥接：文档写支持，实际得到 client_tools_bridge_unsupported');
    return;
  }
  ctx.invoked();
  if (!env.expect.bridge) ctx.mismatch(`S8 桥接：文档写不支持，实际得到 HTTP ${first.status}`);
  const runId = first.headers.get('x-run-id');
  ctx.track(runId);
  const choice = get(first.body, 'choices', 0) as
    | {
        finish_reason?: string;
        message?: { tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
      }
    | undefined;
  ctx.check('第一次响应 finish_reason 为 tool_calls', choice?.finish_reason === 'tool_calls', {
    status: first.status,
    finish: choice?.finish_reason,
    body: clip(first.text),
  });
  const call = choice?.message?.tool_calls?.[0];
  if (!call) return;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {}
  ctx.observe('tool_call', { name: call.function.name, arguments: args });
  ctx.check('调用的是 get_order_status', call.function.name === 'get_order_status');
  ctx.check('参数里的订单号正确', args.order_id === orderId, args.order_id);
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
  ctx.check('回传后 HTTP 200', second.status === 200, second.status);
  ctx.check('最终回答含工具结果', text.includes(status), status);
  ctx.check('整个往返是同一个运行', !!runId && second.headers.get('x-run-id') === runId, {
    first: runId,
    second: second.headers.get('x-run-id'),
  });
  if (runId) {
    const run = await env.gateway.wait(runId, 60_000);
    ctx.check('运行 completed', run.status === 'completed', run.status);
  }
}

export async function s9(env: Env, ctx: Ctx) {
  const client = new OpenAI({
    baseURL: `${env.base}/v1`,
    apiKey: env.key,
    maxRetries: 0,
    timeout: 600_000,
  });
  const tokens = [nonce('OAA-A'), nonce('OAA-B'), nonce('OAA-C')];
  ctx.invoked(tokens.length);
  const results = await Promise.allSettled(
    tokens.map((token) =>
      client.chat.completions
        .create(
          {
            model: env.agentId,
            messages: [
              { role: 'user', content: `只回复这一串字符：${token}，不要加任何其他内容。` },
            ],
          },
          { signal: ctx.signal },
        )
        .withResponse(),
    ),
  );
  const runIds = new Set<string>();
  results.forEach((r, i) => {
    const token = tokens[i]!;
    if (r.status === 'rejected') {
      ctx.check(`任务 ${i + 1} 成功`, false, clip(String((r.reason as Error)?.message), 300));
      return;
    }
    const runId = r.value.response.headers.get('x-run-id');
    ctx.track(runId);
    if (runId) runIds.add(runId);
    const text = r.value.data.choices[0]?.message.content ?? '';
    ctx.observe(`output_${i + 1}`, text);
    ctx.check(`任务 ${i + 1} 含自己的字符串`, text.includes(token), token);
    ctx.check(
      `任务 ${i + 1} 不含别人的字符串`,
      tokens.every((t) => t === token || !text.includes(t)),
    );
  });
  ctx.check('三个任务是三个不同的运行', runIds.size === tokens.length, runIds.size);
  for (const runId of runIds) {
    const run = await env.gateway.wait(runId, 60_000);
    ctx.check(`运行 ${runId} completed`, run.status === 'completed', run.status);
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
  ctx.check('建开发者账号并发 10 点', made.status === 201 && !!accountId, made.status);
  if (!accountId) return;
  const login = await http(env.base, 'POST', '/v1/portal/login', undefined, { email, password });
  const session = get(login.body, 'session', 'token') as string | undefined;
  secrets.add(session);
  const keyResp = await http(env.base, 'POST', '/v1/portal/keys', session, {
    name: 'live-billing',
  });
  const accountKey = get(keyResp.body, 'token') as string | undefined;
  secrets.add(accountKey);
  ctx.check('建账号密钥', keyResp.status === 201 && !!accountKey, keyResp.status);
  const listing = await http(env.base, 'PUT', '/v1/platform/listings', admin, {
    agent_id: env.agentId,
    price: { per_run: 2 },
  });
  ctx.check('上架并定价每任务 2 点', listing.status === 200, listing.status);
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
    {
      model: env.agentId,
      messages: [{ role: 'user', content: `只回复这一串字符：${token}，不要加任何其他内容。` }],
    },
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
    // docs/platform.md：账号密钥只能是 workspace/sandbox 级，调不了原生智能体与适配器。
    ctx.unsupported(
      paidCode,
      '账号密钥（workspace 级）不能调用外部智能体（需要 host 执行等级），未创建运行；按文档如实记录',
    );
    ctx.check('被拒绝时不扣点', b1 === b0, { before: b0, after: b1 });
    ctx.check('被拒绝时流水没有运行行', rows1 === 0, rows1);
  } else {
    ctx.invoked();
    const text = String(get(paid.body, 'choices', 0, 'message', 'content') ?? '');
    ctx.check('付费任务成功', paid.status === 200 && text.includes(token), {
      status: paid.status,
      text: clip(text),
    });
    ctx.check('余额恰好减少一次价格', Math.abs(b0 - 2 - b1) < 1e-6, { before: b0, after: b1 });
    ctx.check('流水里有且只有一行运行扣费', rows1 === 1, rows1);
  }
  const missing = await http(env.base, 'POST', '/v1/chat/completions', accountKey, {
    model: 'agent/does-not-exist-live',
    messages: [{ role: 'user', content: '你好' }],
  });
  ctx.observe('missing_model_status', missing.status);
  ctx.observe('missing_model_code', errorCode(missing.body));
  ctx.check('不存在的模型名被拒绝', missing.status >= 400 && missing.status < 500, missing.status);
  const b2 = await balance();
  ctx.check('失败请求不扣点', b2 === b1, { before: b1, after: b2 });
  ctx.check('失败请求不新增流水', (await runRows()) === rows1);
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
    name: string,
    url: string,
    shape: Shape,
    body: unknown,
    auth: Record<string, string>,
    expected: number[],
  ) => {
    const r = await http(env.base, 'POST', url, undefined, body, auth);
    ctx.observe(name, {
      status: r.status,
      code: errorCode(r.body) ?? get(r.body, 'error', 'type'),
    });
    ctx.check(`${name}：HTTP ${expected.join('/')}`, expected.includes(r.status), r.status);
    ctx.check(`${name}：${shape} 错误形状`, shapeOk(shape, r.body), clip(r.text, 300));
    if (r.headers.get('x-run-id'))
      ctx.check(`${name}：不应创建运行`, false, r.headers.get('x-run-id'));
  };
  await probe(
    '错误密钥·Chat',
    '/v1/chat/completions',
    'openai',
    chatBody,
    { authorization: `Bearer ${wrong}` },
    [401],
  );
  await probe(
    '错误密钥·Messages',
    '/v1/messages',
    'claude',
    msgBody,
    { 'x-api-key': wrong },
    [401],
  );
  await probe('错误密钥·Gemini', gemini, 'gemini', gemBody, { 'x-goog-api-key': wrong }, [401]);

  const k = await http(env.base, 'POST', '/v1/keys', env.gateway.admin, {
    name: 'live-no-access',
    agents: ['agent/none-such'],
    scopes: ['invoke', 'read'],
    execution: 'host',
  });
  const narrow = get(k.body, 'token') as string | undefined;
  secrets.add(narrow);
  ctx.check('建一个无权访问该智能体的密钥', !!narrow, k.status);
  if (narrow) {
    await probe(
      '无权限·Chat',
      '/v1/chat/completions',
      'openai',
      chatBody,
      { authorization: `Bearer ${narrow}` },
      [403, 404],
    );
    await probe(
      '无权限·Messages',
      '/v1/messages',
      'claude',
      msgBody,
      { 'x-api-key': narrow },
      [403, 404],
    );
    await probe(
      '无权限·Gemini',
      gemini,
      'gemini',
      gemBody,
      { 'x-goog-api-key': narrow },
      [403, 404],
    );
  }
  const bearer = { authorization: `Bearer ${env.key}` };
  await probe(
    '非法请求体·Chat',
    '/v1/chat/completions',
    'openai',
    { model: env.agentId, messages: 'x' },
    bearer,
    [400],
  );
  await probe(
    '非法请求体·Messages',
    '/v1/messages',
    'claude',
    { model: env.agentId, max_tokens: 16 },
    { 'x-api-key': env.key },
    [400],
  );
  await probe(
    '非法请求体·Gemini',
    gemini,
    'gemini',
    { contents: 5 },
    { 'x-goog-api-key': env.key },
    [400],
  );
}
