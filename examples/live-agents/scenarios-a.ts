import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  clip,
  errorCode,
  get,
  http,
  nonce,
  type AgentKind,
  type Ctx,
  type Gateway,
} from './harness.js';

// S1–S6：OpenAI Chat（非流式/流式）、Responses 与续接、Claude Messages、Gemini、审批。
// 每个场景只调用一次（S3、S4、S6 各两次）智能体，SDK 一律 maxRetries: 0，不自动重试。

export type Env = {
  kind: AgentKind;
  agentId: string;
  base: string;
  key: string;
  gateway: Gateway;
  /** 运行所在的会话工作目录（在 --out/workspace 之下）。 */
  workspaceOf: (runId: string) => string | undefined;
  sessionOf: (runId: string) => string | undefined;
  expect: Expectations;
};
/** docs/adapters.md 能力矩阵里该接入方式的写法；与观测不符的记入「与文档不一致之处」。 */
export type Expectations = {
  streaming: 'token' | 'message';
  usage: boolean;
  bridge: boolean;
  resume: boolean;
  approvals: boolean;
};
export const EXPECT: Record<AgentKind, Expectations> = {
  claude: { streaming: 'message', usage: true, bridge: false, resume: true, approvals: true },
  codex: { streaming: 'token', usage: false, bridge: false, resume: true, approvals: true },
  // Antigravity：审批不桥接（智能体自身拒绝即 permission_denied）；用量只有首轮。
  antigravity: { streaming: 'token', usage: true, bridge: false, resume: true, approvals: false },
  fixture: { streaming: 'token', usage: true, bridge: true, resume: true, approvals: true },
};

const openai = (env: Env) =>
  new OpenAI({ baseURL: `${env.base}/v1`, apiKey: env.key, maxRetries: 0, timeout: 600_000 });
const anthropic = (env: Env) =>
  new Anthropic({ baseURL: env.base, apiKey: env.key, maxRetries: 0, timeout: 600_000 });
const ask = (token: string) => `只回复这一串字符：${token}，不要加任何其他内容。`;
const sdkError = (ctx: Ctx, error: unknown) => {
  const e = error as { status?: number; code?: unknown; error?: unknown; message?: string };
  const code = typeof e.code === 'string' ? e.code : errorCode({ error: e.error });
  ctx.observe('sdk_error', { status: e.status, code, message: clip(e.message, 300) });
  return { status: e.status, code };
};
const usageOf = (u: unknown) =>
  u && typeof u === 'object'
    ? Object.fromEntries(
        Object.entries(u as Record<string, unknown>).filter(([, v]) => typeof v === 'number'),
      )
    : null;

export async function s1(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  ctx.invoked();
  const { data, response } = await openai(env)
    .chat.completions.create(
      { model: env.agentId, messages: [{ role: 'user', content: ask(token) }] },
      { signal: ctx.signal },
    )
    .withResponse();
  const runId = response.headers.get('x-run-id');
  ctx.track(runId);
  const text = data.choices[0]?.message.content ?? '';
  ctx.observe('http_status', response.status);
  ctx.observe('output', text);
  ctx.observe('finish_reason', data.choices[0]?.finish_reason);
  ctx.observe('usage', usageOf(data.usage));
  ctx.check('HTTP 200', response.status === 200);
  ctx.check('回答含约定字符串', text.includes(token), token);
  const hasUsage = !!data.usage && (data.usage.total_tokens ?? 0) > 0;
  ctx.observe('usage_present', hasUsage);
  if (hasUsage !== env.expect.usage)
    ctx.mismatch(
      `S1 用量：文档写${env.expect.usage ? '会上报' : '不上报'}，实际${hasUsage ? '有非零 usage' : '没有（或为 0）'}`,
    );
  ctx.check('响应带 X-Run-ID', !!runId);
  if (runId) {
    const run = await env.gateway.run(runId);
    ctx.check('任务记录状态为 completed', run.status === 'completed', run.status);
  }
}

