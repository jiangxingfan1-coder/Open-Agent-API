import { z } from 'zod';
import type { Run } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import {
  extractInlineDirective,
  resolveModelSelector,
  type RoutingStrategy,
} from '../kernel/routing.js';
import { invocationSchema, type ImageInput, type Invocation } from '../kernel/invocation.js';
import { openAIImage } from './image-parts.js';
import { compatInput, strictNoToolsChoice, type ToolsFallback } from './client-tools.js';
import { chatFinish, finishOf, runFailure } from './compat-errors.js';
import {
  applyMaxTokens,
  applyReasoningEffort,
  attachResolutionMetadata,
  chatChecked,
  chatTolerated,
  carriesCallerTools,
  rejectUnsatisfiable,
  responsesChecked,
  responsesTolerated,
  unsupportedParameter,
} from './compat-params.js';
import { chatContract, instructionFor, responsesContract } from './structured-output.js';
import {
  rejectNonMessageItems,
  withoutReasoningItems,
  rejectUnsupportedParts,
  renderOpenAIPart,
  renderToolOutput,
  unsupportedContent,
} from './compat-content.js';

export { attachResolutionMetadata } from './compat-params.js';

/** 严格端点也接受、但不转发的采样类参数（经 X-OAA-Ignored-Params 告知）。 */
const ignoredNumber = z.number().nullish();
const strictCommon = {
  temperature: ignoredNumber,
  top_p: ignoredNumber,
  user: z.string().optional(),
  store: z.boolean().optional(),
  service_tier: z.string().optional(),
};

/**
 * 严格端点的解析：未知字段报 `unsupported_parameter`（`param` 是字段名，说明里指向 compat 端点），
 * 其余校验错误照旧。
 */
function strictParse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  endpoint: string,
  compat: string,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues)
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0 && issue.keys[0])
      throw unsupportedParameter(
        issue.keys[0],
        endpoint,
        `Use ${compat} (or the X-OAA-Compat: true header) for the full parameter set.`,
      );
  throw parsed.error;
}

export {
  invocationSchema,
  previewSchema,
  type Invocation,
  type PreviewRequest,
} from '../kernel/invocation.js';
export { responseObject } from '../kernel/response-object.js';

// Parts and items drop unknown keys (`id`, `status`, `annotations`, `cache_control`, ...): they carry
// bookkeeping, not meaning. `output_text` is how clients replay earlier assistant turns.
const inputPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input_text'), text: z.string().max(200_000) }),
  z.object({ type: z.literal('output_text'), text: z.string().max(200_000) }),
  z.object({ type: z.literal('input_file'), file_id: z.string() }),
  z.object({
    type: z.literal('input_image'),
    image_url: z.string().nullish(),
    file_id: z.string().nullish(),
    detail: z.enum(['auto', 'low', 'high']).nullish(),
  }),
]);

const STRICT_RESPONSES_PARTS = new Set(['input_text', 'output_text', 'input_file', 'input_image']);
const STRICT_CHAT_PARTS = new Set(['text', 'input_text', 'file', 'image_url']);

const responsesSchema = z
  .object({
    model: z.string(),
    input: z.union([
      z.string(),
      z
        .array(
          z.object({
            type: z.literal('message').optional(),
            role: z.enum(['user', 'assistant', 'system', 'developer']),
            content: z.union([z.string(), z.array(inputPart)]),
          }),
        )
        .min(1)
        .max(100),
    ]),
    instructions: z.string().max(200_000).nullish(),
    reasoning: z.object({ effort: z.string().nullish() }).nullish(),
    stream: z.boolean().default(false),
    background: z.boolean().default(false),
    previous_response_id: z.string().optional(),
    metadata: z.record(z.string().max(64), z.string().max(512)).default({}),
    max_output_tokens: z.number().int().positive().optional(),
    ...strictCommon,
    ...responsesTolerated,
    ...responsesChecked,
    top_logprobs: z.number().int().nullish(),
    truncation: z.enum(['auto', 'disabled']).nullish(),
  })
  .strict();

