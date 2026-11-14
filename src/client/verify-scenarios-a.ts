import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bi } from '../core/locale.js';
import { clip, errorCode, http, nonce, type Ctx } from './verify-harness.js';
import { ask, recordError, reportsUsage, usageOf, type Env } from './verify-env.js';
import { chat, chatStream, claudeMessage, claudeStream, gemini, responses } from './verify-wire.js';

// S1-S6: OpenAI Chat (plain and streaming), Responses with continuation, Claude Messages, Gemini,
// approvals. Each scenario calls the agent once (S3, S4 and S6 twice); nothing retries.

export async function s1(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  ctx.invoked();
  const r = await chat(env, ask(token), ctx.signal);
  ctx.track(r.runId);
  ctx.observe('http_status', r.status);
  ctx.observe('output', r.text);
  ctx.observe('finish_reason', r.finish);
  ctx.observe('usage', usageOf(r.usage));
  ctx.check(
    'HTTP 200',
    r.status === 200,
    r.status === 200 ? undefined : clip(JSON.stringify(r.body)),
  );
  ctx.check(
    bi('回答含约定字符串', 'The answer contains the agreed string'),
    r.text.includes(token),
    token,
  );
  const hasUsage = reportsUsage(r.usage);
  ctx.observe('usage_present', hasUsage);
  if (env.expect && hasUsage !== env.expect.usage)
    ctx.mismatch(
      bi(
        `S1 用量：文档写${env.expect.usage ? '会上报' : '不上报'}，实际${hasUsage ? '有非零 usage' : '没有（或为 0）'}`,
        `S1 usage: the docs say it ${env.expect.usage ? 'is reported' : 'is not reported'}, observed ${hasUsage ? 'non-zero usage' : 'none (or zero)'}`,
      ),
    );
  ctx.check(bi('响应带 X-Run-ID', 'The response carries X-Run-ID'), !!r.runId);
  if (r.runId) {
    const run = await env.gateway.run(r.runId);
    ctx.check(
      bi('任务记录状态为 completed', 'The run record is completed'),
      run.status === 'completed',
      run.status,
    );
  }
}

export async function s2(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  ctx.invoked();
  const r = await chatStream(env, ask(token), ctx.signal);
  ctx.track(r.runId);
  const span = r.times.length ? r.times.at(-1)! - r.times[0]! : 0;
  const incremental = r.times.length > 1 && span > 20;
  ctx.observe('http_status', r.status);
  ctx.observe('first_delta_ms', r.times[0] !== undefined ? Math.round(r.times[0]) : null);
  ctx.observe('total_ms', Math.round(r.totalMs));
  ctx.observe('delta_count', r.times.length);
  ctx.observe('delta_span_ms', Math.round(span));
  ctx.observe('incremental', incremental);
  ctx.observe('finish_reason', r.finish);
  ctx.observe('usage', usageOf(r.usage));
  ctx.observe('output', r.text);
  ctx.check(
    'HTTP 200',
    r.status === 200,
    r.status === 200 ? undefined : clip(JSON.stringify(r.body)),
  );
  ctx.check(
    bi('流正常结束且 finish_reason 为 stop', 'The stream ends normally with finish_reason stop'),
    r.finish === 'stop',
    r.finish,
  );
  ctx.check(
    bi('拼接文本含约定字符串', 'The joined text contains the agreed string'),
    r.text.includes(token),
    token,
  );
  if (env.expect && incremental !== (env.expect.streaming === 'token'))
    ctx.mismatch(
      bi(
        `S2 流式：文档写${env.expect.streaming === 'token' ? '逐 token 流式' : '按消息流式'}，实际 ${r.times.length} 个增量、跨度 ${Math.round(span)} 毫秒（${incremental ? '逐步到达' : '基本一次性到达'}）`,
        `S2 streaming: the docs say ${env.expect.streaming === 'token' ? 'token-level' : 'message-level'} streaming, observed ${r.times.length} deltas over ${Math.round(span)} ms (${incremental ? 'arrived gradually' : 'arrived at once'})`,
      ),
    );
  if (r.runId) {
    const run = await env.gateway.run(r.runId);
    ctx.check(
      bi('任务记录状态为 completed', 'The run record is completed'),
      run.status === 'completed',
      run.status,
    );
  }
}

