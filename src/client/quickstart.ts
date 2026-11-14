/**
 * `oaa quickstart`：一条命令从零走到第一次真实的网关调用。
 * 初始化（已有则跳过）→ 后台启动网关（已在运行则复用）→ 发布离线示例智能体 agent/sample →
 * 生成调用方密钥（私有文件，已有且有效则复用）→ 真调一次 → 打印 Base URL、model、curl、SDK 代码与下一步。
 * 重复运行不重复创建；只改本工具自己的配置项（localWorker.adapters 里的示例智能体与 port）。
 */
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { initialize, loadConfig, type GatewayConfig } from '../config/config.js';
import { agentSchema } from '../core/contracts.js';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { Fault, executableExists } from '../core/util.js';
import { whichSync } from '../core/which.js';
import { makeBundle } from '../lang/bundle.js';
import { GatewayClient } from './client.js';
import {
  createCallerKey,
  gatewayUrl,
  healthPid,
  startDetached,
  stopDetachedGateway,
} from './onboarding.js';

export const SAMPLE_AGENT = 'agent/sample';
export const SAMPLE_ADAPTER = 'oaa-sample';
const KEY_NAME = 'quickstart';
const NATIVE_BINARIES = { codex: 'codex', claude: 'claude', antigravity: 'agy' } as const;

export type QuickstartOptions = {
  dir: string;
  port?: string;
  cliPath: string;
  locale?: Locale;
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
};

/** 示例智能体脚本的位置：源码与安装包里都在 dist/src 的上两级的 examples/ 下。 */
export function sampleAgentPath(cliPath: string): string {
  return path.resolve(path.dirname(cliPath), '..', '..', 'examples', 'sample-agent.mjs');
}

/** 提示里怎么写 oaa：`npm run oaa --`（源码目录）、安装包里启动器的绝对路径，否则 `oaa`。 */
export function commandPrefix(cliPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.npm_lifecycle_event === 'oaa') return 'npm run oaa --';
  const launcher = path.resolve(path.dirname(cliPath), '..', '..', '..', 'oaa');
  return existsSync(launcher) ? `"${launcher}"` : 'oaa';
}

type RawConfig = {
  port?: number;
  host?: string;
  keys?: { tokenFile?: string; scopes?: string[] }[];
  localWorker?: {
    adapters?: Record<string, unknown>;
    native?: Record<string, { executable: string; enabled: boolean; args?: string[] }>;
  };
};

/**
 * 把示例智能体（以及 PATH 上新装的 codex / claude / agy，记为停用）写进配置；返回是否改了文件。
 * 端口参数也在这里落盘。不改任何其它配置项。
 */
export function syncConfig(
  raw: RawConfig,
  sample: { node: string; script: string },
  port: number | undefined,
  pathEnv: string,
): boolean {
  const before = JSON.stringify(raw);
  if (port !== undefined) raw.port = port;
  const worker = (raw.localWorker ??= {});
  const adapters = (worker.adapters ??= {});
  adapters[SAMPLE_ADAPTER] = {
    transport: 'acp',
    command: sample.node,
    args: [sample.script],
    enabled: true,
  };
  const native = (worker.native ??= {});
  for (const [engine, binary] of Object.entries(NATIVE_BINARIES)) {
    if (native[engine]) continue;
    const found = findOnPath(binary, pathEnv);
    if (found) native[engine] = { executable: found, enabled: false, args: [] };
  }
  return JSON.stringify(raw) !== before;
}

function findOnPath(binary: string, pathEnv: string): string | undefined {
  return whichSync(binary, pathEnv);
}

