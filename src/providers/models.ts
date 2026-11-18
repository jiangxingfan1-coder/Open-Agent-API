import type { AgentDefinition, ModelMessage, ModelResult, ToolCall } from '../core/contracts.js';
import type {
  AnthropicBlock,
  AnthropicDelta,
  AnthropicEvent,
  ChatChoice,
  ChatChunk,
  GeminiCall,
  GeminiChunk,
  ResponsesEvent,
  ResponsesFinal,
  Wire,
} from './model-wire.js';
import type { ProviderConfig } from '../config/config.js';
import { validateEndpoint } from '../config/config.js';
import { Fault, checkAbort } from '../core/util.js';
import { readSseStream } from './http-stream.js';
import { providerApiKey, providerKeyHint } from './provider-key.js';
export { providerApiKey } from './provider-key.js';
import { upstreamFault } from './upstream-errors.js';
import * as imageWire from './image-wire.js';
import type { ProviderImageInput } from './image-wire.js';
import {
  captureProviderState,
  checkProviderStateProtocol,
  replayProviderState,
} from './provider-state.js';
import * as structuredWire from './structured-wire.js';
import type { NativeTurnControls } from './structured-wire.js';
export type { NativeTurnControls } from './structured-wire.js';

function parseToolArguments(name: string, raw: string): Record<string, unknown> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    throw new Fault(
      'invalid_model_result',
      `Model returned invalid JSON arguments for tool ${name}.`,
      502,
    );
  }
}

export const graphTool = {
  name: 'execute_graph',
  description:
    'Execute an explicit dependency graph of registered tools (OAA-VM v2). Independent read operations run concurrently. Supports {"$ref":"stepId#/field","$default":val}, {"$template":"{{stepId#/field}}"}, {"$expr":"stepId#/n > 0"}, virtual zero-RPC tool "$transform", conditional "when", bounded parallel map "foreach" ({"$ref":"s1#/items","as":"item","max_items":16}), and read-only "fallback". Optional "output" selects the returned value using the same reference/expression syntax; all declared steps still execute. Omit output to return the full step-result map. Never use this for tools not in the registered tool list.',
  parameters: {
    type: 'object',
    properties: {
      output: {
        description: 'Optional final value or reference projection; does not prune steps.',
      },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tool: { type: 'string' },
            arguments: { type: 'object' },
            depends_on: { type: 'array', items: { type: 'string' } },
            when: {},
            retry: {
              type: 'object',
              description:
                'Retry a failed read or idempotent tool call. attempts = extra tries (1-3).',
              properties: {
                attempts: { type: 'integer', minimum: 1, maximum: 3 },
                backoff_ms: { type: 'integer', minimum: 0, maximum: 5000 },
              },
              required: ['attempts'],
              additionalProperties: false,
            },
            timeout_ms: {
              type: 'integer',
              minimum: 100,
              maximum: 600000,
              description: 'Per-attempt time limit for a read or idempotent tool call.',
            },
            foreach: {
              type: 'object',
              properties: {
                $ref: { type: 'string' },
                as: { type: 'string' },
                max_items: { type: 'integer', minimum: 1, maximum: 32 },
              },
              required: ['$ref'],
              additionalProperties: false,
            },
            fallback: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                arguments: { type: 'object' },
                value: {},
              },
              additionalProperties: false,
            },
          },
          required: ['id', 'tool', 'arguments'],
          additionalProperties: false,
        },
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },
};

export interface ModelDriver {
  readonly providerStateVersion?: 1;
  /** Image input of a driver that has no provider config (docs/images.md); unset: `none`. */
  readonly imageInput?: ProviderImageInput;
  call(
    agent: AgentDefinition,
    messages: ModelMessage[],
    signal: AbortSignal,
    delta: (text: string) => void,
    controls?: NativeTurnControls,
  ): Promise<ModelResult>;
  /** A driver bound to a caller-supplied key (BYOK); absent when the driver cannot accept one. */
  withApiKey?(apiKey: string): ModelDriver;
}

function modelFrame<T extends object = Wire>(data: string): T {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    // Malformed JSON is reported as invalid_model_result below.
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  throw new Fault('invalid_model_result', 'Provider stream contains an invalid JSON object.', 502);
}

function modelObject<T extends object = Wire>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Fault('invalid_model_result', 'Provider returned a malformed protocol object.', 502);
  return value as T;
}

function tokenCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Fault('invalid_model_result', 'Provider returned an invalid token count.', 502);
  return value;
}

function modelUsage(
  input: number | undefined,
  output: number | undefined,
  total?: number,
): ModelResult['usage'] {
  if (input === undefined || output === undefined) return null;
  const count = total ?? input + output;
  if (!Number.isSafeInteger(count) || count < input + output)
    throw new Fault('invalid_model_result', 'Provider returned inconsistent token counts.', 502);
  return { input_tokens: input, output_tokens: output, total_tokens: count };
}