export async function s2(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  ctx.invoked();
  const start = performance.now();
  const { data: stream, response } = await openai(env)
    .chat.completions.create(
      {
        model: env.agentId,
        messages: [{ role: 'user', content: ask(token) }],
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: ctx.signal },
    )
    .withResponse();
  const runId = response.headers.get('x-run-id');
  ctx.track(runId);
  const times: number[] = [];
  let text = '';
  let finish: string | null | undefined;
  let usage: unknown;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      times.push(performance.now() - start);
      text += delta;
    }
    if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  const total = performance.now() - start;
  const span = times.length ? times.at(-1)! - times[0]! : 0;
  const incremental = times.length > 1 && span > 20;
  ctx.observe('first_delta_ms', times[0] !== undefined ? Math.round(times[0]) : null);
  ctx.observe('total_ms', Math.round(total));
  ctx.observe('delta_count', times.length);
  ctx.observe('delta_span_ms', Math.round(span));
  ctx.observe('incremental', incremental);
  ctx.observe('finish_reason', finish);
  ctx.observe('usage', usageOf(usage));
  ctx.observe('output', text);
  ctx.check('流正常结束且 finish_reason 为 stop', finish === 'stop', finish);
  ctx.check('拼接文本含约定字符串', text.includes(token), token);
  if (incremental !== (env.expect.streaming === 'token'))
    ctx.mismatch(
      `S2 流式：文档写${env.expect.streaming === 'token' ? '逐 token 流式' : '按消息流式'}，实际 ${times.length} 个增量、跨度 ${Math.round(span)} 毫秒（${incremental ? '逐步到达' : '基本一次性到达'}）`,
    );
  if (runId) {
    const run = await env.gateway.run(runId);
    ctx.check('任务记录状态为 completed', run.status === 'completed', run.status);
  }
}

export async function s3(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  const client = openai(env);
  ctx.invoked();
  const first = await client.responses.create(
    { model: env.agentId, input: `请记住这个暗号。${ask(token)}` },
    { signal: ctx.signal },
  );
  ctx.track(first.id);
  ctx.observe('first_status', first.status);
  ctx.observe('first_output', first.output_text);
  ctx.observe('first_usage', usageOf(first.usage));
  ctx.check('第一轮 completed', first.status === 'completed', first.status);
  ctx.check('第一轮含约定字符串', (first.output_text ?? '').includes(token), token);
  ctx.invoked();
  try {
    const second = await client.responses.create(
      {
        model: env.agentId,
        previous_response_id: first.id,
        input: '上一轮我让你回复的那串字符是什么？只回复那串字符，不要加任何其他内容。',
      },
      { signal: ctx.signal },
    );
    ctx.track(second.id);
    ctx.observe('second_output', second.output_text);
    const same = env.sessionOf(first.id) === env.sessionOf(second.id);
    ctx.observe('same_session', same);
    ctx.check('第二轮 completed', second.status === 'completed', second.status);
    ctx.check('续接后答出上一轮的暗号', (second.output_text ?? '').includes(token), token);
    ctx.check('两轮属于同一会话', same);
    if (!env.expect.resume) ctx.mismatch('S3 续接：文档写不支持，实际续接成功');
  } catch (error) {
    const { code } = sdkError(ctx, error);
    if (code === 'native_resume_unsupported' || code === 'resume_unsupported') {
      ctx.unsupported(code, '引擎不支持续接（按文档如实记录）');
      if (env.expect.resume) ctx.mismatch(`S3 续接：文档写支持，实际得到 ${code}`);
    } else throw error;
  }
}

export async function s4(env: Env, ctx: Ctx) {
  const client = anthropic(env);
  const token = nonce('OAA');
  ctx.invoked();
  const { data, response } = await client.messages
    .create(
      { model: env.agentId, max_tokens: 256, messages: [{ role: 'user', content: ask(token) }] },
      { signal: ctx.signal },
    )
    .withResponse();
  ctx.track(response.headers.get('x-run-id'));
  const text = data.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  ctx.observe('sync_output', text);
  ctx.observe('sync_stop_reason', data.stop_reason);
  ctx.observe('sync_usage', usageOf(data.usage));
  ctx.check('非流式含约定字符串', text.includes(token), token);
  ctx.check('非流式 stop_reason 为 end_turn', data.stop_reason === 'end_turn', data.stop_reason);

  const token2 = nonce('OAA');
  ctx.invoked();
  const { data: stream, response: r2 } = await client.messages
    .create(
      {
        model: env.agentId,
        max_tokens: 256,
        stream: true,
        messages: [{ role: 'user', content: ask(token2) }],
      },
      { signal: ctx.signal },
    )
    .withResponse();
  ctx.track(r2.headers.get('x-run-id'));
  let streamed = '';
  let deltas = 0;
  let stopped = false;
  let stopReason: string | null | undefined;
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      streamed += event.delta.text;
      deltas++;
    }
    if (event.type === 'message_delta') stopReason = event.delta.stop_reason;
    if (event.type === 'message_stop') stopped = true;
  }
  ctx.observe('stream_output', streamed);
  ctx.observe('stream_deltas', deltas);
  ctx.observe('stream_stop_reason', stopReason);
  ctx.check('流式含约定字符串', streamed.includes(token2), token2);
  ctx.check('流式以 message_stop 结束', stopped);
}

