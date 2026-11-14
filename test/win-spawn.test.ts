import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cmdCommandLine,
  escapeCmdMeta,
  launchPlan,
  quoteWindowsArg,
} from '../src/engines/win-spawn.js';
import {
  npmShimTarget,
  pathExtensions,
  resolveWindowsCommand,
  whichSync,
} from '../src/core/which.js';
import { windowsUnsafeSegment } from '../src/core/win-path.js';
import { icaclsArgs } from '../src/core/win-acl.js';
import { collectProcess } from '../src/engines/process.js';
import { relativeName } from '../src/core/util.js';

const windows = process.platform === 'win32';
const NASTY = [
  'plain',
  'with space',
  'C:\\Users\\名字 带空格\\x',
  'quote " inside',
  'trailing backslash\\',
  'a & calc.exe',
  '%PATH%',
  '!PATH!',
  'pipe | more > out.txt',
  '^caret^',
  '(paren) ;semi, comma',
  '',
  '中文参数',
];

test('quoteWindowsArg follows the MSVCRT argv rules', () => {
  assert.equal(quoteWindowsArg('simple'), 'simple');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('a b'), '"a b"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg('dir\\ x\\'), '"dir\\ x\\\\"');
  assert.equal(quoteWindowsArg('a\\"b c'), '"a\\\\\\"b c"');
});

test('escapeCmdMeta caret-escapes every cmd.exe metacharacter', () => {
  assert.equal(escapeCmdMeta('a&b|c<d>e'), 'a^&b^|c^<d^>e');
  assert.equal(escapeCmdMeta('%X% !Y!'), '^%X^%^ ^!Y^!');
  assert.equal(escapeCmdMeta('"q"^'), '^"q^"^^');
});

