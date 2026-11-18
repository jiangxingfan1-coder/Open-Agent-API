/**
 * 内核接收外部智能体（engine 不是 kernel）事件的入口约束。
 *
 * 外部智能体经由各接入方式送来的进度与审批数据形状各异、大小不受控；这里在落盘之前统一收口：
 * 进度只保留白名单字段并截断字符串，审批详情超过上限时不创建待审批项而是直接拒绝。
 * 内核工具自身的 `tool.progress`（callTool 里那条）不经过这里。
 */
import { AGENT_LIMITS } from '../core/limits.js';
import type { ArtifactPayload, Run } from '../core/contracts.js';
import { persistWorkerArtifact } from '../store/large-artifacts.js';
import { Fault, sha } from '../core/util.js';
import type { Store } from '../store/store.js';

/** 审批详情序列化后的字符数上限：与 adapter / ACP 接入层是同一个常量。 */
export const APPROVAL_DETAIL_CHARS = AGENT_LIMITS.approvalDetailChars;

/** 白名单字段及字符串截断长度。 */
const PROGRESS_FIELDS: Record<string, number> = {
  native: 240,
  adapter: 240,
  event: 40,
  kind: 40,
  tool: 160,
  tool_call_id: 240,
  title: 240,
  status: 40,
  state: 40,
  itemType: 240,
  model: 240,
  tool_count: 240,
  permission_mode: 240,
  agent: 240,
  version: 240,
  load_session: 240,
  resume_session: 240,
  content_type: 240,
  reason: 240,
  entries: 240,
};
/** 数组字段（如 `entries`）保留的条数；与 ACP 审批详情里 `locations` 的条数一致。 */
const ARRAY_ITEMS = 20;

const scalar = (value: unknown, max: number): unknown => {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
};

/**
 * 外部智能体的进度：只保留白名单字段；字符串截断，数字（有限值）、布尔与 null 保留，
 * 数组限制条数且只保留其中的标量，其它类型丢弃；最后加 `source: "agent"`。
 */
export function sanitizeProgress(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, max] of Object.entries(PROGRESS_FIELDS)) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    const kept = Array.isArray(value)
      ? value
          .slice(0, ARRAY_ITEMS)
          .map((item) => scalar(item, max))
          .filter((item) => item !== undefined)
      : scalar(value, max);
    if (kept !== undefined) out[key] = kept;
  }
  out.source = 'agent';
  return out;
}

/**
 * 审批详情过大（或无法序列化）时返回给接入层的拒绝与要记录的进度；未超限时返回 undefined。
 * owner 看不全的内容不发起审批——与 adapter / ACP 接入层「过大则拒绝」的处理一致。
 */
export function boundApprovalDetail(
  data: Record<string, unknown>,
): { decision: 'deny'; progress: Record<string, unknown> } | undefined {
  let size: number;
  try {
    size = JSON.stringify(data).length;
  } catch {
    size = Infinity;
  }
  if (size <= APPROVAL_DETAIL_CHARS) return undefined;
  return {
    decision: 'deny',
    progress: {
      ...(typeof data.native === 'string' ? { native: data.native } : {}),
      ...(typeof data.adapter === 'string' ? { adapter: data.adapter } : {}),
      event: 'permission_denied',
      reason: 'approval_too_large',
    },
  };
}

/**
 * 落盘一条 `tool.progress`（外部智能体的先经 sanitizeProgress）。落盘失败时返回
 * persistence_failed，由调用方记为本次运行的错误并中止——不把异常抛回接入层。
 */
export function recordProgress(
  store: Store,
  runId: string,
  data: Record<string, unknown>,
  external: boolean,
): Fault | undefined {
  try {
    store.emit(runId, 'tool.progress', external ? sanitizeProgress(data) : data);
    return undefined;
  } catch {
    return new Fault(
      'persistence_failed',
      'Progress could not be persisted. Execution was stopped.',
      500,
    );
  }
}

/**
 * 校验并落盘外部智能体交回的产物，返回文件 ID。任何一个摘要不符即报 artifact_integrity，
 * 调用方不得在此之前把步骤标记为完成。
 */
export async function storeNativeArtifacts(
  store: Store,
  run: Run,
  allowedNodes: Parameters<Store['addFile']>[3],
  artifacts: ArtifactPayload[] = [],
): Promise<string[]> {
  const ids: string[] = [];
  for (const artifact of artifacts) {
    const file = await persistWorkerArtifact(store, run.owner, run.id, artifact, allowedNodes);
    ids.push(file.id);
  }
  return ids;
}
