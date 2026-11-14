import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileOaaLang,
  decompileToOaaLang,
  formatOaaLang,
  diagnoseOaaLang,
} from '../src/lang/lang.js';
import { builtin } from '../src/lang/bundle.js';
import { agent } from './helpers.js';
import { canonical } from '../src/core/util.js';

const module = (body: string) => `agent "agent/contract" { model = "fixture" ${body} }`;

test('formatting preserves explicit ordering dependencies and the complete compiled definition', () => {
  const source = module(`use builtin [write_file, read_file]
    flow "ordered" {
      step write = write_file(path = "result.txt", content = "done")
      step read = read_file(path = "outputs/result.txt") depends_on = ["write"]
    }
  `);
  const before = compileOaaLang(source);
  const formatted = formatOaaLang(source);
  assert.equal(canonical(compileOaaLang(formatted)), canonical(before));
  assert.equal(formatOaaLang(formatted), formatted);
});

test('quoted instructions and JSON string escapes survive decompilation exactly', () => {
  const definition = agent({
    instructions: '  leading\n\nkeep """ exactly\r\n\b\f\u0001\n',
    description: 'unicode-\u0002',
  });
  const source = decompileToOaaLang(definition);
  assert.equal(canonical(compileOaaLang(source).agent), canonical(definition));
});

test('decompilation preserves builtin overrides, tool order, skills and exact delegate model selectors', () => {
  const read = builtin('read_file');
  read.name = 'reviewed_read';
  read.required = true;
  read.capability.requiresApproval = true;
  read.capability.resultExport = false;
  const definition = agent({
    tools: [read, builtin('memory_read')],
    skills: [{ name: 'review', description: 'Reviewed skill', path: 'skills/review/SKILL.md' }],
    delegates: [{ name: 'ask', agent: 'agent/peer', model: 'fast' }],
    routes: [{ id: 'r', provider: 'provider/route', model: 'm', priority: 0 }],
  });
  assert.equal(
    canonical(compileOaaLang(decompileToOaaLang(definition)).agent),
    canonical(definition),
  );
});

test('unknown or misleading runtime policy properties fail rather than silently using defaults', () => {
  for (const body of [
    'limits { tool_concurency = 12 }',
    'tool "read" { reference = "read", requireApproval = true }',
    'tool "read" { reference = "read", approval = "false" }',
    'allow_graph = "false"',
  ])
    assert.equal(diagnoseOaaLang(module(body)).valid, false, body);
  assert.equal(compileOaaLang(module('limits { wall_ms = 2m }')).agent.limits.timeoutMs, 120000);
});

test('flow syntax supports explicit result projection and a checked output schema', () => {
  const source = module(`
    flow "project" {
      params { prefix: string }
      step source = $transform(value = "value", internal = "not returned")
      output_schema { label: string }
      return { label: "{{$input.prefix}}:{{source.value}}" }
    }
  `);
  const compiled = compileOaaLang(source);
  const flow = compiled.agent.workflows![0]!;
  assert.deepEqual(flow.output, { label: { $template: '{{$input#/prefix}}:{{source#/value}}' } });
  assert.deepEqual(flow.outputSchema, {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
    additionalProperties: false,
  });
  assert.equal(canonical(compileOaaLang(formatOaaLang(source))), canonical(compiled));
});

test('projection validation rejects missing step names and leaking foreach locals before execution', () => {
  for (const value of ['$missing', '$item', '$(missing.value)', '"{{$index}}"']) {
    assert.equal(
      diagnoseOaaLang(module(`flow "f" { step a = $transform(value = 1) return ${value} }`)).valid,
      false,
      value,
    );
  }
  assert.equal(
    diagnoseOaaLang(module('flow "f" { step a = $transform(value = 1) return 1 return 2 }')).valid,
    false,
  );
});

test('literal text, explicit descriptors, defaults, and unusual argument keys survive formatting', () => {
  const source = module(`flow "data" {
    step a = $transform("long key" = literal("{{not_a_reference}}"))
    step b = $transform(value = { "$ref": "a#/long key", "$default": { "example": "{{literal}}" } },
      constant = { "$template": "constant text" })
    return { "$ref": "b" }
  }`);
  const before = compileOaaLang(source);
  assert.equal(canonical(compileOaaLang(formatOaaLang(source))), canonical(before));
  assert.equal(
    before.agent.workflows![0]!.steps[0]!.arguments &&
      (before.agent.workflows![0]!.steps[0]!.arguments as Record<string, unknown>)['long key'],
    '{{not_a_reference}}',
  );
});

test('explicit JSON schemas preserve arbitrary keyword order and type-less composition', () => {
  const source = module(`flow "schema" {
    input_schema = json { additionalProperties: false, properties: {}, type: "object" }
    output_schema = json { anyOf: [{ type: "string" }, { type: "null" }] }
    step a = $transform(value = 1)
    return null
  }
  output_schema = json {}
  `);
  assert.equal(canonical(compileOaaLang(formatOaaLang(source))), canonical(compileOaaLang(source)));
});

test('script network bounds and policy flags survive the exact-binding formatter', () => {
  const source = module(`tool "script" {
    script = "scripts/owned.mjs" runtime = node effect = read required = true
    approval = true result_export = false
    network { allowedDomains = ["example.com"] }
    params { query: string }
  }
  use builtin read_file
  `);
  const before = compileOaaLang(source);
  assert.equal(canonical(compileOaaLang(formatOaaLang(source))), canonical(before));
  assert.deepEqual(before.agent.tools[0]!.capability.network, { allowedDomains: ['example.com'] });
});

test('duplicate data, schema, and step-argument fields are not silently overwritten', () => {
  for (const body of [
    'limits { max_turns = 1 max_turns = 10 }',
    'flow "f" { params { x: string x: integer } step a = $transform(value = 1) }',
    'flow "f" { step a = $transform(value = 1 value = 2) }',
  ])
    assert.throws(() => compileOaaLang(module(body)), /Duplicate property/);
});
