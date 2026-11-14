/**
 * ACP 引擎（engines/acp.ts）抛出的错误说明，中英双语。放在单独文件里，acp.ts 只引用键名，
 * 保持它在行数预算之内；`Error.message` 取进程默认语言，HTTP 响应按请求语言再选。
 */
import { bi } from '../core/locale.js';

export const ACP_TEXT = {
  authRequired: bi(
    'ACP 智能体要求先完成认证。请在该智能体自己的 CLI 中登录后重试；OAA 不会代为认证或保存凭据。',
    'The ACP agent requires authentication. Sign in through its own CLI and retry; OAA never signs in or stores credentials on its behalf.',
  ),
  rejected: (method: string, code: number, detail: string) =>
    bi(
      `ACP 智能体拒绝了 ${method}（${code}）：${detail}`,
      `The ACP agent rejected ${method} (${code}): ${detail}`,
    ),
  timeout: (label: string, ms: number) =>
    bi(`ACP ${label} 超过 ${ms} ms 未完成。`, `ACP ${label} did not finish within ${ms} ms.`),
  exited: (how: string, detail: string) =>
    bi(
      `ACP 智能体进程在任务完成前退出（${how}）${detail ? `：${detail}` : ''}`,
      `The ACP agent process exited before the task finished (${how})${detail ? `: ${detail}` : '.'}`,
    ),
  closed: bi('ACP 智能体进程已关闭。', 'The ACP agent process has closed.'),
  spawnFailed: (detail: string) =>
    bi(`ACP 智能体进程无法启动：${detail}`, `The ACP agent process could not start: ${detail}`),
  partialLine: bi(
    'ACP 智能体以不完整的 JSON 行结束了输出。',
    'The ACP agent ended its output with an incomplete JSON line.',
  ),
  frameTooLarge: bi('ACP 消息超过 8 MiB 限制。', 'An ACP message exceeded the 8 MiB limit.'),
  notJson: bi(
    'ACP 智能体在 stdout 输出了非 JSON 内容；stdout 只能承载 ACP 消息。',
    'The ACP agent wrote non-JSON output to stdout; stdout may carry only ACP messages.',
  ),
  notJsonRpc: bi(
    'ACP 智能体输出了无效的 JSON-RPC 2.0 消息。',
    'The ACP agent emitted an invalid JSON-RPC 2.0 message.',
  ),
  badId: bi('ACP 请求携带了无效的 id。', 'An ACP request carried an invalid id.'),
  notificationFailed: bi('ACP 通知无法处理。', 'An ACP notification could not be handled.'),
  unparsable: bi(
    'ACP 智能体无法解析 OAA 发送的消息。',
    'The ACP agent could not parse a message sent by OAA.',
  ),
  unrecognized: bi(
    'ACP 智能体输出了无法识别的消息。',
    'The ACP agent emitted an unrecognized message.',
  ),
  otherAdapter: bi(
    '上一轮会话来自另一个 ACP 适配器，无法续接；请开启新会话。',
    'The previous session came from a different ACP adapter and cannot be continued; start a new session.',
  ),
  foreignUpdate: bi(
    'ACP 智能体发送了不属于本次会话的更新，已停止。',
    'The ACP agent sent an update for another session; stopped.',
  ),
  approvalTitle: bi('ACP 智能体请求操作许可', 'The ACP agent requests permission'),
  cancelled: bi('ACP 任务已取消。', 'The ACP task was cancelled.'),
  badVersion: (got: string, supported?: number) =>
    bi(
      `ACP 智能体返回了不支持的协议版本 ${got}${supported === undefined ? '' : `；OAA 支持版本 ${supported}`}。`,
      `The ACP agent returned unsupported protocol version ${got}${supported === undefined ? '' : `; OAA supports version ${supported}`}.`,
    ),
  noResume: bi(
    '此 ACP 智能体未声明 session/resume 或 session/load，无法续接上一轮会话；请开启新会话。',
    'This ACP agent declares neither session/resume nor session/load, so the previous session cannot be continued; start a new session.',
  ),
  noSessionId: bi(
    'ACP 智能体未返回有效的会话 ID。',
    'The ACP agent did not return a valid session ID.',
  ),
  modelUnconfirmed: bi(
    'ACP 智能体未确认已切换到所选模型；未发送任务。',
    'The ACP agent did not confirm the switch to the selected model; the task was not sent.',
  ),
  modelNotOffered: (model: string) =>
    bi(
      `ACP 智能体未在会话中声明可选模型 ${model}；未发送任务。使用 default 可沿用智能体自身的模型。`,
      `The ACP agent does not offer the model ${model} in this session; the task was not sent. Use default to keep the agent's own model.`,
    ),
  unrequestedCancel: bi(
    'ACP 智能体在 OAA 未请求取消时报告了 cancelled。',
    'The ACP agent reported cancelled although OAA did not request cancellation.',
  ),
  stopped: (reason: string) =>
    bi(
      `ACP 智能体未完整完成任务（停止原因：${reason}）。`,
      `The ACP agent did not finish the task (stop reason: ${reason}).`,
    ),
  denied: (count: number) =>
    bi(
      `ACP 智能体有 ${count} 个操作请求未获批准；进程正常结束不能作为成功依据。`,
      `${count} ACP agent permission request(s) were not approved; a clean process exit does not count as success.`,
    ),
};
