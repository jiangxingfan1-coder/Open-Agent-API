import {
  isForcedToolChoice,
  validateToolChoiceTarget,
  type ToolChoicePolicy,
} from '../core/tool-choice.js';
import { CompatFault } from './compat-errors.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const invalidChoice = (param: string, message: string) =>
  new CompatFault('invalid_request', message, 400, param);

/** Parses OpenAI Chat Completions `tool_choice`. */
export function parseChatToolChoice(choice: unknown): ToolChoicePolicy | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') {
    return { mode: choice };
  }
  if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function)) {
    const name = choice.function.name;
    if (typeof name === 'string' && name.trim().length > 0 && name.length <= 64) {
      return { mode: 'tool', name };
    }
  }
  throw invalidChoice(
    'tool_choice',
    'tool_choice must be "auto", "none", "required", or {"type":"function","function":{"name":"..."}}.',
  );
}

/** Parses OpenAI Responses `tool_choice`. */
export function parseResponsesToolChoice(choice: unknown): ToolChoicePolicy | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') {
    return { mode: choice };
  }
  if (isRecord(choice) && choice.type === 'function') {
    const rawName =
      typeof choice.name === 'string'
        ? choice.name
        : isRecord(choice.function) && typeof choice.function.name === 'string'
          ? choice.function.name
          : undefined;
    if (rawName && rawName.trim().length > 0 && rawName.length <= 64) {
      return { mode: 'tool', name: rawName };
    }
  }
  throw invalidChoice(
    'tool_choice',
    'tool_choice must be "auto", "none", "required", or {"type":"function","name":"..."}.',
  );
}

/** Parses Anthropic Claude Messages `tool_choice`. */
export function parseClaudeToolChoice(choice: unknown): ToolChoicePolicy | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (choice === 'auto' || choice === 'none') return { mode: choice };
  if (choice === 'any') return { mode: 'required' };
  if (isRecord(choice)) {
    if (choice.type === 'auto') return { mode: 'auto' };
    if (choice.type === 'none') return { mode: 'none' };
    if (choice.type === 'any') return { mode: 'required' };
    if (
      choice.type === 'tool' &&
      typeof choice.name === 'string' &&
      choice.name.trim().length > 0 &&
      choice.name.length <= 64
    ) {
      return { mode: 'tool', name: choice.name };
    }
  }
  throw invalidChoice(
    'tool_choice',
    'tool_choice must be {"type":"auto"|"any"|"none"} or {"type":"tool","name":"..."}.',
  );
}

/** Parses Google Gemini `toolConfig.functionCallingConfig` (already camelized or snake_case). */
export function parseGeminiToolChoice(toolConfig: unknown): {
  policy?: ToolChoicePolicy;
  allowedFunctionNames?: string[];
} {
  if (toolConfig === undefined || toolConfig === null) return {};
  if (!isRecord(toolConfig)) {
    throw invalidChoice('toolConfig', 'toolConfig must be an object.');
  }
  const rawFc = toolConfig.functionCallingConfig ?? toolConfig.function_calling_config;
  if (rawFc === undefined || rawFc === null) return {};
  if (!isRecord(rawFc)) {
    throw invalidChoice(
      'toolConfig.functionCallingConfig',
      'toolConfig.functionCallingConfig must be an object.',
    );
  }
  const rawMode = typeof rawFc.mode === 'string' ? rawFc.mode.toUpperCase() : 'MODE_UNSPECIFIED';
  const rawAllowed = rawFc.allowedFunctionNames ?? rawFc.allowed_function_names;
  let allowed: string[] | undefined;
  if (rawAllowed !== undefined) {
    if (
      !Array.isArray(rawAllowed) ||
      rawAllowed.length === 0 ||
      rawAllowed.some((n) => typeof n !== 'string' || !n.trim() || n.length > 64)
    ) {
      throw invalidChoice(
        'toolConfig.functionCallingConfig.allowedFunctionNames',
        'allowedFunctionNames must be a non-empty array of tool names.',
      );
    }
    allowed = rawAllowed as string[];
  }
  if (rawMode === 'AUTO' || rawMode === 'MODE_UNSPECIFIED') {
    if (allowed) {
      throw invalidChoice(
        'toolConfig.functionCallingConfig',
        'allowedFunctionNames is valid only when functionCallingConfig.mode is "ANY".',
      );
    }
    return { policy: { mode: 'auto' } };
  }
  if (rawMode === 'NONE') {
    if (allowed) {
      throw invalidChoice(
        'toolConfig.functionCallingConfig',
        'allowedFunctionNames cannot be set when functionCallingConfig.mode is "NONE".',
      );
    }
    return { policy: { mode: 'none' } };
  }
  if (rawMode === 'ANY') {
    if (!allowed) return { policy: { mode: 'required' } };
    if (allowed.length === 1) return { policy: { mode: 'tool', name: allowed[0]! } };
    return { policy: { mode: 'required' }, allowedFunctionNames: allowed };
  }
  throw invalidChoice(
    'toolConfig.functionCallingConfig.mode',
    'functionCallingConfig.mode must be AUTO, NONE, or ANY.',
  );
}

/** Extracts declared function tool names from raw request `tools` across all four protocols. */
export function declaredToolNames(
  protocol: 'chat' | 'responses' | 'claude' | 'gemini',
  tools: unknown,
): string[] {
  if (!Array.isArray(tools)) return [];
  if (protocol === 'chat') {
    return tools.flatMap((t) =>
      isRecord(t) &&
      t.type === 'function' &&
      isRecord(t.function) &&
      typeof t.function.name === 'string'
        ? [t.function.name]
        : [],
    );
  }
  if (protocol === 'responses') {
    return tools.flatMap((t) =>
      isRecord(t) && t.type === 'function' && typeof t.name === 'string' ? [t.name] : [],
    );
  }
  if (protocol === 'claude') {
    return tools.flatMap((t) =>
      isRecord(t) && (t.type === undefined || t.type === 'custom') && typeof t.name === 'string'
        ? [t.name]
        : [],
    );
  }
  return tools.flatMap((t) => {
    if (!isRecord(t) || !Array.isArray(t.functionDeclarations)) return [];
    return t.functionDeclarations.flatMap((d) =>
      isRecord(d) && typeof d.name === 'string' ? [d.name] : [],
    );
  });
}

/** Validates `tool_choice` against the request's declared `tools` list. */
export function verifyRequestToolChoice(
  protocol: 'chat' | 'responses' | 'claude' | 'gemini',
  policy: ToolChoicePolicy | undefined,
  tools: unknown,
  allowedFunctionNames?: readonly string[],
): ToolChoicePolicy | undefined {
  if (!policy) return undefined;
  const param = protocol === 'gemini' ? 'toolConfig.functionCallingConfig' : 'tool_choice';
  if (isForcedToolChoice(policy)) {
    const names = declaredToolNames(protocol, tools);
    const problem = validateToolChoiceTarget(policy, names);
    if (problem) throw invalidChoice(param, problem);
    if (allowedFunctionNames) {
      for (const name of allowedFunctionNames) {
        if (!names.includes(name)) {
          throw invalidChoice(param, `Tool '${name}' in allowedFunctionNames is not in tools.`);
        }
      }
    }
  }
  return policy;
}