export const delegateInputSchema = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      minLength: 1,
      maxLength: 100_000,
      description: 'Task instructions for the delegated sub-agent.',
    },
    model: {
      type: 'string',
      maxLength: 200,
      description: 'Optional route or semantic profile override.',
    },
  },
  required: ['task'],
  additionalProperties: false,
};

function buildToolDefs(agent: AgentDefinition) {
  const availableNames = new Set<string>([
    ...agent.tools.map((t) => t.name),
    ...(agent.delegates ?? []).map((d) => d.name),
  ]);
  const toolDefs = agent.tools.map((t) => ({
    name: t.name,
    description: t.capability.description,
    parameters: t.capability.inputSchema,
  }));
  for (const d of agent.delegates ?? []) {
    toolDefs.push({
      name: d.name,
      description: d.description || `Delegate sub-task to agent ${d.agent}`,
      parameters: delegateInputSchema,
    });
  }
  for (const wf of agent.workflows ?? []) {
    const stepToolsAvailable = wf.steps.every((s) => {
      const toolName = String((s as { tool?: unknown }).tool ?? '');
      return toolName === '$transform' || availableNames.has(toolName);
    });
    if (stepToolsAvailable) {
      toolDefs.push({
        name: wf.name,
        description: wf.description || `Execute compiled workflow macro ${wf.name}`,
        parameters: wf.inputSchema,
      });
      availableNames.add(wf.name);
    }
  }
  if (agent.allowGraph && toolDefs.length) toolDefs.push(graphTool);
  return toolDefs;
}

// Responses API 里可以原样（或去掉输出专有字段后）作为下一轮输入重放的条目类型。
const REPLAYABLE_RESPONSE_ITEMS = new Set([
  'message',
  'function_call',
  'function_call_output',
  'reasoning',
  'item_reference',
  'additional_tools',
  'apply_patch_call',
  'apply_patch_call_output',
  'code_interpreter_call',
  'compaction',
  'compaction_trigger',
  'computer_call',
  'computer_call_output',
  'configuration_update',
  'custom_tool_call',
  'custom_tool_call_output',
  'file_search_call',
  'image_generation_call',
  'local_shell_call',
  'local_shell_call_output',
  'mcp_approval_request',
  'mcp_approval_response',
  'mcp_call',
  'mcp_list_tools',
  'program',
  'program_output',
  'shell_call',
  'shell_call_output',
  'tool_search_call',
  'tool_search_output',
  'web_search_call',
]);

/**
 * 把上一轮 Responses 输出条目整理成可以再次作为输入发送的条目：去掉只在输出里出现的字段，
 * 丢弃重放后含义会变的条目。遇到不认识的条目类型时抛错，由调用方报成「状态无法重放」。
 */
function replayableResponseItems(items: readonly unknown[]): Record<string, unknown>[] {
  const without = (item: Record<string, unknown>, ...keys: string[]) =>
    Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
  const result: Record<string, unknown>[] = [];
  for (const raw of items) {
    const item = modelObject(raw);
    const type = item.type as string | null | undefined;
    if (type !== null && type !== undefined && !REPLAYABLE_RESPONSE_ITEMS.has(type))
      throw new TypeError(`Unsupported response item type: ${String(type)}`);
    if (type === 'additional_tools' && item.role !== 'developer') continue;
    if (type === 'computer_call_output' && item.status === 'failed') continue;
    if (type === 'custom_tool_call_output') {
      if ('status' in item && item.status !== 'completed') continue;
      result.push(without(item, 'created_by', 'status'));
      continue;
    }
    const clean = without(item, 'created_by');
    if (type === 'function_call') result.push(without(clean, 'parsed_arguments'));
    else if (type === 'message' && item.role === 'assistant' && Array.isArray(item.content))
      result.push({
        ...clean,
        content: item.content.map((part: unknown) =>
          part && typeof part === 'object' && 'parsed' in part
            ? without(part as Record<string, unknown>, 'parsed')
            : part,
        ),
      });
    else if (type === 'shell_call_output' && Array.isArray(item.output))
      result.push({
        ...clean,
        output: item.output.map((chunk: unknown) =>
          chunk && typeof chunk === 'object'
            ? without(chunk as Record<string, unknown>, 'created_by')
            : chunk,
        ),
      });
    else result.push(clean);
  }
  return result;
}

/**
 * OpenAI Responses / Chat Completions 驱动。直接用 fetch 发请求、用本项目的 SSE 读取器解析
 * 流，不依赖厂商 SDK：不自动重试、不跟随重定向，请求体里只有这里明确写出的字段。
 */
