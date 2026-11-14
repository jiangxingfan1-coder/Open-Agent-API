/**
 * ACP command metadata ported from the owner's Possibility project (src/agent-presets.ts and
 * shared/agent-onboarding.ts), whose command metadata is adapted from OpenDesign,
 * Copyright 2026 Open Design contributors.
 * SPDX-License-Identifier: Apache-2.0
 * Source: OpenDesign b40f25a1c89552725f1fc31f8c2fad172f92acfe for the Vibe command shape, current
 * vendor ACP documentation for Kimi Code, and the public Agent Client Protocol Registry for the
 * pinned npx and binary distributions below.
 * Modified for Open Agent API: presentation and discovery metadata only. OAA omits model probing,
 * MCP injection, credentials, package installation, automatic enabling and automatic execution;
 * registry `npx` launchers are never discovered or run. Notes were rewritten for OAA behaviour.
 * See licenses/OpenDesign-APACHE-2.0.txt and THIRD_PARTY_NOTICES.md.
 *
 * 2026-11-10：全部 32 个预设的启动命令都已逐个对照厂商自己的文档或 ACP 官方注册表核实
 * （见每条的 `verified` 日期和 `source_url`）。两个注册表启动器的固定版本按注册表更正；
 * Hermes 不再附带 `--accept-hooks`（它会自动批准尚未确认的 shell 钩子）。
 */
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/**
 * documented: the vendor publishes the ACP entry point; preview: the vendor labels it
 * preview/experimental/EAP; community: no vendor entry point — a third-party or ACP-organisation
 * adapter listed in the ACP Registry.
 */
export type PresetMaturity = 'documented' | 'preview' | 'community';

export interface AcpPreset {
  /** Stable preset id. It is also the icon id served as `/agents/<id>.svg` and the default adapter name. */
  readonly id: string;
  readonly name: string;
  /** Documented command name. Registry launchers use `npx`, which OAA never runs on its own. */
  readonly executable: string;
  readonly args: readonly string[];
  /** See {@link PresetMaturity}. */
  readonly maturity: PresetMaturity;
  /**
   * Date (YYYY-MM-DD) on which the command and maturity were last checked against the vendor's
   * official documentation (or, for community adapters, the ACP Registry). Absent: 待验证.
   */
  readonly verified?: string;
  readonly docs_url: string;
  readonly source_url: string;
  readonly notes: string;
  /** Set for ACP Registry download launchers. Such presets are templates only. */
  readonly launcher?: 'npx';
  /**
   * Locally installed executable names OAA may look for on PATH (file existence only, nothing is
   * executed). `args` overrides the preset args for that installed form. `realpathIncludes`
   * guards generic file names: the resolved real path must contain the marker.
   */
  readonly discover?: {
    readonly names: readonly string[];
    readonly args?: readonly string[];
    readonly realpathIncludes?: string;
  };
}

const REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const NPX_NOTE =
  'OAA 不会运行 npx、不会下载或安装包；请先按厂商说明自行安装，再把适配器的 command 指向已安装的可执行文件。';

