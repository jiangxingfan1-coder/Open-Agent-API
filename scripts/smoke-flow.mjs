// 烟雾测试的「首次调用」段（由 scripts/smoke-release.mjs 在启动检查之后调用）：
// quickstart → 用它生成的调用方密钥分别走 OpenAI Chat、Claude Messages、Gemini generateContent，
// 核对回答来自离线示例智能体 → 发一个带 approve 的后台任务，等它停在 requires_action，经 API 批准，
// 等它完成并核对产物文件 → oaa status 核对网关在运行、示例智能体可运行，再用 oaa approvals / oaa approve 走一遍
// 命令行审批 → 再跑一遍 quickstart 核对幂等 → stop，确认端口释放、没有残留进程。
// 全部步骤都有界：每次 HTTP 请求 30 秒，每段轮询最多 60 秒，失败时先礼后兵地清掉网关再抛出。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** 正在使用中的 quickstart 数据目录：看门狗超时退出时据此尽力停掉网关。 */
export const liveDirs = new Set();

const MARKER = 'offline sample agent';
const SAMPLE = 'agent/sample';

/** 反复调用 fn 直到返回真值，最多 ms 毫秒；超时抛出带说明的错误。 */
async function poll(what, ms, sleep, fn) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${Math.round(ms / 1000)} 秒）：${what}`);
    await sleep(250);
  }
}

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** 命令行里带有这个数据目录的进程（POSIX；Windows 上没有 ps，返回空）。 */
function processesUsing(dir) {
  if (process.platform === 'win32') return [];
  const r = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter((line) => line.includes(dir) && !line.includes(' ps '));
}

export async function firstCallFlow({ run, step, sleep, freePort, expectVersion }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oaa smoke 首次-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let started = false;
  try {
    run(['quickstart', '--dir', dir, '--port', String(port)]);
    started = true;
    liveDirs.add(dir);
    const keyFile = path.join(dir, 'keys', 'quickstart.key');
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    if (!key) throw new Error('quickstart 没有写出调用方密钥文件');
    if (process.platform !== 'win32' && (fs.statSync(keyFile).mode & 0o077) !== 0)
      throw new Error('密钥文件的权限应为 0600');
    step(`quickstart 通过（端口 ${port}，数据目录 ${dir}）`);

    const api = async (method, urlPath, { body, headers = {} } = {}) => {
      const res = await fetch(`${base}${urlPath}`, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        // 不是 JSON（例如产物文件内容）：保留原文。
      }
      return { status: res.status, json, text };
    };
    const expectAnswer = (name, r, answer) => {
      if (r.status !== 200 || !String(answer ?? '').includes(MARKER))
        throw new Error(`${name} 不符：HTTP ${r.status} ${r.text.slice(0, 400)}`);
      step(`${name}：回答来自离线示例智能体`);
    };

    const chat = await api('POST', '/v1/chat/completions', {
      body: { model: SAMPLE, messages: [{ role: 'user', content: 'Hello' }] },
    });
    expectAnswer('OpenAI Chat Completions', chat, chat.json?.choices?.[0]?.message?.content);
    const claude = await api('POST', '/v1/messages', {
      headers: { 'anthropic-version': '2023-06-01' },
      body: { model: SAMPLE, max_tokens: 256, messages: [{ role: 'user', content: 'Hello' }] },
    });
    expectAnswer('Claude Messages', claude, claude.json?.content?.[0]?.text);
    const gemini = await api('POST', `/v1beta/models/${SAMPLE}:generateContent`, {
      body: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
    });
    expectAnswer(
      'Gemini generateContent',
      gemini,
      gemini.json?.candidates?.[0]?.content?.parts?.[0]?.text,
    );

    // 控制台页面与图标库（lucide 的 umd 构建在裁剪后的包里仍要在）。
    const page = await api('GET', '/');
    const icons = await api('GET', '/icons.js');
    if (page.status !== 200 || !/<html/i.test(page.text))
      throw new Error(`控制台页面不可用：HTTP ${page.status}`);
    if (icons.status !== 200 || icons.text.length < 100_000)
      throw new Error(`图标库不可用：HTTP ${icons.status}，${icons.text.length} 字节`);
    step('控制台页面与图标库可访问');

    // 后台任务：停在 requires_action → 批准 → 完成 → 产物文件。
    const created = await api('POST', '/v1/responses', {
      body: { model: SAMPLE, input: 'please approve this', background: true },
    });
    const runId = created.json?.id;
    if (created.status !== 200 || !runId)
      throw new Error(`后台任务没有创建：${created.text.slice(0, 400)}`);
    const parked = await poll('任务停在 requires_action', 60_000, sleep, async () => {
      const r = await api('GET', `/v1/runs/${runId}`);
      if (['completed', 'failed', 'cancelled'].includes(r.json?.status))
        throw new Error(`任务提前结束（${r.json.status}）：${r.text.slice(0, 400)}`);
      return r.json?.status === 'requires_action' ? r.json : undefined;
    });
    const action = parked.actions?.find((a) => a.status === 'pending');
    if (!action)
      throw new Error(`requires_action 却没有待批准的动作：${JSON.stringify(parked.actions)}`);
    step(`任务停在 requires_action：${action.detail?.title ?? action.id}`);
    const decided = await api('POST', `/v1/runs/${runId}/actions/${action.id}`, {
      body: { decision: 'approve' },
    });
    if (decided.status !== 200 || decided.json?.resolved !== true)
      throw new Error(`批准失败：HTTP ${decided.status} ${decided.text.slice(0, 400)}`);
    const done = await poll('任务完成', 60_000, sleep, async () => {
      const r = await api('GET', `/v1/runs/${runId}`);
      if (['failed', 'cancelled'].includes(r.json?.status))
        throw new Error(`批准后任务失败（${r.json.status}）：${r.text.slice(0, 400)}`);
      return r.json?.status === 'completed' ? r.json : undefined;
    });
    const artifact = done.artifacts?.find((a) => a.name === 'sample-note.txt');
    if (!artifact) throw new Error(`没有产物 sample-note.txt：${JSON.stringify(done.artifacts)}`);
    const file = await api('GET', `/v1/files/${artifact.id}/content`);
    if (
      file.status !== 200 ||
      !file.text.includes('Written by the sample agent: please approve this')
    )
      throw new Error(`产物内容不符：HTTP ${file.status} ${file.text.slice(0, 200)}`);
    step('批准后任务完成，产物 sample-note.txt 内容正确');

    // 命令行：oaa status（只读，--json 与语言无关）与 oaa approvals / approve 走一遍审批。
    const status = JSON.parse(run(['status', '--dir', dir, '--json']));
    const sample = status.agents?.find((a) => a.id === SAMPLE);
    if (status.running !== true || status.version !== expectVersion)
      throw new Error(`oaa status 不符：${JSON.stringify(status).slice(0, 400)}`);
    if (!sample || sample.runnable !== true)
      throw new Error(`oaa status 里示例智能体不可运行：${JSON.stringify(sample)}`);
    step(`oaa status：网关在运行（pid ${status.pid}），${SAMPLE} 可运行`);
    const second = await api('POST', '/v1/responses', {
      body: { model: SAMPLE, input: 'please approve this too', background: true },
    });
    const secondId = second.json?.id;
    if (second.status !== 200 || !secondId)
      throw new Error(`第二个后台任务没有创建：${second.text.slice(0, 400)}`);
    const pending = await poll('oaa approvals 列出待批准项', 60_000, sleep, async () =>
      JSON.parse(run(['approvals', '--dir', dir, '--json'])).pending?.find(
        (p) => p.run_id === secondId,
      ),
    );
    const waiting = JSON.parse(run(['status', '--dir', dir, '--json']));
    if (!(waiting.tasks?.awaiting_approval >= 1))
      throw new Error(`oaa status 没有显示等待批准的任务：${JSON.stringify(waiting.tasks)}`);
    const approved = JSON.parse(run(['approve', secondId, '--yes', '--dir', dir, '--json']));
    if (!approved.results?.every((r) => r.ok && r.decision === 'approve'))
      throw new Error(`oaa approve 失败：${JSON.stringify(approved)}`);
    const secondDone = await poll('命令行批准后任务完成', 60_000, sleep, async () => {
      const r = await api('GET', `/v1/runs/${secondId}`);
      if (['failed', 'cancelled'].includes(r.json?.status))
        throw new Error(`命令行批准后任务失败（${r.json.status}）：${r.text.slice(0, 400)}`);
      return r.json?.status === 'completed' ? r.json : undefined;
    });
    if (!secondDone.artifacts?.some((a) => a.name === 'sample-note.txt'))
      throw new Error(`命令行批准后没有产物：${JSON.stringify(secondDone.artifacts)}`);
    step(`oaa approvals 列出「${pending.summary}」，oaa approve 批准后任务完成并有产物`);

    // 再跑一遍 quickstart：沿用同一个网关与密钥，不重复创建。
    const again = run(['quickstart', '--dir', dir, '--port', String(port)]);
    if (!/reusing|沿用|复用/.test(again))
      throw new Error(`第二次 quickstart 没有复用：\n${again.slice(0, 800)}`);
    if (fs.readFileSync(keyFile, 'utf8').trim() !== key)
      throw new Error('第二次 quickstart 换掉了密钥');
    const models = await api('GET', '/v1/models');
    const samples = (models.json?.data ?? []).filter((m) => m.id === SAMPLE);
    if (samples.length !== 1) throw new Error(`示例智能体应当只有一个，实际 ${samples.length} 个`);
    step('第二次 quickstart 幂等：复用网关与密钥，示例智能体仍只有一个');

    const health = await api('GET', '/healthz');
    if (health.json?.version !== expectVersion)
      throw new Error(`/healthz 版本不符：${health.text}`);
    const stopped = JSON.parse(run(['stop', '--dir', dir]));
    started = false;
    liveDirs.delete(dir);
    if (stopped.stopped !== true) throw new Error(`stop 没有成功：${JSON.stringify(stopped)}`);
    await poll(`端口 ${port} 释放`, 15_000, sleep, async () => !(await portOpen(port)));
    await poll(`网关进程 ${stopped.pid} 退出`, 15_000, sleep, async () => !alive(stopped.pid));
    const left = await poll('没有残留进程', 15_000, sleep, async () =>
      processesUsing(dir).length === 0 ? [] : undefined,
    ).catch(() => processesUsing(dir));
    if (left.length) throw new Error(`stop 之后仍有进程使用 ${dir}：\n${left.join('\n')}`);
    step('stop 之后端口已释放、没有残留进程');
  } finally {
    if (started) {
      try {
        run(['stop', '--dir', dir]);
      } catch (err) {
        console.warn(`[smoke] 警告：清理时 stop 失败（${String(err.message).split('\n')[0]}）`);
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (err) {
      console.warn(`[smoke] 警告：没能删除临时目录 ${dir}（${err.message}）`);
    }
  }
}

/** 用当前这个 Node 逐个 import 包里 dist/src 下的每个模块（裁剪 node_modules 后确认没有缺依赖）。 */
export function importEveryModule(appDir, cwd) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = path.join(process.argv[1], 'dist', 'src');
    const files = fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.js')).sort();
    const failed = [];
    for (const f of files) {
      try { await import(pathToFileURL(path.join(root, f)).href); }
      catch (err) { failed.push(f + ': ' + String(err && err.message).split('\\n')[0]); }
    }
    console.log(JSON.stringify({ count: files.length, failed }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, appDir], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`逐个 import 失败（退出码 ${r.status}）：${r.stderr}`);
  const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
  if (result.count < 50) throw new Error(`dist/src 下只找到 ${result.count} 个模块，路径不对？`);
  if (result.failed.length) throw new Error(`有模块无法 import：\n${result.failed.join('\n')}`);
  return result.count;
}
