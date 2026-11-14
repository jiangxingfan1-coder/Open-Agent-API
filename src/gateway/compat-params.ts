/**
 * 兼容入口里「接受但不转发」的参数与输出长度上限。
 *
 * 调用的是智能体：采样类参数由发布者在智能体里决定，网关不转发，但在响应头
 * `X-OAA-Ignored-Params` 里列出这次请求里被忽略的参数名（没有时不出现这个头）。输出长度上限
 * 写进 `metadata["oaa.max_output_tokens"]`，内核取它与智能体自身 `limits.maxOutputTokens`
 * 的较小者（kernel/invocation.ts `outputTokenCap`）。
 */
import { z } from 'zod';
import type { ModelSelectionResolution } from '../kernel/routing.js';
import { CompatFault } from './compat-errors.js';

export type ParamFamily = 'chat' | 'responses' | 'claude' | 'gemini';

const loose = z.unknown().optional();

/**
 * 严格 Chat 端点接受但不转发的字段（值不校验）。聊天客户端的「高级参数」与各家推理服务的采样旋钮
 * （Ollama / llama.cpp / vLLM 的 top_k、min_p、repeat_penalty 等）属于这一类：它们只影响采样，
 * 智能体的采样由发布者决定，忽略不会改变请求的含义。未列出的未知字段仍然报错（拼写错误不被吞掉）。
 * 会改变含义的取值另由 `rejectUnsatisfiable` 拒绝。
 */
export const chatTolerated = {
  logit_bias: loose,
  top_logprobs: loose,
  tool_choice: loose,
  parallel_tool_calls: loose,
  verbosity: loose,
  prompt_cache_key: loose,
  safety_identifier: loose,
  prediction: loose,
  top_k: loose,
  min_p: loose,
  repeat_penalty: loose,
  repetition_penalty: loose,
  repeat_last_n: loose,
  mirostat: loose,
  mirostat_eta: loose,
  mirostat_tau: loose,
  tfs_z: loose,
  typical_p: loose,
  num_ctx: loose,
  num_batch: loose,
  num_keep: loose,
  num_predict: loose,
  keep_alive: loose,
  think: loose,
} as const;

/** 严格 Chat 端点还要按取值检查的字段（空工具列表、`logprobs: false` 等无害取值照常接受）。 */
export const chatChecked = {
  logprobs: loose,
  modalities: loose,
  tools: loose,
  functions: loose,
  function_call: loose,
  response_format: loose,
} as const;

/** 严格 Responses 端点接受但不转发的字段。 */
export const responsesTolerated = {
  tool_choice: loose,
  parallel_tool_calls: loose,
  include: loose,
  max_tool_calls: loose,
  prompt_cache_key: loose,
  safety_identifier: loose,
  stream_options: loose,
  prompt_cache_retention: loose,
} as const;

export const responsesChecked = { tools: loose, text: loose } as const;

const IGNORED: Record<ParamFamily, readonly string[]> = {
  chat: [
    'temperature',
    'top_p',
    'seed',
    'stop',
    'presence_penalty',
    'frequency_penalty',
    'n',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'user',
    'store',
    'service_tier',
    'tool_choice',
    'parallel_tool_calls',
    ...Object.keys(chatTolerated).filter(
      (k) => !['logit_bias', 'top_logprobs', 'tool_choice', 'parallel_tool_calls'].includes(k),
    ),
  ],
  responses: [
    'temperature',
    'top_p',
    'top_logprobs',
    'user',
    'store',
    'service_tier',
    'truncation',
    'tool_choice',
    'parallel_tool_calls',
    ...Object.keys(responsesTolerated).filter(
      (k) => !['tool_choice', 'parallel_tool_calls'].includes(k),
    ),
  ],
  claude: [
    'temperature',
    'top_p',
    'top_k',
    'stop_sequences',
    'tool_choice',
    'thinking',
    'service_tier',
  ],
  gemini: ['safetySettings', 'toolConfig', 'cachedContent'],
};

/** Gemini `generationConfig` 里除 `maxOutputTokens` 之外的字段都不转发。 */
const GEMINI_APPLIED = new Set(['maxOutputTokens']);

/** 这次请求里被忽略的参数名（按固定顺序）；不是对象或没有时为空数组。 */
export function ignoredParams(family: ParamFamily, body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const obj = body as Record<string, unknown>;
  const names = IGNORED[family].filter((k) => obj[k] !== undefined);
  if (family === 'gemini') {
    const config = obj.generationConfig;
    if (config && typeof config === 'object' && !Array.isArray(config))
      for (const k of Object.keys(config))
        if (!GEMINI_APPLIED.has(k)) names.push(`generationConfig.${k}`);
  }
  return names;
}

export function ignoredParamsHeader(
  family: ParamFamily | undefined,
  body: unknown,
): string | undefined {
  if (!family) return undefined;
  const names = ignoredParams(family, body);
  return names.length ? names.join(', ') : undefined;
}

/** 把请求的输出长度上限写进元数据（正整数才写）。 */
export function applyMaxTokens(meta: Record<string, string>, value: unknown): void {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    meta['oaa.max_output_tokens'] = String(value);
}

/** 严格端点上不支持的参数：稳定码 `unsupported_parameter`，`param` 是字段名。 */
export function unsupportedParameter(name: string, endpoint: string, hint?: string): CompatFault {
  return new CompatFault(
    'unsupported_parameter',
    `\`${name}\` is not supported on ${endpoint}.${hint ? ` ${hint}` : ''}`,
    400,
    name,
  );
}

