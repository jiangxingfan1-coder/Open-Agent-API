# 操作手册

[English](../operations.md) · 简体中文

本文收录命令行与接口的操作细节：发布与调用、调用前查看选路、导出已安装的智能体、MCP 入口、目录变更通知、查看与恢复请求、导入选定的 MCP 工具、执行机器、验证命令。内容从 0.1.0 的 README 原样搬来，README 只留入口。

协议字段见 [protocol.md](protocol.md)，架构依据见 [architecture.md](architecture.md)。

> 本页各节的标题前带有与英文版相同的英文锚点（例如 `#local-start`、`#workers`），所以其他文档用英文锚点链接到这里也能对上。

## 速览：随意切换智能体、更稳的内核、更好写的语法

下面这些能力的完整说明在 `docs/protocol.md`、`docs/language.md` 和 `docs/architecture.md`。

**换一个智能体接着干。** 一个请求完成后，可以让另一个智能体在同一个会话里继续，它会先看到之前的对话和文件：

```json
{ "protocol": "oaa/1", "agent": "agent/codex", "input": "按这个方案实现",
  "previous_response_id": "resp_...", "handoff": true }
```

用 OpenAI 兼容接口时不改请求结构，写在元数据里：`"metadata": {"oaa.handoff": "true"}`。控制台里，已完成的请求有「接着做」按钮，可以直接选由谁继续。

**主力不行时自动换备选。** 提交时给出备选智能体，主力还没开始做事就失败（比如连不上模型）时，同一个请求会改由备选完成，不需要调用方重试：

```json
{ "metadata": { "oaa.agent_fallback": "agent/backup,agent/last" } }
```

已经有输出或已经执行过步骤的任务不会换人重做，避免把同一件事做两遍。

**调用方自己也是智能体时。** Cursor、Cline、Claude Code 之类的工具把 OAA 当模型来调，还会带上它们自己的 `tools`。缺省（`auto` 模式）下，网关把这些工具交给能接管它们的智能体（内核智能体，或 ACP 外部智能体）：智能体要用调用方的工具时，以标准 `tool_calls`（Chat Completions、Responses、Claude Messages、Gemini）交回调用方执行，结果回传后同一个运行接着做；响应头 `X-OAA-Client-Tools: bridge` 会明说。接管不了的智能体（Codex、Claude Code、Antigravity、A2A、HTTP 适配器）照旧：兼容端点、Claude 与 Gemini 让它用自己的工具完成（`X-OAA-Client-Tools: ignored`），OpenAI 默认端点则拒绝，并在信息里写明三条出路。`X-OAA-Client-Tools: managed | bridge | reject | auto` 显式选择，网关设置 `clientTools.default` 改变「什么都没选」的请求得到什么（`managed` 恢复 `auto` 之前的行为）。模式与支持情况见 [docs/harness.md](harness.md)。

**一键启用电脑上已有的智能体。** 控制台「执行机器」页的「支持的智能体」里，已安装的会显示「启用」按钮；点一下就能用，不需要改配置文件，也不需要重启。之后再「发布」成可调用的智能体。

**流程里的每一步可以重试、可以限时。**

```text
flow "load" {
  params { path: string }
  step doc = read_file(path = $input.path) retry(2, backoff=200ms) timeout 30s fallback = "missing"
}
```

只允许用在重复执行无害的工具上；用在普通写入上会在检查时直接报错。

**语法更好写、更好查错。** 支持 `type Doc = { path: string }` 这样的类型别名；写错关键字会提示最接近的写法（`Did you mean 'description'?`），多处拼写错误一次全部报出；`oaa fmt` 输出的是和人手写一样的简洁写法。

**内核更快。** 同一批到达的流式文本合并成一次落盘，长短混合的工具批次不再等最慢的那个。数据安全级别和线上输出的每个字节都没有变化；基准数字和测量方法见 `docs/architecture.md`。

<a id="local-start"></a>
## 本机启动

需要 Node.js 24.18 及以上的 24 或 26 版本线。不需要 Docker、Redis，也不需要全局安装任何包。

```sh
npm ci --omit=optional --ignore-scripts
npm run build
npm run oaa -- init
npm start
```

