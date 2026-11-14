/**
 * Anthropic Claude Messages API（`/v1/messages`、`/v1/compat/messages`）的请求转译与响应对象。
 * 字段依据：https://platform.claude.com/docs/en/api/messages 。
 */
import { claudeModelInfo } from './compat-models.js';
import { z } from 'zod';
import type { Run } from '../core/contracts.js';
import { extractInlineDirective, resolveModelSelector } from '../kernel/routing.js';
import { invocationSchema, type Invocation } from '../kernel/invocation.js';
import { compatInput } from './client-tools.js';
import { CompatFault, claudeStop, finishOf, runFailure } from './compat-errors.js';
import { applyMaxTokens, attachResolutionMetadata } from './compat-params.js';

const claudeMessageItem = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(200_000), z.array(z.record(z.string(), z.unknown())).max(100)]),
});

export const claudeMessagesSchema = z
  .object({
    model: z.string(),
    messages: z.array(claudeMessageItem).min(1).max(100),
    system: z
      .union([z.string().max(200_000), z.array(z.record(z.string(), z.unknown()))])
      .optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().default(false),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type Block = Record<string, unknown>;

const unsupported = (param: string, what: string) =>
  new CompatFault(
    'unsupported_content',
    `${param}: ${what} The agent receives text and files only: upload the file with POST /v1/files and reference it as {"type":"image"|"document","source":{"type":"file","file_id":"…"}}.`,
    400,
    param,
  );

/** `tool_result.content`：字符串或 text 块；其它块（图片等）拒绝。 */
function toolResultText(content: unknown, param: string): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content))
    throw unsupported(
      `${param}.content`,
      'tool_result content must be a string or an array of text blocks.',
    );
  return content
    .map((b: Block, k) => {
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      throw unsupported(
        `${param}.content.${k}`,
        `tool_result blocks of type "${String(b?.type)}" are not supported.`,
      );
    })
    .join('\n');
}

/**
 * 一个内容块渲染成交给智能体的文本：text 原样；`source.type: "file"` 的 image / document 作为附件；
 * tool_use / tool_result 用与 Responses 兼容入口相同的标注写法；thinking 块是模型自己的推理，
 * 不交给智能体；其余（base64 或 URL 图片、未知类型）明确拒绝，不把原始 JSON 塞进提示词。
 */
function renderBlock(b: Block, param: string, files: string[]): string | undefined {
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  if (b.type === 'image' || b.type === 'document') {
    const source = (b.source ?? {}) as Block;
    if (source.type === 'file' && typeof source.file_id === 'string') {
      files.push(source.file_id);
      return `[Attached file ${source.file_id}]`;
    }
    throw unsupported(
      param,
      `${b.type} blocks with source type "${String(source.type)}" are not supported.`,
    );
  }
  if (b.type === 'tool_use')
    return `[assistant tool_call:${String(b.name ?? 'tool')}]\n${JSON.stringify(b.input ?? {})}`;
  if (b.type === 'tool_result') {
    const text = toolResultText(b.content, param);
    return `[tool:${String(b.tool_use_id ?? 'call')}]\n${b.is_error === true ? `[error] ${text}` : text}`;
  }
  if (b.type === 'thinking' || b.type === 'redacted_thinking') return undefined;
  throw unsupported(param, `content blocks of type "${String(b.type)}" are not supported.`);
}

