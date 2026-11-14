/**
 * 兼容入口里「接受但不转发」的参数与输出长度上限。
 *
 * 调用的是智能体：采样类参数由发布者在智能体里决定，网关不转发，但在响应头
 * `X-OAA-Ignored-Params` 里列出这次请求里被忽略的参数名（没有时不出现这个头）。输出长度上限
 * 写进 `metadata["oaa.max_output_tokens"]`，内核取它与智能体自身 `limits.maxOutputTokens`
 * 的较小者（kernel/invocation.ts `outputTokenCap`）。
 */
import type { ModelSelectionResolution } from '../kernel/routing.js';
import { CompatFault } from './compat-errors.js';

export type ParamFamily = 'chat' | 'responses' | 'claude' | 'gemini';

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
