/**
 * 兼容解析器里与调用方工具有关的部分（双层 Harness 契约，docs/harness.md）。
 *
 * 只有请求带了非空的 `tools` 数组才会进入这里的模式处理；空数组、缺省或不是数组都原样返回，
 * 解析结果与没有这段逻辑时逐字节相同。调用发生在行内指令（`@oaa(...)`）识别之后。
 */
import { Fault } from '../core/util.js';
import { isForcedToolChoice, type ToolChoicePolicy } from '../core/tool-choice.js';
import { CLIENT_TOOLS_MANAGED_NOTE, resolveClientToolsMode } from '../kernel/harness.js';
import type { Invocation } from '../kernel/invocation.js';
import {
  parseChatToolChoice,
  parseClaudeToolChoice,
  parseGeminiToolChoice,
  parseResponsesToolChoice,
  verifyRequestToolChoice,
} from './tool-choice.js';

export type ToolsFallback = 'managed' | 'reject';

/**
 * 按模式处理调用方工具，返回交给内层智能体的输入；`meta` 会被就地写入模式标记。
 *
 * 请求没有选模式时（`default`，或显式的 `auto`）这里什么都不替智能体决定：输入原样返回，桥接字段照
 * bridge 准备好，提交时由 `submitClientTools` 按网关配置与智能体能力定下来（能桥接就桥接，否则回到
 * `fallback`：OpenAI 默认端点 `reject`，其余入口 `managed`）。
 */
export function withClientTools(
  tools: unknown,
  headers: Record<string, unknown> | undefined,
  meta: Record<string, string>,
  input: string,
  options: { count?: number; forced?: boolean; fallback?: ToolsFallback } = {},
): string {
  if (!Array.isArray(tools) || tools.length === 0) return input;
  const count = String(options.count || tools.length);
  const mode = resolveClientToolsMode(headers, meta);
  if (mode === 'reject')
    throw new Fault(
      'client_tools_unsupported',
      'This endpoint is backed by an agent that uses its own tools; caller-defined tools are not accepted in reject mode. Remove tools, or use X-OAA-Client-Tools: managed (the agent works with its own tools) or bridge (the caller executes tools, where supported).',
    );
  if (mode === 'bridge') {
    meta['oaa.client_tools'] = 'bridge';
    meta['oaa.client_tools_declared'] = count;
    return input;
  }
  if (mode === 'managed') {
    if (options.forced)
      throw new Fault(
        'client_tools_unsupported',
        'A forced tool_choice cannot be satisfied in managed mode because caller tools are not exposed to the agent. Use X-OAA-Client-Tools: bridge or set tool_choice to auto.',
      );
    meta['oaa.client_tools'] = 'managed';
    meta['oaa.client_tools_ignored'] = count;
    return `${input}\n\n[Harness note] ${CLIENT_TOOLS_MANAGED_NOTE}`;
  }
  meta['oaa.client_tools'] = mode;
  meta['oaa.client_tools_declared'] = count;
  if (options.fallback === 'reject') meta['oaa.client_tools_fallback'] = 'reject';
  if (options.forced) meta['oaa.tool_choice_forced'] = '1';
  return input;
}

/** 这次请求的桥接字段要不要准备：显式 bridge，或还没定的 auto / default。 */
const preparesBridge = (meta: Record<string, string>) =>
  ['bridge', 'auto', 'default'].includes(meta['oaa.client_tools'] ?? '');

/**
 * 桥接字段构造失败（内置或服务端工具、不合规的名字或 schema）：显式 bridge 或强制 tool_choice 照旧报错；
 * 还没定的 auto / default 不报错，记下原因、不带桥接字段，提交时直接走回退行为。
 */
