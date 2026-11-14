/**
 * `oaa connect <model preset>`: give the built-in kernel a real model in one command.
 * Check arguments → (local services) probe the loopback endpoint → write the provider into the
 * configuration (skip when identical, refuse when different) → make the gateway use it (restart
 * only a gateway this data directory started) → publish agent/assistant → check the caller key →
 * print the model and a curl line. It never calls a paid model; `--test` sends one minimal request
 * through the gateway, and only for loopback endpoints.
 */
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, providerSchema, type GatewayConfig } from '../config/config.js';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { Fault } from '../core/util.js';
import {
  findPreset,
  presetProviderEntry,
  type ProviderPreset,
} from '../providers/provider-presets.js';
import { isLoopbackUrl, probeProvider } from '../providers/provider-status.js';
import { GatewayClient } from './client.js';
import { callLines, ensureCallerKey } from './connect.js';
import { gatewayUrl, healthPid, startDetached, stopDetachedGateway } from './onboarding.js';

export const PLACEHOLDER = 'default/"configure-your-model"';
export const DEFAULT_AGENT = 'agent/assistant';

export type ModelConnectOptions = {
  preset: string;
  dir: string;
  cliPath: string;
  prefix: string;
  model?: string;
  keyEnv?: string;
  keyFile?: string;
  baseUrl?: string;
  agent?: string;
  name?: string;
  definition?: string;
  test?: boolean;
  locale?: Locale;
  out?: (line: string) => void;
  /** Restart / start the gateway (injected by tests). */
  gateway?: GatewayControl;
};

export type GatewayControl = {
  /** Make the gateway at `config` serve the current file; returns its URL and what was done. */
  ensure(file: string, config: GatewayConfig, changed: boolean): Promise<GatewayState>;
};
export type GatewayState = { url: string; state: 'reused' | 'restarted' | 'started' | 'foreign' };

type Say = (zh: string, en: string) => string;
type RawConfig = { localWorker?: { providers?: Record<string, Record<string, unknown>> } };

/** Restart only a gateway whose pid file lives in this data directory; never touch another. */
export function detachedGateway(cliPath: string): GatewayControl {
  return {
    async ensure(file, config, changed) {
      const url = gatewayUrl(config);
      const running = await healthPid(url);
      let ours: number | undefined;
      try {
        ours = Number((await readFile(path.join(config.dataDir, 'server.pid'), 'utf8')).trim());
      } catch {
        ours = undefined;
      }
      if (running === undefined) {
        await startDetached(cliPath, file, config);
        return { url, state: 'started' };
      }
      if (running !== ours) return { url, state: 'foreign' };
      if (!changed) return { url, state: 'reused' };
      await stopDetachedGateway(config.dataDir, url);
      await startDetached(cliPath, file, config);
      return { url, state: 'restarted' };
    },
  };
}

/** Only http/https, no credentials; anything off the loopback interface must use https. */
export function checkBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Fault(
      'arguments',
      bi(`--base-url 不是有效地址：${raw}`, `--base-url is not a valid URL: ${raw}`),
    );
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Fault(
      'insecure_endpoint',
      bi(
        '--base-url 只允许 http/https，不能带用户名密码、查询串或 #。',
        '--base-url must be http or https, without credentials, a query string or a fragment.',
      ),
    );
  if (u.protocol === 'http:' && !isLoopbackUrl(raw))
    throw new Fault(
      'insecure_endpoint',
      bi(
        `非本机回环地址必须用 https：${raw}。网关的模型驱动对远程端点一律要求 TLS（不提供放宽开关）；局域网里的服务请放在 https 反向代理后面，或在那台机器上用 127.0.0.1 访问。`,
        `Endpoints off the loopback interface must use https: ${raw}. The gateway's model drivers always require TLS for remote endpoints (there is no switch to relax this); put a LAN service behind an https reverse proxy, or reach it as 127.0.0.1 on that machine.`,
      ),
    );
  return u.toString().replace(/\/+$/, '');
}

/** A private, regular, single-line key file. Its content is checked, never printed or stored. */
export async function checkKeyFile(file: string): Promise<string> {
  const abs = path.resolve(file);
  const fail = (zh: string, en: string): never => {
    throw new Fault('key_file_insecure', bi(`密钥文件 ${abs}：${zh}`, `Key file ${abs}: ${en}`));
  };
  const info = await lstat(abs).catch(() =>
    fail('不存在或无法访问。', 'does not exist or cannot be accessed.'),
  );
  if (!info.isFile())
    fail(
      '不是普通文件（不接受目录、符号链接或设备）。',
      'is not a regular file (directories, symbolic links and devices are refused).',
    );
  if (info.size === 0 || info.size > 8192)
    fail('为空或大于 8 KiB。', 'is empty or larger than 8 KiB.');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    fail(
      '同组或其他用户可以读写它。先运行 chmod 600 该文件。',
      `other users can access it. Run chmod 600 '${abs}' first.`,
    );
  const text = (await readFile(abs, 'utf8')).trim();
  if (!text || /\s/.test(text))
    fail('内容应当只有一行密钥。', 'should hold the key on a single line.');
  return abs;
}

