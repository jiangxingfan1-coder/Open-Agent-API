/**
 * 调用方工具桥接（docs/harness.md「bridge」）：内核里与调用方工具有关的纯逻辑。
 *
 * - submit：`prepareBridge` 检查名字、冲突、数量与参数 schema，返回要登记进检查点的 `bridge`。
 * - 模型轮次：`withClientBindings` 用合成绑定（`handler: node client/<别名>`）拼出交给执行节点的
 *   智能体副本；可用性判断仍用原始智能体。
 * - 工具阶段：`clientToolCall` 把调用方工具的调用落成 `pending` 步骤与 `client_tool` 待办，抛出
 *   `ApprovalSuspension`，与需要审批的工具走同一条停车路径；回传后以调用方给的结果完成步骤。
 * - 续接：`resolveClientResults` 校验归属后把结果写进待办，由内核沿用「批准后重新入场」。
 * - 外部智能体（ACP，经 MCP 中继）：`awaitCallerTool` 在进程内等待待办解决（内层进程保持存活），
 *   新待办出现后合并发出 `run.awaiting_caller`；续接时不重新入场，等待中的调用被事件唤醒。
 */
import type {
  AgentDefinition,
  Checkpoint,
  ClientTool,
  Principal,
  Run,
  ToolBinding,
  ToolCall,
} from '../core/contracts.js';
import { capabilitySchema, terminal, visibleSubject } from '../core/contracts.js';
import { JsonSchemas } from '../core/schemas.js';
import { ApprovalSuspension } from '../core/suspension.js';
import { Fault, boundedJson, checkAbort, id } from '../core/util.js';
import type { Approval, Store } from '../store/store.js';
import { assertClientToolsSupported, requestedClientToolsMode } from './harness.js';
import type { Invocation } from './invocation.js';
import { stepIdFor } from './run-state.js';

const schemas = new JsonSchemas();
const CLIENT_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOLS = 100;

/** 内部别名：`-` 换成 `_`，首字符不是字母时加前缀 `t_`。对外渲染一律用原名。 */
export function clientToolAlias(name: string): string {
  const alias = name.replaceAll('-', '_');
  return /^[a-zA-Z]/.test(alias) ? alias : `t_${alias}`;
}

/** 请求是否要桥接调用方工具（submit 据此只考虑声明了 client-tools-v1 的执行机器）。 */
export function bridgeRequested(invocation: Invocation): boolean {
  return (
    requestedClientToolsMode(invocation.metadata) === 'bridge' && !!invocation.client_tools?.length
  );
}

/** submit：桥接运行没有可用的执行机器，且原因是没有机器声明 client-tools-v1 时报 400。 */
export function assertBridgePlaced(reasons: { code: string }[]): void {
  if (reasons.some((r) => r.code === 'client_tools_unsupported'))
    throw new Fault(
      'client_tools_bridge_unsupported',
      'No online worker can bridge caller tools for this agent (client-tools-v1: the kernel, or an ACP adapter). Upgrade the worker, or use X-OAA-Client-Tools: managed instead.',
    );
}

/**
 * submit 阶段（任何执行之前）：不能桥接的外部智能体请求 bridge 报 `client_tools_bridge_unsupported`；
 * 检查调用方工具，返回要写进检查点的 `bridge`。不是桥接请求时返回 undefined。外部智能体
 * （`adapter/<name>`）没有已发布的工具，名字只需满足命名规则且互不重复，不做别名。
 */