const TOOLS_HINT =
  'Caller-defined tools need an explicit mode and are accepted only on the compatibility endpoints: use the Base URL <origin>/v1/compat (or send X-OAA-Compat: true). By default the agent keeps using its own tools; add X-OAA-Client-Tools: bridge to have the agent call yours.';
const FORMAT_HINT =
  'JSON output formats are applied as a best-effort instruction only on the compatibility endpoints (Base URL <origin>/v1/compat, or X-OAA-Compat: true).';

/** 严格 Chat 端点上的工具往返消息（`role: "tool"`、assistant 的 `tool_calls`）：先于 zod，错误点明哪条消息。 */
export function rejectToolMessages(body: unknown, endpoint: string): void {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return;
  messages.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const msg = m as Record<string, unknown>;
    const what =
      msg.role === 'tool' || msg.role === 'function'
        ? 'tool result messages'
        : msg.tool_calls !== undefined || msg.function_call !== undefined
          ? 'assistant tool calls'
          : undefined;
    if (what)
      throw new CompatFault(
        'unsupported_parameter',
        `messages.${i}: ${what} are not supported on ${endpoint}. ${TOOLS_HINT}`,
        400,
        `messages.${i}`,
      );
  });
}

/**
 * 严格端点上「接受字段、但取值会改变请求含义且无法满足」的情形，明确拒绝：
 * 非空工具列表（要选模式）、`logprobs: true`、强制工具调用、非文本输出（模态）、JSON 输出格式。
 * 其余取值（空工具列表、`tool_choice: "auto" | "none"`、`logprobs: false`、`response_format: text`）照常接受。
 */
export function rejectUnsatisfiable(
  family: 'chat' | 'responses',
  body: Record<string, unknown>,
  endpoint: string,
): void {
  const nonEmpty = (v: unknown) =>
    v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
  for (const name of family === 'chat' ? ['tools', 'functions'] : ['tools'])
    if (nonEmpty(body[name])) throw unsupportedParameter(name, endpoint, TOOLS_HINT);
  const choice = body.tool_choice;
  if (choice !== undefined && choice !== null && choice !== 'auto' && choice !== 'none')
    throw unsupportedParameter(
      'tool_choice',
      endpoint,
      'Forcing a tool call is not possible: the agent decides which tools to use. Use "auto" or omit it.',
    );
  if (family === 'responses') {
    const format = (body.text as { format?: { type?: unknown } } | null | undefined)?.format;
    if (format && typeof format === 'object' && format.type !== undefined && format.type !== 'text')
      throw unsupportedParameter('text.format', endpoint, FORMAT_HINT);
    return;
  }
  if (body.logprobs === true)
    throw unsupportedParameter(
      'logprobs',
      endpoint,
      'Token probabilities are not available: an agent run produces text, not logits. Send logprobs=false or omit it.',
    );
  if (Array.isArray(body.modalities) && body.modalities.some((m) => m !== 'text'))
    throw unsupportedParameter('modalities', endpoint, 'Only text output is available.');
  const fc = body.function_call;
  if (fc !== undefined && fc !== null && fc !== 'auto' && fc !== 'none')
    throw unsupportedParameter('function_call', endpoint, TOOLS_HINT);
  const format = body.response_format;
  if (format && typeof format === 'object' && (format as { type?: unknown }).type !== 'text')
    throw unsupportedParameter('response_format', endpoint, FORMAT_HINT);
}

/**
 * `reasoning_effort`（Chat）与 `reasoning.effort`（Responses）是路由提示，不是采样参数：high / xhigh
 * 倾向质量路线，low / minimal 倾向速度路线；调用方已经明确选了路由策略时不覆盖。
 */
export function applyReasoningEffort(meta: Record<string, string>, effort: unknown): void {
  if (typeof effort !== 'string' || !effort) return;
  const level = effort.toLowerCase();
  meta['oaa.reasoning_effort'] = level.slice(0, 32);
  if (meta['oaa.routing_strategy']) return;
  if (level === 'high' || level === 'xhigh') meta['oaa.routing_strategy'] = 'quality';
  else if (level === 'low' || level === 'minimal') meta['oaa.routing_strategy'] = 'speed';
}

/** 兼容入口按渲染协议对应的参数族；UAP 与原生 `/v1/invoke` 没有这类参数。 */
export function paramFamily(path: string, dialect: string): ParamFamily | undefined {
  if (path === '/v1/invoke' || dialect === 'uap') return undefined;
  if (dialect === 'chat' || dialect === 'responses' || dialect === 'claude' || dialect === 'gemini')
    return dialect;
  return undefined;
}

/** 路由解析结果写进元数据（策略、版本、模型链）。 */
export function attachResolutionMetadata(
  base: Record<string, string> | undefined,
  resolved: ModelSelectionResolution,
): Record<string, string> {
  const meta: Record<string, string> = { ...(base ?? {}) };
  if (resolved.strategy && resolved.strategy !== 'auto') {
    meta['oaa.routing_strategy'] = resolved.strategy;
  }
  if (resolved.agent_version) {
    meta['oaa.agent_version'] = resolved.agent_version;
  }
  if (resolved.chain && resolved.chain.length > 1) {
    meta['oaa.model_chain'] = resolved.chain.slice(0, 8).join('|').slice(0, 512);
  }
  return meta;
}
