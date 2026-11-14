/**
 * The structured-output request fields of the four entries, turned into one output contract
 * (kernel/output-contract.ts; docs/structured-output.md):
 *
 * - Chat Completions `response_format`: `json_object`, `json_schema` (`json_schema.schema`, `name`, `strict`)
 * - Responses `text.format`: `json_object`, `json_schema` (`schema`, `name`, `strict`)
 * - Gemini `generationConfig.responseMimeType: "application/json"` with `responseSchema` (the OpenAPI
 *   subset the SDKs send, uppercase types) or `responseJsonSchema` (plain JSON Schema)
 * - Claude Messages `output_config.format` (`type: "json_schema"`)
 *
 * A schema the gateway cannot honestly enforce is refused here, at request time, with the error that
 * says what is wrong (kernel/output-contract.ts `assertContractSchema`).
 */
import type { OutputContract } from '../core/contracts.js';
import { JsonSchemas } from '../core/schemas.js';
import { Fault } from '../core/util.js';
import { assertContractSchema, contractInstruction } from '../kernel/output-contract.js';
import { geminiSchema } from './client-tools.js';
import { CompatFault } from './compat-errors.js';

const schemas = new JsonSchemas({ formats: true });

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const bad = (param: string, message: string) =>
  new CompatFault('invalid_request', message, 400, param);

/** Checks the schema now; a rejected schema is a 400 that names the field it came from. */
function verified(contract: OutputContract, param: string): OutputContract {
  try {
    assertContractSchema(contract, schemas);
  } catch (error) {
    if (error instanceof Fault) throw new CompatFault(error.code, error.message, 400, param);
    throw error;
  }
  return contract;
}

function jsonSchemaContract(
  spec: Record<string, unknown>,
  param: string,
  extra: Partial<OutputContract> = {},
): OutputContract {
  if (!isObject(spec.schema)) throw bad(`${param}.schema`, 'json_schema needs a "schema" object.');
  return verified(
    {
      kind: 'json_schema',
      schema: spec.schema,
      ...(typeof spec.name === 'string' ? { name: spec.name.slice(0, 64) } : {}),
      ...(typeof spec.strict === 'boolean' ? { strict: spec.strict } : {}),
      ...extra,
    },
    `${param}.schema`,
  );
}

/** Chat Completions `response_format`. */
export function chatContract(format: unknown): OutputContract | undefined {
  if (format === undefined || format === null) return undefined;
  if (!isObject(format)) throw bad('response_format', 'response_format must be an object.');
  if (format.type === 'text') return undefined;
  if (format.type === 'json_object') return { kind: 'json_object' };
  if (format.type === 'json_schema') {
    if (!isObject(format.json_schema))
      throw bad('response_format.json_schema', 'json_schema needs a "json_schema" object.');
    return jsonSchemaContract(format.json_schema, 'response_format.json_schema');
  }
  throw bad(
    'response_format.type',
    'response_format.type must be text, json_object or json_schema.',
  );
}

/** Responses `text.format`. The caller's own object is kept for the response's `text.format`. */
export function responsesContract(text: unknown): OutputContract | undefined {
  const format = isObject(text) ? text.format : undefined;
  if (format === undefined || format === null) return undefined;
  if (!isObject(format)) throw bad('text.format', 'text.format must be an object.');
  if (format.type === 'text') return undefined;
  if (format.type === 'json_object') return { kind: 'json_object', format };
  if (format.type === 'json_schema') return jsonSchemaContract(format, 'text.format', { format });
  throw bad('text.format.type', 'text.format.type must be text, json_object or json_schema.');
}

/** Gemini `generationConfig` (already in camelCase). */
export function geminiContract(config: unknown): OutputContract | undefined {
  if (!isObject(config)) return undefined;
  const mime = config.responseMimeType;
  if (mime === undefined || mime === 'text/plain') return undefined;
  if (mime === 'text/x.enum')
    throw bad(
      'generationConfig.responseMimeType',
      'responseMimeType text/x.enum is not supported; use application/json.',
    );
  if (mime !== 'application/json')
    throw bad(
      'generationConfig.responseMimeType',
      'responseMimeType must be text/plain or application/json.',
    );
  if (isObject(config.responseJsonSchema))
    return verified(
      { kind: 'json_schema', schema: config.responseJsonSchema },
      'generationConfig.responseJsonSchema',
    );
  if (isObject(config.responseSchema))
    return verified(
      {
        kind: 'json_schema',
        schema: geminiSchema(config.responseSchema) as Record<string, unknown>,
      },
      'generationConfig.responseSchema',
    );
  return { kind: 'json_any' };
}

/** Claude Messages `output_config.format`. */
export function claudeContract(outputConfig: unknown): OutputContract | undefined {
  const format = isObject(outputConfig) ? outputConfig.format : undefined;
  if (format === undefined || format === null) return undefined;
  if (!isObject(format) || format.type !== 'json_schema' || !isObject(format.schema))
    throw bad(
      'output_config.format',
      'output_config.format must be {"type":"json_schema","schema":{...}}.',
    );
  return verified({ kind: 'json_schema', schema: format.schema }, 'output_config.format.schema');
}

/** The sentence added to the request input so the agent knows the shape to produce. */
export const instructionFor = contractInstruction;
