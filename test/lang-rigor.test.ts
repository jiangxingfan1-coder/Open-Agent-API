import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOaaLang, diagnoseOaaLang, formatOaaLang } from '../src/lang/lang.js';
import { Fault } from '../src/core/util.js';

// T12 语言严谨性：每一类以前会崩溃、被静默接受或报错不带位置的写法。离线，不监听端口。

/** 第 1 行是 prelude，正文从第 7 行开始。 */
const agentWith = (body: string, prelude = '') => `${prelude}
agent "agent/demo" {
  description = "demo"
  model = "m"
  provider = "p"
  use builtin read_file
${body}
}`;

const failure = (source: string): { code: string; message: string; fault: boolean } => {
  try {
    compileOaaLang(source);
  } catch (e) {
    return {
      code: (e as Fault).code,
      message: String((e as Error).message),
      fault: e instanceof Fault,
    };
  }
  throw new Error(`expected a compile error:\n${source}`);
};

const located = (source: string, line: number, pattern: RegExp, code = 'oaa_syntax_error') => {
  const f = failure(source);
  assert.ok(f.fault, `${f.message}\n${source}`);
  assert.equal(f.code, code, f.message);
  assert.match(f.message, new RegExp(`^Line ${line}, Col \\d+: `), source);
  assert.match(f.message, pattern, source);
};

test('严谨性 1：route r null 与 limits = null 报带位置的语法错误，而不是 TypeError', () => {
  located(agentWith('  route r null'), 7, /route/i);
  located(agentWith('  limits = null'), 7, /limits/i);
  located(agentWith('  limits = [1]'), 7, /limits/i);
});

test('严谨性 2：常量只在值的位置展开，键名、工具名、ID 不被替换', () => {
  const builtinName = compileOaaLang(agentWith('', 'let read_file = "write_file"'));
  assert.deepEqual(
    builtinName.agent.tools.map((t) => t.name),
    ['read_file'],
  );
  const single = compileOaaLang(
    agentWith('  use builtin list_files', 'let list_files = "write_file"'),
  );
  assert.deepEqual(
    single.agent.tools.map((t) => t.name),
    ['read_file', 'list_files'],
  );
  const keys = compileOaaLang(
    agentWith(
      `  flow f {
    params { path: string }
    step path = read_file(path = $input.path)
  }
  limits { max_turns = turns }`,
      'let path = "zzz"\nlet turns = 3',
    ),
  );
  const flow = keys.agent.workflows![0]!;
  assert.deepEqual(Object.keys((flow.inputSchema as { properties: object }).properties), ['path']);
  assert.equal(flow.steps[0]!.id, 'path');
  assert.deepEqual(Object.keys(flow.steps[0]!.arguments as object), ['path']);
  // 值的位置照常展开。
  assert.equal(keys.agent.limits.maxTurns, 3);
  const values = compileOaaLang(
    agentWith('  instructions = "我是 ${who}"', 'let who = "研究员"\nlet m = "mm"').replace(
      'model = "m"',
      'model = m',
    ),
  );
  assert.equal(values.agent.model, 'mm');
  assert.equal(values.agent.instructions, '我是 研究员');
  // route / delegate 的名字不替换。
  const names = compileOaaLang(
    agentWith('  route fast -> "q"/"m2"\n  delegate fast_d -> "agent/x"', 'let fast = "slow"'),
  );
  assert.equal(names.agent.routes[0]!.id, 'fast');
});

test('严谨性 3：能编译但步骤 ID 不安全的程序仍判为有效，格式化给 ID 加引号', () => {
  const source = agentWith('  flow f { step "1a" = read_file(path = ".") }');
  const report = diagnoseOaaLang(source);
  assert.equal(report.valid, true, JSON.stringify(report.diagnostics));
  assert.ok(!report.diagnostics.some((d) => d.severity === 'error'));
  assert.match(report.formatted!, /step "1a" = read_file/);
  assert.equal(
    JSON.stringify(compileOaaLang(formatOaaLang(source)).agent),
    JSON.stringify(compileOaaLang(source).agent),
  );
});

