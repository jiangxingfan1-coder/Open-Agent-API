/**
 * `oaa connect <名字>`：把本机已安装的一个智能体接到网关上，一步到位。
 * 检测是否安装 → 在本网关启用 → 发布为 agent/<名字>（已发布则跳过）→ 确认调用方密钥能调用它 →
 * 打印 model 与一条可粘贴的 curl。**不调用这个智能体**：第一次调用会用它自己的登录与额度。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { Fault, executableExists } from '../core/util.js';
import { whichSync } from '../core/which.js';
import { isNativeEngine } from '../config/agent-presets.js';
import type { GatewayClient } from './client.js';
import { createCallerKey } from './onboarding.js';

/** 常用别名：可执行文件名 → 引擎名。 */
const ALIASES: Record<string, string> = { agy: 'antigravity', 'claude-code': 'claude' };
const BINARIES: Record<string, string> = {
  codex: 'codex',
  claude: 'claude',
  antigravity: 'agy',
  dsh: 'dsh',
};

type Backend = {
  engine: string;
  enabled: boolean;
  evidence?: string;
  executable?: string;
  name?: string;
};
type Preset = { id: string; installed_executable?: string | null; configured?: boolean };

export type ConnectOptions = {
  name: string;
  keysDir: string;
  prefix: string;
  locale?: Locale;
  pathEnv?: string;
  out?: (line: string) => void;
};

/** 名字 → 引擎：内置的四个原生引擎（含别名）直接用；其它当作 ACP 适配器 `adapter/<名字>`。 */
export function engineFor(name: string): string {
  const key = name.trim().toLowerCase();
  const alias = ALIASES[key] ?? key;
  if (isNativeEngine(alias)) return alias;
  return key.startsWith('adapter/') ? key : `adapter/${key}`;
}

function onPath(binary: string, pathEnv: string): string | undefined {
  return whichSync(binary, pathEnv);
}

export async function connectAgent(client: GatewayClient, options: ConnectOptions): Promise<void> {
  const locale = options.locale ?? processLocale();
  const t = (zh: string, en: string) => pick(bi(zh, en), locale);
  const out = options.out ?? ((line: string) => process.stdout.write(line + '\n'));
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,80}$/.test(options.name))
    throw new Fault('arguments', 'connect needs an agent name such as codex, claude or agy.');
  const engine = engineFor(options.name);
  const short = engine.startsWith('adapter/') ? engine.slice('adapter/'.length) : engine;
  const agentId = `agent/${short}`;

  // 1. 检测
  const local = await client.request<{ data: Backend[]; presets?: Preset[] }>(
    'GET',
    '/v1/local/backends',
  );
  const backend = local.data.find((b) => b.engine === engine);
  if (isNativeEngine(engine)) {
    const binary = BINARIES[engine]!;
    if (!backend || backend.evidence === 'not_installed') {
      const found = onPath(binary, options.pathEnv ?? process.env.PATH ?? '');
      throw new Fault(
        'native_not_installed',
        found
          ? bi(
              `${binary} 已安装在 ${found}，但网关启动时还没有它。运行 ${options.prefix} quickstart 让网关重新识别（会把它记进配置并重启网关），再运行 ${options.prefix} connect ${options.name}。`,
              `${binary} is installed at ${found}, but the gateway started before it existed. Run ${options.prefix} quickstart so the gateway picks it up (it records it and restarts the gateway), then ${options.prefix} connect ${options.name} again.`,
            )
          : bi(
              `这台机器上没有找到 ${binary}。先按它的官方方式安装并登录，然后运行 ${options.prefix} quickstart 让网关识别它，再运行 ${options.prefix} connect ${options.name}。`,
              `${binary} was not found on this machine. Install it and sign in the official way, run ${options.prefix} quickstart so the gateway sees it, then ${options.prefix} connect ${options.name}.`,
            ),
      );
    }
    out(
      t(
        `1/4 已检测到 ${engine}：${backend.executable}`,
        `1/4 Found ${engine}: ${backend.executable}`,
      ),
    );
  } else if (backend) {
    if (backend.evidence === 'not_installed')
      throw new Fault(
        'backend_unavailable',
        bi(
          `适配器 ${engine} 已配置，但找不到它的程序（${backend.executable}）。先安装它。`,
          `Adapter ${engine} is configured, but its program (${backend.executable}) was not found. Install it first.`,
        ),
        409,
      );
    out(
      t(
        `1/4 已检测到 ${engine}：${backend.executable}`,
        `1/4 Found ${engine}: ${backend.executable}`,
      ),
    );
  } else {
    const preset = local.presets?.find((p) => p.id === short);
    if (!preset)
      throw new Fault(
        'backend_unavailable',
        bi(
          `不认识「${options.name}」：它既不是 codex、claude、agy、dsh，也不是已配置的适配器或内置的 ACP 预设。${options.prefix} doctor 列出本机找到的智能体。`,
          `Unknown agent "${options.name}": it is not codex, claude, agy, dsh, a configured adapter, or a built-in ACP preset. ${options.prefix} doctor lists the agents found on this machine.`,
        ),
        409,
      );
    out(t(`1/4 按 ACP 预设 ${short} 接入`, `1/4 Connecting through the ACP preset ${short}`));
  }

  // 2. 启用（只改本网关的记录，不动该智能体自己的配置）
  if (backend?.enabled) out(t('2/4 已启用，跳过', '2/4 Already enabled; skipped'));
  else {
    if (backend)
      await client.request('POST', `/v1/local/backends/${encodeURIComponent(engine)}`, {
        enabled: true,
      });
    else await client.request('POST', `/v1/local/presets/${encodeURIComponent(short)}/enable`, {});
    out(
      t(
        `2/4 已在本网关启用 ${engine}（只改本网关的记录，不改它自己的配置与登录）`,
        `2/4 Enabled ${engine} on this gateway (only this gateway's record; its own configuration and sign-in are untouched)`,
      ),
    );
  }

  // 3. 发布（已发布则跳过）
  const agents = await client.request<{ data: { id: string; engine?: string }[] }>(
    'GET',
    '/v1/agents',
  );
  const existing = agents.data.find((a) => a.id === agentId);
  if (existing && existing.engine === engine)
    out(t(`3/4 ${agentId} 已发布，跳过`, `3/4 ${agentId} is already published; skipped`));
  else {
    if (existing)
      throw new Fault(
        'agent_conflict',
        bi(
          `${agentId} 已经发布为另一个引擎（${existing.engine}），connect 不会覆盖它。`,
          `${agentId} is already published with another engine (${existing.engine}); connect will not overwrite it.`,
        ),
        409,
      );
    const published = await client.request<{ warning?: { message: string } }>(
      'POST',
      '/v1/agents/publish-native',
      { id: agentId, engine, models: ['default'] },
    );
    out(t(`3/4 已发布为 ${agentId}`, `3/4 Published as ${agentId}`));
    if (published.warning)
      out(t(`    警告：${published.warning.message}`, `    Warning: ${published.warning.message}`));
  }

  // 4. 调用方密钥：quickstart 的密钥能调用所有智能体时直接沿用，否则单独建一把只能调用它的
  const keyFile = await ensureCallerKey(client, {
    keysDir: options.keysDir,
    agentId,
    short,
    step: '4/4',
    t,
    out,
  });
  const baseUrl = `${client.url.replace(/\/+$/, '')}/v1`;
  for (const line of callLines(baseUrl, agentId, keyFile, t)) out(line);
  out(
    t(
      `connect 没有调用 ${engine}。第一次调用会使用它自己在这台机器上的登录状态与额度，并以你在这台机器上的权限运行；需要它做的操作要你批准时，任务会停在「待审批」。`,
      `connect did not call ${engine}. The first call uses its own sign-in and quota on this machine and runs with your permissions here; when it asks for approval, the task waits in "awaiting approval".`,
    ),
  );
}

