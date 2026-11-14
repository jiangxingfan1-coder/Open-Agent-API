// 离线测试入口：挑出不监听端口的测试文件（源码里没有 `.listen(`、`WebSocketServer(`、`createServer(`），
// 把对应的 dist/test/*.test.js 交给 node --test 顺序运行，退出码原样返回。需先 build。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LISTENS = /\.listen\(|WebSocketServer\(|createServer\(/;

const files = readdirSync('test')
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .filter((f) => !LISTENS.test(readFileSync(path.join('test', f), 'utf8')))
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
const child = spawn(
  process.execPath,
  ['--import', './dist/test/setup-locale.js', '--test', '--test-concurrency=1', ...files],
  {
    stdio: 'inherit',
  },
);
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
