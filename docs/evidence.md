# 实测证据：哪些智能体被真的转成了 Agent API

> 2026-11-11，在一台 macOS 机器上对本机已安装的真实智能体做的联调（2026-11-13 另有一次 Antigravity 的端到端验证，见本页末尾）。每一行都是实际执行并看到的结果；没有做过的写「未测」，失败的照实写失败原因。测试替身（协议级假智能体）的覆盖范围见 [adapters.md](adapters.md) 的转换契约，不计入本页。

## 结论（先说边界）

- **不能证明「所有智能体」都能转。** 能证明的是：一个智能体只要提供四种接入方式之一（内置原生、ACP、`oaa/1` 适配器、A2A），就能发布成 Agent API；本机装着的 7 个真实智能体里，4 个跑通了真实调用，另外 3 个卡在它们各自的账号状态上（未登录、密钥过期、自身配置锁），网关给出了明确的错误而不是含糊失败。
- **「其它智能体能使用这个 API」已用真实智能体证明一次**：Antigravity（Gemini 3.8 Flash）作为调用方，经 OAA 的 MCP 入口调用了由 Codex 充当的 `agent/codex`，拿回了正确结果。两层 Harness、两个不同的智能体、两家不同的模型。

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

在进程内起一个只监听 `127.0.0.1` 随机端口的隔离网关（数据目录与智能体工作目录都在 `--out` 下，开启开发者平台），用官方 `openai`、`@anthropic-ai/sdk` 与 `fetch` 经真实 HTTP 跑 12 个场景：S1 Chat 非流式、S2 Chat 流式、S3 Responses 与续接、S4 Claude Messages、S5 Gemini、S6 审批（批准与拒绝）、S7 取消（按 PID 核对子进程退出）、S8 调用方工具桥接、S9 并发、S10 计费、S11 错误面、S12 收尾（残留子进程、秘密值扫描）。每个场景只调用一次智能体、不自动重试（SDK `maxRetries: 0`）、有硬超时；引擎不支持的能力按文档的错误码记为「引擎不支持」，不算失败。

```bash
npm run build
# 离线自检（仓库里的假 ACP 智能体 test/fixtures/acp-live-agent.mjs，无费用）
node dist/examples/live-agents-acceptance.js --agent fixture --out /新目录
# 真实智能体（会产生费用，必须显式确认；--out 必须是不存在的新目录）
node dist/examples/live-agents-acceptance.js --agent claude|codex|antigravity --executable /path/to/cli --confirm-live-cost --out /新目录 [--model default] [--only S1,S5]
```

证据写到 `--out/report.json` 与 `--out/report.md`（场景表、「与文档不一致之处」、传给子进程的环境变量名——只有名字）。报告不含任何密钥，智能体输出只保留前 300 个字符；退出码按有无失败场景设置。对 Antigravity 的一次真实运行结果见下一节；Codex 与 Claude Code 尚未用这个脚本运行。

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