export async function s5(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  ctx.invoked();
  const r = await http(
    env.base,
    'POST',
    `/v1/models/${env.agentId}:generateContent`,
    undefined,
    { contents: [{ role: 'user', parts: [{ text: ask(token) }] }] },
    { 'x-goog-api-key': env.key },
    ctx.signal,
  );
  ctx.track(r.headers.get('x-run-id'));
  const text = ((get(r.body, 'candidates', 0, 'content', 'parts') as { text?: string }[]) ?? [])
    .map((p) => p.text ?? '')
    .join('');
  ctx.observe('http_status', r.status);
  ctx.observe('output', text);
  ctx.observe('finish_reason', get(r.body, 'candidates', 0, 'finishReason'));
  ctx.observe('usage', usageOf(get(r.body, 'usageMetadata')));
  ctx.check('HTTP 200', r.status === 200, r.status === 200 ? undefined : clip(r.text));
  ctx.check('回答含约定字符串', text.includes(token), token);
  const sdkPath = process.env.OAA_GENAI_PATH;
  if (!sdkPath) {
    ctx.observe('genai_sdk', '跳过：未设置 OAA_GENAI_PATH（@google/genai 不是项目依赖）');
    return;
  }
  const entry = createRequire(import.meta.url).resolve(path.resolve(sdkPath));
  const genai = (await import(pathToFileURL(entry).href)) as {
    GoogleGenAI: new (o: Record<string, unknown>) => {
      models: { generateContent(o: Record<string, unknown>): Promise<{ text?: string }> };
    };
  };
  const ai = new genai.GoogleGenAI({ apiKey: env.key, httpOptions: { baseUrl: env.base } });
  const token2 = nonce('OAA');
  ctx.invoked();
  const sdk = await ai.models.generateContent({ model: env.agentId, contents: ask(token2) });
  ctx.observe('genai_sdk_output', sdk.text);
  ctx.check('@google/genai 回答含约定字符串', (sdk.text ?? '').includes(token2), token2);
}

/** 发一个写 note.txt 的任务，返回 422 时的运行 ID；200 表示没有进入审批。 */
async function noteTask(env: Env, ctx: Ctx, line: string) {
  ctx.invoked();
  const r = await http(
    env.base,
    'POST',
    '/v1/chat/completions',
    env.key,
    {
      model: env.agentId,
      messages: [
        {
          role: 'user',
          content: `请在当前工作目录创建文件 note.txt，内容只有一行：${line}。不要做其它任何事，完成后只回复 DONE。`,
        },
      ],
    },
    {},
    ctx.signal,
  );
  const runId = r.headers.get('x-run-id');
  ctx.track(runId);
  return { r, runId, code: errorCode(r.body) };
}
async function noteContent(env: Env, runId: string) {
  const dir = env.workspaceOf(runId);
  const file = dir ? path.join(dir, 'note.txt') : undefined;
  return file && existsSync(file) ? (await readFile(file, 'utf8')).trim() : null;
}
/** 依次处理待审批项（智能体可能连续请求多次），直到运行结束。 */
async function settle(env: Env, ctx: Ctx, runId: string, decision: 'approve' | 'deny') {
  const kinds: string[] = [];
  for (let round = 0; round < 6; round++) {
    const run = await env.gateway.wait(runId, 240_000, true);
    if (run.status !== 'requires_action') return { run, kinds };
    const pending = await env.gateway.pendingActions(runId);
    for (const action of pending) {
      kinds.push(action.kind);
      ctx.observe(`${decision}_action_${kinds.length}`, clip(JSON.stringify(action.detail), 300));
      const d = await env.gateway.decide(runId, action.id, decision);
      ctx.check(
        `${decision === 'approve' ? '批准' : '拒绝'}待审批项 ${action.id}`,
        d.status === 200,
        d.status,
      );
    }
  }
  return { run: await env.gateway.wait(runId, 240_000), kinds };
}

