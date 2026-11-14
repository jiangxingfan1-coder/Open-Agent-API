/**
 * 兼容入口的错误形状与结束原因。
 *
 * - 错误体按入口所属的协议编码：OpenAI 是 `{error:{code,message,type,param}}`；Claude 是
 *   `{type:"error",error:{type,message,code}}`（https://platform.claude.com/docs/en/api/errors）；
 *   Gemini 是 Google API 错误模型 `{error:{code:<int>,message,status,details:[ErrorInfo]}}`
 *   （https://cloud.google.com/apis/design/errors）。网关自己的稳定错误码在 OpenAI 的 `error.code`、
 *   Claude 的附加字段 `error.code`、Gemini 的 `details[].reason`。
 * - 运行已经创建、但没有正常结束（失败、取消、中断、待审批）时，非流式兼容响应用 422 并带
 *   `x-should-retry: false`：Stainless 生成的官方 SDK（openai、@anthropic-ai/sdk）默认对 408、409、
 *   429、5xx 自动重试两次，而且只在服务端明确给出 `x-should-retry` 时听从它
 *   （node_modules/openai/client.js `shouldRetry`）。原样重试会新建运行、重复执行工具与扣费。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import type { Run } from '../core/contracts.js';
import { errorClassStatus, errorEntry, faultMessage } from '../core/errors.js';
import { processLocale, requestLocale, type Locale, type LocalText } from '../core/locale.js';
import { Fault, RetryLaterFault } from '../core/util.js';
import { ParamFault } from '../core/param-fault.js';
import { fromGoogleClient, isGeminiPath } from './gemini.js';

/** 带参数名或运行 ID 的错误：`param` 进 OpenAI 的 `error.param`，`runId` 说明运行已经创建。 */
export class CompatFault extends Fault {
  constructor(
    code: string,
    message: string | LocalText,
    status = 400,
    public param: string | null = null,
    public runId?: string,
  ) {
    super(code, message, status);
  }
}

export type ErrorDialect = 'openai' | 'claude' | 'gemini' | 'native';

const OPENAI_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/compat/chat/completions',
  '/v1/compat/responses',
  '/v1/responses',
]);

/** 按路径（以及 `/v1/universal` 已判定的协议）选择错误形状；其余路由保持原有形状。 */
export function errorDialect(path: string, detected?: unknown): ErrorDialect {
  // `/v1/messages/*`（count_tokens、batches 等本网关没有的子路径）同样是 Claude 形状，
  // 官方 SDK 才能把 404 解析成带 `not_found_error` 的 NotFoundError。
  if (/^\/v1\/(compat\/)?messages(\/|$)/.test(path)) return 'claude';
  if (isGeminiPath(path)) return 'gemini';
  if (OPENAI_PATHS.has(path) || path.startsWith('/v1/responses/')) return 'openai';
  if (path === '/v1/universal') {
    if (detected === 'claude') return 'claude';
    if (detected === 'gemini') return 'gemini';
    if (detected === 'chat' || detected === 'responses') return 'openai';
  }
  return 'native';
}

/** Claude 的 `error.type`：按 HTTP 状态（官方错误文档的对照表）。 */
export function claudeErrorType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 402) return 'billing_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 409) return 'conflict_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 504) return 'timeout_error';
  if (status === 529 || status === 503) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

/** Gemini 的 `error.status`：google.rpc.Code 的名字，按 HTTP 状态。 */
export function geminiStatus(status: number): string {
  const table: Record<number, string> = {
    400: 'INVALID_ARGUMENT',
    401: 'UNAUTHENTICATED',
    402: 'FAILED_PRECONDITION',
    403: 'PERMISSION_DENIED',
    404: 'NOT_FOUND',
    409: 'ABORTED',
    413: 'INVALID_ARGUMENT',
    415: 'INVALID_ARGUMENT',
    422: 'FAILED_PRECONDITION',
    429: 'RESOURCE_EXHAUSTED',
    499: 'CANCELLED',
    501: 'UNIMPLEMENTED',
    503: 'UNAVAILABLE',
    504: 'DEADLINE_EXCEEDED',
  };
  return table[status] ?? (status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT');
}

const paramOf = (fault: Fault): string | null =>
  fault instanceof CompatFault || fault instanceof ParamFault ? fault.param : null;

export function errorBody(
  dialect: ErrorDialect,
  status: number,
  fault: Fault,
  locale: Locale = processLocale(),
): Record<string, unknown> {
  const message = faultMessage(fault, locale);
  const extra = fault instanceof CompatFault ? fault : undefined;
  const runId = extra?.runId ? { run_id: extra.runId } : {};
  // 类别按错误码的语义选（服务一侧的运行错误码为 500 一类），HTTP 状态与重试头不受影响。
  const kind = errorClassStatus(fault.code, status);
  if (dialect === 'claude')
    return {
      type: 'error',
      error: { type: claudeErrorType(kind), message, code: fault.code, ...runId },
    };
  if (dialect === 'gemini')
    return {
      error: {
        code: status,
        message,
        status: geminiStatus(kind),
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: fault.code,
            domain: 'open-agent-api',
            ...(extra?.runId ? { metadata: { run_id: extra.runId } } : {}),
          },
        ],
      },
    };
  return {
    error: {
      code: fault.code,
      message,
      type: 'invalid_request_error',
      ...(dialect === 'openai' ? { param: paramOf(fault) } : {}),
      // Native bodies gain `param` only when a fault names a field (an image part, ...).
      ...(dialect === 'native' && paramOf(fault) ? { param: paramOf(fault) } : {}),
      ...runId,
    },
  };
}

