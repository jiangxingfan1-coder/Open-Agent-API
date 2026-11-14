import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileOaaLang, formatOaaLang } from '../src/lang/lang.js';
import { canonical } from '../src/core/util.js';

// docs/language.md 里每个标了 ```oaa 的代码块都必须能编译，格式化后重新编译与原产物一致，
// 且格式化幂等。片段用 ```text 标记，不在这里检查。离线，不监听端口。

test('docs/language.md 的每个 oaa 代码块都能编译，格式化往返一致且幂等', async () => {
  const docs = await readFile(path.resolve('docs/language.md'), 'utf8');
  const blocks = [...docs.matchAll(/^```oaa\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);
  assert.ok(blocks.length >= 10, `only ${blocks.length} oaa blocks`);
  for (const [index, source] of blocks.entries()) {
    const label = `block #${index + 1}:\n${source}`;
    const compiled = compileOaaLang(source);
    const formatted = formatOaaLang(source);
    assert.equal(canonical(compileOaaLang(formatted)), canonical(compiled), label);
    assert.equal(formatOaaLang(formatted), formatted, label);
  }
});
