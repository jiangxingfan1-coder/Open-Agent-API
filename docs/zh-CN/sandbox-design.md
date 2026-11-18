# 沙箱 worker 设计（P1 最后一项）

[English](../sandbox-design.md) · 简体中文

> 状态：S1 已实现；S2a（Claude、Codex 进沙箱）的代码已实现，用协议替身验证过，**尚未用真实 CLI 和真实模型实测**（见 §4.1 的「待实测」）；S3 未开始（2026-11-08）。
> - 已安装 `@anthropic-ai/sandbox-runtime@0.0.82`，安装时用 `--ignore-scripts`。它自带的 zod 3 有一条内存耗尽类的审计告警；srt 只用它校验我们构造的、有长度上限的配置，外部输入到不了这条路径。
> - 实现位置：`src/engines/sandbox.ts`（`SrtLauncher`、自检）、`src/engines/process.ts`（`collectProcess` 的沙箱参数）、`src/fabric/worker.ts`（`sandbox` 配置项、脚本工具走沙箱）、`src/kernel/kernel.ts` / `src/fabric/placement.ts`（`sandbox` 等级、调度和协商）。
> - 测试：`test/sandbox-routing.test.ts`（不开端口），`test/sandbox-srt.test.ts`（会启动 srt 代理，**需要授权后才运行**）。
> - 实现中的取舍与并发模型：`SrtLauncher` 按调用方 `subject` 池化有界 `worker_threads` 沙箱槽位（默认 `maxConcurrentSandboxes = 4`，跨主体复用冷槽位前强制轮换重置代理凭据，无 `subject` 调用保持严格串行，杜绝跨调用方串用 `allowedDomains`），原生画像同步覆盖 `antigravity` 与通用 stdio `acp` 适配器；`parentProxy` 默认不启用。
> - S2 发现：srt 的 `credentials.envVars`（`mode: "mask"` + `injectHosts`）可以让沙箱里的原生智能体只看到占位符，真正的 BYOK 密钥由宿主侧代理在发往提供方时才替换。
> - 实施时凡是涉及下载依赖、监听端口、出网规则的步骤，都要逐项单独确认（见 §8）。

## 1. 已确定的决策

| 决策 | 结论 |
|---|---|
| 首个隔离后端 | **Anthropic sandbox-runtime（srt）**：macOS 上用 `sandbox-exec`，Linux 上用 bubblewrap；网络由宿主机上的代理按域名放行 |
| 第一批放进沙箱的执行 | **发布者脚本工具 + 原生智能体**（Codex、Claude、Antigravity、DSH） |
| 出网策略 | **默认全部禁止 + 白名单** |
| 生产平台 | 还没定，所以接口与平台无关；Linux 上以后可以加 gVisor 后端 |

## 2. 现状与目标

现在 worker 启动的所有外部进程都以宿主机权限运行：发布者脚本（`src/fabric/worker.ts` 里 `handler.kind === 'script'` 的分支）、原生智能体（`src/engines/native.ts`）、ACP 和 stdio 适配器。它们都经过 `src/engines/process.ts` 的 `ownedProcess` / `collectProcess` 启动，这就是沙箱的统一接入点。

目标：一把 `sandbox` 级的 key 可以运行这些智能体，但它们的进程：

- 只能读写本次会话的工作区；能力包目录和运行时目录只读；其它路径一律拒绝，包括 home、`~/.ssh`、OAA 数据目录、其它会话的工作区。
- 只能访问白名单里的域名。不能访问 localhost，包括网关的 `127.0.0.1:8787`；也不能访问局域网和云厂商的元数据地址。
- 拿不到宿主机的凭据和登录状态。
- 受 CPU、内存、进程数、时长限制。

## 3. 架构

```
kernel ──调度──▶ worker
                  ├─ 内置工具（workspace 级，进程内，不变）
                  └─ SandboxLauncher.spawn(spec) ──▶ 后端
                        ├─ none   （host 级，等于现状）
                        ├─ srt    （本期）
                        └─ gvisor （以后，仅 Linux）
```

### 3.1 `SandboxLauncher` 接口（`src/engines/sandbox.ts`，新文件）