export function prepareBridge(
  agent: AgentDefinition,
  invocation: Invocation,
): Checkpoint['bridge'] | undefined {
  const mode = requestedClientToolsMode(invocation.metadata);
  assertClientToolsSupported(agent, mode);
  const tools = invocation.client_tools;
  if (mode !== 'bridge') return undefined;
  if (!tools?.length)
    throw new Fault(
      'client_tools_bridge_unsupported',
      'Bridge mode needs caller tools from Chat Completions, Responses or Claude Messages. Use X-OAA-Client-Tools: managed instead.',
    );
  const external = agent.engine !== 'kernel';
  const published = external ? 0 : agent.tools.length;
  const taken = new Set<string>(
    external
      ? []
      : [
          ...agent.tools.map((t) => t.name),
          ...(agent.workflows ?? []).map((w) => w.name),
          ...(agent.delegates ?? []).map((d) => d.name),
          'execute_graph',
        ],
  );
  for (const tool of tools) {
    if (!CLIENT_TOOL_NAME.test(tool.name))
      throw new Fault(
        'invalid_client_tool',
        `Caller tool name '${tool.name.slice(0, 80)}' must match ^[a-zA-Z0-9_-]{1,64}$.`,
      );
    const alias = external ? tool.name : clientToolAlias(tool.name);
    if (alias.length > 64)
      throw new Fault('invalid_client_tool', `Caller tool name '${tool.name}' is too long.`);
    if (taken.has(alias))
      throw new Fault(
        'client_tool_conflict',
        `Caller tool '${tool.name}' conflicts with a published tool, workflow, delegate or another caller tool.`,
      );
    taken.add(alias);
    try {
      schemas.compile(tool.parameters);
    } catch {
      throw new Fault(
        'invalid_client_tool',
        `The parameters schema of caller tool '${tool.name}' cannot be compiled.`,
      );
    }
  }
  if (published + tools.length > MAX_TOOLS)
    throw new Fault(
      'client_tools_too_many',
      `Published tools plus caller tools exceed ${MAX_TOOLS} (${published} + ${tools.length}).`,
    );
  return { tools: tools.map((t) => ({ ...t })), delivered: 0 };
}

function bindingFor(tool: ClientTool): ToolBinding {
  const alias = clientToolAlias(tool.name);
  return {
    name: alias,
    capability: capabilitySchema.parse({
      id: `client/${alias}`,
      version: '1',
      description: (tool.description ?? `Caller tool ${tool.name}`).slice(0, 4000),
      placement: 'portable',
      effect: 'unknown',
      inputSchema: tool.parameters,
    }),
    handler: { kind: 'node', reference: `client/${alias}` },
  };
}

/** 交给执行节点的智能体副本与本轮工具名：已发布工具（按可用性筛过）+ 调用方工具。 */
export function withClientBindings(
  agent: AgentDefinition,
  toolNames: string[],
  bridge: Checkpoint['bridge'],
): { agent: AgentDefinition; toolNames: string[] } {
  if (!bridge?.tools.length) return { agent, toolNames };
  const bindings = bridge.tools.map(bindingFor);
  return {
    agent: { ...agent, tools: [...agent.tools, ...bindings] },
    toolNames: [...toolNames, ...bindings.map((b) => b.name)],
  };
}

/**
 * 调用方回传的结果（字符串）。写回对话时：能解析成 JSON 对象或数组就按解析后的值写回，否则按
 * 原字符串写回、不加引号。只用于调用方工具；已发布工具的结果照旧经 `boundedJson`。
 */
export class CallerOutput {
  constructor(readonly output: unknown) {}
}
/** 工具阶段把结果写回对话：调用方结果按上面的规则，其余照旧 `boundedJson`。 */
export function toolMessageContent(value: unknown): string {
  if (!(value instanceof CallerOutput)) return boundedJson(value);
  const output = value.output;
  if (typeof output !== 'string') return boundedJson(output);
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === 'object') return boundedJson(parsed);
  } catch {
    // 不是 JSON：按原字符串写回。
  }
  boundedJson(output); // 同样的大小上限
  return output;
}

const timeoutFault = () =>
  new Fault('client_tool_timeout', 'The caller did not return the tool result in time.', 409);