export async function s6(env: Env, ctx: Ctx) {
  if (!env.expect.approvals) return s6Unbridged(env, ctx);
  const line = nonce('OAA-NOTE');
  const a = await noteTask(env, ctx, line);
  ctx.observe('approve_http_status', a.r.status);
  ctx.observe('approve_error_code', a.code);
  const parked = a.r.status === 422 && a.code === 'action_required';
  ctx.check('非流式返回 422 action_required', parked, { status: a.r.status, code: a.code });
  ctx.check('响应带运行 ID', !!a.runId);
  if (!parked && env.expect.approvals)
    ctx.mismatch(
      `S6 审批：文档写会桥接审批，实际第一次请求得到 HTTP ${a.r.status}（${a.code ?? '无错误码'}）`,
    );
  if (a.runId) {
    const pending = await env.gateway.pendingActions(a.runId);
    ctx.observe('pending_count', pending.length);
    if (parked) ctx.check('管理密钥能列出待审批项', pending.length > 0);
    const { run, kinds } = await settle(env, ctx, a.runId, 'approve');
    ctx.observe('approve_kinds', kinds);
    ctx.observe('approve_final_status', run.status);
    ctx.check('批准后运行 completed', run.status === 'completed', run.status);
    const content = await noteContent(env, a.runId);
    ctx.observe('note_content', content);
    ctx.check('note.txt 存在且内容正确', content === line, { expected: line, got: content });
  }

  const line2 = nonce('OAA-NOTE');
  const b = await noteTask(env, ctx, line2);
  ctx.observe('deny_http_status', b.r.status);
  ctx.check(
    '第二个任务也返回 422 action_required',
    b.r.status === 422 && b.code === 'action_required',
    {
      status: b.r.status,
      code: b.code,
    },
  );
  if (b.runId) {
    const { run, kinds } = await settle(env, ctx, b.runId, 'deny');
    ctx.observe('deny_kinds', kinds);
    ctx.observe('deny_final_status', run.status);
    ctx.observe('deny_error_code', run.error?.code);
    ctx.check(
      '拒绝后以 permission_denied 失败',
      run.status === 'failed' && run.error?.code === 'permission_denied',
      {
        status: run.status,
        code: run.error?.code,
      },
    );
    const content = await noteContent(env, b.runId);
    ctx.check('拒绝后没有写入 note.txt', content !== line2, content);
  }
}

/**
 * 审批不桥接的引擎（Antigravity）：只发一次写文件任务，如实记录它是直接写了、被智能体自身拒绝
 * （permission_denied），还是别的结果；不发第二个「拒绝」任务，因为网关没有可拒绝的待审批项。
 */
async function s6Unbridged(env: Env, ctx: Ctx) {
  const line = nonce('OAA-NOTE');
  const a = await noteTask(env, ctx, line);
  ctx.observe('http_status', a.r.status);
  ctx.observe('error_code', a.code);
  ctx.check('响应带运行 ID', !!a.runId);
  if (a.code === 'action_required') {
    ctx.mismatch('S6 审批：文档写该引擎不桥接审批，实际进入了 requires_action');
    if (a.runId) await settle(env, ctx, a.runId, 'deny');
    return;
  }
  if (!a.runId) return;
  const run = await env.gateway.wait(a.runId, 240_000);
  const content = await noteContent(env, a.runId);
  ctx.observe('final_status', run.status);
  ctx.observe('final_error_code', run.error?.code);
  ctx.observe('note_content', content);
  ctx.observe('note_written', content === line);
  ctx.unsupported(
    'approvals_not_bridged',
    `引擎不桥接审批（docs/adapters.md）：没有待审批项；运行 ${run.status}${run.error?.code ? `（${run.error.code}）` : ''}，note.txt ${content === line ? '已写入' : '未写入'}`,
  );
}