```ts
type SandboxSpec = {
  command: string; args: string[];
  workspace: string;            // 唯一可写目录
  readOnly: string[];           // 能力包、运行时（node/python/CLI 安装目录）
  env: Record<string, string>;  // 已按 nativeEnv / BYOK 计算好的环境变量
  allowedDomains: string[];     // 已经求过交集的出网白名单
  limits: { cpuSeconds: number; memoryMb: number; processes: number; wallMs: number };
};
interface SandboxLauncher {
  readonly backend: 'srt' | 'gvisor';
  spawn(spec: SandboxSpec, signal: AbortSignal): ChildProcessWithoutNullStreams;
}
```

`ownedProcess` 新增一个可选参数 `sandbox?: SandboxSpec`。传了就交给 launcher 启动，没传就和现在一样。脚本、原生智能体、适配器只在调用的地方多传这一个参数，执行器本身不改。

### 3.2 执行等级加一档

`workspace < sandbox < host`（在 `src/core/contracts.ts` 的 `executionLevels` 里补上）。

- 智能体的**所需等级**不变：脚本和原生智能体仍然是 `host`。
- key 的允许等级为 `sandbox` 时，这类智能体**只会被调度到声明了沙箱能力的节点**，并且在沙箱里运行。不满足条件时，返回的仍是 `isolation_required`。
- 节点上的私有宿主工具（`node` 类型的 handler，例如 MCP）**始终需要 `host`**。它们本来就是为了访问主人的私有资源，沙箱帮不上忙。
- 公网部署时，建议把 `defaultKeyExecution` 改成 `sandbox`。

### 3.3 节点声明与协商

沿用 BYOK 的做法：网关在 `welcome.features` 里加 `sandbox-v1`；worker 收到后，才在 `execution` 里上报：

```json
{ "sandbox": { "backend": "srt", "version": "x.y.z", "kinds": ["script", "native/claude", "native/codex"] } }
```

`kinds` 只列出**在这台机器上验证过能在沙箱里运行**的执行类型（见 §5 的自检）。调度器的判断条件是：`sandbox` 级请求 + 这个 kind 在列表里。

### 3.4 出网白名单怎么算

```
生效白名单 = (发布者声明 ∩ worker 主人批准) ∪ 该原生引擎的模型提供方域名
```

- **发布者声明**：在能力包里新增 `capability.network.allowedDomains`（脚本），或 `agent.network.allowedDomains`（原生智能体）。这是发布时公开的元数据，审核时可以看到。
- **worker 主人批准**：worker 配置 `sandbox.allowDomains`，是上限。发布者声明了但主人没批准的域名，不会生效。
- **提供方域名**：worker 配置里给每个原生引擎列出它的 API 域名，例如 Claude 是 `api.anthropic.com`。这些只能由主人配置，发布者无权添加。
- 两份列表求交集为空时，就是完全断网。srt 会额外拦截 loopback、链路本地地址、元数据地址和宿主机自身的地址（这是它的「resolved-address check」）。

## 4. 原生智能体进沙箱的特殊问题

| 问题 | 设计 |
|---|---|
| **登录状态**：CLI 默认读取 `~/.claude`、`~/.codex` 等目录里的主人登录信息 | 沙箱里的 `HOME` 指向工作区里一个**全新的空目录**，不挂载主人的配置目录。陌生人控制的智能体绝不能拿到主人的订阅登录信息 |
| **那它用什么密钥** | 默认要求**调用方自带密钥（BYOK）**：把调用方密钥作为该引擎约定的环境变量（例如 `ANTHROPIC_API_KEY`）注入沙箱。需要把 BYOK 从「只支持 kernel」扩展到「支持沙箱里的原生智能体」。主人也可以指定一把**专用的低额度密钥**给沙箱用，但要明白：沙箱里的智能体能读到这把密钥 |
| **嵌套沙箱**：Codex 在 macOS 上会用 Seatbelt 包裹自己执行的命令，而 macOS 一般不允许在 `sandbox-exec` 里再套一层 `sandbox-exec` | 待验证。如果确实不能嵌套，就在外层沙箱里关掉 CLI 自带的沙箱（例如 Codex 的完全访问模式），由外层沙箱负责隔离 |
| **Claude Agent SDK 自己启动 CLI 进程**，不经过 `ownedProcess` | 待验证。可选做法：把 `pathToClaudeCodeExecutable` 指向一个包装脚本，由它在 srt 里启动真正的 CLI；或者使用 SDK 提供的自定义 spawn 钩子（如果有） |
| **审批**：原生智能体在沙箱里请求权限 | 审批流程不变；不管批准什么，都只在沙箱范围内生效 |
| **续接会话**：原生会话的状态保存在 CLI 的配置目录里 | 这个目录随会话工作区保存；工作区按 TTL 删除后，就不能再续接 |

