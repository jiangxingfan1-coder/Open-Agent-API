/**
 * 桥接（docs/harness.md「bridge」）的网关侧：等待运行真正停车，把停车的 `client_tool` 待办
 * 渲染成 Chat Completions 的标准 `tool_calls`（非流式与流式）。
 */
import { terminal, visibleSubject, type Principal, type Run } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { nativeStepId } from '../kernel/native-turn.js';
import type { Invocation } from '../kernel/invocation.js';
import type { Kernel } from '../kernel/kernel.js';
import type { Store } from '../store/store.js';
import { pendingApprovals } from '../store/approval-rows.js';
import { chatObject, chatUsage, claudeMessageObject, responseObject } from './protocol.js';
import { claudeDelta, claudeDeltaUsage, claudeMessage } from './claude.js';
import { geminiResponseObject } from './uap.js';

/** 外部智能体的运行（有 `native_<runId>` 步骤）：桥接时在进程内等待调用方，不停车。 */
const externalRun = (store: Store, run: Run) => !!store.getStep(nativeStepId(run));

/** 外部智能体的桥接运行此刻只等调用方（进程内等待，`run.awaiting_caller`）。 */
export const awaitingCallerInProcess = (store: Store, run: Run) =>
  run.status === 'requires_action' &&
  !run.checkpoint.suspension &&
  !!run.checkpoint.bridge &&
  store.awaitingCaller(run.id) &&
  externalRun(store, run);

/**
 * 运行是否已经在调用方工具上真正停车（`run.parked` 已落盘），而且只等调用方；外部智能体的
 * 桥接运行在进程内等待调用方时同样算（`run.awaiting_caller`）。
 */
export const parkedOnCaller = (store: Store, run: Run) =>
  (run.status === 'requires_action' &&
    run.checkpoint.suspension?.kind === 'approval' &&
    store.awaitingCaller(run.id)) ||
  awaitingCallerInProcess(store, run);

/** 「该把待处理的调用交给调用方了」：内核停车，或外部智能体的合并通知。 */
export const handOffEvent = (type: string) =>
  type === 'run.parked' || type === 'run.awaiting_caller';

/**
 * 等到运行真正停车（`run.parked`）或终止。一轮里并行的多个调用方工具各自产生
 * `run.requires_action`，只有停车之后才能一次给全。外部智能体以 `run.awaiting_caller` 代替
 * `run.parked`；续接时如果此刻已经有别的 pending 调用（晚到的并行调用），立即返回。
 * 关机、调用方断开时与 `kernel.wait` 一致。
 */
export async function waitParkedOrTerminal(
  kernel: Kernel,
  store: Store,
  runId: string,
  signal: AbortSignal,
): Promise<Run> {
  const inner = new AbortController();
  const stop = () => inner.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  let onEvent: ((e: { type: string }) => void) | undefined;
  try {
    const parked = new Promise<Run>((resolve) => {
      const check = () => {
        const run = store.run(runId);
        if (
          terminal(run.status) ||
          (run.status === 'requires_action' && run.checkpoint.suspension?.kind === 'approval') ||
          awaitingCallerInProcess(store, run)
        )
          resolve(run);
      };
      onEvent = (e) => {
        if (handOffEvent(e.type)) check();
      };
      store.events.on(runId, onEvent);
      check();
    });
    return await Promise.race([parked, kernel.wait(runId, false, inner.signal)]);
  } finally {
    if (onEvent) store.events.off(runId, onEvent);
    signal.removeEventListener('abort', stop);
    inner.abort();
  }
}

/** 停车中的运行全部待处理的调用方工具调用，按产生顺序；`id` 是待办 ID，名字用调用方原名。 */
export function pendingToolCalls(store: Store, runId: string) {
  return pendingApprovals(store, runId, 'client_tool').map((a) => ({
    id: a.id,
    type: 'function' as const,
    function: {
      name: String(a.detail.tool),
      arguments: JSON.stringify(a.detail.arguments ?? {}),
    },
  }));
}

/**
 * 桥接运行的非流式 Chat 响应：停车时 `finish_reason: "tool_calls"`；`message.content` 只含
 * `delivered` 之后新产生的输出（没有则为 null）。混有人工审批时按既有方式报 `action_required`。
 */
