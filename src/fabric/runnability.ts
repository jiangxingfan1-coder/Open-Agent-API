/**
 * 「这个智能体现在在本机跑得起来吗？」——给 `model_unavailable` 与发布警告用的具体原因：
 * 哪个引擎没安装、没启用，或内置智能体缺哪个提供方环境变量。只看本网关进程内的 local worker；
 * 远程节点的情况看不到，这时返回 undefined，调用方沿用原来的笼统说明。
 */
import type { WorkerConfig } from '../config/config.js';
import type { AgentDefinition } from '../core/contracts.js';
import { bi, pick, requestLocale, type LocalText } from '../core/locale.js';
import { executableExists } from '../core/util.js';
import { isNativeEngine, nativeBackends } from '../config/agent-presets.js';
import { claudeSdkStatus } from '../engines/claude-sdk.js';
import { WorkerRuntime, adapterReady } from './worker.js';
import type { NodeHub } from './network.js';
import { providerKeyReady } from '../providers/provider-key.js';

/** 本网关进程内的 local worker 配置（没有则 undefined）。 */
export function localWorkerConfig(hub: NodeHub): WorkerConfig | undefined {
  let local: WorkerConfig | undefined;
  for (const node of hub.nodes.values()) {
    // 有远程节点在线时，智能体可能由它们执行：只看本机配置会误判，干脆不下结论。
    if (!(node.executor instanceof WorkerRuntime)) return undefined;
    local ??= node.executor.config;
  }
  return local;
}

const enableHint = (engine: string) =>
  bi(
    `在控制台「执行机器」里启用它，或用管理员密钥 POST /v1/local/backends/${encodeURIComponent(engine)}，请求体 {"enabled":true}。`,
    `Enable it under "Execution machines" in the console, or POST /v1/local/backends/${encodeURIComponent(engine)} with {"enabled":true} using the admin key.`,
  );

/** `unavailableReason` 只读智能体的这几个字段（`oaa status` 用目录里的条目调用它）。 */
export type RunnabilityShape = Pick<
  AgentDefinition,
  'id' | 'engine' | 'allowedNodes' | 'provider'
> & {
  routes: { provider: string }[];
};