/** SDK 会自动重试的状态码（Stainless `shouldRetry`）。 */
const sdkRetries = (status: number) =>
  status === 408 || status === 409 || status === 429 || status >= 500;

/**
 * 重试相关的响应头：运行已经创建、或错误码在目录里标为不可重试而状态码会让 SDK 重试时，
 * `x-should-retry: false`；可重试的 429 / 503 给 `Retry-After`（每分钟限流给窗口真实的剩余秒数，
 * 其余容量类给保守的 10 秒）。
 */
export function retryHeaders(status: number, fault: Fault): Record<string, string> {
  if (fault instanceof CompatFault && fault.runId) return { 'x-should-retry': 'false' };
  const retryable = errorEntry(fault.code)?.retryable === true;
  if (!retryable) return sdkRetries(status) ? { 'x-should-retry': 'false' } : {};
  if (status === 429 || status === 503)
    return {
      'retry-after': String(fault instanceof RetryLaterFault ? fault.retryAfterSeconds : 10),
    };
  return {};
}

// ---------------------------------------------------------------------------
// 结束原因
// ---------------------------------------------------------------------------

export type Finish = 'stop' | 'length' | 'failure';

/** 运行的结束原因：正常完成、模型输出被截断（`max_output_tokens`），其余都算没有正常结束。 */
export function finishOf(run: Run): Finish {
  if (run.status === 'completed') return 'stop';
  if (run.status === 'incomplete' && run.error?.code === 'max_output_tokens') return 'length';
  return 'failure';
}

export const chatFinish = (f: Finish) => (f === 'length' ? 'length' : 'stop');
export const claudeStop = (f: Finish) => (f === 'length' ? 'max_tokens' : 'end_turn');
export const geminiFinish = (f: Finish) => (f === 'length' ? 'MAX_TOKENS' : 'STOP');

/** 运行没有正常结束时的错误码与说明（流式与非流式共用）。 */
export function runProblem(run: Run): { code: string; message: string } {
  if (run.status === 'requires_action')
    return {
      code: 'action_required',
      message: `Response ${run.id} is waiting for an approval. Decide it with POST /v1/runs/${run.id}/actions/{action_id} (GET /v1/runs/${run.id} lists the pending actions), then read the result with GET /v1/responses/${run.id}. Do not resend this request: that starts a new run.`,
    };
  const code = run.error?.code ?? (run.status === 'cancelled' ? 'cancelled' : 'incomplete');
  const reason = run.error?.message ?? `The run ended as ${run.status}.`;
  return { code, message: `${reason} Response ID: ${run.id}` };
}

/** 非流式兼容响应：运行已创建但没有正常结束（422，带运行 ID，SDK 不会重试）。 */
export function runFailure(run: Run): CompatFault {
  const { code, message } = runProblem(run);
  return new CompatFault(code, message, 422, null, run.id);
}

/**
 * 流里出错时的 HTTP 状态语义（只用于选择 Claude / Gemini 的错误类别）。目录里状态为 `null` 的
 * run 码按 `errorClassStatus`：调用自身的上限（`callerLimit`）为 422，服务一侧的原因为 500。
 */
export function problemStatus(run: Run): number {
  if (run.status === 'requires_action') return 422;
  const code = run.error?.code ?? '';
  return errorClassStatus(code, errorEntry(code)?.status ?? 500);
}

// ---------------------------------------------------------------------------
// 网关的全局错误处理用到的小工具（server.ts 的 setErrorHandler / setNotFoundHandler）
// ---------------------------------------------------------------------------

/** 校验错误：`字段: 原因`（字段为空时不留前导冒号），`param` 取第一个问题的字段。 */
export function zodFault(error: ZodError): CompatFault {
  const where = (i: ZodError['issues'][number]) =>
    i.path.length ? i.path.join('.') : i.code === 'unrecognized_keys' ? (i.keys[0] ?? '') : '';
  const message = error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  const first = error.issues[0];
  return new CompatFault('invalid_request', message, 400, first ? where(first) || null : null);
}

/** 按入口的协议与请求的语言（`Accept-Language`，缺省为进程默认语言）写错误响应，并带上重试相关的响应头。 */
export function sendError(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  fault: Fault,
): void {
  const path = req.url.split('?')[0]!;
  const dialect =
    fromGoogleClient(req) && path.startsWith('/v1/models')
      ? 'gemini'
      : errorDialect(path, reply.getHeader('X-OAA-Detected-Protocol'));
  for (const [name, value] of Object.entries(retryHeaders(status, fault)))
    reply.header(name, value);
  reply
    .code(status)
    .send(errorBody(dialect, status, fault, requestLocale(req.headers['accept-language'])));
}

/**
 * Gemini REST 的 `?key=`：只在 Gemini 的模型路径上接受——
 * `/v1beta/models[/*]` 与 `/v1/models/{model}:{method}`（官方 SDK 默认的 `v1`）。
 */
export function geminiQueryKey(req: FastifyRequest): string | undefined {
  const path = req.url.split('?')[0]!;
  if (!/^\/v1beta\/models(\/|$)/.test(path) && !(isGeminiPath(path) && path.startsWith('/v1/')))
    return undefined;
  const key = (req.query as { key?: unknown } | undefined)?.key;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/** Gemini 的 `:streamGenerateContent` 是否要求 SSE；`/v1/universal` 的 Gemini 流一直是 SSE。 */
export function sseRequested(req: FastifyRequest): boolean {
  if (!isGeminiPath(req.url)) return true;
  return (req.query as { alt?: unknown } | undefined)?.alt === 'sse';
}