export function bridgedChatObject(store: Store, run: Run): Record<string, unknown> {
  const text = run.output
    .slice(run.checkpoint.bridge?.delivered ?? 0)
    .map((m) => m.text)
    .join('\n\n');
  if (!parkedOnCaller(store, run)) {
    const body = chatObject(run) as { choices: { message: { content: string } }[] };
    body.choices[0]!.message.content = text;
    return body;
  }
  return {
    id: `chatcmpl_${run.id}`,
    object: 'chat.completion',
    created: Math.floor(run.createdAt / 1000),
    model: run.agentId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          refusal: null,
          tool_calls: pendingToolCalls(store, run.id),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: chatUsage(run) ?? undefined,
  };
}

/**
 * 流式：停车时依次发出（还没发过时）角色帧 `{role:"assistant",content:null}`、每个调用一帧
 * tool_calls 增量（`index` 从 0 起）、`finish_reason: "tool_calls"` 收尾帧、（请求了时）用量帧与
 * `[DONE]`。运行没有只在调用方工具上停车时返回 undefined。
 */
export function chatToolCallFrames(
  store: Store,
  runId: string,
  base: Record<string, unknown>,
  roleSent: boolean,
  includeUsage: boolean,
): string[] | undefined {
  const run = store.run(runId);
  if (!parkedOnCaller(store, run)) return undefined;
  const frame = (payload: Record<string, unknown>) =>
    `data: ${JSON.stringify({ ...base, ...payload })}\n\n`;
  const choice = (delta: Record<string, unknown>, finish: string | null = null) => ({
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    ...(roleSent ? [] : [frame(choice({ role: 'assistant', content: null }))]),
    ...pendingToolCalls(store, runId).map((call, index) =>
      frame(choice({ tool_calls: [{ index, ...call }] })),
    ),
    frame(choice({}, 'tool_calls')),
    ...(includeUsage ? [frame({ choices: [], usage: chatUsage(run) })] : []),
    'data: [DONE]\n\n',
  ];
}

// ---------------------------------------------------------------------------
// 与协议无关的续接，以及 Responses / Claude Messages 的渲染。
// ---------------------------------------------------------------------------

export type BridgeDialect = 'chat' | 'responses' | 'claude' | 'gemini';
export const bridgeDialect = (dialect: string): dialect is BridgeDialect =>
  dialect === 'chat' || dialect === 'responses' || dialect === 'claude' || dialect === 'gemini';

/**
 * 带着调用方工具结果回来的请求：找到停车的运行并续接。待办与协议无关：Chat 发起的运行可以用
 * Responses 回传，响应按这次请求的协议渲染。Responses 给了 `previous_response_id` 而它不是
 * `call_id` 所在的运行时按未命中处理（退回新请求的既有行为）。
 */
export function resumeBridged(
  kernel: Kernel,
  store: Store,
  principal: Principal,
  invocation: Invocation,
): { run: Run; cursor: number } | undefined {
  const results = invocation.client_results;
  if (!results?.length) return undefined;
  let prior: Run | undefined;
  try {
    const action = store.getApproval(results[0]!.call_id, principal.owner);
    prior = store.run(action.runId, principal.owner, visibleSubject(principal));
    kernel.authorize(principal, prior.agentId, 'invoke');
  } catch {
    return undefined;
  }
  if (prior.metadata['oaa.tool_boundary']) {
    const boundary = invocation.metadata['oaa.tool_boundary'];
    if (boundary && boundary !== prior.metadata['oaa.tool_boundary'])
      throw new Fault(
        'invalid_continuation',
        'Finish or cancel the pending caller tool before changing its execution location.',
        409,
      );
    if (
      invocation.model !== 'auto' &&
      invocation.model !== prior.route.id &&
      invocation.model !== prior.route.model
    )
      throw new Fault(
        'invalid_continuation',
        'Finish or cancel the pending caller tool before changing models.',
        409,
      );
  }
  if (invocation.previous_response_id) {
    try {
      const runId = store.getApproval(results[0]!.call_id, principal.owner).runId;
      if (runId !== invocation.previous_response_id) return undefined;
    } catch {
      return undefined;
    }
  }
  if (invocation.tool_choice?.mode === 'none' && prior.checkpoint.toolChoice?.mode !== 'none') {
    prior.checkpoint.toolChoice = { mode: 'none' };
    store.save(prior);
  }
  return kernel.resolveClientTools(principal, results);
}

/** 停车的调用方调用（参数同时给 JSON 字符串与对象）。 */
function pendingCalls(store: Store, runId: string) {
  return pendingToolCalls(store, runId).map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
    input: JSON.parse(call.function.arguments) as unknown,
  }));
}
const newText = (run: Run) =>
  run.output
    .slice(run.checkpoint.bridge?.delivered ?? 0)
    .map((m) => m.text)
    .join('\n\n');

