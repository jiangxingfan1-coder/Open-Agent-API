/**
 * Stream progress (docs/progress.md): a short, human-readable line for each phase of a run, built
 * from the run events that already exist. Lines never carry tool arguments, tool results, prompts,
 * internal identifiers or caller names; titles pass through `redact` and are cut to a short length.
 *
 * `summarize` is a pure function: it takes the event, the previous state and the locale and returns
 * the line (if any) plus the next state. The stream encoders (progress-stream.ts) only place the
 * line into each protocol's own "thinking / reasoning" shape.
 */
import type { Locale } from '../core/locale.js';
import { redact } from '../core/util.js';

export interface ProgressState {
  /** Tool name per step id (tool.started / completed / failed carry only the step id). */
  readonly tools: Readonly<Record<string, string>>;
  /** Execution has started once (the next `response.in_progress` is a resumption). */
  readonly started: boolean;
  /** The external agent already reported that it is thinking (said once until something else). */
  readonly thinking: boolean;
}

export const INITIAL_PROGRESS: ProgressState = { tools: {}, started: false, thinking: false };

export interface ProgressEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const TITLE_CHARS = 120;

/** A title or name safe to show: a string, secrets redacted, whitespace collapsed, length capped. */
export function safeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = redact(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text;
}

const code = (value: unknown) =>
  typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : undefined;

const ZH = {
  queued: () => '排队中：等待执行名额',
  queuedFair: () => '排队中：与其他运行轮流使用执行名额',
  requeued: () => '等待的事项已处理，重新排队',
  fallback: (to: string, why?: string) => `切换到备选智能体 ${to}${why ? `（原因：${why}）` : ''}`,
  start: () => '开始执行',
  resume: () => '继续执行',
  external: () => '交给智能体执行',
  tool: (name: string, effect?: string) => `调用工具 ${name}${effect ? `（${effect}）` : ''}`,
  read: () => '只读',
  write: () => '会修改数据',
  retry: (name: string, n?: string) => `重试工具 ${name}（第 ${n} 次）`,
  toolDone: (name: string) => `工具 ${name} 完成`,
  toolFailed: (name: string, why?: string) => `工具 ${name} 失败${why ? `（${why}）` : ''}`,
  cached: (name: string) => `工具 ${name} 使用了缓存结果`,
  agentTool: (title: string) => `智能体调用工具：${title}`,
  agentToolDone: (title: string) => `完成：${title}`,
  agentToolFailed: (title: string) => `失败：${title}`,
  thinking: () => '智能体正在思考…',
  plan: (n: string) => `智能体制定了计划（${n} 步）`,
  denied: () => '一项操作未获许可，已拒绝',
  autoAllowed: (title: string) => `按策略自动允许：${title}`,
  repair: (n: string) => `答案不符合要求的格式，退回修改（第 ${n} 轮）`,
  callerTool: (name: string) => `等待调用方执行工具 ${name}`,
  approval: (name: string) => `等待审批：需要所有者在控制台批准${name ? `「${name}」` : '这一步'}`,
  approved: () => '审批通过',
  autoApproved: () => '已按策略自动批准',
  rejected: () => '审批被拒绝',
  failover: () => '模型线路切换到备用线路',
  subagent: (name: string) => `委托子智能体 ${name}`,
  subagentDone: (name: string) => `子智能体 ${name} 完成`,
  subagentFailed: (name: string) => `子智能体 ${name} 失败`,
  workflow: (name: string, n?: string) => `开始工作流 ${name}${n ? `（${n} 步）` : ''}`,
  workflowDone: (name: string) => `工作流 ${name} 完成`,
  completed: () => '完成',
};

type Words = typeof ZH;

const EN: Words = {
  queued: () => 'Queued: waiting for an execution slot',
  queuedFair: () => 'Queued: taking turns with other runs for an execution slot',
  requeued: () => 'What it waited for is settled; back in the queue',
  fallback: (to, why) => `Switching to fallback agent ${to}${why ? ` (reason: ${why})` : ''}`,
  start: () => 'Started',
  resume: () => 'Resumed',
  external: () => 'Handed to the agent',
  tool: (name, effect) => `Calling tool ${name}${effect ? ` (${effect})` : ''}`,
  read: () => 'read-only',
  write: () => 'changes data',
  retry: (name, n) => `Retrying tool ${name} (attempt ${n})`,
  toolDone: (name) => `Tool ${name} finished`,
  toolFailed: (name, why) => `Tool ${name} failed${why ? ` (${why})` : ''}`,
  cached: (name) => `Tool ${name} used a cached result`,
  agentTool: (title) => `Agent tool call: ${title}`,
  agentToolDone: (title) => `Done: ${title}`,
  agentToolFailed: (title) => `Failed: ${title}`,
  thinking: () => 'The agent is thinking…',
  plan: (n) => `The agent made a plan (${n} steps)`,
  denied: () => 'An operation was not permitted and was refused',
  autoAllowed: (title) => `Allowed by policy: ${title}`,
  repair: (n) =>
    `The answer did not match the required format; sent back for correction (round ${n})`,
  callerTool: (name) => `Waiting for the caller to run tool ${name}`,
  approval: (name) =>
    `Waiting for approval: the owner must approve ${name ? `"${name}"` : 'this step'} in the console`,
  approved: () => 'Approved',
  autoApproved: () => 'Approved automatically by policy',
  rejected: () => 'Approval denied',
  failover: () => 'Switched to a backup model route',
  subagent: (name) => `Delegating to sub-agent ${name}`,
  subagentDone: (name) => `Sub-agent ${name} finished`,
  subagentFailed: (name) => `Sub-agent ${name} failed`,
  workflow: (name, n) => `Workflow ${name} started${n ? ` (${n} steps)` : ''}`,
  workflowDone: (name) => `Workflow ${name} finished`,
  completed: () => 'Done',
};