export const acpPresets: readonly AcpPreset[] = [
  {
    id: 'qoder',
    name: 'Qoder CLI',
    executable: 'qoder',
    args: ['--acp'],
    maturity: 'documented',
    docs_url: 'https://docs.qoder.com/cli/acp',
    source_url: 'https://docs.qoder.com/cli/acp',
    notes:
      'Qoder 官方 qoder --acp 入口；也会发现旧版 qodercli 文件名。发现只按文件名匹配，不代表已登录或握手通过。',
    discover: { names: ['qoder', 'qodercli'] },
    verified: '2026-11-08',
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness ACP',
    executable: 'dsh',
    args: ['--profile', 'acp'],
    maturity: 'documented',
    docs_url:
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md',
    source_url:
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md',
    notes:
      'DeepSeek Harness 的 ACP profile，与内置 dsh 原生引擎（一次性 headless）并列；多轮续接以 ACP 会话能力为准。认证、provider、模型和额度由 Harness 管理。',
    discover: { names: ['dsh'] },
    verified: '2026-11-10',
  },
  {
    id: 'kimi',
    name: 'Kimi Code CLI',
    executable: 'kimi',
    args: ['acp'],
    maturity: 'documented',
    docs_url: 'https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/ides.md',
    source_url:
      'https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md',
    notes:
      'Kimi Code CLI 的 ACP stdio 入口（支持 session/load、resume、fork）；OAA 只发送文本提示。认证和额度由 Kimi Code CLI 管理。',
    discover: { names: ['kimi'] },
    verified: '2026-11-08',
  },
  {
    id: 'vibe',
    name: 'Mistral Vibe CLI',
    executable: 'vibe-acp',
    args: [],
    maturity: 'documented',
    docs_url: 'https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md',
    source_url: 'https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md',
    notes: 'Mistral Vibe 的 ACP stdio 入口；OAA 不代填路径、认证或自动批准参数。',
    discover: { names: ['vibe-acp'] },
    verified: '2026-11-10',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    executable: 'gemini',
    args: ['--acp'],
    maturity: 'documented',
    docs_url: 'https://geminicli.com/docs/cli/acp-mode/',
    source_url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md',
    notes:
      'Gemini CLI 官方 ACP 入口 gemini --acp（--experimental-acp 为已弃用的别名）。注意：2026-06-18 起免费层与 Google One 用户的 Gemini CLI 由 Antigravity CLI 取代。Gemini CLI 另有标注 experimental 的 A2A 服务（gemini-cli-a2a-server），可用 transport: "a2a" 接入。请先在 Gemini CLI 中完成登录；OAA 不会代为调用 ACP authenticate，握手通过也不代表认证有效。',
    discover: { names: ['gemini'] },
    verified: '2026-11-08',
  },
  {
    id: 'antigravity-acp',
    name: 'Google Antigravity ACP',
    executable: 'agy_acp_server.par',
    args: [],
    maturity: 'documented',
    docs_url: 'https://antigravity.google/docs/ide/extensions',
    source_url: REGISTRY,
    notes:
      'ACP Registry 的 Google Antigravity 二进制入口；OAA 只发现已放入 PATH 的 agy_acp_server.par，不下载、解压或认证。与内置 antigravity（agy headless）引擎相互独立。',
    discover: { names: ['agy_acp_server.par'] },
    verified: '2026-11-10',
  },
  {
    id: 'amp-acp',
    name: 'Amp ACP',
    executable: 'amp-acp',
    args: [],
    maturity: 'community',
    docs_url: 'https://github.com/tao12345666333/amp-acp',
    source_url: REGISTRY,
    notes:
      '非官方：ACP Registry 收录的社区适配器，Amp 官方没有 ACP 入口（官方的程序化接口是 amp -x --stream-json 与 @ampcode/sdk）。OAA 只发现已安装的 amp-acp，不下载或运行归档；认证和额度由 Amp 管理。',
    discover: { names: ['amp-acp'] },
    verified: '2026-11-08',
  },
  {
    id: 'cortex-code',
    name: 'Snowflake Cortex Code',
    executable: 'cortex',
    args: ['acp', 'serve'],
    maturity: 'documented',
    docs_url: 'https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code',
    source_url: REGISTRY,
    notes:
      'ACP Registry 的 Snowflake Cortex Code 入口；cortex 文件名可能与其他工具重名，启用前请确认。企业登录、模型权限和额度由 Cortex Code 管理。',
    discover: { names: ['cortex'] },
    verified: '2026-11-10',
  },
  {
    id: 'pi-acp',
    name: 'pi ACP',
    executable: 'npx',
    args: ['-y', 'pi-acp@0.0.34'],
    maturity: 'documented',
    docs_url: 'https://github.com/svkozak/pi-acp',
    source_url: REGISTRY,
    notes: `ACP Registry 的固定版本 pi ACP 启动器。${NPX_NOTE}`,
    launcher: 'npx',
    verified: '2026-11-10',
  },
  {
    id: 'deepagents',
    name: 'DeepAgents',
    executable: 'npx',
    args: ['-y', 'deepagents-acp@0.1.7'],
    maturity: 'documented',
    docs_url: 'https://docs.langchain.com/oss/javascript/deepagents/overview',
    source_url: REGISTRY,
    notes: `LangChain DeepAgents 的 ACP Registry 启动器。${NPX_NOTE}`,
    launcher: 'npx',
    verified: '2026-11-10',
  },
  {
    id: 'junie',
    name: 'JetBrains Junie',
    executable: 'junie',
    args: ['--acp=true'],
    maturity: 'preview',
    docs_url: 'https://junie.jetbrains.com/docs/junie-cli-acp.html',
    source_url: REGISTRY,
    notes:
      'JetBrains Junie CLI 的 ACP 入口（文档写作 junie --acp true，Registry 为 --acp=true）；Junie CLI 仍处于 EAP 抢先体验阶段。登录、模型和企业许可由 Junie 管理。',
    discover: { names: ['junie'] },
    verified: '2026-11-08',
  },
  {
    id: 'opencode-acp',
    name: 'OpenCode ACP',
    executable: 'opencode',
    args: ['acp'],
    maturity: 'documented',
    docs_url: 'https://opencode.ai/docs',
    source_url: REGISTRY,
    notes: 'OpenCode 官方 ACP 入口；认证、provider 和模型由 OpenCode 管理。',
    discover: { names: ['opencode'] },
    verified: '2026-11-08',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    executable: 'copilot',
    args: ['--acp', '--stdio'],
    maturity: 'preview',
    docs_url: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server',
    source_url: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server',
    notes:
      'Copilot CLI 的 ACP 仍为公开预览；显式 --stdio 让 stdout 只承载 NDJSON。copilot 文件名可能与其他 CLI 重名，启用前请确认。',
    discover: { names: ['copilot'] },
    verified: '2026-11-08',
  },
  {
    id: 'goose',
    name: 'Goose CLI',
    executable: 'goose',
    args: ['acp'],
    maturity: 'documented',
    docs_url:
      'https://github.com/block/goose/blob/main/documentation/docs/guides/goose-cli-commands.md',
    source_url:
      'https://github.com/block/goose/blob/main/documentation/docs/guides/goose-cli-commands.md',
    notes:
      'Goose 官方 ACP stdio 子命令；扩展和模型由 Goose 本地配置决定。goose 文件名可能与数据库迁移工具重名，启用前请确认。',
    discover: { names: ['goose'] },
    verified: '2026-11-08',
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    executable: 'kiro-cli',
    args: ['acp'],
    maturity: 'documented',
    docs_url: 'https://kiro.dev/docs/cli/acp/',
    source_url: 'https://kiro.dev/docs/cli/acp/',
    notes:
      'Kiro 官方 ACP 入口；OAA 只自动发现 kiro-cli（kiro 可能是 IDE 启动器）。Kiro 扩展方法不桥接。',
    discover: { names: ['kiro-cli'] },
    verified: '2026-11-08',
  },
  {
    id: 'cursor',
    name: 'Cursor Agent CLI',
    executable: 'agent',
    args: ['acp'],
    maturity: 'documented',
    docs_url: 'https://prod.cursor.com/docs/cli/acp',
    source_url: 'https://prod.cursor.com/docs/cli/acp',
    notes:
      'Cursor CLI 的 ACP stdio 入口；agent 是通用文件名，OAA 只在其真实路径包含 cursor 时才视为 Cursor。Cursor 的问答/计划扩展方法不桥接，按不支持处理；认证由 agent login 管理。',
    discover: { names: ['agent', 'cursor-agent'], realpathIncludes: 'cursor' },
    verified: '2026-11-08',
  },
  {
    id: 'qwen',
    name: 'Qwen Code CLI',
    executable: 'qwen',
    args: ['--acp'],
    maturity: 'documented',
    docs_url: 'https://github.com/QwenLM/qwen-code/blob/main/docs/users/integration-jetbrains.md',
    source_url: 'https://github.com/QwenLM/qwen-code/blob/main/docs/developers/architecture.md',
    notes:
      'Qwen Code 官方 ACP 模式（qwen --acp）；认证、模型和额度由 Qwen Code 管理，OAA 只负责标准 ACP 会话与审批边界。',
    discover: { names: ['qwen'] },
    verified: '2026-11-08',
  },
  {
    id: 'auggie',
    name: 'Auggie CLI',
    executable: 'auggie',
    args: ['--acp'],
    maturity: 'documented',
    docs_url: 'https://www.augmentcode.com/product/CLI',
    source_url: 'https://zed.dev/acp/agent/augment-code',
    notes:
      'Augment 官方 Auggie ACP 入口（auggie --acp）；登录、代码库上下文和额度由 Augment 管理。',
    discover: { names: ['auggie'] },
    verified: '2026-11-08',
  },
  {
    id: 'factory-droid',
    name: 'Factory Droid',
    executable: 'droid',
    args: ['exec', '--output-format', 'acp-daemon'],
    maturity: 'documented',
    docs_url: 'https://docs.factory.com/ide-integrations',
    source_url: 'https://docs.factory.com/ide-integrations',
    notes:
      'Factory Droid ACP 入口，采用 ACP Registry 的 droid exec --output-format acp-daemon；官方 Zed 集成文档写作 --output-format acp，若握手失败可改用该写法。账户、模型和计费由 Factory 管理。',
    discover: { names: ['droid'] },
    verified: '2026-11-08',
  },
  {
    id: 'cline',
    name: 'Cline CLI',
    executable: 'cline',
    args: ['--acp'],
    maturity: 'documented',
    docs_url: 'https://github.com/cline/cline/blob/main/docs/usage/acp.mdx',
    source_url: 'https://github.com/cline/cline/blob/main/docs/usage/acp.mdx',
    notes:
      'Cline 官方 ACP 模式（cline --acp，ACP 模式下默认不自动批准）；登录、provider、模型和额度由 Cline CLI 管理，工具审批走 OAA 审批。',
    discover: { names: ['cline'] },
    verified: '2026-11-08',
  },
  {
    id: 'devin',
    name: 'Devin for Terminal',
    executable: 'devin',
    args: ['acp'],
    maturity: 'documented',
    docs_url: 'https://docs.devin.ai/cli',
    source_url: 'https://docs.devin.ai/cli/reference/commands',
    notes:
      'Devin for Terminal 的 ACP stdio 入口；OAA 不预置权限绕过参数，采用 ACP 原生权限请求与 OAA 审批，不代填登录。',
    discover: { names: ['devin'] },
    verified: '2026-11-10',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    executable: 'hermes',
    args: ['acp'],
    maturity: 'documented',
    docs_url: 'https://github.com/NousResearch/hermes-agent',
    source_url:
      'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md',
    notes:
      'Hermes ACP stdio 入口（hermes acp）。这里不带 --accept-hooks：那个参数会自动批准所有还没确认过的 shell 钩子，需要的话请在 Hermes 自己的配置里逐个批准。hermes 文件名可能与 JS 引擎重名，启用前请确认。账户、模型和额度由 Hermes 管理。',
    discover: { names: ['hermes'] },
    verified: '2026-11-10',
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    executable: 'kilo',
    args: ['acp'],
    maturity: 'documented',
    docs_url: 'https://kilo.ai/docs',
    source_url: 'https://kilo.ai/docs/cli',
    notes:
      'Kilo 的 ACP stdio 入口；kilo 文件名可能与文本编辑器重名，启用前请确认。登录、provider、模型和额度由 Kilo 管理。',
    discover: { names: ['kilo'] },
    verified: '2026-11-10',
  },
  {
    id: 'reasonix',
    name: 'DeepSeek Reasonix',
    executable: 'reasonix',
    args: ['acp'],
    maturity: 'documented',
    docs_url: 'https://reasonix.io/docs/',
    source_url: 'https://reasonix.io/docs/',
    notes:
      'Reasonix ACP stdio 入口；也会发现旧版 dsnix 文件名。OAA 不注入专属系统提示或密钥，只使用通用 ACP 合同。',
    discover: { names: ['reasonix', 'dsnix'] },
    verified: '2026-11-10',
  },
  {
    id: 'trae-cli',
    name: 'Trae CLI',
    executable: 'traecli',
    args: ['acp', 'serve'],
    maturity: 'documented',
    docs_url: 'https://docs.trae.cn/cli_agent-client-protocol',
    source_url: 'https://docs.trae.cn/cli_agent-client-protocol',
    notes:
      'Trae CLI 官方 ACP serve 入口（--profile、--permission-mode 等全局参数须写在 acp serve 之前）；OAA 不预置 --yolo 权限绕过参数，保留 ACP 原生权限请求。',
    discover: { names: ['traecli'] },
    verified: '2026-11-10',
  },
  {
    id: 'grok-build-acp',
    name: 'Grok Build ACP',
    executable: 'grok',
    args: ['agent', 'stdio'],
    maturity: 'documented',
    docs_url: 'https://docs.x.ai/build/cli/reference',
    source_url: 'https://docs.x.ai/build/cli/reference',
    notes:
      'xAI Grok Build 的 ACP stdio 入口（grok agent stdio）；不自动登录、不启用 --always-approve。',
    discover: { names: ['grok'] },
    verified: '2026-11-10',
  },
  {
    id: 'claude-acp',
    name: 'Claude Agent ACP',
    executable: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.85.1'],
    maturity: 'community',
    docs_url: 'https://github.com/agentclientprotocol/claude-agent-acp',
    source_url: REGISTRY,
    notes: `非厂商：ACP 组织维护的 Claude 适配器（旧名 claude-code-acp），Anthropic 没有原生 ACP 入口；厂商支持的接入方式是内置 claude 原生引擎（Agent SDK）。${NPX_NOTE} 全局安装后 OAA 会在 PATH 中查找 claude-agent-acp 或 claude-code-acp（按包名推断的可执行文件名）。`,
    launcher: 'npx',
    discover: { names: ['claude-agent-acp', 'claude-code-acp'], args: [] },
    verified: '2026-11-08',
  },
  {
    id: 'codex-acp',
    name: 'Codex ACP',
    executable: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@2.1.1'],
    maturity: 'community',
    docs_url: 'https://github.com/agentclientprotocol/codex-acp',
    source_url: REGISTRY,
    notes: `非厂商：ACP 组织维护的 Codex 适配器，OpenAI 没有原生 ACP 入口；厂商支持的接入方式是内置 codex 原生引擎（app-server，官方标注 Experimental）。${NPX_NOTE} 安装后 OAA 会在 PATH 中查找 codex-acp。`,
    launcher: 'npx',
    discover: { names: ['codex-acp'], args: [] },
    verified: '2026-11-08',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    executable: 'npx',
    args: ['-y', '@tencent-ai/codebuddy-code@2.161.1', '--acp'],
    maturity: 'documented',
    docs_url: 'https://www.codebuddy.cn/cli/',
    source_url: REGISTRY,
    notes: `腾讯云 CodeBuddy Code 原生支持 ACP（codebuddy --acp；另有 --acp-transport streamable-http，OAA 只使用 stdio）。已全局安装时 OAA 会在 PATH 中查找 codebuddy；登录、模型和额度由 CodeBuddy 管理。${NPX_NOTE}`,
    launcher: 'npx',
    verified: '2026-11-08',
    discover: { names: ['codebuddy'], args: ['--acp'] },
  },
  {
    id: 'minimax-code',
    name: 'MiniMax Code',
    executable: 'npx',
    args: ['-y', '@minimax-ai/code@0.2.7', 'acp'],
    maturity: 'documented',
    docs_url: REGISTRY,
    source_url: REGISTRY,
    notes: `MiniMax Code 的 ACP Registry 启动器；账户、模型和额度由 MiniMax 管理。${NPX_NOTE}`,
    launcher: 'npx',
    verified: '2026-11-10',
  },
  {
    id: 'glm',
    name: 'GLM Agent',
    executable: 'npx',
    args: ['-y', 'glm-acp-agent@1.17.0'],
    maturity: 'documented',
    docs_url: REGISTRY,
    source_url: REGISTRY,
    notes: `GLM Agent 的 ACP Registry 启动器；认证、模型和额度由 GLM CLI 管理。${NPX_NOTE}`,
    launcher: 'npx',
    verified: '2026-11-10',
  },
  {
    id: 'grok',
    name: 'Grok Build Agent',
    executable: 'npx',
    args: ['-y', '@xai-official/grok@1.0.79', 'agent', 'stdio'],
    maturity: 'documented',
    docs_url: REGISTRY,
    source_url: REGISTRY,
    notes: `xAI Grok Build 的 ACP Registry 启动器；已安装 grok 时请使用 grok-build-acp 预设。${NPX_NOTE}`,
    launcher: 'npx',
    verified: '2026-11-10',
  },
];