export function bridgeFieldsOrFallback(
  meta: Record<string, string>,
  build: () => Pick<Invocation, 'client_tools' | 'client_results'>,
  forced = false,
): Pick<Invocation, 'client_tools' | 'client_results'> {
  try {
    return build();
  } catch (error) {
    if (forced || meta['oaa.client_tools'] === 'bridge' || !(error instanceof Fault)) throw error;
    meta['oaa.client_tools_unbridgeable'] = error.message.slice(0, 300);
    return {};
  }
}

/** 调用方强制了工具选择（网关与上游模型都没法如实保证）。 */
export function forcedToolChoice(choice: unknown): boolean {
  if (choice === 'required' || choice === 'any') return true;
  if (!choice || typeof choice !== 'object') return false;
  const c = choice as { type?: unknown; mode?: unknown };
  return c.type === 'function' || c.type === 'tool' || c.type === 'any' || c.mode === 'ANY';
}

/** Gemini 的 `tools[].functionDeclarations`：按声明的函数个数计数，没有声明时按 tools 条数。 */
export function geminiToolCount(tools: unknown): number {
  if (!Array.isArray(tools)) return 0;
  return tools.reduce(
    (n: number, t) =>
      n +
      (Array.isArray((t as { functionDeclarations?: unknown })?.functionDeclarations)
        ? (t as { functionDeclarations: unknown[] }).functionDeclarations.length
        : 0),
    0,
  );
}

type ChatMessage = { role: string; content?: unknown; tool_call_id?: string };
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
      : content == null
        ? ''
        : JSON.stringify(content);

/**
 * bridge 模式下的 Chat 请求：`tools` 变成 `client_tools`，末尾连续的 `role: "tool"` 消息变成
 * `client_results`（本次回传的结果）。输入文本仍是全部压平的旧形式：网关找不到对应的停车运行时，
 * 去掉 `client_results` 就是旧式的新请求（见 `flattenClientResults`）。
 */
export function chatBridgeFields(
  tools: unknown,
  messages: ChatMessage[],
  meta: Record<string, string>,
): Pick<Invocation, 'client_tools' | 'client_results'> {
  if (!preparesBridge(meta) || !Array.isArray(tools)) return {};
  const clientTools = tools.map((t) => {
    const fn = (t as { type?: unknown; function?: Record<string, unknown> })?.function;
    if ((t as { type?: unknown })?.type !== 'function' || !fn || typeof fn.name !== 'string')
      throw new Fault(
        'invalid_client_tool',
        'Bridged caller tools must be {"type":"function","function":{"name",...}}.',
      );
    const parameters = fn.parameters;
    return {
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description.slice(0, 4000) } : {}),
      parameters:
        parameters && typeof parameters === 'object' && !Array.isArray(parameters)
          ? (parameters as Record<string, unknown>)
          : { type: 'object', properties: {} },
    };
  });
  let first = messages.length;
  while (first > 0 && messages[first - 1]!.role === 'tool' && messages[first - 1]!.tool_call_id)
    first--;
  const results = messages
    .slice(first)
    .map((m) => ({ call_id: m.tool_call_id!, output: textOf(m.content) }));
  return { client_tools: clientTools, ...(results.length ? { client_results: results } : {}) };
}

const objectSchema = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { type: 'object', properties: {} };
const onlyFunctions = (protocol: string) =>
  new Fault(
    'client_tools_unsupported',
    `Bridge mode on ${protocol} accepts only caller-defined function tools; built-in or server tools cannot be bridged.`,
  );
const description = (value: unknown) =>
  typeof value === 'string' ? { description: value.slice(0, 4000) } : {};
const resultText = (output: unknown) =>
  typeof output === 'string' ? output : JSON.stringify(output ?? '');

/**
 * bridge 模式下的 Responses 请求：`tools` 里 `type: "function"` 的扁平条目是调用方工具（其它类型
 * 报 `client_tools_unsupported`）；`input` 末尾连续的 `function_call_output` 条目是回传结果。
 */
