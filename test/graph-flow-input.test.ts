import test from 'node:test';
import assert from 'node:assert/strict';
import { executeGraph, parseGraph, validateWorkflows } from '../src/lang/graph.js';
import { compileOaaLang, formatOaaLang } from '../src/lang/lang.js';
import { canonical } from '../src/core/util.js';

// R3：流程表达式里的 `input` 与 `$input` 等价；execute_graph（没有流程输入）与 JSON 发布的
// 同名步骤保持原样。离线，不监听端口。

const signal = () => new AbortController().signal;
const flowBindings = new Set(['$input', 'input']);

const source = `agent "agent/flow-input" {
  model = "m"
  provider = "p"
  use builtin read_file
  flow head {
    params { text: string limit?: int(default=4) }
    step doc = read_file(path = "README.md") when $(input.limit > 0)
    step cut = $transform(head = $(slice(input.text, 0, 3)), both = $(len(doc.text) > 0 && input.limit > 0))
    return $cut
  }
}`;

test('flow：表达式里直接写 input 能编译，且不产生对步骤的依赖', () => {
  const compiled = compileOaaLang(source) as { agent: { workflows: { steps: unknown[] }[] } };
  const steps = parseGraph(
    { steps: compiled.agent.workflows[0]!.steps },
    new Set(['read_file']),
    undefined,
    flowBindings,
  );
  assert.deepEqual(steps.find((s) => s.id === 'doc')!.depends_on, []);
  assert.deepEqual(steps.find((s) => s.id === 'cut')!.depends_on, ['doc']);
});

test('flow：input 与 $input 在求值时等价', async () => {
  const steps = parseGraph(
    {
      steps: [
        { id: 'a', tool: '$transform', arguments: { v: { $expr: 'slice(input.text, 0, 3)' } } },
        { id: 'b', tool: '$transform', arguments: { v: { $expr: 'slice($input.text, 0, 3)' } } },
        { id: 'c', tool: '$transform', arguments: {}, when: { $expr: 'input.limit > 5' } },
      ],
    },
    new Set(),
    undefined,
    flowBindings,
  );
  const input = { text: 'abcdef', limit: 4 };
  const ran: string[] = [];
  const out = await executeGraph(
    steps,
    2,
    signal(),
    async (s, args) => {
      ran.push(s.id);
      return args;
    },
    undefined,
    { $input: input, input },
  );
  assert.deepEqual(out.a, { v: 'abc' });
  assert.deepEqual(out.b, { v: 'abc' });
  assert.equal(ran.includes('c'), false);
});

test('flow：格式化往返对含 input 表达式的流程一致且幂等', () => {
  const formatted = formatOaaLang(source);
  assert.equal(canonical(compileOaaLang(formatted)), canonical(compileOaaLang(source)));
  assert.equal(formatOaaLang(formatted), formatted);
});

test('execute_graph（没有流程输入）：表达式里的 input 仍按步骤引用，报不存在的步骤', () => {
  assert.throws(
    () =>
      parseGraph(
        { steps: [{ id: 'a', tool: 'work', arguments: { v: { $expr: 'input.limit > 0' } } }] },
        new Set(['work']),
      ),
    /refers to 'input', which is not a step/,
  );
});

test('JSON 发布：有名为 input 的步骤时步骤优先，依赖与结果都指向该步骤', async () => {
  const workflow = {
    name: 'wf',
    description: 'd',
    inputSchema: { type: 'object' },
    steps: [
      { id: 'input', tool: '$transform', arguments: { limit: 9 } },
      { id: 'use', tool: '$transform', arguments: { v: { $expr: 'input.limit' } } },
    ],
  };
  validateWorkflows({ tools: [], workflows: [workflow as never] });
  const steps = parseGraph({ steps: workflow.steps }, new Set(), undefined, flowBindings);
  assert.deepEqual(steps.find((s) => s.id === 'use')!.depends_on, ['input']);
  const out = await executeGraph(steps, 2, signal(), async (_s, args) => args, undefined, {
    $input: { limit: 1 },
    input: { limit: 1 },
  });
  assert.deepEqual(out.use, { v: 9 });
});
