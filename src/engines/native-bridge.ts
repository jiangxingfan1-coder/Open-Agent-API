/**
 * 原生智能体引擎（Claude Code、Codex）的调用方工具桥接与单次运行隔离配置（docs/harness.md）。
 *
 * 复用 `caller-relay.ts` 的本机 Unix 域套接字 / Windows 命名管道与 0600 一次性令牌（`oaa mcp-relay`）：
 * - Claude Agent SDK：通过 `options.mcpServers` 注入单次 stdio MCP 服务 `oaa-caller`，并在
 *   `canUseTool` 中仅对 `mcp__oaa-caller__<name>` 调用方工具自动放行一次（宿主机工具仍走审批）。
 * - Codex app-server：通过进程启动参数 `-c` 注入单次覆盖（`mcp_servers.oaa-caller.*`），不修改用户
 *   `~/.codex/config.toml`，并在 MCP 工具审批事件中自动放行 `oaa-caller` 工具。
 */
import type { ClientTool } from '../core/contracts.js';
import {
  CALLER_RELAY_NAME,
  callerToolPermission,
  openCallerRelay,
  type AcpStdioMcpServer,
  type CallerRelay,
} from './caller-relay.js';
import { record } from './shared.js';

export { CALLER_RELAY_NAME, openCallerRelay, type AcpStdioMcpServer, type CallerRelay };

/** Claude Agent SDK `options.mcpServers` 接收的 stdio MCP 服务条目。 */
export type ClaudeStdioMcpServer = {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
};

const CLAUDE_CALLER_PREFIX = `mcp__${CALLER_RELAY_NAME}__`;
const ACP_CALLER_PREFIX = `mcp_${CALLER_RELAY_NAME}_`;

const SERVER_KEYS = ['server', 'serverName', 'server_name', 'mcpServer', 'mcp_server'] as const;
const TOOL_KEYS = ['tool', 'toolName', 'tool_name', 'name'] as const;

/** 将 `AcpStdioMcpServer` 转换为 Claude Agent SDK `options.mcpServers` 所需的字典结构。 */
export function claudeCallerMcpServers(
  server: AcpStdioMcpServer,
): Record<string, ClaudeStdioMcpServer> {
  const env: Record<string, string> = {};
  for (const entry of server.env) env[entry.name] = entry.value;
  return {
    [server.name]: {
      type: 'stdio',
      command: server.command,
      args: [...server.args],
      env,
    },
  };
}

/** 若 `toolName` 命中本次桥接声明的 Claude MCP 调用方工具，返回工具原名；否则返回 null。 */
export function claudeCallerTool(
  toolName: string,
  clientTools?: readonly Pick<ClientTool, 'name'>[],
): string | null {
  if (!clientTools?.length || typeof toolName !== 'string') return null;
  if (!toolName.startsWith(CLAUDE_CALLER_PREFIX)) return null;
  const raw = toolName.slice(CLAUDE_CALLER_PREFIX.length);
  return clientTools.find((tool) => tool.name === raw)?.name ?? null;
}

/** Claude `canUseTool` 判定：是否为 `oaa-caller` 暴露的已声明调用方工具。 */
export function isClaudeCallerTool(
  toolName: string,
  clientTools?: readonly Pick<ClientTool, 'name'>[],
): boolean {
  return claudeCallerTool(toolName, clientTools) !== null;
}

/** 序列化为合法的 TOML 1.0 双引号基础字符串（同时也是合法的 JSON 字符串）。 */
export function tomlString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = value.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/**
 * 为 Codex 单次进程启动构造 `-c` 覆盖参数，注入 `oaa-caller` stdio MCP 服务；
 * 仅对当前子进程生效，绝不修改用户 `~/.codex/config.toml`。
 */
export function codexCallerArgs(server: AcpStdioMcpServer): string[] {
  const prefix = `mcp_servers.${tomlKey(server.name)}`;
  const out = [
    '-c',
    `${prefix}.command=${tomlString(server.command)}`,
    '-c',
    `${prefix}.args=${tomlStringArray(server.args)}`,
  ];
  if (server.env.length) {
    const pairs = server.env.map((e) => `${tomlKey(e.name)}=${tomlString(e.value)}`).join(', ');
    out.push('-c', `${prefix}.env={ ${pairs} }`);
  }
  return out;
}

