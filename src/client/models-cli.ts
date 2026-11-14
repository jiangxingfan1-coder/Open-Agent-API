/**
 * Command-line entry points for model providers: `oaa connect` (no target: what can be connected),
 * `oaa connect <model preset> …` and `oaa models [--check]`. cli.ts hands these over in one line.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type GatewayConfig } from '../config/config.js';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { whichSync } from '../core/which.js';
import { PROVIDER_PRESETS } from '../providers/provider-presets.js';
import {
  isLoopbackUrl,
  probeProvider,
  providerStatuses,
  type ProviderStatus,
} from '../providers/provider-status.js';
import { GatewayClient } from './client.js';
import { connectModel, isModelPreset } from './connect-model.js';
import { gatewayUrl, healthPid } from './onboarding.js';
import { commandPrefix } from './quickstart.js';

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
type Say = (zh: string, en: string) => string;
const str = (v: Values[string]) =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;

/** Handles the command when it is one of ours; returns false to let cli.ts continue. */
export async function runModelCommand(
  positionals: string[],
  values: Values,
  cliPath: string,
  options: { locale?: Locale; out?: (line: string) => void } = {},
): Promise<boolean> {
  const [command, target] = positionals;
  if (command !== 'models' && command !== 'connect') return false;
  if (command === 'connect' && target && !isModelPreset(target)) return false;
  const locale = options.locale ?? processLocale();
  const t: Say = (zh, en) => pick(bi(zh, en), locale);
  const out = options.out ?? ((line: string) => process.stdout.write(line + '\n'));
  const dir = path.resolve(str(values.dir) ?? '.oaa');
  const prefix = commandPrefix(cliPath) + (values.dir ? ` --dir '${dir}'` : '');
  if (command === 'connect' && !target) {
    for (const line of await connectTargets(prefix, t)) out(line);
    return true;
  }
  if (command === 'connect') {
    await connectModel({
      preset: target!,
      dir,
      cliPath,
      prefix,
      model: str(values.model),
      keyEnv: str(values['key-env']),
      keyFile: str(values['key-file']),
      baseUrl: str(values['base-url']),
      agent: str(values.agent),
      name: str(values.name),
      definition: str(values.definition),
      test: values.test === true,
      locale,
      out,
    });
    return true;
  }
  const config = await loadConfig(path.join(dir, 'config.json'));
  const report = await modelsReport(config, { check: values.check === true });
  if (values.json) out(JSON.stringify(report, null, 2));
  else for (const line of formatModels(report, t)) out(line);
  return true;
}

/** `oaa connect` with no target: detected external agents and the model presets. */
export async function connectTargets(
  prefix: string,
  t: Say,
  pathEnv = process.env.PATH ?? '',
  probe = true,
) {
  const lines = [t('可以接上的外部智能体（本机检测）：', 'External agents found on this machine:')];
  const found = Object.entries({ codex: 'codex', claude: 'claude', agy: 'agy', dsh: 'dsh' })
    .map(([name, bin]) => [name, whichSync(bin, pathEnv)] as const)
    .filter(([, at]) => at);
  for (const [name, at] of found) lines.push(`  ${prefix} connect ${name}    # ${at}`);
  if (!found.length)
    lines.push(
      t('  （没有找到 codex、claude、agy 或 dsh）', '  (no codex, claude, agy or dsh found)'),
    );
  lines.push(
    t(`  ${prefix} doctor 还会列出 ACP 智能体。`, `  ${prefix} doctor also lists ACP agents.`),
    '',
  );
  lines.push(
    t(
      '给内置智能体接一个模型（发布为 agent/assistant）：',
      'Give the built-in agent a model (published as agent/assistant):',
    ),
  );
  for (const p of PROVIDER_PRESETS) {
    let state = '';
    if (p.local && probe) {
      const probe = await probeProvider(
        {
          kind: p.kind,
          baseUrl: p.baseUrl,
          apiKeyEnv: '',
          noApiKey: true,
          byok: false,
          timeoutMs: 1000,
          maxTokensField: 'max_tokens',
        },
        process.env,
        500,
      );
      state =
        probe.reachable && probe.status < 400 ? t('  ← 本机正在运行', '  ← running here') : '';
    }
    const args = p.local
      ? ''
      : p.baseUrl
        ? ` --key-env ${p.keyEnv}${p.model ? '' : ' --model <model>'}`
        : ' --base-url https://… --model <model>';
    lines.push(`  ${prefix} connect ${p.id}${args}${state}`);
  }
  lines.push(
    '',
    t(
      '密钥只接受环境变量名（--key-env）或私有密钥文件（--key-file），不接受命令行里的密钥本身。详见 docs/zh-CN/models.md。',
      'Keys are accepted only as an environment variable name (--key-env) or a private key file (--key-file), never as the key itself on the command line. See docs/models.md.',
    ),
  );
  return lines;
}