export class OpenAIModel implements ModelDriver {
  readonly providerStateVersion = 1 as const;
  private readonly apiKey: string;
  constructor(
    readonly config: ProviderConfig,
    apiKey?: string,
    readonly name?: string,
  ) {
    validateEndpoint(config.baseUrl);
    const key = apiKey ?? providerApiKey(config);
    if (key === undefined)
      throw new Fault('model_not_configured', providerKeyHint(config, name), 503);
    this.apiKey = key;
  }
  private async open(
    path: string,
    body: unknown,
    signal: AbortSignal,
    connected: () => void,
  ): Promise<Response> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    connected();
    if (!response.ok)
      throw await upstreamFault(
        this.name,
        this.config,
        response,
        (body as { model: string }).model,
      );
    return response;
  }
  async call(
    agent: AgentDefinition,
    messages: ModelMessage[],
    signal: AbortSignal,
    delta: (text: string) => void,
    controls?: NativeTurnControls,
  ): Promise<ModelResult> {
    const toolDefs = buildToolDefs(agent);
    checkAbort(signal);
    checkProviderStateProtocol(this.config, messages);
    // 超时只管「连上并开始响应」这一段：收到响应头后就解除，长回答的流不会被它掐断。
    const request = new AbortController();
    const forward = () => request.abort();
    signal.addEventListener('abort', forward, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      request.abort();
    }, this.config.timeoutMs);
    const connected = () => clearTimeout(timer);
    try {
      const args = [agent, messages, toolDefs, request.signal, connected, delta, controls] as const;
      return this.config.kind === 'openai-responses'
        ? await this.callResponses(...args)
        : await this.callChat(...args);
    } catch (error) {
      if (signal.aborted) throw new Fault('cancelled', 'Model request cancelled.', 409);
      if (error instanceof Fault && !timedOut) throw error;
      // 连接失败、等待响应超时、流中途断开：都属于上游不可用，没有可用的 HTTP 状态码。
      if (timedOut || error instanceof TypeError)
        throw new Fault('upstream_failed', 'Model provider returned HTTP unknown.', 502);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    }
  }
  private async callResponses(
    agent: AgentDefinition,
    messages: ModelMessage[],
    toolDefs: ReturnType<typeof buildToolDefs>,
    signal: AbortSignal,
    connected: () => void,
    delta: (text: string) => void,
    controls?: NativeTurnControls,
  ): Promise<ModelResult> {
    const input: Record<string, unknown>[] = [];
    const tools = toolDefs.map((t) => ({ type: 'function' as const, ...t, strict: false }));
    for (const m of messages) {
      if (m.role === 'tool')
        input.push({ type: 'function_call_output', call_id: m.tool_call_id!, output: m.content });
      else if (m.providerState || m.providerItems?.length) {
        const items =
          replayProviderState(this.config, agent, { input, tools }, m) ?? m.providerItems!;
        let replayable: Record<string, unknown>[];
        try {
          replayable = replayableResponseItems(items as unknown[]);
        } catch {
          throw new Fault(
            'invalid_provider_state',
            'Stored Responses items cannot be replayed by this SDK.',
            502,
          );
        }
        input.push(...replayable);
      } else {
        if (m.content || m.images?.length)
          input.push({ role: m.role, content: imageWire.responsesUserContent(m) });
        for (const c of m.tool_calls ?? [])
          input.push({
            type: 'function_call',
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.arguments),
          });
      }
    }
    const response = await this.open(
      'responses',
      {
        model: agent.model,
        input,
        tools,
        stream: true,
        store: false,
        max_output_tokens: agent.limits.maxOutputTokens,
        ...structuredWire.openAIResponsesControls(controls, tools.length > 0),
      },
      signal,
      connected,
    );
    let final: ResponsesFinal | undefined;
    for await (const frame of readSseStream(response, signal)) {
      if (frame.data === '[DONE]') break;
      if (!frame.data) continue;
      const event = modelFrame<ResponsesEvent>(frame.data);
      if (event.type === 'response.output_text.delta') delta(String(event.delta ?? ''));
      else if (event.type === 'response.completed' || event.type === 'response.incomplete')
        final = modelObject<ResponsesFinal>(event.response);
      else if (event.type === 'response.failed')
        throw new Fault(
          'upstream_failed',
          String(event.response?.error?.message ?? 'Upstream response failed.'),
          502,
        );
      else if (event.type === 'error' || frame.event === 'error')
        throw new Fault(
          'upstream_failed',
          String(event.message ?? event.error?.message ?? 'Upstream stream reported an error.'),
          502,
        );
    }
    if (!final)
      throw new Fault('upstream_truncated', 'Upstream ended without a terminal response.', 502);
    if (!Array.isArray(final.output))
      throw new Fault(
        'invalid_model_result',
        'Provider returned a malformed protocol object.',
        502,
      );
    const output = final.output.map((item) => modelObject(item));
    const calls: ToolCall[] = output
      .filter((x) => x.type === 'function_call')
      .map((c) => ({
        id: String(c.call_id),
        name: String(c.name),
        arguments: parseToolArguments(String(c.name), String(c.arguments ?? '')),
      }));
    const text = output
      .filter((x) => x.type === 'message')
      .flatMap((x) => (Array.isArray(x.content) ? x.content : []))
      .filter((x) => x?.type === 'output_text')
      .map((x) => String(x.text ?? ''))
      .join('');
    return {
      text,
      calls,
      providerItems: final.output,
      providerState: captureProviderState(this.config, agent, { input, tools }, final.output, {
        text,
        calls,
      }),
      usage: final.usage
        ? {
            input_tokens: final.usage.input_tokens,
            output_tokens: final.usage.output_tokens,
            total_tokens: final.usage.total_tokens,
          }
        : null,
      finish: final.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop',
    };
  }
  private async callChat(
    agent: AgentDefinition,
    messages: ModelMessage[],
    toolDefs: ReturnType<typeof buildToolDefs>,
    signal: AbortSignal,
    connected: () => void,
    delta: (text: string) => void,
    controls?: NativeTurnControls,
  ): Promise<ModelResult> {
    const chatMessages = messages.map((m) =>
      m.role === 'tool'
        ? { role: 'tool', content: m.content, tool_call_id: m.tool_call_id! }
        : {
            role: m.role,
            content: imageWire.chatUserContent(m),
            ...(m.tool_calls?.length
              ? {
                  tool_calls: m.tool_calls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                  })),
                }
              : {}),
          },
    );
    const response = await this.open(
      'chat/completions',
      {
        model: agent.model,
        messages: chatMessages,
        tools: toolDefs.length
          ? toolDefs.map((t) => ({ type: 'function', function: t }))
          : undefined,
        stream: true,
        stream_options: this.config.streamUsage === false ? undefined : { include_usage: true },
        [this.config.maxTokensField]: agent.limits.maxOutputTokens,
        ...structuredWire.openAIChatControls(controls, toolDefs.length > 0),
      },
      signal,
      connected,
    );
    let text = '';
    let usage: ModelResult['usage'] = null;
    let finish: string | null = null;
    const parts = new Map<number, { id: string; name: string; args: string }>();
    for await (const frame of readSseStream(response, signal)) {
      if (frame.data === '[DONE]') break;
      if (!frame.data) continue;
      const chunk = modelFrame<ChatChunk>(frame.data);
      // 兼容服务会把错误塞在流里：没有状态码可报，与连接失败同样处理。
      if (chunk.error)
        throw new Fault('upstream_failed', 'Model provider returned HTTP unknown.', 502);
      if (chunk.usage)
        usage = {
          input_tokens: chunk.usage.prompt_tokens,
          output_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.total_tokens,
        };
      const c: ChatChoice | undefined = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!c) continue;
      const piece = c.delta?.content;
      if (typeof piece === 'string' && piece) {
        text += piece;
        delta(piece);
      }
      for (const call of c.delta?.tool_calls ?? []) {
        const index = Number(call.index ?? 0);
        const p = parts.get(index) ?? { id: '', name: '', args: '' };
        if (call.id) p.id = call.id;
        if (call.function?.name) p.name += call.function.name;
        p.args += call.function?.arguments ?? '';
        if (p.args.length > 1_048_576)
          throw new Fault('tool_arguments_too_large', 'Model tool arguments exceed limit.', 502);
        parts.set(index, p);
      }
      if (c.finish_reason) finish = c.finish_reason;
    }
    if (!finish)
      throw new Fault('upstream_truncated', 'Upstream ended without finish_reason.', 502);
    if (!['stop', 'tool_calls', 'length'].includes(finish))
      throw new Fault('upstream_incomplete', `Upstream finish reason: ${finish}`, 502);
    return {
      text,
      usage,
      calls: [...parts.values()].map((p) => ({
        id: p.id,
        name: p.name,
        arguments: parseToolArguments(p.name, p.args),
      })),
      finish: finish as ModelResult['finish'],
    };
  }
}