打开[控制台](http://127.0.0.1:8787)。在连接设置里选择 `.oaa/admin.token`。不要分享这把管理员密钥。为每个调用方应用各创建一把限定范围的 API 密钥。令牌以受限权限保存在本地，不嵌入 URL。

生成的配置是 `.oaa/config.json`。原生可执行文件会被发现，但在你到控制台的**执行机器**页显式启用之前是**停用**的。macOS 桌面应用是例外：为了开箱即用，它在启动时会启用检测到的本机原生智能体（网关只监听 `127.0.0.1`）；在控制台里停用某一个，会记在本地数据库里，之后的启动以这个记录为准。`oaa quickstart` 只添加并启用离线示例智能体 `adapter/oaa-sample`（`examples/sample-agent.mjs`，不调用任何模型），新发现的 codex / claude / agy 记为停用。开关只保存在本平台的本地数据库里，不会修改原生应用的全局配置。模型凭据是 worker 上的环境变量引用，不会提取或修改已有应用的任何凭据。

要用受管的本地后台进程：`npm run oaa -- serve --detach`。它的 PID 和日志在配置的数据目录里。默认端口是 8787；被占用时，在你自己的配置里修改 `port`。用 `npm run oaa -- stop` 停止（它只向 `/health` 报告的那个 PID 发信号）。不用控制台也能创建调用方密钥：`npm run oaa -- key create --name myapp --agent agent/codex --url URL --token-file .oaa/admin.token`；密钥写入 `.oaa/keys/myapp.key`（权限 0600），不会打印出来。

<a id="publish-and-invoke"></a>
## 发布与调用

在你自己的配置和智能体定义里设置提供方与模型。`examples/research.agent.json` 里特意放的是模型占位符，而不是一个编造出来的可用连接。

```sh
npm run oaa -- publish examples/research.agent.json \
  --skill /absolute/path/to/a/selected/skill \
  --url http://127.0.0.1:8787 --token-file .oaa/admin.token

npm run oaa -- publish-native --id agent/codex --engine codex \
  --models default,gpt-model-you-have-access-to \
  --url http://127.0.0.1:8787 --token-file .oaa/admin.token

# 无人值守：它的权限请求自动批准（风险见下）
npm run oaa -- publish-native --id agent/codex-auto --engine codex --approvals auto \
  --url http://127.0.0.1:8787 --token-file .oaa/admin.token

npm run oaa -- invoke agent/codex --model auto --input 'Your task' \
  --url http://127.0.0.1:8787 --token-file /path/to/scoped.token
```

`--approvals auto` 让智能体的权限请求（命令、文件修改、工具调用）由策略批准，而不是等 owner 来批；每一次仍会留下记录（`actor: "policy:auto"`）。这等于让调用方以你在这台机器上的权限驱动这个智能体。给这样的智能体单独发一把只限定它的 API 密钥，只对受信的调用方开放，并尽可能使用沙箱执行等级。见 [protocol.md](protocol.md#approval-policy-for-external-agents-approval-policy-v1)。

原生后端上的 `default` 表示保留它已配置的模型。模型别名由 owner 声明，不证明对上游账号有访问权。自动选路只从已发布且合格的路线里选，依据是配置的优先级、观测到的延迟、失败与冷却。续接的会话保留它的路线和能力包版本；换模型需要新会话。它不会在一次结果不确定的操作进行到一半时切换模型。

标准的 OpenAI SDK 用法：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=YOUR_SCOPED_KEY)
response = client.responses.create(
    model="agent/research", input="Analyze the supplied sources.",
    metadata={"oaa.model": "auto"}, background=True,
)
result = client.responses.retrieve(response.id)
```

显式的原生协议是 `POST /v1/invoke`：

```json
{
  "protocol": "oaa/1",
  "agent": "agent/codex",
  "model": "auto",
  "input": "Your task",
  "background": true
}
```

支持的字段、文件上传、流式、审批、续接与取消见[协议与兼容](protocol.md)。

<a id="inspect-routing-before-execution"></a>
## 调用前查看选路

```sh
npm run oaa -- preview agent/codex --model auto \
  --url http://127.0.0.1:8787 --token-file /path/to/scoped.token
```

控制台在智能体对话框里给出同样的只读预览。它报告合格的节点、文件放置、原生模型映射、不可用的工具、针对目标的冷却，以及观测到的与估计的延迟。这不会启动模型，也不会预留容量。

要固定已审阅的发布版本，在 `/v1/invoke` 上用 `agent_version`，在 OpenAI 兼容请求上用 `metadata["oaa.agent_version"]`，在 CLI 里用 `--agent-version <digest>`。控制台的预览与提交都使用所显示的版本。

标了 `required: true` 的工具绑定，必须在请求被接受之前就有合格的执行者；否则请求在使用模型之前就被拒绝。没有标记的绑定为了兼容仍是可选的：不可用的工具会被报告，并从本次模型请求中省略，而不是悄悄声称已经加载。原生智能体仍使用它们原有的宿主工具集，而不是可移植的内核绑定。

<a id="export-an-installed-agent"></a>
## 导出已安装的智能体

```sh
npm run oaa -- expose codex --models default --detach \
  --url http://127.0.0.1:8787 --token-file .oaa/admin.token
```

这个显式命令会登记一个专用的 worker，只启用所选的原生适配器，并发布一个绑定到该节点的智能体。它不发起任何模型请求。它的私有配置、凭据、PID 与日志保存在 `.oaa/exposed/<engine>/` 下。被调用时它会打开一个新的、归它所有的智能体会话；不会接管桌面上已有的对话。管理员密钥只用于设置，之后分发限定范围的调用密钥。`expose dsh` 起初使用它原生的默认模型；额外的模型路线需要显式的 profile 覆盖映射。

<a id="mcp-and-plugin-entry"></a>
## MCP 与插件入口

```sh
npm run oaa -- integration --out /absolute/path/to/mcp.json \
  --url http://127.0.0.1:8787 --token-file /absolute/path/to/scoped.token
```

这会按常见的 `mcpServers` 约定生成 MCP 启动器 JSON，可执行文件使用绝对路径。具体的宿主可能需要它自己的配置格式；这个命令**不会**覆盖任何智能体的全局配置。随附的[技能](../../integrations/open-agent-api/SKILL.md)可以安装到调用方已有的技能 / 插件系统里。我们用真实的 stdio MCP 客户端对生成的启动器做过测试，而不只是进程内传输。

MCP 的任务工作流是 `oaa_upload_text`（可选）、`oaa_preview_route`、`oaa_invoke`、`oaa_wait_run`，然后是 `oaa_read_output` 与 `oaa_list_artifacts`。另有 `oaa_list_agents`、精简的 `oaa_get_run`、`oaa_cancel`，以及仅管理员可用的 `oaa_publish` / `oaa_publish_native`。同一个预期任务的重试，复用一次调用的 `idempotency_key`。取消一次等待不会取消已接受的任务。审批仍在独立的 owner 控制台 / API 里进行；桥不会自动批准它自己的工具使用。

发现是渐进式的：`oaa_list_agents` 返回精简摘要，而不是完整的工具 schema 或实测的就绪情况。用同一个 `revision` 跟着 `next_offset` 翻页；发布列表变化时会返回明确的冲突。用 `oaa_inspect_agent` 加上所选版本和 `section: "routes"`、`"tools"` 或 `"skills"`，按有界分页查看完整的标识符。只有需要完整的描述 / schema 时，才去读链接到的、固定到版本的元数据资源。它不含提示词正文、脚本文件或私有的 worker 配置；已发布的元数据本身仍需要 owner 审阅。超过 4 MiB 的资源读取会明确失败，可以改用带鉴权的 HTTP 元数据链接。

对应的 CLI 是 `oaa agents --limit 20`、`oaa agent AGENT --section routes --agent-version DIGEST`，以及 `oaa agent AGENT --agent-version DIGEST --out NEW_METADATA_FILE`。摘要 / 详情的 JSON 载荷控制在 20000 字节以内；页大小会缩小，而不是把 JSON 或智能体 / 模型 ID 截断。较早的完整 `/v1/agents` API 对现有控制台客户端保持不变。

输出文本有无损游标；大的结果不再把响应 ID 或产物引用藏在被截断的 JSON 预览后面。产物链接是带鉴权的 `oaa://files/{id}` 资源。MCP 资源读取限制在 4 MiB，以保证 base64 帧有界；更大的文件使用带鉴权的 HTTP 或 `oaa download`（上限仍是现有的 8 MiB 文件限制）。访问仍然需要文件权限和来源智能体的授权。资源 URL 里没有令牌。

CLI 调用方不用控制台也能完成同样的工作流：`oaa upload SELECTED_FILE`、`oaa invoke ... --idempotency-key KEY`、`oaa wait RESPONSE_ID`、`oaa output RESPONSE_ID`、`oaa artifacts RESPONSE_ID`、`oaa download FILE_ID --out NEW_FILE`。使用 `--url` 与 `--token-file`，或 `OAA_GATEWAY_URL` / `OAA_TOKEN_FILE`。下载从不覆盖已有文件。

发布一个原生智能体，除了 MCP 入口，还需要一个已启用的 worker 适配器。仅仅读取一个 MCP 服务器，并不会导出调用方的进程、私有插件或桌面登录状态。

<a id="follow-published-capabilities"></a>
## 跟随已发布的能力

用 `GET /v1/agents` 或 `oaa_list_agents` 给出的 `catalog_cursor`，等待可见的发布、版本、节点与运行时变化。HTTP 客户端可以用 `/v1/catalog/events`（SSE）或 `/v1/catalog/changes`（有界等待）；MCP 调用方用 `oaa_watch_catalog`。CLI 支持 `oaa catalog --cursor CURSOR --timeout-ms 20000`，以及常用的 `--url` 与 `--token-file` 选项。省略游标时，返回一份初始的重新同步回执，不会等待。

`reset` 的意思是重新加载目录，而不是重放某次执行。通知是经过合并、限定作用域的元数据提示，在内存里保留有界的历史；网关重启和游标过期会明确要求重新同步。它们既不分发凭据，也不派发任务。API 密钥被吊销会关闭正在读取的连接，但不会隐含地取消已接受的任务。见[目录契约](protocol.md#catalog-notifications)。

<a id="inspect-and-recover-work"></a>
## 查看与恢复请求

控制台的请求检查器使用有界的状态，并对输出、步骤、审批与产物分页，而不是反复下载整份执行记录。审批回复在刷新后仍可编辑。完整文本、步骤 JSON 与审批 JSON 只在请求时下载；所有读取都保留调用方的 owner、权限与智能体检查。[原生检查 API](protocol.md#bounded-inspection-and-mcp-delivery) 支持不用控制台的同样工作流。

概览是一个运营驾驶舱（等你处理的审批、成功率、P50/P95 延迟、活动脉搏，以及时间花在哪里的关键路径拆分），每个请求还有带并行泳道与关键路径的时间线。见[控制台使用说明](console.md)。

未知的外部写入结果会阻止恢复。有权限的操作员必须先显式记录带结果的 `completed`，或 `not_executed`，然后再单独恢复内核运行。这是**操作员的断言**，在步骤历史里可见地保留，不是一次新的工具测量。对账与审批决定都与它们的审计事件一起提交，之后执行才能继续。原生的黑盒会话不会被呈现为可重放的检查点，一次失败的 HTTP 响应也不是重复外部写入的许可。

<a id="import-selected-mcp-tools"></a>
## 导入选定的 MCP 工具

对 owner 已配置的 MCP 服务器，可以在不执行任何工具、不复制其连接凭据的情况下检查并准备：

```sh
npm run oaa -- mcp inspect --config worker.json --server private_notes
npm run oaa -- mcp prepare --config worker.json --server private_notes \
  --tool read_note --capability private/notes --effect read --export-result \
  --out prepared-notes
npm run oaa -- node join --config worker.json --tool-config prepared-notes/worker-tool.json
npm run oaa -- build agent.json --tool-binding prepared-notes/binding.json \
  --skill /explicitly/selected/skill --out reviewed-bundle.json
npm run oaa -- publish-bundle reviewed-bundle.json \
  --url http://127.0.0.1:8787 --token-file /path/to/admin.token
```

`prepare` 把一份公开绑定、一份私有的 worker 工具覆盖配置和一份审阅摘要写进一个**新**目录。它不改变任何正在运行的配置。默认的副作用等级是 `unknown`，需要审批，且结果导出默认关闭，除非显式选择开启。上游的 `readOnlyHint` 注解只是提示，不是权威。`--approval none` 是显式的运营者策略选择，不是推断出来的优化。准备好的工具默认是必需的；`--optional` 允许在没有它时降级执行。

绑定里包含所选工具的元数据和一个宿主引用；连接命令、URL、令牌与环境变量的值不会从 worker 配置里复制出来。所选的 worker 配置把它的 MCP 连接放在 `mcp` 下；带 `localWorker` 的网关配置同样可以用于检查与准备。`serve --tool-config ...` 可以在当前进程里把一份覆盖配置应用到那个本地 worker。已有的引用 / 能力版本不能被悄悄替换。`publish-bundle` 发布已审阅的能力包版本，不会重新读取技能目录。元数据本身可能包含私密信息，所以要审阅；凭据扫描是启发式的，不是隐私证明。

MCP 连接按 owner、会话、智能体版本与连接凭据隔离。它们只在这个范围内复用，空闲 60 秒后过期，空闲缓存有上限。一个领域错误不会关闭另一个调用方的并行请求。工具调用之前会检查已准备好的元数据指纹；发生漂移就需要新的审阅 / 版本。这个同步 worker 配置会明确拒绝任务必需的 MCP 工具。这既不是对第三方服务器实现 / 全局状态的证明或沙箱，它的进程内状态也不承诺能在空闲淘汰或网关重启后保留。

<a id="workers"></a>
## 执行机器（Workers）

用管理员控制台 / API（`POST /v1/nodes/enroll`）登记一个节点。给它单独的凭据，只授予预期的智能体 / 能力。worker 的 JSON 文件形如：

```json
{
  "nodeId": "workstation-2",
  "owner": "owner",
  "dataDir": "/private/path/oaa-worker",
  "gatewayUrl": "https://your-gateway.example",
  "tokenFile": "/private/path/node.token",
  "concurrency": 4,
  "providers": {
    "default": { "kind": "openai-responses", "apiKeyEnv": "OPENAI_API_KEY" }
  }
}
```

```sh
npm run oaa -- node join --config /private/path/worker.json
```

Worker 主动向外连接。非 loopback 的连接要求 WSS/HTTPS 并校验证书。请配置网关 TLS，或使用配置正确的可信反向代理，并显式设置 `allowedHosts` 与 `allowedOrigins`。本仓库不会执行任何公网部署或系统网络配置。要把网关放到公网给受信调用方使用（按调用方隔离数据、`consoleHosts`、`nativeEnv` 白名单、反向代理示例），见[公网部署手册](deploy-public.md)。

可移植的能力包只包含显式选定的文件。宿主绑定的工具会指明一个节点，并留在那里。节点侧的工具配置绑定 MCP 引用、选定的只读目录，或 owner 批准的脚本。调度器不会把任务内容广播给每个节点。显式的文件 `allowed_nodes` 约束在派发前检查，worker 再检查一次。

owner 级管理员可以在控制台里，或通过 `oaa nodes`、`oaa node drain NODE`、`oaa node resume NODE`、`oaa node revoke NODE` 和 `oaa node history NODE` 管理远程节点。暂停派发会让已经开始的调用收尾，但阻止后续步骤；受影响的内核任务保留已确认的检查点，容量恢复后可以用 `oaa resume RESPONSE_ID` 显式继续。吊销对该节点身份是终局的，在网关重启后依然有效，包括来自配置文件的凭据。它会立即关闭受信输入，但并不声称远端的副作用或逃逸的进程已经停止。未知的写入仍然需要对账。不会修改任何已有的凭据文件，本地 worker 也受保护，不会被远程的吊销控制影响。

<a id="native-backend-boundaries"></a>
## 原生后端的边界

| 后端 | 接入方式 | 当前边界 |
| --- | --- | --- |
| Codex | 专用的 stdio app-server、模型选择、会话续接、审批桥 | 检查过已安装的 schema；用夹具测试过，没有真实提供方测试 |
| Claude | 官方 Agent SDK，使用单独安装的 CLI 与原生配置 | 通过了类型检查；没有真实的 SDK / 凭据测试 |
| Antigravity | Stream-JSON `event: "user"`、发送提示词前确认 init 里的模型、观测用量 | 在本地通过了一次经授权的 Gemini 3.8 Flash Low 读文件任务；其它模型、续接的用量核算和跨机器行为仍未验证；没有交互式审批 |
| DSH | 已安装的 `dsh --profile headless`，归它所有的一次性进程 | 只有最终文本；没有原生续接或工具轨迹。显式更换模型需要 owner 配置的 `native.dsh.models` 覆盖参数 |

原生权限是继承的，本网关不做沙箱隔离。一次原生调用可以读取或修改宿主运行时允许的任何内容。自建内核的内置文件工具使用专用的会话工作区；显式注册的宿主工具和脚本保留它们声明的宿主权限。这不是针对恶意节点、脚本或同一用户的本地进程的隔离边界。

<a id="verification"></a>
## 验证

```sh
npm test
npm run demo
npm run bench
npm run bench:stream -- --label local --out .oaa-bench/streaming-new.json
npm run bench:fair -- --label local --out .oaa-bench/fairness-new.json
npm run oaa -- doctor
```

测试使用本地确定性模型、本地协议服务器和归测试所有的子进程夹具。演示脚本写出 `.oaa-demo/report.md`；调度器微基准写出 `.oaa-bench/runtime.json`。它们**不能**证明真实提供方的兼容性、真实的跨机器性能、账号访问，也不能证明优于 OpenAI / AgentScope。使用真实模型和外部部署，需要显式的访问与费用授权。

另外，2026-11-02 一次经授权的只读 `agy` 任务，使用 `gemini-3.8-flash-low`，通过了：两次真实的 `read_file` 操作，算术正确，并读出了所提供文件里一个无法预测的标记。之前那次输入格式错误的尝试作为失败保留，没有被改称成功。这只证明了那条具体的本地路线与任务。真实运行脚本是 `examples/live-native-acceptance.ts`；它从不属于 `npm test`，需要 `--confirm-live-cost`，每个新的输出目录只做一次原生调用，也不重试。原生的 token 上限不被宣传为可强制的花费上限，上报的 token 也不是费用估计。

流式基准统计实际的 SQLite 快照写入次数，并在固定工作负载上检查持久输出的重放。报告从不被覆盖；每次运行都选一个新的输出路径。`--compare BASELINE.json` 只比较工作负载哈希一致的报告。存储 schema v4（当前）保留带检查点的 v2 文本日志，加入持久的节点准入 / 吊销审计（v3）和调用方数据隔离（v4）；已有数据以事务方式迁移，v3 数据库在 v4 迁移之前会自动备份。升级前先备份。不要用旧版网关二进制降级，也不要不经审阅就恢复过期的凭据授权。

公平性基准测量一个短请求单独运行时、以及在只有一个网关运行槽的情况下排在长的工具 / 图工作之后时的表现。它报告首个事件、首段文本、完成时间与总工作负载时间，把第一个夹具请求与热身后的样本分开，并核对模型 / 工具调用次数与输出完全一致。内核任务只在已确认的边界处、且有其它任务在等待时才让出；正在进行的操作和原生会话不会被强行拆开。这些本地的排队延迟测量，不能证明另行设定的 30% 真实模型性能目标，也不能证明有金钱成本优势。

可选的[配对运行时基准](../../bench/paired/README.md)会让真实的 AgentScope 2.0.11 SDK 与 OAA 一起运行，有串行与并行两种配置，共用一个无需凭据的脚本化模型 / 工具判定器，使用全新会话的试验，并留有源码 / 依赖记录。它核对调用次数、依赖结果和实际的并发，而不是比较毫不相干的演示。OAA 的 SQLite 持久性与 AgentScope 默认的内存状态仍是明确不同的。这些测量不是真实模型、费用、完整服务或跨机器的验收，也不能证明 30% 的目标。

架构与来源依据见：[architecture](architecture.md)。不会扫描用户主目录里的密钥，不训练任何基础模型，也没有实现订阅池或隐藏的认证中继。

OAA-Lang 支持经过检查的工作流结果和保持语义的格式化。flow 里显式的 `return` 选择哪些内容进入下一轮模型，而不删除工具执行记录，也不绕过审批。见[语法参考](language.md)和[文档节选示例](../../examples/projected-workflow.oaa)。
