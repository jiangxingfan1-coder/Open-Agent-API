// 把内核事件编码成各种线上流格式（原生 SSE、OpenAI Responses / Chat、Claude、Gemini、UAP）。
// 这里的每个字节都是对外兼容契约，改动前先跑逐字节比对的测试。
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from './auth.js';
import type { Store } from '../store/store.js';
import { terminal, type Run, type RunEvent, type Usage } from '../core/contracts.js';
import { chatUsage, responseObject } from './protocol.js';
import { claudeDelta, claudeDeltaUsage, claudeMessage } from './claude.js';
import { openEventStream } from './streams.js';
import { streamSlots } from './stream-slots.js';
import { sseRequested } from './compat-errors.js';
import * as progress from './progress-stream.js';
export { streamSlots };

/** Stream options of a compat entry (gateway/server.ts). */
export const streamOptions = (
  req: FastifyRequest,
  dialect: string,
  release: (() => void) | undefined,
  progressDefaults: progress.ProgressDefaults,
) => ({ jsonArray: dialect === 'gemini' && !sseRequested(req), release, progressDefaults });
import {
  awaitingCallerInProcess,
  chatToolCallFrames,
  claudeToolCallFrames,
  geminiToolCallChunk,
  handOffEvent,
  responsesToolCallFrames,
} from './bridge.js';
import { Fault } from '../core/util.js';
import { isTerminalEvent } from '../core/events.js';
import {
  chatFinish,
  claudeErrorType,
  claudeStop,
  finishOf,
  geminiFinish,
  geminiStatus,
  problemStatus,
  runProblem,
} from './compat-errors.js';

export function cursor(req: FastifyRequest): number {
  const value = Number(
    req.headers['last-event-id'] ?? (req.query as { after?: string }).after ?? 0,
  );
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Fault('invalid_cursor', 'Event cursor must be a nonnegative integer.');
  return value;
}
export type StreamMode =
  'native' | 'responses' | 'chat' | 'claude' | 'gemini' | 'uap-ndjson' | 'uap-sse';

