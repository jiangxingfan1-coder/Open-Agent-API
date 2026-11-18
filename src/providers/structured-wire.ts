import type { ProviderConfig } from '../config/config.js';
import type { OutputContract } from '../core/contracts.js';
import { isForcedToolChoice, type ToolChoicePolicy } from '../core/tool-choice.js';

export type NativeTurnControls = {
  outputContract?: OutputContract;
  toolChoice?: ToolChoicePolicy;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const STRICT_UNSUPPORTED_KEYS = new Set([
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'multipleOf',
]);

const DATA_SLOTS = new Set(['enum', 'const', 'default', 'examples', 'example', 'required']);

function sanitizeSchemaName(name: string | undefined): string {
  const cleaned = (name ?? 'response').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'response';
}

/**
 * Checks whether a JSON Schema fits the strict Structured Outputs subset required by OpenAI
 * (`strict: true`): root must be `type: "object"`, every object must declare `properties`,
 * `additionalProperties: false`, and list every property in `required`, with no free-form
 * dictionaries or unsupported combinators. Incompatible schemas degrade gracefully to gateway
 * validation instead of triggering upstream 400 errors.
 */
export function isOpenAIStrictCompatible(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object') return false;
  const checkNode = (node: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (Array.isArray(node)) return node.every((item) => checkNode(item, depth + 1));
    if (!isRecord(node)) return true;
    for (const key of Object.keys(node)) {
      if (STRICT_UNSUPPORTED_KEYS.has(key)) return false;
    }
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#/')) return false;
    const typeVal = node.type;
    const isObj =
      typeVal === 'object' ||
      (Array.isArray(typeVal) && typeVal.includes('object')) ||
      node.properties !== undefined;
    if (isObj) {
      if (!isRecord(node.properties) || node.additionalProperties !== false) return false;
      const propKeys = Object.keys(node.properties);
      if (!Array.isArray(node.required)) return false;
      const reqSet = new Set(node.required.filter((k): k is string => typeof k === 'string'));
      if (propKeys.some((k) => !reqSet.has(k))) return false;
      for (const child of Object.values(node.properties)) {
        if (!checkNode(child, depth + 1)) return false;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'properties' || DATA_SLOTS.has(key)) continue;
      if ((key === '$defs' || key === 'definitions') && isRecord(child)) {
        for (const def of Object.values(child)) {
          if (!checkNode(def, depth + 1)) return false;
        }
        continue;
      }
      if (!checkNode(child, depth + 1)) return false;
    }
    return true;
  };
  return checkNode(schema, 0);
}

/**
 * Checks whether a JSON Schema fits Anthropic's native `output_config.format` subset:
 * root must be an object, every object must disallow free-form `additionalProperties`,
 * and unsupported keywords are absent (optional properties not in `required` are allowed).
 */
export function isAnthropicSchemaCompatible(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object') return false;
  const checkNode = (node: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (Array.isArray(node)) return node.every((item) => checkNode(item, depth + 1));
    if (!isRecord(node)) return true;
    for (const key of Object.keys(node)) {
      if (STRICT_UNSUPPORTED_KEYS.has(key)) return false;
    }
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#/')) return false;
    const typeVal = node.type;
    const isObj =
      typeVal === 'object' ||
      (Array.isArray(typeVal) && typeVal.includes('object')) ||
      node.properties !== undefined;
    if (isObj) {
      if (!isRecord(node.properties) || node.additionalProperties !== false) return false;
      for (const child of Object.values(node.properties)) {
        if (!checkNode(child, depth + 1)) return false;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'properties' || DATA_SLOTS.has(key)) continue;
      if ((key === '$defs' || key === 'definitions') && isRecord(child)) {
        for (const def of Object.values(child)) {
          if (!checkNode(def, depth + 1)) return false;
        }
        continue;
      }
      if (!checkNode(child, depth + 1)) return false;
    }
    return true;
  };
  return checkNode(schema, 0);
}

const GEMINI_SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const GEMINI_ALLOWED_KEYS = new Set([
  '$schema',
  'title',
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
]);

/**
 * Projects a JSON Schema into Gemini's OpenAPI 3.0 `responseSchema` subset when lossless
 * (stripping `additionalProperties: false` and `$schema`, converting `[T, "null"]` to `nullable`).
 * Returns `undefined` when the schema uses free-form objects, `$ref`, `const`, or unsupported keywords.
 */
export function toGeminiOpenApiSchema(
  schema: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> | undefined {
  if (depth > 32) return undefined;
  for (const key of Object.keys(schema)) {
    if (!GEMINI_ALLOWED_KEYS.has(key)) return undefined;
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    return undefined;
  }
  let baseType: string | undefined;
  let nullable = schema.nullable === true;
  if (typeof schema.type === 'string') {
    const lower = schema.type.toLowerCase();
    if (lower === 'null') return undefined;
    if (!GEMINI_SCALARS.has(lower)) return undefined;
    baseType = lower;
  } else if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t): t is string => typeof t === 'string');
    if (types.length !== schema.type.length) return undefined;
    const nonNull = types.filter((t) => t.toLowerCase() !== 'null');
    if (types.length !== nonNull.length) nullable = true;
    if (nonNull.length !== 1 || !GEMINI_SCALARS.has(nonNull[0]!.toLowerCase())) return undefined;
    baseType = nonNull[0]!.toLowerCase();
  }
  const out: Record<string, unknown> = {};
  if (baseType) out.type = baseType.toUpperCase();
  if (nullable) out.nullable = true;
  for (const copyKey of [
    'format',
    'description',
    'enum',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'pattern',
  ] as const) {
    if (schema[copyKey] !== undefined) out[copyKey] = schema[copyKey];
  }
  if (baseType === 'object' || schema.properties !== undefined) {
    if (!isRecord(schema.properties) || Object.keys(schema.properties).length === 0) {
      return undefined;
    }
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      if (!isRecord(v)) return undefined;
      const sub = toGeminiOpenApiSchema(v, depth + 1);
      if (!sub) return undefined;
      props[k] = sub;
    }
    out.type = 'OBJECT';
    out.properties = props;
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      out.required = schema.required;
    }
  }
  if (baseType === 'array' || schema.items !== undefined) {
    if (!isRecord(schema.items)) return undefined;
    const sub = toGeminiOpenApiSchema(schema.items, depth + 1);
    if (!sub) return undefined;
    out.type = 'ARRAY';
    out.items = sub;
  }
  if (Array.isArray(schema.anyOf)) {
    const branches: Record<string, unknown>[] = [];
    for (const item of schema.anyOf) {
      if (!isRecord(item)) return undefined;
      const sub = toGeminiOpenApiSchema(item, depth + 1);
      if (!sub) return undefined;
      branches.push(sub);
    }
    out.anyOf = branches;
  }
  if (!out.type && !out.anyOf) return undefined;
  return out;
}