export function parseClaudeMessages(value: unknown, headers?: Record<string, unknown>): Invocation {
  const req = claudeMessagesSchema.parse(value);
  const parts: string[] = [];
  const files: string[] = [];

  // system 不截断、不丢弃；整体长度受 invocation 的输入上限约束，
  // 超限时报 invalid_request，与其它入口一致。
  if (req.system) {
    const sysText =
      typeof req.system === 'string'
        ? req.system
        : req.system
            .map((p, k) => {
              if (p.type === 'text' && typeof p.text === 'string') return p.text;
              throw unsupported(
                `system.${k}`,
                `system blocks of type "${String(p.type)}" are not supported.`,
              );
            })
            .filter(Boolean)
            .join('\n');
    if (sysText) parts.push(`[system]\n${sysText}`);
  }

  req.messages.forEach((m, i) => {
    let contentText = '';
    if (typeof m.content === 'string') {
      contentText = m.content;
    } else if (Array.isArray(m.content)) {
      contentText = m.content
        .map((p, j) => renderBlock(p, `messages.${i}.content.${j}`, files))
        .filter((t): t is string => t !== undefined)
        .join('\n');
    }
    if (parts.length === 0 && req.messages.length === 1 && m.role === 'user') {
      parts.push(contentText);
    } else {
      parts.push(`[${m.role}]\n${contentText}`);
    }
  });

  const stringMeta = req.metadata
    ? Object.fromEntries(
        Object.entries(req.metadata).filter(([, v]) => typeof v === 'string') as [string, string][],
      )
    : undefined;

  const directive = extractInlineDirective(parts.join('\n\n'));
  const resolved = resolveModelSelector(req.model, stringMeta, headers, directive);
  const meta = attachResolutionMetadata(stringMeta, resolved);
  applyMaxTokens(meta, req.max_tokens);

  return invocationSchema.parse({
    agent: resolved.agent,
    model: resolved.model,
    ...compatInput('claude', req, headers, meta, directive.cleanedInput),
    ...(files.length ? { file_ids: [...new Set(files)] } : {}),
    stream: req.stream,
    metadata: meta,
    agent_version: resolved.agent_version,
  });
}

type Tokens = { input_tokens?: number; output_tokens?: number } | null | undefined;

/**
 * SDK（@anthropic-ai/sdk 1.3.0，resources/messages/messages.d.ts）的 `Usage` 里必有、可为 null 的字段。
 * 网关不做提示缓存计数，也没有地域、服务档位、速度、服务端工具这些信息，一律 null。
 */
export const claudeUsage = (usage: Tokens) => ({
  input_tokens: usage?.input_tokens ?? 0,
  output_tokens: usage?.output_tokens ?? 0,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  cache_creation: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  inference_geo: null,
  speed: null,
});

/** 流式 `message_delta` 的 `MessageDeltaUsage`：同理，非可选字段补 null。 */
export const claudeDeltaUsage = (usage: Tokens) => ({
  input_tokens: usage?.input_tokens ?? 0,
  output_tokens: usage?.output_tokens ?? 0,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  output_tokens_details: null,
  server_tool_use: null,
});

/** `message_delta` 的 `delta`：`container`、`stop_details` 必有可为 null（SDK 的 finalMessage 照抄 stop_details）。 */
export const claudeDelta = (stopReason: string | null) => ({
  stop_reason: stopReason,
  stop_sequence: null,
  stop_details: null,
  container: null,
});

/** `Message` 外壳；`container`、`diagnostics`、`stop_details`（只用于拒答）网关都没有，给 null。 */
export const claudeMessage = (
  id: string,
  model: string,
  content: unknown[],
  stopReason: string | null,
  usage: Tokens,
): Record<string, unknown> => ({
  id: `msg_${id}`,
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  stop_details: null,
  container: null,
  diagnostics: null,
  usage: claudeUsage(usage),
});

export function claudeMessageObject(run: Run): Record<string, unknown> {
  const finish = finishOf(run);
  if (finish === 'failure') throw runFailure(run);
  const fullText = run.output.map((m) => m.text).join('\n\n');
  return claudeMessage(
    run.id,
    run.agentId,
    [{ type: 'text', text: fullText }],
    claudeStop(finish),
    run.usage,
  );
}

/**
 * `GET /v1/models` 对 Claude 客户端（带 `anthropic-version`）的形状：官方 SDK `models.list()` 的
 * ModelInfo 与游标分页（`has_more`、`first_id`、`last_id`）。没有发布日期，`created_at` 用纪元时间
 * （官方字段说明允许）；网关不知道的能力与上限给 null。
 */
export function claudeModelList(agents: readonly { id: string }[]): Record<string, unknown> {
  return {
    data: agents.map(claudeModelInfo),
    has_more: false,
    first_id: agents[0]?.id ?? null,
    last_id: agents.at(-1)?.id ?? null,
  };
}