export class AnthropicModel implements ModelDriver {
  readonly providerStateVersion = 1 as const;
  private readonly apiKey: string;
  constructor(
    readonly config: ProviderConfig,
    apiKey?: string,
    readonly name?: string,
  ) {
    validateEndpoint(config.baseUrl);
    const key = apiKey ?? providerApiKey(config);
    if (key === undefined)
      throw new Fault('model_not_configured', providerKeyHint(config, name), 503);
    this.apiKey = key;
  }

  async call(
    agent: AgentDefinition,
    messages: ModelMessage[],
    signal: AbortSignal,
    delta: (text: string) => void,
    controls?: NativeTurnControls,
  ): Promise<ModelResult> {
    const toolDefs = buildToolDefs(agent);
    checkAbort(signal);
    checkProviderStateProtocol(this.config, messages);

    const systemParts = messages
      .filter((m) => m.role === 'system' && m.content)
      .map((m) => m.content);
    const claudeMessages: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];
    const rawTools = toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    const wire = structuredWire.anthropicControls(controls, rawTools);
    const tools = wire.tools ?? [];
    const prefix = () => ({ system: systemParts.join('\n\n'), tools, messages: claudeMessages });

    const pushMerged = (role: 'user' | 'assistant', blocks: Record<string, unknown>[]) => {
      if (!blocks.length) return;
      const last = claudeMessages.at(-1);
      if (last && last.role === role) {
        last.content.push(...blocks);
      } else {
        claudeMessages.push({ role, content: [...blocks] });
      }
    };

