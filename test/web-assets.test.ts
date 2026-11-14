import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, token } from './helpers.js';
import { ADMIN, call, withPlatform } from './platform-http.js';

// Console static assets that came with the stylesheet split: `console.css` is only a list of
// @imports; the files it names live in web/shared/ and web/styles/ and are served from the console
// host only. In-process inject only (no sockets, no models).

const API = 'api.example.com';
const CONSOLE = 'console.example.com';
const separated = { allowedHosts: [API, CONSOLE, 'localhost'], consoleHosts: [CONSOLE] };
const web = (relative: string) => new URL(`../../web/${relative}`, import.meta.url);

/** `@import url('./shared/tokens.css');` lines of an entry stylesheet, in order. */
function importsOf(file: string): string[] {
  return [...readFileSync(web(file), 'utf8').matchAll(/@import url\('([^']+)'\);/g)].map(
    (m) => m[1]!,
  );
}

test('console.css imports every stylesheet that exists, and each is served on the console host only', async () => {
  const s = await setup(undefined, separated);
  try {
    const imports = importsOf('console.css');
    assert.ok(imports.length >= 10, 'console.css lists its style files');
    // Every @import resolves to a served file; no style file is left out of the entry sheet.
    const listed = imports.filter((i) => i.startsWith('./styles/')).map((i) => i.slice(9));
    const onDisk = readdirSync(web('styles')).filter((f) => f.endsWith('.css'));
    assert.deepEqual([...listed].sort(), [...onDisk].sort());
    assert.ok(imports.includes('./shared/tokens.css'));
    assert.equal(imports[imports.length - 1], './styles/responsive.css', 'responsive rules last');
    assert.equal(imports[imports.length - 2], './styles/preferences.css');
    for (const rel of imports) {
      const url = rel.replace(/^\./, '');
      const r = await s.app.inject({ method: 'GET', url, headers: { host: CONSOLE } });
      assert.equal(r.statusCode, 200, url);
      assert.equal(r.headers['content-type'], 'text/css; charset=utf-8', url);
      assert.match(String(r.headers['content-security-policy']), /default-src 'self'/, url);
      assert.equal(r.headers['cache-control'], 'no-store', url);
      assert.equal(r.rawPayload.compare(readFileSync(web(rel.slice(2)))), 0, url);
      const api = await s.app.inject({ method: 'GET', url, headers: { host: API } });
      assert.equal(api.statusCode, 404, url);
      assert.equal(api.json().error.code, 'route_not_found', url);
    }
    // Every style file stays under the line budget the split was made for.
    for (const rel of imports)
      assert.ok(readFileSync(web(rel.slice(2)), 'utf8').split('\n').length <= 650, rel);
  } finally {
    await s.cleanup();
  }
});

test('style and shared names outside the whitelist never reach the file system', async () => {
  const s = await setup();
  try {
    for (const url of [
      '/styles/Base.css',
      '/styles/base.js',
      '/styles/base.css.map',
      '/styles/a.b.css',
      '/styles/..%2Fconsole.css',
      '/styles/%2e%2e%2fpackage.json',
      `/styles/${'a'.repeat(60)}.css`,
      '/styles/missing-file.css',
      '/shared/Tokens.css',
      '/shared/tokens.json',
      '/shared/..%2Fconsole.js',
      '/shared/missing-file.css',
      '/shared/sub/tokens.css',
    ]) {
      const r = await s.request('GET', url);
      assert.equal(r.statusCode, 404, url);
      assert.ok(['not_found', 'route_not_found'].includes(r.json().error.code), url);
    }
  } finally {
    await s.cleanup();
  }
});

test('portal.css imports its own styles and the shared tokens, all served without a credential', async () => {
  await withPlatform({}, async (s) => {
    const imports = importsOf('portal/portal.css');
    const listed = imports.filter((i) => i.startsWith('./styles/')).map((i) => i.slice(9));
    const onDisk = readdirSync(web('portal/styles')).filter((f) => f.endsWith('.css'));
    assert.deepEqual([...listed].sort(), [...onDisk].sort());
    assert.equal(imports[0], './shared/tokens.css');
    assert.equal(imports[imports.length - 1], './styles/responsive.css', 'responsive rules last');
    for (const rel of imports) {
      const url = `/portal${rel.slice(1)}`;
      const r = await call(s, 'GET', url);
      assert.equal(r.statusCode, 200, url);
      assert.equal(r.headers['content-type'], 'text/css; charset=utf-8', url);
      assert.equal(r.headers['cache-control'], 'no-store', url);
      const file = rel.startsWith('./shared/') ? rel.slice(2) : `portal/${rel.slice(2)}`;
      assert.equal(r.rawPayload.compare(readFileSync(web(file))), 0, url);
      assert.ok(readFileSync(web(file), 'utf8').split('\n').length <= 650, url);
    }
    // The console serves the very same tokens file, byte for byte.
    const a = await call(s, 'GET', '/shared/tokens.css', undefined, ADMIN);
    const b = await call(s, 'GET', '/portal/shared/tokens.css');
    assert.equal(a.rawPayload.compare(b.rawPayload), 0);
    // Names outside the whitelist never reach the file system.
    for (const url of [
      '/portal/styles/Base.css',
      '/portal/styles/base.js',
      '/portal/styles/..%2Fportal.css',
      '/portal/styles/missing-file.css',
      `/portal/styles/${'a'.repeat(60)}.css`,
      '/portal/shared/Tokens.css',
      '/portal/shared/tokens.json',
      '/portal/shared/..%2Fconsole.js',
      '/portal/shared/missing-file.css',
    ]) {
      const r = await call(s, 'GET', url);
      assert.equal(r.statusCode, 404, url);
      assert.ok(['not_found', 'route_not_found'].includes(r.json().error.code), url);
    }
    // runs.css was folded into the portal styles.
    assert.equal((await call(s, 'GET', '/portal/runs.css')).statusCode, 404);
  });
});