/**
 * 工具阶段：不是调用方工具返回 undefined；否则返回这次调用的结果，或抛出 `ApprovalSuspension`
 * 停车等待调用方。参数不符合调用方 schema 时，把校验错误作为结果交回模型，而不是让运行失败。
 */
export function clientToolCall(
  store: Store,
  run: Run,
  call: ToolCall,
  timeoutMs: number,
): { value: unknown } | undefined {
  const tool = run.checkpoint.bridge?.tools.find((t) => clientToolAlias(t.name) === call.name);
  if (!tool) return undefined;
  const stepId = stepIdFor(run.id, run.checkpoint.turn, call.id);
  const step = store.getStep(stepId);
  if (step?.status === 'completed') return { value: new CallerOutput(step.result?.value) };
  const action = store
    .approvals(run.id)
    .findLast((a) => a.kind === 'client_tool' && a.stepId === stepId);
  if (action?.status === 'approved' && step) {
    const value = action.response?.output;
    step.status = 'completed';
    step.result = { value };
    delete step.error;
    store.step(step, {
      type: 'tool.completed',
      data: { step_id: stepId, node_id: 'caller', artifacts: [] },
    });
    return { value: new CallerOutput(value) };
  }
  if (action?.status === 'pending' && Date.now() < action.expiresAt)
    throw new ApprovalSuspension([action.id]);
  if (action) throw timeoutFault();
  if (!schemas.validate(tool.parameters, call.arguments))
    return { value: { error: 'invalid_arguments', detail: schemas.errorsText() } };
  store.step(
    {
      id: stepId,
      runId: run.id,
      callId: call.id,
      name: tool.name,
      effect: 'unknown',
      status: 'pending',
      arguments: call.arguments,
    },
    { type: 'tool.queued', data: { step_id: stepId, tool: tool.name, effect: 'unknown' } },
  );
  const approval: Approval = {
    id: id('call'),
    runId: run.id,
    owner: run.owner,
    stepId,
    kind: 'client_tool',
    detail: { tool: tool.name, arguments: call.arguments, model_call_id: call.id },
    status: 'pending',
    expiresAt: Date.now() + timeoutMs,
  };
  store.approval(approval);
  run.status = 'requires_action';
  store.checkpoint(run, [{ type: 'run.requires_action', data: { approval } }]);
  throw new ApprovalSuspension([approval.id]);
}

const awaitingScheduled = new Set<string>();
/**
 * 新的调用方待办出现后，在下一个事件循环发出一次 `run.awaiting_caller`（载荷为此刻全部 pending
 * 的 `client_tool` 待办），同一时刻到达的并行调用因此一次给全。
 */
function announceAwaiting(store: Store, runId: string): void {
  if (awaitingScheduled.has(runId)) return;
  awaitingScheduled.add(runId);
  setImmediate(() => {
    awaitingScheduled.delete(runId);
    try {
      if (terminal(store.run(runId).status)) return;
      const ids = store
        .approvals(runId)
        .filter((a) => a.kind === 'client_tool' && a.status === 'pending')
        .map((a) => a.id);
      if (ids.length) store.emit(runId, 'run.awaiting_caller', { approval_ids: ids });
    } catch {
      // 运行已不存在或存储已关闭：没有调用方可交付。
    }
  });
}

export type CallerToolAnswer = { output: string } | { error: string };
/**
 * 外部智能体（经 MCP 中继）调用了调用方工具：校验后登记步骤与 `client_tool` 待办，运行进入
 * `requires_action`，在进程内等待调用方回传（内层进程保持存活）。名字不在登记的工具里、参数
 * 不符合调用方 schema 时直接把错误交回智能体，不创建待办。超时抛 `client_tool_timeout`。
 */
