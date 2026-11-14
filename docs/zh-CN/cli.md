# 命令行参考

[English](../cli.md) · 简体中文

`oaa` 是 Open Agent API 的命令行。本页按「你想做什么」分组列出每条命令，各附一句说明和一个例子。运行 `oaa`（或 `oaa --help`）可以得到同一份清单，语言跟随你的系统。
在源码检出目录里，把 `oaa` 写成 `npm run oaa --`。

- **语言。** 输出跟随系统区域；用 `OAA_LOCALE=zh` 或 `OAA_LOCALE=en` 固定语言。
- **错误。** 命令失败时在 stderr 打印 `error_code: message`（错误目录里有建议时再加一行 `Next:`），退出码为 1。错误码见 [protocol.md](protocol.md)。
- **网关和密钥从哪里来。** 要访问运行中网关的命令接受 `--url URL` 与 `--token-file FILE`；省略时使用环境变量 `OAA_GATEWAY_URL` 与 `OAA_TOKEN_FILE`，地址缺省为 `http://127.0.0.1:8787`。
  `connect`、`status`、`approvals`、`approve`、`deny` 与 `verify` 还能到本机数据目录（`--dir`，缺省 `.oaa`）里找：地址取自其中的 `config.json`，密钥是 `oaa init` 写下的所有者管理员密钥。要用别的密钥，就传 `--token-file`。
- **密钥从不打印。** 创建密钥的命令把密钥写进私有文件（权限 0600）。

## 目录