/**
 * Responses：停车时 `status: "completed"`，`output` 先是本段新产生的 message 条目，再是每个调用
 * 一个 `function_call` 条目（`call_id` 是待办 ID），`metadata["oaa.status"] = "requires_action"`。
 */
export function bridgedResponseObject(store: Store, run: Run): Record<string, unknown> {
  const body = responseObject(run);
  const output = (body.output as unknown[]).slice(run.checkpoint.bridge?.delivered ?? 0);
  if (!parkedOnCaller(store, run)) return { ...body, output };
  return {
    ...body,
    status: 'completed',
    output: [
      ...output,
      ...pendingCalls(store, run.id).map((call) => ({
        type: 'function_call',
        id: `fc_${call.id.replace(/^call_/, '')}`,
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        status: 'completed',
      })),
    ],
    metadata: { ...(body.metadata as Record<string, string>), 'oaa.status': 'requires_action' },
  };
}

/**
 * Claude Messages：停车时 `content` 先是本段新文本的 text 块，再是每个调用一个 `tool_use` 块，
 * `stop_reason: "tool_use"`。`tool_use.id` 直接用待办 ID（`call_…`），不映射成 `toolu_` 前缀。
 */
export function bridgedClaudeObject(store: Store, run: Run): Record<string, unknown> {
  const text = newText(run);
  if (!parkedOnCaller(store, run)) {
    const body = claudeMessageObject(run) as { content: { text: string }[] };
    body.content[0]!.text = text;
    return body;
  }
  return claudeMessage(
    run.id,
    run.agentId,
    [
      ...(text ? [{ type: 'text', text }] : []),
      ...pendingCalls(store, run.id).map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    ],
    'tool_use',
    run.usage,
  );
}

export function bridgedObject(
  dialect: BridgeDialect,
  store: Store,
  run: Run,
): Record<string, unknown> {
  if (dialect === 'responses') return bridgedResponseObject(store, run);
  if (dialect === 'claude') return bridgedClaudeObject(store, run);
  if (dialect === 'gemini') return bridgedGeminiObject(store, run);
  return bridgedChatObject(store, run);
}

/**
 * Responses 流：停车时为每个调用依次发 `response.output_item.added`（arguments 为空串）、
 * `response.function_call_arguments.delta`、`.done`、`response.output_item.done`，最后
 * `response.completed`。`function_call_arguments.*` 只是线上帧，不是运行事件（不落盘，所以不在
 * core/events.ts 的事件目录里）。`sequence_number` 由 `nextSeq` 给出（该流已发出的最大值 + 1，见 docs/harness.md）。
 */
export function responsesToolCallFrames(
  store: Store,
  runId: string,
  nextSeq: () => number,
  /** A progress reasoning item already streamed at output_index 0 (docs/progress.md). */
  lead?: Record<string, unknown>,
): string[] | undefined {
  const run = store.run(runId);
  if (!parkedOnCaller(store, run)) return undefined;
  const body = bridgedResponseObject(store, run);
  if (lead) body.output = [lead, ...(body.output as unknown[])];
  const frames: string[] = [];
  const event = (type: string, data: Record<string, unknown>) => {
    const seq = nextSeq();
    frames.push(
      `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...data })}\n\n`,
    );
  };
  (body.output as Record<string, unknown>[]).forEach((item, output_index) => {
    if (item.type !== 'function_call') return;
    event('response.output_item.added', {
      output_index,
      item: { ...item, arguments: '', status: 'in_progress' },
    });
    event(`response.function_call_arguments.delta`, {
      item_id: item.id,
      output_index,
      delta: item.arguments,
    });
    event(`response.function_call_arguments.done`, {
      item_id: item.id,
      output_index,
      arguments: item.arguments,
    });
    event('response.output_item.done', { output_index, item });
  });
  event('response.completed', { response: body });
  return frames;
}

