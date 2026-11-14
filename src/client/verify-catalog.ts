import { bi, type LocalText } from '../core/locale.js';
import { reportsUsage } from './verify-env.js';
import type { AgentKind, ScenarioResult } from './verify-harness.js';

export type ScenarioMeta = {
  id: string;
  key: string;
  title: LocalText;
  /** Agent invocations the scenario makes (the maximum; an engine without a capability makes fewer). */
  calls: number;
  /** One line on what it does, for the plan printed before anything runs. */
  note: LocalText;
  /** Part of `oaa verify` by default. */
  verify: boolean;
  /** Part of examples/live-agents-acceptance.ts. */
  acceptance: boolean;
};

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: 'S1',
    key: 'chat',
    calls: 1,
    verify: true,
    acceptance: true,
    title: bi('OpenAI Chat 非流式', 'OpenAI Chat, non-streaming'),
    note: bi(
      'POST /v1/chat/completions，要求回复一串约定字符',
      'POST /v1/chat/completions; the agent must answer with an agreed string',
    ),
  },
  {
    id: 'S2',
    key: 'chat-stream',
    calls: 1,
    verify: true,
    acceptance: true,
    title: bi('OpenAI Chat 流式', 'OpenAI Chat, streaming'),
    note: bi(
      '同一请求加 stream:true，核对增量到达方式与结束帧',
      'The same request with stream:true; checks how deltas arrive and the final frame',
    ),
  },
  {
    id: 'S3',
    key: 'responses',
    calls: 2,
    verify: true,
    acceptance: true,
    title: bi(
      'OpenAI Responses 与 previous_response_id 续接',
      'OpenAI Responses and previous_response_id continuation',
    ),
    note: bi(
      '第一轮给暗号，第二轮续接并要求复述',
      'Turn one gives a code; turn two continues the session and asks for it back',
    ),
  },
  {
    id: 'S4',
    key: 'claude-messages',
    calls: 2,
    verify: true,
    acceptance: true,
    title: bi('Claude Messages 非流式与流式', 'Claude Messages, non-streaming and streaming'),
    note: bi('POST /v1/messages 各一次', 'POST /v1/messages once plain and once streaming'),
  },
  {
    id: 'S5',
    key: 'gemini',
    calls: 1,
    verify: true,
    acceptance: true,
    title: bi('Gemini generateContent', 'Gemini generateContent'),
    note: bi('POST /v1/models/{agent}:generateContent', 'POST /v1/models/{agent}:generateContent'),
  },
  {
    id: 'S6',
    key: 'approvals',
    calls: 2,
    verify: true,
    acceptance: true,
    title: bi('审批：批准与拒绝', 'Approvals: approve and deny'),
    note: bi(
      '两个「创建 note.txt」任务：一个批准后继续，一个拒绝后应失败；文件只写在临时目录',
      'Two "create note.txt" tasks: one approved and continued, one denied and expected to fail; files are written only in a temporary directory',
    ),
  },
  {
    id: 'S7',
    key: 'cancel',
    calls: 1,
    verify: true,
    acceptance: true,
    title: bi('取消', 'Cancel'),
    note: bi(
      '后台任务运行 3 秒后取消，核对状态与子进程退出',
      'A background task is cancelled after 3 seconds; checks the status and that its child processes exit',
    ),
  },
  {
    id: 'S8',
    key: 'client-tools',
    calls: 1,
    verify: true,
    acceptance: true,
    title: bi('调用方工具桥接', 'Caller-tool round trip'),
    note: bi(
      '智能体调用调用方提供的工具，结果回传后继续',
      'The agent calls a tool the caller provides; the result is returned and the run continues',
    ),
  },
  {
    id: 'S9',
    key: 'concurrency',
    calls: 3,
    verify: true,
    acceptance: true,
    title: bi('并发 3 个任务', '3 concurrent tasks'),
    note: bi(
      '同时发 3 个任务，核对互不串话',
      'Three tasks at once; checks they do not mix up answers',
    ),
  },
  {
    id: 'S10',
    key: 'billing',
    calls: 1,
    verify: false,
    acceptance: true,
    title: bi('计费', 'Billing'),
    note: bi(
      '开发者平台：账号密钥、定价与扣点',
      'Developer platform: account key, pricing and charging',
    ),
  },
  {
    id: 'S11',
    key: 'errors',
    calls: 0,
    verify: true,
    acceptance: true,
    title: bi('错误路径', 'Error paths'),
    note: bi(
      '错误密钥、无权限、非法请求体（三种协议），不会调用智能体',
      'Wrong key, no access and malformed bodies on three protocols; never reaches the agent',
    ),
  },
  {
    id: 'S12',
    key: 'cleanup',
    calls: 0,
    verify: true,
    acceptance: true,
    title: bi(
      '收尾检查：残留子进程与秘密泄漏',
      'Final check: leftover processes and leaked secrets',
    ),
    note: bi(
      '不调用智能体：核对子进程都已退出、临时目录里没有密钥',
      'Calls no agent: checks that child processes exited and no key is left in the temporary directory',
    ),
  },
  {
    id: 'S13',
    key: 'usage',
    calls: 0,
    verify: true,
    acceptance: false,
    title: bi('用量上报', 'Usage reporting'),
    note: bi(
      '不额外调用：从前面场景的响应里判断是否上报了 token 用量',
      'No extra call: judged from the responses of the earlier scenarios',
    ),
  },
];

