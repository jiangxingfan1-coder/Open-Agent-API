import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOaaLang, formatOaaLang, oaaSourceHasComments } from '../src/lang/lang.js';
import { canonical } from '../src/core/util.js';

// T13 语法统一：agent 属性的 `=` / `:`、snake_case 规范写法、格式化保留 let / 三引号 / 合并
// use builtin、重复声明补齐、flow 里的 `$常量`。离线，不监听端口。

const agentWith = (body: string, prelude = '') => `${prelude}
agent "agent/demo" {
  description = "demo"
  model = "m"
  provider = "p"
  use builtin read_file
${body}
}`;

const failure = (source: string): string => {
  try {
    compileOaaLang(source);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`expected a compile error:\n${source}`);
};

/** 格式化后重新编译与原产物一致，且格式化幂等。 */
const roundtrip = (source: string): string => {
  const formatted = formatOaaLang(source);
  assert.equal(canonical(compileOaaLang(formatted)), canonical(compileOaaLang(source)), formatted);
  assert.equal(formatOaaLang(formatted), formatted);
  return formatted;
};

test('语法 1：agent 级属性同时接受 = 与 :', () => {
  const eq = compileOaaLang(`agent "agent/a" {
  description = "d"
  model = "m"
  engine = kernel
  allow_graph = false
  files = ["a.txt"]
  limits = { max_turns = 2 }
  output_schema = { a: string }
  instructions = "i"
}`);
  const colon = compileOaaLang(`agent "agent/a" {
  description: "d"
  model: "m"
  engine: kernel
  allow_graph: false
  files: ["a.txt"]
  limits: { max_turns: 2 }
  output_schema: { a: string }
  instructions: "i"
}`);
  assert.equal(canonical(colon), canonical(eq));
});

test('语法 2：tool 的 network 接受 allowed_domains，格式化统一输出 snake_case', () => {
  const tool = (network: string) =>
    agentWith(`  tool fetch {
    script = "scripts/fetch.mjs" runtime = node effect = read
    requiresApproval = true timeoutMs = 5s cacheTtlMs = 1m resultExport = false
    network { ${network} = ["example.com"] }
    params { url: string }
  }`);
  const snake = compileOaaLang(tool('allowed_domains'));
  const camel = compileOaaLang(tool('allowedDomains'));
  assert.equal(canonical(snake), canonical(camel));
  assert.deepEqual(snake.agent.tools[1]!.capability.network, {
    allowedDomains: ['example.com'],
  });
  const formatted = roundtrip(tool('allowedDomains'));
  assert.match(formatted, /tool "fetch" \{/);
  assert.match(formatted, /allowed_domains/);
  assert.doesNotMatch(
    formatted,
    /allowedDomains|requiresApproval|timeoutMs|cacheTtlMs|resultExport|inputSchema/,
  );
});

test('格式化 3：保留 let 声明、多行 instructions 用三引号、连续 use builtin 合并', () => {
  const source = agentWith(
    `  use builtin list_files
  use builtin write_file
  instructions = """
    第一行
      缩进的第二行

    第四行
  """`,
    'let who = "研究员"\nlet limit = { a: 1 }',
  ).replace('description = "demo"', 'description = who');
  const formatted = roundtrip(source);
  assert.match(formatted, /^let who = "研究员"$/m);
  assert.match(formatted, /^let limit = /m);
  assert.match(formatted, /description = who/);
  assert.match(
    formatted,
    /instructions = """\n {4}第一行\n {6}缩进的第二行\n\n {4}第四行\n {2}"""/,
  );
  assert.match(formatted, /use builtin \[read_file, list_files, write_file\]/);
  // 表达不了的 instructions（含只有空白的行）保持 JSON 字符串。
  const odd = roundtrip(agentWith('  instructions = "a\\n  \\nb"'));
  assert.match(odd, /instructions = "a\\n  \\nb"/);
});

test('格式化 3：能检测出源码里的注释（格式化会丢掉它们）', () => {
  assert.equal(oaaSourceHasComments(agentWith('  # note')), true);
  assert.equal(oaaSourceHasComments(agentWith('  // note')), true);
  assert.equal(oaaSourceHasComments(agentWith('  /* note */')), true);
  assert.equal(
    oaaSourceHasComments(agentWith('  instructions = "# not a comment // here"')),
    false,
  );
});

test('语法 6：agent 块的单值属性与单例子块不许重复声明', () => {
  for (const body of [
    '  engine = kernel\n  engine = codex',
    '  provider = "q"',
    '  output_schema { a: string }\n  output_schema { b: string }',
    '  allow_graph = true\n  allowGraph = false',
    '  allowed_nodes = ["n"]\n  allowed_nodes = ["m"]',
    '  files = ["a"]\n  files = ["b"]',
    '  skills = []\n  skills = []',
  ])
    assert.match(failure(agentWith(body)), /^Line \d+, Col \d+: Duplicate '/, body);
});

test('语法 7：flow 里的 $常量 解析为常量的值；同名时步骤优先；带路径时提示常量不能带路径', () => {
  const flow = (step: string) =>
    agentWith(
      `  flow f {\n    step a = read_file(path = "x")\n    ${step}\n  }`,
      'let base = "docs"\nlet a = "const-a"',
    );
  const value = compileOaaLang(flow('step b = read_file(path = $base)'));
  assert.equal((value.agent.workflows![0]!.steps[1]!.arguments as { path: unknown }).path, 'docs');
  const ret = compileOaaLang(flow('step b = read_file(path = "y")\n    return { p: $base }'));
  assert.deepEqual(ret.agent.workflows![0]!.output, { p: 'docs' });
  // 同名时是步骤引用。
  const shadow = compileOaaLang(flow('step b = read_file(path = $a)'));
  assert.deepEqual((shadow.agent.workflows![0]!.steps[1]!.arguments as { path: unknown }).path, {
    $ref: 'a',
  });
  assert.match(
    failure(flow('step b = read_file(path = $base.x)')),
    /^Line 10, Col \d+: .*'base' is a constant.*path/,
  );
  roundtrip(flow('step b = read_file(path = $base)'));
});
