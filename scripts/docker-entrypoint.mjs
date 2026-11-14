#!/usr/bin/env node
// Container entrypoint (copied to /app/docker-entrypoint.mjs by the Dockerfile).
//
// First start: initialize the data directory, bind the gateway to every interface inside the container
// (the host side is limited to loopback by the port mapping, see docker-compose.yml), register and
// publish the offline sample agent and create a caller key file. Every start: keep host / port /
// allowed hosts in line with the environment, run `oaa serve` as a child and forward signals to it.
// The admin key and the caller key are never printed, only the location of their files.
//
// Environment: OAA_DATA_DIR (default /data/.oaa), OAA_PORT (8787), OAA_HOST (0.0.0.0),
// OAA_ALLOWED_HOSTS (comma separated extra Host header values, for a reverse proxy),
// OAA_PUBLIC_BASE_URL (read by the gateway itself), OAA_APP_DIR (where dist/ lives; tests only).
// Arguments other than `serve` run the oaa CLI instead (docker run IMAGE doctor).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const KEY_NAME = 'quickstart';

const say = (zh, en) => console.log(`[oaa] ${zh} / ${en}`);

export const listFromEnv = (value) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** Reads the container settings from the environment; throws on a bad port. */
export function settingsFromEnv(env) {
  const port = env.OAA_PORT ? Number(env.OAA_PORT) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`OAA_PORT must be an integer between 1 and 65535, got ${env.OAA_PORT}`);
  return {
    dataDir: env.OAA_DATA_DIR || '/data/.oaa',
    host: env.OAA_HOST || '0.0.0.0',
    port,
    extraHosts: listFromEnv(env.OAA_ALLOWED_HOSTS),
  };
}

/**
 * Applies the settings to a parsed config.json (mutates and returns it). The allowed hosts are only ever
 * extended: whatever the owner put there stays, the loopback names are always present, and the extra
 * hosts from OAA_ALLOWED_HOSTS are added once.
 */
export function applySettings(raw, settings) {
  raw.host = settings.host;
  raw.port = settings.port;
  const hosts = new Set([
    ...DEFAULT_ALLOWED_HOSTS,
    ...(raw.allowedHosts ?? []),
    ...settings.extraHosts,
  ]);
  raw.allowedHosts = [...hosts];
  return raw;
}

async function waitHealthy(port, child) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** Enables and publishes the sample agent and makes sure a working caller key file exists. */
async function bootstrap({ lib, dataDir, port }) {
  const url = `http://127.0.0.1:${port}`;
  const admin = new lib.GatewayClient(
    url,
    fs.readFileSync(path.join(dataDir, 'admin.token'), 'utf8').trim(),
  );
  await admin.request(
    'POST',
    `/v1/local/backends/${encodeURIComponent(`adapter/${lib.SAMPLE_ADAPTER}`)}`,
    {
      enabled: true,
    },
  );
  await admin.request('POST', '/v1/agents/publish', lib.makeBundle(lib.sampleDefinition()));
  const keyFile = path.join(dataDir, 'keys', `${KEY_NAME}.key`);
  let usable = false;
  try {
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    const res = await fetch(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    usable = res.ok && (await res.json()).data?.some((m) => m.id === lib.SAMPLE_AGENT);
  } catch {
    usable = false;
  }
  if (!usable) {
    fs.rmSync(keyFile, { force: true });
    await lib.createCallerKey(admin, {
      name: KEY_NAME,
      agents: ['*'],
      out: keyFile,
      approve: true,
    });
  }
  return keyFile;
}

function printSummary({ dataDir, port, keyFile }) {
  const adminFile = path.join(dataDir, 'admin.token');
  const base = `http://127.0.0.1:${port}`;
  say(
    `网关已就绪（容器内 ${base}；从宿主机访问需要映射端口，见 docker-compose.yml）`,
    `Gateway ready (${base} inside the container; publish the port to reach it from the host, see docker-compose.yml)`,
  );
  say(
    `管理员密钥文件：${adminFile}（不打印密钥本身）`,
    `Admin key file: ${adminFile} (the key itself is not printed)`,
  );
  say(`调用方密钥文件：${keyFile}`, `Caller key file: ${keyFile}`);
  say(
    '离线示例智能体 agent/sample 已发布（不调用任何模型）',
    'The offline sample agent agent/sample is published (it calls no model)',
  );
  say(
    '读取密钥：docker compose exec oaa cat ' + adminFile,
    'Read the admin key: docker compose exec oaa cat ' + adminFile,
  );
  const payload = JSON.stringify({
    model: 'agent/sample',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  console.log(
    `[oaa] curl http://127.0.0.1:8787/v1/chat/completions -H "Authorization: Bearer $(docker compose exec -T oaa cat ${keyFile})" -H 'Content-Type: application/json' -d '${payload}'`,
  );
}

export async function main(
  argv,
  env = process.env,
  appDir = env.OAA_APP_DIR || path.dirname(fileURLToPath(import.meta.url)),
) {
  const cli = path.join(appDir, 'dist', 'src', 'cli.js');
  if (argv.length > 0 && argv[0] !== 'serve') {
    // `docker run IMAGE doctor` and friends: hand over to the CLI untouched.
    const child = spawn(process.execPath, [cli, ...argv], { stdio: 'inherit' });
    return new Promise((resolve) =>
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))),
    );
  }
  const settings = settingsFromEnv(env);
  const { dataDir, port } = settings;
  const lib = {
    ...(await import(pathToFileURL(path.join(appDir, 'dist/src/client/quickstart.js')).href)),
    ...(await import(pathToFileURL(path.join(appDir, 'dist/src/client/client.js')).href)),
    ...(await import(pathToFileURL(path.join(appDir, 'dist/src/client/onboarding.js')).href)),
    ...(await import(pathToFileURL(path.join(appDir, 'dist/src/lang/bundle.js')).href)),
  };
  const { initialize } = await import(
    pathToFileURL(path.join(appDir, 'dist/src/config/config.js')).href
  );

  const configFile = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configFile)) {
    await initialize(dataDir);
    say(`已初始化数据目录：${dataDir}`, `Initialized the data directory: ${dataDir}`);
  } else {
    say(`沿用已有数据目录：${dataDir}`, `Using the existing data directory: ${dataDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const before = JSON.stringify(raw);
  lib.syncConfig(
    raw,
    { node: process.execPath, script: lib.sampleAgentPath(cli) },
    port,
    env.PATH ?? '',
  );
  applySettings(raw, settings);
  if (JSON.stringify(raw) !== before) {
    fs.writeFileSync(configFile, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  }

  const server = spawn(process.execPath, [cli, 'serve', '--config', configFile], {
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (server.exitCode === null) server.kill(signal);
    });
  const exited = new Promise((resolve) =>
    server.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))),
  );

  if (await waitHealthy(port, server)) {
    try {
      const keyFile = await bootstrap({ lib, dataDir, port });
      printSummary({ dataDir, port, keyFile });
    } catch (error) {
      console.error(
        `[oaa] 示例智能体或密钥准备失败（网关仍在运行）/ Preparing the sample agent or key failed (the gateway keeps running): ${error.message}`,
      );
    }
  } else if (server.exitCode === null) {
    console.error('[oaa] 60 秒内网关没有就绪 / The gateway was not ready within 60 seconds');
  }
  return exited;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[oaa] ${error.message}`);
      process.exit(1);
    },
  );
}
