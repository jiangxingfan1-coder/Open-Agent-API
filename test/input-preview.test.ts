/**
 * 控制台任务列表与概览里的「输入」预览：兼容入口把多条消息拼成 `[role]\n文本` 交给智能体，
 * 预览取最后一条用户消息的文本，不带角色标记、不显示系统提示；交给智能体的输入不变。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, agent, FixtureModel } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { inputPreview } from '../src/store/inspection.js';

const LONG_SYSTEM = `你是一个严谨的研究助理。${'请遵守以下规则。'.repeat(60)}`;

test('input preview: last user message, no role marks, no system prompt, on every entry', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'ok' })));
  try {
    s.store.publish('owner', makeBundle(agent()));
    const cases: [string, string, unknown, string][] = [
      [
        'chat',
        '/v1/chat/completions',
        {
          model: 'agent/test',
          messages: [
            { role: 'system', content: LONG_SYSTEM },
            { role: 'user', content: '第一个问题' },
            { role: 'assistant', content: '第一个回答' },
            { role: 'user', content: '调研端侧小模型的现状' },
          ],
        },
        '调研端侧小模型的现状',
      ],
      [
        'claude',
        '/v1/messages',
        {
          model: 'agent/test',
          max_tokens: 64,
          system: LONG_SYSTEM,
          messages: [{ role: 'user', content: 'hi' }],
        },
        'hi',
      ],
      [
        'gemini',
        '/v1beta/models/agent%2Ftest:generateContent',
        {
          systemInstruction: { parts: [{ text: LONG_SYSTEM }] },
          contents: [
            { role: 'user', parts: [{ text: '先说结论' }] },
            { role: 'model', parts: [{ text: '好的' }] },
            { role: 'user', parts: [{ text: '再给出处' }] },
          ],
        },
        '再给出处',
      ],
      [
        'responses string',
        '/v1/responses',
        { model: 'agent/test', input: '调研端侧小模型的现状' },
        '调研端侧小模型的现状',
      ],
      [
        'responses messages',
        '/v1/responses',
        {
          model: 'agent/test',
          input: [
            { role: 'developer', content: LONG_SYSTEM },
            { role: 'user', content: [{ type: 'input_text', text: '列出三个要点' }] },
          ],
        },
        '列出三个要点',
      ],
    ];
    const expected = new Map<string, string>();
    for (const [name, url, body, preview] of cases) {
      const r = await s.request('POST', url, body);
      assert.equal(r.statusCode, 200, `${name}: ${r.body}`);
      const run = s.store.summaries('owner', ['*'], 1)[0]!;
      // 交给智能体的输入原样保留（带标记的那几种仍含系统提示）。
      if (name !== 'responses string') assert.notEqual(s.store.run(run.id).input, preview, name);
      expected.set(run.id, preview);
    }
    const list = (await s.request('GET', '/v1/runs')).json().data as {
      id: string;
      input: string;
    }[];
    const overview = (await s.request('GET', '/v1/overview')).json().runs as {
      id: string;
      input: string;
    }[];
    for (const rows of [list, overview])
      for (const [id, preview] of expected)
        assert.equal(rows.find((r) => r.id === id)?.input, preview, id);
  } finally {
    await s.cleanup();
  }
});

test('input preview: old summaries stored with role marks read back cleanly', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'ok' })));
  try {
    s.store.publish('owner', makeBundle(agent()));
    await s.request('POST', '/v1/responses', { model: 'agent/test', input: 'x' });
    const run = s.store.summaries('owner', ['*'], 1)[0]!;
    const row = s.store.db
      .prepare('SELECT payload FROM run_summaries WHERE run_id=?')
      .get(run.id) as { payload: string };
    const old = { ...JSON.parse(row.payload), input: '[system]\n规则\n\n[user]\nhi' };
    s.store.db
      .prepare('UPDATE run_summaries SET payload=? WHERE run_id=?')
      .run(JSON.stringify(old), run.id);
    assert.equal(s.store.summaries('owner', ['*'], 1)[0]!.input, 'hi');
  } finally {
    await s.cleanup();
  }
});

test('input preview: extraction rules', () => {
  assert.equal(inputPreview('调研端侧小模型的现状'), '调研端侧小模型的现状');
  assert.equal(inputPreview('[user]\nhi'), 'hi');
  assert.equal(inputPreview('[system]\nS\n\n[user]\na\n\n[assistant]\nb\n\n[user]\nc'), 'c');
  // 没有用户消息：退到整段开头。
  assert.equal(inputPreview('[system]\nS\n\n[assistant]\nb'), '[system]\nS\n\n[assistant]\nb');
  // Responses 兼容入口追加的格式要求不算用户消息的内容。
  assert.equal(
    inputPreview('[user]\nq\n\n[Response Format Requirement: Respond with valid JSON.]'),
    'q',
  );
  assert.equal(inputPreview('[user]\n' + 'x'.repeat(500)).length, 200);
});
