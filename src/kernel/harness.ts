/**
 * 双层 Harness 契约（docs/harness.md）：调用方自己也是智能体、在兼容接口里传入自己的工具时，
 * 按请求选择的模式处理这些工具。
 *
 * - `auto`（缺省，网关配置 `clientTools.default` 可改）：智能体能接管调用方工具就按 `bridge`，
 *   否则回到该入口原来的行为（OpenAI 默认端点明确拒绝，其余入口按 `managed`）。
 * - `managed`：内层智能体用自己的工具完成任务；调用方工具不执行，响应头
 *   `X-OAA-Client-Tools: ignored`，并在输入末尾追加 `CLIENT_TOOLS_MANAGED_NOTE`。
 * - `bridge`：调用方工具投射给内层智能体、由调用方执行（内核智能体，以及经 MCP 中继的 ACP
 *   外部智能体，见 kernel/client-tools.ts）；其余外部智能体报 `client_tools_bridge_unsupported`。
 * - `reject`：传了工具就报 `client_tools_unsupported`。
 */
import type { AgentDefinition } from '../core/contracts.js';
import { Fault } from '../core/util.js';

export const CLIENT_TOOLS_MODES = ['auto', 'managed', 'bridge', 'reject'] as const;
export type ClientToolsMode = (typeof CLIENT_TOOLS_MODES)[number];
/** What the parser records when the request chose no mode: the gateway settles it at submit time. */
export type ParsedClientToolsMode = ClientToolsMode | 'default';

/** 托管模式追加给内层智能体的固定说明（英文，三句）。 */
export const CLIENT_TOOLS_MANAGED_NOTE =
  "External tools declared in the caller's request are not available here and will not be executed. " +
  'Use your own tools to complete the task and give the final result directly. ' +
  'Do not write tool calls in your reply or pretend to have called them.';

/**
 * 请求头 `x-oaa-client-tools` 优先，其次 `metadata["oaa.client_tools"]`；大小写不敏感。
 * 都没写返回 `default`：解析器照 `auto` 准备好桥接字段，提交时按网关配置与智能体能力定下来。
 */
export function resolveClientToolsMode(
  headers: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): ParsedClientToolsMode {
  const header = headers?.['x-oaa-client-tools'];
  const raw = header !== undefined && header !== '' ? header : metadata?.['oaa.client_tools'];
  if (raw === undefined || raw === '') return 'default';
  const value = String(Array.isArray(raw) ? raw[0] : raw)
    .trim()
    .toLowerCase();
  if ((CLIENT_TOOLS_MODES as readonly string[]).includes(value)) return value as ClientToolsMode;
  throw new Fault(
    'invalid_request',
    `X-OAA-Client-Tools (or metadata["oaa.client_tools"]) must be one of: ${CLIENT_TOOLS_MODES.join(', ')}.`,
  );
}

/** 解析阶段写下的 bridge 模式；只有请求确实声明了工具（解析器写了 declared 计数）时才返回。 */
export function requestedClientToolsMode(metadata: Record<string, string>): string | undefined {
  return metadata['oaa.client_tools_declared'] ? metadata['oaa.client_tools'] : undefined;
}

/**
 * 提交前置检查（授权之后、建运行之前）：内核智能体与 `adapter/<name>` 可以请求桥接；后者是否
 * 真的支持（ACP 接入、执行机器声明了 client-tools-v1）由放置阶段按执行机器的声明判断。
 */
export function assertClientToolsSupported(
  agent: Pick<AgentDefinition, 'engine'>,
  mode: string | undefined,
): void {
  if (mode === 'bridge' && agent.engine !== 'kernel' && !agent.engine.startsWith('adapter/'))
    throw new Fault(
      'client_tools_bridge_unsupported',
      'This agent runs its own tool loop; in this version only kernel agents and ACP adapters can bridge caller tools. Use X-OAA-Client-Tools: managed instead.',
    );
}
