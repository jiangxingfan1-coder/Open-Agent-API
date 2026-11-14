// 开发者平台走查：把离线示例智能体（真实的 ACP 外部智能体进程，不调用模型、不联网）作为外部智能体
// 上架，走一遍「上架 → 放开 → 兑换码 → 注册 → 兑换 → 建密钥 → 调用 → 扣费 → 余额不足 → 充值」。
// 只用临时数据目录与 127.0.0.1 随机端口，结束后删除临时目录。
// Developer platform walkthrough with the offline sample agent as an external ACP agent; a temporary
// data directory and a random 127.0.0.1 port only. Run: npm run build && node dist/examples/platform-walkthrough.js
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { agentSchema } from '../src/core/contracts.js';
import { createGateway } from '../src/gateway/server.js';
import { makeBundle } from '../src/lang/bundle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/examples/ when built, examples/ in the source tree: the agent script sits in examples/.
const sample = path.resolve(
  here,
  here.includes(`${path.sep}dist${path.sep}`) ? '../..' : '..',
  'examples/sample-agent.mjs',
);
const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-platform-walkthrough-'));
const owner = `oaa_walkthrough_${Math.random().toString(36).slice(2)}${'x'.repeat(24)}`;
process.env.OAA_WALKTHROUGH_TOKEN = owner;

const worker = workerSchema.parse({
  nodeId: 'local',
  dataDir: path.join(dir, 'worker'),
  adapters: {
    'oaa-sample': { transport: 'acp', command: process.execPath, args: [sample], enabled: true },
  },
});
const gw = await createGateway(
  gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    host: '127.0.0.1',
    port: 0,
    keys: [{ name: 'owner', owner: 'owner', tokenEnv: 'OAA_WALKTHROUGH_TOKEN', scopes: ['admin'] }],
    localWorker: worker,
    platform: { owner: 'owner', registration: 'open', siteName: 'Walkthrough' },
  }),
);