### 4.1 S2 事实核查（2026-11-08，只读，未调用模型）

| 引擎 | 本机版本 | 配置目录 | 只用 API key 认证 | 自带沙箱 | 怎么接管启动 | 结论 |
|---|---|---|---|---|---|---|
| Claude Code | 2.1.318，单个 Mach-O 二进制 | `CLAUDE_CONFIG_DIR` | `--bare` 模式下**只用** `ANTHROPIC_API_KEY`，不读 OAuth 和钥匙串 | 默认关闭 | Agent SDK 的 `spawnClaudeCodeProcess` 钩子 | **S2a 先做** |
| Codex | 0.167.0，`#!/usr/bin/env node` 脚本 | `CODEX_HOME` | 待实测（`OPENAI_API_KEY`） | 有，用 `-s` / `-c sandbox_mode=…` 覆盖 | 我们自己启动 app-server | **S2a 先做**，认证方式待实测 |
| Antigravity（agy） | 1.5.3 | 帮助里没有说明 | 不明 | 可选的 `--sandbox` | 我们自己启动 | **暂缓**，等实测 |
| DSH | 0.1.5-rc.1，node 脚本 | `$DSH_HOME` | 不明 | — | 我们自己启动 | **暂缓**，等实测 |

由此确定的设计：

- **一律要求调用方自带密钥。** 沙箱里的原生智能体只能用调用方的密钥（BYOK），由 worker 注入到该引擎约定的环境变量里（Claude 是 `ANTHROPIC_API_KEY`，Codex 是 `OPENAI_API_KEY`）。`sandbox` 级的密钥调用原生智能体时，如果没带 `X-OAA-Provider-Key`，提交时就返回 400 `provider_key_required`。由主人出资的「沙箱专用密钥」留到以后再做。
- **配置目录隔离。** 沙箱里的 HOME 和配置目录（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`）都指向会话工作区里的 `.oaa-home/`，所以同一会话可以续接，但永远读不到主人的配置。Claude 另外加上 `--bare`，并设置 `settingSources: []`。
- **启动方式**：
  - Claude：SDK 的钩子要求同步返回进程对象，而 srt 的包装是异步的。所以先返回一个用管道桥接的代理对象，包装完成后再启动真实进程并接上管道。
  - Codex：先等沙箱包装完成，再启动 app-server。
  - node 脚本形式的 CLI 一律用真实的 node 路径加脚本的真实路径来启动。`~/.local/bin` 里的符号链接位于被禁止读取的 home 目录下，所以不能直接用。
- **只读目录**：CLI 的安装目录。node 包取包的根目录，单个二进制文件取它所在的目录。node 脚本还需要 node 运行时目录。
- **出网**：只放行主人在 `sandbox.native.<engine>.providerDomains` 里配置的提供方域名。S2a 里发布者不能为原生智能体增加域名。
- **上报能力**：只有同时满足以下条件，才上报 `native/<engine>`：主人配置了该引擎、该引擎已启用、启动自检通过（在沙箱里运行 `<cli> --version`）。
- **密钥对智能体可见**：密钥以明文环境变量注入，沙箱里的智能体读得到。因为这是调用方自己的密钥，出网又只能到提供方域名，所以风险可控。以后可以用 srt 的 `credentials.envVars` 掩码（需要实验性的 TLS 终止）做加固，让智能体只看到占位符。
- **待实测**（需要启动 srt，以及真实的模型调用）：Codex 在 `CODEX_HOME` 为空时是否能用 `OPENAI_API_KEY` 认证；两个 CLI 在 srt 里是否需要额外的可写路径或 mach 服务；macOS 上嵌套 Seatbelt 的行为。

## 5. srt 后端的实现要点

- **依赖**：npm 包 `@anthropic-ai/sandbox-runtime`，版本固定。Linux 还需要 `bubblewrap`（建议 0.5 及以上）、`socat`、`ripgrep`。
- **用法**：`SandboxManager.initialize(config)` 会在宿主机的 localhost 上启动 HTTP 代理和 SOCKS5 代理；`wrapWithSandbox(command)` 返回包装后的命令，然后照常启动这个进程。
- **按调用设置白名单**：用 `registerCommandNetworkLists(commandId, { allowedDomains })` 给每次调用单独设置。注意：srt 的文档明确说明，command ID 只是归属标记，**不是安全边界**。所以不同信任等级的调用，最终应该交给**不同的 SandboxManager 实例**（或不同进程）处理，不能共用一组代理。第一期先保守处理：同一时间只给一个调用方 subject 共用一个实例。
- **文件规则**：srt 的默认是「读全部允许、写全部拒绝」。必须显式 `denyRead` home、OAA 数据目录、`/Volumes` 等位置，只用 `allowRead` 放开运行时目录。我们在 srt 外面再加一层：spec 里只列出允许的路径，其余默认拒绝。
- **资源限制**：srt 本身不限制 CPU 和内存。macOS 上用 `setrlimit`（CPU 时间、地址空间、进程数），Linux 上用 `prlimit` 或 cgroup。超出时长由现有的 `AbortSignal` 和 `terminateOwned` 强制结束。
- **启动自检**：worker 启动时，在沙箱里跑一组探测：读 `~/.ssh` 应该失败、写工作区以外应该失败、访问不在白名单的域名应该失败、访问 `127.0.0.1` 应该失败、访问白名单域名的 DNS 能解析。全部符合预期后，才上报对应的 `kinds`。

## 6. 已知局限（要如实对外说明）

- srt 是**进程级**隔离，和宿主机共享内核，内核漏洞可以突破。它的官方状态是 **Beta 研究预览**，配置格式可能变化。
- macOS 的 `sandbox-exec` 已被苹果标记为弃用，但目前仍可使用。
- 域名白名单依赖 DNS：谁控制白名单里某个域名的 DNS，谁就决定它解析到哪里。
- 真正对陌生人大规模开放时，Linux 上应改用 gVisor，或者每次运行一台微虚拟机（Firecracker / Apple container）。接口已经为此预留。

## 7. 分期与验收

**S1：接口 + srt + 脚本工具**
- `SandboxLauncher`、srt 后端、`sandbox` 执行等级、`sandbox-v1` 协商、启动自检。
- 验收（自动化测试）：沙箱里的脚本读不到 `~/.ssh`；写不到工作区以外；访问不在白名单的域名和 `127.0.0.1:8787` 都失败；访问白名单域名可以；环境变量里只有允许的那些；进程数和 CPU 超限会被结束。

**S2：原生智能体进沙箱**
- 每个引擎一套适配：隔离的 HOME、BYOK 环境变量注入、提供方域名、关闭 CLI 自带沙箱、续接会话目录。
- BYOK 扩展到沙箱里的原生智能体。
- 验收：每个引擎各跑一次真实任务（**需要操作者授权真实模型调用的费用**），并做一次逃逸测试：让智能体去读主人的 `~/.claude` 等目录，必须失败。

**S2a 实施记录（2026-11-08）**
- 实现：`src/engines/native.ts`（`sandboxPlan`；Claude 通过 SDK 的 `spawnClaudeCodeProcess` 加 `DeferredProcess` 桥接；Codex 直接启动 app-server）、`src/engines/sandbox.ts`（`cliLaunch`、`nativeSandboxProfiles`、启动自检里的 CLI 探测）、`src/fabric/worker.ts`（`nativeSandbox`，拒绝被误派过来的任务）、`src/kernel/kernel.ts`（`provider_key_required`、原生任务的隔离标记和密钥）。
- 测试：`test/sandbox-native.test.ts`，5 项，不开端口，用的是协议替身。
- 实现中修掉的一个缺陷：脚本形式的 CLI 如果附近找不到 `package.json`，原来会把只读范围扩大到 4 层之上的祖先目录。现在只放开脚本自己所在的目录。

**S3（平台确定后）：gVisor 后端**，在 Linux 上作为生产级隔离。

## 8. 实施时需要你单独确认的事项

1. 从 npm 下载 `@anthropic-ai/sandbox-runtime`，固定版本，写入 `package.json` 和 lock 文件。
2. srt 会在 worker 本机的 localhost 上**监听两个代理端口**（HTTP 和 SOCKS5），测试时也会。
3. 每个原生引擎要放行的提供方域名列表。
4. S2 的真实模型调用（会产生费用）。
5. Linux 服务器上安装 `bubblewrap`、`socat`、`ripgrep`（平台确定后再说）。

## 参考

- [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime)：API、配置格式、局限、Beta 状态
- [gVisor 发布记录](https://github.com/google/gvisor/releases/tag/release-20261005.0)
- [apple/container](https://github.com/apple/container)：每个容器一台轻量 VM，1.0 版（2026-06）
