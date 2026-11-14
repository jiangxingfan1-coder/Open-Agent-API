/** 删除密钥：DELETE 之后立刻失效，且不再出现在任何列表里（任务 K1）。进程内，不监听端口。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('api key: DELETE /v1/keys/:id removes the key from the list and stops it at once', async () => {
  const s = await setup();
  try {
    const made = await s.request('POST', '/v1/keys', {
      name: 'gone',
      agents: ['*'],
      scopes: ['read'],
    });
    const key = made.json() as { id: string; token: string };
    const ids = async () =>
      ((await s.request('GET', '/v1/keys')).json().data as { id: string }[]).map((k) => k.id);
    assert.ok((await ids()).includes(key.id));
    assert.equal((await s.request('DELETE', `/v1/keys/${key.id}`)).statusCode, 204);
    assert.ok(!(await ids()).includes(key.id), 'a deleted key is no longer listed');
    assert.equal((await s.request('GET', '/v1/models', undefined, key.token)).statusCode, 401);
    // 重复删除沿用原行为（不报错）。
    assert.equal((await s.request('DELETE', `/v1/keys/${key.id}`)).statusCode, 204);
    assert.ok(
      ((await s.request('GET', '/v1/keys')).json().data as { revoked: boolean }[]).every(
        (k) => k.revoked === false,
      ),
    );
  } finally {
    await s.cleanup();
  }
});
