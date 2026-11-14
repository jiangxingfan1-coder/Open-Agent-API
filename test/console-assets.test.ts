import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';

test('console serves agent marks publicly and nothing outside the allowlist', async () => {
  const s = await setup();
  try {
    const mark = await s.app.inject({ method: 'GET', url: '/agents/codex.svg' });
    assert.equal(mark.statusCode, 200);
    assert.match(String(mark.headers['content-type']), /image\/svg\+xml/);
    assert.match(String(mark.headers['content-security-policy']), /default-src 'none'/);
    assert.match(mark.body, /<svg/);

    const missing = await s.app.inject({ method: 'GET', url: '/agents/missing-agent.svg' });
    assert.equal(missing.statusCode, 404);

    for (const url of [
      '/agents/..%2Fbrand.svg',
      '/agents/CODEX.svg',
      '/agents/codex.png',
      '/agents/',
    ]) {
      const res = await s.app.inject({ method: 'GET', url });
      assert.notEqual(res.statusCode, 200, url);
      assert.doesNotMatch(res.body, /<svg/, url);
    }

    const brand = await s.app.inject({ method: 'GET', url: '/brand.svg' });
    assert.equal(brand.statusCode, 200);
    assert.match(brand.body, /<svg/);

    const page = await s.app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<html lang="zh-CN">/);
    // The page CSP forbids inline styles, so markup must not carry style attributes.
    assert.match(String(page.headers['content-security-policy']), /style-src 'self'/);
    assert.doesNotMatch(page.body, /\sstyle="/);
    // Appearance is applied before first paint by a same-origin script (no inline scripts).
    assert.match(page.body, /<script src="\/boot\.js"><\/script>\s*<link rel="stylesheet"/);
    assert.doesNotMatch(page.body, /<script>(?!<\/script>)/);
    const boot = await s.app.inject({ method: 'GET', url: '/boot.js' });
    assert.equal(boot.statusCode, 200);
    assert.match(String(boot.headers['content-type']), /text\/javascript/);
    assert.match(boot.body, /oaa\.prefs\.v1/);
  } finally {
    await s.cleanup();
  }
});

test('console serves every local script the page imports and nothing else', async () => {
  const s = await setup();
  try {
    // Walk index.html and every static import reachable from it.
    const html = readFileSync('web/index.html', 'utf8');
    const pending = [...html.matchAll(/<script[^>]*\ssrc="(\/[^"]+\.js)"/g)].map((m) => m[1]!);
    const seen = new Set<string>();
    while (pending.length) {
      const url = pending.pop()!;
      if (seen.has(url)) continue;
      seen.add(url);
      if (url === '/icons.js') continue; // served from the lucide package, not web/
      const source = readFileSync(path.join('web', url), 'utf8');
      // `import { a } from './x.js';` and the bare `import './x.js';` (the console's i18n text pass).
      for (const m of source.matchAll(/^import (?:[^;]*? from )?'(\.{1,2}\/[^']+)';/gm))
        pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(url), m[1]!)));
    }
    assert.ok(seen.has('/lib/state.js') && seen.has('/run-inspector.js'), [...seen].join(' '));
    for (const url of seen) {
      const res = await s.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.match(String(res.headers['content-type']), /javascript/, url);
    }
    for (const url of ['/lib/missing.js', '/views/missing.js', '/dialogs/missing.js']) {
      const res = await s.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
    }
    for (const url of [
      '/lib/..%2Fconsole.js',
      '/lib/State.js',
      '/lib/state.mjs',
      '/views/',
      '/scripts/package-all.js',
    ]) {
      const res = await s.app.inject({ method: 'GET', url });
      assert.notEqual(res.statusCode, 200, url);
    }
  } finally {
    await s.cleanup();
  }
});
