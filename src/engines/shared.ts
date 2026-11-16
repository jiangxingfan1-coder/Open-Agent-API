/**
 * 各接入方式（内置原生、ACP、A2A、oaa/1 适配器）共用的事件回调类型、上限与小工具。
 *
 * 数值与引入前各文件里的写法完全一致；改动任何一项都会改变线上行为，需要单独评审。
 */
import type { WorkEvent, Usage, ArtifactPayload } from '../core/contracts.js';
import { AGENT_LIMITS } from '../core/limits.js';
import { bi } from '../core/locale.js';
import { Fault, redact } from '../core/util.js';

/** 接入层向内核（经由执行节点）报告文本、进度与审批的回调；审批时返回 owner 的决定。 */
export type Emit = (event: WorkEvent) => Promise<Record<string, unknown> | void>;

export type NativeResult = {
  text: string;
  nativeState: Record<string, unknown>;
  usage: Usage | null;
  artifacts?: ArtifactPayload[];
};

export const AGENT_IO_LIMITS = {
  /** 一轮输出文本的字符数（超出报 output_too_large）；与内核输出写入器是同一个上限。 */
  textChars: AGENT_LIMITS.outputTextChars,
  /** 审批详情序列化后的字符数：owner 看不全的内容不发起审批，直接拒绝。 */
  approvalDetailChars: AGENT_LIMITS.approvalDetailChars,
  /** ACP 的单帧、A2A 的整条流的字节数。 */
  frameBytes: 8 * 1024 * 1024,
  /** oaa/1 HTTP 适配器响应体的字节数。 */
  adapterHttpBytes: 2_097_152,
} as const;

/** 只接受普通对象，其它（数组、null、原始值）一律当作空对象。 */
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** 字符串截断到 `max` 字符；不是字符串时为 null。 */
export const bounded = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? value.slice(0, max) : null;

/**
 * 发出一个事件而不等待它；回调失败（落盘失败、内核拒绝等）时把错误交给 `onError`，
 * 由调用方结束本轮——不会留下未处理的 Promise 拒绝。
 */
export const safeEmit = (emit: Emit, event: WorkEvent, onError: (error: unknown) => void): void => {
  void emit(event).catch(onError);
};

/** 智能体自报的失败原因（如 Claude Code 结果消息里的文本）带进错误消息时的字符数上限。 */
const FAILURE_REASON_CHARS = 240;
/** 能识别为「未登录 / 凭据无效」的失败原因（大小写不敏感）。 */
const AUTH_HINTS = ['not logged in', 'please run /login', 'invalid api key', 'authentication'];

/**
 * 外部智能体报告失败时的错误：原因先脱敏、再限长后带进消息；原因能识别为未登录时归为
 * `adapter_auth_required`（503），否则为 `native_incomplete`（502）。
 */
export function agentFailure(agent: string, reason: unknown): Fault {
  const text = typeof reason === 'string' ? reason.trim() : '';
  const shown = redact(text).slice(0, FAILURE_REASON_CHARS);
  const lower = text.toLowerCase();
  if (AUTH_HINTS.some((hint) => lower.includes(hint)))
    return new Fault(
      'adapter_auth_required',
      bi(
        `${agent} 要求先完成认证：${shown}。请在它自己的 CLI 中登录后重试；OAA 不会代为认证或保存凭据。`,
        `${agent} requires authentication: ${shown}. Sign in through its own CLI and retry; OAA never signs in or stores credentials on its behalf.`,
      ),
      503,
    );
  return new Fault(
    'native_incomplete',
    `${agent} did not complete successfully${shown ? `: ${shown}` : '.'}`,
    502,
  );
}