export async function s3(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  ctx.invoked();
  const first = await responses(env, `请记住这个暗号。${ask(token)}`, undefined, ctx.signal);
  ctx.track(first.id);
  ctx.observe('first_status', first.runStatus);
  ctx.observe('first_output', first.text);
  ctx.observe('first_usage', usageOf(first.usage));
  ctx.check(
    bi('第一轮 completed', 'First turn completed'),
    first.runStatus === 'completed',
    first.runStatus,
  );
  ctx.check(
    bi('第一轮含约定字符串', 'First turn contains the agreed string'),
    first.text.includes(token),
    token,
  );
  if (!first.id) return;
  ctx.invoked();
  const second = await responses(
    env,
    '上一轮我让你回复的那串字符是什么？只回复那串字符，不要加任何其他内容。',
    first.id,
    ctx.signal,
  );
  ctx.track(second.id);
  if (second.status !== 200) {
    const { code } = recordError(ctx, second.status, second.body);
    if (code === 'native_resume_unsupported' || code === 'resume_unsupported') {
      ctx.unsupported(
        code,
        bi(
          '引擎不支持续接（按文档如实记录）',
          'The engine does not support continuation (recorded as documented)',
        ),
      );
      if (env.expect?.resume)
        ctx.mismatch(
          bi(
            `S3 续接：文档写支持，实际得到 ${code}`,
            `S3 continuation: the docs say supported, observed ${code}`,
          ),
        );
      return;
    }
    ctx.check('HTTP 200', false, second.status);
    return;
  }
  ctx.observe('second_output', second.text);
  const same = !!second.id && env.sessionOf(first.id) === env.sessionOf(second.id);
  ctx.observe('same_session', same);
  ctx.check(
    bi('第二轮 completed', 'Second turn completed'),
    second.runStatus === 'completed',
    second.runStatus,
  );
  ctx.check(
    bi('续接后答出上一轮的暗号', 'After continuing, it repeats the previous turn’s code'),
    second.text.includes(token),
    token,
  );
  ctx.check(bi('两轮属于同一会话', 'Both turns belong to one session'), same);
  if (env.expect && !env.expect.resume)
    ctx.mismatch(
      bi(
        'S3 续接：文档写不支持，实际续接成功',
        'S3 continuation: the docs say unsupported, observed success',
      ),
    );
}

export async function s4(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  ctx.invoked();
  const sync = await claudeMessage(env, ask(token), ctx.signal);
  ctx.track(sync.runId);
  ctx.observe('sync_status', sync.status);
  ctx.observe('sync_output', sync.text);
  ctx.observe('sync_stop_reason', sync.stopReason);
  ctx.observe('sync_usage', usageOf(sync.usage));
  ctx.check(
    'HTTP 200',
    sync.status === 200,
    sync.status === 200 ? undefined : clip(JSON.stringify(sync.body)),
  );
  ctx.check(
    bi('非流式含约定字符串', 'Non-streaming contains the agreed string'),
    sync.text.includes(token),
    token,
  );
  ctx.check(
    bi('非流式 stop_reason 为 end_turn', 'Non-streaming stop_reason is end_turn'),
    sync.stopReason === 'end_turn',
    sync.stopReason,
  );

  const token2 = nonce('OAA');
  ctx.invoked();
  const stream = await claudeStream(env, ask(token2), ctx.signal);
  ctx.track(stream.runId);
  ctx.observe('stream_status', stream.status);
  ctx.observe('stream_output', stream.text);
  ctx.observe('stream_deltas', stream.deltas);
  ctx.observe('stream_stop_reason', stream.stopReason);
  ctx.check(
    bi('流式含约定字符串', 'Streaming contains the agreed string'),
    stream.text.includes(token2),
    token2,
  );
  ctx.check(bi('流式以 message_stop 结束', 'The stream ends with message_stop'), stream.stopped);
}

export async function s5(env: Env, ctx: Ctx) {
  const token = nonce('OAA');
  ctx.invoked();
  const r = await gemini(env, ask(token), ctx.signal);
  ctx.track(r.runId);
  ctx.observe('http_status', r.status);
  ctx.observe('output', r.text);
  ctx.observe('finish_reason', r.finish);
  ctx.observe('usage', usageOf(r.usage));
  ctx.check('HTTP 200', r.status === 200, r.status === 200 ? undefined : clip(r.raw.text));
  ctx.check(
    bi('回答含约定字符串', 'The answer contains the agreed string'),
    r.text.includes(token),
    token,
  );
  // Optional: the official @google/genai SDK, which is not a dependency; point OAA_GENAI_PATH at it.
  const sdkPath = process.env.OAA_GENAI_PATH;
  if (!sdkPath) return;
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
  ctx.check(
    bi('@google/genai 回答含约定字符串', '@google/genai answer contains the agreed string'),
    (sdk.text ?? '').includes(token2),
    token2,
  );
}

/** Sends a task that writes note.txt; the run ID and error code tell whether it parked for approval. */
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
/** Decides pending items one after another (the agent may ask repeatedly) until the run ends. */
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
        bi(
          `${decision === 'approve' ? '批准' : '拒绝'}待审批项 ${action.id}`,
          `${decision === 'approve' ? 'Approve' : 'Deny'} pending item ${action.id}`,
        ),
        d.status === 200,
        d.status,
      );
    }
  }
  return { run: await env.gateway.wait(runId, 240_000), kinds };
}