export async function awaitCallerTool(
  rt: { store: Store; limits: { approvalTimeoutMs: number } },
  run: Run,
  data: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallerToolAnswer> {
  checkAbort(signal);
  const store = rt.store;
  const name = typeof data.name === 'string' ? data.name : '';
  const tool = run.checkpoint.bridge?.tools.find((t) => t.name === name);
  if (!tool) return { error: `Unknown caller tool '${name.slice(0, 80)}'.` };
  const args = data.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return { error: 'invalid_arguments: arguments must be an object.' };
  if (!schemas.validate(tool.parameters, args))
    return { error: `invalid_arguments: ${schemas.errorsText()}` };
  const callId =
    typeof data.relay_call_id === 'string' && data.relay_call_id
      ? data.relay_call_id.slice(0, 160)
      : id('relay');
  const stepId = stepIdFor(run.id, run.checkpoint.turn, callId);
  const arguments_ = args as Record<string, unknown>;
  store.step(
    {
      id: stepId,
      runId: run.id,
      callId,
      name: tool.name,
      effect: 'unknown',
      status: 'pending',
      arguments: arguments_,
    },
    { type: 'tool.queued', data: { step_id: stepId, tool: tool.name, effect: 'unknown' } },
  );
  const approval: Approval = {
    id: id('call'),
    runId: run.id,
    owner: run.owner,
    stepId,
    kind: 'client_tool',
    detail: { tool: tool.name, arguments: arguments_, relay_call_id: callId },
    status: 'pending',
    expiresAt: Date.now() + rt.limits.approvalTimeoutMs,
  };
  store.approval(approval);
  run.status = 'requires_action';
  store.checkpoint(run, [{ type: 'run.requires_action', data: { approval } }]);
  announceAwaiting(store, run.id);
  return await new Promise<CallerToolAnswer>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      store.events.off(`approval:${approval.id}`, check);
      signal.removeEventListener('abort', check);
    };
    const finish = (
      status: 'completed' | 'failed',
      value?: unknown,
      code: 'client_tool_timeout' | 'client_tool_abandoned' = 'client_tool_timeout',
    ) => {
      // 续接时 `resolveClientResults` 推进了已落盘的 delivered：带回进程内的运行对象。
      const stored = store.run(run.id).checkpoint.bridge;
      if (run.checkpoint.bridge && stored)
        run.checkpoint.bridge.delivered = Math.max(
          run.checkpoint.bridge.delivered,
          stored.delivered,
        );
      const step = store.getStep(stepId);
      if (step) {
        step.status = status;
        if (status === 'completed') step.result = { value };
        else step.error = code;
        store.step(
          step,
          status === 'completed'
            ? {
                type: 'tool.completed',
                data: { step_id: stepId, node_id: 'caller', artifacts: [] },
              }
            : {
                type: 'tool.failed',
                data: { step_id: stepId, code, uncertain: false },
              },
        );
      }
      if (!terminal(run.status)) {
        run.status = store.approvals(run.id).some((a) => a.status === 'pending')
          ? 'requires_action'
          : 'in_progress';
        store.save(run);
      }
    };
    const check = () => {
      if (settled) return;
      try {
        checkAbort(signal);
        const current = store.getApproval(approval.id, run.owner);
        if (current.status === 'pending' && Date.now() < approval.expiresAt) return arm();
        settled = true;
        cleanup();
        if (current.status === 'approved') {
          const output = String(current.response?.output ?? '');
          finish('completed', output);
          resolve({ output });
          return;
        }
        if (current.status === 'expired' && current.response?.abandoned === true) {
          finish('failed', undefined, 'client_tool_abandoned');
          resolve({ error: 'The agent abandoned this caller tool call.' });
          return;
        }
        if (current.status === 'pending') {
          current.status = 'expired';
          store.approval(current);
        }
        finish('failed');
        reject(timeoutFault());
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    // 计时器可能比 `Date.now()` 早到（单调时钟与墙上时钟不同步）：没到期就重新计时，不能停住。
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(check, Math.max(1, approval.expiresAt - Date.now()));
    };
    store.events.on(`approval:${approval.id}`, check);
    signal.addEventListener('abort', check, { once: true });
    check();
  });
}

