/**
 * Which agent does `oaa verify AGENT` test, and what does it report about itself?
 * AGENT is what `oaa connect` takes (codex, claude, agy, an ACP preset or adapter name), optionally
 * written as the published id `agent/NAME`; any other published id is looked up on the running gateway.
 * Where the program lives comes from the local configuration, else PATH, else `--executable`.
 */
import { execFile } from 'node:child_process';
import { launchPlan } from '../engines/win-spawn.js';
import path from 'node:path';
import {
  discoverAcpAgents,
  discoveredAdapterEntry,
  isNativeEngine,
} from '../config/agent-presets.js';
import type { GatewayConfig } from '../config/config.js';
import { bi } from '../core/locale.js';
import { Fault, executableExists } from '../core/util.js';
import { claudeSdkStatus } from '../engines/claude-sdk.js';
import { nativeEnvironment } from '../engines/process.js';
import { probeAcp } from '../engines/acp.js';
import { engineFor } from './connect.js';
import type { VerifyTarget } from './verify-env.js';

const BINARIES: Record<string, string> = { codex: 'codex', claude: 'claude', antigravity: 'agy' };

export type ResolveInput = {
  agent: string;
  config?: GatewayConfig;
  /** `--executable PATH`: overrides where a built-in engine's program is. */
  executable?: string;
  pathEnv?: string;
  /** The engine behind a published agent id on the running gateway, when it can be asked. */
  publishedEngine?: (id: string) => Promise<string | undefined>;
};

function onPath(binary: string, pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, binary);
    if (executableExists(candidate)) return candidate;
  }
  return undefined;
}

export async function resolveTarget(input: ResolveInput): Promise<VerifyTarget> {
  const name = input.agent.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,80}$/.test(name))
    throw new Fault(
      'arguments',
      bi(
        'verify 需要智能体名称，例如 codex、claude、agy，或已发布的 agent/名称。',
        'verify needs an agent name such as codex, claude or agy, or a published agent/NAME.',
      ),
    );
  let engine: string | undefined;
  if (name.startsWith('agent/')) engine = await input.publishedEngine?.(name);
  engine ??= engineFor(name.startsWith('agent/') ? name.slice('agent/'.length) : name);
  const pathEnv = input.pathEnv ?? process.env.PATH ?? '';

  if (isNativeEngine(engine)) {
    if (engine === 'dsh')
      throw new Fault(
        'arguments',
        bi(
          'verify 暂不支持 dsh（它是一次性的无头引擎，没有续接、审批与流式）。',
          'verify does not support dsh yet (it is a one-shot headless engine without continuation, approvals or streaming).',
        ),
      );
    const kind = engine as 'codex' | 'claude' | 'antigravity';
    const configured = input.config?.localWorker?.native[engine]?.executable;
    const found =
      input.executable ??
      (configured && executableExists(configured) ? configured : undefined) ??
      onPath(BINARIES[kind]!, pathEnv);
    if (!found || !executableExists(found))
      throw new Fault(
        'native_not_installed',
        bi(
          `没有找到 ${BINARIES[kind]}。先按它的官方方式安装并登录，或用 --executable 指定它的路径。`,
          `${BINARIES[kind]} was not found. Install it and sign in the official way, or pass its path with --executable.`,
        ),
      );
    if (kind === 'claude' && claudeSdkStatus().status !== 'available')
      throw new Fault(
        'backend_unavailable',
        bi(
          'Claude Code 引擎还缺少单独安装的 @anthropic-ai/claude-agent-sdk。运行 oaa doctor 查看安装方法。',
          'The Claude Code engine still needs @anthropic-ai/claude-agent-sdk installed separately. Run oaa doctor for how to install it.',
        ),
        409,
      );
    return {
      kind,
      label: kind,
      engine: kind,
      native: { engine: kind, executable: path.resolve(found) },
    };
  }

  const adapterName = engine.slice('adapter/'.length);
  const configured = input.config?.localWorker?.adapters[adapterName];
  if (configured)
    return {
      kind: 'acp',
      label: engine,
      engine,
      adapter: { name: adapterName, config: { ...configured } },
    };
  const found = (await discoverAcpAgents()).find((f) => f.preset.id === adapterName);
  if (found) {
    const { enabled: _enabled, ...entry } = discoveredAdapterEntry(found);
    return { kind: 'acp', label: engine, engine, adapter: { name: adapterName, config: entry } };
  }
  throw new Fault(
    'backend_unavailable',
    bi(
      `不认识「${input.agent}」：它既不是 codex、claude、agy，也不是已配置的适配器，本机也没有找到同名的 ACP 智能体。oaa doctor 列出本机找到的智能体。`,
      `Unknown agent "${input.agent}": it is not codex, claude, agy or a configured adapter, and no ACP agent of that name was found on this machine. oaa doctor lists what was found.`,
    ),
    409,
  );
}

export type Identity = {
  name?: string;
  version?: string;
  source: 'acp-handshake' | 'version-flag' | 'none';
};

const clipLine = (text: string) =>
  text
    .split('\n')
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 120);

/**
 * What the agent says about itself, without sending it a prompt: the ACP `initialize` handshake, or
 * `<program> --version`. Neither calls a model. Any failure leaves the identity unknown.
 */
export async function agentIdentity(target: VerifyTarget, timeoutMs = 10_000): Promise<Identity> {
  const env = nativeEnvironment({ mode: 'inherit', allow: [] });
  try {
    if (target.adapter) {
      const c = target.adapter.config as { transport?: string; command?: string; args?: string[] };
      if (c.transport !== 'acp' || !c.command) return { source: 'none' };
      const probe = await probeAcp(c.command, c.args ?? [], timeoutMs, env);
      return probe.agent
        ? {
            name: probe.agent.name,
            version: probe.agent.version ?? undefined,
            source: 'acp-handshake',
          }
        : { source: 'none' };
    }
    if (!target.native) return { source: 'none' };
    // launchPlan: on Windows an npm `.cmd` launcher cannot be executed directly.
    const plan = launchPlan(target.native.executable, ['--version'], env);
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        plan.command,
        plan.args,
        {
          timeout: timeoutMs,
          env,
          windowsHide: true,
          windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false,
        },
        (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}\n${stderr}`)),
      ),
    );
    const line = clipLine(out);
    return line
      ? { name: target.label, version: line, source: 'version-flag' }
      : { source: 'none' };
  } catch {
    return { source: 'none' };
  }
}