export type ModelsReport = {
  gateway: { url: string; running: boolean; view: 'gateway' | 'local' };
  providers: (ProviderStatus & {
    reachable?: boolean | 'not_checked';
    http_status?: number;
    models?: string[];
    agents: string[];
  })[];
};

/** Providers with key state (from the running gateway when possible), reachability and users. */
export async function modelsReport(
  config: GatewayConfig,
  o: { check: boolean },
): Promise<ModelsReport> {
  const url = gatewayUrl(config);
  const running = (await healthPid(url)) !== undefined;
  let statuses = providerStatuses(config.localWorker);
  let view: 'gateway' | 'local' = 'local';
  let agents: { id: string; provider?: string; routes?: { provider: string }[] }[] = [];
  const adminFile = config.keys.find((k) => k.scopes.includes('admin') && k.tokenFile)?.tokenFile;
  if (running && adminFile) {
    try {
      const admin = new GatewayClient(url, (await readFile(adminFile, 'utf8')).trim());
      const local = await admin.request<{ providers?: ProviderStatus[] }>(
        'GET',
        '/v1/local/backends',
      );
      if (local.providers) {
        statuses = local.providers;
        view = 'gateway';
      }
      agents = (await admin.request<{ data: typeof agents }>('GET', '/v1/agents')).data;
    } catch {
      /* fall back to this process's own view */
    }
  }
  const providers: ModelsReport['providers'] = [];
  for (const s of statuses) {
    const cfg = config.localWorker?.providers[s.name];
    const users = agents
      .filter((a) => a.provider === s.name || a.routes?.some((r) => r.provider === s.name))
      .map((a) => a.id);
    const row: ModelsReport['providers'][number] = {
      ...s,
      agents: users,
      reachable: 'not_checked',
    };
    if (cfg && (isLoopbackUrl(cfg.baseUrl) || o.check)) {
      const probe = await probeProvider(cfg);
      row.reachable = probe.reachable;
      if (probe.reachable) {
        row.http_status = probe.status;
        if (probe.models) row.models = probe.models;
      }
    }
    providers.push(row);
  }
  return { gateway: { url, running, view }, providers };
}

export function formatModels(report: ModelsReport, t: Say): string[] {
  if (!report.providers.length)
    return [
      t(
        '还没有配置模型提供方。运行 oaa connect 查看可用的预设。',
        'No model providers are configured. Run oaa connect to see the presets.',
      ),
    ];
  const lines = [
    report.gateway.view === 'gateway'
      ? t(
          `密钥状态取自正在运行的网关（${report.gateway.url}）。`,
          `Key state as seen by the running gateway (${report.gateway.url}).`,
        )
      : t(
          '网关没在运行：密钥状态按当前终端的环境判断，网关进程的环境可能不同。',
          'The gateway is not running: key state is judged from this terminal, whose environment may differ from the gateway process.',
        ),
  ];
  for (const p of report.providers) {
    const key =
      p.key.kind === 'none'
        ? t('不需要密钥', 'no key needed')
        : `${p.key.kind === 'env' ? t('环境变量', 'env') : t('密钥文件', 'key file')} ${p.key.ref} ${p.key_ready ? t('可解析', 'resolves') : t('解析不了', 'does NOT resolve')}`;
    const reach =
      p.reachable === 'not_checked'
        ? t('未探测（公网端点需加 --check）', 'not probed (add --check for public endpoints)')
        : p.reachable
          ? `HTTP ${p.http_status}${p.models ? t(`，${p.models.length} 个模型`, `, ${p.models.length} models`) : ''}`
          : t('不可达', 'unreachable');
    lines.push(
      `  ${p.name}  ${p.kind}  ${p.base_url}`,
      `    ${t('密钥', 'key')}: ${key}`,
      `    ${t('端点', 'endpoint')}: ${reach}`,
      `    ${t('使用它的智能体', 'used by')}: ${p.agents.length ? p.agents.join(', ') : '—'}`,
    );
  }
  lines.push(
    t(
      '--check 对公网端点只请求一次模型列表接口（不生成内容，不产生 token 费用）。',
      '--check asks public endpoints for their model list only (no generation, no token cost).',
    ),
  );
  return lines;
}