export function parseInvocation(value: unknown, headers?: Record<string, unknown>): Invocation {
  const raw = invocationSchema.parse(value);
  const directive = extractInlineDirective(raw.input);
  const compositeSpec =
    raw.model === 'auto' && (raw.agent.includes('@') || raw.agent.includes(':'))
      ? raw.agent
      : raw.model !== 'auto'
        ? `${raw.agent}@${raw.model}`
        : raw.agent;
  const resolved = resolveModelSelector(compositeSpec, raw.metadata, headers, directive);
  const meta = attachResolutionMetadata(raw.metadata, resolved);
  return invocationSchema.parse({
    ...raw,
    agent: resolved.agent,
    model: resolved.model,
    input: directive.cleanedInput,
    agent_version: raw.agent_version ?? resolved.agent_version,
    metadata: meta,
  });
}

export function parseResponse(value: unknown, headers?: Record<string, unknown>): Invocation {
  value = withoutReasoningItems(value);
  const compatHeader = String(headers?.['x-oaa-compat'] ?? '').toLowerCase();
  if (compatHeader === 'true' || compatHeader === '1') {
    return parseCompatResponse(value, headers);
  }
  // Caller tools (and their calls and results) are handed to the shared compat path; every other
  // field is still checked here, so a typo is not swallowed. A request nobody can bridge is refused
  // there with the message that names the way out.
  if (carriesCallerTools('responses', value)) {
    rejectUnsatisfiable('responses', value as Record<string, unknown>, '/v1/responses');
    strictParse(
      responsesSchema,
      { ...(value as object), input: 'x', tools: undefined },
      '/v1/responses',
      '/v1/compat/responses',
    );
    return parseCompatResponse(value, headers, 'reject');
  }
  rejectNonMessageItems(value, '/v1/compat/responses');
  rejectUnsupportedParts(value, 'input', STRICT_RESPONSES_PARTS);
  const req = strictParse(responsesSchema, value, '/v1/responses', '/v1/compat/responses');
  rejectUnsatisfiable('responses', value as Record<string, unknown>, '/v1/responses');
  const files: string[] = [];
  const contract = responsesContract(req.text);
  const images: ImageInput[] = [];
  const system = req.instructions?.trim() ? `[system]\n${req.instructions.trim()}\n\n` : '';
  const rawText =
    system +
    (typeof req.input === 'string'
      ? req.input
      : req.input
          .map((m, i) => {
            const content =
              typeof m.content === 'string'
                ? m.content
                : m.content
                    .map((p, j) => {
                      if (p.type === 'input_image')
                        return openAIImage(p, `input.${i}.content.${j}`, images)!;
                      if (p.type !== 'input_file') return p.text;
                      files.push(p.file_id);
                      return `[Attached file ${p.file_id}]`;
                    })
                    .join('\n');
            return `[${m.role}]\n${content}`;
          })
          .join('\n\n')) +
    (contract ? `\n\n${instructionFor(contract)}` : '');

  const directive = extractInlineDirective(rawText);
  const rawMeta = { ...req.metadata };
  applyReasoningEffort(rawMeta, req.reasoning?.effort);
  const resolved = resolveModelSelector(req.model, rawMeta, headers, directive);
  const meta = attachResolutionMetadata(rawMeta, resolved);
  applyMaxTokens(meta, req.max_output_tokens);

  return invocationSchema.parse({
    agent: resolved.agent,
    model: resolved.model,
    input: directive.cleanedInput,
    file_ids: [...new Set(files)],
    ...(images.length ? { images } : {}),
    stream: req.stream,
    background: req.background,
    previous_response_id: req.previous_response_id,
    agent_version: resolved.agent_version,
    metadata: meta,
    ...(contract ? { output_contract: contract } : {}),
    ...strictNoToolsChoice('responses', req.tool_choice),
  });
}

const compatResponsesSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.record(z.string(), z.unknown())).min(1).max(200)]),
    instructions: z.string().max(200_000).optional(),
    stream: z.boolean().default(false),
    background: z.boolean().default(false),
    previous_response_id: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    reasoning: z.record(z.string(), z.unknown()).optional(),
    text: z.record(z.string(), z.unknown()).optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    store: z.boolean().optional(),
    user: z.string().optional(),
    truncation: z.unknown().optional(),
  })
  .passthrough();

export function parseCompatResponse(
  value: unknown,
  headers?: Record<string, unknown>,
  fallback: ToolsFallback = 'managed',
): Invocation {
  const req = compatResponsesSchema.parse(withoutReasoningItems(value));
  const files: string[] = [];
  const images: ImageInput[] = [];
  const sections: string[] = [];
  if (req.instructions && req.instructions.trim()) {
    sections.push(`[system]\n${req.instructions.trim()}`);
  }
  const inputText =
    typeof req.input === 'string'
      ? req.input
      : req.input
          .map((item, i) => {
            if (item.type === 'function_call_output') {
              return `[tool:${String(item.call_id ?? 'call')}]\n${renderToolOutput(item.output, `input.${i}.output`, files)}`;
            }
            if (item.type === 'function_call') {
              return `[assistant tool_call:${String(item.name ?? 'fn')}]\n${typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})}`;
            }
            if (item.type !== undefined && item.type !== 'message')
              throw unsupportedContent(
                `input.${i}`,
                `input items of type "${String(item.type)}" are not supported.`,
              );
            const role = typeof item.role === 'string' ? item.role : 'user';
            const rawContent = item.content;
            if (typeof rawContent === 'string') return `[${role}]\n${rawContent}`;
            if (!Array.isArray(rawContent))
              throw unsupportedContent(
                `input.${i}.content`,
                'message content must be a string or an array of content parts.',
              );
            const rendered = rawContent
              .map((p, j) => renderOpenAIPart(p, `input.${i}.content.${j}`, files, images))
              .join('\n');
            return `[${role}]\n${rendered}`;
          })
          .join('\n\n');
  sections.push(inputText);

  const contract = responsesContract(req.text);
  if (contract) sections.push(instructionFor(contract));

  const rawMeta: Record<string, string> = {};
  if (req.metadata) {
    for (const [k, v] of Object.entries(req.metadata)) {
      if (typeof v === 'string' && k.length <= 64 && v.length <= 512) rawMeta[k] = v;
    }
  }
  rawMeta['oaa.compat_mode'] = 'true';
  applyReasoningEffort(rawMeta, req.reasoning?.effort);
  if (req.max_output_tokens !== undefined) {
    rawMeta['oaa.compat_max_tokens'] = String(req.max_output_tokens);
  }
  if (req.temperature !== undefined) {
    rawMeta['oaa.compat_temperature'] = String(req.temperature);
  }

  const directive = extractInlineDirective(sections.join('\n\n'));
  const resolved = resolveModelSelector(req.model, rawMeta, headers, directive);
  const meta = attachResolutionMetadata(rawMeta, resolved);

  return invocationSchema.parse({
    agent: resolved.agent,
    model: resolved.model,
    ...compatInput('responses', req, headers, meta, directive.cleanedInput, fallback),
    file_ids: [...new Set(files)],
    ...(images.length ? { images } : {}),
    stream: req.stream,
    background: req.background,
    previous_response_id: req.previous_response_id,
    agent_version: resolved.agent_version,
    metadata: meta,
    ...(contract ? { output_contract: contract } : {}),
  });
}

// Unknown keys on parts are dropped (`cache_control` markers and similar bookkeeping).
const chatContentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(200_000) }),
  z.object({ type: z.literal('input_text'), text: z.string().max(200_000) }),
  z.object({ type: z.literal('file'), file: z.object({ file_id: z.string() }) }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string(), detail: z.enum(['auto', 'low', 'high']).nullish() }),
  }),
]);