function resolveTarget(o: ModelConnectOptions, t: Say) {
  const preset = findPreset(o.preset);
  if (!preset) throw new Fault('arguments', `Unknown model preset: ${o.preset}`);
  if (o.keyEnv && o.keyFile)
    throw new Fault(
      'arguments',
      bi('--key-env 与 --key-file 只能选一个。', 'Use either --key-env or --key-file, not both.'),
    );
  if (o.keyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(o.keyEnv))
    throw new Fault(
      'arguments',
      bi(
        '--key-env 只接受环境变量的名字（不是密钥本身）。',
        '--key-env takes the name of an environment variable, not the key itself.',
      ),
    );
  const name = o.name ?? preset.id;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
    throw new Fault(
      'arguments',
      bi(
        '--name 只能用小写字母、数字、_ 与 -。',
        '--name may only use lowercase letters, digits, _ and -.',
      ),
    );
  const agentId = o.agent ?? DEFAULT_AGENT;
  if (!/^agent\/[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(agentId))
    throw new Fault(
      'arguments',
      bi('--agent 形如 agent/assistant。', '--agent looks like agent/assistant.'),
    );
  if (!preset.baseUrl && !o.baseUrl)
    throw new Fault(
      'arguments',
      t(
        `${preset.id} 需要 --base-url，例如 --base-url https://example.com/v1`,
        `${preset.id} needs --base-url, for example --base-url https://example.com/v1`,
      ),
    );
  const baseUrl = o.baseUrl ? checkBaseUrl(o.baseUrl) : preset.baseUrl;
  return { preset, name, agentId, baseUrl };
}

/** Same settings (ignoring fields filled in by the schema) means "already connected". */
function sameProvider(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const norm = (x: Record<string, unknown>) => JSON.stringify(providerSchema.parse(x));
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

async function pickModel(
  o: ModelConnectOptions,
  preset: ProviderPreset,
  baseUrl: string,
  out: (l: string) => void,
  t: Say,
) {
  if (!isLoopbackUrl(baseUrl)) {
    const model = o.model ?? preset.model;
    if (!model)
      throw new Fault(
        'arguments',
        t(
          `${preset.label} 的模型名经常变化，请用 --model 指定一个（见 ${preset.docs}）。`,
          `${preset.label} model names change often; name one with --model (see ${preset.docs}).`,
        ),
      );
    return model;
  }
  const probe = await probeProvider(
    providerSchema.parse({ kind: preset.kind, baseUrl, apiKeyEnv: '', noApiKey: true }),
  );
  if (!probe.reachable || probe.status >= 400)
    throw new Fault(
      'provider_unreachable',
      bi(
        `${baseUrl} 上没有 ${preset.label} 在响应（${probe.reachable ? `HTTP ${probe.status}` : probe.error}）。它可能没在运行，或用的不是缺省端口：先启动它，或用 --base-url http://127.0.0.1:<端口>/v1 指定。`,
        `${preset.label} is not answering at ${baseUrl} (${probe.reachable ? `HTTP ${probe.status}` : probe.error}). It may not be running, or it uses another port: start it, or pass --base-url http://127.0.0.1:<port>/v1.`,
      ),
      503,
    );
  const models = probe.models ?? [];
  out(
    t(
      `1/5 已探测到 ${preset.label}：${baseUrl}（${models.length} 个模型${models.length ? `：${models.slice(0, 8).join('、')}` : ''}）`,
      `1/5 Found ${preset.label} at ${baseUrl} (${models.length} model${models.length === 1 ? '' : 's'}${models.length ? `: ${models.slice(0, 8).join(', ')}` : ''})`,
    ),
  );
  if (o.model) {
    if (models.length && !models.includes(o.model))
      throw new Fault(
        'arguments',
        t(
          `${preset.label} 上没有模型 ${o.model}。可选：${models.join('、')}`,
          `${preset.label} has no model ${o.model}. Available: ${models.join(', ')}`,
        ),
      );
    return o.model;
  }
  if (models.length === 1) return models[0]!;
  throw new Fault(
    'arguments',
    models.length
      ? t(
          `有多个模型，用 --model 选一个：${models.join('、')}`,
          `Several models are available; choose one with --model: ${models.join(', ')}`,
        )
      : t(
          `${preset.label} 上还没有模型。先下载一个（例如 ollama pull <模型>），再重试。`,
          `${preset.label} has no models yet. Download one first (for example ollama pull <model>), then retry.`,
        ),
  );
}

/** The agent source: the bundled template (or --definition) with the route pointed at the provider. */
export async function assistantSource(
  cliPath: string,
  o: { definition?: string; agent: string; provider: string; model: string },
) {
  const file = o.definition
    ? path.resolve(o.definition)
    : path.resolve(path.dirname(cliPath), '..', '..', 'examples', 'assistant.oaa');
  let source = await readFile(file, 'utf8');
  source = source.split(PLACEHOLDER).join(`${o.provider}/${JSON.stringify(o.model)}`);
  if (!o.definition) source = source.replace(`agent "${DEFAULT_AGENT}"`, `agent "${o.agent}"`);
  return source;
}

export async function connectModel(o: ModelConnectOptions): Promise<void> {
  const locale = o.locale ?? processLocale();
  const t: Say = (zh, en) => pick(bi(zh, en), locale);
  const out = o.out ?? ((line: string) => process.stdout.write(line + '\n'));
  const { preset, name, agentId, baseUrl } = resolveTarget(o, t);
  const keyFile = o.keyFile ? await checkKeyFile(o.keyFile) : undefined;
  const file = path.join(path.resolve(o.dir), 'config.json');
  const raw = JSON.parse(
    await readFile(file, 'utf8').catch(() => {
      throw new Fault(
        'not_running',
        bi(`没有 ${file}。先运行 oaa quickstart。`, `No ${file}. Run oaa quickstart first.`),
        404,
      );
    }),
  ) as RawConfig;

  // A conflicting provider of the same name is refused before anything is probed or written.
  const entry = presetProviderEntry(preset, { baseUrl, keyEnv: o.keyEnv, keyFile });
  if (preset.id === 'openai-compatible' && (o.keyEnv || keyFile)) delete entry.noApiKey;
  const existing = raw.localWorker?.providers?.[name];
  if (existing && !sameProvider(existing, entry))
    throw new Fault(
      'provider_conflict',
      bi(
        `配置里已有提供方 ${name}，但设置不同（${String(existing.baseUrl)}）。connect 不会覆盖：用 --name 换个名字，或手工修改 ${file}。`,
        `Provider ${name} already exists with different settings (${String(existing.baseUrl)}). connect will not overwrite it: pick another name with --name, or edit ${file} by hand.`,
      ),
      409,
    );

  // 1. model
  const model = await pickModel(o, preset, baseUrl, out, t);
  if (!isLoopbackUrl(baseUrl))
    out(
      t(
        `1/5 ${preset.label}：${baseUrl}，模型 ${model}`,
        `1/5 ${preset.label}: ${baseUrl}, model ${model}`,
      ),
    );

  // 2. provider entry (a key reference only)
  const worker = (raw.localWorker ??= {});
  const providers = (worker.providers ??= {});
  let changed = false;
  if (existing)
    out(
      t(
        `2/5 提供方 ${name} 已在配置里，跳过`,
        `2/5 Provider ${name} is already configured; skipped`,
      ),
    );
  else {
    providers[name] = entry;
    await writeFile(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
    changed = true;
    out(
      t(
        `2/5 已把提供方 ${name} 写进 ${file}（只存密钥的引用）`,
        `2/5 Wrote provider ${name} to ${file} (a key reference only)`,
      ),
    );
  }
  const keyLine = keyFile
    ? t(
        `    密钥：网关每次调用时读取文件 ${keyFile}（内容不回显、不写进配置）`,
        `    Key: the gateway reads ${keyFile} on each call (never printed, never copied into the configuration)`,
      )
    : entry.noApiKey
      ? t('    密钥：不需要', '    Key: none needed')
      : t(
          `    密钥：环境变量 ${String(entry.apiKeyEnv)}。网关进程启动时必须能读到它：在启动网关的那个终端里 export，之后由 connect 或 oaa serve 启动的网关才会带上它；桌面应用或别人启动的网关看不到你这个终端的变量。`,
          `    Key: environment variable ${String(entry.apiKeyEnv)}. The gateway process must have it when it starts: export it in the terminal that starts the gateway; only a gateway started from there (by connect or oaa serve) inherits it. The desktop app, or a gateway someone else started, cannot see this terminal's variables.`,
        );
  out(keyLine);
  if (!keyFile && !entry.noApiKey && !process.env[String(entry.apiKeyEnv)])
    out(
      t(
        `    注意：当前终端没有设置 ${String(entry.apiKeyEnv)}。`,
        `    Note: ${String(entry.apiKeyEnv)} is not set in this terminal.`,
      ),
    );

  // 3. gateway
  const config = await loadConfig(file);
  const gateway = await (o.gateway ?? detachedGateway(o.cliPath)).ensure(file, config, changed);
  out(
    {
      reused: t(
        `3/5 网关已在运行且已是最新配置：${gateway.url}`,
        `3/5 Gateway already running with this configuration: ${gateway.url}`,
      ),
      restarted: t(
        `3/5 已重启本数据目录启动的网关以加载新提供方：${gateway.url}`,
        `3/5 Restarted the gateway this data directory started, to load the new provider: ${gateway.url}`,
      ),
      started: t(
        `3/5 网关已在后台启动：${gateway.url}`,
        `3/5 Gateway started in the background: ${gateway.url}`,
      ),
      foreign: t(
        `3/5 ${gateway.url} 上的网关不是由这个数据目录启动的（可能是桌面应用），connect 不会去动它。${changed ? '新提供方要等你自己重启它之后才生效。' : ''}`,
        `3/5 The gateway at ${gateway.url} was not started from this data directory (perhaps the desktop app); connect leaves it alone.${changed ? ' The new provider takes effect after you restart it yourself.' : ''}`,
      ),
    }[gateway.state],
  );

  // 4. publish
  const adminFile = config.keys.find((k) => k.scopes.includes('admin') && k.tokenFile)?.tokenFile;
  if (!adminFile) throw new Fault('token_required', 'No admin key with a tokenFile is configured.');
  const admin = new GatewayClient(gateway.url, (await readFile(adminFile, 'utf8')).trim());
  const agents = await admin.request<{
    data: { id: string; engine?: string; routes?: { provider: string }[] }[];
  }>('GET', '/v1/agents');
  const current = agents.data.find((a) => a.id === agentId);
  const used = current?.routes?.[0]?.provider;
  if (current && (current.engine !== 'kernel' || used !== name))
    throw new Fault(
      'agent_conflict',
      bi(
        `${agentId} 已经发布为另一个${current.engine === 'kernel' ? `提供方（${used}）` : `引擎（${current.engine}）`}的智能体，connect 不会覆盖它。用 --agent 换个名字。`,
        `${agentId} is already published on another ${current.engine === 'kernel' ? `provider (${used})` : `engine (${current.engine})`}; connect will not overwrite it. Pick another name with --agent.`,
      ),
      409,
    );
  const source = await assistantSource(o.cliPath, {
    definition: o.definition,
    agent: agentId,
    provider: name,
    model,
  });
  const published = await admin.request<{ id: string; version: string }>(
    'POST',
    '/v1/agents/publish-oaa',
    { source },
  );
  out(
    t(
      `4/5 已发布 ${published.id}（${name}/${model}，版本 ${published.version.slice(0, 12)}）`,
      `4/5 Published ${published.id} (${name}/${model}, version ${published.version.slice(0, 12)})`,
    ),
  );

  // 5. caller key
  const keysDir = path.join(path.resolve(o.dir), 'keys');
  const callerKey = await ensureCallerKey(admin, {
    keysDir,
    agentId: published.id,
    short: published.id.slice(6),
    step: '5/5',
    t,
    out,
  });
  const base = `${gateway.url.replace(/\/+$/, '')}/v1`;
  for (const line of callLines(base, published.id, callerKey, t)) out(line);

  if (o.test && isLoopbackUrl(baseUrl)) {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${(await readFile(callerKey, 'utf8')).trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: published.id,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await r.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: { code?: string; message?: string };
    };
    if (!r.ok)
      throw new Fault(
        body.error?.code ?? 'gateway_error',
        body.error?.message ?? `HTTP ${r.status}`,
        r.status,
      );
    out(
      t(
        `测试调用成功（本地服务）：${body.choices?.[0]?.message?.content ?? ''}`,
        `Test call succeeded (local service): ${body.choices?.[0]?.message?.content ?? ''}`,
      ),
    );
  } else
    out(
      isLoopbackUrl(baseUrl)
        ? t(
            'connect 没有调用模型。加 --test 会经网关向这个本地服务发一次最小请求。',
            'connect did not call the model. Add --test to send one minimal request through the gateway to this local service.',
          )
        : t(
            `connect 没有调用模型：第一次调用会计入你在 ${preset.label} 的用量与费用。`,
            `connect did not call the model: the first call counts against your ${preset.label} usage and billing.`,
          ),
    );
}

export const isModelPreset = (name: string | undefined) => !!name && !!findPreset(name);
