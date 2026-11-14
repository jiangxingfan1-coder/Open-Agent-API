import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOaaLang, diagnoseOaaLang, formatOaaLang, suggestName } from '../src/lang/lang.js';

const agentWith = (body: string, prelude = '') => `${prelude}
agent "agent/demo" {
  description = "demo"
  model = "m"
  provider = "p"
  use builtin read_file
${body}
  instructions "x"
}`;

const failure = (source: string): string => {
  try {
    compileOaaLang(source);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error('expected a compile error');
};

test('type 别名在编译期展开，产物与手写展开完全一致', () => {
  const aliased = compileOaaLang(
    agentWith(
      `  type Excerpt = string(max=2000)
  flow "inspect" {
    params { doc: Doc mode?: Mode tags: Tag[] }
    step document = read_file(path = $input.doc.path)
    output_schema { path: string excerpt: Excerpt }
    return { path: $input.doc.path excerpt: $(slice(document.text, 0, 2000)) }
  }`,
      `type Doc = { path: string(min=1) title?: string }
type Mode = "fast" | "deep"
type Tag = string(max=32)`,
    ),
  );
  const expanded = compileOaaLang(
    agentWith(`  flow "inspect" {
    params {
      doc: { path: string(min=1) title?: string }
      mode?: "fast" | "deep"
      tags: string(max=32)[]
    }
    step document = read_file(path = $input.doc.path)
    output_schema { path: string excerpt: string(max=2000) }
    return { path: $input.doc.path excerpt: $(slice(document.text, 0, 2000)) }
  }`),
  );
  assert.deepEqual(aliased.agent, expanded.agent);
  // 同一个别名用两次，得到的是两份独立的 schema，互不影响。
  const twice = compileOaaLang(
    agentWith(
      `  flow "f" {
    params { a: Name("first") b: Name("second") }
    step s = read_file(path = $input.a)
  }`,
      'type Name = string(max=8)',
    ),
  );
  const props = (twice.agent.workflows![0]!.inputSchema as { properties: Record<string, unknown> })
    .properties;
  assert.deepEqual(props.a, { type: 'string', maxLength: 8, description: 'first' });
  assert.deepEqual(props.b, { type: 'string', maxLength: 8, description: 'second' });
  // 格式化后仍然等价（别名会被展开）。
  const formatted = formatOaaLang(
    agentWith(
      `  flow "f" {
    params { a: Name }
    step s = read_file(path = $input.a)
  }`,
      'type Name = string(max=8)',
    ),
  );
  assert.deepEqual(
    compileOaaLang(formatted).agent.workflows,
    compileOaaLang(
      agentWith(`  flow "f" {
    params { a: string(max=8) }
    step s = read_file(path = $input.a)
  }`),
    ).agent.workflows,
  );
});

test('type 别名的错误：重复、遮蔽内置类型、未定义', () => {
  assert.match(failure(agentWith('', 'type A = string\ntype A = int')), /Duplicate type alias 'A'/);
  assert.match(failure(agentWith('', 'type string = int')), /would shadow a built-in type/);
  assert.match(
    failure(
      agentWith(
        `  flow "f" {
    params { a: Excerp }
    step s = read_file(path = $input.a)
  }`,
        'type Excerpt = string',
      ),
    ),
    /Line \d+, Col \d+: Unknown type 'Excerp' in schema DSL\. Did you mean 'Excerpt'\?/,
  );
});

test('拼错关键字时给出最接近的建议，差得远就不乱猜', () => {
  assert.match(
    failure(agentWith('  descripton = "x"')),
    /Unknown agent property 'descripton'\. Did you mean 'description'\?/,
  );
  assert.match(
    failure(agentWith('  use builtin read_fil')),
    /Unknown built-in capability 'read_fil'\. Did you mean 'read_file'\?/,
  );
  assert.match(
    failure(agentWith('  limits { max_turn = 3 }')),
    /Unknown property 'max_turn'\. Did you mean 'max_turns'\?/,
  );
  assert.match(
    failure(
      agentWith(`  flow "f" {
    stp s = read_file(path = "a")
  }`),
    ),
    /Unexpected statement 'stp' inside flow 'f'\. Did you mean 'step'\?/,
  );
  assert.match(
    failure(
      agentWith(`  flow "f" {
    params { a: strng }
    step s = read_file(path = $input.a)
  }`),
    ),
    /Unknown type 'strng' in schema DSL\. Did you mean 'string'\?/,
  );
  const far = failure(agentWith('  zzzzzzzz = 1'));
  assert.match(far, /Unknown agent property 'zzzzzzzz'\./);
  assert.doesNotMatch(far, /Did you mean/);
  assert.equal(suggestName('timeout', ['timeout']), '');
  assert.equal(suggestName('timeot', ['timeout', 'tags']), " Did you mean 'timeout'?");
});

test('route 写错属性时指出是 route 的问题，而不是误报成未知的智能体属性', () => {
  const message = failure(agentWith('  route "main" -> p/"m" priorty=1'));
  assert.match(message, /Unknown route attribute 'priorty'\. Did you mean 'priority'\?/);
  assert.doesNotMatch(message, /Unknown agent property/);
  // 下一行的智能体属性不会被误当成 route 属性。
  const ok = compileOaaLang(
    agentWith(`  route "main" -> p/"m" priority=1
  allow_graph = false`),
  );
  assert.equal(ok.agent.allowGraph, false);
  assert.match(
    failure(agentWith('  route "main" { provider = "p" modle = "m" }')),
    /Unknown property 'modle'\. Did you mean 'model'\?/,
  );
});

test('诊断报告带上行列号和建议', () => {
  const report = diagnoseOaaLang(agentWith('  descripton = "x"'));
  assert.equal(report.valid, false);
  const error = report.diagnostics.find((d) => d.severity === 'error')!;
  assert.match(error.message, /Did you mean 'description'\?/);
  assert.equal(typeof error.line, 'number');
});

test('诊断一次报全：多处独立的拼写错误一起报出来，结构性错误不连带误报', () => {
  const report = diagnoseOaaLang(`agent "agent/demo" {
  descripton = "demo"
  model = "m"
  provider = "p"
  use builtin read_fil
  limits { max_turn = 3 }
  alow_graph = false
  instructions "x"
}`);
  assert.equal(report.valid, false);
  const errors = report.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(
    errors.map((d) => [d.line, d.message]),
    [
      [2, "Unknown agent property 'descripton'. Did you mean 'description'?"],
      [5, "Unknown built-in capability 'read_fil'. Did you mean 'read_file'?"],
      [6, "Unknown property 'max_turn'. Did you mean 'max_turns'?"],
    ],
  );
  // 第 6 行带花括号，抹掉它可能造成连带错误，所以到此为止，不再往下猜（第 7 行留到下次）。

  // 没有花括号的行可以一直往下找。
  const flat = diagnoseOaaLang(`agent "agent/demo" {
  descripton = "demo"
  modle = "m"
  provider = "p"
  alow_graph = false
  instructions "x"
}`);
  assert.deepEqual(
    flat.diagnostics.filter((d) => d.severity === 'error').map((d) => d.line),
    [2, 3, 5],
  );

  // 结构性错误只报一条。
  const broken = diagnoseOaaLang(`agent "agent/demo" {
  description = "unterminated
  modle = "m"
}`);
  assert.equal(broken.diagnostics.filter((d) => d.severity === 'error').length, 1);

  // 只有一处错误时，结果和以前一样只有一条。
  const single = diagnoseOaaLang(`agent "agent/demo" {
  descripton = "demo"
  model = "m"
  provider = "p"
  instructions "x"
}`);
  assert.equal(single.diagnostics.filter((d) => d.severity === 'error').length, 1);
});

test('格式化用简洁的类型写法输出，表达不了的才退回 json，编译结果始终不变', () => {
  const source = (params: string, output = '') => `agent "agent/demo" {
  description = "demo"
  model = "m"
  provider = "p"
  use builtin read_file
  flow "f" {
    ${params}
    step s = read_file(path = "a")
    ${output}
  }
  instructions "x"
}`;
  const cases: [string, RegExp][] = [
    ['params { path: string }', /params \{ path: string \}/],
    [
      'params { name: string("who", min=1, max=20, pattern="^[a-z]+$") age?: int(min=0, max=150) ok: bool(default=true) }',
      /params \{\n\s+name: string\("who", min=1, max=20, pattern="\^\[a-z\]\+\$"\)\n\s+age\?: int\(min=0, max=150\)\n\s+ok: bool\(default=true\)\n\s+\}/,
    ],
    [
      'params { mode: "fast" | "deep" tags: string(max=8)[] level?: 1 | 2 | 3 }',
      /mode: "fast" \| "deep" tags: string\(max=8\)\[\] level\?: 1 \| 2 \| 3/,
    ],
    [
      'params { doc: { path: string meta?: { size: number } } extra?: any }',
      /doc: \{ path: string meta\?: \{ size: number \} \} extra\?: any/,
    ],
    ['params { "odd-name": string }', /"odd-name": string/],
    ['params {}', /params \{\}/],
  ];
  for (const [params, expected] of cases) {
    const formatted = formatOaaLang(source(params));
    assert.match(formatted, expected, params);
    assert.doesNotMatch(formatted, /input_schema = json/, params);
    assert.deepEqual(compileOaaLang(formatted).agent, compileOaaLang(source(params)).agent, params);
    assert.equal(formatOaaLang(formatted), formatted, `idempotent: ${params}`);
  }
  // 类型写法表达不了的 Schema 保持 json，不丢信息。
  const exotic = [
    'input_schema = json { "type": "object", "properties": { "a": { "type": "string", "format": "uri" } }, "additionalProperties": false }',
    'input_schema = json { "type": "object", "properties": { "a": { "type": "string" } } }',
    'input_schema = json { "type": "object", "properties": { "a": { "type": "string", "default": "x" } }, "required": ["a"], "additionalProperties": false }',
    'input_schema = json { "type": "object", "properties": { "type": { "type": "string" } }, "required": ["type"], "additionalProperties": false }',
    'input_schema = json { "type": "object", "properties": { "a": { "type": "string", "description": "has ${NOT_A_CONSTANT}" } }, "required": ["a"], "additionalProperties": false }',
    'input_schema = json { "type": "object", "properties": { "b": { "type": "string" }, "a": { "type": "string" } }, "required": ["a", "b"], "additionalProperties": false }',
  ];
  for (const params of exotic) {
    const formatted = formatOaaLang(source(params));
    assert.match(formatted, /input_schema = json/, params);
    assert.deepEqual(compileOaaLang(formatted).agent, compileOaaLang(source(params)).agent, params);
  }
  // 输出 Schema 同样处理。
  const withOutput = formatOaaLang(
    source(
      'params { path: string }',
      'output_schema { path: string size?: int }\n    return { path: $input.path }',
    ),
  );
  assert.match(withOutput, /output_schema \{ path: string size\?: int \}/);
});

test('格式化把引用、表达式和模板还原成人写的简洁形式，写不成的保持原样', () => {
  const source = (steps: string) => `agent "agent/demo" {
  description = "demo"
  model = "m"
  provider = "p"
  use builtin [read_file, list_files]
  flow "f" {
    params { path: string names: string[] }
${steps}
  }
  instructions "x"
}`;
  const cases: [string, RegExp[]][] = [
    [
      `    step doc = read_file(path = $input.path)
    return { path: $input.path, size: $(len(doc.text)), note: "read {{doc.path}}" }`,
      [
        /step doc = read_file\(path = \$input\.path\)/,
        /return \{ path: \$input\.path, size: \$\(len\(doc\.text\)\), note: "read \{\{doc\.path\}\}" \}/,
      ],
    ],
    [
      `    step listing = list_files()
    step each = read_file(path = $item) foreach item in $listing.files (max=4)
    step again = read_file(path = $listing.files.0) fallback = "none"`,
      [
        /step each = read_file\(path = \$item\) foreach item in \$listing\.files \(max=4\)/,
        /step again = read_file\(path = \$listing\.files\.0\) depends_on = \["listing"\] fallback = "none"/,
      ],
    ],
    [
      `    step doc = read_file(path = literal("{{not_a_ref}}"))`,
      [/read_file\(path = literal\("\{\{not_a_ref\}\}"\)\)/],
    ],
    [
      `    step doc = read_file("path" = { "$ref": "$input#/path", "$default": "README.md" })`,
      [/\{ "\$ref": "\$input#\/path", "\$default": "README\.md" \}/],
    ],
  ];
  for (const [steps, expected] of cases) {
    const formatted = formatOaaLang(source(steps));
    for (const pattern of expected) assert.match(formatted, pattern, steps);
    assert.deepEqual(compileOaaLang(formatted).agent, compileOaaLang(source(steps)).agent, steps);
    assert.equal(formatOaaLang(formatted), formatted, `idempotent: ${steps}`);
  }
});

test('引用了不存在的步骤，或在 when 里用了循环变量时，报错说清是哪一步、为什么', () => {
  const source = (step: string) => `agent "agent/demo" {
  description = "demo"
  model = "m"
  provider = "p"
  use builtin [read_file, list_files]
  flow "f" {
    step listing = list_files()
    ${step}
  }
  instructions "x"
}`;
  const failure = (step: string) => {
    try {
      compileOaaLang(source(step));
    } catch (e) {
      return String((e as Error).message);
    }
    throw new Error('expected a compile error');
  };
  assert.match(
    failure(
      'step each = read_file(path = $item) when $(item != "") foreach item in $listing.files',
    ),
    /Step 'each': 'when' is checked once before the loop starts, so it cannot use the loop variable 'item'/,
  );
  assert.match(
    failure(
      'step each = read_file(path = $doc) foreach doc in $listing.files when $(doc.size > 0)',
    ),
    /cannot use the loop variable 'doc'/,
  );
  assert.match(
    failure('step again = read_file(path = $lisitng.files.0)'),
    /Graph references a missing step: step 'again' refers to 'lisitng', which is not a step in this graph\./,
  );
  // when 引用别的步骤仍然可以。
  assert.doesNotThrow(() =>
    compileOaaLang(
      source(
        'step each = read_file(path = $item) foreach item in $listing.files when $(len(listing.files) > 0)',
      ),
    ),
  );
});

test('格式化保留类型别名：声明放在开头，用到的地方写别名的名字，编译结果不变', () => {
  const source = `type Doc = { path: string(min=1) title?: string }
type Mode = "fast" | "deep"
type Unused = int(min=0)

agent "agent/reader" {
  description = "demo"
  model = "m"
  provider = "p"
  use builtin read_file
  type Excerpt = string(max=2000)
  flow "inspect" {
    params { doc: Doc mode?: Mode tags: string(max=32)[] docs?: Doc[] note: Excerpt("why") }
    step document = read_file(path = $input.doc.path)
    output_schema { path: string excerpt: Excerpt }
    return { path: $input.doc.path, excerpt: $(slice(document.text, 0, 2000)) }
  }
  instructions "x"
}`;
  const formatted = formatOaaLang(source);
  assert.ok(
    formatted.startsWith(
      [
        'type Doc = { path: string(min=1) title?: string }',
        'type Mode = "fast" | "deep"',
        'type Unused = int(min=0)',
        'type Excerpt = string(max=2000)',
        '',
        'agent "agent/reader" {',
      ].join('\n'),
    ),
    formatted.slice(0, 300),
  );
  // 用到别名的地方写名字；在别名上另加了说明的字段不再等于别名，展开书写。
  assert.match(
    formatted,
    /params \{\n\s+doc: Doc\n\s+mode\?: Mode\n\s+tags: string\(max=32\)\[\]\n\s+docs\?: Doc\[\]\n\s+note: string\(max=2000, "why"\)\n\s+\}/,
  );
  assert.match(formatted, /output_schema \{ path: string excerpt: Excerpt \}/);
  assert.deepEqual(compileOaaLang(formatted).agent, compileOaaLang(source).agent);
  assert.deepEqual(compileOaaLang(formatted).typeAliases, compileOaaLang(source).typeAliases);
  assert.equal(formatOaaLang(formatted), formatted);
  // 没有声明别名的源码，编译结果里不出现这个字段，格式化结果也没有声明行。
  const plain = `agent "agent/plain" {
  description = "demo"
  model = "m"
  provider = "p"
  instructions "x"
}`;
  assert.equal('typeAliases' in compileOaaLang(plain), false);
  assert.ok(formatOaaLang(plain).startsWith('agent "agent/plain" {'));
});