const chatSchema = z
  .object({
    model: z.string(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant', 'system', 'developer']),
            content: z.union([z.string().max(200_000), z.array(chatContentPart).min(1).max(100)]),
            name: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    stream: z.boolean().default(false),
    // `include_usage` is honoured; other keys (`include_obfuscation`, ...) are dropped.
    stream_options: z.object({ include_usage: z.boolean().nullish() }).nullish(),
    metadata: z.record(z.string(), z.string()).optional(),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
    ...strictCommon,
    ...chatTolerated,
    ...chatChecked,
    reasoning_effort: z.string().nullish(),
    seed: ignoredNumber,
    stop: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
    presence_penalty: ignoredNumber,
    frequency_penalty: ignoredNumber,
    n: z.number().int().nullish(),
  })
  .strict();

export function parseChat(value: unknown, headers?: Record<string, unknown>): Invocation {
  const compatHeader = String(headers?.['x-oaa-compat'] ?? '').toLowerCase();
  if (compatHeader === 'true' || compatHeader === '1') {
    return parseCompatChat(value, headers);
  }
  if (carriesCallerTools('chat', value)) {
    rejectUnsatisfiable('chat', value as Record<string, unknown>, '/v1/chat/completions');
    strictParse(
      chatSchema,
      { ...(value as object), messages: [{ role: 'user', content: 'x' }], tools: undefined },
      '/v1/chat/completions',
      '/v1/compat/chat/completions',
    );
    return parseCompatChat(value, headers, 'reject');
  }
  rejectUnsupportedParts(value, 'messages', STRICT_CHAT_PARTS);
  const req = strictParse(chatSchema, value, '/v1/chat/completions', '/v1/compat/chat/completions');
  rejectUnsatisfiable('chat', value as Record<string, unknown>, '/v1/chat/completions');
  if (req.n !== undefined && req.n !== null && req.n !== 1)
    throw unsupportedParameter(
      'n',
      '/v1/chat/completions',
      'Only n=1 is supported: an agent returns one answer per run.',
    );
  // Same as OpenAI: stream_options is only valid together with stream=true.
  if (req.stream_options && !req.stream)
    throw new Fault('invalid_request', 'stream_options requires stream=true.');

  const files: string[] = [];
  const images: ImageInput[] = [];
  const rawInput = req.messages
    .map((m, i) => {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((p, j) => {
                if (p.type === 'image_url')
                  return openAIImage(p, `messages.${i}.content.${j}`, images)!;
                if (p.type === 'file') {
                  files.push(p.file.file_id);
                  return `[Attached file ${p.file.file_id}]`;
                }
                return p.text;
              })
              .join('\n');
      return `[${m.role}]\n${content}`;
    })
    .join('\n\n');
  const contract = chatContract(req.response_format);
  const rawInputWithFormat = contract ? `${rawInput}\n\n${instructionFor(contract)}` : rawInput;

  const directive = extractInlineDirective(rawInputWithFormat);
  const rawMeta = { ...req.metadata };
  applyReasoningEffort(rawMeta, req.reasoning_effort);
  const resolved = resolveModelSelector(req.model, rawMeta, headers, directive);
  const meta = attachResolutionMetadata(rawMeta, resolved);
  applyMaxTokens(meta, req.max_completion_tokens ?? req.max_tokens);

  return invocationSchema.parse({
    agent: resolved.agent,
    model: resolved.model,
    input: directive.cleanedInput,
    file_ids: [...new Set(files)],
    ...(images.length ? { images } : {}),
    stream: req.stream,
    metadata: meta,
    agent_version: resolved.agent_version,
    ...(contract ? { output_contract: contract } : {}),
    ...strictNoToolsChoice('chat', req.tool_choice),
  });
}

const compatChatSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant', 'system', 'developer', 'tool', 'function']),
            content: z
              .union([
                z.string().max(200_000),
                z.array(z.record(z.string(), z.unknown())).max(100),
                z.null(),
              ])
              .optional(),
            name: z.string().optional(),
            tool_call_id: z.string().optional(),
            tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(200),
    stream: z.boolean().default(false),
    stream_options: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    reasoning_effort: z.string().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: z.record(z.string(), z.unknown()).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    user: z.string().optional(),
    store: z.boolean().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    seed: z.number().optional(),
    n: z.number().optional(),
  })
  .passthrough();

