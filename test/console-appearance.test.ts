import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = (file: string) =>
  readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8');

test('dark surfaces and text retain the approved Possibility palette', () => {
  const css = source('shared/tokens.css');
  const dark = css.slice(css.indexOf(":root[data-theme='dark']"));
  const approved = {
    paper: '#202020',
    'paper-2': '#191919',
    ink: '#efefef',
    bg: '#202020',
    'bg-app': '#191919',
    'bg-panel': '#282828',
    'bg-subtle': '#333333',
    'bg-muted': '#3d3d3d',
    'bg-elevated': '#303030',
    'segment-bg': '#282828',
    border: '#454545',
    'border-soft': '#363636',
    'border-strong': '#626262',
    text: '#d5d5d5',
    'text-strong': '#efefef',
    'text-muted': '#bcbcbc',
    'text-soft': '#b0b0b0',
    'text-faint': '#a3a3a3',
    'code-bg': '#1c1c1c',
    'tide-deep': '#91dcd4',
    'tide-wash': '#343434',
    'tide-ink': '#173f3b',
  };
  for (const [name, value] of Object.entries(approved))
    assert.ok(dark.includes(`--${name}: ${value};`), name);
  assert.ok(
    !dark.includes("[data-palette='tide']"),
    'legacy palette cannot override the neutral surfaces',
  );
});

function browser(saved: Record<string, unknown>, dark = true) {
  let stored = JSON.stringify(saved);
  const dataset: Record<string, string> = {};
  const listeners = new Map<string, () => void>();
  const query = {
    matches: dark,
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  };
  const messages: unknown[] = [];
  return {
    globals: {
      document: { documentElement: { dataset } },
      localStorage: {
        getItem: (key: string) => (key === 'oaa.prefs.v1' ? stored : null),
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
      sessionStorage: { getItem: () => null },
      navigator: { language: 'en' },
      window: {
        matchMedia: () => query,
        webkit: {
          messageHandlers: { oaa: { postMessage: (message: unknown) => messages.push(message) } },
        },
      },
    },
    dataset,
    query,
    listeners,
    messages,
    stored: () => JSON.parse(stored) as Record<string, unknown>,
  };
}

test('first paint normalizes legacy dark palettes and keeps system appearance in sync', () => {
  const b = browser({ theme: 'system', palette: 'tide', density: 'compact', sidebar: 'collapsed' });
  runInNewContext(source('boot.js'), b.globals);
  assert.equal(b.dataset.palette, 'black');
  assert.equal(b.dataset.theme, 'dark');
  assert.equal(b.dataset.density, 'compact');
  assert.equal(b.dataset.sidebar, 'collapsed');
  b.query.matches = false;
  b.listeners.get('change')!();
  assert.equal(b.dataset.theme, 'light');
  assert.equal(b.stored().palette, 'tide', 'boot does not rewrite unrelated stored preferences');
});

function loadModule(
  file: string,
  globals: Record<string, unknown>,
  imports: Record<string, unknown> = {},
) {
  const context = { ...globals, exports: {}, require: (name: string) => imports[name] ?? {} };
  const compiled = ts.transpileModule(source(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  runInNewContext(compiled.outputText, context);
  return context.exports;
}

test('preference updates retain the neutral palette and do not erase other settings', () => {
  const b = browser({ theme: 'dark', palette: 'tide', sidebar: 'collapsed', refresh: 30 });
  const runtime = loadModule('lib/state.js', b.globals) as {
    hooks: Record<string, () => void>;
    prefs: Record<string, unknown>;
    applyPrefs(): void;
    savePrefs(patch: Record<string, unknown>): void;
  };
  for (const name of ['schedulePolling', 'renderView', 'syncBadge', 'icons'])
    runtime.hooks[name] = () => {};
  runtime.applyPrefs();
  assert.equal(runtime.prefs.palette, 'black');
  assert.equal(b.dataset.theme, 'dark');
  runtime.savePrefs({ theme: 'light', palette: 'tide' });
  assert.equal(b.dataset.theme, 'light');
  assert.equal(b.stored().palette, 'black');
  assert.equal(b.stored().sidebar, 'collapsed');
  assert.equal(b.stored().refresh, 30);
  assert.equal((b.messages.at(-1) as { palette: string }).palette, 'black');
});

test('settings return to the previous page, including its subpage, with a direct-link fallback', () => {
  const location = { hash: '#settings' };
  const state: { settingsReturnHash?: string } = { settingsReturnHash: '#platform/accounts' };
  const settings = loadModule(
    'views/settings.js',
    { location },
    { '../lib/state.js': { state } },
  ) as {
    leaveSettings(): void;
  };
  settings.leaveSettings();
  assert.equal(location.hash, '#platform/accounts');
  delete state.settingsReturnHash;
  settings.leaveSettings();
  assert.equal(location.hash, '#overview');
});

test('settings navigation belongs to the shell, not a second sidebar inside the page', () => {
  const html = source('index.html');
  const sidebar = html.indexOf('id="settings-sidebar"');
  const nav = html.indexOf('id="settings-nav"');
  const main = html.indexOf('<main class="main">');
  assert.ok(sidebar > 0 && sidebar < nav && nav < main);
  assert.ok(!source('views/settings.js').includes('IntersectionObserver'));
  assert.ok(source('views/settings.js').includes('section.hidden = section.id !=='));
});