/** Every `url('../fonts/x.woff2')` the two font stylesheets name, in file order. */
function fontsNamed(): string[] {
  return ['shared/fonts.css', 'shared/fonts-serif-sc.css'].flatMap((file) =>
    [...readFileSync(web(file), 'utf8').matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g)].map(
      (m) => m[1]!,
    ),
  );
}

test('fonts ship with the product: every @font-face file exists, is whitelisted and has a notice', () => {
  const named = fontsNamed();
  assert.equal(new Set(named).size, named.length, 'no file named twice');
  const onDisk = readdirSync(web('fonts')).filter((f) => f.endsWith('.woff2'));
  assert.deepEqual(
    [...named].sort(),
    [...onDisk].sort(),
    'web/fonts holds exactly what the CSS uses',
  );
  for (const f of named) assert.match(f, /^[a-z0-9-]{1,64}\.woff2$/, f);
  // fonts.css pulls in the CJK slices; the Latin families are Geist, Geist Mono, Instrument Serif.
  const css = readFileSync(web('shared/fonts.css'), 'utf8');
  for (const family of ['Geist', 'Geist Mono', 'Instrument Serif'])
    assert.ok(css.includes(`font-family: '${family}'`), family);
  assert.ok(css.includes("@import url('./fonts-serif-sc.css')"));
  assert.ok(readFileSync(web('shared/fonts-serif-sc.css'), 'utf8').includes("'Noto Serif SC'"));
  // The notices name every family and each licence text exists.
  const notices = readFileSync(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const [family, licence] of [
    ['Geist', 'Geist-OFL-1.1.txt'],
    ['Geist Mono', 'GeistMono-OFL-1.1.txt'],
    ['Instrument Serif', 'InstrumentSerif-OFL-1.1.txt'],
    ['Noto Serif SC', 'NotoSerifSC-OFL-1.1.txt'],
  ] as const) {
    assert.ok(notices.includes(family) && notices.includes(licence), family);
    assert.match(
      readFileSync(new URL(`../../licenses/${licence}`, import.meta.url), 'utf8'),
      /SIL Open Font License/,
      licence,
    );
  }
});

test('font files are served with a year-long immutable cache, on the console host and in the portal', async () => {
  const names = fontsNamed();
  const sample = [names[0]!, names[names.length - 1]!, 'noto-serif-sc-4-600.woff2'];
  const s = await setup(undefined, separated);
  try {
    for (const name of sample) {
      const r = await s.app.inject({
        method: 'GET',
        url: `/fonts/${name}`,
        headers: { host: CONSOLE },
      });
      assert.equal(r.statusCode, 200, name);
      assert.equal(r.headers['content-type'], 'font/woff2', name);
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', name);
      assert.equal(r.rawPayload.compare(readFileSync(web(`fonts/${name}`))), 0, name);
      assert.equal(r.rawPayload.subarray(0, 4).toString('latin1'), 'wOF2', name);
      // The management plane stays on the console host.
      const api = await s.app.inject({
        method: 'GET',
        url: `/fonts/${name}`,
        headers: { host: API },
      });
      assert.equal(api.statusCode, 404, name);
    }
    for (const url of [
      '/fonts/Geist.woff2',
      '/fonts/geist-latin.woff',
      '/fonts/..%2Fconsole.css',
      '/fonts/missing-font.woff2',
      `/fonts/${'a'.repeat(70)}.woff2`,
    ]) {
      const r = await s.request('GET', url, undefined, token, { host: CONSOLE });
      assert.equal(r.statusCode, 404, url);
    }
  } finally {
    await s.cleanup();
  }
  await withPlatform({}, async (p) => {
    for (const name of sample) {
      const r = await call(p, 'GET', `/portal/fonts/${name}`);
      assert.equal(r.statusCode, 200, name);
      assert.equal(r.headers['content-type'], 'font/woff2', name);
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', name);
      const consoleCopy = await call(p, 'GET', `/fonts/${name}`, undefined, ADMIN);
      assert.equal(r.rawPayload.compare(consoleCopy.rawPayload), 0, name);
    }
    for (const url of [
      '/portal/fonts/Geist.woff2',
      '/portal/fonts/geist-latin.ttf',
      '/portal/fonts/..%2Fportal.css',
      '/portal/fonts/missing-font.woff2',
    ]) {
      const r = await call(p, 'GET', url);
      assert.equal(r.statusCode, 404, url);
      assert.equal(r.json().error.code, 'not_found', url);
    }
  });
});