    for (const m of messages) {
      if (m.role === 'system') {
        continue;
      } else if (m.role === 'tool') {
        pushMerged('user', [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id!,
            content: m.content,
          },
        ]);
      } else if (m.role === 'assistant') {
        const preserved = replayProviderState(this.config, agent, prefix(), m);
        if (preserved) {
          pushMerged('assistant', preserved);
          continue;
        }
        const blocks: Record<string, unknown>[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const c of m.tool_calls ?? []) {
          blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
        }
        pushMerged('assistant', blocks);
      } else {
        pushMerged('user', imageWire.anthropicUserBlocks(m));
      }
    }

    const base = this.config.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    const combinedSignal = AbortSignal.any([signal, deadline]);

    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: combinedSignal,
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
          'anthropic-version': this.config.anthropicVersion ?? '2023-06-01',
        },
        body: JSON.stringify({
          model: agent.model,
          max_tokens: agent.limits.maxOutputTokens,
          ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
          messages: claudeMessages,
          ...wire,
          stream: true,
        }),
      });

      if (!response.ok) throw await upstreamFault(this.name, this.config, response, agent.model);

      let text = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let stopReason: string | null = null;
      let started = false;
      let stopped = false;
      const blocks = new Map<number, { type: string; closed: boolean; content: AnthropicBlock }>();
      const invalid = (message: string): never => {
        throw new Fault('invalid_model_result', `Anthropic ${message}`, 502);
      };
      const append = (value: string) => {
        if (text.length + value.length > 1_000_000)
          throw new Fault('output_too_large', 'Model output exceeds limit.', 413);
        text += value;
        delta(value);
      };
      const toolBlocks = new Map<
        number,
        { id: string; name: string; initialInput?: Record<string, unknown>; argsJson: string }
      >();

      for await (const frame of readSseStream(response, combinedSignal)) {
        if (frame.data === '[DONE]') break;
        if (!frame.data) continue;
        const payload = modelFrame<AnthropicEvent>(frame.data);
        const type = payload.type ?? frame.event;

        if (type === 'message_start') {
          if (started) invalid('stream contains duplicate message_start.');
          started = true;
          if (payload.message?.usage) {
            inputTokens = tokenCount(payload.message.usage.input_tokens);
            outputTokens = tokenCount(payload.message.usage.output_tokens);
          }
        } else if (type === 'content_block_start') {
          const index = payload.index;
          if (
            !started ||
            stopReason ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            blocks.has(index)
          )
            invalid('stream contains an invalid content block start.');
          const cb = payload.content_block;
          if (!cb || typeof cb.type !== 'string') invalid('content block has no type.');
          blocks.set(index, { type: cb!.type, closed: false, content: structuredClone(cb!) });
          if (cb?.type === 'tool_use') {
            if (typeof cb.id !== 'string' || !cb.id || typeof cb.name !== 'string' || !cb.name)
              invalid('tool block has no valid id or name.');
            if (
              cb.input !== undefined &&
              (!cb.input || typeof cb.input !== 'object' || Array.isArray(cb.input))
            )
              invalid('tool input must be an object.');
            toolBlocks.set(index, {
              id: cb.id,
              name: cb.name,
              initialInput:
                cb.input && typeof cb.input === 'object' && Object.keys(cb.input).length > 0
                  ? (cb.input as Record<string, unknown>)
                  : undefined,
              argsJson: '',
            });
          } else if (cb?.type === 'text') {
            if (cb.text !== undefined && typeof cb.text !== 'string')
              invalid('text block must contain text.');
            if (cb.text) append(cb.text);
          }
        } else if (type === 'content_block_delta') {
          const block = blocks.get(payload.index);
          if (!started || stopReason || !block || block.closed)
            invalid('delta does not belong to an open content block.');
          const d = modelObject<AnthropicDelta>(payload.delta);
          if (d.type === 'text_delta') {
            if (typeof d.text !== 'string') invalid('text delta must contain text.');
            if (block!.type !== 'text') invalid('text delta does not match its content block.');
            block!.content.text = (block!.content.text ?? '') + d.text;
            append(d.text);
          } else if (d.type === 'input_json_delta') {
            if (typeof d.partial_json !== 'string')
              invalid('tool delta must contain partial_json.');
            if (block!.type !== 'tool_use') invalid('tool delta does not match its content block.');
            const entry = toolBlocks.get(payload.index);
            if (entry) {
              entry.argsJson += d.partial_json;
              if (entry.argsJson.length > 1_048_576) {
                throw new Fault(
                  'tool_arguments_too_large',
                  'Model tool arguments exceed limit.',
                  502,
                );
              }
            }
          } else if (d.type === 'thinking_delta' || d.type === 'signature_delta') {
            const field = d.type === 'thinking_delta' ? 'thinking' : 'signature';
            if (block!.type !== 'thinking' || typeof d[field] !== 'string')
              invalid('thinking delta does not match its content block.');
            block!.content[field] = (block!.content[field] ?? '') + d[field];
          } else if (d.type === 'citations_delta') {
            if (block!.type !== 'text') invalid('citation does not belong to a text block.');
            const citation = modelObject(d.citation);
            const citations = block!.content.citations ?? [];
            if (!Array.isArray(citations)) invalid('citations must be an array.');
            block!.content.citations = [...citations, structuredClone(citation)];
          } else {
            throw new Fault(
              'provider_state_unsupported',
              'Unsupported provider content delta cannot be preserved safely.',
              502,
            );
          }
        } else if (type === 'content_block_stop') {
          const block = blocks.get(payload.index);
          if (!block || block.closed) invalid('stream closes an unknown content block.');
          block!.closed = true;
        } else if (type === 'message_delta') {
          if (!started || [...blocks.values()].some((block) => !block.closed))
            invalid('message_delta arrived before content blocks completed.');
          const nextReason = modelObject<AnthropicDelta>(payload.delta).stop_reason;
          if (nextReason != null) {
            if (typeof nextReason !== 'string' || (stopReason && stopReason !== nextReason))
              invalid('stream contains an invalid or conflicting stop reason.');
            stopReason = nextReason;
          }
          if (payload.usage?.output_tokens !== undefined) {
            outputTokens = tokenCount(payload.usage.output_tokens);
          }
        } else if (type === 'message_stop') {
          if (!started || [...blocks.values()].some((block) => !block.closed))
            invalid('message_stop arrived before content blocks completed.');
          stopped = true;
          break;
        } else if (type === 'error') {
          throw new Fault(
            'upstream_failed',
            String(payload.error?.message ?? 'Anthropic stream failed.'),
            502,
          );
        }
      }

      if (!stopped || !stopReason) {
        throw new Fault(
          'upstream_truncated',
          'Anthropic stream ended without a complete message_stop.',
          502,
        );
      }
      const length = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded';
      if (!length && !['end_turn', 'stop_sequence', 'tool_use'].includes(stopReason))
        throw new Fault(
          'upstream_incomplete',
          `Anthropic stop reason: ${stopReason.slice(0, 80)}`,
          502,
        );

      const calls: ToolCall[] = length
        ? []
        : [...toolBlocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([index, b]) => {
              const args = b.argsJson.trim() ? modelFrame(b.argsJson) : (b.initialInput ?? {});
              blocks.get(index)!.content.input = structuredClone(args);
              return {
                id: b.id,
                name: b.name,
                arguments: args,
              };
            });
      if (!length && (stopReason === 'tool_use') !== calls.length > 0)
        invalid('stop reason does not match the returned tool calls.');
      if (new Set(calls.map((call) => call.id)).size !== calls.length)
        invalid('stream contains duplicate tool call IDs.');

      const finish: ModelResult['finish'] = length
        ? 'length'
        : calls.length > 0
          ? 'tool_calls'
          : 'stop';
      const ordered = [...blocks.entries()].sort(([a], [b]) => a - b);
      if (ordered.some(([index], position) => index !== position))
        invalid('content block indices are not contiguous.');

      return {
        text,
        calls,
        ...(!length
          ? {
              providerState: captureProviderState(
                this.config,
                agent,
                prefix(),
                ordered.map(([, block]) => block.content),
                { text, calls },
              ),
            }
          : {}),
        usage: modelUsage(inputTokens, outputTokens),
        finish,
      };
    } catch (error) {
      if (signal.aborted) throw new Fault('cancelled', 'Model request cancelled.', 409);
      if (deadline.aborted)
        throw new Fault(
          'upstream_timeout',
          'Anthropic provider exceeded its request deadline.',
          504,
        );
      if (error instanceof Fault) throw error;
      throw new Fault(
        'upstream_failed',
        `Anthropic provider request failed: ${String(error)}`,
        502,
      );
    }
  }
}

