/**
 * Structured output (docs/structured-output.md): the caller asked for JSON, so a successful answer
 * must be JSON that fits, or the run fails. This module is the pure part: unwrap, parse, validate,
 * and the wording of a correction round. execute.ts runs it when the final answer is in.
 *
 * Validation is Ajv (draft-07, 2019-09 and 2020-12) plus ajv-formats: the same library the
 * published `outputSchema` and the tool schemas already use. What Ajv would silently skip is refused
 * up front instead (`unsupportedFeature`): a contract that is not checked is not a contract.
 */
import type { OutputContract } from '../core/contracts.js';
import { JsonSchemas, knownFormats } from '../core/schemas.js';
import { Fault } from '../core/util.js';

export const MAX_CONTRACT_SCHEMA_BYTES = 65_536;
const MAX_DEPTH = 40;
const MAX_PATTERN = 256;
/** A nested quantifier such as `(a+)+` can take exponential time on a crafted answer. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*{]/;
/** Keywords whose value is data, not a subschema: never searched for `$ref` or `format`. */
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples', 'example']);

let formats: Set<string> | undefined;

/**
 * The first thing in `schema` that Ajv would ignore or that could hurt the gateway, or undefined.
 * Standard keywords of the three supported drafts are all validated by Ajv; this lists the rest:
 * asynchronous schemas, references outside the document, `format` names nobody implements, regular
 * expressions that are very long or can backtrack exponentially, and absurd nesting.
 */
export function unsupportedFeature(schema: unknown): string | undefined {
  formats ??= knownFormats();
  const walk = (node: unknown, path: string, depth: number): string | undefined => {
    if (depth > MAX_DEPTH) return `${path || '$'}: nesting deeper than ${MAX_DEPTH} levels`;
    if (Array.isArray(node)) {
      for (const [i, child] of node.entries()) {
        const found = walk(child, `${path}/${i}`, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (!node || typeof node !== 'object') return undefined;
    const obj = node as Record<string, unknown>;
    if (obj.$async) return `${path || '$'}: "$async" is not supported`;
    if (typeof obj.$ref === 'string' && !obj.$ref.startsWith('#'))
      return `${path || '$'}: "$ref" must point inside the schema (starts with #), got "${obj.$ref.slice(0, 60)}"`;
    if (typeof obj.format === 'string' && !formats!.has(obj.format))
      return `${path || '$'}: format "${obj.format.slice(0, 40)}" is not implemented, so it could not be enforced`;
    const patterns = [
      ...(typeof obj.pattern === 'string' ? [obj.pattern] : []),
      ...(obj.patternProperties && typeof obj.patternProperties === 'object'
        ? Object.keys(obj.patternProperties)
        : []),
    ];
    for (const pattern of patterns)
      if (pattern.length > MAX_PATTERN || NESTED_QUANTIFIER.test(pattern))
        return `${path || '$'}: the regular expression is longer than ${MAX_PATTERN} characters or has nested quantifiers`;
    for (const [key, child] of Object.entries(obj)) {
      if (DATA_KEYWORDS.has(key)) continue;
      const found = walk(child, `${path}/${key}`, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(schema, '', 0);
}

/**
 * Request-time check of a contract's schema (before any run exists): size, dialect, compilability,
 * unsupported features. Throws a 400 Fault; the gateway turns it into the protocol's error.
 */
export function assertContractSchema(contract: OutputContract, schemas: JsonSchemas): void {
  if (contract.kind !== 'json_schema') return;
  const schema = contract.schema;
  if (!schema || Buffer.byteLength(JSON.stringify(schema)) > MAX_CONTRACT_SCHEMA_BYTES)
    throw new Fault(
      'invalid_schema',
      `The output schema is missing or larger than ${MAX_CONTRACT_SCHEMA_BYTES / 1024} KiB.`,
    );
  const unsupported = unsupportedFeature(schema);
  if (unsupported) throw new Fault('output_schema_unsupported', unsupported);
  schemas.compile(schema);
}

/** The JSON texts worth trying, most literal first: the whole text, fenced blocks, outermost braces. */
function candidates(text: string): string[] {
  const out = [text.trim()];
  for (const match of text.matchAll(/```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g))
    out.push(match[1]!.trim());
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) out.push(text.slice(start, end + 1));
  }
  return out.filter((c) => c.length > 0);
}

/** The first parseable candidate: fences, surrounding prose and whitespace are not part of the answer. */
export function extractJson(text: string): { value: unknown } | undefined {
  for (const candidate of candidates(text)) {
    try {
      return { value: JSON.parse(candidate) as unknown };
    } catch {
      // try the next form
    }
  }
  return undefined;
}

export type Verdict = { ok: true; text: string } | { ok: false; problem: string };

const brief = (text: string, limit = 400) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** Does the final answer meet the contract? On success `text` is the normalized JSON (compact, no wrapper). */
export function checkAnswer(
  contract: OutputContract,
  answer: string,
  schemas: JsonSchemas,
): Verdict {
  const parsed = extractJson(answer);
  if (!parsed) return { ok: false, problem: 'the answer is not parseable JSON' };
  const value = parsed.value;
  if (
    contract.kind === 'json_object' &&
    (typeof value !== 'object' || value === null || Array.isArray(value))
  )
    return { ok: false, problem: 'the answer is JSON but not a JSON object' };
  if (contract.kind === 'json_schema' && contract.schema) {
    if (!schemas.validate(contract.schema, value))
      return {
        ok: false,
        problem: `the JSON does not match the schema: ${brief(schemas.errorsText())}`,
      };
  }
  return { ok: true, text: JSON.stringify(value) };
}

/** Marker that starts every correction prompt (scripted stand-ins and the inspector recognise it). */
export const REPAIR_MARKER = '[Structured output repair]';

/** The correction round: self-contained, so an external agent that resumes its session still gets the facts. */
export function repairPrompt(contract: OutputContract, problem: string, previous: string): string {
  return (
    `${REPAIR_MARKER} Your previous answer cannot be used: ${problem}.\n` +
    `Previous answer (shortened):\n${brief(previous, 2000)}\n\n` +
    `Reply again with only the corrected JSON${contract.kind === 'json_schema' ? ' that satisfies the schema from the request' : ''}: ` +
    'no code fence, no explanation, nothing before or after it.'
  );
}

/** Instruction appended to the request input, so the agent knows the shape it has to produce. */
export function contractInstruction(contract: OutputContract): string {
  const what = contract.kind === 'json_object' ? 'a single JSON object' : 'JSON';
  const schema =
    contract.kind === 'json_schema' && contract.schema
      ? `\nJSON Schema${contract.name ? ` (${contract.name})` : ''}: ${JSON.stringify(contract.schema)}`
      : '';
  return `[Response Format Requirement: Respond with ${what}.${schema}\nReply with the JSON only: no code fence, no explanation.]`;
}
