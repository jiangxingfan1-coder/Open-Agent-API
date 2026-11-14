/**
 * 新手上手用的两个小命令：`oaa key create`（不打开控制台也能拿到调用方密钥）与 `oaa stop`
 * （停掉 `oaa serve --detach` 启动的网关）。只经网关的公开接口或本机 pid 文件工作。
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { GatewayClient } from './client.js';
import type { GatewayConfig } from '../config/config.js';
import { Fault, sleep, writePrivate } from '../core/util.js';

export type KeyCreateOptions = {
  name?: string;
  agents?: string[];
  out?: string;
  approve?: boolean;
};

/** 调用方密钥默认的权限：调用、读取自己的任务、上传文件；`--approve` 时再加审批。 */
export function callerScopes(approve = false): string[] {
  return ['invoke', 'read', 'files', ...(approve ? ['approve'] : [])];
}

/** `oaa key create`：经 `POST /v1/keys` 生成一把调用方密钥，写进私有文件（不打印密钥本身）。 */
export async function createCallerKey(client: GatewayClient, options: KeyCreateOptions) {
  const name = options.name?.trim();
  if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name))
    throw new Fault('arguments', 'key create needs --name made of letters, digits, _ . or -.');
  const agents = options.agents?.length ? options.agents : ['*'];
  const out = path.resolve(options.out ?? path.join('.oaa', 'keys', `${name}.key`));
  await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  try {
    await readFile(out);
    throw new Fault('output_exists', `${out} already exists; choose another --out or --name.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const created = await client.request<{ id: string; token: string; scopes: string[] }>(
    'POST',
    '/v1/keys',
    { name, agents, scopes: callerScopes(options.approve) },
  );
  await writePrivate(path.dirname(out), path.basename(out), created.token + '\n', true);
  const baseUrl = `${client.url.replace(/\/+$/, '')}/v1`;
  const model = agents[0] === '*' ? 'AGENT' : agents[0];
  return {
    id: created.id,
    name,
    token_file: out,
    base_url: baseUrl,
    model,
    agents,
    scopes: created.scopes,
    try: `curl ${baseUrl}/chat/completions -H "Authorization: Bearer $(cat '${out}')" -H 'Content-Type: application/json' -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'`,
    note: 'The key itself is only in token_file; it is not printed.',
  };
}

/** `oaa stop`：读数据目录里的 server.pid，确认 /health 报告的正是这个进程后再发 SIGTERM。 */
export async function stopDetachedGateway(
  dataDir: string,
  url: string,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
  probe: (url: string) => Promise<number | undefined> = healthPid,
  graceful?: () => Promise<boolean>,
) {
  const pidFile = path.join(dataDir, 'server.pid');
  let pid: number;
  try {
    pid = Number((await readFile(pidFile, 'utf8')).trim());
  } catch {
    throw new Fault(
      'not_running',
      `No ${pidFile}; the gateway was not started with --detach.`,
      404,
    );
  }
  if (!Number.isInteger(pid) || pid <= 0 || (await probe(url)) !== pid) {
    await rm(pidFile, { force: true });
    throw new Fault(
      'not_running',
      `The gateway recorded in ${pidFile} is not running at ${url}.`,
      404,
    );
  }
  // Windows: SIGTERM is TerminateProcess, so ask the gateway to close itself first (admin key,
  // loopback only) and fall back to the signal only if it is still the same process afterwards.
  let asked = false;
  if (graceful) asked = await graceful().catch(() => false);
  for (let i = 0; asked && i < 100 && (await probe(url)) === pid; i++) await sleep(100);
  if (!asked || (await probe(url)) === pid) kill(pid, 'SIGTERM');
  for (let i = 0; i < 50 && (await probe(url)) === pid; i++) await sleep(100);
  await rm(pidFile, { force: true });
  return { stopped: true, pid, url };
}

/** 网关的服务地址（`http(s)://host:port`）。 */
export const gatewayUrl = (config: GatewayConfig) =>
  `${config.tls ? 'https' : 'http'}://${config.host}:${config.port}`;

/** `oaa serve --detach`：起一个后台网关进程，等到 /health 报告的 pid 就是它，再写 server.pid。 */
export async function startDetached(
  cliPath: string,
  file: string,
  config: GatewayConfig,
  toolConfigs: string[] = [],
): Promise<{ url: string; pid: number }> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(config.dataDir, 'server.log');
  const log = openSync(logFile, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [
      cliPath,
      'serve',
      '--config',
      file,
      ...toolConfigs.flatMap((tool) => ['--tool-config', path.resolve(tool)]),
    ],
    // windowsHide: on Windows a detached child otherwise gets its own visible console window.
    { cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', log, log] },
  );
  closeSync(log);
  child.unref();
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const url = gatewayUrl(config);
  for (let n = 0; n < 50; n++) {
    await sleep(100);
    if (exited)
      throw new Fault('startup_failed', `Service startup failed; inspect ${logFile}.`, 500);
    if (child.pid !== undefined && (await healthPid(url)) === child.pid) {
      await writePrivate(config.dataDir, 'server.pid', String(child.pid));
      return { url, pid: child.pid };
    }
  }
  throw new Fault('startup_timeout', 'Service readiness was not observed. Inspect its log.', 500);
}

/** `oaa stop` on Windows: ask the gateway at `url` to close itself with the configured admin key. */
export function adminShutdown(config: GatewayConfig, url: string): () => Promise<boolean> {
  return async () => {
    const tokenFile = config.keys.find((k) => k.scopes.includes('admin') && k.tokenFile)?.tokenFile;
    if (!tokenFile) return false;
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const r = await fetch(`${url}/v1/gateway/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  };
}

export async function healthPid(url: string): Promise<number | undefined> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    return r.ok ? ((await r.json()) as { pid?: number }).pid : undefined;
  } catch {
    return undefined;
  }
}