/** `S1`, `chat` or `Chat` to the scenario's legacy id; undefined when unknown. */
export function scenarioId(name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  return SCENARIOS.find((s) => s.id.toLowerCase() === wanted || s.key === wanted)?.id;
}

/** Arguments for a native engine that make approvals meaningful (read allowed, writes need approval). */
export function nativeArgs(
  kind: AgentKind,
  options: { agyMode?: string; timeoutMs: number; agyLogFile: string },
): string[] {
  if (kind === 'codex')
    return ['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="read-only"'];
  if (kind === 'antigravity')
    return [
      '--mode',
      options.agyMode ?? 'plan',
      '--sandbox',
      '--effort',
      'low',
      '--print-timeout',
      `${Math.max(30, Math.floor(options.timeoutMs / 1000) - 15)}s`,
      '--log-file',
      options.agyLogFile,
    ];
  return [];
}

/** Usage is "reported" when any protocol's response carried a non-zero token count. */
export function deriveUsage(results: ScenarioResult[]): ScenarioResult {
  const meta = SCENARIOS.find((s) => s.id === 'S13')!;
  const sources: [string, string][] = [
    ['S1', 'usage'],
    ['S2', 'usage'],
    ['S3', 'first_usage'],
    ['S4', 'sync_usage'],
    ['S5', 'usage'],
  ];
  const result: ScenarioResult = {
    id: meta.id,
    key: meta.key,
    title: meta.title,
    status: 'pass',
    elapsed_ms: 0,
    agent_invocations: 0,
    observations: {},
    checks: [],
    run_ids: [],
    doc_mismatches: [],
  };
  const ran = sources.filter(([id]) => results.some((r) => r.id === id && r.status !== 'skipped'));
  if (!ran.length) {
    result.status = 'skipped';
    result.error = {
      code: 'no_source',
      message: bi(
        '没有运行任何会返回用量的场景（chat、chat-stream、responses、claude-messages、gemini）',
        'None of the scenarios that return usage ran (chat, chat-stream, responses, claude-messages, gemini)',
      ),
    };
    return result;
  }
  const reported: string[] = [];
  for (const [id, field] of ran) {
    const usage = results.find((r) => r.id === id)?.observations[field];
    result.observations[`${id}_reports_usage`] = reportsUsage(usage);
    if (reportsUsage(usage)) reported.push(id);
  }
  result.observations.reported_by = reported;
  if (!reported.length) {
    result.status = 'unsupported';
    result.error = {
      code: 'usage_not_reported',
      message: bi(
        '智能体没有上报 token 用量（响应里的 usage 缺失或全为 0）；网关按「用量未知」处理，不编造数字',
        'The agent did not report token usage (usage missing or all zero); the gateway treats it as unknown and invents no numbers',
      ),
    };
  } else
    result.checks.push({
      name: bi('响应里带有非零的 token 用量', 'Responses carry non-zero token usage'),
      ok: true,
      detail: reported,
    });
  return result;
}

/** Label for a status in the terminal and in reports. */
export const STATUS_LABEL: Record<ScenarioResult['status'], LocalText> = {
  pass: bi('通过', 'pass'),
  fail: bi('失败', 'FAIL'),
  unsupported: bi('不支持', 'unsupported'),
  skipped: bi('跳过', 'skipped'),
};