/** 这个智能体在本机 local worker 上跑不起来的具体原因；跑得起来或看不出来时返回 undefined。 */
export function unavailableReason(
  worker: WorkerConfig | undefined,
  agent: RunnabilityShape,
  env: NodeJS.ProcessEnv = process.env,
): LocalText | undefined {
  if (!worker || (agent.allowedNodes?.length && !agent.allowedNodes.includes(worker.nodeId)))
    return undefined;
  const engine = agent.engine;
  if (isNativeEngine(engine)) {
    const name = nativeBackends[engine].name;
    const backend = worker.native[engine];
    if (!backend || !executableExists(backend.executable))
      return bi(
        `智能体 ${agent.id} 用的引擎 ${name}（${engine}）没有安装在这台机器上（或不在网关的 PATH 里）。按它的官方方式安装并登录后重启网关，再运行 oaa doctor 确认。`,
        `Agent ${agent.id} uses the ${name} engine (${engine}), which is not installed on this machine (or not on the gateway's PATH). Install and sign in to it the official way, restart the gateway, then confirm with oaa doctor.`,
      );
    if (!backend.enabled) {
      const hint = enableHint(engine);
      return bi(
        `智能体 ${agent.id} 用的引擎 ${name}（${engine}）已安装但没有启用。${hint.zh}`,
        `Agent ${agent.id} uses the ${name} engine (${engine}), which is installed but not enabled. ${hint.en}`,
      );
    }
    if (engine === 'claude' && claudeSdkStatus().status !== 'available') {
      return bi(
        `智能体 ${agent.id} 用的 Claude Code 引擎还缺少单独安装的 @anthropic-ai/claude-agent-sdk。运行 oaa doctor 查看安装方法。`,
        `Agent ${agent.id} uses the Claude Code engine, which still needs @anthropic-ai/claude-agent-sdk installed separately. Run oaa doctor for how to install it.`,
      );
    }
    return undefined;
  }
  if (engine.startsWith('adapter/')) {
    const name = engine.slice('adapter/'.length);
    const adapter = worker.adapters[name];
    if (!adapter)
      return bi(
        `智能体 ${agent.id} 用的适配器 ${engine} 没有配置在这台机器的 localWorker.adapters 里。`,
        `Agent ${agent.id} uses adapter ${engine}, which is not configured under localWorker.adapters on this machine.`,
      );
    if (!adapterReady(name, { ...adapter, enabled: true }))
      return bi(
        `智能体 ${agent.id} 用的适配器 ${engine} 找不到可执行文件（或端点、令牌没有就绪）。`,
        `Agent ${agent.id} uses adapter ${engine}, whose executable (or endpoint and token) is not available.`,
      );
    if (!adapter.enabled) {
      const hint = enableHint(engine);
      return bi(
        `智能体 ${agent.id} 用的适配器 ${engine} 已配置但没有启用。${hint.zh}`,
        `Agent ${agent.id} uses adapter ${engine}, which is configured but not enabled. ${hint.en}`,
      );
    }
    return undefined;
  }
  // 内置内核：每条线路的提供方都配置了、却都缺 API Key 环境变量时，点名第一个缺的变量。
  // 配置里没有的提供方可能由进程内注入的驱动提供（测试、嵌入），看不出来就不下结论。
  const providers = [...new Set([agent.provider, ...agent.routes.map((r) => r.provider)])];
  const usable = providers.some((p) => {
    const cfg = worker.providers[p];
    return !cfg || (!cfg.apiKeyFile && !cfg.apiKeyEnv) || providerKeyReady(cfg, env);
  });
  if (usable) return undefined;
  for (const p of providers) {
    const cfg = worker.providers[p];
    if (cfg?.apiKeyFile)
      return bi(
        `智能体 ${agent.id} 的模型提供方 ${p} 读不到密钥文件 ${cfg.apiKeyFile}（不存在、为空、无权限读取或大于 8 KiB）。修好文件后重新调用即可，不需要重启。`,
        `Model provider ${p} of agent ${agent.id} cannot read its key file ${cfg.apiKeyFile} (missing, empty, unreadable or larger than 8 KiB). Fix the file and call again; no restart is needed.`,
      );
    if (cfg?.apiKeyEnv && !env[cfg.apiKeyEnv])
      return bi(
        `智能体 ${agent.id} 的模型提供方 ${p} 缺少环境变量 ${cfg.apiKeyEnv}。在启动网关的环境里设置它（export ${cfg.apiKeyEnv}=…）后重启网关。`,
        `Model provider ${p} of agent ${agent.id} is missing the environment variable ${cfg.apiKeyEnv}. Set it in the gateway's environment (export ${cfg.apiKeyEnv}=…) and restart the gateway.`,
      );
  }
  return undefined;
}

/** 发布成功但本机现在跑不起来时附在发布结果里的警告。 */
export function publishWarning(
  hub: NodeHub,
  agent: AgentDefinition,
  acceptLanguage?: string | string[],
) {
  const reason = unavailableReason(localWorkerConfig(hub), agent);
  if (!reason) return {};
  return {
    warning: { code: 'not_runnable_here', message: pick(reason, requestLocale(acceptLanguage)) },
  };
}

/** `POST /v1/agents/publish-native` 的返回体：附上本机跑不起来时的警告。 */
export function publishedNative(
  hub: NodeHub,
  bundle: { agent: AgentDefinition; digest: string },
  acceptLanguage?: string | string[],
) {
  return {
    id: bundle.agent.id,
    version: bundle.digest,
    validation: { native: 'not_exercised' },
    ...publishWarning(hub, bundle.agent, acceptLanguage),
  };
}
