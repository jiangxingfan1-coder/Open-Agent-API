import test from 'node:test';
import assert from 'node:assert/strict';
import { faultMessage } from '../src/core/errors.js';
import { bi, pick, processLocale, requestLocale } from '../src/core/locale.js';
import { Fault } from '../src/core/util.js';
import { errorBody } from '../src/gateway/compat-errors.js';
import { cliFailure, cliHelp } from '../src/client/cli-text.js';
import { setup } from './helpers.js';

const hasHan = (text: string) => /\p{Script=Han}/u.test(text);

test('locale: the test entry pins the process locale to zh', () => {
  assert.equal(process.env.OAA_LOCALE, 'zh');
  assert.equal(processLocale(), 'zh');
});

test('locale: process default follows OAA_LOCALE, then LC_ALL / LC_MESSAGES / LANG', () => {
  assert.equal(processLocale({ OAA_LOCALE: 'en', LANG: 'zh_CN.UTF-8' }), 'en');
  assert.equal(processLocale({ OAA_LOCALE: 'ZH' }), 'zh');
  assert.equal(processLocale({ OAA_LOCALE: 'fr', LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(processLocale({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }), 'en');
  assert.equal(processLocale({ LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' }), 'zh');
  assert.equal(processLocale({ LANG: 'de_DE.UTF-8' }), 'en');
  // C / POSIX 不算明确语言，继续往后看（最后是 Intl 的区域，结果取决于机器，只要求是两者之一）。
  assert.ok(['zh', 'en'].includes(processLocale({ LANG: 'C' })));
});

test('locale: Accept-Language picks the highest-weighted explicit language', () => {
  assert.equal(requestLocale('zh-CN,zh;q=0.9,en;q=0.8', 'en'), 'zh');
  assert.equal(requestLocale('en-US,en;q=0.9', 'zh'), 'en');
  assert.equal(requestLocale('fr-FR', 'zh'), 'en');
  assert.equal(requestLocale('en;q=0.5, zh-Hans;q=0.8', 'en'), 'zh');
  assert.equal(requestLocale('zh;q=0, en', 'zh'), 'en');
  // 没有这个头、或只有 `*`（Node 的 fetch 默认发送）时用进程默认语言。
  assert.equal(requestLocale(undefined, 'zh'), 'zh');
  assert.equal(requestLocale('*', 'en'), 'en');
  assert.equal(requestLocale('', 'zh'), 'zh');
});

test('locale: fault messages localize, and Chinese-only messages fall back to the catalog in English', () => {
  const both = new Fault('native_closed', bi('进程已关闭。', 'The process has closed.'), 502);
  assert.equal(both.message, '进程已关闭。', 'Error.message follows the process locale');
  assert.equal(faultMessage(both, 'en'), 'The process has closed.');
  assert.equal(faultMessage(both, 'zh'), '进程已关闭。');
  const english = new Fault('agent_not_found', 'Agent or version not found.', 404);
  assert.equal(faultMessage(english, 'zh'), 'Agent or version not found.', 'zh stays unchanged');
  assert.equal(faultMessage(english, 'en'), 'Agent or version not found.');
  const chinese = new Fault(
    'backend_not_configured',
    '后端 adapter/foo 没有在 worker.json 中声明。',
  );
  const fallback = faultMessage(chinese, 'en');
  assert.ok(!hasHan(fallback), fallback);
  assert.match(fallback, /^The local worker configuration has no such backend\./);
  assert.match(fallback, /adapter\/foo/);
  assert.match(fallback, /worker\.json/);
  assert.equal(pick(bi('中', 'en'), 'en'), 'en');
});

test('locale: every compat error dialect keeps its shape and only changes the message', () => {
  const fault = new Fault('backend_not_enabled', bi('中文说明。', 'English text.'), 409);
  for (const dialect of ['openai', 'claude', 'gemini', 'native'] as const) {
    const zh = errorBody(dialect, 409, fault, 'zh');
    const en = errorBody(dialect, 409, fault, 'en');
    assert.deepEqual(
      JSON.parse(JSON.stringify(en).replace('English text.', '中文说明。')),
      zh,
      `${dialect}: only the message differs`,
    );
  }
});

test('locale: HTTP errors follow Accept-Language, otherwise the process default', async () => {
  const g = await setup();
  try {
    const publish = (headers: Record<string, string>) =>
      g.request(
        'POST',
        '/v1/agents/publish-native',
        { id: 'demo/acp', engine: 'adapter/gemini', models: ['default'] },
        undefined,
        headers,
      );
    const fallback = await publish({});
    assert.equal(fallback.statusCode, 409);
    assert.equal(fallback.json().error.code, 'backend_not_enabled');
    assert.ok(hasHan(fallback.json().error.message), 'no header: process default (zh)');
    const english = await publish({ 'accept-language': 'en-US,en;q=0.9' });
    assert.equal(english.statusCode, 409);
    assert.deepEqual(Object.keys(english.json().error), Object.keys(fallback.json().error));
    assert.match(english.json().error.message, /^This adapter is not enabled on any online node/);
    const chinese = await publish({ 'accept-language': 'zh-CN' });
    assert.equal(chinese.json().error.message, fallback.json().error.message);
  } finally {
    await g.cleanup();
  }
});

test('locale: CLI help and failure text follow the locale', () => {
  assert.match(cliHelp('en'), /^Open Agent API\nPublish agents/);
  assert.ok(!hasHan(cliHelp('en')));
  assert.match(cliHelp('zh'), /最快上手/);
  assert.match(cliHelp('zh'), /\n {2}oaa doctor \[--config \.oaa\/config\.json\] \[--write\]\n/);
  const fault = new Fault('unauthorized', 'A Bearer API key is required.', 401);
  assert.equal(
    cliFailure(fault, 'en'),
    'unauthorized: A Bearer API key is required.\nNext: Check the API key in the Authorization header.\n',
  );
  assert.match(cliFailure(fault, 'zh'), /\n下一步：检查 Authorization 头里的 API 密钥\n$/);
});

test('locale: ACP preset notes on GET /v1/local/backends follow Accept-Language', async () => {
  const g = await setup();
  try {
    const notes = async (headers: Record<string, string>) => {
      const res = await g.request('GET', '/v1/local/backends', undefined, undefined, headers);
      assert.equal(res.statusCode, 200);
      const presets = res.json().presets as { kind: string; id: string; notes?: string }[];
      return new Map(presets.filter((p) => p.kind === 'acp').map((p) => [p.id, p.notes ?? '']));
    };
    const zh = await notes({});
    const en = await notes({ 'accept-language': 'en-US' });
    assert.equal(en.size, 32);
    assert.deepEqual([...en.keys()], [...zh.keys()]);
    for (const [id, text] of en) assert.ok(!hasHan(text) && text.length > 0, id);
    assert.ok([...zh.values()].every(hasHan), 'no header: process default (zh)');
  } finally {
    await g.cleanup();
  }
});
