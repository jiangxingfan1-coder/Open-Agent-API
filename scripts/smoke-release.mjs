// 发布产物的烟雾测试（只在 CI 机器上运行，见 .github/workflows/release.yml）：
//   <包内 node> scripts/smoke-release.mjs --launcher <包内 oaa 或 oaa.cmd> --expect-version <版本>
// 依次：launcher --help；在临时目录（路径含空格与中文）init；把端口改成随机的本机回环端口；
// 后台 serve；请求 /healthz 核对 protocol 与版本；doctor 应把 Claude 引擎标为需要另行安装；最后结束网关。
//
// 防卡死：每条同步命令 60 秒超时；等待网关就绪最多 60 秒；结束网关先礼后兵（Windows 用 taskkill /T /F 杀整棵进程树，
// 其他平台先 SIGTERM、10 秒后 SIGKILL）；整个脚本另有 4 分钟看门狗。清理临时目录失败只警告，不让已通过的测试变红。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`缺少 ${name}`);
  return args[i + 1];
};
const launcher = path.resolve(arg('--launcher'));
const expectVersion = arg('--expect-version').replace(/^v/, '');
const isCmd = process.platform === 'win32' && /\.cmd$/i.test(launcher);

// Windows 上 .cmd 必须经 cmd.exe 运行；整条命令行再包一层引号（cmd /s /c 的规则），路径含空格与中文也安全。
function command(argv) {
  if (!isCmd) return { file: launcher, args: argv, opts: {} };
  const line = [launcher, ...argv].map((a) => `"${a}"`).join(' ');
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    opts: { windowsVerbatimArguments: true },
  };
}
function run(argv) {
  const c = command(argv);
  const r = spawnSync(c.file, c.args, { ...c.opts, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0)
    throw new Error(
      `${argv.join(' ')} 退出码 ${r.status}${r.error ? `（${r.error.message}）` : ''}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    );
  return r.stdout;
}
const step = (msg) => console.log(`[smoke] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等 promise 完成，最多 ms 毫秒；返回是否在时限内完成（并清掉定时器，免得拖慢进程退出）。 */
const within = (promise, ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    promise.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

/** 结束网关及其子进程，并有界地等它退出；返回是否确认已退出。 */
async function stopGateway(child) {
  if (hasExited(child)) return true;
  const exited = new Promise((r) => child.once('exit', r));
  const killTree = (force) => {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {}
  };
  killTree(false);
  if (await within(exited, 10_000)) return true;
  killTree(true);
  return await within(exited, 5_000);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oaa smoke 数据-'));
let child;
let logFd;
const watchdog = setTimeout(async () => {
  console.error('[smoke] 超过 4 分钟仍未结束，强制退出');
  if (child) await stopGateway(child);
  process.exit(1);
}, 240_000);
watchdog.unref();

try {
  step(`launcher：${launcher}`);
  run(['--help']);
  step('--help 通过');

  run(['init', '--dir', dataDir]);
  const configPath = path.join(dataDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const port = await freePort();
  config.host = '127.0.0.1';
  config.port = port;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  step(`init 通过，端口 ${port}`);

  const doctor = JSON.parse(run(['doctor', '--config', configPath]));
  const sdk = doctor.binaries?.claude?.sdk?.status;
  if (sdk !== 'requires_separate_install')
    throw new Error(`发布包不应带 Claude Agent SDK，doctor 却报告 ${JSON.stringify(sdk)}`);
  step('doctor 把 Claude 引擎标为需要另行安装');

  const c = command(['serve', '--config', configPath]);
  const logPath = path.join(dataDir, 'serve.log');
  logFd = fs.openSync(logPath, 'a');
  child = spawn(c.file, c.args, { ...c.opts, stdio: ['ignore', logFd, logFd] });
  child.unref(); // 万一结束不了它，也不让本脚本因此挂住
  let health;
  // 最多等 60 秒：Windows 运行器上首次启动要被杀毒软件扫描 node_modules，比 macOS 慢。
  for (let i = 0; i < 300 && !health; i++) {
    await sleep(200);
    if (hasExited(child)) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) health = await res.json();
    } catch {}
  }
  if (!health)
    throw new Error(
      `网关没有就绪${hasExited(child) ? `（进程已退出，码 ${child.exitCode}）` : '（60 秒内没有响应 /healthz）'}：\n${fs.readFileSync(logPath, 'utf8').slice(-4000)}`,
    );
  if (health.protocol !== 'oaa/1' || health.version !== expectVersion)
    throw new Error(`/healthz 不符：${JSON.stringify(health)}，期望版本 ${expectVersion}`);
  step(`/healthz 通过：版本 ${health.version}`);
} finally {
  if (child) {
    const ok = await stopGateway(child);
    step(ok ? '网关已结束' : '警告：网关没有确认退出（不影响测试结论）');
  }
  if (logFd !== undefined) {
    try {
      fs.closeSync(logFd);
    } catch {}
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.warn(`[smoke] 警告：没能删除临时目录 ${dataDir}（${err.message}）`);
  }
}
