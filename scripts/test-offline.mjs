// 离线测试入口：挑出不监听端口的测试文件（源码里没有 `.listen(`、`WebSocketServer(`、`createServer(`），
// 把对应的 dist/test/*.test.js 交给 node --test 顺序运行，退出码原样返回。需先 build。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LISTENS = /\.listen\(|WebSocketServer\(|createServer\(/;

// `--all`：不筛选，跑全部测试文件（`npm test` 用）。
const ALL = process.argv.includes('--all');
const files = readdirSync('test')
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .filter((f) => ALL || !LISTENS.test(readFileSync(path.join('test', f), 'utf8')))
  .map((f) => path.join('dist', 'test', f.replace(/\.ts$/, '.js')));

const missing = files.filter((f) => !existsSync(f));
if (files.length === 0 || missing.length > 0) {
  console.error(
    files.length === 0
      ? 'test-offline: no offline test files found'
      : `test-offline: missing build output: ${missing.join(', ')}`,
  );
  process.exit(1);
}

console.log(`test-offline: ${files.length} files`);
// `--isolate`：每个文件单独一个 node --test 进程，各自时限（默认 3 分钟，OAA_TEST_FILE_TIMEOUT_MS
// 可调）；超时结束该文件的进程树并记为超时，继续下一个文件；最后汇总，有任何失败则非零退出。
if (process.argv.includes('--isolate')) {
  const { runIsolated, summarize } = await import('./test-isolate.mjs');
  const results = await runIsolated(files, {
    nodeArgs: [
      '--import',
      './dist/test/setup-locale.js',
      '--test',
      '--test-concurrency=1',
      '--test-timeout=120000',
    ],
    timeoutMs: Number(process.env.OAA_TEST_FILE_TIMEOUT_MS) || 3 * 60_000,
  });
  const { ok, text } = summarize(results);
  console.log(text);
  process.exit(ok ? 0 : 1);
}
// 两道保险，避免一项卡死静默耗到 CI 作业超时：
// 1. 单项超时：最慢的测试本机约 3.5 秒，给 2 分钟足够宽裕；卡死的那项会以名字报出并判失败。
// 2. 总时限：超时的测试若留下句柄（计时器、套接字），该文件的进程不会自己退出，所以这里再设总时限，
//    到点结束整个进程树并以非零退出。不用 --test-force-exit：实测它会让部分测试不被执行却仍然报告通过。
const WATCHDOG_MS = Number(process.env.OAA_TEST_WATCHDOG_MS) || 20 * 60_000;
const windows = process.platform === 'win32';
const child = spawn(
  process.execPath,
  [
    '--import',
    './dist/test/setup-locale.js',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=120000',
    ...files,
  ],
  { stdio: 'inherit', detached: !windows },
);
const watchdog = setTimeout(() => {
  console.error(
    `test-offline: 超过总时限 ${Math.round(WATCHDOG_MS / 60_000)} 分钟仍未结束，结束测试进程（上面最后一项之后的测试卡住了）。`,
  );
  try {
    if (windows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // 进程已经退出。
  }
  process.exit(1);
}, WATCHDOG_MS);
child.on('exit', (code, signal) => {
  clearTimeout(watchdog);
  process.exit(code ?? (signal ? 1 : 0));
});
