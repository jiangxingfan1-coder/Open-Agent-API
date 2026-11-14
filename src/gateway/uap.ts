import { z } from 'zod';
import type { Run } from '../core/contracts.js';
import {
  extractInlineDirective,
  invocationSchema,
  resolveModelSelector,
  type Invocation,
  type RoutingStrategy,
} from './protocol.js';
import { Fault } from '../core/util.js';
import {
  bridgeFieldsOrFallback,
  forcedToolChoice,
  geminiBridgeFields,
  geminiToolCount,
  withClientTools,
} from './client-tools.js';
import { CompatFault, finishOf, geminiFinish, runFailure } from './compat-errors.js';
import { applyMaxTokens } from './compat-params.js';
import { camelizeGeminiBody } from './gemini.js';
import { geminiContract, instructionFor } from './structured-output.js';

type GeminiPart = z.infer<typeof geminiPartSchema>;

/**
 * Gemini 的一个 part 渲染成文本：text 原样；`fileData`（`oaa://files/<id>` 或文件 ID）作为附件；
 * functionCall / functionResponse 用与 Responses 兼容入口相同的标注写法；`thought` 部分不交给
 * 智能体；`inlineData` 等其它内容明确拒绝，不把 base64 塞进提示词。
 */
function renderGeminiPart(p: GeminiPart, param: string, files: string[]): string | undefined {
  if (p.thought === true) return undefined;
  if (typeof p.text === 'string') return p.text;
  if (p.fileData?.fileUri) {
    const uri = p.fileData.fileUri.replace(/^oaa:\/\/files\//, '');
    files.push(uri);
    return `[Attached file ${uri}]`;
  }
  const call = p.functionCall as { name?: unknown; args?: unknown } | undefined;
  if (call && typeof call === 'object')
    return `[assistant tool_call:${String(call.name ?? 'fn')}]\n${JSON.stringify(call.args ?? {})}`;
  const result = p.functionResponse as { name?: unknown; response?: unknown } | undefined;
  if (result && typeof result === 'object')
    return `[tool:${String(result.name ?? 'fn')}]\n${JSON.stringify(result.response ?? {})}`;
  const kind = Object.keys(p)[0] ?? 'empty';
  throw new CompatFault(
    'unsupported_content',
    `${param}: parts with "${kind}" are not supported. The agent receives text and files only: upload the file with POST /v1/files and reference it as {"fileData":{"fileUri":"oaa://files/<file_id>"}}.`,
    400,
    param,
  );
}

// ---------------------------------------------------------------------------
// 1. UAP/1 (Unified Agent Protocol v1.0) Schema, Parser & Wire Codec
// ---------------------------------------------------------------------------

const uapContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(200_000) }).strict(),
  z.object({ type: z.literal('input_text'), text: z.string().max(200_000) }).strict(),
  z.object({ type: z.literal('file'), file_id: z.string().min(1).max(120) }).strict(),
  z.object({ type: z.literal('input_file'), file_id: z.string().min(1).max(120) }).strict(),
]);

const uapMessageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string().max(200_000), z.array(uapContentBlock).min(1).max(100)]),
  })
  .strict();

