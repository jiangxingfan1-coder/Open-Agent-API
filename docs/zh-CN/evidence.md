# 实测证据：哪些智能体被真的转成了 Agent API

[English](../evidence.md) · 简体中文

> 2026-11-11，在一台 macOS 机器上对本机已安装的真实智能体做的联调（2026-11-13 另有一次 Antigravity 的端到端验证，见本页末尾）。每一行都是实际执行并看到的结果；没有做过的写「未测」，失败的照实写失败原因。测试替身（协议级假智能体）的覆盖范围见 [adapters.md](adapters.md) 的转换契约，不计入本页。

## 结论（先说边界）

- **不能证明「所有智能体」都能转。** 能证明的是：一个智能体只要提供四种接入方式之一（内置原生、ACP、`oaa/1` 适配器、A2A），就能发布成 Agent API；本机装着的 7 个真实智能体里，3 个跑通了真实调用，另外 4 个卡在它们各自的账号或配置状态上（两个未登录、一个密钥过期、一个自身配置锁），网关给出了明确的错误而不是含糊失败。
- **「其它智能体能使用这个 API」已用真实智能体证明一次**：Antigravity（Gemini 3.8 Flash）作为调用方，经 OAA 的 MCP 入口调用了由 Codex 充当的 `agent/codex`，拿回了正确结果。两层 Harness、两个不同的智能体、两家不同的模型。
- **0.0.64 之后自动检查多了很多，真实智能体的记录没有增加。** CI 现在在 Linux、macOS 与 Windows、Node 24 与 26 上跑完整测试，构建并烟雾测试 Docker 镜像，并运行一个兼容性实验室：官方 SDK 实际运行，常用聊天客户端的请求回放（见 [CI 里的自动检查](#ci-里的自动检查2026-11-14)）。这些全都用替身智能体与夹具模型。真实智能体的端到端仍然只有 Antigravity，Codex 与 Claude Code 没有重跑（见[还没有任何检查覆盖的](#还没有任何检查覆盖的)）。

## 作为被调用方（智能体 → Agent API）

| 智能体 | 接入方式 | 握手 | 托管模式真实调用 | 桥接真实调用 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Antigravity `agy acp` 1.5.5 | ACP | 通过 | 通过（Gemini 3.8 Flash，回复正确，用量上报） | **通过**（单个调用；并行两个调用；流式续接） | 并行调用被拆成两轮交给调用方；模型名用 `gemini-3.8-flash`，不能带 `-low` |
| Qoder CLI 1.1.52 | ACP | 通过 | 通过（回复正确） | **通过**（单个调用） | 调用工具前它先发了权限请求，本次由脚本代所有者批准；它上报的用量全是 0 |
| Codex CLI 0.167.0 | 内置原生（app-server） | — | 通过（默认模型 `gpt-6-astra`，回复正确） | 不支持（未实现） | 不上报用量 |
| OpenCode 1.18.29 | ACP | 通过 | **失败：它自己的 API 密钥已过期** | 未测 | 网关报 `native_protocol_error` 并带出智能体的原话，密钥片段已脱敏 |
| Grok Build | ACP | 通过 | **失败：尚未登录** | 未测 | 网关报 `adapter_auth_required`，提示去它自己的 CLI 登录 |
| Claude Code | 内置原生（Agent SDK） | — | **失败：命令行版本尚未登录** | 不支持（未实现） | 网关只报了 `native_incomplete`，没有带出「未登录」这个原因——这是本次发现的缺陷，见下 |
| DeepSeek Harness | ACP | **失败：它自己的配置写锁超时** | 未测 | 未测 | 握手阶段进程退出，与 OAA 无关 |

## 作为调用方（其它智能体使用这个 API）

| 调用方 | 入口 | 被调用的智能体 | 结果 |
| --- | --- | --- | --- |
| Antigravity（Gemini 3.8 Flash），经 ACP 驱动，MCP 服务只在会话级传入 | OAA 的 MCP 桥（`oaa mcp`），网关临时监听 `127.0.0.1:8799` | `agent/codex`（Codex，`gpt-6-astra`） | **通过**。它依次调用了 `oaa_list_agents`、`oaa_invoke`、`oaa_wait_run`、`oaa_read_output`，最后回答：调用的是 `agent/codex`，回复文本是 `CODEX-OK-7391`（与要求一致）。网关上有对应的一条 `completed` 请求记录，耗时约 12.5 秒 |

OpenAI / Claude / Gemini 兼容接口一侧，调用方工具桥接的真实调用见上表「桥接真实调用」一列（那里的调用方是测试脚本，按 OpenAI Chat Completions 协议收发）。

## 这次联调发现、需要改的

1. **Claude Code 失败原因不透明**：SDK 返回的结果里写着 `Not logged in · Please run /login`，网关却只报「Claude did not complete successfully」。应带出（脱敏、限长的）原因，并把未登录归为需要认证的错误。（已修正）
2. **桥接时智能体对调用方工具发权限请求**（Qoder）：这些工具是调用方自己提供、自己执行的，再让所有者批准一次没有意义，还会让无人值守的桥接卡住。应对来自 `oaa-caller` 中继的工具自动放行。（已修正）
3. **全零用量**（Qoder）：智能体上报的用量全是 0 时，应当按「未知」处理，而不是当成真的用了 0 个 token。（已修正）
4. **并行调用被拆成两轮**（agy）：见 [harness.md](harness.md) 的限制一节。
5. **ACP 里不能指定思考强度**（agy 把它作为独立选项声明）。

## 没有验证的

- 调用方回传慢于智能体自身 MCP 超时的情况。
- 跨机器（远程执行机器）上的任何真实调用。
- 需要登录或续费后才能测的：OpenCode、Grok Build、Claude Code。
- Cursor、Cline 等把 OAA 当作模型来调的真实客户端（本页的调用方证明走的是 MCP 入口）。

## 修正后的复验（同日）

- Qoder 桥接：不再出现所有者审批，进度里有一条 `permission_auto_allowed`，运行直接走到 `tool_calls` 并续接完成；用量为未知（响应里不再有编造的 0）。
- Claude Code：网关现在报 `adapter_auth_required`，消息里带出智能体的原话「Not logged in · Please run /login」。

## 端到端验证脚本 `examples/live-agents-acceptance.ts`（2026-11-13）

在进程内起一个只监听 `127.0.0.1` 随机端口的隔离网关（数据目录与智能体工作目录都在 `--out` 下，开启开发者平台），经真实 HTTP 跑 12 个场景：S1 Chat 非流式、S2 Chat 流式、S3 Responses 与续接、S4 Claude Messages、S5 Gemini、S6 审批（批准与拒绝）、S7 取消（按 PID 核对子进程退出）、S8 调用方工具桥接、S9 并发、S10 计费、S11 错误面、S12 收尾（残留子进程、秘密值扫描）。每个场景只调用一次智能体、不自动重试、有硬超时；引擎不支持的能力按文档的错误码记为「引擎不支持」，不算失败。

这些场景用 Node 内置的 `fetch` 讲四种线上格式（OpenAI Chat Completions 与 Responses、Claude Messages、Gemini `generateContent`），不用官方 SDK。与官方 SDK 的兼容性由兼容性实验室和 `test/compat-*-sdk.test.ts` 负责（见下文），它们用的是替身智能体。自 2026-11-14 起，场景代码与 `oaa verify` 共用（[cli.md](cli.md#自己验证一个智能体)）；`oaa verify` 运行其中适合在别人机器上跑的那一部分。下面 2026-11-13 的记录出自脚本的第一版，当时 Chat 与 Messages 场景用的是官方 `openai` 与 `@anthropic-ai/sdk` 客户端（`maxRetries: 0`）。现在这版场景在离线状态下对假 ACP 智能体跑过，没有对真实智能体重做。

```bash
npm run build
# 离线自检（仓库里的假 ACP 智能体 test/fixtures/acp-live-agent.mjs，无费用）
node dist/examples/live-agents-acceptance.js --agent fixture --out /新目录
# 真实智能体（会产生费用，必须显式确认；--out 必须是不存在的新目录）
node dist/examples/live-agents-acceptance.js --agent claude|codex|antigravity --executable /path/to/cli --confirm-live-cost --out /新目录 [--model default] [--only S1,S5] [--native-env inherit|allowlist] [--scenario-timeout-sec 300] [--agy-mode plan]
```

证据写到 `--out/report.json` 与 `--out/report.md`（场景表、「与文档不一致之处」、传给子进程的环境变量名——只有名字）。报告不含任何密钥，智能体输出只保留前 300 个字符；退出码按有无失败场景设置。对 Antigravity 的一次真实运行结果见下一节；Codex 与 Claude Code 尚未用这个脚本运行。装了其中之一的人可以运行 `oaa verify`，把报告附到 issue 里（[智能体验证报告](../../.github/ISSUE_TEMPLATE/agent_verification.md)模板）。

## 对 Antigravity 的端到端验证（2026-11-13）

用上面的脚本，对真实的 Antigravity（`agy`，模型 `gemini-3.8-flash-low`）跑了一次：隔离网关、`127.0.0.1` 随机端口、临时工作目录，每个场景只调用一次、不自动重试，共 12 次真实调用。

| 场景 | 结果 | 观测 |
| --- | --- | --- |
| S1 OpenAI Chat 非流式（官方 SDK，`sk-oaa-` 密钥） | 通过 | 12.5 秒；回答正确；`usage` 有值 |
| S2 OpenAI Chat 流式 | 通过 | 首个增量 7.4 秒才到，共 2 个增量：这个引擎在结束时一次给出，不是逐步输出 |
| S3 Responses 与 `previous_response_id` 续接 | 通过 | 第二轮答出了第一轮的暗号，续接到同一会话 |
| S4 Claude Messages 非流式与流式（官方 SDK） | 通过 | |
| S5 Gemini `generateContent` | 通过 | |
| S6 审批 | 引擎不支持 | 没有待审批项；任务以 `permission_denied` 失败，文件没有被写入，与文档一致 |
| S7 取消 | 通过 | 取消后子进程退出；状态 `interrupted`、`effect_outcome_unknown` |
| S8 调用方工具桥接 | 引擎不支持 | `client_tools_bridge_unsupported`，没有创建任务 |
| S9 并发 3 个任务 | 通过 | 12.6 秒，互不串话 |
| S10 计费 | 未能验证 | 账号密钥不能调用外部智能体（`isolation_required`），不扣点，所以成功路径没有走到 |
| S11 错误面 | 通过 | |
| S12 收尾检查 | 一项未过 | 记录与日志里没有泄露密钥；但留下 1 个残留进程，见下 |

另外观察到：

- 残留的是 `agy --bg-updater`（Antigravity 自己的后台更新程序，父进程为 1）。它由 `agy` 派生并脱离进程组，网关按进程组结束任务时管不到它。所以「任务结束后没有残留进程」对外部智能体不能保证。
- Antigravity 每次调用的输入约 1.3 万 token（它自带的系统提示），与任务长短无关。
- 开发者平台的账号密钥是 workspace 级，外部智能体需要 host 级，会被拒绝；这是有意的隔离，所以目前平台上能上架计费的只有内置智能体。

**没有验证的**：审批与调用方工具桥接（这个引擎不支持）；计费的成功路径（被隔离拦下）；Codex、Claude Code 的真实运行；内置内核智能体配真实模型；公网与反向代理环境。

## CI 里的自动检查（2026-11-14）

下面这些是在公开仓库一个开发分支上的 GitHub Actions 里，用后来成为 0.0.65 的代码跑的。它们都不涉及真实智能体、真实模型提供方或账号：用的是确定性夹具与替身智能体。

| 检查 | 运行了什么 | 结果 | 它说明什么、不说明什么 |
| --- | --- | --- | --- |
| Linux 与 macOS 上的完整离线测试，Node 24 与 26 | `ci.yml`：在 `ubuntu-latest` 与 `macos-latest` 上各用 Node 24 和 Node 26 跑 `npm run verify`（类型检查、格式检查、全部测试） | 四项全部通过 | 代码在 `engines` 的两条 Node 线、这两个系统上表现正常 |
| Windows 上的完整测试 | `windows.yml`：在 `windows-latest`、Node 24 上跑 `node scripts/test-offline.mjs --all --isolate`：每个测试文件一个进程；只在 POSIX 上有意义的测试带明确原因跳过 | 通过（约 10 分钟） | 经 `PATHEXT` 发现命令、`.cmd` 启动器、结束整棵进程树、命名管道、文件权限与命令行，在 Windows 运行器上对着测试替身工作正常。没有在 Windows 上用真实的 Codex、Claude Code 或 Antigravity 运行过；Node 26 上的 Windows 作业只跑类型检查、格式检查与打包相关的测试 |
| Windows 发布包 | v0.0.64 的发布工作流在 Windows 运行器上：zip 解压到含空格与中文的路径，经 `oaa.cmd` 启动，`/healthz` 报告了版本 | v0.0.64 的包通过 | 0.0.65 的 Windows 包还没有走过这条工作流（见下面的发布包烟雾测试） |
| Docker 镜像 | `docker.yml`：构建 amd64 镜像，再跑容器烟雾测试（首次启动、密钥文件、一次 API 调用、日志里没有密钥、Host 检查、重启、`docker stop` 退出码为 0） | 在 `ubuntu-latest` 上通过 | Dockerfile 能构建，容器配合离线示例智能体工作正常。没有运行的：arm64 镜像、推送到 ghcr（这两步只在发布 Release 时进行）、任何智能体命令行（容器里没有） |
| 兼容性实验室 | `compat.yml`（每次 push 与 pull request，以及每周一次）：十一类软件包对着一个隔离网关运行（网关里是离线示例智能体和确定性夹具模型），并把十二个聊天客户端记录下来的请求形状回放给它 | 374 个场景通过、0 失败、4 个按设计不适用（客户端本来就做不到）、0 跳过：实际运行部分 244 个，回放部分 130 个 | 实际运行部分是真实的软件包经真实套接字；回放只说明网关接受客户端发来的请求、并以它能解析的形式回答，不说明整个应用可用。过程中没有真实模型或智能体。Cursor 未核实。各客户端的版本、证据等级与配置见 [compatibility.md](compatibility.md) |
| 开发者平台与外部智能体 | 离线的端到端测试，把示例智能体当作外部运行的上架项：逐项的 `host_execution` 开关、委派或故障转移链、并发调用、取消、拒绝审批、流式断开，以及每种情况下的扣费或退回 | 离线测试通过 | 对不上报用量的外部智能体，计费规则成立。真实外部智能体的计费成功路径（上面的场景 S10）仍然没有见到过 |
| 发布包烟雾测试 | `scripts/smoke-release.mjs` 与 `scripts/smoke-flow.mjs`，每个安装包都跑：启动器 `--help`、在含空格与中文的路径里 `init`、在随机端口 `serve` 并核对 `/healthz` 版本、`doctor` 把 Claude 引擎标为需要另行安装、用包内 Node 逐个 import `dist/src` 下的每个模块，然后 `quickstart`、在三种协议上各调用一次并由示例智能体回答、控制台页面与图标库、一个停在审批的任务经 API 批准、同样的流程经 `oaa approvals` 与 `oaa approve`、`oaa status`、第二次 `quickstart` 不重复创建任何东西，以及 `oaa stop` 释放端口且没有残留进程 | 第一部分在 v0.0.64 的发布工作流里跑过；其余是之后加的，还没有在发布运行器上跑过 | 包里带齐了需要的东西，第一次使用的人能从示例智能体得到回答。没有运行的：任何真实智能体 |

## 还没有任何检查覆盖的

- **真实的 Codex 与 Claude Code 端到端。** 自 2026-11-11 那次手工联调以来，对这两个的调用没有重做过，端到端脚本也没有对它们运行过。这包括图片交付：Codex 的 `localImage` 条目与 Claude Code 的图片块只是按厂商文档实现的（[images.md](images.md#验证状况)）。结构化输出的修复轮与调用方工具桥接用替身测试，没有用这两个真实智能体测过。
- **向真实的公网 HTTPS 端点投递事件回调。** 测试只用本机的明文 http 接收端；HTTPS 投递走同一段代码，但没有被覆盖（[webhooks.md](webhooks.md#限制与未覆盖的情况)）。
- **桌面应用，一次人工检查之外的部分。** 项目所有者于 2026-11-14 在一台 Apple 芯片的 Mac 上，用隔离方式打开了一个发布模式构建的 macOS 应用包（只做了一次），确认了五处：控制台直接是已连接状态、没有连接对话框；首次启动的一次性说明出现；刷新（⌘R）后仍然已连接（管理员密钥经 `sessionStorage` 交接）；「关于」里的版本号正确；菜单与对话框跟随系统语言（只看了所有者当前的系统语言）。没有验证的：端口被占用时的三种提示；系统语言两个方向的切换；同一数据目录第二次启动不再弹首次启动说明；应用崩溃后遗留网关的识别与复用；Intel 芯片的包；这个版本在正常的、非隔离安装下（数据目录在默认位置、端口 8787）的表现；Windows 启动器的双语提示（没有 Windows 机器，CI 里只有 PowerShell 语法检查）；审批通知。离线测试运行的是壳的纯逻辑（语言、端口与数据目录的处理、端口上是谁的网关、让控制台登录的页面脚本）。
- **Windows 与 Linux 上的真实智能体**、Linux 包与 `install.sh` 在发布运行器上的表现、arm64 的 Docker 镜像，以及从发布页安装的 npm tarball。
- **内置智能体配真实模型提供方**、反向代理后的公网部署、跨机器调用，以及 Cursor、Cline 等把网关当模型来调的客户端。
- **`oaa connect` 的模型提供方预设**（Ollama、OpenAI、Anthropic、DeepSeek 等）：它们的地址与差异对照各服务的文档核对过，测试用的是假服务；没有任何一个预设对着真实的模型服务运行过（[models.md](models.md)）。
- **真实 GitHub Pages 上的文档站点。** 生成器和它的链接检查是离线运行的；第一次部署就是它第一次露面。
- **压测测到的之外的长时间运行。** `npm run soak`（真实的网关进程、假模型、离线示例智能体）在 macOS 上跑过 32 分钟（带三次重启）和 62 分钟单段，并满足了它的判据。它没有覆盖持续许多小时的运行、真实的模型提供方或真实的智能体命令行；有一次 32 分钟的尝试里网关在 SIGKILL 之后约 110 秒才有回应，之后没有再出现，原因不明（[stability.md](stability.md#5-已知限制)）。