type Result = { line?: string; state: ProgressState };

/** External agent progress (`tool.progress` with `source: "agent"`, already sanitized). */
function agentLine(d: Readonly<Record<string, unknown>>, w: Words, state: ProgressState): Result {
  const event = d.event;
  if (event === 'thinking')
    return state.thinking ? { state } : { line: w.thinking(), state: { ...state, thinking: true } };
  const next = { ...state, thinking: false };
  if (event === 'tool' || (event === 'item' && d.kind === 'tool')) {
    const title = safeTitle(d.title) ?? safeTitle(d.tool) ?? safeTitle(d.itemType);
    if (!title) return { state: next };
    const status = String(d.status ?? d.state ?? '').toLowerCase();
    if (/fail|error|declined|cancel/.test(status))
      return { line: w.agentToolFailed(title), state: next };
    if (/complete|done|success|finish/.test(status))
      return { line: w.agentToolDone(title), state: next };
    return { line: w.agentTool(title), state: next };
  }
  if (event === 'plan' && typeof d.entries === 'number' && d.entries > 0)
    return { line: w.plan(String(d.entries)), state: next };
  if (event === 'permission_denied') return { line: w.denied(), state: next };
  if (event === 'permission_auto_allowed') {
    const title = safeTitle(d.tool);
    return title ? { line: w.autoAllowed(title), state: next } : { state: next };
  }
  return { state };
}

/** One run event to at most one progress line. Unknown or uninteresting events give no line. */
export function summarize(event: ProgressEvent, state: ProgressState, locale: Locale): Result {
  const w = locale === 'zh' ? ZH : EN;
  const d = event.data;
  const name = (stepId: unknown) =>
    (typeof stepId === 'string' ? state.tools[stepId] : undefined) ?? 'tool';
  switch (event.type) {
    case 'run.queued': {
      if (d.reason === 'agent_fallback') {
        const to = safeTitle(d.to);
        return to ? { line: w.fallback(to, code(d.error)), state } : { state };
      }
      if (d.reason === 'approval_resolved') return { line: w.requeued(), state };
      return { line: d.reason === 'fairness' ? w.queuedFair() : w.queued(), state };
    }
    case 'response.in_progress':
      return {
        line: state.started ? w.resume() : w.start(),
        state: { ...state, started: true },
      };
    case 'tool.queued': {
      const stepId = typeof d.step_id === 'string' ? d.step_id : '';
      if (stepId.startsWith('native_')) return { line: w.external(), state };
      const tool = safeTitle(d.tool) ?? 'tool';
      const effect = d.effect === 'read' ? w.read() : d.effect === 'write' ? w.write() : '';
      return {
        line: w.tool(tool, effect || undefined),
        state: { ...state, tools: { ...state.tools, [stepId]: tool } },
      };
    }
    case 'tool.started': {
      const attempt = Number(d.attempt);
      if (!Number.isSafeInteger(attempt) || attempt < 2 || !state.tools[String(d.step_id)])
        return { state };
      return { line: w.retry(name(d.step_id), String(attempt)), state };
    }
    case 'tool.completed':
      return state.tools[String(d.step_id)]
        ? { line: w.toolDone(name(d.step_id)), state }
        : { state };
    case 'tool.failed':
      return state.tools[String(d.step_id)]
        ? { line: w.toolFailed(name(d.step_id), code(d.code)), state }
        : { state };
    case 'tool.cached':
      return state.tools[String(d.step_id)]
        ? { line: w.cached(name(d.step_id)), state }
        : { state };
    case 'tool.progress':
      if (d.source === 'agent') return agentLine(d, w, state);
      if (d.event === 'output_repair' && typeof d.round === 'number')
        return { line: w.repair(String(d.round)), state };
      return { state };
    case 'run.requires_action': {
      const approval = (d.approval ?? {}) as Record<string, unknown>;
      const detail = (approval.detail ?? {}) as Record<string, unknown>;
      const title = safeTitle(detail.tool) ?? safeTitle(detail.title);
      if (approval.kind === 'client_tool') return { line: w.callerTool(title ?? 'tool'), state };
      return { line: w.approval(title ?? ''), state };
    }
    case 'approval.resolved':
      if (d.decision === 'deny') return { line: w.rejected(), state };
      return { line: d.actor === 'policy:auto' ? w.autoApproved() : w.approved(), state };
    case 'route.failover':
      return { line: w.failover(), state };
    case 'subagent.started':
    case 'subagent.completed':
    case 'subagent.failed': {
      const agent = safeTitle(d.target_agent);
      if (!agent) return { state };
      const say =
        event.type === 'subagent.started'
          ? w.subagent
          : event.type === 'subagent.completed'
            ? w.subagentDone
            : w.subagentFailed;
      return { line: say(agent), state };
    }
    case 'workflow.started':
    case 'workflow.completed': {
      const flow = safeTitle(d.workflow);
      if (!flow) return { state };
      return event.type === 'workflow.started'
        ? {
            line: w.workflow(
              flow,
              typeof d.step_count === 'number' ? String(d.step_count) : undefined,
            ),
            state,
          }
        : { line: w.workflowDone(flow), state };
    }
    case 'response.completed':
      return { line: w.completed(), state };
    default:
      return { state };
  }
}

export type ProgressMode = 'off' | 'reasoning';
export const PROGRESS_MODES: readonly ProgressMode[] = ['off', 'reasoning'];