test('cmdCommandLine leaves no unescaped metacharacter for cmd.exe', () => {
  const line = cmdCommandLine('C:\\tools\\agent.cmd', ['a & calc', '%PATH%', 'x"y']);
  assert.ok(line.startsWith('"') && line.endsWith('"'));
  const inner = line.slice(1, -1);
  // Every metacharacter is preceded by a caret (pairs of carets collapse to literal carets).
  const stripped = inner.replace(/\^./g, '');
  assert.doesNotMatch(stripped, /[&|<>%!"()]/);
  // Arguments are escaped twice (cmd.exe line, then the batch file's %* re-parse).
  assert.match(inner, /\^\^\^&/);
});

test('cmdCommandLine refuses line breaks and NUL instead of truncating', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\0b'])
    assert.throws(() => cmdCommandLine('x.cmd', [bad]), { code: 'invalid_request' });
});

test('npmShimTarget reads the entry point of an npm cmd-shim', () => {
  const shim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n');
  const target = npmShimTarget(path.join('npm', 'codex.cmd'), shim);
  assert.ok(target?.endsWith('codex.js'));
  assert.equal(npmShimTarget('x.cmd', '@echo off\r\nnode other.js'), undefined);
});

test('launchPlan is a pass-through outside Windows', () => {
  assert.deepEqual(launchPlan('codex', ['exec', 'a b'], process.env, 'linux'), {
    command: 'codex',
    args: ['exec', 'a b'],
  });
});

test('PATHEXT lookup finds extension-less commands like where does', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-which-'));
  try {
    await writeFile(path.join(dir, 'tool.CMD'), '@echo off\r\n');
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
    assert.deepEqual(pathExtensions(env), ['.exe', '.cmd']);
    const found = resolveWindowsCommand('tool', env);
    // Case-insensitive file systems (Windows, default macOS) match `tool.cmd`; others need the real case.
    assert.ok(
      found === undefined || found.toLowerCase() === path.join(dir, 'tool.cmd').toLowerCase(),
    );
    assert.equal(resolveWindowsCommand('missing', env), undefined);
    assert.ok(resolveWindowsCommand(path.join(dir, 'tool.CMD'), env));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows-only path segments are recognised', () => {
  for (const bad of ['a:b', 'CON', 'nul.txt', 'COM1', 'name.', 'name ', 'x?y'])
    assert.equal(windowsUnsafeSegment(bad), true, bad);
  for (const ok of ['readme.md', 'console.log', '中文.txt', 'a b'])
    assert.equal(windowsUnsafeSegment(ok), false, ok);
  if (windows) assert.throws(() => relativeName('docs/file:stream'), { code: 'invalid_path' });
});

test('icacls arguments drop inheritance and grant only the owner', () => {
  assert.deepEqual(icaclsArgs('C:\\d\\admin.token', 'HOST\\me'), [
    'C:\\d\\admin.token',
    '/inheritance:r',
    '/grant:r',
    'HOST\\me:F',
    '/q',
  ]);
});

test(
  'a .cmd launcher receives hostile arguments verbatim and runs no injected command',
  { skip: windows ? false : 'Batch files and cmd.exe exist only on Windows' },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa cmd 中文 '));
    try {
      const echo = path.join(dir, 'echo.js');
      await writeFile(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      // Not an npm shim: exercises the cmd.exe /d /s /c fallback with double escaping.
      await writeFile(
        path.join(dir, 'echo-args.cmd'),
        `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`,
      );
      const marker = path.join(dir, 'injected.txt');
      const args = [...NASTY, `x & echo pwned > "${marker}"`];
      const out = await collectProcess(
        path.join(dir, 'echo-args'),
        args,
        dir,
        '',
        AbortSignal.timeout(20_000),
      );
      assert.deepEqual(JSON.parse(out), args);
      assert.equal(whichSync('echo-args', dir), path.join(dir, 'echo-args.cmd'));
      await assert.rejects(rm(marker), { code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'an npm cmd-shim runs its JavaScript entry point through node without cmd.exe',
  { skip: windows ? false : 'npm .cmd shims exist only on Windows' },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-shim-'));
    try {
      await mkdir(path.join(dir, 'node_modules', 'fake', 'bin'), { recursive: true });
      await writeFile(
        path.join(dir, 'node_modules', 'fake', 'bin', 'cli.js'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
      );
      await writeFile(
        path.join(dir, 'fake.cmd'),
        '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"node"  "%dp0%\\node_modules\\fake\\bin\\cli.js" %*\r\n',
      );
      const plan = launchPlan('fake', ['multi\nline', 'a & b'], { ...process.env, PATH: dir });
      assert.equal(plan.command, process.execPath);
      assert.equal(plan.windowsVerbatimArguments, undefined);
      const out = await collectProcess(
        path.join(dir, 'fake.cmd'),
        ['multi\nline', 'a & b', '%PATH%'],
        dir,
        '',
        AbortSignal.timeout(20_000),
      );
      assert.deepEqual(JSON.parse(out), ['multi\nline', 'a & b', '%PATH%']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'cancelling a .cmd launcher ends the real process behind it',
  {
    skip: windows
      ? false
      : 'Covers taskkill /T on Windows; POSIX uses process groups (process.test)',
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-tree-'));
    try {
      const pidFile = path.join(dir, 'pid');
      await writeFile(
        path.join(dir, 'hang.js'),
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000);`,
      );
      await writeFile(
        path.join(dir, 'hang.cmd'),
        `@echo off\r\n"${process.execPath}" "%~dp0hang.js"\r\n`,
      );
      const controller = new AbortController();
      const run = collectProcess(path.join(dir, 'hang.cmd'), [], dir, '', controller.signal);
      let pid = 0;
      for (let i = 0; i < 100 && !pid; i++) {
        await new Promise((r) => setTimeout(r, 100));
        pid = Number(
          await import('node:fs/promises')
            .then((f) => f.readFile(pidFile, 'utf8'))
            .catch(() => '0'),
        );
      }
      assert.ok(pid > 0, 'grandchild started');
      controller.abort();
      await assert.rejects(run, { code: 'cancelled' });
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, 'the node process behind the .cmd launcher was ended');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