/**
 * Claude 流：停车时（还没发过时）补发 `message_start`；已打开的 text 块先 `content_block_stop`；
 * 每个调用 `content_block_start`（tool_use，input 为空对象）、一个 `input_json_delta`（完整 JSON）、
 * `content_block_stop`，index 依次递增；最后 `message_delta`（`stop_reason: "tool_use"`）与 `message_stop`。
 */
export function claudeToolCallFrames(
  store: Store,
  runId: string,
  /** Blocks so far: message_start sent, the open text block, the next free index (progress). */
  open: { started: boolean; textIndex?: number; next: number },
  model: string,
): string[] | undefined {
  const run = store.run(runId);
  if (!parkedOnCaller(store, run)) return undefined;
  const frame = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const frames =
    open.textIndex !== undefined
      ? [frame('content_block_stop', { index: open.textIndex })]
      : open.started
        ? []
        : [
            frame('message_start', {
              message: claudeMessage(runId, model, [], null, undefined),
            }),
            frame('ping', {}),
          ];
  const first = open.textIndex !== undefined ? open.textIndex + 1 : open.next;
  pendingCalls(store, runId).forEach((call, i) => {
    const index = first + i;
    frames.push(
      frame('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      }),
      frame('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: call.arguments },
      }),
      frame('content_block_stop', { index }),
    );
  });
  frames.push(
    frame('message_delta', {
      delta: claudeDelta('tool_use'),
      usage: claudeDeltaUsage(run.usage),
    }),
    frame('message_stop', {}),
  );
  return frames;
}

const geminiUsage = (run: Run) => ({
  promptTokenCount: run.usage?.input_tokens ?? 0,
  candidatesTokenCount: run.usage?.output_tokens ?? 0,
  totalTokenCount: run.usage?.total_tokens ?? 0,
});
const functionCallParts = (store: Store, runId: string) =>
  pendingCalls(store, runId).map((call) => ({
    functionCall: { id: call.id, name: call.name, args: call.input },
  }));

/**
 * Gemini：停车时 `candidates[0].content.parts` 先是本段新文本的 text part，再是每个调用一个
 * `functionCall` part（`args` 是对象，`id` 是待办 ID），`finishReason: "STOP"`（Gemini 的工具调用
 * 就以 STOP 结束）。`responseId` 是运行 ID，续接时不变。
 */
export function bridgedGeminiObject(store: Store, run: Run): Record<string, unknown> {
  const text = newText(run);
  if (!parkedOnCaller(store, run)) {
    const body = geminiResponseObject(run) as { candidates: { content: { parts: unknown[] } }[] };
    body.candidates[0]!.content.parts = [{ text }];
    return body;
  }
  return {
    responseId: run.id,
    modelVersion: `${run.agentId}@${run.route.model}`,
    candidates: [
      {
        index: 0,
        content: {
          role: 'model',
          parts: [...(text ? [{ text }] : []), ...functionCallParts(store, run.id)],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: geminiUsage(run),
  };
}

/**
 * Gemini 流：停车时一个分片给出全部 `functionCall` part（Gemini 不分片参数），同一分片带
 * `finishReason: "STOP"` 与 `usageMetadata`。已经流式发出的文本不重复。
 */
export function geminiToolCallChunk(
  store: Store,
  runId: string,
  modelVersion: string,
): string | undefined {
  const run = store.run(runId);
  if (!parkedOnCaller(store, run)) return undefined;
  return JSON.stringify({
    responseId: runId,
    modelVersion,
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: functionCallParts(store, runId) },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: geminiUsage(run),
  });
}
