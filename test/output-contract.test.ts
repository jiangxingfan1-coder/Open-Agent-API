import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonSchemas } from '../src/core/schemas.js';
import {
  REPAIR_MARKER,
  assertContractSchema,
  checkAnswer,
  extractJson,
  repairPrompt,
  unsupportedFeature,
} from '../src/kernel/output-contract.js';

// The pure part of structured output (docs/structured-output.md): unwrap, parse, validate.

const schemas = new JsonSchemas({ formats: true });
const PERSON = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
  required: ['name', 'age'],
  additionalProperties: false,
};

test('extractJson: fences, surrounding prose and whitespace are not part of the answer', () => {
  const object = { a: 1 };
  for (const text of [
    '{"a":1}',
    '  \n{"a": 1}\n ',
    '```json\n{"a": 1}\n```',
    '```\n{"a": 1}\n```',
    'Here is the JSON you asked for:\n```json\n{ "a": 1 }\n```\nHope this helps!',
    'Sure! {"a": 1} Done.',
  ])
    assert.deepEqual(extractJson(text)?.value, object, text);
  assert.deepEqual(extractJson('[1, 2]')?.value, [1, 2]);
  assert.equal(extractJson('no json here'), undefined);
  assert.equal(extractJson('{"a": '), undefined);
  assert.equal(extractJson(''), undefined);
});

test('checkAnswer: json_object, json_any and json_schema; the verdict text is compact JSON', () => {
  const ok = checkAnswer({ kind: 'json_object' }, '```json\n{"a": 1,\n "b": [1, 2]}\n```', schemas);
  assert.deepEqual(ok, { ok: true, text: '{"a":1,"b":[1,2]}' });
  const array = checkAnswer({ kind: 'json_object' }, '[1]', schemas);
  assert.equal(array.ok, false);
  assert.match(String((array as { problem: string }).problem), /not a JSON object/);
  assert.deepEqual(checkAnswer({ kind: 'json_any' }, '[1, 2]', schemas), {
    ok: true,
    text: '[1,2]',
  });
  assert.equal(checkAnswer({ kind: 'json_any' }, 'prose', schemas).ok, false);

  const contract = { kind: 'json_schema' as const, schema: PERSON };
  assert.deepEqual(checkAnswer(contract, '{"name":"Ada","age":36}', schemas), {
    ok: true,
    text: '{"name":"Ada","age":36}',
  });
  for (const bad of [
    '{"name":"Ada"}',
    '{"name":"Ada","age":-1}',
    '{"name":"Ada","age":1.5}',
    '{"name":"Ada","age":1,"x":1}',
  ]) {
    const verdict = checkAnswer(contract, bad, schemas);
    assert.equal(verdict.ok, false, bad);
    assert.match((verdict as { problem: string }).problem, /does not match the schema/);
  }
});

test('checkAnswer: format keywords are enforced, not skipped', () => {
  const contract = {
    kind: 'json_schema' as const,
    schema: {
      type: 'object',
      properties: {
        when: { type: 'string', format: 'date-time' },
        id: { type: 'string', format: 'uuid' },
      },
    },
  };
  assert.equal(
    checkAnswer(
      contract,
      '{"when":"2026-11-14T10:00:00Z","id":"123e4567-e89b-12d3-a456-426614174000"}',
      schemas,
    ).ok,
    true,
  );
  assert.equal(checkAnswer(contract, '{"when":"yesterday"}', schemas).ok, false);
  assert.equal(checkAnswer(contract, '{"id":"nope"}', schemas).ok, false);
});

test('checkAnswer: draft 2019-09 and 2020-12 schemas are validated by their own rules', () => {
  const draft2020 = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      tags: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'integer' } },
    },
  };
  const contract = { kind: 'json_schema' as const, schema: draft2020 };
  assert.equal(checkAnswer(contract, '{"tags":["a",1,2]}', schemas).ok, true);
  assert.equal(checkAnswer(contract, '{"tags":["a","b"]}', schemas).ok, false);
});

test('unsupportedFeature: what Ajv would skip or what could hurt is refused, standard keywords pass', () => {
  assert.equal(unsupportedFeature(PERSON), undefined);
  assert.equal(
    unsupportedFeature({
      type: 'object',
      properties: { a: { $ref: '#/$defs/x' } },
      $defs: { x: { type: 'string' } },
    }),
    undefined,
  );
  assert.match(unsupportedFeature({ $async: true }) ?? '', /\$async/);
  assert.match(
    unsupportedFeature({ properties: { a: { $ref: 'https://example.com/s.json' } } }) ?? '',
    /\$ref/,
  );
  assert.match(unsupportedFeature({ type: 'string', format: 'made-up' }) ?? '', /format "made-up"/);
  assert.match(
    unsupportedFeature({ type: 'string', pattern: '(a+)+$' }) ?? '',
    /nested quantifiers/,
  );
  assert.match(
    unsupportedFeature({ type: 'string', pattern: 'a'.repeat(300) }) ?? '',
    /longer than/,
  );
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 50; i++) deep = { type: 'array', items: deep };
  assert.match(unsupportedFeature(deep) ?? '', /nesting deeper/);
  // Data keywords are not searched: an enum value that looks like a reference is just a value.
  assert.equal(
    unsupportedFeature({ enum: [{ $ref: 'http://x' }], default: { format: 'nope' } }),
    undefined,
  );
});

test('assertContractSchema: size, dialect, compilation and unsupported features give distinct 400 codes', () => {
  assertContractSchema({ kind: 'json_object' }, schemas);
  assertContractSchema({ kind: 'json_schema', schema: PERSON }, schemas);
  const code = (schema: Record<string, unknown>) => {
    try {
      assertContractSchema({ kind: 'json_schema', schema }, schemas);
    } catch (error) {
      return (error as { code: string }).code;
    }
    return 'accepted';
  };
  assert.equal(
    code({ type: 'object', properties: { a: { $ref: 'http://x/y' } } }),
    'output_schema_unsupported',
  );
  assert.equal(code({ type: 'not-a-type' }), 'invalid_schema');
  assert.equal(
    code({ $schema: 'https://example.com/other', type: 'object' }),
    'schema_dialect_unsupported',
  );
  assert.equal(code({ type: 'object', description: 'x'.repeat(70_000) }), 'invalid_schema');
});

test('repairPrompt: carries the marker, the problem and a shortened copy of the answer', () => {
  const prompt = repairPrompt(
    { kind: 'json_schema', schema: PERSON },
    'the answer is not parseable JSON',
    'x'.repeat(5000),
  );
  assert.ok(prompt.startsWith(REPAIR_MARKER));
  assert.match(prompt, /not parseable JSON/);
  assert.ok(prompt.length < 2600, 'the previous answer is shortened');
  assert.match(prompt, /satisfies the schema/);
});