/**
 * 中继报告外部智能体放弃了仍在等待的调用（到中继的套接字断开）：把对应的待办标为过期并记下
 * `abandoned`，`awaitCallerTool` 的等待随之以 `client_tool_abandoned` 结束这一步，运行继续。
 * 找不到（已回传、已过期或不是这个运行的调用）时什么也不做。
 */
export function abandonCallerTool(store: Store, run: Run, relayCallId: unknown): void {
  if (typeof relayCallId !== 'string' || !relayCallId) return;
  const action = store
    .approvals(run.id)
    .find(
      (a) =>
        a.kind === 'client_tool' &&
        a.status === 'pending' &&
        a.detail.relay_call_id === relayCallId.slice(0, 160),
    );
  if (!action) return;
  action.status = 'expired';
  action.response = { abandoned: true };
  store.approval(action);
}

/** 挂起的待办过期时运行结束用的错误码：调用方工具是 `client_tool_timeout`，其余照旧。 */
export function parkedExpiry(actions: Approval[]): [string, string] {
  return actions.some(
    (a) => a.kind === 'client_tool' && (a.status === 'expired' || a.status === 'pending'),
  )
    ? ['client_tool_timeout', 'The caller did not return the tool result in time.']
    : ['approval_expired', 'Approval deadline expired.'];
}

/**
 * 续接：按 `call_id` 找到调用方工具的待办并写入结果。要求同一 owner、调用方能看到该运行（同一
 * 数据分区，或 owner 级可见）、对该智能体有 `invoke` 权限、全部属于同一个运行。任何一条不满足都
 * 整体返回 undefined，且不区分「不存在」与「不属于你」。
 *
 * 待办已不是 pending（调用方重试了同一次请求）时不改写结果，返回同一个运行与当初的游标。
 * 写入了新结果时经 `hooks.wake` 唤醒停车的运行（沿用「批准后重新入场」）。
 */
export type ClientResult = { call_id: string; output: string };
export function resolveClientResults(
  store: Store,
  principal: Principal,
  results: ClientResult[],
  hooks: { authorize: (agentId: string) => void; wake: (runId: string) => void },
): { run: Run; cursor: number } | undefined {
  if (!results.length || new Set(results.map((r) => r.call_id)).size !== results.length) return;
  let run: Run;
  const actions: Approval[] = [];
  try {
    for (const r of results) actions.push(store.getApproval(r.call_id, principal.owner));
    const runId = actions[0]!.runId;
    if (actions.some((a) => a.runId !== runId || a.kind !== 'client_tool')) return;
    run = store.run(runId, principal.owner, visibleSubject(principal));
    hooks.authorize(run.agentId);
  } catch {
    return;
  }
  if (actions.some((a) => a.status !== 'pending' && a.status !== 'approved')) return;
  const pending = actions.filter((a) => a.status === 'pending');
  if (!pending.length)
    return { run, cursor: Math.min(...actions.map((a) => Number(a.response?.cursor ?? 0))) };
  if (
    terminal(run.status) ||
    run.status !== 'requires_action' ||
    pending.some((a) => Date.now() >= a.expiresAt)
  )
    return;
  // 宁可重复交付，不可丢失：停车时不推进 delivered，到续接时才推进到停车那一刻的输出条数。
  if (run.checkpoint.bridge) {
    run.checkpoint.bridge.delivered = run.output.length;
    store.save(run);
  }
  const before = store.lastEventId(run.id);
  for (const a of pending) {
    a.status = 'approved';
    a.response = { output: results.find((r) => r.call_id === a.id)!.output, cursor: before };
    store.approval(a, {
      type: 'approval.resolved',
      data: { approval_id: a.id, decision: 'approve', actor: principal.name, kind: 'client_tool' },
    });
  }
  const cursor = store.lastEventId(run.id);
  hooks.wake(run.id);
  return { run: store.run(run.id), cursor };
}