export function responsesBridgeFields(
  tools: unknown,
  input: unknown,
  meta: Record<string, string>,
): Pick<Invocation, 'client_tools' | 'client_results'> {
  if (!preparesBridge(meta) || !Array.isArray(tools)) return {};
  const clientTools = tools.map((t) => {
    const tool = (t ?? {}) as Record<string, unknown>;
    if (tool.type !== 'function') throw onlyFunctions('Responses');
    if (typeof tool.name !== 'string')
      throw new Fault('invalid_client_tool', 'A Responses function tool needs a name.');
    return {
      name: tool.name,
      ...description(tool.description),
      parameters: objectSchema(tool.parameters),
    };
  });
  const items = (Array.isArray(input) ? input : []) as Record<string, unknown>[];
  let first = items.length;
  while (first > 0 && items[first - 1]?.type === 'function_call_output') first--;
  const results = items
    .slice(first)
    .map((item) => ({ call_id: String(item.call_id ?? ''), output: resultText(item.output) }));
  return { client_tools: clientTools, ...(results.length ? { client_results: results } : {}) };
}

/**
 * bridge 模式下的 Claude Messages 请求：带 `name` 与 `input_schema` 的条目是调用方工具（带 `type`
 * 的服务端工具报 `client_tools_unsupported`）；最后一条 `user` 消息里的 `tool_result` 块是回传
 * 结果，`is_error: true` 时包成 `{ "error": … }` 交给模型。
 */