/** Built-in native engines. `preset` is the shared icon id; these never use ACP. */
export const nativeBackends = {
  codex: { preset: 'codex', name: 'Codex', executable: 'codex' },
  claude: { preset: 'claude', name: 'Claude Code', executable: 'claude' },
  antigravity: {
    preset: 'antigravity',
    name: 'Antigravity',
    executable: 'agy',
    docs_url: 'https://antigravity.google/docs/cli/headless/',
  },
  dsh: { preset: 'deepseek-harness', name: 'DeepSeek Harness', executable: 'dsh' },
} as const;
export type NativeEngine = keyof typeof nativeBackends;
export const nativeEngines = Object.keys(nativeBackends) as [NativeEngine, ...NativeEngine[]];
export const isNativeEngine = (value: unknown): value is NativeEngine =>
  typeof value === 'string' && Object.hasOwn(nativeBackends, value);

/** Adapter names become `adapter/<name>` engines; this is the published agent engine grammar. */
export const adapterNamePattern = /^[a-z0-9_-]+$/;
export const adapterEnginePattern = /^adapter\/[a-z0-9_-]+$/;

export function acpPreset(id: unknown): AcpPreset | undefined {
  return typeof id === 'string' ? acpPresets.find((preset) => preset.id === id) : undefined;
}