/**
 * Coordinates `outputContract` and `tools`/`toolChoice`: when tools are active and a tool call is
 * forced (`required` / `tool`), `toolChoice` takes precedence and `outputContract` is deferred until
 * the final text-answer turn.
 */
export function activeOutputContract(
  controls: NativeTurnControls | undefined,
  hasActiveTools: boolean,
): OutputContract | undefined {
  if (!controls?.outputContract) return undefined;
  if (hasActiveTools && isForcedToolChoice(controls.toolChoice)) return undefined;
  return controls.outputContract;
}

export function openAIChatControls(
  controls: NativeTurnControls | undefined,
  hasTools: boolean,
): Record<string, unknown> {
  if (!controls) return {};
  const out: Record<string, unknown> = {};
  const tc = controls.toolChoice;
  if (tc && hasTools) {
    out.tool_choice =
      tc.mode === 'tool' ? { type: 'function', function: { name: tc.name } } : tc.mode;
  }
  const contract = activeOutputContract(controls, hasTools && tc?.mode !== 'none');
  if (contract?.kind === 'json_object') {
    out.response_format = { type: 'json_object' };
  } else if (
    contract?.kind === 'json_schema' &&
    contract.schema &&
    isOpenAIStrictCompatible(contract.schema)
  ) {
    out.response_format = {
      type: 'json_schema',
      json_schema: {
        name: sanitizeSchemaName(contract.name),
        schema: contract.schema,
        strict: true,
      },
    };
  }
  return out;
}

