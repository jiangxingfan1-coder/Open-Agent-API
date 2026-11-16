import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

test('model branding is display-only, recognizes families and leaves unknown names neutral', async () => {
  const source = await readFile('web/lib/model-brand.js', 'utf8');
  const { modelBrand } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  for (const [name, brand] of [
    ['gpt-6.1-sol[low]', 'openai'],
    ['vendor/claude-opus-4-6', 'claude'],
    ['Gemini-3.8-Flash', 'gemini'],
    ['Qwen4-Max-Preview', 'qwen'],
    ['Kimi-K3.1-Pro', 'kimi'],
    ['GLM-5.3', 'zai'],
    ['DeepSeek-V4-Pro', 'deepseek'],
    ['MiniMax-M3.1-Flash', 'minimax'],
    ['Devstral-small', 'mistral'],
  ])
    assert.equal(modelBrand(name), brand);
  for (const name of ['default', 'auto', 'fast', 'best', 'eco', 'qmodel_latest', 'not-gpt', null])
    assert.equal(modelBrand(name), null);
});

test('model and mainstream agent marks are local static SVGs without executable content', async () => {
  const names = (await readdir('web/agents')).filter((n) => n.endsWith('.svg'));
  assert.equal(names.filter((n) => n.startsWith('model-')).length, 11);
  for (const name of names) {
    const svg = await readFile(`web/agents/${name}`, 'utf8');
    assert.match(svg, /<svg\b/);
    assert.doesNotMatch(
      svg,
      /<(?:script|foreignObject|image)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:|javascript:)/i,
      name,
    );
  }
  const copilot = await readFile('web/agents/copilot.svg', 'utf8');
  assert.match(copilot, /GitHub\s*Copilot/i);
});
