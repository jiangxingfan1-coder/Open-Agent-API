/** API 密钥的 `sk-oaa-` 格式、旧 `oaa_` 密钥兼容、删除即从列表消失（任务 K1）。进程内，不监听端口。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateApiKey, API_KEY_PREFIX } from '../src/gateway/api-key.js';
import { Auth } from '../src/gateway/auth.js';
import { redact } from '../src/core/util.js';
import { assertPublishableMetadata } from '../src/lang/bundle.js';
import { sha } from '../src/core/util.js';
import { setup } from './helpers.js';

test('api key: sk-oaa- plus 48 base62 characters, never repeating', () => {
  assert.equal(API_KEY_PREFIX, 'sk-oaa-');
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const key = generateApiKey();
    assert.match(key, /^sk-oaa-[A-Za-z0-9]{48}$/);
    assert.equal(key.length, 55);
    seen.add(key);
  }
  assert.equal(seen.size, 2000);
  // 无偏取样：62 个字符都会出现，且分布大致均匀。
  const counts = new Map<string, number>();
  for (const key of seen) for (const c of key.slice(7)) counts.set(c, (counts.get(c) ?? 0) + 1);
  assert.equal(counts.size, 62);
  const expected = (2000 * 48) / 62;
  for (const n of counts.values()) assert.ok(Math.abs(n - expected) < expected * 0.25);
});

test('api key: both formats are redacted from error text and refused in public metadata', () => {
  const fresh = generateApiKey();
  const legacy = `oaa_${randomBytes(32).toString('base64url')}`;
  for (const key of [fresh, legacy]) {
    const shown = redact(`upstream said: invalid key ${key} (retry)`);
    assert.ok(!shown.includes(key.slice(8)), shown);
    assert.match(shown, /\[REDACTED\]/);
    assert.throws(() => assertPublishableMetadata({ description: `use ${key}` }), {
      code: 'secret_in_bundle',
    });
  }
  // 错误码之类的 `oaa_` 词不是密钥，不遮蔽。
  assert.equal(redact('oaa_syntax_error at line 3'), 'oaa_syntax_error at line 3');
});

test('api key: console-created keys use sk-oaa-; a legacy oaa_ key still authenticates', async () => {
  const s = await setup();
  try {
    const created = await s.request('POST', '/v1/keys', {
      name: 'fresh',
      agents: ['*'],
      scopes: ['read', 'invoke'],
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.match(created.json().token, /^sk-oaa-[A-Za-z0-9]{48}$/);
    assert.equal(
      (await s.request('GET', '/v1/models', undefined, created.json().token)).statusCode,
      200,
    );

    // 旧格式密钥按哈希存：直接写一行旧格式的记录，重启后仍能鉴权。
    const legacy = `oaa_${randomBytes(32).toString('base64url')}`;
    const row = {
      id: 'key_legacy',
      name: 'legacy',
      owner: 'owner',
      hash: sha(legacy),
      agents: ['*'],
      scopes: ['read', 'invoke'],
      revoked: false,
      createdAt: Date.now(),
      execution: 'host',
    };
    s.store.db
      .prepare('INSERT INTO api_keys VALUES(?,?,?)')
      .run(row.id, row.owner, JSON.stringify(row));
    const auth = new Auth(s.store);
    assert.equal(auth.authenticate(`Bearer ${legacy}`).keyId, 'key_legacy');
  } finally {
    await s.cleanup();
  }
});