export const uapRequestSchema = z
  .object({
    uap: z.literal('1.0').default('1.0'),
    target: z.string().min(1).max(240).optional(),
    agent: z.string().min(1).max(240).optional(),
    model: z.string().min(1).max(200).optional(),
    system: z.string().max(100_000).optional(),
    input: z
      .union([z.string().min(1).max(200_000), z.array(uapMessageSchema).min(1).max(100)])
      .optional(),
    messages: z.array(uapMessageSchema).min(1).max(100).optional(),
    files: z.array(z.string().min(1).max(120)).max(20).optional(),
    session: z
      .object({
        previous_id: z.string().optional(),
        agent_version: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .optional(),
    routing: z
      .object({
        strategy: z.enum(['auto', 'speed', 'cost', 'quality', 'balanced']).optional(),
        fallback_chain: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
      })
      .strict()
      .optional(),
    delivery: z
      .object({
        stream: z.boolean().optional(),
        background: z.boolean().optional(),
        format: z.enum(['json', 'sse', 'uap-ndjson']).optional(),
      })
      .strict()
      .optional(),
    stream: z.boolean().optional(),
    background: z.boolean().optional(),
    metadata: z.record(z.string().max(64), z.string().max(512)).optional(),
  })
  .strict();

export type UapDeliveryFormat = 'json' | 'sse' | 'uap-ndjson';

export interface ParsedUapEnvelope {
  invocation: Invocation;
  format: UapDeliveryFormat;
}

export function parseUapRequest(
  value: unknown,
  headers?: Record<string, unknown>,
): ParsedUapEnvelope {
  const req = uapRequestSchema.parse(value);
  const rawTarget = req.target ?? req.agent ?? req.model;
  if (!rawTarget) {
    throw new Fault('invalid_request', 'UAP/1 request requires target (or agent).');
  }

  const files: string[] = [...(req.files ?? [])];
  const segments: string[] = [];

  if (req.system) {
    segments.push(`[system]\n${req.system}`);
  }

  const msgList = Array.isArray(req.input) ? req.input : req.messages;
  if (typeof req.input === 'string') {
    segments.push(req.input);
  } else if (msgList) {
    for (const m of msgList) {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) => {
                if (b.type === 'file' || b.type === 'input_file') {
                  files.push(b.file_id);
                  return `[Attached file ${b.file_id}]`;
                }
                return b.text;
              })
              .join('\n');
      segments.push(`[${m.role}]\n${text}`);
    }
  } else {
    throw new Fault('invalid_request', 'UAP/1 request requires input or messages.');
  }

  const combinedRaw = segments.join('\n\n');
  const directive = extractInlineDirective(combinedRaw);

  // Merge explicit model / fallback_chain into composite target if target didn't specify @/:
  let selectorInput = rawTarget;
  if (!selectorInput.includes('@') && !selectorInput.includes(':')) {
    if (req.routing?.fallback_chain?.length) {
      selectorInput = `${selectorInput}@${req.routing.fallback_chain.join('|')}`;
    } else if (req.model && req.target) {
      selectorInput = `${selectorInput}@${req.model}`;
    } else if (req.model && req.agent) {
      selectorInput = `${selectorInput}@${req.model}`;
    }
  }

  const meta: Record<string, string> = { ...(req.metadata ?? {}) };
  if (req.routing?.strategy && !meta['oaa.routing_strategy']) {
    meta['oaa.routing_strategy'] = req.routing.strategy;
  }

  const resolved = resolveModelSelector(selectorInput, meta, headers, directive);
  const finalStrategy: RoutingStrategy | undefined = req.routing?.strategy ?? resolved.strategy;
  if (finalStrategy && finalStrategy !== 'auto') {
    meta['oaa.routing_strategy'] = finalStrategy;
  }
  const finalVersion = req.session?.agent_version ?? resolved.agent_version;
  if (finalVersion) {
    meta['oaa.agent_version'] = finalVersion;
  }
  const chain = req.routing?.fallback_chain ?? resolved.chain;
  if (chain && chain.length > 1) {
    meta['oaa.model_chain'] = chain.slice(0, 8).join('|').slice(0, 512);
  }

  const acceptHeader = String(headers?.['accept'] ?? '').toLowerCase();
  const streamRequested =
    req.delivery?.stream ??
    req.stream ??
    (req.delivery?.format === 'sse' ||
      req.delivery?.format === 'uap-ndjson' ||
      acceptHeader.includes('application/x-ndjson'));

  const format: UapDeliveryFormat =
    req.delivery?.format ??
    (acceptHeader.includes('application/x-ndjson')
      ? 'uap-ndjson'
      : streamRequested
        ? 'uap-ndjson'
        : 'json');

  const invocation = invocationSchema.parse({
    agent: resolved.agent,
    model: resolved.model,
    input: directive.cleanedInput,
    file_ids: [...new Set(files)],
    previous_response_id: req.session?.previous_id,
    agent_version: finalVersion,
    background: req.delivery?.background ?? req.background ?? false,
    stream: Boolean(streamRequested),
    metadata: meta,
  });

  return { invocation, format };
}

export function uapResponseObject(run: Run): Record<string, unknown> {
  return {
    uap: '1.0',
    id: run.id,
    status: run.status,
    agent: {
      id: run.agentId,
      version: run.digest,
    },
    session_id: run.sessionId,
    previous_id: run.previousId,
    route: {
      id: run.route.id,
      provider: run.route.provider,
      model: run.route.model,
      mode: run.route.mode,
      failover_from: run.metadata['oaa.failover_from'] ?? null,
    },
    output: {
      text: run.output.map((m) => m.text).join('\n\n'),
      messages: run.output.map((m) => ({
        id: m.id,
        role: 'assistant',
        status: m.status ?? (run.status === 'completed' ? 'completed' : 'incomplete'),
        blocks: [{ type: 'text', text: m.text }],
      })),
    },
    artifacts: run.artifactIds,
    usage: run.usage ? { ...run.usage } : null,
    error: run.error,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    metadata: run.metadata,
  };
}