export function streamEvents(
  req: FastifyRequest,
  reply: FastifyReply,
  store: Store,
  auth: Auth,
  runId: string,
  after: number,
  mode: StreamMode,
  includeUsage = false,
  initialRun?: Run,
  options: {
    /** Responses：不发 `sequence_number` 不大于它的帧（`GET ?stream=true&starting_after=`）。 */
    skipThrough?: number;
    /** Gemini：不带 `alt=sse` 时按 REST 的分块 JSON 数组输出。 */
    jsonArray?: boolean;
    /** 调用方事先占好的流名额（兼容入口在提交运行之前占）；没有时这里占。 */
    release?: () => void;
    /** The configured stream-progress defaults (docs/progress.md). */
    progressDefaults?: progress.ProgressDefaults;
  } = {},
): void {
  const release = options.release ?? streamSlots(store).acquire(req.principal);
  const needsInitial =
    mode === 'chat' ||
    mode === 'claude' ||
    mode === 'gemini' ||
    mode === 'uap-ndjson' ||
    mode === 'uap-sse';
  const initial = needsInitial ? (initialRun ?? store.run(runId)) : initialRun;
  if (options.progressDefaults) progress.rememberProgressDefaults(store, options.progressDefaults);
  const locale = progress.progressFor(store, req, initial ?? store.run(runId), mode);
  const lines = locale ? new progress.ProgressLines(locale) : undefined;
  const reasoning =
    mode === 'responses' && lines ? new progress.ResponsesReasoning(runId) : undefined;
  const thinking = new progress.ClaudeThinking();
  let answered = false;
  const base = initial
    ? {
        id: `chatcmpl_${runId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(initial.createdAt / 1000),
        model: initial.agentId,
        ...(includeUsage ? { usage: null } : {}),
      }
    : undefined;

  // 极速切片缓冲区（Zero-Copy Pre-serialized Slices）
  const chatDeltaPrefix = initial
    ? `data: {"id":"chatcmpl_${runId}","object":"chat.completion.chunk","created":${Math.floor(initial.createdAt / 1000)},"model":${JSON.stringify(initial.agentId)}${includeUsage ? ',"usage":null' : ''},"choices":[{"index":0,"delta":{"content":`
    : '';
  const chatDeltaSuffix = `},"finish_reason":null}]}\n\n`;

  let claudeDeltaPrefix = '';
  const claudeDeltaSuffix = `}}\n\n`;

  const geminiModelVer = initial ? `${initial.agentId}@${initial.route.model}` : 'agent';
  const geminiDeltaPrefix = `data: {"responseId":${JSON.stringify(runId)},"modelVersion":${JSON.stringify(geminiModelVer)},"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":`;
  const geminiDeltaSuffix = `}]}}]}\n\n`;
  const geminiDeltaJson = (delta: unknown) =>
    JSON.stringify({
      responseId: runId,
      modelVersion: geminiModelVer,
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: delta }] } }],
    });
  /** Claude 流的开头：message_start、ping（官方事件序列里紧跟 message_start）、text 块开始。 */
  let claudeStarted = false;
  const writeClaudeMessageStart = () => {
    if (claudeStarted) return;
    claudeStarted = true;
    write(
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: claudeMessage(runId, initial?.agentId ?? 'agent', [], null, undefined) })}\n\n`,
    );
    write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
  };
  /** The text block follows a progress thinking block when there was one (index 1, else 0). */
  const writeClaudeStart = () => {
    writeClaudeMessageStart();
    for (const frame of thinking.close()) write(frame);
    const index = thinking.next;
    claudeDeltaPrefix = `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":`;
    write(
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n\n`,
    );
  };

  const bridged =
    (mode === 'chat' || mode === 'responses' || mode === 'claude' || mode === 'gemini') &&
    !!initial?.checkpoint.bridge;
  // Responses 流的 sequence_number（以及 SSE 的 id）是这条流里帧的序号，从 0 起连续；
  // 桥接合成的帧同样计数。`skipThrough` 之前的帧照常计数但不发出。
  let seq = -1;
  const skipThrough = options.skipThrough ?? -1;
  const nextSeq = () => ++seq;
  const writeResponses = (type: string, raw: Record<string, unknown>, shift = true) => {
    const data = reasoning && shift ? reasoning.shift(raw) : raw;
    const n = nextSeq();
    if (n > skipThrough)
      write(
        `id: ${n}\nevent: ${type}\ndata: ${JSON.stringify({ type, sequence_number: n, ...data })}\n\n`,
      );
  };
  const jsonArray = mode === 'gemini' && options.jsonArray === true;
  let geminiChunks = 0;
  /** Gemini 的一块：SSE 是 `data:` 帧，JSON 数组模式是数组的一个元素。 */
  const writeGemini = (json: string) => {
    if (!jsonArray) write(`data: ${json}\n\n`);
    else write(`${geminiChunks++ === 0 ? '[' : ',\r\n'}${json}`);
  };
  /** 运行没有正常结束时的错误内容（真实的错误码与原因）。 */
  const problem = () => {
    const r = store.run(runId);
    return { ...runProblem(r), status: problemStatus(r) };
  };
  const callerAction = (e: RunEvent) =>
    bridged &&
    e.type === 'run.requires_action' &&
    (e.data.approval as { kind?: string } | undefined)?.kind === 'client_tool';
  const isNdjson = mode === 'uap-ndjson';
  const extraHeaders: Record<string, string> = { 'x-run-id': runId };
  if (mode === 'uap-ndjson' || mode === 'uap-sse') {
    extraHeaders['x-uap-version'] = '1.0';
  }

  let stream: ReturnType<typeof openEventStream>;
  try {
    stream = openEventStream(
      req,
      reply,
      auth,
      extraHeaders,
      2 * 1024 * 1024,
      isNdjson ? 'ndjson' : jsonArray ? 'json' : 'sse',
    );
  } catch (error) {
    release();
    throw error;
  }
  stream.onClose(release);
  let last = after;
  let roleSent = false;
  let seenTerminal = false;
  const { close, write } = stream;

  const writeUapFrame = (type: string, seq: number, payload: Record<string, unknown>) => {
    const json = JSON.stringify({ t: type, seq, ...payload });
    if (isNdjson) write(`${json}\n`);
    else write(`id: ${seq}\nevent: uap.${type}\ndata: ${json}\n\n`);
  };

  if ((mode === 'uap-ndjson' || mode === 'uap-sse') && initial && after === 0) {
    writeUapFrame('start', 0, {
      uap: '1.0',
      run: runId,
      agent: initial.agentId,
      route: initial.route,
    });
  }

  /** Progress first, then the event's own frames (docs/progress.md). */
  const writeProgress = (e: RunEvent, terminalEvent: boolean) => {
    const opensAnswer =
      e.type === 'response.output_item.added' || e.type === 'response.output_text.delta';
    // Claude and Responses keep progress ahead of the answer (one block / item, positions stable).
    if (reasoning && (opensAnswer || terminalEvent || (bridged && handOffEvent(e.type))))
      reasoning.close((type, data) => writeResponses(type, data, false));
    const text =
      (mode === 'claude' || mode === 'responses') && answered ? undefined : lines!.next(e);
    if (opensAnswer) answered = true;
    if (!text || (answered && e.type === 'response.completed')) return;
    if (mode === 'chat') {
      if (!roleSent)
        write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`,
        );
      roleSent = true;
      write(progress.chatReasoningFrame(base!, text));
    } else if (mode === 'gemini')
      writeGemini(progress.geminiThoughtJson(runId, geminiModelVer, text));
    else if (mode === 'claude') {
      writeClaudeMessageStart();
      for (const frame of thinking.line(text)) write(frame);
    } else if (reasoning && !reasoning.closed)
      reasoning.line(text, (type, data) => writeResponses(type, data, false));
  };
  /** What the bridged tool_use frames continue from: an open text block, or the next free index. */
  const claudeBlocks = () => {
    const textIndex = roleSent ? thinking.next : undefined;
    const closing = thinking.close();
    for (const frame of closing) write(frame);
    return { started: claudeStarted, textIndex, next: thinking.next };
  };
  const onEvent = (e: RunEvent) => {
    if (e.id <= last || stream.closed) return;
    last = e.id;
    const terminalEvent = isTerminalEvent(e.type);
    if (lines) writeProgress(e, terminalEvent);

    if (mode === 'native') write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    else if (mode === 'responses' && e.type.startsWith('response.')) {
      writeResponses(e.type, e.data);
    } else if (mode === 'responses' && bridged && handOffEvent(e.type)) {
      const frames = responsesToolCallFrames(
        store,
        runId,
        nextSeq,
        reasoning?.active ? reasoning.item() : undefined,
      );
      if (frames) {
        for (const frame of frames) write(frame);
        seenTerminal = true;
        close();
      }
    } else if (mode === 'responses' && e.type === 'run.requires_action' && !callerAction(e)) {
      // A Responses stream stays open while the owner decides; it reports the same state as the
      // non-streaming Responses object (`in_progress`, metadata `oaa.status=requires_action`).
      writeResponses('response.in_progress', { response: responseObject(store.run(runId)) });
    } else if (mode === 'chat') {
      if (e.type === 'response.output_text.delta') {
        if (!roleSent) {
          write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`,
          );
          roleSent = true;
        }
        write(chatDeltaPrefix + JSON.stringify(e.data.delta) + chatDeltaSuffix);
      }
      // 截断与正常完成一样收尾，只是 finish_reason 为 "length"。
      const truncated = e.type === 'response.incomplete' && finishOf(store.run(runId)) === 'length';
      if (e.type === 'response.completed' || truncated) {
        write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: truncated ? chatFinish('length') : 'stop' }] })}\n\n`,
        );
        if (includeUsage) {
          const respObj = e.data.response as
            { usage?: Run['usage']; metadata?: Record<string, string> } | undefined;
          const usagePayload =
            respObj !== undefined
              ? respObj.usage && respObj.metadata?.['oaa.usage_complete'] !== 'false'
                ? {
                    prompt_tokens: respObj.usage.input_tokens,
                    completion_tokens: respObj.usage.output_tokens,
                    total_tokens: respObj.usage.total_tokens,
                  }
                : null
              : chatUsage(store.run(runId));
          write(`data: ${JSON.stringify({ ...base, choices: [], usage: usagePayload })}\n\n`);
        }
        write('data: [DONE]\n\n');
      }
      // 桥接：调用方工具的待办不当作人工审批；真正停车时以 tool_calls 收尾（docs/harness.md）。
      const toolCalls =
        bridged && handOffEvent(e.type)
          ? chatToolCallFrames(store, runId, base!, roleSent, includeUsage)
          : undefined;
      if (toolCalls) {
        for (const frame of toolCalls) write(frame);
        seenTerminal = true;
        close();
      }
      if (
        !truncated &&
        ((e.type === 'run.requires_action' && !callerAction(e)) ||
          [
            'response.failed',
            'response.incomplete',
            'response.cancelled',
            'run.interrupted',
          ].includes(e.type))
      ) {
        const { code, message, status } = problem();
        write(
          `data: ${JSON.stringify({ error: { code, message, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, run_id: runId } })}\n\n`,
        );
        seenTerminal = true;
        close();
      }
    } else if (mode === 'claude') {
      const truncated = e.type === 'response.incomplete' && finishOf(store.run(runId)) === 'length';
      if (e.type === 'response.output_text.delta') {
        if (!roleSent) {
          writeClaudeStart();
          roleSent = true;
        }
        write(claudeDeltaPrefix + JSON.stringify(e.data.delta) + claudeDeltaSuffix);
      }
      if (e.type === 'response.completed' || truncated) {
        if (!roleSent) {
          writeClaudeStart();
          roleSent = true;
        }
        write(
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: thinking.next })}\n\n`,
        );
        const respUsage =
          (e.data.response as { usage?: Run['usage'] } | undefined)?.usage ??
          store.run(runId).usage;
        const inTokens = respUsage?.input_tokens ?? 0;
        const outTokens = respUsage?.output_tokens ?? 0;
        write(
          `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: claudeDelta(claudeStop(truncated ? 'length' : 'stop')), usage: claudeDeltaUsage({ input_tokens: inTokens, output_tokens: outTokens }) })}\n\n`,
        );
        write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      }
      const toolUses =
        bridged && handOffEvent(e.type)
          ? claudeToolCallFrames(store, runId, claudeBlocks(), initial?.agentId ?? 'agent')
          : undefined;
      if (toolUses) {
        for (const frame of toolUses) write(frame);
        seenTerminal = true;
        close();
      }
      if (
        !truncated &&
        ((e.type === 'run.requires_action' && !callerAction(e)) ||
          [
            'response.failed',
            'response.incomplete',
            'response.cancelled',
            'run.interrupted',
          ].includes(e.type))
      ) {
        const { code, message, status } = problem();
        write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: claudeErrorType(status), message, code, run_id: runId } })}\n\n`,
        );
        seenTerminal = true;
        close();
      }
    } else if (mode === 'gemini') {
      const truncated = e.type === 'response.incomplete' && finishOf(store.run(runId)) === 'length';
      if (e.type === 'response.output_text.delta') {
        if (jsonArray) writeGemini(geminiDeltaJson(e.data.delta));
        else write(geminiDeltaPrefix + JSON.stringify(e.data.delta) + geminiDeltaSuffix);
      }
      if (e.type === 'response.completed' || truncated) {
        const respUsage = (e.data.response as { usage?: Run['usage'] } | undefined)?.usage;
        writeGemini(
          JSON.stringify({
            responseId: runId,
            modelVersion: geminiModelVer,
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [] },
                finishReason: geminiFinish(truncated ? 'length' : 'stop'),
              },
            ],
            usageMetadata: {
              promptTokenCount: respUsage?.input_tokens ?? 0,
              candidatesTokenCount: respUsage?.output_tokens ?? 0,
              totalTokenCount: respUsage?.total_tokens ?? 0,
            },
          }),
        );
        if (jsonArray) write(']');
      }
      const calls =
        bridged && handOffEvent(e.type)
          ? geminiToolCallChunk(store, runId, geminiModelVer)
          : undefined;
      if (calls) {
        writeGemini(calls);
        if (jsonArray) write(']');
        seenTerminal = true;
        close();
      }
      if (
        !truncated &&
        ((e.type === 'run.requires_action' && !callerAction(e)) ||
          [
            'response.failed',
            'response.incomplete',
            'response.cancelled',
            'run.interrupted',
          ].includes(e.type))
      ) {
        const { code, message, status } = problem();
        writeGemini(
          JSON.stringify({
            error: {
              code: status,
              message,
              status: geminiStatus(status),
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: code,
                  domain: 'open-agent-api',
                  metadata: { run_id: runId },
                },
              ],
            },
          }),
        );
        if (jsonArray) write(']');
        seenTerminal = true;
        close();
      }
    } else if (mode === 'uap-ndjson' || mode === 'uap-sse') {
      if (e.type === 'response.output_text.delta') {
        if (isNdjson) {
          write(`{"t":"delta","seq":${e.id},"d":${JSON.stringify(e.data.delta)}}\n`);
        } else {
          writeUapFrame('delta', e.id, { d: e.data.delta });
        }
      } else if (e.type === 'route.failover') {
        writeUapFrame('failover', e.id, { data: e.data });
      } else if (e.type.startsWith('tool.')) {
        writeUapFrame('step', e.id, { ev: e.type, data: e.data });
      } else if (e.type === 'run.requires_action') {
        writeUapFrame('action', e.id, { data: e.data });
        seenTerminal = true;
        close();
      } else if (terminalEvent) {
        const resp = e.data.response as
          | {
              status?: unknown;
              usage?: Partial<Usage>;
              error?: unknown;
              metadata?: Record<string, unknown>;
            }
          | undefined;
        writeUapFrame('done', e.id, {
          status: e.type === 'response.completed' ? 'completed' : (resp?.status ?? e.type),
          usage: resp?.usage
            ? {
                input_tokens: resp.usage.input_tokens,
                output_tokens: resp.usage.output_tokens,
                total_tokens: resp.usage.total_tokens,
              }
            : null,
          error: resp?.error ?? e.data.error ?? null,
          selected_model: resp?.metadata?.['oaa.selected_model'] ?? initial?.route.model,
          selected_route: resp?.metadata?.['oaa.selected_route'] ?? initial?.route.id,
        });
      }
    }

    if (terminalEvent) {
      seenTerminal = true;
      close();
    }
  };
  // 补发与追赶：积压超过高水位时等客户端读走再继续，事件从已提交的
  // 历史按游标重读，所以等待期间到达的实时事件不会排在内存里，也不会乱序或遗漏。没有积压
  // 时实时事件照旧同步写出，常规大小的运行线上字节不变。
  let catchingUp = false;
  let behind = false;
  const pump = async () => {
    if (catchingUp) {
      behind = true;
      return;
    }
    catchingUp = true;
    try {
      do {
        behind = false;
        for (;;) {
          if (stream.closed) return;
          const events = store.recentHistory(runId, last, REPLAY_BATCH);
          for (const e of events) {
            if (
              stream.backlog() > REPLAY_HIGH_WATER &&
              !(await stream.drained(REPLAY_HIGH_WATER, REPLAY_STALL_MS))
            )
              return;
            onEvent(e);
          }
          if (events.length < REPLAY_BATCH) break;
        }
      } while (behind && !stream.closed);
    } finally {
      catchingUp = false;
    }
  };
  const live = (e: RunEvent) => {
    if (stream.closed || e.id <= last) return;
    if (!catchingUp && stream.backlog() <= REPLAY_HIGH_WATER) onEvent(e);
    else void pump();
  };
  store.events.on(runId, live);
  stream.onClose(() => {
    store.events.off(runId, live);
  });
  void pump().then(() => afterReplay());
  const afterReplay = () => {
    // 续接时外部智能体已经在等别的调用（晚到的并行调用，通知在游标之前）：立即交给调用方。
    if (
      bridged &&
      !stream.closed &&
      !seenTerminal &&
      awaitingCallerInProcess(store, store.run(runId))
    ) {
      const cursorAt = last;
      onEvent({ id: last + 1, runId, type: 'run.awaiting_caller', time: Date.now(), data: {} });
      last = cursorAt;
    }
    if (!stream.closed && !seenTerminal && terminal(store.run(runId).status)) close();
  };
}

/** 补发一批读多少条事件；积压超过高水位就等客户端读走；多久一个字节都没读走算慢客户端。 */
const REPLAY_BATCH = 500;
const REPLAY_HIGH_WATER = 1024 * 1024;
const REPLAY_STALL_MS = 30_000;