1. [启动并照看本机网关](#启动并照看本机网关)
2. [接上你装好的智能体](#接上你装好的智能体)
3. [在终端里处理审批](#在终端里处理审批)
4. [事件回调](#事件回调)
5. [自己验证一个智能体](#自己验证一个智能体)
6. [密钥与调用身份](#密钥与调用身份)
7. [编写并发布智能体](#编写并发布智能体)
8. [调用智能体并读取结果](#调用智能体并读取结果)
9. [执行节点](#执行节点)
10. [MCP 与集成](#mcp-与集成)
11. [共享一个网关](#共享一个网关)

## 启动并照看本机网关

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa quickstart [--dir .oaa] [--port 8787]` | 初始化数据目录，在后台启动网关，发布离线示例智能体 `agent/sample`，创建调用方密钥并完成第一次调用；可重复运行。 | `oaa quickstart --port 18787` |
| `oaa init [--dir .oaa]` | 创建带 `config.json` 与管理员密钥文件 `admin.token` 的数据目录；已安装的智能体命令行会被记为停用。 | `oaa init --dir ./gateway-data` |
| `oaa serve [--config .oaa/config.json] [--dir DIR] [--detach] [--tool-config FILE]...` | 运行网关（加 `--detach` 在后台运行，并写下 `server.pid`）；`--tool-config` 把准备好的 MCP 工具绑定加到本机 worker。 | `oaa serve --detach` |
| `oaa stop [--config .oaa/config.json]` | 停止由 `oaa serve --detach` 启动的网关，停之前先确认 `/health` 报告的就是那个进程。 | `oaa stop` |
| `oaa status [--dir .oaa] [--url URL] [--token-file FILE] [--json]` | 对「我的网关怎么样了」给出一份只读的回答：地址、版本、进程 ID、运行时长、数据目录与数据库大小、已发布的智能体以及各自现在能不能运行（不能时给原因）、本机找到但还没接上的智能体、运行中、排队中与等待审批的任务、最近失败的任务及其错误码、密钥数量，以及本地配置里的安全档位（当网关看起来能被外部访问、档位却还是 `local` 时多一行警告，与 `oaa doctor` 的 `security_exposure` 字段是同一个检查）。网关没在运行时退出码为 1。 | `oaa status` |
| `oaa doctor [--config .oaa/config.json] [--write]` | 报告哪些智能体命令行与 ACP 智能体已安装、配置里有什么，以及数据库大小（超过 `retention.warnDatabaseMb`，默认 1024 MB 时给出提示）；什么都不执行。`--write` 把新发现的 ACP 智能体记为停用的适配器。 | `oaa doctor --write` |
| `oaa prune [--older-than 30d] [--dry-run] [--vacuum] [--config .oaa/config.json]` | 删除早于指定时长（`30d`、`12h`、`45m`、`90s`；默认 `30d`）的已结束运行，连同它们的事件、产物和没人再引用的上传文件；网关停止时还会清扫旧的会话工作区。`--dry-run` 只统计不删除。网关在运行时经 `POST /v1/maintenance/prune`（管理员密钥）执行；`--vacuum` 需要先停止网关。排队、执行中、等待审批和 interrupted 的运行一律不动。见 [stability.md](stability.md#4-数据保留与-oaa-prune)。 | `oaa prune --older-than 30d --dry-run` |

`status` 只读。某个密钥读不了某一部分时（例如密钥列表需要管理员密钥），其余部分照常给出，并注明缺了哪一部分。`--json` 以 JSON 输出同样的事实。

## 接上你装好的智能体

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa connect NAME [--dir .oaa]` | 检测 `codex`、`claude`、`agy` 或某个 ACP 智能体（预设名或适配器名），在运行中的网关上启用它，发布为 `agent/NAME`，确认调用方密钥能调用它，并打印一条可以试的 `curl`。不会调用这个智能体。 | `oaa connect codex` |
| `oaa connect [--dir .oaa]` | 不带目标时：列出本机找到的外部智能体和所有模型预设，并给出下一步该敲的命令。 | `oaa connect` |
| `oaa connect PRESET [--model M] [--key-env NAME \| --key-file FILE] [--base-url URL] [--agent agent/assistant] [--name NAME] [--definition FILE.oaa] [--test] [--dir .oaa]` | 给内置智能体接上模型：探测本地服务（只限本机回环地址），把提供方写进配置（只存密钥的引用；相同的条目跳过，不同的条目拒绝覆盖），只在这个数据目录自己启动了网关时才重启它，发布 `agent/assistant`，确认调用方密钥可用，并打印一条 `curl`。从不调用模型；`--test` 只发一次最小请求，且只对本机地址的端点。预设与密钥见 [models.md](models.md)。 | `oaa connect deepseek --key-file ~/.config/deepseek.key` |
| `oaa models [--dir .oaa] [--check] [--json]` | 列出已配置的模型提供方：协议、端点、密钥的引用能不能解析、端点有没有回应（本机地址自动探测，托管服务只有加 `--check` 才探测，而且只请求模型列表），以及哪些智能体在用它。 | `oaa models --check` |
| `oaa publish-native --id ID --engine ENGINE [--models default] [--approvals ask\|auto] --url URL --token-file FILE` | 把一个内置引擎（`codex`、`claude`、`antigravity`、`dsh`）或一个已启用的适配器（`adapter/NAME`）发布为智能体。`--approvals auto` 让这个智能体的权限请求按策略批准，而不是等你。 | `oaa publish-native --id agent/codex --engine codex --url http://127.0.0.1:8787 --token-file .oaa/admin.token` |
| `oaa expose ENGINE\|definition.oaa [--models default] [--approvals ask\|auto] [--id ID] [--dir DIR] [--detach] --url URL --token-file FILE` | 在本机把一个智能体命令行作为（可能是远程）网关的执行节点运行，并在那个网关上发布它。 | `oaa expose codex --detach --url https://gw.example.com --token-file admin.token` |

## 在终端里处理审批

在没有控制台的服务器上，需要你决定的任务会停在「等待审批」。下面的命令和控制台用的是同一套接口（`GET /v1/runs`、`GET /v1/runs/{id}/actions`、`POST /v1/runs/{id}/actions/{action}`）。

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa approvals [--watch] [--json] [--dir .oaa]` | 列出所有待处理的审批：运行 ID、智能体、动作 ID、何时过期，以及对所请求操作的一行摘要。加 `--watch` 会持续轮询（每 2 秒一次），每个新出现的待办只打印一次，Ctrl+C 结束。加 `--json` 输出 JSON（监视时每行一个对象）。 | `oaa approvals --watch` |
| `oaa approve RESPONSE_ID [--action ACTION_ID] [--all] [--yes] [--dir .oaa]` | 批准一个运行的待办。 | `oaa approve resp_0123 --action approval_4567` |
| `oaa deny RESPONSE_ID [--action ACTION_ID] [--all] [--reason TEXT] [--dir .oaa]` | 拒绝它们。运行随后以 `permission_denied` 失败。`--reason` 随审批记录保存，不会发给智能体。 | `oaa deny resp_0123 --reason "not on production"` |

行为：

- **先打印操作。** 在做出任何决定之前，`approve` 与 `deny` 先打印要决定的是什么（类型、运行，以及这个请求完整的、有长度上限的详情）。
- **有多个待办时。** 一个运行可以同时有不止一个待办。对这样的运行，不带 `--action` 或 `--all` 就什么都不决定，命令以 `approval_ambiguous` 失败并列出各项。`--action ID` 决定其中一项，`--all` 决定这个运行的所有项。没有待办的运行以 `approval_not_found` 失败。
- **交互与否。** 在终端里，`approve` 打印完操作后会问 `[y/N]`（`--yes` 跳过这个问题；`deny` 从不询问；回答 no 则什么都不决定，并以 `approval_declined` 失败）。当 stdin 或 stderr 不是终端（管道、脚本、cron）时不会询问，命令立即做出决定；结果看退出码（所有项都已决定为 0，否则为 1）。`--json` 打印每一项的结果。
- **调用你自己的工具不是审批。** 一个在等调用方工具结果（`client_tool`）的运行，既不会在这里列出，也不能在这里决定；结果由调用方回传（见 [harness.md](harness.md)）。
- **权限就是接口的权限。** 做决定需要带 `approve` 范围的密钥（管理员密钥有）并有权访问这个智能体。用 `oaa key create --approve` 创建的调用方密钥可以决定它能看到的运行；没有这个范围的密钥会在一开始就被拒绝，提示怎么修，什么都不会发出。已过时的待办（已被决定或已过期）会在那一项上报告为失败。

## 事件回调

运行事件（完成、失败、等待审批等）可以推送到你的一个 HTTPS 端点，带签名并会重试，见 [webhooks.md](webhooks.md)。这些命令需要所有者管理员密钥，找网关和密钥的方式与 `approvals` 相同（`--dir`、`--url`、`--token-file`）。都接受 `--json`。

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa webhook add URL [--event EVENT]... [--agent AGENT]... [--include-output] [--out SECRET_FILE]` | 添加一个端点。`--event`（可重复）从 `run.requires_action`、`run.completed`、`run.failed`、`run.cancelled`、`run.incomplete`、`run.interrupted` 里选事件（缺省为全部）；`--agent` 把它限定到某些智能体；`--include-output` 在运行事件里附上最终输出（至多 32 KiB）。签名密钥只打印一次；用 `--out` 则写进一个新文件（权限 0600），不打印。 | `oaa webhook add https://hooks.example.com/oaa --event run.completed --out webhook.secret` |
| `oaa webhook list` | 列出端点及其事件、智能体、状态（`ok`、`failing`、`disabled`）、排队中的投递、连续失败次数与最近一次投递。 | `oaa webhook list` |
| `oaa webhook remove ID` | 删除一个端点及其排队中的投递。 | `oaa webhook remove wh_0123` |
| `oaa webhook test ID` | 排入一个 `webhook.test` 事件，最多等 15 秒让第一次尝试发生并打印出来；失败时退出码为 1。 | `oaa webhook test wh_0123` |
| `oaa webhook deliveries ID [--limit 20]` | 最近的投递，新的在前：事件、状态、HTTP 状态、耗时、尝试次数与最后一个错误。 | `oaa webhook deliveries wh_0123` |

启用、停用、修改过滤条件、轮换密钥与重新投递要通过接口完成（`PATCH /v1/webhooks/{id}`、`POST /v1/webhooks/{id}/rotate-secret`、`POST /v1/webhooks/{id}/deliveries/{delivery}/redeliver`）。

## 自己验证一个智能体

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa verify AGENT [--model default] [--scenarios LIST] [--out DIR] [--executable PATH] [--timeout-ms 300000] [--dir .oaa] [--json]` | 打印计划：哪些场景、会对智能体做多少次真实调用、你的机器上会发生什么。什么都不运行。 | `oaa verify codex` |
| `oaa verify AGENT ... --confirm-live-cost` | 运行这些场景，把 `report.json` 与 `report.md` 写到 `--out`（缺省为当前目录下的 `oaa-verify-AGENT-TIME`，这个目录必须还不存在）。 | `oaa verify codex --confirm-live-cost` |

`AGENT` 与 `oaa connect` 接受的相同（`codex`、`claude`、`agy`、某个 ACP 预设名或适配器名），或者是已发布的 ID `agent/NAME`。程序通过本地配置查找，再到 `PATH` 里找；对内置引擎可以用 `--executable` 覆盖。

**它运行什么。** 在命令自己的进程里起一个隔离的网关（127.0.0.1、随机端口，数据与智能体的工作目录都在一个临时目录里，结束时删除）。你自己的网关、数据目录和密钥不会被读取或改动。场景（用 `--scenarios chat,approvals` 或 `S1,S6` 选择；缺省为全部，免费的 `cleanup` 检查总会运行）：

| 键 | ID | 智能体调用次数 | 检查什么 |
| --- | --- | --- | --- |
| `chat` | S1 | 1 | OpenAI Chat Completions，非流式。 |
| `chat-stream` | S2 | 1 | 同样，带 `stream: true`：增量如何到达、最后一帧。 |
| `responses` | S3 | 2 | OpenAI Responses 与 `previous_response_id` 续接。 |
| `claude-messages` | S4 | 2 | Claude Messages，非流式与流式。 |
| `gemini` | S5 | 1 | Gemini `generateContent`。 |
| `approvals` | S6 | 2 | 需要审批的任务：批准后继续；拒绝后以 `permission_denied` 失败。 |
| `cancel` | S7 | 1 | 一个后台任务被取消；它的子进程必须退出。 |
| `client-tools` | S8 | 1 | 智能体调用调用方提供的工具，并带着结果继续。 |
| `concurrency` | S9 | 3 | 三个任务同时进行，答案不串。 |
| `errors` | S11 | 0 | 三种线上格式上的错误密钥、无权限与格式错误的请求体。 |
| `cleanup` | S12 | 0 | 没有残留的子进程或密钥。 |
| `usage` | S13 | 0 | 前面的响应有没有上报 token 用量（推导得出，不调用）。 |

每个场景的结论是 `pass`、`FAIL`、`unsupported`（引擎按文档所述不提供这项能力）或 `skipped` 之一。不做任何重试，一个场景失败也不会让其他场景停下，每个场景都有硬性超时（`--timeout-ms`）。Ctrl+C 会干净地结束：运行中的任务被取消，智能体进程被停掉，剩下的场景标为 `skipped`，仍会写出一份不完整的报告（退出码 130）。退出码：没有失败为 0，有场景或准备工作失败为 1。

**真实调用要花钱。** 每个场景都会向智能体发送真实的提示，使用智能体自己的登录与额度，权限是你在这台机器上的权限；审批场景会让它在临时目录里创建一个文件。不带 `--confirm-live-cost` 时什么都不会启动。在跑场景之前，会先不带提示地启动一次智能体（ACP 的 `initialize` 握手，或 `--version`），读取它自报的名称与版本；这一步不调用模型。

**报告**包含网关版本、智能体的名称与自报版本、操作系统与架构、Node.js 版本、每个场景的结果、耗时与失败原因，以及与 [adapters.md](adapters.md) 的差异。写出之前会先脱敏：密钥与令牌、你的用户名、主机名、主目录与其他本地路径、电子邮件与局域网地址都会被去掉。发出去之前请自己读一遍 `report.md`；[智能体验证报告](../../.github/ISSUE_TEMPLATE/agent_verification.md)的 issue 模板会要求提供它。

同一批场景也是 `examples/live-agents-acceptance.ts`（产生 [evidence.md](evidence.md) 里 Antigravity 证据的那个脚本）的基础，那个脚本有自己的命令行。

## 密钥与调用身份

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa key create --name NAME [--agent AGENT]... [--approve] [--out FILE] --url URL --token-file ADMIN_TOKEN` | 为指定的智能体（缺省为全部）创建一个调用方密钥（范围 `invoke`、`read`、`files`；加 `--approve` 再加 `approve`），并写进一个私有文件。 | `oaa key create --name ci --agent agent/codex --approve --token-file .oaa/admin.token` |
| `oaa me --url URL --token-file FILE`（别名 `whoami`） | 显示这个密钥是谁：所有者、范围、已授权的智能体、额度与实时用量。 | `oaa me --token-file .oaa/keys/ci.key` |

## 编写并发布智能体

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa check definition.oaa` | 检查一份 `.oaa` 源文件，打印诊断与工作流计划；无效时退出码为 1。 | `oaa check examples/research.oaa` |
| `oaa fmt definition.oaa [--out FILE]` | 打印格式化后的源码（或写成新文件）；注释不会保留。 | `oaa fmt a.oaa --out formatted.oaa` |
| `oaa decompile definition.json [--out FILE]` | 把一份定义 JSON 转成 `.oaa` 源码。 | `oaa decompile agent.json --out agent.oaa` |
| `oaa build definition.oaa\|definition.json [--skill DIR]... [--tool-binding FILE]... --out bundle.json` | 不连接网关，构建一个可审阅的包文件。 | `oaa build a.oaa --skill ./skills/research --out bundle.json` |
| `oaa publish definition.oaa\|definition.json [--skill DIR]... [--tool-binding FILE]... --url URL --token-file FILE` | 一步完成构建与发布。 | `oaa publish examples/research.oaa --token-file .oaa/admin.token` |
| `oaa publish-bundle BUNDLE.json --url URL --token-file FILE` | 发布你审阅过的包，不添加任何内容。 | `oaa publish-bundle bundle.json --token-file .oaa/admin.token` |

## 调用智能体并读取结果

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa agents [--offset 0] [--limit 20] [--revision REVISION]` | 分页浏览已发布智能体的目录。 | `oaa agents --limit 5` |
| `oaa agent AGENT [--section overview\|routes\|tools\|skills] [--offset N] [--limit N] [--agent-version DIGEST]` | 显示一个智能体。 | `oaa agent agent/codex --section routes` |
| `oaa agent AGENT [--agent-version DIGEST] --out NEW_FILE` | 下载这个智能体完整的公开元数据（文件必须还不存在）。 | `oaa agent agent/codex --out codex.json` |
| `oaa catalog [--cursor CURSOR] [--limit 32] [--timeout-ms 20000]` | 长轮询目录的变更流。 | `oaa catalog --limit 10` |
| `oaa preview AGENT [--model auto] [--agent-version DIGEST] [--file-id ID]... [--previous-response-id ID]` | 显示一次调用会怎么选路，但不运行它。 | `oaa preview agent/codex` |
| `oaa invoke AGENT --input TASK [--model auto] [--agent-version DIGEST] [--file-id ID]... [--previous-response-id ID] [--idempotency-key KEY]` | 启动一个后台任务并打印它的运行 ID。 | `oaa invoke agent/sample --input "hello"` |
| `oaa get RESPONSE_ID` | 打印这个运行的状态。 | `oaa get resp_0123` |
| `oaa wait RESPONSE_ID [--timeout-ms 20000]` | 等这个运行改变状态（最多等到超时）。 | `oaa wait resp_0123` |
| `oaa output RESPONSE_ID [--cursor CURSOR] [--max-bytes 8000]` | 一页一页地读这个运行的输出。 | `oaa output resp_0123` |
| `oaa artifacts RESPONSE_ID [--offset 0] [--limit 10]` | 列出这个运行产生的文件。 | `oaa artifacts resp_0123` |
| `oaa cancel RESPONSE_ID` | 取消一个运行。 | `oaa cancel resp_0123` |
| `oaa resume RESPONSE_ID` | 恢复一个被中断的运行。 | `oaa resume resp_0123` |
| `oaa upload SELECTED_FILE [--allowed-node NODE]...` | 上传你选定的一个文件并打印它的文件 ID。 | `oaa upload report.pdf` |
| `oaa download FILE_ID --out NEW_FILE` | 下载一个文件；已有的文件绝不会被覆盖。 | `oaa download file_0123 --out result.txt` |

## 执行节点

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa node join --config worker.json [--tool-config FILE]...` | 让这台机器作为执行节点连接到一个网关。 | `oaa node join --config worker.json` |
| `oaa nodes` | 列出节点注册。 | `oaa nodes` |
| `oaa node drain\|resume\|revoke NODE_ID [--reason TEXT]` | 不再给一个节点派新活、恢复派活，或吊销它。 | `oaa node drain laptop --reason maintenance` |
| `oaa node history NODE_ID [--cursor EVENT_ID] [--limit 50]` | 显示一个节点的审计历史。 | `oaa node history laptop` |

## MCP 与集成

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa mcp --url URL --token-file FILE` | 经 stdio 把网关提供给一个 MCP 客户端。 | `oaa mcp --token-file .oaa/admin.token` |
| `oaa mcp inspect --config worker.json --server NAME [--tool NAME] [--cursor CURSOR]` | 列出配置在 worker 上的一个 MCP 服务器的工具。 | `oaa mcp inspect --config worker.json --server files` |
| `oaa mcp prepare --config worker.json --server NAME --tool NAME --capability private/name --out NEW_DIRECTORY [--name N] [--version V] [--effect E] [--approval A] [--export-result] [--optional]` | 为一个 MCP 工具准备一份可审阅的能力绑定。 | `oaa mcp prepare --config worker.json --server files --tool read --capability private/read --out ./prepared` |
| `oaa integration --out FILE --token-file FILE [--url URL]` | 写出一份启动 `oaa mcp` 的 MCP 客户端配置（`mcpServers`）；不安装任何东西。 | `oaa integration --out mcp.json --token-file .oaa/admin.token` |

`oaa mcp-relay` 由 ACP 智能体根据它们的会话配置启动，不是给人用的。

## 共享一个网关

| 命令 | 作用 | 示例 |
| --- | --- | --- |
| `oaa tunnel [URL\|none] [--public-url URL] [--detach] --url URL --token-file FILE` | 登记网关的公开 Base URL；没有给时，若装了 `cloudflared` 就打开一条 HTTPS 隧道。`none` 清除这项设置。 | `oaa tunnel --public-url https://agents.example.com --token-file .oaa/admin.token` |