test('严谨性 4：Zod 校验错误映射回源码位置，用一句可读的话', () => {
  const limits = agentWith('  limits {\n    max_turns = 0\n  }');
  located(limits, 8, /max_turns/, 'oaa_validation_error');
  assert.doesNotMatch(failure(limits).message, /"code"|\[\s*\{/);
  located(agentWith('  engine = "nope"'), 7, /engine/, 'oaa_validation_error');
  located(agentWith('  route r -> "p"/"m" cost=9'), 7, /cost/i, 'oaa_validation_error');
  // 映射不到具体属性时退回 agent 声明的位置，不丢位置。
  located(
    agentWith('  tool read_file { reference = "x" }'),
    2,
    /Duplicate tool/,
    'oaa_validation_error',
  );
  const report = diagnoseOaaLang(limits);
  const error = report.diagnostics.find((d) => d.severity === 'error')!;
  assert.equal(error.code, 'oaa_validation_error');
  assert.equal(error.line, 8);
  assert.equal(typeof error.col, 'number');
});

test('严谨性 4：执行图校验错误带所属 flow / step 的位置并保留原错误码', () => {
  const source = agentWith(`  flow f {
    step a = read_file(path = ".")
    step b = read_file(path = $missing.x)
  }`);
  const f = failure(source);
  assert.notEqual(f.code, 'execution_failed');
  assert.match(f.message, /^Line 9, Col \d+: /);
  const report = diagnoseOaaLang(source);
  const error = report.diagnostics.find((d) => d.severity === 'error')!;
  assert.notEqual(error.code, 'execution_failed');
  assert.equal(error.line, 9);
  // 找不到步骤时退到 flow 声明。
  const output = failure(
    agentWith('  flow g {\n    step a = read_file(path = ".")\n    return $nope\n  }'),
  );
  assert.match(output.message, /^Line 7, Col \d+: /);
});

test('严谨性 5：重复声明明确报错', () => {
  for (const [body, line, prelude] of [
    ['  description = "again"', 7],
    ['  model = "again"', 7],
    ['  instructions = "a"\n  instructions = "b"', 8],
    ['  limits { max_turns = 1 }\n  limits { max_turns = 2 }', 8],
    ['  let x = 1\n  let x = 2', 8],
    ['', 2, 'let x = 1\nlet x = 2'],
    [
      '  flow f {\n    params { a: string }\n    params { b: string }\n    step a = read_file(path = ".")\n  }',
      9,
    ],
    [
      '  flow f {\n    description = "a"\n    description = "b"\n    step a = read_file(path = ".")\n  }',
      9,
    ],
    ['  flow f {\n    step a = read_file(path = ".") when $(true) when $(false)\n  }', 8],
    ['  flow f {\n    step a = read_file(path = ".") fallback = 1 fallback = 2\n  }', 8],
    [
      '  flow f {\n    step a = read_file(path = ".")\n    step b = read_file(path = ".") depends_on = ["a"] depends_on = ["a"]\n  }',
      9,
    ],
  ] as [string, number, string?][])
    located(agentWith(body, prelude ?? ''), line, /Duplicate/);
});

test('严谨性 5：未知键与未知类型修饰给出建议', () => {
  located(
    agentWith('  delegate d -> "agent/x" { timout = 5s }'),
    7,
    /Unknown property 'timout'\. Did you mean 'timeout'\?/,
  );
  located(
    agentWith(
      '  flow f {\n    step a = read_file(path = $item) foreach item in $input.xs (maxx=3)\n  }',
    ),
    8,
    /Unknown foreach option 'maxx'\. Did you mean 'max'\?/,
  );
  located(agentWith('  output_schema { a: string(foo=1) }'), 7, /Unknown type modifier 'foo'/);
  located(agentWith('  output_schema { a: string(patern="x") }'), 7, /Did you mean 'pattern'\?/);
});

test('严谨性 5：修饰与类型不符、混合字面量联合', () => {
  located(agentWith('  output_schema { a: bool(min=1) }'), 7, /'min'.*bool/);
  located(agentWith('  output_schema { a: int(default="x") }'), 7, /default/);
  located(agentWith('  output_schema { a: string(pattern=1) }'), 7, /pattern/);
  located(agentWith('  output_schema { a: "x" | 1 }'), 7, /union/i);
  // 合法写法照旧。
  const ok = compileOaaLang(
    agentWith(
      '  output_schema { a: int(min=1, default=2) b: string(min=1, pattern="^x") c: any(default="x") }',
    ),
  );
  assert.ok(ok.agent.outputSchema);
});

test('严谨性 5：属性值类型不对时报错', () => {
  located(
    agentWith('  instructions = "x"').replace('description = "demo"', 'description = { a = 1 }'),
    3,
    /'description' must be a string/,
  );
  located(agentWith('').replace('model = "m"', 'model = 5'), 4, /'model' must be a string/);
  located(agentWith('  files = [1, 2]'), 7, /'files' must be an array of/);
  located(
    agentWith('  flow f {\n    description = 5\n    step a = read_file(path = ".")\n  }'),
    8,
    /description/,
  );
});

test('严谨性 5：与内置类型同名的别名、名为 input 的步骤、超范围数字', () => {
  located(agentWith('', 'type Str = int'), 1, /shadow a built-in type/);
  located(agentWith('', 'type STRING = int'), 1, /shadow a built-in type/);
  located(agentWith('  flow f { step input = read_file(path = ".") }'), 7, /input/);
  located(agentWith('  limits { max_turns = 1e400 }'), 7, /numeric|range/i);
  assert.equal(compileOaaLang(agentWith('  limits { max_turns = 1e1 }')).agent.limits.maxTurns, 10);
});

test('严谨性 6：默认提供方在 agent 块解析完之后确定，与 route 的书写顺序无关', () => {
  const before = compileOaaLang(`agent "agent/a" {
  route r -> m1
  route s { model = "m2" }
  provider = "p"
}`);
  assert.deepEqual(
    before.agent.routes.map((r) => r.provider),
    ['p', 'p'],
  );
  const after = compileOaaLang(`agent "agent/a" {
  provider = "p"
  route r -> m1
  route s { model = "m2" }
}`);
  assert.equal(JSON.stringify(after.agent), JSON.stringify(before.agent));
  // 明确写了提供方的 route 不受影响；没有 provider 时仍是 default。
  const explicit = compileOaaLang(`agent "agent/a" {
  route r -> q/m1
  route s -> m2
}`);
  assert.deepEqual(
    explicit.agent.routes.map((r) => r.provider),
    ['q', 'default'],
  );
});