/** 端口上有没有别的程序在监听（只发起连接，不监听）。 */
export function portBusy(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function readPid(dataDir: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(path.join(dataDir, 'server.pid'), 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** 确保由本数据目录管理的网关在跑：复用、必要时重启以加载新配置，或新起一个。 */
async function ensureGateway(
  file: string,
  config: GatewayConfig,
  changed: boolean,
  cliPath: string,
): Promise<{ url: string; state: 'reused' | 'restarted' | 'started'; pid: number }> {
  const url = gatewayUrl(config);
  const ours = await readPid(config.dataDir);
  const running = await healthPid(url);
  if (running !== undefined && running === ours) {
    if (!changed) return { url, state: 'reused', pid: running };
    await stopDetachedGateway(config.dataDir, url);
    const started = await startDetached(cliPath, file, config);
    return { ...started, state: 'restarted' };
  }
  if (running !== undefined || (await portBusy(config.host, config.port)))
    throw new Fault(
      'port_in_use',
      bi(
        `端口 ${config.port} 已被${running !== undefined ? `另一个 Open Agent API 网关（pid ${running}，可能是桌面应用）` : '其它程序'}占用，quickstart 不会去动它。换一个端口重试：oaa quickstart --port <端口>（例如 18787），会写进 ${file}。`,
        `Port ${config.port} is already used by ${running !== undefined ? `another Open Agent API gateway (pid ${running}, perhaps the desktop app)` : 'another program'}; quickstart leaves it alone. Retry on another port: oaa quickstart --port <port> (for example 18787); it is saved in ${file}.`,
      ),
      409,
    );
  const started = await startDetached(cliPath, file, config);
  return { ...started, state: 'started' };
}

/** 已有的 quickstart 密钥还能不能用（能列出示例智能体）。 */
async function keyStillValid(url: string, keyFile: string): Promise<boolean> {
  let key: string;
  try {
    key = (await readFile(keyFile, 'utf8')).trim();
  } catch {
    return false;
  }
  try {
    const r = await fetch(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return false;
    const body = (await r.json()) as { data?: { id: string }[] };
    return !!body.data?.some((m) => m.id === SAMPLE_AGENT);
  } catch {
    return false;
  }
}

export function sampleDefinition() {
  return agentSchema.parse({
    id: SAMPLE_AGENT,
    description:
      'Offline sample agent: calls no model, uses no network; answers by fixed rules. 离线示例智能体：不调用任何模型。',
    engine: `adapter/${SAMPLE_ADAPTER}`,
    provider: 'native',
    model: 'default',
    instructions: '',
    tools: [],
    allowGraph: false,
    routes: [{ id: 'default', provider: 'native', model: 'default', priority: 0 }],
  });
}

export async function quickstart(options: QuickstartOptions): Promise<void> {
  const locale = options.locale ?? processLocale();
  const env = options.env ?? process.env;
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  const out = options.out ?? ((line: string) => process.stdout.write(line + '\n'));
  const dirArgs =
    path.resolve(options.dir) === path.resolve('.oaa')
      ? ''
      : ` --dir '${path.resolve(options.dir)}'`;
  const prefix = commandPrefix(options.cliPath, env);
  const port = options.port === undefined ? undefined : Number(options.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))
    throw new Fault('arguments', '--port must be an integer between 1 and 65535.');

  const dir = path.resolve(options.dir);
  const file = path.join(dir, 'config.json');
  const fresh = !existsSync(file);
  if (fresh) await initialize(dir);
  out(
    fresh
      ? t(`1/5 已初始化：${file}`, `1/5 Initialized: ${file}`)
      : t(`1/5 已初始化过，沿用：${file}`, `1/5 Already initialized; using ${file}`),
  );

  const script = sampleAgentPath(options.cliPath);
  try {
    await access(script, constants.R_OK);
  } catch {
    throw new Fault('sample_agent_missing', `The sample agent ${script} is missing.`, 500);
  }
  const raw = JSON.parse(await readFile(file, 'utf8')) as RawConfig;
  const changed = syncConfig(raw, { node: process.execPath, script }, port, env.PATH ?? '');
  if (changed) await writeFile(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  const config = await loadConfig(file);

  const gateway = await ensureGateway(file, config, changed, options.cliPath);
  out(
    {
      reused: t(
        `2/5 网关已在运行，复用：${gateway.url}（pid ${gateway.pid}）`,
        `2/5 Gateway already running; reusing ${gateway.url} (pid ${gateway.pid})`,
      ),
      restarted: t(
        `2/5 配置有更新，已重启网关：${gateway.url}（pid ${gateway.pid}）`,
        `2/5 Configuration changed; restarted the gateway: ${gateway.url} (pid ${gateway.pid})`,
      ),
      started: t(
        `2/5 网关已在后台启动：${gateway.url}（pid ${gateway.pid}，只监听 ${config.host}）`,
        `2/5 Gateway started in the background: ${gateway.url} (pid ${gateway.pid}, listening on ${config.host} only)`,
      ),
    }[gateway.state],
  );

  const adminFile = config.keys.find((k) => k.scopes.includes('admin') && k.tokenFile)?.tokenFile;
  if (!adminFile)
    throw new Fault('token_required', 'No admin key with a tokenFile is configured.', 400);
  const admin = new GatewayClient(gateway.url, (await readFile(adminFile, 'utf8')).trim());
  // 控制台里停用过的开关记在数据库里、优先于配置文件：quickstart 明确把示例智能体打开。
  await admin.request(
    'POST',
    `/v1/local/backends/${encodeURIComponent(`adapter/${SAMPLE_ADAPTER}`)}`,
    {
      enabled: true,
    },
  );
  const published = await admin.request<{ version: string }>(
    'POST',
    '/v1/agents/publish',
    makeBundle(sampleDefinition()),
  );
  out(
    t(
      `3/5 已发布离线示例智能体 ${SAMPLE_AGENT}（版本 ${published.version.slice(0, 12)}；不调用任何模型）`,
      `3/5 Published the offline sample agent ${SAMPLE_AGENT} (version ${published.version.slice(0, 12)}; calls no model)`,
    ),
  );

  const keyFile = path.join(dir, 'keys', `${KEY_NAME}.key`);
  const reuse = await keyStillValid(gateway.url, keyFile);
  if (!reuse) {
    await rm(keyFile, { force: true });
    await createCallerKey(admin, { name: KEY_NAME, agents: ['*'], out: keyFile, approve: true });
  }
  out(
    reuse
      ? t(
          `4/5 调用方密钥已存在且有效，沿用：${keyFile}`,
          `4/5 Caller key exists and works; reusing ${keyFile}`,
        )
      : t(
          `4/5 已生成调用方密钥（权限 0600，未打印）：${keyFile}`,
          `4/5 Created a caller key (mode 0600, not printed): ${keyFile}`,
        ),
  );

  const baseUrl = `${gateway.url}/v1`;
  const question = t('你好，请演示一下你会做什么', 'Hello, show me what you can do');
  const key = (await readFile(keyFile, 'utf8')).trim();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: SAMPLE_AGENT, messages: [{ role: 'user', content: question }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { code?: string; message?: string };
  };
  if (!response.ok)
    throw new Fault(
      body.error?.code ?? 'gateway_error',
      body.error?.message ?? `HTTP ${response.status}`,
      response.status,
    );
  out(
    t(
      '5/5 第一次调用成功，示例智能体的回答：',
      '5/5 First call succeeded. The sample agent answered:',
    ),
  );
  out(`    ${body.choices?.[0]?.message?.content ?? ''}`);
  out('');
  for (const line of usageLines({
    baseUrl,
    keyFile,
    adminFile,
    url: gateway.url,
    prefix,
    dirArgs,
    t,
    question,
  }))
    out(line);
  out('');
  for (const line of nextSteps(config, {
    url: gateway.url,
    adminFile,
    prefix,
    dirArgs,
    t,
    cliPath: options.cliPath,
  }))
    out(line);
}

type Say = (zh: string, en: string) => string;

export function usageLines(p: {
  baseUrl: string;
  keyFile: string;
  adminFile: string;
  url: string;
  prefix: string;
  dirArgs: string;
  question: string;
  t: Say;
}): string[] {
  const { t } = p;
  const payload = JSON.stringify({
    model: SAMPLE_AGENT,
    messages: [{ role: 'user', content: p.question }],
  });
  return [
    t('调用方需要的三样东西：', 'What a caller needs:'),
    `  Base URL : ${p.baseUrl}`,
    `  model    : ${SAMPLE_AGENT}`,
    t(`  API Key  : 在文件 ${p.keyFile} 里`, `  API key  : in the file ${p.keyFile}`),
    '',
    t('直接粘贴运行：', 'Paste and run:'),
    `  curl ${p.baseUrl}/chat/completions -H "Authorization: Bearer $(cat '${p.keyFile}')" -H 'Content-Type: application/json' -d '${payload}'`,
    '',
    t(
      '官方 OpenAI SDK（Python，pip install openai）：',
      'Official OpenAI SDK (Python, pip install openai):',
    ),
    '  from openai import OpenAI',
    `  client = OpenAI(base_url="${p.baseUrl}", api_key=open("${p.keyFile}").read().strip())`,
    `  r = client.chat.completions.create(model="${SAMPLE_AGENT}", messages=[{"role": "user", "content": "${p.question}"}])`,
    '  print(r.choices[0].message.content)',
    '',
    t(
      `控制台：${p.url}（连接设置里选择管理员密钥文件 ${p.adminFile}，不要分享）。在任务里写上「审批」可以看到任务停下来等你批准。`,
      `Console: ${p.url} (select the admin key file ${p.adminFile} in the connection settings; keep it private). Put "approve" in a task to see it stop for your approval.`,
    ),
    t(`停止网关：${p.prefix} stop${p.dirArgs}`, `Stop the gateway: ${p.prefix} stop${p.dirArgs}`),
  ];
}

export function nextSteps(
  config: Pick<GatewayConfig, 'localWorker'>,
  p: { url: string; adminFile: string; prefix: string; dirArgs: string; cliPath: string; t: Say },
): string[] {
  const { t } = p;
  const lines = [t('接上你自己的智能体：', 'Connect your own agent:')];
  const installed = Object.entries(config.localWorker?.native ?? {}).filter(
    ([engine, b]) => engine in NATIVE_BINARIES && b && executableExists(b.executable),
  );
  for (const [engine, backend] of installed)
    lines.push(
      t(
        `  ${p.prefix} connect ${NATIVE_BINARIES[engine as keyof typeof NATIVE_BINARIES]}${p.dirArgs}    # ${backend!.executable}`,
        `  ${p.prefix} connect ${NATIVE_BINARIES[engine as keyof typeof NATIVE_BINARIES]}${p.dirArgs}    # ${backend!.executable}`,
      ),
    );
  if (installed.length)
    lines.push(
      t(
        '  connect 会启用并发布它、确认上面的密钥能调用它，并打印调用命令；它不会替你调用这个智能体（第一次调用会用它自己的登录与额度）。',
        '  connect enables and publishes it, checks that the key above can call it, and prints the call; it does not call the agent for you (the first call uses its own sign-in and quota).',
      ),
    );
  if (!installed.length)
    lines.push(
      t(
        '  本机没有找到 codex、claude 或 agy。装好并登录其中任何一个后重新运行 quickstart，这里会给出对应命令。',
        '  No codex, claude, or agy was found on this machine. Install and sign in to one of them, then rerun quickstart to get its commands here.',
      ),
    );
  lines.push(
    t(
      '  或者给内置智能体接一个模型，发布为 agent/assistant（本地模型不需要密钥）：',
      '  Or give the built-in agent a model, published as agent/assistant (local models need no key):',
    ),
    `    ${p.prefix} connect ollama${p.dirArgs}`,
    `    ${p.prefix} connect deepseek --key-file ~/.config/deepseek.key${p.dirArgs}`,
    t(
      `    ${p.prefix} connect${p.dirArgs}    # 列出全部模型预设`,
      `    ${p.prefix} connect${p.dirArgs}    # lists every model preset`,
    ),
  );
  lines.push(
    t(
      `  同一把密钥可以调用你之后发布的智能体，把 model 换成它的名字即可。${p.prefix} doctor 列出本机找到的智能体。`,
      `  The same key can call agents you publish later; just change model to its name. ${p.prefix} doctor lists the agents found on this machine.`,
    ),
  );
  return lines;
}
