/**
 * 事件目录：运行事件（`RunEvent.type`）的全部类型。
 *
 * 事件由 store 在与检查点同一个事务里写入；写入入口（`store.emit`、`EventInput.type`）只接受这里登记的
 * 类型。读出的 `RunEvent.type` 仍是 string（数据库里的历史数据不受这里约束）。新增事件先在这里登记，
 * 再在 docs/protocol.md 写明 `type` 与 `data`；已有事件的字段只能新增，不能改名或删除。
 */
export const RUN_EVENT_TYPES = [
  // —— 对外的 Responses 事件（兼容流、SSE 原样转发） ——
  /** 运行已创建。data: { response }（responseObject 快照） */
  'response.created',
  /** 运行开始或恢复执行。data: { response } */
  'response.in_progress',
  /** 新的输出消息开始。data: { output_index, item } */
  'response.output_item.added',
  /** 输出消息里新的内容片段开始。data: { item_id, output_index, content_index, part } */
  'response.content_part.added',
  /** 输出文本增量。data: { item_id, output_index, content_index, delta } */
  'response.output_text.delta',
  /** 一段输出文本结束。data: { output_index, content_index, text } */
  'response.output_text.done',
  /** 内容片段结束。data: { output_index, content_index, part } */
  'response.content_part.done',
  /** 输出消息结束。data: { output_index, item } */
  'response.output_item.done',
  /** 终态：完成。data: { response } */
  'response.completed',
  /** 终态：失败。data: { response }（response.error 带错误码） */
  'response.failed',
  /** 终态：取消。data: { response } */
  'response.cancelled',
  /** 终态：未完整完成（含 interrupted 状态对应的终止事件）。data: { response } */
  'response.incomplete',

  // —— 运行生命周期 ——
  /** 进入队列等待执行槽位。data: { reason, phase?, from?, to?, error? }（reason 如 fairness、approval_resolved、agent_fallback） */
  'run.queued',
  /** 让出执行槽位，等待审批等外部条件。data: { reason, approval_ids? } */
  'run.parked',
  /** 需要人处理（审批）。data: { approval } */
  'run.requires_action',
  /**
   * 外部智能体的桥接运行在等调用方执行工具（进程内等待，不让出槽位）：新的调用方待办出现后于下一个
   * 事件循环发出一次。data: { approval_ids }（此刻全部 pending 的 client_tool 待办）
   */
  'run.awaiting_caller',
  /** 运行中断（网关重启、结果未知等）。data: { error } */
  'run.interrupted',

  // —— 审批与步骤 ——
  /** 审批已处理。data: { approval_id, decision, actor } */
  'approval.resolved',
  /** 人工核对了不确定的步骤。data: { step_id, outcome, actor, evidence } */
  'step.reconciled',

  // —— 工具 ——
  /** 工具步骤排队。data: { step_id, tool, effect } */
  'tool.queued',
  /** 工具步骤开始一次尝试。data: { step_id, node_id, attempt } */
  'tool.started',
  /** 工具执行进度（由执行节点上报）。data：执行节点给出的进度载荷 */
  'tool.progress',
  /** 工具步骤完成。data: { step_id, node_id, artifacts } */
  'tool.completed',
  /** 工具步骤失败。data: { step_id, code, uncertain } */
  'tool.failed',
  /** 工具结果命中缓存，未重新执行。data: { step_id } */
  'tool.cached',
  /** 部分工具当前不可用。data: { tools: [{ name, reasons }] } */
  'tools.unavailable',

  // —— 路由、工作流与子智能体 ——
  /** 模型路由故障转移。data: { from_route, from_model, to_route, to_model, reason, attempt } */
  'route.failover',
  /** 工作流开始。data: { workflow, call_id, step_count } */
  'workflow.started',
  /** 工作流完成。data: { workflow, call_id } */
  'workflow.completed',
  /** 委托子智能体开始。data: { step_id, delegate, target_agent, depth } */
  'subagent.started',
  /** 子智能体完成。data: { step_id, child_run_id, target_agent, selected_model, artifacts } */
  'subagent.completed',
  /** 子智能体失败。data: { step_id, child_run_id?, code } */
  'subagent.failed',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** 运行到达终点时写入的事件：四个 response 终态加 run.interrupted。 */
export const TERMINAL_EVENT_TYPES = [
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
  'run.interrupted',
] as const satisfies readonly RunEventType[];

/** 该事件之后运行不会再有新的进展（等待者与兼容流据此结束）。 */
export function isTerminalEvent(type: string): boolean {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(type);
}

/** 构成输出投影的事件（store 为它们建了部分索引）。 */
export const OUTPUT_EVENT_TYPES = [
  'response.output_item.added',
  'response.output_text.delta',
  'response.output_item.done',
] as const satisfies readonly RunEventType[];

/** 运行时间线需要读取的事件；输出增量与内容片段不读。 */
export const TIMELINE_EVENT_TYPES = [
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.cancelled',
  'response.incomplete',
  'run.queued',
  'run.parked',
  'run.requires_action',
  'run.interrupted',
  'approval.resolved',
  'tool.queued',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.cached',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
] as const satisfies readonly RunEventType[];