type Json = Record<string, unknown>;
/** A value inside a JSON body by path (undefined when absent); for display only. */
const at = (value: unknown, ...keys: (string | number)[]): unknown =>
  keys.reduce<unknown>(
    (v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
    value,
  );
const rows = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const step = (n: number, zh: string, en: string) => console.log(`\n[${n}] ${zh} / ${en}`);
const show = (label: string, value: unknown) =>
  console.log(`    ${label}: ${JSON.stringify(value)}`);

try {
  const base = await gw.listen();
  const call = async (method: string, url: string, body?: unknown, bearer = owner) => {
    const r = await fetch(base + url, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as unknown };
  };
  console.log(`gateway: ${base}  data: ${dir}`);

  step(1, '发布示例智能体（外部 ACP 智能体）', 'publish the sample agent (external ACP agent)');
  gw.store.publish(
    'owner',
    makeBundle(
      agentSchema.parse({
        id: 'agent/sample',
        description: 'Offline sample agent',
        engine: 'adapter/oaa-sample',
        provider: 'native',
        model: 'default',
        instructions: '',
        routes: [{ id: 'default', provider: 'native', model: 'default', priority: 0 }],
      }),
    ),
  );

  step(2, '上架，按次 2 点，先不放开', 'list it at 2 credits per task, switch off');
  let listing = await call('PUT', '/v1/platform/listings', {
    agent_id: 'agent/sample',
    title: 'Sample agent',
    price: { per_run: 2 },
  });
  const pick = (l: unknown) => ({
    callable: at(l, 'callable'),
    requires_host: at(l, 'requires_host'),
    host_execution: at(l, 'host_execution'),
    blocked_by: at(l, 'blocked_by'),
    usage_reported: at(l, 'usage_reported'),
  });
  show('listing', pick(listing.body));
  show(
    'portal catalog',
    rows(at((await call('GET', '/v1/portal/agents', undefined, '')).body, 'data')).length,
  );
  const perToken = await call('PUT', '/v1/platform/listings', {
    agent_id: 'agent/sample',
    price: { per_1k_tokens: 1 },
  });
  show('per-token price', [perToken.status, at(perToken.body, 'error', 'code')]);

  step(
    3,
    '生成兑换码，开发者注册、兑换、建密钥',
    'credit code, developer signs up, redeems, creates a key',
  );
  const code = String(
    at(
      (await call('POST', '/v1/platform/codes', { kind: 'credit', credits: 5 })).body,
      'data',
      0,
      'code',
    ),
  );
  const signup = await call(
    'POST',
    '/v1/portal/signup',
    { email: 'dev@example.com', password: 'password1' },
    '',
  );
  const session = String(at(signup.body, 'session', 'token'));
  show('redeem', at((await call('POST', '/v1/portal/redeem', { code }, session)).body, 'credited'));
  const key = String(
    at((await call('POST', '/v1/portal/keys', { name: 'walkthrough' }, session)).body, 'token'),
  );
  const balance = async () =>
    at((await call('GET', '/v1/portal/account', undefined, session)).body, 'account', 'balance');
  show('balance', await balance());

  const chat = async () =>
    call(
      'POST',
      '/v1/chat/completions',
      { model: 'agent/sample', messages: [{ role: 'user', content: 'hello' }] },
      key,
    );
  step(4, '开关未打开时调用', 'call while the switch is off');
  let r = await chat();
  show('chat', [r.status, at(r.body, 'error', 'code')]);
  show('balance', await balance());

  step(5, '所有者打开开关', 'owner turns the switch on');
  listing = await call('PUT', '/v1/platform/listings', {
    agent_id: 'agent/sample',
    host_execution: true,
  });
  show('listing', pick(listing.body));
  show(
    'portal catalog',
    rows(at((await call('GET', '/v1/portal/agents', undefined, '')).body, 'data')).map((a) => a.id),
  );

  step(6, '用 OpenAI 协议调用两次', 'call twice with the OpenAI protocol');
  for (let i = 0; i < 2; i++) {
    r = await chat();
    show('chat', [
      r.status,
      String(at(r.body, 'choices', 0, 'message', 'content') ?? '').slice(0, 70),
    ]);
    show('balance', await balance());
  }
  const ledger = rows(
    at((await call('GET', '/v1/portal/ledger', undefined, session)).body, 'data'),
  );
  show(
    'ledger',
    ledger.map((e) => [e.kind, e.amount, e.status ?? '', e.balance_after]),
  );
  const usage = (await call('GET', '/v1/platform/usage')).body;
  show('owner usage', { totals: at(usage, 'totals'), by_account: at(usage, 'by_account') });

  step(7, '余额 1 点，不够一次：各协议入口的错误', 'balance 1, not enough: errors per protocol');
  r = await chat();
  show('openai chat', [r.status, at(r.body, 'error', 'code')]);
  r = await call(
    'POST',
    '/v1/messages',
    { model: 'agent/sample', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    key,
  );
  show('claude messages', [r.status, at(r.body, 'error', 'type'), at(r.body, 'error', 'code')]);
  r = await call(
    'POST',
    '/v1beta/models/agent%2Fsample:generateContent',
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    key,
  );
  show('gemini', [
    r.status,
    at(r.body, 'error', 'status'),
    at(r.body, 'error', 'details', 0, 'reason'),
  ]);

  step(8, '再兑换 4 点后恢复', 'redeem 4 more credits and call again');
  const more = String(
    at(
      (await call('POST', '/v1/platform/codes', { kind: 'credit', credits: 4 })).body,
      'data',
      0,
      'code',
    ),
  );
  await call('POST', '/v1/portal/redeem', { code: more }, session);
  show('balance', await balance());
  r = await chat();
  show('chat', [r.status]);
  show('balance', await balance());

  step(9, '审计记录', 'audit rows');
  const audit = rows(at((await call('GET', '/v1/audit?limit=50')).body, 'data')).filter(
    (e) => e.code === 'platform_listing_host_execution',
  );
  show(
    'audit',
    audit.map((e) => [e.code, e.agent_id, e.detail]),
  );
} finally {
  await gw.app.close();
  await rm(dir, { recursive: true, force: true });
}