export type DiscoveredAcpAgent = { preset: AcpPreset; executable: string; args: string[] };

async function executableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Resolve the first executable `names` entry on PATH. Only file metadata is read; nothing runs. */
export async function findOnPath(
  names: readonly string[],
  pathEnv = process.env.PATH ?? '',
  realpathIncludes?: string,
): Promise<string | undefined> {
  const dirs = pathEnv.split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (!(await executableFile(candidate))) continue;
      if (realpathIncludes) {
        try {
          if (!(await realpath(candidate)).toLowerCase().includes(realpathIncludes)) continue;
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return undefined;
}

/**
 * Discover installed ACP agents by executable file name. The result is intended to be written as
 * disabled adapter entries; OAA never enables or executes a discovered command by itself.
 */
export async function discoverAcpAgents(
  pathEnv = process.env.PATH ?? '',
): Promise<DiscoveredAcpAgent[]> {
  const found: DiscoveredAcpAgent[] = [];
  for (const preset of acpPresets) {
    if (!preset.discover) continue;
    const executable = await findOnPath(
      preset.discover.names,
      pathEnv,
      preset.discover.realpathIncludes,
    );
    if (executable)
      found.push({ preset, executable, args: [...(preset.discover.args ?? preset.args)] });
  }
  return found;
}

/** Adapter configuration for a discovered agent: always disabled until the owner enables it. */
export function discoveredAdapterEntry(found: DiscoveredAcpAgent) {
  return {
    transport: 'acp' as const,
    command: found.executable,
    args: found.args,
    enabled: false,
    preset: found.preset.id,
  };
}
