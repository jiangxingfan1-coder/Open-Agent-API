/**
 * 拆出去的内核模块（提交、模型轮次、工具阶段、审批、外部智能体回合、生命周期）需要的内核状态与协作者。
 * 由 Kernel 构造一次并显式传入，不暴露 Kernel 的私有字段。
 */
import type { Run, WorkContext } from '../core/contracts.js';
import type { JsonSchemas } from '../core/schemas.js';
import type { Store } from '../store/store.js';
import type { NodeHub } from '../fabric/network.js';
import type { ModelRouter } from './routing.js';
import type { ToolCache } from './tool-cache.js';
import type { DelegateRuntime } from './delegate.js';
import type { Admission } from './admission.js';
import type { KernelAuth, KernelLimits } from './types.js';

export interface KernelRuntime {
  readonly store: Store;
  readonly hub: NodeHub;
  readonly router: ModelRouter;
  readonly limits: KernelLimits;
  /** 准入队列、运行槽与停车表。 */
  readonly admission: Admission;
  readonly controllers: Map<string, AbortController>;
  /** 调用方自带的 provider 密钥（BYOK），只在内存里。 */
  readonly byokKeys: Map<string, string>;
  readonly byokExpiry: Map<string, NodeJS.Timeout>;
  readonly shutdown: AbortController;
  readonly ajv: JsonSchemas;
  /** Validator of caller-requested output contracts: also enforces `format`. */
  readonly outputSchemas: JsonSchemas;
  readonly cache: ToolCache;
  readonly delegation: DelegateRuntime;
  /** 网关是否正在关闭。 */
  closing(): boolean;
  auth(): KernelAuth | undefined;
  /** 经由 Kernel.context 构造工作区上下文（诊断工具会包装这个方法）。 */
  context(run: Run): Promise<WorkContext>;
}