export async function s6(env: Env, ctx: Ctx) {
  if (env.expect?.approvals === false) return s6Unbridged(env, ctx);
  const line = nonce('OAA-NOTE');
  const a = await noteTask(env, ctx, line);
  ctx.observe('approve_http_status', a.r.status);
  ctx.observe('approve_error_code', a.code);
  const parked = a.r.status === 422 && a.code === 'action_required';
  if (!parked && !env.expect && a.r.status === 200) {
    // An agent the docs say nothing about finished without asking: approve/deny cannot be tested.
    ctx.unsupported(
      'approval_not_requested',
      bi(
        '智能体没有请求审批就完成了写文件任务，无法测试批准与拒绝；没有待审批项',
        'The agent finished the write task without asking for approval, so approve and deny cannot be tested; there was no pending item',
      ),
    );
    ctx.observe('note_content', await noteContent(env, a.runId ?? ''));
    return;
  }
  ctx.check(
    bi('非流式返回 422 action_required', 'Non-streaming returns 422 action_required'),
    parked,
    { status: a.r.status, code: a.code },
  );
  ctx.check(bi('响应带运行 ID', 'The response carries a run ID'), !!a.runId);
  if (!parked && env.expect?.approvals)
    ctx.mismatch(
      bi(
        `S6 审批：文档写会桥接审批，实际第一次请求得到 HTTP ${a.r.status}（${a.code ?? '无错误码'}）`,
        `S6 approvals: the docs say approvals are bridged, observed HTTP ${a.r.status} (${a.code ?? 'no error code'}) on the first request`,
      ),
    );
  if (a.runId) {
    const pending = await env.gateway.pendingActions(a.runId);
    ctx.observe('pending_count', pending.length);
    if (parked)
      ctx.check(
        bi('管理密钥能列出待审批项', 'The admin key can list the pending items'),
        pending.length > 0,
      );
    const { run, kinds } = await settle(env, ctx, a.runId, 'approve');
    ctx.observe('approve_kinds', kinds);
    ctx.observe('approve_final_status', run.status);
    ctx.check(
      bi('批准后运行 completed', 'After approval the run completes'),
      run.status === 'completed',
      run.status,
    );
    const content = await noteContent(env, a.runId);
    ctx.observe('note_content', content);
    ctx.check(
      bi('note.txt 存在且内容正确', 'note.txt exists with the right content'),
      content === line,
      { expected: line, got: content },
    );
  }

  const line2 = nonce('OAA-NOTE');
  const b = await noteTask(env, ctx, line2);
  ctx.observe('deny_http_status', b.r.status);
  ctx.check(
    bi('第二个任务也返回 422 action_required', 'The second task also returns 422 action_required'),
    b.r.status === 422 && b.code === 'action_required',
    { status: b.r.status, code: b.code },
  );
  if (b.runId) {
    const { run, kinds } = await settle(env, ctx, b.runId, 'deny');
    ctx.observe('deny_kinds', kinds);
    ctx.observe('deny_final_status', run.status);
    ctx.observe('deny_error_code', run.error?.code);
    ctx.check(
      bi('拒绝后以 permission_denied 失败', 'After denial the run fails with permission_denied'),
      run.status === 'failed' && run.error?.code === 'permission_denied',
      { status: run.status, code: run.error?.code },
    );
    const content = await noteContent(env, b.runId);
    ctx.check(
      bi('拒绝后没有写入 note.txt', 'After denial note.txt was not written'),
      content !== line2,
      content,
    );
  }
}

/**
 * Engines that do not bridge approvals (Antigravity): one write task, recording honestly whether it
 * wrote, was refused by the agent itself (permission_denied) or ended otherwise. No second "deny" task:
 * the gateway has nothing to deny.
 */
async function s6Unbridged(env: Env, ctx: Ctx) {
  const line = nonce('OAA-NOTE');
  const a = await noteTask(env, ctx, line);
  ctx.observe('http_status', a.r.status);
  ctx.observe('error_code', a.code);
  ctx.check(bi('响应带运行 ID', 'The response carries a run ID'), !!a.runId);
  if (a.code === 'action_required') {
    ctx.mismatch(
      bi(
        'S6 审批：文档写该引擎不桥接审批，实际进入了 requires_action',
        'S6 approvals: the docs say this engine does not bridge approvals, observed requires_action',
      ),
    );
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
    bi(
      `引擎不桥接审批（docs/adapters.md）：没有待审批项；运行 ${run.status}${run.error?.code ? `（${run.error.code}）` : ''}，note.txt ${content === line ? '已写入' : '未写入'}`,
      `The engine does not bridge approvals (docs/adapters.md): there was no pending item; the run is ${run.status}${run.error?.code ? ` (${run.error.code})` : ''}, note.txt was ${content === line ? 'written' : 'not written'}`,
    ),
  );
}
