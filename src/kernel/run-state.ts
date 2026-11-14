import { zeroUsage, type RunStatus, type Usage } from '../core/contracts.js';
import { sha } from '../core/util.js';
import type { RunEventType } from '../core/events.js';

export interface FailureInput {
  fault: {
    code: string;
    message: string;
    uncertain?: boolean;
  };
  closing: boolean;
  timedOut: boolean;
  aborted: boolean;
  hadEventError: boolean;
}

export interface FailureClassification {
  status: 'interrupted' | 'incomplete' | 'cancelled' | 'failed';
  error: {
    code: string;
    message: string;
  };
}

export interface FailureRule {
  name: string;
  match: (input: FailureInput) => boolean;
  produce: (input: FailureInput) => FailureClassification;
}

// 规则按优先级从上到下匹配，取第一条命中的。注意：只要运行已经超时，错误码一律是
// run_timeout（即使状态由前两条规则判为 interrupted），这与重构前的行为一致。
export const FAILURE_RULES: readonly FailureRule[] = [
  // 1. 副作用操作未确认结果：标记为中断，改写错误码为 effect_outcome_unknown
  {
    name: 'uncertain_effect',
    match: (input) => Boolean(input.fault.uncertain),
    produce: (input) => ({
      status: 'interrupted',
      error: {
        code: input.timedOut ? 'run_timeout' : 'effect_outcome_unknown',
        message:
          'A side-effecting operation has no confirmed outcome. Reconcile its step before resuming.',
      },
    }),
  },
  // 2. 节点正在关闭或 Provider 状态不匹配/不支持：标记为可恢复的中断
  {
    name: 'closing_or_provider_mismatch',
    match: (input) =>
      input.closing ||
      ['node_draining', 'provider_state_mismatch', 'provider_state_unsupported'].includes(
        input.fault.code,
      ),
    produce: (input) => ({
      status: 'interrupted',
      error: {
        code: input.timedOut ? 'run_timeout' : input.fault.code,
        message: input.fault.message,
      },
    }),
  },
  // 3. 运行超时：标记为未完成，错误码改写为 run_timeout
  {
    name: 'timed_out',
    match: (input) => input.timedOut,
    produce: (input) => ({
      status: 'incomplete',
      error: {
        code: 'run_timeout',
        message: input.fault.message,
      },
    }),
  },
  // 4. 控制器信号中止且无事件错误：标记为已取消
  {
    name: 'aborted',
    match: (input) => input.aborted && !input.hadEventError,
    produce: (input) => ({
      status: 'cancelled',
      error: {
        code: input.fault.code,
        message: input.fault.message,
      },
    }),
  },
  // 5. 达到轮数限制、Token 预算耗尽或模型输出截断：标记为未完成
  {
    name: 'resource_limit',
    match: (input) =>
      ['turn_limit', 'token_budget', 'max_output_tokens'].includes(input.fault.code),
    produce: (input) => ({
      status: 'incomplete',
      error: {
        code: input.fault.code,
        message: input.fault.message,
      },
    }),
  },
  // 6. 其他未分类的执行错误：兜底标记为失败
  {
    name: 'fallback_failed',
    match: () => true,
    produce: (input) => ({
      status: 'failed',
      error: {
        code: input.fault.code,
        message: input.fault.message,
      },
    }),
  },
];

/**
 * 纯函数：根据失败现场状态与错误特征，依据优先级规则表归类运行终态和错误对象。
 */
export function classifyFailure(input: FailureInput): FailureClassification {
  for (const rule of FAILURE_RULES) {
    if (rule.match(input)) {
      return rule.produce(input);
    }
  }
  return {
    status: 'failed',
    error: {
      code: input.fault.code,
      message: input.fault.message,
    },
  };
}

/**
 * 计算步骤 ID，保证三处步骤计算完全一致。
 */
export function stepIdFor(runId: string, turn: number, callId: string): string {
  return `step_${sha(`${runId}:${turn}:${callId}`).slice(0, 32)}`;
}

/**
 * 累加运行所消耗的 Token 统计。
 */
export function addUsage(run: { usage?: Usage | null }, usage?: Usage | null): void {
  if (!usage) return;
  run.usage ??= zeroUsage();
  run.usage.input_tokens += usage.input_tokens;
  run.usage.output_tokens += usage.output_tokens;
  run.usage.total_tokens += usage.total_tokens;
}

/**
 * 映射运行终态对应的事件名称。
 */
export function terminalEventType(status: RunStatus | string): RunEventType {
  // 调用方只传终态（completed / failed / cancelled / incomplete / interrupted）。
  return (status === 'interrupted' ? 'response.incomplete' : `response.${status}`) as RunEventType;
}

// 运行状态机定义在 core/（存储层落盘前要用它校验），这里再导出给内核。
export {
  RUN_TRANSITIONS,
  FINAL_STATUSES,
  canTransition,
  assertTransition,
  phaseConsistent,
} from '../core/run-status.js';