/** The paste-and-run block printed at the end of every connect. */
export function callLines(
  baseUrl: string,
  agentId: string,
  keyFile: string,
  t: (zh: string, en: string) => string,
): string[] {
  const payload = JSON.stringify({
    model: agentId,
    messages: [{ role: 'user', content: t('你好', 'Hello') }],
  });
  return [
    '',
    `  model    : ${agentId}`,
    `  Base URL : ${baseUrl}`,
    t('  调用（粘贴运行）：', '  Call it (paste and run):'),
    `  curl ${baseUrl}/chat/completions -H "Authorization: Bearer $(cat '${keyFile}')" -H 'Content-Type: application/json' -d '${payload}'`,
    '',
  ];
}

/**
 * A caller key file that can call `agentId`: the quickstart key when it covers every agent,
 * otherwise a key limited to this agent (created once, reused afterwards).
 */
export async function ensureCallerKey(
  client: GatewayClient,
  p: {
    keysDir: string;
    agentId: string;
    short: string;
    step: string;
    t: (zh: string, en: string) => string;
    out: (line: string) => void;
  },
): Promise<string> {
  const { t, out, agentId, step } = p;
  const baseUrl = `${client.url.replace(/\/+$/, '')}/v1`;
  const safe = p.short.replace(/[^A-Za-z0-9_.-]/g, '_');
  let keyFile = path.join(p.keysDir, 'quickstart.key');
  if (await canCall(baseUrl, keyFile, agentId)) {
    out(
      t(
        `${step} 同一把密钥已可调用：${keyFile}`,
        `${step} The same key can already call it: ${keyFile}`,
      ),
    );
    return keyFile;
  }
  keyFile = path.join(p.keysDir, `${safe}.key`);
  if (await canCall(baseUrl, keyFile, agentId)) {
    out(t(`${step} 沿用密钥：${keyFile}`, `${step} Reusing key: ${keyFile}`));
    return keyFile;
  }
  const create = (file: string) =>
    createCallerKey(client, {
      name: `connect-${safe}`.slice(0, 64),
      agents: [agentId],
      out: file,
      approve: true,
    });
  await create(keyFile).catch(async (error: unknown) => {
    // 文件在但密钥已失效：换一个文件名重建，不覆盖原文件。
    if (!(error instanceof Fault) || error.code !== 'output_exists') throw error;
    keyFile = keyFile.replace(/\.key$/, `-${Date.now()}.key`);
    await create(keyFile);
  });
  out(
    t(
      `${step} 已生成只能调用 ${agentId} 的密钥：${keyFile}`,
      `${step} Created a key for ${agentId} only: ${keyFile}`,
    ),
  );
  return keyFile;
}

/** 这个密钥文件里的密钥能不能调用该智能体（出现在 GET /v1/models 里）。 */
async function canCall(baseUrl: string, keyFile: string, agentId: string): Promise<boolean> {
  let key: string;
  try {
    key = (await readFile(keyFile, 'utf8')).trim();
  } catch {
    return false;
  }
  try {
    const r = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return false;
    const body = (await r.json()) as { data?: { id: string }[] };
    return !!body.data?.some((m) => m.id === agentId);
  } catch {
    return false;
  }
}