// ---------------------------------------------------------------------------
// 2. Google Gemini API (/v1beta/models/{agent}:generateContent) Codec
// ---------------------------------------------------------------------------

const geminiPartSchema = z
  .object({
    text: z.string().max(200_000).optional(),
    fileData: z
      .object({
        fileUri: z.string().max(512),
        mimeType: z.string().max(120).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const geminiContentSchema = z
  .object({
    role: z.enum(['user', 'model', 'system', 'function']).optional(),
    parts: z.array(geminiPartSchema).min(1).max(100),
  })
  .passthrough();

export const geminiGenerateSchema = z
  .object({
    model: z.string().min(1).max(240).optional(),
    contents: z.union([geminiContentSchema, z.array(geminiContentSchema).min(1).max(100)]),
    systemInstruction: z
      .union([
        z.string().max(100_000),
        z.object({ parts: z.array(geminiPartSchema).min(1) }).passthrough(),
      ])
      .optional(),
    generationConfig: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

/** Gemini's forced function calling: `toolConfig.functionCallingConfig.mode: "ANY"`. */
const geminiToolChoice = (req: object) =>
  ((req as { toolConfig?: { functionCallingConfig?: unknown } }).toolConfig ?? {})
    .functionCallingConfig;

export function parseGeminiGenerateContent(
  value: unknown,
  targetFromPath?: string,
  stream = false,
  headers?: Record<string, unknown>,
): Invocation {
  const req = geminiGenerateSchema.parse(camelizeGeminiBody(value));
  const rawModel = targetFromPath ?? req.model;
  if (!rawModel) {
    throw new Fault('invalid_request', 'Gemini request requires model in URL path or body.');
  }

  const segments: string[] = [];
  const files: string[] = [];

  if (req.systemInstruction) {
    const sysText =
      typeof req.systemInstruction === 'string'
        ? req.systemInstruction
        : req.systemInstruction.parts
            .map((p) => p.text ?? '')
            .filter(Boolean)
            .join('\n');
    if (sysText) segments.push(`[system]\n${sysText}`);
  }

  const contents = Array.isArray(req.contents) ? req.contents : [req.contents];
  contents.forEach((item, i) => {
    const role = item.role === 'model' ? 'assistant' : (item.role ?? 'user');
    const text = item.parts
      .map((p, j) => renderGeminiPart(p, `contents.${i}.parts.${j}`, files))
      .filter((t): t is string => t !== undefined)
      .join('\n');
    segments.push(`[${role}]\n${text}`);
  });

  const contract = geminiContract(req.generationConfig);
  if (contract) segments.push(`[user]\n${instructionFor(contract)}`);
  const directive = extractInlineDirective(segments.join('\n\n'));
  const resolved = resolveModelSelector(rawModel, req.metadata, headers, directive);
  const meta: Record<string, string> = { ...(req.metadata ?? {}) };
  if (resolved.strategy && resolved.strategy !== 'auto') {
    meta['oaa.routing_strategy'] = resolved.strategy;
  }
  if (resolved.agent_version) {
    meta['oaa.agent_version'] = resolved.agent_version;
  }
  if (resolved.chain && resolved.chain.length > 1) {
    meta['oaa.model_chain'] = resolved.chain.slice(0, 8).join('|').slice(0, 512);
  }
  applyMaxTokens(meta, req.generationConfig?.maxOutputTokens);

  const input = withClientTools(req.tools, headers, meta, directive.cleanedInput, {
    count: geminiToolCount(req.tools),
    forced: forcedToolChoice(geminiToolChoice(req)),
  });
  return invocationSchema.parse({
    agent: resolved.agent,
    model: resolved.model,
    input,
    ...bridgeFieldsOrFallback(meta, () => geminiBridgeFields(req.tools, contents, meta)),
    file_ids: [...new Set(files)],
    stream,
    metadata: meta,
    agent_version: resolved.agent_version,
    ...(contract ? { output_contract: contract } : {}),
  });
}

export function geminiResponseObject(run: Run): Record<string, unknown> {
  const finish = finishOf(run);
  if (finish === 'failure') throw runFailure(run);

  return {
    responseId: run.id,
    modelVersion: `${run.agentId}@${run.route.model}`,
    candidates: [
      {
        index: 0,
        content: {
          role: 'model',
          parts: [{ text: run.output.map((m) => m.text).join('\n\n') }],
        },
        finishReason: geminiFinish(finish),
      },
    ],
    usageMetadata: {
      promptTokenCount: run.usage?.input_tokens ?? 0,
      candidatesTokenCount: run.usage?.output_tokens ?? 0,
      totalTokenCount: run.usage?.total_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. O(1) Structural Protocol Dialect Auto-Detector (/v1/universal)
// ---------------------------------------------------------------------------

export type ProtocolDialect = 'uap' | 'oaa' | 'gemini' | 'claude' | 'chat' | 'responses';
const DIALECTS: readonly ProtocolDialect[] = [
  'uap',
  'oaa',
  'gemini',
  'claude',
  'chat',
  'responses',
];

const CLAUDE_BLOCKS = new Set([
  'image',
  'document',
  'tool_use',
  'tool_result',
  'thinking',
  'redacted_thinking',
]);
const CHAT_PARTS = new Set(['image_url', 'input_audio', 'file', 'refusal']);
const CHAT_FIELDS = [
  'stream_options',
  'n',
  'response_format',
  'max_completion_tokens',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'stop',
  'parallel_tool_calls',
  'reasoning_effort',
];
const CLAUDE_FIELDS = ['anthropic_version', 'stop_sequences', 'top_k', 'thinking'];
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * 带 `messages` 的请求是 Claude 还是 Chat：只看各家独有的请求头与结构特征。
 * `max_tokens`、字符串 `system`、`model`、`stream`、`metadata` 两家都可能出现，不参与判断。
 */
function messagesDialect(obj: Record<string, unknown>, headers?: Record<string, unknown>) {
  let claude =
    headers?.['anthropic-version'] !== undefined ||
    headers?.['x-api-key'] !== undefined ||
    Array.isArray(obj.system) ||
    CLAUDE_FIELDS.some((k) => k in obj);
  let chat = CHAT_FIELDS.some((k) => k in obj);
  const choice = rec(obj.tool_choice);
  if (choice?.type === 'function') chat = true;
  else if (choice && ['auto', 'any', 'tool', 'none'].includes(String(choice.type))) claude = true;
  for (const t of Array.isArray(obj.tools) ? obj.tools : []) {
    const tool = rec(t);
    if (tool?.type === 'function' && rec(tool.function)) chat = true;
    if (tool && 'input_schema' in tool) claude = true;
  }
  for (const m of Array.isArray(obj.messages) ? obj.messages : []) {
    const msg = rec(m);
    if (!msg) continue;
    if (['system', 'developer', 'tool', 'function'].includes(String(msg.role))) chat = true;
    if ('tool_calls' in msg || 'tool_call_id' in msg) chat = true;
    for (const p of Array.isArray(msg.content) ? msg.content : []) {
      const type = String(rec(p)?.type ?? '');
      if (CLAUDE_BLOCKS.has(type)) claude = true;
      if (CHAT_PARTS.has(type)) chat = true;
    }
  }
  return claude === chat ? undefined : claude ? 'claude' : 'chat';
}

/**
 * `/v1/universal` 的协议识别。`X-OAA-Protocol` 显式指明时以它为准；否则按结构判断，判定不了
 * （两家的特征都没有，或者都有）时报 `protocol_undetected`，不猜。
 */
export function detectProtocolDialect(
  body: unknown,
  headers?: Record<string, unknown>,
): ProtocolDialect {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Fault('invalid_request', 'Request body must be a JSON object.');
  }
  const obj = body as Record<string, unknown>;
  const explicit = headers?.['x-oaa-protocol'];
  if (explicit !== undefined) {
    const named = String(explicit).trim().toLowerCase();
    if (!(DIALECTS as readonly string[]).includes(named))
      throw new Fault('invalid_request', `X-OAA-Protocol must be one of ${DIALECTS.join(', ')}.`);
    return named as ProtocolDialect;
  }

  if ('uap' in obj || 'target' in obj || 'delivery' in obj || 'routing' in obj) {
    return 'uap';
  }
  if (obj.protocol === 'oaa/1' || ('agent' in obj && 'input' in obj)) {
    return 'oaa';
  }
  if ('contents' in obj) {
    return 'gemini';
  }
  if ('messages' in obj) {
    const found = messagesDialect(obj, headers);
    if (found) return found;
    throw new Fault(
      'protocol_undetected',
      'Cannot tell whether this is an OpenAI Chat Completions or a Claude Messages request. Call /v1/chat/completions or /v1/messages directly, or name the protocol with the X-OAA-Protocol header (chat or claude).',
    );
  }
  if ('input' in obj && 'model' in obj) {
    return 'responses';
  }

  throw new Fault(
    'invalid_request',
    'Unable to auto-detect API protocol dialect. Provide UAP/1, OAA/1, OpenAI Responses, OpenAI Chat, Claude Messages, or Gemini GenerateContent payload, or name it with the X-OAA-Protocol header.',
  );
}
