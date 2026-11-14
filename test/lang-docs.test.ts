import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileOaaLang, formatOaaLang } from '../src/lang/lang.js';
import { canonical } from '../src/core/util.js';

// Every block tagged ```oaa in docs/language.md (English) and docs/zh-CN/language.md (Chinese)
// must compile, recompile to the same output after formatting, and format idempotently; the two
// languages must also carry the same number of checked blocks. Fragments are tagged ```text and
// are not checked here. Offline, no port.

const oaaBlocks = async (file: string) => {
  const docs = await readFile(path.resolve(file), 'utf8');
  return [...docs.matchAll(/^```oaa\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);
};

for (const file of ['docs/language.md', 'docs/zh-CN/language.md']) {
  test(`${file}: every oaa block compiles, and formatting round-trips and is idempotent`, async () => {
    const blocks = await oaaBlocks(file);
    assert.ok(blocks.length >= 10, `only ${blocks.length} oaa blocks`);
    for (const [index, source] of blocks.entries()) {
      const label = `block #${index + 1}:\n${source}`;
      const compiled = compileOaaLang(source);
      const formatted = formatOaaLang(source);
      assert.equal(canonical(compileOaaLang(formatted)), canonical(compiled), label);
      assert.equal(formatOaaLang(formatted), formatted, label);
    }
  });
}

test('docs/language.md and docs/zh-CN/language.md check the same number of oaa blocks', async () => {
  assert.equal(
    (await oaaBlocks('docs/zh-CN/language.md')).length,
    (await oaaBlocks('docs/language.md')).length,
  );
});
