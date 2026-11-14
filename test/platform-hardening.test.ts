import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { Auth } from '../src/gateway/auth.js';
import { hashPassword, verifyPassword } from '../src/gateway/platform-accounts.js';
import { setup } from './helpers.js';

// Hardening of the developer-platform kernel: password hash parameters, operator level,
// the in-memory index of account keys. In-process only.

const legacyHash = (password: string, salt = randomBytes(16)) =>
  `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1 }).toString('base64url')}`;

test('password hash: stored with its parameters (N=32768, r=8, p=3)', async () => {
  const stored = await hashPassword('correct horse battery');
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', '32768', '8', '3']);
  assert.ok(parts[4] && parts[5]);
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('correct horse batterz', stored), false);
  assert.notEqual(stored, await hashPassword('correct horse battery'), 'salt is per hash');
});

test('password hash: the legacy three-part format still verifies (N=16384, r=8, p=1)', async () => {
  const stored = legacyHash('legacy-password');
  assert.equal(stored.split('$').length, 3);
  assert.equal(await verifyPassword('legacy-password', stored), true);
  assert.equal(await verifyPassword('legacy-passworD', stored), false);
});

test('password hash: unreasonable stored parameters are rejected', async () => {
  const salt = randomBytes(16).toString('base64url');
  const hash = randomBytes(32).toString('base64url');
  for (const stored of [
    `scrypt$0$8$3$${salt}$${hash}`,
    `scrypt$-16384$8$3$${salt}$${hash}`,
    `scrypt$16384.5$8$3$${salt}$${hash}`,
    `scrypt$abc$8$3$${salt}$${hash}`,
    `scrypt$20000$8$3$${salt}$${hash}`, // not a power of two
    `scrypt$${2 ** 21}$8$3$${salt}$${hash}`, // above 2^20
    `scrypt$32768$0$3$${salt}$${hash}`,
    `scrypt$32768$8$0$${salt}$${hash}`,
    `scrypt$32768$8$1.5$${salt}$${hash}`,
    `scrypt$32768$8$3$${salt}`,
    `scrypt$32768$8$3$${salt}$${hash}$extra`,
    `bcrypt$32768$8$3$${salt}$${hash}`,
    '',
  ])
    assert.equal(await verifyPassword('anything', stored), false, stored);
});

test('platform: operator calls need an owner-wide admin key of the platform owner', async () => {
  const s = await setup(undefined, { platform: { owner: 'owner' } });
  try {
    const p = s.platform!;
    const base = { name: 'k', owner: 'owner', agents: ['*'], scopes: ['admin'] };
    assert.doesNotThrow(() => p.requireOperator(base));
    assert.throws(() => p.requireOperator({ ...base, agents: ['agent/test'] }), {
      code: 'scope_denied',
      status: 403,
    });
    assert.throws(() => p.requireOperator({ ...base, owner: 'second' }), { code: 'scope_denied' });
    assert.throws(() => p.requireOperator({ ...base, scopes: ['invoke', 'read'] }), {
      code: 'scope_denied',
    });
  } finally {
    await s.cleanup();
  }
});

test('platform: account keys come from an in-memory index (no row parsing, same order)', async () => {
  const s = await setup(undefined, { platform: { owner: 'owner', maxKeysPerAccount: 5 } });
  try {
    const auth = s.auth;
    const first = auth.createAccountKey('owner', 'acct_a', 'first', 5);
    const second = auth.createAccountKey('owner', 'acct_a', 'second', 5);
    auth.createAccountKey('owner', 'acct_b', 'other', 5);
    auth.revokeAccountKey('owner', 'acct_a', first.id);

    const parse = JSON.parse;
    let parsed = 0;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      parsed++;
      return parse(...args);
    }) as typeof JSON.parse;
    let live;
    try {
      for (let i = 0; i < 20; i++) live = auth.accountKeys('owner', 'acct_a');
    } finally {
      JSON.parse = parse;
    }
    assert.equal(parsed, 0, 'accountKeys must not read and parse api_keys rows');
    assert.deepEqual(
      live!.map((k) => [k.id, k.name, k.revoked]),
      [[second.id, 'second', false]],
      'a deleted (revoked) key is no longer listed',
    );
    assert.deepEqual(
      auth.accountKeys('owner', 'acct_b').map((k) => k.name),
      ['other'],
    );
    assert.deepEqual(auth.accountKeys('owner', 'acct_none'), []);
    assert.deepEqual(auth.accountKeys('second', 'acct_a'), [], 'owner is part of the lookup');

    // The index is rebuilt from the table at startup; deleted keys stay out of the list.
    const restarted = new Auth(s.store);
    assert.deepEqual(restarted.accountKeys('owner', 'acct_a'), live);

    // The key limit counts live keys from the index.
    auth.createAccountKey('owner', 'acct_a', 'third', 2);
    assert.throws(() => auth.createAccountKey('owner', 'acct_a', 'fourth', 2), {
      code: 'key_limit_reached',
    });
  } finally {
    await s.cleanup();
  }
});