export function claudeBridgeFields(
  tools: unknown,
  messages: { role: string; content: unknown }[],
  meta: Record<string, string>,
): Pick<Invocation, 'client_tools' | 'client_results'> {
  if (!preparesBridge(meta) || !Array.isArray(tools)) return {};
  const clientTools = tools.map((t) => {
    const tool = (t ?? {}) as Record<string, unknown>;
    if (tool.type !== undefined && tool.type !== 'custom') throw onlyFunctions('Claude Messages');
    if (typeof tool.name !== 'string' || !tool.input_schema)
      throw new Fault('invalid_client_tool', 'A Claude tool needs name and input_schema.');
    return {
      name: tool.name,
      ...description(tool.description),
      parameters: objectSchema(tool.input_schema),
    };
  });
  const last = messages.at(-1);
  const blocks = last?.role === 'user' && Array.isArray(last.content) ? last.content : [];
  const results = (blocks as Record<string, unknown>[])
    .filter((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map((b) => {
      const text = Array.isArray(b.content) ? textOf(b.content) : resultText(b.content);
      return {
        call_id: b.tool_use_id as string,
        output: b.is_error === true ? JSON.stringify({ error: text }) : text,
      };
    });
  return { client_tools: clientTools, ...(results.length ? { client_results: results } : {}) };
}

type GeminiContent = { role?: string; parts: Record<string, unknown>[] };
const record = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** 值是「名字 → schema」映射的关键字：逐个值递归，名字本身（哪怕叫 `type`、`items`）不当关键字。 */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
/** 值是 schema 或 schema 数组的关键字。`enum`、`default`、`const`、`example(s)` 等值原样保留。 */
const SCHEMA_SLOTS = new Set(['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf', 'not']);

/**
 * Gemini 的 `parameters` 是 OpenAPI 子集（官方 SDK 发 `type: "OBJECT"` 等大写类型、`nullable`）：
 * 类型转成 JSON Schema 的小写，`nullable: true` 并入类型；嵌套 schema 的位置都递归。
 * `parametersJsonSchema` 已是 JSON Schema，原样。
 */
export function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  const node = record(value);
  if (!node) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === 'nullable') continue;
    if (key === 'type' && typeof child === 'string') out.type = child.toLowerCase();
    else if (SCHEMA_MAPS.has(key) && record(child))
      out[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([k, v]) => [k, geminiSchema(v)]),
      );
    else if (SCHEMA_SLOTS.has(key) || (key === 'additionalProperties' && record(child)))
      out[key] = geminiSchema(child);
    else out[key] = child;
  }
  if (node.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

/**
 * bridge 模式下的 Gemini 请求：`tools[].functionDeclarations[]` 是调用方工具（`parameters` 或
 * `parametersJsonSchema`）；`googleSearch`、`codeExecution` 等内置工具报 `client_tools_unsupported`。
 * `contents` 最后一条（`user` 或 `function`）里的 `functionResponse` 是回传结果：带 `id` 按 id；
 * 不带 `id` 时按上一条 `model` 内容里 `functionCall` 的名字与出现顺序配对。配不上的给空 ID，
 * 续接整体不命中，退回新请求（与其它协议未知 ID 的处理一致）。
 */
export function geminiBridgeFields(
  tools: unknown,
  contents: GeminiContent[],
  meta: Record<string, string>,
): Pick<Invocation, 'client_tools' | 'client_results'> {
  if (!preparesBridge(meta) || !Array.isArray(tools)) return {};
  const clientTools = tools.flatMap((t) => {
    const tool = record(t) ?? {};
    const keys = Object.keys(tool);
    if (!Array.isArray(tool.functionDeclarations) || keys.some((k) => k !== 'functionDeclarations'))
      throw onlyFunctions('Gemini');
    return (tool.functionDeclarations as unknown[]).map((d) => {
      const decl = record(d) ?? {};
      if (typeof decl.name !== 'string' || !decl.name)
        throw new Fault('invalid_client_tool', 'A Gemini function declaration needs a name.');
      return {
        name: decl.name,
        ...description(decl.description),
        parameters: objectSchema(decl.parametersJsonSchema ?? geminiSchema(decl.parameters)),
      };
    });
  });
  const last = contents.at(-1);
  const parts = last && (last.role === 'user' || last.role === 'function') ? last.parts : [];
  const responses = parts
    .map((p) => record(p.functionResponse))
    .filter((r): r is Record<string, unknown> => !!r);
  if (!responses.length) return { client_tools: clientTools };
  const model = contents
    .slice(0, -1)
    .reverse()
    .find((c) => c.role === 'model');
  const calls = (model?.parts ?? [])
    .map((p) => record(p.functionCall))
    .filter((c): c is Record<string, unknown> => !!c && typeof c.id === 'string');
  const used = new Set<number>();
  const results = responses.map((r) => {
    let id = typeof r.id === 'string' ? r.id : '';
    if (!id) {
      const i = calls.findIndex((c, j) => !used.has(j) && c.name === r.name);
      if (i >= 0) {
        used.add(i);
        id = calls[i]!.id as string;
      }
    }
    return { call_id: id || 'unpaired', output: resultText(r.response) };
  });
  return { client_tools: clientTools, client_results: results };
}

/** 严格端点未携带 `tools` 时校验 `tool_choice`（强制调用无工具时报 400 `invalid_request`）。 */
export function strictNoToolsChoice(
  protocol: 'chat' | 'responses',
  rawChoice: unknown,
): { tool_choice?: ToolChoicePolicy } {
  const policy =
    protocol === 'chat' ? parseChatToolChoice(rawChoice) : parseResponsesToolChoice(rawChoice);
  verifyRequestToolChoice(protocol, policy, undefined);
  return policy ? { tool_choice: policy } : {};
}

function resultsOnlyWhenNone(
  build: (probeMeta: Record<string, string>) => Pick<Invocation, 'client_tools' | 'client_results'>,
): Pick<Invocation, 'client_results'> {
  try {
    const built = build({ 'oaa.client_tools': 'bridge' });
    return built.client_results ? { client_results: built.client_results } : {};
  } catch {
    return {};
  }
}

/**
 * 三个兼容解析器的输入与桥接字段：先校验 `tool_choice`，`none` 时本轮不向智能体暴露调用方工具；
 * 其余按模式处理（`withClientTools`），bridge 模式下再按协议解析出 `client_tools` / `client_results`。
 */
export function compatInput(
  protocol: 'chat' | 'responses' | 'claude',
  req: { tools?: unknown; messages?: unknown; input?: unknown; tool_choice?: unknown },
  headers: Record<string, unknown> | undefined,
  meta: Record<string, string>,
  text: string,
  fallback: ToolsFallback = 'managed',
): { input: string } & Pick<Invocation, 'client_tools' | 'client_results' | 'tool_choice'> {
  const rawPolicy =
    protocol === 'chat'
      ? parseChatToolChoice(req.tool_choice)
      : protocol === 'responses'
        ? parseResponsesToolChoice(req.tool_choice)
        : parseClaudeToolChoice(req.tool_choice);
  const policy = verifyRequestToolChoice(protocol, rawPolicy, req.tools);
  const buildFor = (m: Record<string, string>) =>
    protocol === 'chat'
      ? chatBridgeFields(req.tools ?? [], req.messages as ChatMessage[], m)
      : protocol === 'responses'
        ? responsesBridgeFields(req.tools ?? [], req.input, m)
        : claudeBridgeFields(
            req.tools ?? [],
            req.messages as { role: string; content: unknown }[],
            m,
          );
  if (policy?.mode === 'none') {
    if (
      Array.isArray(req.tools) &&
      req.tools.length > 0 &&
      resolveClientToolsMode(headers, meta) === 'reject'
    ) {
      withClientTools(req.tools, headers, meta, text, { fallback });
    }
    return { input: text, ...resultsOnlyWhenNone(buildFor), tool_choice: policy };
  }
  const forced = isForcedToolChoice(policy);
  const input = withClientTools(req.tools, headers, meta, text, {
    forced,
    fallback,
  });
  const fields = bridgeFieldsOrFallback(meta, () => buildFor(meta), forced);
  return { input, ...fields, ...(policy ? { tool_choice: policy } : {}) };
}

/** Gemini 入口的 `tools` 与 `toolConfig.functionCallingConfig` 解析。 */
export function geminiToolInput(
  tools: unknown,
  contents: GeminiContent[],
  toolConfig: unknown,
  headers: Record<string, unknown> | undefined,
  meta: Record<string, string>,
  text: string,
): { input: string } & Pick<Invocation, 'client_tools' | 'client_results' | 'tool_choice'> {
  const { policy: rawPolicy, allowedFunctionNames } = parseGeminiToolChoice(toolConfig);
  const policy = verifyRequestToolChoice('gemini', rawPolicy, tools, allowedFunctionNames);
  if (policy?.mode === 'none') {
    if (
      Array.isArray(tools) &&
      tools.length > 0 &&
      resolveClientToolsMode(headers, meta) === 'reject'
    ) {
      withClientTools(tools, headers, meta, text, { count: geminiToolCount(tools) });
    }
    return {
      input: text,
      ...resultsOnlyWhenNone((m) => geminiBridgeFields(tools ?? [], contents, m)),
      tool_choice: policy,
    };
  }
  const forced = isForcedToolChoice(policy);
  const input = withClientTools(tools, headers, meta, text, {
    count: geminiToolCount(tools),
    forced,
  });
  const fields = bridgeFieldsOrFallback(
    meta,
    () => geminiBridgeFields(tools, contents, meta),
    forced,
  );
  if (allowedFunctionNames && fields.client_tools) {
    const allow = new Set(allowedFunctionNames);
    fields.client_tools = fields.client_tools.filter((t) => allow.has(t.name));
  }
  return { input, ...fields, ...(policy ? { tool_choice: policy } : {}) };
}

/** 续接没有命中时：去掉回传结果，当作旧式的新请求（历史已经压平在输入里）。 */
export function flattenClientResults(invocation: Invocation): Invocation {
  const { client_results: _results, ...rest } = invocation;
  return rest;
}