export class GeminiModel implements ModelDriver {
  readonly providerStateVersion = 1 as const;
  private readonly apiKey: string;
  constructor(
    readonly config: ProviderConfig,
    apiKey?: string,
    readonly name?: string,
  ) {
    validateEndpoint(config.baseUrl);
    const key = apiKey ?? providerApiKey(config);
    if (key === undefined)
      throw new Fault('model_not_configured', providerKeyHint(config, name), 503);
    this.apiKey = key;
  }

  async call(
    agent: AgentDefinition,
    messages: ModelMessage[],
    signal: AbortSignal,
    delta: (text: string) => void,
    controls?: NativeTurnControls,
  ): Promise<ModelResult> {
    const toolDefs = buildToolDefs(agent);
    checkAbort(signal);
    checkProviderStateProtocol(this.config, messages);

    const systemParts = messages
      .filter((m) => m.role === 'system' && m.content)
      .map((m) => m.content);
    const contents: { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] = [];
    const callNames = new Map<string, { name: string; id?: string }>();
    const tools = toolDefs.length
      ? [
          {
            functionDeclarations: toolDefs.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ]
      : [];
    const prefix = () => ({ system: systemParts.join('\n\n'), tools, contents });

    const pushContent = (role: 'user' | 'model', parts: Record<string, unknown>[]) => {
      if (!parts.length) return;
      const last = contents.at(-1);
      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts: [...parts] });
      }
    };

    for (const m of messages) {
      if (m.role === 'system') {
        continue;
      } else if (m.role === 'assistant') {
        const preserved = replayProviderState(this.config, agent, prefix(), m);
        if (preserved) {
          const calls = preserved
            .filter((part) => part.functionCall)
            .map((part) => modelObject(part.functionCall));
          if (calls.length !== (m.tool_calls?.length ?? 0))
            throw new Fault(
              'invalid_provider_state',
              'Stored Gemini calls do not match the normalized turn.',
              502,
            );
          for (const [index, call] of (m.tool_calls ?? []).entries()) {
            const native = calls[index]!;
            if (
              native.name !== call.name ||
              (native.id !== undefined && native.id !== call.id) ||
              JSON.stringify(native.args ?? {}) !== JSON.stringify(call.arguments)
            )
              throw new Fault(
                'invalid_provider_state',
                'Stored Gemini call association has changed.',
                502,
              );
            callNames.set(call.id, {
              name: call.name,
              ...(native.id ? { id: native.id as string } : {}),
            });
          }
          pushContent('model', preserved);
          continue;
        }
        const parts: Record<string, unknown>[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.tool_calls ?? []) {
          callNames.set(c.id, { name: c.name });
          parts.push({ functionCall: { name: c.name, args: c.arguments } });
        }
        pushContent('model', parts);
      } else if (m.role === 'tool') {
        const original = callNames.get(m.tool_call_id ?? '');
        if (!original)
          throw new Fault(
            'invalid_provider_state',
            'Gemini tool result has no preceding function call.',
            502,
          );
        let parsedResult: unknown = m.content;
        try {
          parsedResult = JSON.parse(m.content);
        } catch {
          // Non-JSON tool output is kept as plain text.
        }
        pushContent('user', [
          {
            functionResponse: {
              name: original.name,
              ...(original.id ? { id: original.id } : {}),
              response:
                parsedResult && typeof parsedResult === 'object' && !Array.isArray(parsedResult)
                  ? parsedResult
                  : { result: parsedResult },
            },
          },
        ]);
      } else {
        pushContent('user', imageWire.geminiUserParts(m));
      }
    }

    const base = this.config.baseUrl.replace(/\/+$/, '');
    const apiRoot = base.includes('/v1beta') || base.endsWith('/v1') ? base : `${base}/v1beta`;
    const modelPath = agent.model.startsWith('models/')
      ? agent.model
      : `models/${encodeURIComponent(agent.model)}`;
    const url = `${apiRoot}/${modelPath}:streamGenerateContent?alt=sse`;
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    const combinedSignal = AbortSignal.any([signal, deadline]);

    const wire = structuredWire.geminiControls(controls, tools.length > 0);
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: combinedSignal,
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { 'x-goog-api-key': this.apiKey } : {}),
        },
        body: JSON.stringify({
          ...(systemParts.length
            ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } }
            : {}),
          contents,
          ...(tools.length ? { tools } : {}),
          ...(wire.toolConfig ? { toolConfig: wire.toolConfig } : {}),
          generationConfig: {
            maxOutputTokens: agent.limits.maxOutputTokens,
            ...wire.generationConfigExtra,
          },
        }),
      });

      if (!response.ok) throw await upstreamFault(this.name, this.config, response, agent.model);

      let text = '';
      let finishReason: string | null = null;
      let usage: ModelResult['usage'] = null;
      const functionCalls: GeminiCall[] = [];
      const nativeParts: Record<string, unknown>[] = [];

      for await (const frame of readSseStream(response, combinedSignal)) {
        if (!frame.data || frame.data === '[DONE]') continue;
        const chunk = modelFrame<GeminiChunk>(frame.data);
        if (chunk.error) {
          throw new Fault(
            'upstream_failed',
            String(chunk.error.message ?? 'Gemini stream failed.'),
            502,
          );
        }
        const blocked = chunk.promptFeedback?.blockReason;
        if (blocked && blocked !== 'BLOCK_REASON_UNSPECIFIED')
          throw new Fault(
            'upstream_incomplete',
            `Gemini prompt blocked: ${String(blocked).slice(0, 80)}`,
            502,
          );
        if (chunk.candidates !== undefined && !Array.isArray(chunk.candidates))
          throw new Fault('invalid_model_result', 'Gemini candidates must be an array.', 502);
        const candidates = ((chunk.candidates ?? []) as unknown[]).map((c) => modelObject(c));
        const cand = candidates.find((candidate) => (candidate.index ?? 0) === 0);
        const parts = cand?.content === undefined ? [] : modelObject(cand.content).parts;
        if (parts !== undefined && !Array.isArray(parts))
          throw new Fault('invalid_model_result', 'Gemini content parts must be an array.', 502);
        if (parts) {
          if (
            finishReason &&
            parts.some((part: unknown) => {
              const value = modelObject(part);
              return (
                Object.keys(value).some(
                  (key) => !['text', 'thoughtSignature', 'thought', 'partMetadata'].includes(key),
                ) ||
                (value.text !== undefined && value.text !== '')
              );
            })
          )
            throw new Fault(
              'invalid_model_result',
              'Gemini returned content after its finish reason.',
              502,
            );
          for (const value of parts) {
            const part = modelObject(value);
            nativeParts.push(structuredClone(part));
            if (part.text !== undefined && typeof part.text !== 'string')
              throw new Fault('invalid_model_result', 'Gemini text part must contain text.', 502);
            if (typeof part.text === 'string' && part.text.length > 0 && part.thought !== true) {
              if (text.length + part.text.length > 1_000_000)
                throw new Fault('output_too_large', 'Model output exceeds limit.', 413);
              text += part.text;
              delta(part.text);
            }
            if (part.functionCall !== undefined)
              functionCalls.push(modelObject<GeminiCall>(part.functionCall));
          }
        }
        if (cand?.finishReason) {
          if (finishReason && finishReason !== cand.finishReason)
            throw new Fault(
              'invalid_model_result',
              'Gemini returned conflicting finish reasons.',
              502,
            );
          finishReason = String(cand.finishReason);
        }
        if (chunk.usageMetadata) {
          modelObject(chunk.usageMetadata);
          usage = modelUsage(
            tokenCount(chunk.usageMetadata.promptTokenCount),
            tokenCount(chunk.usageMetadata.candidatesTokenCount),
            tokenCount(chunk.usageMetadata.totalTokenCount),
          );
        }
      }

      if (!finishReason || finishReason === 'FINISH_REASON_UNSPECIFIED')
        throw new Fault('upstream_truncated', 'Gemini stream ended without finishReason.', 502);
      if (!['STOP', 'MAX_TOKENS'].includes(finishReason))
        throw new Fault(
          'upstream_incomplete',
          `Gemini finish reason: ${finishReason.slice(0, 80)}`,
          502,
        );
      const calls: ToolCall[] =
        finishReason === 'MAX_TOKENS'
          ? []
          : functionCalls.map((fn, index) => {
              if (
                typeof fn.name !== 'string' ||
                !fn.name ||
                (fn.id !== undefined && (typeof fn.id !== 'string' || !fn.id)) ||
                (fn.args !== undefined &&
                  (!fn.args || typeof fn.args !== 'object' || Array.isArray(fn.args)))
              )
                throw new Fault(
                  'invalid_model_result',
                  'Gemini returned an invalid function call.',
                  502,
                );
              return {
                id: fn.id ?? `call_${index + 1}_${fn.name}`,
                name: fn.name,
                arguments: fn.args ?? {},
              };
            });
      if (new Set(calls.map((call) => call.id)).size !== calls.length)
        throw new Fault(
          'invalid_model_result',
          'Gemini returned duplicate function call IDs.',
          502,
        );

      const finish: ModelResult['finish'] =
        finishReason === 'MAX_TOKENS' ? 'length' : calls.length > 0 ? 'tool_calls' : 'stop';

      return {
        text,
        calls,
        ...(finish !== 'length'
          ? {
              providerState: captureProviderState(this.config, agent, prefix(), nativeParts, {
                text,
                calls,
              }),
            }
          : {}),
        usage,
        finish,
      };
    } catch (error) {
      if (signal.aborted) throw new Fault('cancelled', 'Model request cancelled.', 409);
      if (deadline.aborted)
        throw new Fault('upstream_timeout', 'Gemini provider exceeded its request deadline.', 504);
      if (error instanceof Fault) throw error;
      throw new Fault('upstream_failed', `Gemini provider request failed: ${String(error)}`, 502);
    }
  }
}

/** `apiKey` overrides the worker's `apiKeyEnv` value (a caller-supplied BYOK key). */
export function createModelDriver(
  config: ProviderConfig,
  apiKey?: string,
  name?: string,
): ModelDriver {
  if (config.kind === 'anthropic-messages') return new AnthropicModel(config, apiKey, name);
  if (config.kind === 'gemini-generate') return new GeminiModel(config, apiKey, name);
  return new OpenAIModel(config, apiKey, name);
}
