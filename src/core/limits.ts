/**
 * 限额目录：内核、存储与节点网络里的固定上限，集中命名、在原处引用。
 *
 * 只是命名，不是配置：数值与引入前完全一致，改动任何一项都会改变线上行为，需要单独评审。
 * 报错文案仍写在各自的抛出处，须与这里的数值一致（例如上下文上限的文案写的是 2 MB（2,000,000 字节））。
 */
export const LIMITS = {
  /** 每个 owner 同时未完成的请求数（kernel：超出报 concurrency_limit）。 */
  ownerActiveRuns: 32,
  /** 一次模型请求的上下文（系统指令 + 历史消息的 JSON）字节数上限（kernel：超出报 context_limit）。 */
  contextBytes: 2_000_000,
  /** 一次运行的输入文件总字节数（kernel：超出报 files_too_large）。 */
  inputFilesBytes: 8 * 1024 * 1024,
  /** 发给执行节点的工作区文件总字节数（kernel：超出报 workspace_too_large）。 */
  workspaceTransferBytes: 16 * 1024 * 1024,
  /** 检查点里保留的模型轮次标记条数，超出时丢弃最早的（kernel）。 */
  modelTurnMarks: 400,
  /**
   * 运行时子智能体委托的最大深度（kernel/delegate：顶层运行为 0，子运行深度为父运行 +1，
   * 超过 3 报 delegation_depth_exceeded）。限制的是真正会被启动的子运行层数：第 0–3 层。
   */
  delegationDepth: 3,
  /**
   * 提交前静态检查委托链执行级别时向下遍历的层数（kernel `checkExecution`：第 0–4 层，更深的不再看）。
   * 限制的是一次检查的遍历范围（防环另有已访问集合），不是运行时能走多深。它必须不小于
   * delegationDepth，才能覆盖运行时可能启动的每一层；比它多看一层只会更严格地拒绝。
   * 两个值的含义不同，保留各自的常量；改成相同的值会放宽现有的拒绝行为，需要单独评审。
   */
  delegationCheckDepth: 4,
  /** `metadata["oaa.agent_fallback"]` 里最多采用的备选智能体个数（kernel）。 */
  agentFallbacks: 4,
  /** Idempotency-Key 的最大长度（字符，kernel：超出报 invalid_idempotency_key）。 */
  idempotencyKeyChars: 200,
  /** 只读工具结果缓存的条目数（kernel/tool-cache）。 */
  toolCacheEntries: 1000,
  /** 只读工具结果缓存的总字节数（kernel/tool-cache）。 */
  toolCacheBytes: 16 * 1024 * 1024,
  /** 输出投影缓存保留的运行数（store）。 */
  projectionCacheRuns: 128,
  /** 文件内容缓存保留的文件数（store）。 */
  filePayloadCacheFiles: 128,
  /** 单个上传文件的字节数（store：超出报 file_too_large）。 */
  fileBytes: 8 * 1024 * 1024,
  /** 单条记忆序列化后的字节数（store：超出报 memory_too_large）。 */
  memoryEntryBytes: 256_000,
  /** 单个节点的待派发队列长度（fabric/network：超出报 queue_full）。 */
  nodeQueueLength: 1000,
  /** 节点连接的单条消息与发送缓冲字节数（fabric/network：超出报 node_backpressure）。 */
  nodeMessageBytes: 24 * 1024 * 1024,
} as const;

/**
 * 外部智能体接入的上限：内核（kernel/text-sink、kernel/agent-events）与接入层（engines/shared）
 * 引用同一份数值。单独导出、不并入 LIMITS，以免改变限额目录本身。
 */
export const AGENT_LIMITS = {
  /** 一次运行（含外部智能体的一轮）输出文本的字符数（超出报 output_too_large）。 */
  outputTextChars: 1_000_000,
  /** 外部智能体审批详情序列化后的字符数（超出即拒绝批准，不创建待审批项）。 */
  approvalDetailChars: 256 * 1024,
} as const;