export function parseCompatChat(
  value: unknown,
  headers?: Record<string, unknown>,
  fallback: ToolsFallback = 'managed',
): Invocation {
  const req = compatChatSchema.parse(value);
  const files: string[] = [];
  const images: ImageInput[] = [];
  const renderedMessages = req.messages.map((m, i) => {
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((p, j) => renderOpenAIPart(p, `messages.${i}.content.${j}`, files, images))
        .join('\n');
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const callsText = m.tool_calls
        .map((tc) => {
          const fn = (tc.function ?? {}) as { name?: unknown; arguments?: unknown };
          return `${fn.name ?? 'tool'}(${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})})`;
        })
        .join(', ');
      text = text ? `${text}\n[tool_calls: ${callsText}]` : `[tool_calls: ${callsText}]`;
    }
    const label =
      m.role === 'tool' || m.role === 'function'
        ? `tool${m.tool_call_id ? `:${m.tool_call_id}` : m.name ? `:${m.name}` : ''}`
        : m.role;
    return `[${label}]\n${text}`;
  });

  const contract = chatContract(req.response_format);
  if (contract) renderedMessages.push(instructionFor(contract));

  const rawMeta: Record<string, string> = {};
  if (req.metadata) {
    for (const [k, v] of Object.entries(req.metadata)) {
      if (typeof v === 'string' && k.length <= 64 && v.length <= 512) rawMeta[k] = v;
    }
  }
  rawMeta['oaa.compat_mode'] = 'true';
  applyReasoningEffort(rawMeta, req.reasoning_effort);
  const maxTok = req.max_completion_tokens ?? req.max_tokens;
  if (maxTok !== undefined) rawMeta['oaa.compat_max_tokens'] = String(maxTok);
  if (req.temperature !== undefined) rawMeta['oaa.compat_temperature'] = String(req.temperature);
  if (typeof req.response_format?.type === 'string') {
    rawMeta['oaa.response_format'] = req.response_format.type.slice(0, 64);
  }

  const directive = extractInlineDirective(renderedMessages.join('\n\n'));
  const resolved = resolveModelSelector(req.model, rawMeta, headers, directive);
  const meta = attachResolutionMetadata(rawMeta, resolved);

  return invocationSchema.parse({
    agent: resolved.agent,
    model: resolved.model,
    ...compatInput('chat', req, headers, meta, directive.cleanedInput, fallback),
    file_ids: [...new Set(files)],
    ...(images.length ? { images } : {}),
    stream: req.stream,
    metadata: meta,
    agent_version: resolved.agent_version,
    ...(contract ? { output_contract: contract } : {}),
  });
}

export function chatUsage(run: Run) {
  return run.usage && run.metadata['oaa.usage_complete'] !== 'false'
    ? {
        prompt_tokens: run.usage.input_tokens,
        completion_tokens: run.usage.output_tokens,
        total_tokens: run.usage.total_tokens,
      }
    : null;
}

/** 截断（`max_output_tokens`）时照常 200，`finish_reason: "length"`。 */
export function chatObject(run: Run): Record<string, unknown> {
  const finish = finishOf(run);
  if (finish === 'failure') throw runFailure(run);
  return {
    id: `chatcmpl_${run.id}`,
    object: 'chat.completion',
    created: Math.floor(run.createdAt / 1000),
    model: run.agentId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: run.output.map((m) => m.text).join('\n\n'),
          refusal: null,
        },
        finish_reason: chatFinish(finish),
      },
    ],
    usage: chatUsage(run) ?? undefined,
  };
}

export { claudeMessagesSchema, parseClaudeMessages, claudeMessageObject } from './claude.js';

export * from '../kernel/routing.js';