export function openAIResponsesControls(
  controls: NativeTurnControls | undefined,
  hasTools: boolean,
): Record<string, unknown> {
  if (!controls) return {};
  const out: Record<string, unknown> = {};
  const tc = controls.toolChoice;
  if (tc && hasTools) {
    out.tool_choice = tc.mode === 'tool' ? { type: 'function', name: tc.name } : tc.mode;
  }
  const contract = activeOutputContract(controls, hasTools && tc?.mode !== 'none');
  if (contract?.kind === 'json_object') {
    out.text = { format: { type: 'json_object' } };
  } else if (
    contract?.kind === 'json_schema' &&
    contract.schema &&
    isOpenAIStrictCompatible(contract.schema)
  ) {
    out.text = {
      format: {
        type: 'json_schema',
        name: sanitizeSchemaName(contract.name),
        schema: contract.schema,
        strict: true,
      },
    };
  }
  return out;
}

export function anthropicControls(
  controls: NativeTurnControls | undefined,
  tools: Record<string, unknown>[],
): {
  tools?: Record<string, unknown>[];
  tool_choice?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
} {
  const tc = controls?.toolChoice;
  const effectiveTools = tc?.mode === 'none' ? [] : tools;
  const out: {
    tools?: Record<string, unknown>[];
    tool_choice?: Record<string, unknown>;
    output_config?: Record<string, unknown>;
  } = {
    ...(effectiveTools.length ? { tools: effectiveTools } : {}),
  };
  if (tc && tc.mode !== 'none' && effectiveTools.length) {
    out.tool_choice =
      tc.mode === 'tool'
        ? { type: 'tool', name: tc.name }
        : tc.mode === 'auto'
          ? { type: 'auto' }
          : { type: 'any' };
  }
  const contract = activeOutputContract(controls, effectiveTools.length > 0);
  if (
    contract?.kind === 'json_schema' &&
    contract.schema &&
    isAnthropicSchemaCompatible(contract.schema)
  ) {
    out.output_config = { format: { type: 'json_schema', schema: contract.schema } };
  }
  return out;
}

export function geminiControls(
  controls: NativeTurnControls | undefined,
  hasTools: boolean,
): {
  generationConfigExtra: Record<string, unknown>;
  toolConfig?: Record<string, unknown>;
} {
  const tc = controls?.toolChoice;
  let toolConfig: Record<string, unknown> | undefined;
  if (tc && hasTools) {
    toolConfig = {
      functionCallingConfig:
        tc.mode === 'tool'
          ? { mode: 'ANY', allowedFunctionNames: [tc.name] }
          : tc.mode === 'auto'
            ? { mode: 'AUTO' }
            : tc.mode === 'none'
              ? { mode: 'NONE' }
              : { mode: 'ANY' },
    };
  }
  const generationConfigExtra: Record<string, unknown> = {};
  const contract = activeOutputContract(controls, hasTools && tc?.mode !== 'none');
  if (contract) {
    generationConfigExtra.responseMimeType = 'application/json';
    if (contract.kind === 'json_schema' && contract.schema) {
      const openApiSchema = toGeminiOpenApiSchema(contract.schema);
      if (openApiSchema) {
        generationConfigExtra.responseSchema = openApiSchema;
      }
    }
  }
  return { generationConfigExtra, ...(toolConfig ? { toolConfig } : {}) };
}

/** Whether a Kernel turn with `repairs === 0` can stream tokens directly via native wire pushdown. */
export function canNativeStreamStructured(
  providerKind: ProviderConfig['kind'] | undefined,
  contract: OutputContract,
  hasActiveTools: boolean,
): boolean {
  if (!providerKind || hasActiveTools) return false;
  if (providerKind === 'openai-chat') {
    return Boolean(openAIChatControls({ outputContract: contract }, false).response_format);
  }
  if (providerKind === 'openai-responses') {
    return Boolean(openAIResponsesControls({ outputContract: contract }, false).text);
  }
  if (providerKind === 'anthropic-messages') {
    return Boolean(anthropicControls({ outputContract: contract }, []).output_config);
  }
  if (providerKind === 'gemini-generate') {
    return Boolean(
      geminiControls({ outputContract: contract }, false).generationConfigExtra.responseMimeType,
    );
  }
  return false;
}