/**
 * 为 Codex 无工具纯推理回合构造单次 `-c` 覆盖参数：只读沙箱（外层已有 OS 沙箱时保留其免嵌套设置）、
 * 最严审批策略与空 MCP 服务表。
 */
export function codexReasoningArgs(sandboxed = false): string[] {
  return [
    ...(sandboxed ? [] : ['-c', 'sandbox_mode="read-only"']),
    '-c',
    'approval_policy="on-request"',
    '-c',
    'mcp_servers={}',
  ];
}

function pickField(sources: Record<string, unknown>[], keys: readonly string[]): string | null {
  for (const src of sources) {
    for (const key of keys) {
      const value = src[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return null;
}

function matchPrefixedCallerTool(raw: string, names: readonly string[]): string | null {
  for (const prefix of [CLAUDE_CALLER_PREFIX, ACP_CALLER_PREFIX]) {
    if (raw.toLowerCase().startsWith(prefix.toLowerCase())) {
      const candidate = raw.slice(prefix.length);
      const found = names.find((name) => name === candidate);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 判定 Codex 审批请求是否针对 `oaa-caller` MCP 服务提供的调用方工具；
 * 是则返回调用方工具原名，否则返回 null（宿主机命令、文件变更等照旧走 owner 审批）。
 */
export function codexCallerTool(
  method: string,
  params: Record<string, unknown>,
  clientTools?: readonly Pick<ClientTool, 'name'>[],
): string | null {
  if (!clientTools?.length) return null;
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method.includes('requestUserInput')
  )
    return null;
  const meta = record(params._meta);
  if (method.includes('elicitation')) {
    if (method !== 'mcpServer/elicitation/request' || meta.codex_approval_kind !== 'mcp_tool_call')
      return null;
  }
  const names = clientTools.map((t) => t.name);
  const sources = [params, meta, record(params.item), record(params.toolCall), record(params.call)];
  const server = pickField(sources, SERVER_KEYS);
  if (server !== null && server.toLowerCase() !== CALLER_RELAY_NAME) return null;
  if (method === 'mcpServer/elicitation/request' && server === null) return null;
  const tool = pickField(sources, TOOL_KEYS);
  if (server !== null && tool !== null) {
    if (names.includes(tool)) return tool;
    const stripped = matchPrefixedCallerTool(tool, names);
    if (stripped) return stripped;
  }
  if (server === null && tool !== null) {
    const stripped = matchPrefixedCallerTool(tool, names);
    if (stripped) return stripped;
  }
  if (method === 'mcpServer/elicitation/request') return null;
  return callerToolPermission(params.toolCall ?? params, names);
}

/** Codex 审批事件布尔判定：是否为 `oaa-caller` 调用方工具。 */
export function isCodexCallerTool(
  method: string,
  params: Record<string, unknown>,
  clientTools?: readonly Pick<ClientTool, 'name'>[],
): boolean {
  return codexCallerTool(method, params, clientTools) !== null;
}

/** 构造 Codex app-server 审批请求的协议返回结果。 */
export function codexDecisionPayload(
  method: string,
  params: Record<string, unknown>,
  approved: boolean,
  answer?: Record<string, unknown> | void,
): unknown {
  if (method.includes('requestUserInput'))
    return approved && answer?.answers ? { answers: answer.answers } : { answers: {} };
  if (method.includes('elicitation'))
    return {
      action: approved ? 'accept' : 'decline',
      content: approved ? (answer?.content ?? (params.mode === 'url' ? null : {})) : null,
      _meta: null,
    };
  if (method === 'item/permissions/requestApproval')
    return {
      permissions: approved ? (params.permissions ?? {}) : {},
      scope: 'turn',
    };
  return { decision: approved ? 'accept' : 'decline' };
}
