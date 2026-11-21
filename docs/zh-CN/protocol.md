# OAA/1 契约

[English](../protocol.md) · 简体中文

<a id="identity-and-authorization"></a>

## 身份与授权

一次调用按 `agent -> immutable bundle -> published model route -> eligible worker`（智能体 → 不可变能力包 → 已发布的模型线路 → 可用的 worker）解析。调用方拿到的是响应 ID，而不是上游凭据。API 密钥带有 owner、允许的智能体 ID 和权限范围（scope）：`read`、`invoke`、`files`、`approve`、`admin`、`billing`（只用于开发者平台：给账号加点数并按邮箱查找账号，见「[开发者平台](#开发者平台)」）。节点凭据是另一套，不能调用应用 API。

`POST /v1/invoke` 接受 `protocol: "oaa/1"`、`agent`、`model`（`auto`、线路 ID 或已发布的模型名）、文本 `input`，以及可选的 `file_ids`、`previous_response_id`、`stream`、`background` 和值为字符串的 `metadata`。未知字段会被拒绝。`Idempotency-Key` 把规范化后的请求绑定到唯一的一个响应；同一个键配不同输入返回 409。

### 调用方数据隔离（schema v4，2026-11-08）

同一 owner 下的每个 API 密钥都有自己的数据分区 `subject`，默认就是密钥 ID；子智能体的运行继承父运行的 subject。下列数据按 subject 隔离：

- 运行：列表、读取、事件流、时间线、步骤、产物、取消、续接（`resume`）、审批、对账，以及 `previous_response_id`。
- 文件：上传的文件和运行产物。
- 记忆：`/v1/memory` 接口和智能体的 `memory_read` / `memory_write` 工具。
- `Idempotency-Key`：两个调用方用同一个键，各自得到自己的运行。
- 概览指标和活动脉搏。

不在自己分区内的运行或文件一律返回 404（`run_not_found` / `file_not_found`），不透露它是否存在。

**谁能看到全部调用方的数据**

- 带 `admin` scope 的密钥，仍然只限于它被授权的智能体。
- 用 `POST /v1/keys` 创建、并指定 `"data_scope": "owner"` 的密钥，例如只读监控面板。配置文件里的密钥用 `dataScope: "owner"` 指定。

新建密钥默认是 `"data_scope": "own"`。旧版本创建的密钥没有这个字段，升级后也按 `own` 处理：**以前用来查看他人运行的非管理员只读密钥，升级后需要重新创建并指定 `data_scope: "owner"`。**

**记忆的规则更严格**：记忆不按智能体划分，所以只有 owner 级管理员（`admin` scope 且 `agents: ["*"]`）可以用 `subject` 参数读写别人的记忆，包括 `legacy` 分区。其它密钥带着别人的 subject 访问会返回 403。

**限额**：在 owner 总上限（32 个未完成请求）之外，网关配置项 `maxActiveRunsPerSubject` 可以单独限制每个调用方。默认不限制；对外分发密钥时建议设置。

**升级迁移**：v3 → v4 在启动事务里完成。迁移前会先把数据库复制到 `<dataDir>/backups/state-v3-before-subjects-<时间戳>.sqlite`，复制失败就停止启动。存量数据的归属规则：

- 运行：按提交时记录的密钥归属；子智能体的运行沿父运行链归属。
- 产物：跟随所属运行。
- 上传的文件：如果所有用到它的运行都属于同一个调用方，就归这个调用方。
- 记忆：如果有对应的运行，跟随运行。
- 其余数据进入 `legacy` 分区，只有管理员能看到。

旧网关打不开 v4 数据库（返回 `schema_too_new`）。需要回退时，恢复上面那个备份文件即可。

### 管理面与 API 域名分离（2026-11-08）

网关配置项 `consoleHosts` 用来列出管理面的域名，例如 `["console.example.com"]`。每一项都必须已被 `allowedHosts` 覆盖，否则加载配置时直接报错。通配项（`*.example.com`）要求 `allowedHosts` 里有完全相同的通配项。

配置了 `consoleHosts` 后：

- 控制台页面和静态资源（`/`、`/console.js`、`/agents/*.svg` 等）只在这些域名上提供。其它域名上访问返回 404 `route_not_found`，就像这些路由不存在一样。
- 带 `admin` scope 的密钥只能在这些域名上使用。在其它域名上，任何接口都返回 403 `admin_host_denied`，包括 MCP 桥接和 CLI 发起的请求。所以对外的 API 域名上只能使用调用方密钥，发布、密钥管理、节点管理都要通过控制台域名完成。
- 调用方密钥不受影响，可以在任何允许的域名上使用。Worker 的 `/v1/nodes/connect` 使用独立的节点凭据，也不受影响。

不配置 `consoleHosts` 时，行为与以前完全一样。本机桌面版默认就不配置。

判断依据是请求的 `Host` 头。反向代理需要原样转发 Host，Caddy 默认就这样做；Nginx 需要设置 `proxy_set_header Host $host`。

### 执行等级（P1，2026-11-08）

每个已发布的智能体都有一个**所需执行等级**，由它的引擎和工具绑定自动计算，发布者不需要声明：

| 等级 | 哪些智能体 | 含义 |
|---|---|---|
| `workspace` | `kernel` 引擎，并且只使用内置工具（`read_file`、`write_file`、`list_files`、`read_skill`、`memory_*`） | 模型循环加上只限于会话工作区的文件和记忆工具 |
| `host` | 原生智能体（Codex、Claude、Antigravity、DSH）、任何适配器（包括 ACP、A2A），以及带 `script` 或 `node` 工具的 kernel 智能体 | 以 worker 宿主机的权限执行 |

每把 API 密钥有一个**允许的最高等级** `execution`：

- 带 `admin` scope 的密钥始终是 `host`。
- `POST /v1/keys` 可以显式传 `"execution": "workspace" | "host"`；不传时取网关配置 `defaultKeyExecution` 的值，它的默认值是 `host`，与 P1 之前的行为相同。公网部署建议把 `defaultKeyExecution` 设为 `workspace`。
- 配置文件里的密钥用 `execution` 字段设置，不设时为 `host`。
- 旧版本创建、没有这个字段的密钥按 `host` 处理。

在解析出要运行的版本之后、调用任何模型之前，网关会做检查：如果所需等级高于密钥允许的等级，提交和预览都返回 403 `isolation_required`。检查还会顺着它的委派链（按当前发布的版本，最多 4 层）往下查。子智能体的运行继承父运行的等级（记录在运行检查点里），并且在子运行提交时按它实际运行的版本再检查一次。

`workspace` 是**代码层面**的限制（内置工具只能访问会话工作区），不是操作系统沙箱。

**`sandbox` 等级（沙箱 S1，2026-11-08）**：介于 `workspace` 和 `host` 之间，可以作为密钥的 `execution` 或 `defaultKeyExecution` 的值。

- 这类密钥除了能运行 `workspace` 级智能体，还能运行 **kernel 引擎、工具只有内置工具和 `script` 脚本**的智能体。
- 这些脚本**只会**被派给已经声明并通过自检的 OS 沙箱节点，在沙箱里运行。worker 收到这类任务但自己没有可用沙箱时，会直接拒绝（`sandbox_unavailable`），不会退回到宿主机上执行。
- **Claude Code 和 Codex（沙箱 S2a）** 也可以由 `sandbox` 级密钥调用，条件是：
  - worker 主人在 `sandbox.native.<engine>.providerDomains` 里列出了该引擎，并且启用了它；
  - 启动自检时，这个 CLI 在沙箱里成功运行了 `--version`，worker 据此上报 `native/<engine>`；
  - 调用方带上了自己的 `X-OAA-Provider-Key`，否则返回 400 `provider_key_required`。

  运行时：
  - HOME 和 CLI 的配置目录（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`）都位于会话工作区的 `.oaa-home/` 下，主人的登录信息和配置不可见。
  - 调用方的密钥以 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 注入，除基础变量外不传任何其它环境变量。
  - Claude 以 `--bare` 启动（只用 API key 认证）；Codex 关闭它自带的沙箱，由外层沙箱负责隔离。
  - 出网只放行主人列出的提供方域名。
  - 沙箱里的智能体**能读到**注入的密钥。这是调用方自己的密钥，出网又只能到提供方域名。
- 用 `host` 级密钥调用原生智能体时，仍然使用主人自己的配置，并且不接受调用方密钥（`byok_not_supported`）。
- Antigravity、DSH、适配器、`node` 类型的宿主工具，仍然只能用 `host` 级密钥调用。
- 沙箱节点的能力通过 `sandbox-v1` 协商后，以 `execution.sandbox` 上报：`{backend, version, kinds}`。

worker 端的配置项 `sandbox`：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `backend` | `none` | `none` 时不启动任何东西；`srt` 时启动 `@anthropic-ai/sandbox-runtime`，它的 HTTP 和 SOCKS 代理会在 localhost 上监听，自检通过后才上报沙箱能力 |
| `allowDomains` | `[]` | 沙箱里的脚本能访问的域名上限。实际放行的是「能力声明的 `network.allowedDomains`」和它的交集，支持 `*.` 通配；交集为空就是完全断网 |
| `cpuSeconds` | `60` | `ulimit -t` 设置的 CPU 时间上限 |
| `denyRead` | `[]` | 额外禁止读取的路径。home、外接卷、worker 数据目录始终禁止读取，只放开会话工作区、能力包和语言运行时 |
| `native` | `{}` | 允许在沙箱里运行的原生引擎（`claude`、`codex`）。每项是 `{providerDomains: [...], cpuSeconds?: 1800}` |
| `parentProxy` | 不设置 | srt 自己访问外网时经过的上游代理。不设置时，srt 直接连接 |

srt 后端的边界与局限：
- 它是进程级隔离，和宿主机共享内核，官方状态为 Beta 研究预览。
- 每个调用的网络白名单靠代理用户名里的随机 ID 绑定，所以同一个 worker **同一时间只运行一个沙箱进程**。
- 不限制内存和进程数。
- 详见 `docs/sandbox-design.md`。

### 调用方自带模型密钥（BYOK，P1）

调用方可以在请求头 `X-OAA-Provider-Key` 里带上自己的模型提供方密钥。这个头适用于所有提交入口：`/v1/responses`、`/v1/invoke`、`/v1/chat/completions`、`/v1/messages`、兼容端点和 Gemini 端点，也适用于预览（`/v1/agents/preview`）和续跑（`/v1/runs/{id}/resume`）。用 OpenAI SDK 时，可以通过 `default_headers` 传入。

**密钥怎么流转**

- 网关只把密钥保存在内存里，按运行 ID 管理。它不会写入 SQLite（包括 WAL）、事件、检查点、时间线、日志或任何响应；运行里只持久保存一个 `byok: true` 标记。
- 每次模型调用时，网关把密钥随任务发给 worker。远程 worker 走 WSS，非 loopback 地址强制 TLS。worker 用这把密钥**新建一个不缓存的**模型客户端，用完即弃。上游错误信息里如果出现了这把密钥，会被替换成 `[redacted]`。
- 运行结束后密钥立即丢弃。被中断（`interrupted`）的运行会多保留 1 小时，以便续跑。

**绝不回退到发布者的密钥**

- 带了调用方密钥的运行，它的每一次模型调用都只会派给明确接受调用方密钥的节点，也就是声明了 `byokProviders` 的节点。
- 只有 worker 主人在提供方配置里写了 `"byok": true`，或者注入的驱动实现了 `withApiKey`，节点才会接受。
- 节点自己有密钥也**不算**接受。找不到合适的节点时返回 503 `model_unavailable`，预览里的原因码是 `byok_unsupported`。
- worker 收到不该收的调用方密钥时，会直接拒绝（`byok_not_supported`），不会改用自己的密钥。
- 开启了 `byok` 但没有配置 `apiKeyEnv` 值的提供方，只服务 BYOK 请求。

**范围与限制**

- 只适用于 kernel 智能体。原生智能体用的是它们自己的配置，带这个头会返回 400 `byok_not_supported`。
- kernel 子智能体沿用父运行的调用方密钥；原生子智能体不会收到它。
- 网关重启后，内存里的密钥都会丢失：
  - 进行中的运行会变成 `interrupted`，需要带上这个头续跑，否则返回 409 `byok_key_required`；
  - 重启前已经排在队列里的运行，在下一次模型调用时会以 `byok_key_required` 失败。
- 计费和用量统计仍然记在这把 API 密钥（调用方）名下。上游的费用由调用方自己的提供方账户承担。

**节点协议**：网关在 `welcome.features` 里声明 `byok-v1`。新版 worker 收到后，才通过 `advertisement` 消息上报 `execution.byokProviders`，hello 里不会带这个字段。所以新 worker 连旧网关、旧 worker 连新网关都能正常工作；旧 worker 不会被分配 BYOK 任务。

### 审计记录（P1）

网关会持久记录**已鉴权**请求被拒绝的事件，记录的错误码有：`scope_denied`、`admin_host_denied`、`isolation_required`、`concurrency_limit`、`subject_concurrency_limit`、`key_concurrency_limit`、`run_quota_exceeded`、`token_quota_exceeded`。

- 每条记录包含：时间、错误码、密钥 ID、subject、HTTP 方法、路径，以及客户端 IP（`trustProxy` 时取 `X-Forwarded-For` 的第一跳）。
- 同一 owner、同一密钥、同一错误码、同一路径的拒绝，在 60 秒内只写一条；下一条记录的 `suppressed` 字段给出期间被合并的次数。这个次数保存在进程内存里，网关重启会丢失。
- 每个 owner 最多保留 10,000 条，更早的会被删除。

**不记录**的情况：未鉴权的失败（401、`invalid_host`、`origin_denied`）和 `rate_limited`。否则每个被拒绝的请求都会变成一次数据库写入，等于给攻击者一个放大手段。这类流量应该在边缘层限流和记录。

`GET /v1/audit?after=<事件 ID>&limit=50`（最多 200）按时间从旧到新分页返回，`next_after` 是下一页的起点。只有 owner 级管理员可以读取，其它密钥会得到 403 `scope_denied`，而这次被拒绝本身也会被记录。

### `/health` 与进程 ID

`/health` 和 `/healthz` 无需鉴权，在任何允许的域名上都可用，适合负载均衡做健康检查。只有本机直接探测时才返回 `pid`，例如 `oaa serve --detach` 用它确认后台进程。本机直接探测需同时满足三个条件：

1. Host 是 loopback 或通配监听地址（`localhost`、`127.0.0.1`、`[::1]`、`0.0.0.0`、`[::]`）。
2. 对端地址是 loopback。
3. 请求没有 `X-Forwarded-For`、`X-Forwarded-Host` 或 `Forwarded` 头。

经过反向代理的请求和远程请求都看不到 `pid`，其余字段不变。

### 本机关闭（`POST /v1/gateway/shutdown`）

请网关自己关闭：先回答 `{"stopping": true, "pid": <pid>}`，然后让在途请求处理完、关闭数据库。需要覆盖整个所有者的管理员密钥，并且只在对端地址是 loopback 时接受（其他调用方得到 403 `scope_denied`），所以远程调用方永远不能用它停掉网关。`oaa stop` 在 Windows 上使用它，因为在那里信号没法让进程干净地停下来（见 [windows.md](windows.md#结束进程)）；在其他系统上 `oaa stop` 发送 SIGTERM。

<a id="compatibility"></a>

## 兼容接口

| 接口 | 已实现的子集 |
| --- | --- |
| `GET /v1/models` | 已发布的智能体 ID，作为可调用的模型别名 |
| `GET /v1/models/{id}` | 单个模型：OpenAI 的 Model 对象；带 `anthropic-version` 头时是 Anthropic 的 ModelInfo，带 `x-goog-api-client` 时是 Google 的 Model。智能体 ID 里的斜杠可以百分号编码（SDK 会这样发），也可以不编码 |
| `POST /v1/responses` | 文本，或带 `input_text` 与已上传 `input_file.file_id` 的 role/content 输入；流式、后台、metadata、上一个响应 |
| `GET /v1/responses/{id}` | 经鉴权的持久化响应读取；`?stream=true` 从头重放 Responses 流（`starting_after=N` 跳过 `sequence_number` 不大于 N 的帧） |
| `POST /v1/responses/{id}/cancel` | 只取消自己名下的响应 |
| `POST /v1/chat/completions` | 文本消息、普通/流式输出、`stream_options.include_usage`、metadata |
| `POST /v1/files` | OpenAI 风格的 multipart file/purpose，或 JSON `{filename,content,encoding,allowed_nodes}` |
| `GET /v1/files/{id}/content` | 经鉴权的输入/产物下载 |

Responses 的 `model` 选择一个智能体别名；`metadata["oaa.model"]` 可选地指定一条线路。不支持的 OpenAI 输入会明确报错，而不是悄悄降级：在严格端点上，未知字段返回 `unsupported_parameter` 并带 `error.param`；在每个 OpenAI 入口（严格、兼容与 `/v1/universal`）上，音频或未知的内容块返回 400 `unsupported_content`，`error.param` 指向那个内容块（例如 `messages.1.content.0`）；不会创建运行，该内容块也不会进入提示词。图片内容段（`image_url`、`input_image`）在每个入口都被接受，作为图片交给智能体（[images.md](images.md)）；收不了图片的智能体同样返回 400 `unsupported_content`，`error.param` 指向图片内容段。其它文件请用 `POST /v1/files` 上传，再用 `file` / `input_file` 内容块引用（见[兼容入口的参数、错误与结束原因](#兼容入口的参数错误与结束原因060)）。采样类参数会被接受，并报告为已忽略。默认（托管模式）下，网关执行已注册的智能体工具，不把它们作为客户端函数调用暴露出去；调用方自己定义的工具只有在桥接模式下才会交回调用方，见下文。

调用方定义的工具：请求带了非空的 `tools` 数组（或回传工具结果）时，每个入口都按模式处理，模式由请求头 `X-OAA-Client-Tools` 或 `metadata["oaa.client_tools"]` 选择。请求没有选时模式是 `auto`（网关配置 `clientTools.default` 可以改这个缺省）：调用方的工具交给能接管它们的智能体（下面的 `bridge`），接管不了的智能体得到该入口原来的行为，所以只有对「能桥接的智能体」的请求与旧版本不同。回退因入口而异：OpenAI 默认端点（不带 `X-OAA-Compat` 的 `/v1/chat/completions` 与 `/v1/responses`）返回 400 `unsupported_parameter`（`error.param` 是 `tools`；说明里讲清这个智能体接管不了你的工具、原因是什么，并写明三条出路：Base URL 用 `<origin>/v1/compat`、`X-OAA-Compat: true`、`X-OAA-Client-Tools: managed`），兼容端点、Claude Messages 与 Gemini 照旧按 `managed`。调用方工具与已发布的工具重名、不是普通函数（Gemini 的 `googleSearch`、`codeExecution` 等），或调用方强制了工具选择（`tool_choice` 为 `required` 或某个函数；Claude 的 `any` / `tool`；Gemini 的 `ANY` 模式）时，auto 同样回退：网关与智能体都没法保证做到强制，所以默认端点拒绝它（`unsupported_parameter`，`error.param` 是 `tool_choice`），其余入口照旧忽略。显式写的 `managed`、`bridge`、`reject`、`auto` 永远不被覆盖。空的 `tools: []` 不改变任何行为；旧式的 `functions` / `function_call` 在默认端点上仍被拒绝，`/v1/uap` 仍把 `tools` 当作未知字段拒绝。各模式：`auto`（默认，见上）、`managed`（智能体用自己的工具，调用方的工具不执行，响应带 `X-OAA-Client-Tools: ignored`）、`reject`（`client_tools_unsupported`）或 `bridge`（内核智能体与 ACP 智能体；响应带 `X-OAA-Client-Tools: bridge`：智能体对调用方工具的调用以各协议的标准形式交回——Chat 为 `tool_calls` 加 `finish_reason: "tool_calls"`，Responses 为 `completed` 响应里的 `function_call` 条目加 `metadata["oaa.status"]="requires_action"`，Claude 为 `tool_use` 块加 `stop_reason: "tool_use"`，Gemini 为 `functionCall` part（`args` 是对象）加 `finishReason: "STOP"`——运行随之停车；带着结果的下一个请求（`role: "tool"`、`function_call_output`、`tool_result`、`functionResponse`——按 `id` 配对，没有 `id` 时按名字与顺序对上一个 `model` 回合的 `functionCall` part 配对）接着同一个运行，沿用同一个 `X-Run-ID` 与同一个响应 ID（`resp_…` / `chatcmpl_resp_…` / `msg_resp_…` / Gemini 的 `responseId`）——这与 OpenAI 不同，那边每次 `responses.create` 都返回新的 Response；这里一个任务就是一个 ID、一次计费，`GET /v1/responses/{id}` 显示它的最新状态，更早的 `function_call` 条目不会另存成快照；其他外部智能体返回 `client_tools_bridge_unsupported`，桥接模式下的非函数 / 服务端 / 内置工具（Gemini 的 `googleSearch`、`codeExecution` 等）返回 `client_tools_unsupported`）。空的或没有 `tools` 时一切照旧。见 [harness.md](harness.md)。

Responses 的输出使用标准的 `response.created`、`response.in_progress`、消息/内容事件、`response.output_text.delta` 与终止事件。官方 OpenAI JavaScript SDK 对普通与流式输出都测试过。`X-Run-ID` 标识底层的执行。HTTP 客户端断开不会取消已被接受的任务。

SSE 响应头在流被接受时就刷出，即使 Chat 请求还没有产生文本。`X-Run-ID` 是单个值，流式响应保留 `Cache-Control: no-store, no-cache`；收到响应头只代表请求被接受，不能证明推理或工具已经完成。

文本增量先持久化，再投递。被取消、失败或被截断的生成会保留部分消息内容，状态为 `incomplete`，而不是声称消息已完成。一个已完成的模型回合，即使后面的工具或输出契约检查失败，也可以保留一条已完成的消息。原生事件重放仍然基于游标；显式恢复一个被中断的运行时，请从最后观察到的事件之后继续，不要从游标 0 重放更早的终止事件。

竞争时，内核运行可以在一个已确认的模型/工具边界从 `in_progress` 回到 `queued`。原生 SSE 记录 `run.queued`，带 `reason: "fairness"` 与下一个检查点的 `phase`。响应 ID、固定的模型/版本、输出序号、用量与截止时间都不重置，重新准入时可能再产生一次 `response.in_progress` 事件。这不是终止结果，也不是审批请求；客户端应继续跟随同一个执行。普通的 Responses、Chat Completions 与 MCP 等待会跨越这些调度转换继续。

Chat 的 `stream_options.include_usage=true` 要求 `stream=true`：普通数据块带 `usage: null`，成功完成时在 `[DONE]` 之前再发一个 `choices: []` 的用量数据块。未知或不完整的合计保持 null；不会编造 token 数或费用。被中断的流可能以错误结束，而不是以最后的用量数据块结束。

普通的同步调用在完成或停车等待审批时返回。Responses 把待审批表示为 `in_progress` 加 `metadata["oaa.status"]="requires_action"`；要看待办内容请查看原生运行接口。Chat Completions、Claude Messages 与 Gemini 返回 HTTP 422 `action_required`（带 `x-should-retry: false`，运行 ID 在 `X-Run-ID` 与错误体里），而不是假装任务已完成：用 `POST /v1/runs/{id}/actions/{action_id}` 决定这个待办（`GET /v1/runs/{id}` 会列出它），再用 `GET /v1/responses/{id}` 读取结果；不要重发请求，那会再启动一个运行。长时间运行或由审批驱动的客户端应使用后台 Responses 或 `oaa/1`，并检查待办。

（2026-11-08 新增）流式 Responses 在等待 owner 决定时保持连接，并额外发出一个 `response.in_progress` 事件，其 `response.metadata["oaa.status"]` 为 `requires_action`，与非流式 Responses 的表示一致；决定后同一条流继续输出直到终止事件。Chat / Claude / Gemini 流以各自的错误帧结束（Chat `error.code: action_required`；Claude `event: error`，`error.type: invalid_request_error`、`error.code: action_required`；Gemini `error.status: FAILED_PRECONDITION`、`details[0].reason: action_required`），UAP 流以 `action` 帧结束；任务本身在后台继续，可用 `X-Run-ID` 查询。各协议的审批、取消、续接差异见 `docs/adapters.md`「AgentAPI 转换契约」。

### 兼容入口的参数、错误与结束原因（0.6.0）

调用的是智能体，不是裸模型：采样类参数由发布者在智能体里决定，网关不转发。各入口的处理如下。

| 入口 | 生效 | 接受但忽略（列在 `X-OAA-Ignored-Params`） | 拒绝 |
| --- | --- | --- | --- |
| `/v1/chat/completions`（严格） | `messages`（`name` 被丢弃）、`stream`、`stream_options.include_usage`、`metadata`、`max_tokens` / `max_completion_tokens`、`reasoning_effort`（路由提示：`high` / `xhigh` 倾向质量路线，`low` / `minimal` 倾向速度路线）、`tools`、`tool_choice`（`auto`、`none`、`required` 或 `tools` 中的具名函数）与工具消息（`auto` 模式，见上）、`response_format`（结构化输出，见 [structured-output.md](structured-output.md)）、`n`（只能是 1） | `temperature`、`top_p`、`seed`、`stop`（条数不限）、`presence_penalty`、`frequency_penalty`、`user`、`store`、`service_tier`、`logit_bias`、`top_logprobs`、`parallel_tool_calls`、`verbosity`、`prompt_cache_key`、`safety_identifier`、`prediction`，以及厂商采样旋钮 `top_k`、`min_p`、`repeat_penalty`、`repetition_penalty`、`repeat_last_n`、`mirostat`、`mirostat_eta`、`mirostat_tau`、`tfs_z`、`typical_p`、`num_ctx`、`num_batch`、`num_keep`、`num_predict`、`keep_alive`、`think`；无害取值 `logprobs: false`、`modalities: ["text"]`、`tools: []`、`functions: []`、`response_format: {"type":"text"}`；文本块上的多余键（`cache_control`）与 `stream_options` 里的多余键（`include_obfuscation`）被丢弃；可选数值字段允许 `null` | 会改变网关要做的事的取值：`functions` / `function_call` 不是 `auto` / `none`（旧式写法，请声明 `tools`），指定了未声明函数或无 `tools` 时强制调工具的 `tool_choice`（`invalid_request`）或在 `managed` 模式下强制 `tool_choice`（`client_tools_unsupported`），`logprobs: true`，非文本 `modalities`，`n > 1`，不带 `stream: true` 的 `stream_options`（与 OpenAI 一致），以及这一行没有列出的任何字段（拼写错误不会被吞掉）：400 `unsupported_parameter`，`error.param` 是字段名，说明里写明出路（`/v1/compat`）；`input_audio` 等内容块：400 `unsupported_content`；`image_url` 内容段被接受（[images.md](images.md)） |
| `/v1/responses`（严格） | `input`（字符串，或带或不带 `type: "message"` 的消息项；内容块 `input_text`、`output_text`、`input_file`、`input_image`）、`instructions`、`stream`、`background`、`previous_response_id`、`metadata`、`max_output_tokens`、`reasoning.effort`、`tools`、`tool_choice`（`auto`、`none`、`required` 或具名函数）及其调用与结果（`auto` 模式）、`text.format`（结构化输出） | `temperature`、`top_p`、`top_logprobs`、`user`、`store`、`service_tier`、`truncation`、`parallel_tool_calls`、`include`、`max_tool_calls`、`prompt_cache_key`、`safety_identifier`、`stream_options`、`prompt_cache_retention`；无害取值 `text.format` 为 `text`、`tools: []` | 非法或无法桥接的强制 `tool_choice`（`invalid_request` / `client_tools_unsupported`）与未知字段：400 `unsupported_parameter`；消息与工具项以外的输入项（`reasoning`、`item_reference` 等）：400 `unsupported_content`，`error.param` 是 `input.N`；`input_audio` 等内容块：400 `unsupported_content` |
| `/v1/compat/chat/completions`、`X-OAA-Compat: true` | 同上，加 `tools` 与 `tool_choice`（按 `X-OAA-Client-Tools` 模式）、`response_format`（结构化输出）、`reasoning_effort`（路由策略） | `temperature`、`top_p`、`seed`、`stop`、`presence_penalty`、`frequency_penalty`、`n`、`logit_bias`、`logprobs`、`top_logprobs`、`user`、`store`、`service_tier`、`parallel_tool_calls`（仅当 `tools` 回退为 `managed` 时 `tool_choice` 才列入此头） | `input_audio` 与未知内容块：400 `unsupported_content`，`error.param` 指到内容块（如 `messages.1.content.0`）；其它文件先 `POST /v1/files` 上传，再用 `{"type":"file","file":{"file_id":"…"}}` 引用；图片见 [images.md](images.md) |
| `/v1/compat/responses` | 同上，加 `instructions`、`tools`、`tool_choice`、`text.format`（结构化输出）、`reasoning.effort` | `temperature`、`top_p`、`top_logprobs`、`user`、`store`、`service_tier`、`truncation`、`parallel_tool_calls` | `input_audio`、未知内容块与未知输入项：400 `unsupported_content`（用 `{"type":"input_file","file_id":"…"}` 引用已上传的文件）；图片见 [images.md](images.md) |
| `/v1/messages`、`/v1/compat/messages` | `system`（全文，不截断）、`messages`、`stream`、`metadata`、`max_tokens`、`tools`、`tool_choice`（`auto`、`none`、`any`、`tool`）、`output_config.format`（结构化输出） | `temperature`、`top_p`、`top_k`、`stop_sequences`、`thinking`、`service_tier` | 内联的 base64 / URL 文档、未知内容块：400 `unsupported_content`（先 `POST /v1/files` 上传，再用 `{"type":"document","source":{"type":"file","file_id":"…"}}` 引用）；`base64`、`url`、`file` 来源的 `image` 块被接受（[images.md](images.md)） |
| `/v1beta/models/{agent}:generateContent` / `:streamGenerateContent`（`/v1/models/...` 相同；不带 `models/` 的 `/v1beta/{agent}:generateContent` 也受理，AI SDK 的 Google provider 对含斜杠的 ID 就这样请求） | `contents`、`systemInstruction`、`generationConfig.maxOutputTokens`、`generationConfig.responseMimeType` / `responseSchema` / `responseJsonSchema`（结构化输出）、`tools`、`toolConfig.functionCallingConfig`（`AUTO`、`NONE`、`ANY`、`allowedFunctionNames`）、`fileData`、图片 `inlineData`（[images.md](images.md)） | `generationConfig` 的其余字段（`generationConfig.temperature` 等）、`safetySettings`、非函数类的 `toolConfig` 字段、`cachedContent` | 其它 part，例如不是图片的 `inlineData`：400 `unsupported_content`（用 `{"fileData":{"fileUri":"oaa://files/<id>"}}`） |

- **输出长度上限**：请求的上限写进 `metadata["oaa.max_output_tokens"]`（旧的 compat 端点仍写 `oaa.compat_max_tokens`），内核取它与智能体自身 `limits.maxOutputTokens` 的较小者，经节点线协议的可选字段 `Work.maxOutputTokens` 交给执行模型调用的节点。调用方只能调低，不能调高。外部智能体（ACP、A2A 等原生执行）不经网关调用模型，不受这个上限约束。不认识该字段的旧节点按已发布的上限执行。
- **Gemini 字段名**：Google 的 REST 接受 proto-JSON，请求体可以写 snake_case 或 camelCase。网关在解析前把已知的 snake_case 键（`system_instruction`、`generation_config`、`max_output_tokens`、`function_declarations`、`parameters_json_schema`、`inline_data`、`file_data` 等）改写成 camelCase；调用方自己的数据（`args`、`response`、JSON Schema）不动。`google-genai` 3.3 把工具 schema 发成 `parameters_json_schema`。
- **Base URL 容错**：API 路径里连续的斜杠被合并，`/v1...` 与 `/v1beta...` 路径末尾的斜杠被去掉，所以 Base URL 带末尾斜杠（`/v1//chat/completions`、`/v1/models/`）照常路由；鉴权看的也是规范化后的路径。以 `/chat/completions`、`/completions`、`/models`、`/responses` 或 `/embeddings` 开头的路径 404 时，说明会补一句：OpenAI 风格的 Base URL 必须以 `/v1` 结尾；以 `/v1/v1` 开头时补一句：客户端已经自己加了 `/v1`。
- **CORS 预检**：`Origin` 必须是网关自己的，或在 `allowedOrigins` 里（否则 403 `origin_denied`）；对 `OPTIONS` 的回答是固定的头列表，加上浏览器在 `Access-Control-Request-Headers` 里要求的、格式合法的头名（浏览器会发 `user-agent`、`x-stainless-*` 等固定列表预料不到的头）。
- **无请求体的 POST**：`DELETE`，以及 `/cancel`、`/resume`、`/reconcile`，带 `Content-Type: application/json` 而请求体长度为零，按没有请求体处理（官方 SDK 的 `responses.cancel` 就这样发）；非空而畸形的请求体仍然是 400 `invalid_json`。
- **已测试的客户端**：哪些 SDK、框架与聊天客户端实际运行过、哪些按记录的请求形状回放，见 [compatibility.md](compatibility.md)。
- **`X-OAA-Ignored-Params`**：这次请求里被接受但没有转发的参数名，逗号加空格分隔；没有被忽略的参数时不出现这个头。
- **内容块**：Claude 的 `tool_use` / `tool_result` 与 Gemini 的 `functionCall` / `functionResponse` 以 `[assistant tool_call:<name>]` / `[tool:<id 或 name>]` 标注成文本交给智能体（与 compat Responses 相同）；Claude 的 `thinking` 块与 Gemini 的 `thought` part 不交给智能体。
- **`/v1/universal` 的识别**：`X-OAA-Protocol: uap|oaa|gemini|claude|chat|responses` 显式指明时以它为准。否则：UAP、OAA 按字段；有 `contents` 是 Gemini；有 `messages` 时只看各家独有的特征——Claude：`anthropic-version` 或 `x-api-key` 请求头、数组形式的 `system`、`stop_sequences`、`top_k`、`thinking`、`anthropic_version`、带 `input_schema` 的工具、`image` / `document` / `tool_use` / `tool_result` / `thinking` 内容块；Chat：`system` / `developer` / `tool` 角色、`tool_calls`、`tool_call_id`、`stream_options`、`n`、`response_format`、`max_completion_tokens`、`seed`、`stop` 等字段、`type: "function"` 的工具、`image_url` 等内容块。`max_tokens`、字符串 `system`、`model`、`stream`、`metadata` 两家都有，不参与判断。两边都没有或都有特征时返回 400 `protocol_undetected`，不猜。有 `input` 与 `model` 是 Responses。Gemini 经 universal 时是否流式由非标准的 `body.stream` 决定，并且始终是 SSE。

**错误形状**：

| 入口 | 形状 | 网关错误码的位置 |
| --- | --- | --- |
| OpenAI（`/v1/chat/completions`、`/v1/responses*`、`/v1/compat/chat/completions`、`/v1/compat/responses`，universal 判为 chat / responses） | `{"error":{"code","message","type","param"}}` | `error.code` |
| Claude（`/v1/messages`、`/v1/compat/messages` 及其子路径（如 `/v1/messages/count_tokens` 的 404），universal 判为 claude） | `{"type":"error","error":{"type","message","code"}}`，`error.type` 按 HTTP 状态：400 `invalid_request_error`、401 `authentication_error`、402 `billing_error`、403 `permission_error`、404 `not_found_error`、409 `conflict_error`、413 `request_too_large`、429 `rate_limit_error`、503 / 529 `overloaded_error`、504 `timeout_error`、其余 5xx `api_error`、其余 4xx `invalid_request_error` | 附加字段 `error.code` |
| Gemini（`/v1beta/*`、`/v1/models/{agent}:{方法}`、带 `x-goog-api-client` 的 `/v1/models*`，universal 判为 gemini） | `{"error":{"code":<HTTP 状态>,"message","status","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason","domain":"open-agent-api"}]}}`，`status` 按 HTTP 状态：400 `INVALID_ARGUMENT`、401 `UNAUTHENTICATED`、403 `PERMISSION_DENIED`、404 `NOT_FOUND`、409 `ABORTED`、422 `FAILED_PRECONDITION`、429 `RESOURCE_EXHAUSTED`、503 `UNAVAILABLE`、504 `DEADLINE_EXCEEDED`、其余 5xx `INTERNAL` | `details[0].reason` |
| 其余路由 | `{"error":{"code","message","type":"invalid_request_error"}}`（不变） | `error.code` |

运行已创建之后的错误再带 `run_id`（OpenAI、Claude）或 `details[0].metadata.run_id`（Gemini）。流开始之后出错时，错误帧带真实的错误码与原因：Chat `data: {"error":{"code","message","type","param":null,"run_id"}}`（`type` 在服务端失败时为 `server_error`）；Claude `event: error`，`error.type` 按错误码在目录里的 HTTP 状态映射；Gemini 同上的 Google 错误对象。

**重试**：运行已经创建、但没有正常结束（失败、取消、中断、待审批）时，非流式 Chat / Claude / Gemini 返回 **422**（不再是官方 SDK 默认会自动重试的 409）并带 `x-should-retry: false`；Responses 照旧返回 200 的 response 对象（`status: "failed"` 等）。错误码目录里不可重试、而状态码会让 SDK 重试（408、409、429、5xx）的错误同样带 `x-should-retry: false`（例如配额耗尽）。可重试的 429 / 503 带 `Retry-After`：每分钟限流（`rate_limited`）给当前 60 秒窗口真实的剩余秒数（1–60），其余容量类上限（含 `too_many_streams`、`catalog_capacity`、`key_concurrency_limit`）给 10 秒。

**每个入口都认 `Idempotency-Key`**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、Gemini 的 `generateContent` / `streamGenerateContent` 以及 `/v1/compat/*` 都遵守请求头 `Idempotency-Key`（1 到 200 个字符，否则 400 `invalid_idempotency_key`），与 `POST /v1/invoke` 相同。同一个键、同样的输入再发一次，会接到已经存在的那个运行上（`X-Run-ID` 相同，不会再起第二个运行；流式请求同样接上）；同一个键配不同的输入返回 409 `idempotency_conflict`（Chat 在 `error.code`，Claude 是 `error.type: "conflict_error"` 加 `error.code`，Gemini 是 `status: "ABORTED"`）。每个逻辑任务用一个键，每次重试都带同一个键：这样结果不明的请求（超时、连接中断）才可以放心重发，因为客户端断开不会取消运行。桥接工具轮次里带着工具结果的续接请求是按工具调用 ID 找到运行的，不看这个键。

**取消**：`POST /v1/responses/{id}/cancel`（或 `oaa cancel`）之后的最终状态取决于智能体。内置（kernel）智能体以 `cancelled` 结束。外部智能体（ACP、Codex、Claude Code 等）如果还没开始执行，也是 `cancelled`；已经开始执行后才被取消的，记为 `interrupted`、错误码 `effect_outcome_unknown`，因为它已经产生的副作用无法排除。`GET /v1/runs/{id}` 显示 `interrupted`；Responses 入口把它显示为 `status: "incomplete"`、`incomplete_details.reason: "effect_outcome_unknown"` 与 `metadata["oaa.status"]: "interrupted"`；Chat、Claude、Gemini 与其他没有正常结束的运行一样返回 422。取消已经结束的运行，原样返回该运行。调用方应把 `cancelled` 与 `interrupted` / `effect_outcome_unknown` 都当作取消的正常结果，后一种要核对副作用（见[操作手册「查看与恢复请求」](operations.md#查看与恢复请求)）。

**配额耗尽（429）与余额不足（402）为什么不同**：`run_quota_exceeded`、`token_quota_exceeded` 是 API 密钥上由 owner 设的限额，语义是「这把密钥用完了」，与 OpenAI 的 `insufficient_quota` 一样用 429；`insufficient_balance` 是平台账户需要付费充值，用 402。两者都不可重试：429 的配额耗尽带 `x-should-retry: false`、不带 `Retry-After`，402 本身不在官方 SDK 自动重试的状态码里，所以都不会被 SDK 自动重试。已发布错误码的 HTTP 状态不改。

**结束原因**：

| 运行 | Chat `finish_reason` | Claude `stop_reason` | Gemini `finishReason` | Responses |
| --- | --- | --- | --- | --- |
| 完成 | `stop` | `end_turn` | `STOP` | `status: completed` |
| 模型输出被截断（`max_output_tokens`） | `length`（200，已生成的文本照常给出；流式照常以 `[DONE]` 结束） | `max_tokens` | `MAX_TOKENS` | `status: incomplete`，`incomplete_details.reason: max_output_tokens` |
| 桥接：等调用方执行工具 | `tool_calls` | `tool_use` | 不支持桥接 | `completed` + `function_call` 条目 |
| 失败 / 取消 / 中断 / 其它未完成 / 待审批 | 422 错误（流：错误帧） | 422 错误（流：`event: error`） | 422 错误（流：错误对象） | `failed` / `cancelled` / `incomplete` / `in_progress` |

`stop_sequence` 恒为 `null`（网关不转发停止序列）。Claude 的 `message_start.usage` 是 0：开始输出时还没有用量，真实值在 `message_delta` 里。`model` 回显的是智能体 ID，Gemini 的 `modelVersion` 是 `<agent>@<route model>`。Claude 入口不要求 `max_tokens`、不校验角色交替，比官方宽松。

**流的细节**：Responses 流的 `sequence_number`（与 SSE 的 `id:`）是这条流里帧的序号，从 0 起连续；桥接续接的流是新的一段，同样从 0 起。Claude 流在 `message_start` 之后发一个 `ping` 事件，长时间没有输出时网关每 15 秒发一次 SSE 注释心跳。Gemini `:streamGenerateContent?alt=sse` 是 SSE；不带 `alt=sse` 时是分块传输的 JSON 数组（`application/json`，元素之间以 `,\r\n` 分隔，心跳是空白字符）。Gemini 也接受 REST 的 `?key=`（只在 `/v1beta/models[/*]` 与 `/v1/models/{agent}:{方法}` 上；网关不记录完整 URL，审计记录只保存路径）。

**官方 SDK 实测**：Claude Messages 入口有仓库内的官方 `@anthropic-ai/sdk` 1.3.0 回归测试（`test/compat-anthropic-sdk.test.ts`、`test/compat-anthropic-sdk-errors.test.ts`，进程内、不监听端口）：`messages.create` 与 `messages.stream()` 的解析（`finalMessage()`、`finalText()`、原始事件迭代）、截断、系统提示与多轮、鉴权（SDK 1.3.0 把 `apiKey` 发成 `Authorization: Bearer`；`authToken` 与显式 `x-api-key` 头同样可用；`anthropic-beta` 不影响请求）、各错误类（`AuthenticationError`、`PermissionDeniedError`、`NotFoundError`、`BadRequestError`、`RateLimitError`、`UnprocessableEntityError`）、失败与待审批只发一次请求、桥接工具（`tool_use` 块、流式 `input_json_delta` 拼成对象、并行调用、`tool_result` 续接）。SDK 有而网关没有的端点（`messages.countTokens`、`messages.batches.*`）返回 Claude 形状的 404，SDK 解析为 `NotFoundError`（`type: "not_found_error"`）。带 `anthropic-version` 请求头的 `GET /v1/models`（SDK 的 `models.list()`）返回 Anthropic 的 ModelInfo 列表（`type: "model"`、`display_name` 为智能体 ID、`created_at` 为纪元时间、`has_more: false`）；不带该头时仍是 OpenAI 的列表形状。SDK 1.3.0 的类型里必有、可为 `null` 的字段网关都会给出：`Message` 的 `container`、`stop_details`、`diagnostics` 为 `null`；`usage` 的 `input_tokens`、`output_tokens` 是运行的真实计数，`cache_creation_input_tokens`、`cache_read_input_tokens`（网关不做提示缓存计数）、`cache_creation`、`output_tokens_details`、`server_tool_use`、`service_tier`、`inference_geo`、`speed` 为 `null`；流式 `message_start` 的 message 同形，`message_delta` 的 `delta` 带 `stop_details: null`、`container: null`，`usage` 带 `MessageDeltaUsage` 的 `cache_creation_input_tokens`、`cache_read_input_tokens`、`output_tokens_details`、`server_tool_use`（`null`）。非流式与 `finalMessage()` 读到的都是 `null`，不是 `undefined`；类型上可选的字段不加。Gemini 入口用临时安装的官方 `@google/genai` 3.2.0 做过一次性实测（探测脚本 `examples/gemini-sdk-probe.mjs`，进程内、不监听端口；该 SDK 不是项目依赖，回归靠线上格式测试 `test/compat-claude-gemini.test.ts`、`test/compat-gemini-sdk-findings.test.ts`）：SDK 默认 `apiVersion` 是 `v1`，请求发到 `/v1/models/{agent}:generateContent`，网关在 `/v1` 与 `/v1beta` 下同样接受；`generateContent` 读到 `text`、`candidates`、`finishReason`、`usageMetadata`、`modelVersion`、`responseId`；`generateContentStream` 与 `chats.sendMessageStream()` 用 `?alt=sse`，最后一片带 `finishReason` 与用量；`systemInstruction`、多轮与 `chats` 历史按角色进入提示词；`maxOutputTokens` 截断是 `MAX_TOKENS`，`temperature`/`topP`/`topK`/`stopSequences` 列在 `X-OAA-Ignored-Params`；SDK 用 `x-goog-api-key` 头鉴权（`?key=` 同样可用）。错误抛 `ApiError`，`status` 是 HTTP 状态，`message` 是错误体的 JSON 字符串，可从中读到 `details[0].reason` 与 `metadata.run_id`；流中途失败也是 `ApiError`（`status: 500`，`INTERNAL`）。SDK 默认不重试（只有设了 `httpOptions.retryOptions` 才对 408、429、5xx 重试，不看 `Retry-After`），运行失败与待审批（422）只发一次请求、只建一个运行。调用方工具：默认与托管模式下 SDK 拿不到 `functionCalls`，回传的 `functionCall`/`functionResponse` part 作为文本进入提示词；带 `X-OAA-Client-Tools: bridge`（`httpOptions.headers`）时，`generateContent` 的 `response.functionCalls` 有 `id`、`name` 与对象形式的 `args`，`finishReason` 是 `STOP`，手工回传 `functionResponse` 续接同一个运行（同一 `responseId`），并行两个调用、`generateContentStream`（调用在一个分片里给全）与 `chats.sendMessage` 往返（SDK 的历史保留模型回合 `functionCall` 的 `id`，调用方的 `functionResponse` 不带 `id`，按名字配对）都已实测；SDK 把 `parameters` 的类型写成大写（`OBJECT`），网关转成 JSON Schema。`models.list()`/`models.get()`：`GET /v1beta/models[/{agent}]`，以及带 `x-goog-api-client` 头（SDK 每次都发）的 `GET /v1/models[/{agent}]`，返回 Google 的 Model 形状（`name: "models/<agent>"`、`displayName`、`supportedGenerationMethods`），一次返回全部、没有 `nextPageToken`。`countTokens`、`embedContent`、`caches`、`files` 网关没有，返回 404，SDK 正常解析为 `ApiError`（`/v1/cachedContents`、`/v1/files` 的 404 不是 Gemini 形状，但 SDK 不依赖形状）。

取消一个已经完成的响应返回 200 与它已完成的对象（OpenAI 只允许取消 background 响应）。`metadata` 会附加若干 `oaa.*` 键（状态、版本、线路等），可能超过 OpenAI 的 16 键上限；把响应对象转发给真的 OpenAI 之前请去掉 `oaa.*` 键。

<a id="execution-and-actions"></a>

## 执行与待办

<a id="catalog-notifications"></a>

### 目录通知

`GET /v1/agents` 返回它通常的授权后 `data`，外加 `catalog_cursor`，二者取自同一份可见元数据。发现接口选取定义时不在应用里物化能力包的文件正文。发布仍然持久化在 SQLite 里；通知日志是刻意分开的，且只在内存里。

- `GET /v1/catalog/changes?cursor=...&limit=32&timeout_ms=20000` 返回 `{cursor,reset,data,has_more,timed_out}`。需要 `read`，按 owner 与智能体授权过滤，从不调用模型或工具。`data` 最多含 32 条变化，每条是 `{cursor,agent,version,reason}`；`reason` 为 `published`、`runtime` 或 `removed`。沿着返回的游标一直取，直到 `has_more` 为 false。等待最长 25 秒；超时返回的空页不是任务失败。
- `GET /v1/catalog/events` 把同样的变化作为 `catalog.changed` 以流的形式推送。用 `Last-Event-ID` 或 `?cursor=...` 续接；互相冲突的游标会被拒绝。事件 ID 是不透明的目录游标，不是运行事件的整数，也不是凭据。首次连接或需要重新同步时发出 `catalog.reset`，带游标与 `refresh: "/v1/agents"`。

收到 `reset: true` 时，重新读取授权范围内的智能体列表，并从它的 `catalog_cursor` 继续。游标缺失、网关重启、授权视图不同、视图被淘汰或历史已过期，都需要重置，绝不会跨授权范围静默重放。每个视图最多保留 256 条通知。网关最多保留 64 个授权视图，每个 owner 最多有 64 个存活的订阅/等待。空闲视图可能被淘汰。这是一个有界的目录失效通知流，不是持久的发布审计，也不是每一次瞬时负载变化的完整记录。

发布、worker 注册/断开、能力更新、执行负载与本机适配器变化，都会触发合并后的刷新。活跃的视图还会每秒重新检查一次元数据，以发现由时钟驱动的冷却到期和本机配置变化。授权相同的订阅者共用一次刷新；别的 owner 或未授权智能体的更新不会推进这个视图的游标。运行时提示不含任务文本、工具载荷、登录状态或节点凭据。派发之前请重新获取线路就绪情况：通知既不预留节点，也不扩大访问权限。

SSE 保留常规的 CORS 与 no-store 头，并限制排队的输出量；读得慢或已断开的读者用最后收到的游标重连。通过 API 吊销一把密钥，会关闭它的目录/运行事件流与待处理的等待，但不会取消已被接受的任务。已经发出的字节无法收回。流的心跳会重新校验凭据，但不额外消耗一次 API 请求配额。

MCP 把这个功能暴露为普通的只读工具 `oaa_watch_catalog`；它不是主动推送的 MCP 工具列表变更，也不是在声称每个宿主都支持推送订阅。`oaa_list_agents` 带有用于通知的 `catalog_cursor`，以及一个用于一致分页目录的、单独的发布 `revision`。运行时通知可以在发布 revision 不变的情况下推进。命令行对应的是 `oaa catalog --cursor CURSOR --timeout-ms 20000`；省略游标即可得到初始的重新同步回执。取消一次监视只是让读者脱离。

<a id="bounded-capability-discovery"></a>

### 有界的能力发现

`GET /v1/catalog/agents?offset=0&limit=20` 返回精简摘要、`total`、`next_offset`、`revision` 与 `catalog_cursor`。后续分页请带上 `revision`。它只对调用方被授权的发布 ID/版本与授权做指纹；可见的发布变化会返回 `409 catalog_changed`，而不是悄悄把不同的列表拼在一起。别的 owner 或未授权智能体的发布不会使它失效。字节预算可能让一页比请求的 `limit`（最大 50）更短；请始终跟随 `next_offset`，不要自己加上 limit。

摘要包括完整的智能体 ID 与不可变版本、已发布工具/技能/模型线路的数量，以及明确标注的描述/引擎预览。它们在 SQLite 里选取元数据标量，而不是每个完整的智能体定义或工具 schema。`readiness: "not_evaluated"` 是刻意的：发现一个发布并不会检查或调用它的运行时。原生智能体已**发布**的工具/技能数为零，并不表示它私有的宿主工具集为空。调用之前请对选定的版本做线路预览。现有的完整 `/v1/agents` 端点仍然可用，并保持它实时就绪情况的契约。

`GET /v1/catalog/agent?agent=AGENT&agent_version=DIGEST&section=routes&offset=0&limit=20` 提供 `overview`、`routes`、`tools` 或 `skills` 之一。只有把第一页解析到当前发布时才可以省略版本。偏移量大于零时必须带 `agent_version`；请把返回的摘要值带过每一页详情，直到最终的调用。模型线路 ID/名称与工具/技能标识符从不被截断。工具行给出副作用等级、审批、必需/导出标志，以及完整 schema 的字节数/哈希，而不把大 schema 嵌进去。描述是预览，带显式的 `description_truncated` 标志。摘要/详情页序列化后的 JSON 数据载荷最多 20000 字节，低于 MCP 桥接的通用回退阈值；传输信封与资源链接另算。

每个详情页都链接到 `metadata_uri` 与一个需鉴权的 `metadata_url`。`GET /v1/catalog/agent/content?agent=AGENT&agent_version=DIGEST` 下载恰好那个版本的完整**公开元数据**：描述、全部模型线路、公开的能力 schema 与技能元数据。它不含提示词正文、工具处理器、脚本/文件内容、原生状态与私有的 worker 连接配置。已发布的元数据本身可能含有敏感文字；这不是数据防泄漏（DLP）保证。所有发现与元数据读取都需要 owner、智能体授权与 `read` scope。仅限管理员的完整能力包端点保留它单独的权限边界。

MCP 的 `oaa_list_agents` 使用有界摘要端点；`oaa_inspect_agent` 暴露详情各节。只有需要完整描述或 schema 时才读取它的 `oaa://agents/{encoded_agent}/versions/{digest}` 资源。MCP 资源读取上限 4 MiB，超过就明确失败而不截断；更大的元数据请走需鉴权的 HTTP，或 `oaa agent AGENT --agent-version DIGEST --out NEW_FILE`。命令行下载是私有的，从不覆盖已有文件。`oaa agents` 与 `oaa agent AGENT --section routes` 暴露同样的分页。

摘要式发现会播下一个只含发布信息的轻量通知游标。它不会为了创建这个游标而扫描所有运行时；运行时观察要等到被监视或经完整发现刷新时才开始。列出与监视之间发生的发布变化仍然会被发现。发布 `revision`、不可变的 `agent_version` 与临时的 `catalog_cursor` 是三种分开的令牌，各有各的用途；都不授予访问权限。

<a id="read-only-route-inspection"></a>

### 只读的线路检查

`POST /v1/agents/preview` 接受 `{agent, model?, agent_version?, file_ids?, previous_response_id?}`，需要对该智能体有读权限。它返回选中的已发布线路、排好序的候选、逐节点的约束、必需/可选工具的可用情况，以及执行健康的证据。它不创建运行，也不加载或调用模型。候选节点仅限于这个 owner 与这个智能体的节点授权；它不会向受限范围的调用方暴露无关的节点。

派发时会再次运行同样的放置检查。预览是快照，不是预留。工具全部可用得到 `ready`；缺少可选工具得到 `degraded`；节点占满得到 `busy`；模型目标处于退避得到 `cooling_down`。`available` 表示线路可以被派发或排队，并不表示上游账号/模型已经验证过。

`agent_version` 把一次新的调用或预览固定到某个不可变的发布。OpenAI 兼容请求用 `metadata["oaa.agent_version"]`。续接的会话会拒绝互相冲突的版本/模型选择。未知的或别的 owner 的版本返回 404。

必需的工具（ToolBinding 上的 `required: true`）在任何提供方请求之前检查。不可用的可选工具会从该回合的工具列表里移除，记入 `tools.unavailable`，即使模型仍然要求调用它们也不会被接受。较早的能力包没有这个可选字段，保持原有的摘要。工具选择本身必须得到所选 worker 的支持；不会假定旧版 worker 实现了过滤。

- `GET /v1/runs?limit=50`：有界的、自己名下的运行摘要（`data[]`）。`status` 为 `requires_action` 且有待办的行带有 `waiting_on`（0.3.0）：当所有待办都是 `client_tool` 时为 `"caller"`（运行在等调用方回传它自己的工具结果；owner 无事可做），至少有一个待办需要人处理时为 `"owner"`。其他状态没有这个键，所以其他行的字节完全不变。较早的网关不提供它。
- `GET /v1/runs/{id}`：响应、实际线路、工具步骤、待办、产物元数据与执行错误。
- `GET /v1/runs/{id}/events`：原生 SSE；`Last-Event-ID` 或 `?after=N` 在持久化的事件游标之后续接。
  重放是在背压下写出的：当给客户端缓冲的数据超过 1 MiB 时，网关等客户端读走一些再继续发，并断开 30 秒内什么都不读的客户端；有实时事件到来时停止读取的客户端，在缓冲达到 2 MiB 时仍会被断开。单个大帧从不因为大小而被拒绝，所以终止帧（`response.completed` 带有完整响应，受 `outputTextChars` 限制）总会到达，无论是第一次连接还是续接之后。`GET /v1/responses/{id}?stream=true` 与兼容流同样如此。每个调用方最多可持有 64 条运行事件流（`/events`、`/wait`、Responses 重放与兼容流合计），每个 owner 256 条；超出的返回 `429 too_many_streams` 并带 `Retry-After`。
- `POST /v1/runs/{id}/actions/{action}`：`{decision:"approve"|"deny",response?:{...}}`；需要 `approve`。原生的问题回答可以放在 `response.answers` 里。
- `POST /v1/runs/{id}/resume`：显式地从检查点恢复一个被中断的内核运行。已完成的步骤会被复用。被中断的原生进程从不被盲目重放。恢复时无论由谁恢复（密钥自己，或 owner 的管理员密钥代为恢复别的密钥的运行），都会按提交规则重新检查该运行自己的 API 密钥：密钥必须仍然有效（管理员恢复的运行所属密钥已过期或被吊销时返回 `run_key_inactive`；密钥自己则在鉴权时就被拒绝），它的开发者平台账号处于启用状态（`account_disabled`），智能体仍被授权或上架（`scope_denied`），付费智能体的余额足够（`insufficient_balance`），配额没有用尽（`key_concurrency_limit`、`token_quota_exceeded`、`run_quota_exceeded`；恢复的运行就是同一个运行，所以不会再次计入 `maxRuns`）。被拒绝的恢复让运行保持 `interrupted`，没有任何副作用。恢复的运行会重新计入它的密钥的并发，它的 token 只会加进密钥用量一次（即与它被中断时已计入的部分之差）。
- `POST /v1/runs/{id}/reconcile`：`{step_id,outcome:"completed"|"not_executed",value?}`；需要 `approve`。它记录的是一条**运营者的断言**，不是新测得的工具成功。恢复之前请先处理不确定的副作用。

未知的用量保持 null；不完整的用量用 `oaa.usage_complete=false` 标记。不会根据测试夹具的 token 数推断模型定价或精确计费。续接的会话内模型线路不会改变。新的发布只对新会话更新别名。

`run.awaiting_caller`（`data: { approval_ids }`）只在外部（ACP）智能体的桥接运行里写入：它们在进程内等待调用方而不是停车，所以内核在下一个事件循环回合里宣告新的待处理 `client_tool` 待办，一同到达的调用只宣告一次。兼容响应把它当作 `run.parked` 处理。

内核的工具审批在运行被持久化停车期间保持公开状态 `requires_action`。`run.parked` 表示已经开始的工作已经落定、全局运行槽已释放；单有 `run.requires_action` 并不表示并行的工作或原生进程已经停下。审批唤醒会发出 `run.queued`，并在继续已确认的检查点之前重新取得一个运行槽。重复的部分审批沿用原先的决定，不重跑已完成的步骤。拒绝、过期或取消会结束停车的工作，不授予任何工具。原有的运行超时包含审批等待与重新准入的排队时间。

审批记录把请求的操作放在 `detail`，owner 可选的回复放在 `response`；带 `detail.response` 的旧版已批准内核记录，在显式的检查点恢复时仍被识别。原生的审批等待仍然附着在它的宿主执行上，不释放运行槽。排队的、执行中的与停车的请求，无论经由哪个入口 API 或哪个新的幂等键，都计入每个 owner 32 个未完成请求的上限。

<a id="approval-policy-for-external-agents-approval-policy-v1"></a>

### 外部智能体的审批策略（`approval-policy-v1`）

`POST /v1/agents/publish-native` 接受 `{id, engine, models, approvals?}`，需要 `admin`。`approvals` 为 `"ask"`（默认）或 `"auto"`；智能体定义上有同样的可选字段（能力包、`.oaa` 源码里的 `approvals = auto`、`publish-native` 与 `expose` 上的命令行 `--approvals ask|auto`）。它只对外部智能体有意义：带 `approvals: "auto"` 的 `kernel` 智能体会通不过校验，因为内核的工具审批由各工具的 `requiresApproval` 决定。字段缺失（或为 `ask`）时不写进定义，所以已有的摘要不变。

用 `auto` 时，智能体发来的权限请求仍然先受限制（超过 256 KiB 的详情照旧被拒绝）。之后它不进入 `requires_action`，也不等待：内核存下一条 `status: "approved"`、`kind: "native"`、`response: {"auto": true}` 的审批记录，发出 `approval.resolved`（`{approval_id, decision: "approve", actor: "policy:auto"}`），并答复智能体批准。运行保持 `in_progress`，不写 `run.requires_action`，所以每一种流看起来都像没有发生过权限请求。`approval.resolved` 的 `actor`，对 owner 的决定是批准的那把密钥的名字，对这些策略批准是 `policy:auto`。只有这样的智能体，`GET /v1/agents` 与概览里的智能体条目才带 `approvals: "auto"`；其他条目不变。发布或更新这样的智能体（经任何发布端点）会写一条审计记录，错误码为 `approval_policy_auto`，带 `agent_id`（`GET /v1/audit`）。

执行等级与授权并没有放宽：外部智能体仍然需要 `host` 执行等级的调用方密钥，沙箱、BYOK 与节点授权检查都不变。**风险**：自动批准让调用方以 owner 自己在那台机器上的权限驱动智能体；命令或文件修改在执行之前没有人审阅。只对受信任的调用方使用，配一把只限定这个智能体的专用 API 密钥，并尽量使用沙箱执行等级。

一次审批决定与它的 `approval.resolved` 事件在同一个 SQLite 事务里提交；观察者只在提交之后才收到通知。对账过的步骤与它的 `step.reconciled` 事件同理。审计写入失败会回滚状态变化，也不授予执行。重复一次已经处理过的审批或对账，返回 409，而不是改变已记录的决定。丢失的 HTTP 响应不能证明失败：采取下一步动作之前，请先读取审批/步骤记录。

<a id="bounded-inspection-and-mcp-delivery"></a>

## 有界的检查与 MCP 交付

- `GET /v1/runs/{id}/state`：有界的状态、引擎、选中的线路/版本、已上报用量是否完整、步骤计数、最多五个待处理审批 ID、输出预览、产物数与最近提交的 `event_id`。它不物化完整的模型检查点或步骤结果正文。
- `GET /v1/runs/{id}/steps?offset=0&limit=20&status=uncertain`：只有步骤元数据；可选的 status 为 `pending`、`running`、`completed`、`failed` 或 `uncertain`。最多 50 行；返回 `data`、`total` 与 `next_offset`。`reconciled` 表示存在运营者的对账历史，不是对当前结果的独立验证。
- `GET /v1/runs/{id}/steps/{step}`：步骤元数据、`arguments` 与 `result` 的预览，以及最近一次 `reconciliation`（或 null）。每个预览含 `preview`、原始紧凑 JSON 的 `bytes` 与 `truncated`。被截断的 JSON 是显示文本，不能替代完整记录来解析。预览文本限制在序列化后 8000 字节，完整值被美化缩进输出时最多 16000 字节；信封字段另算。
- `GET /v1/runs/{id}/steps/{step}/content`：显式下载完整存储的步骤，作为 JSON 附件。
- `GET /v1/runs/{id}/actions?offset=0&limit=5`：待处理的审批，`detail` 用同样的预览信封做有界预览；最多 10 行。返回 `data`、`total` 与 `next_offset`。
- `GET /v1/runs/{id}/actions/{action}/content`：显式下载完整的审批 JSON，含它当前的决定与可选的回复。该待办必须属于这个运行。
- `GET /v1/runs/{id}/wait?timeout_ms=20000`：等待终止结果或审批，最长 25 秒。超时返回当前状态并带 `timed_out: true`；这不是任务失败。断开或取消这次等待，释放的是它的监听器，不是已被接受的执行。
- `GET /v1/runs/{id}/output?cursor=...&max_bytes=8000`：有序、无损的输出分页。`max_bytes`（256-16000）限制序列化后的文本字段（含 JSON 转义）；信封元数据另算。沿着 `next_cursor` 一直读到 `done`；`waiting_for_output` 表示读者已到达当前的末尾。`tail_cursor` 可以在显式恢复被中断的运行后继续保留。游标是不透明的，绑定到某个响应，不是凭据。
- `GET /v1/runs/{id}/output.txt`：显式下载目前所有已提交的输出，作为 UTF-8 文本，消息之间以两个换行分隔。这是一个快照，不是等待完成；要保留消息 ID 与状态，请使用分页输出。
- `GET /v1/runs/{id}/artifacts?offset=0&limit=10`：最多 20 个文件描述，外加 `next_offset`。已有的 HTTP 文件下载保留它们 8 MiB 的上限，并需要文件 scope 与产生它的智能体授权。

所有检查端点都需要 `read` scope 与该运行所属智能体的授权，即使是同一个 owner。它们不做任何模型/工具调用。偏移量分页是当前视图，不是跨请求的快照；待审批与按条件过滤的步骤计数可能减少。控制台会调整失效的页，并在刷新时保留审批草稿。它只为显式的下载读取完整记录，从不自动恢复一个不确定的操作。`reconcile` 记录一条人工断言，同时让运行保持中断；`resume` 是另一个需要调用授权的操作。OpenAPI 端点目录包含检查路径、路径参数与分页边界；它不是每个响应体的完整生成 schema。

MCP 桥接复用这些端点。生成的启动器在免费测试套件里经官方 SDK 真实的 stdio 客户端演练过。`oaa_upload_text` 只接受显式提供的文本，从不接受本地路径。`oaa_invoke` 支持稳定的幂等键；已接受任务的回执保留 ID，而不是嵌入完整输出。`oaa_wait_run`、`oaa_read_output` 与 `oaa_list_artifacts` 补全了取回的流程。不暴露任何授予审批的 MCP 工具。

产物按标准的 [MCP 资源链接与资源读取](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)暴露。`oaa://files/{id}` 返回经鉴权的 base64 文件字节，不是公开 URL，也不是本地文件系统路径。MCP 读取限制为 4 MiB 以约束传输帧；更大的文件明确失败，请改用经鉴权的 HTTP 或 `oaa download`。资源的内容是不受信任的数据。宿主专属的界面与安装行为，并不由 SDK 的互操作性推出。[MCP 请求取消](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)会传到待处理的 HTTP 等待/读取，而任务取消仍然是显式的 `oaa_cancel` 操作。

<a id="capability-packages"></a>

## 能力包

一个 `oaa.bundle.v1` 包含一个校验过的 AgentDefinition、一份排好序的显式文件列表（路径、SHA-256、base64 内容）与一个清单摘要。发布从不执行脚本。路径、重复文件、符号链接、凭据文件名、明显的密钥模式、内容哈希与大小限制都会被检查。模式检测不是全面的密钥/DLP 扫描；分发之前请自己审阅选中的文件。

工具声明 ID、版本、输入 JSON Schema、放置方式（`portable` 或 `host-bound`）、副作用等级（`read`、`idempotent-write`、`write`、`unknown`）、是否需要审批、超时、可选的资源键/缓存 TTL，以及结果是否可以离开节点。MCP 的注解不会被自动当作授权决定而信任。

可移植的工具与技能绑定属于内核智能体。原生/外部智能体使用它们宿主自己的工具集；不兼容的混合声明会被拒绝而不是被忽略。原生会话在专用的任务工作区里启动，所以用户级配置与已配置的运行时配置会被继承，但别的项目里仅限工作区的配置不会被自动导入。已有的桌面会话不会被接管或附着。

`execute_graph` 接受最多 32 个已注册的工具步骤。`{ "$ref": "stepId#/field" }` 产生一个依赖；环与未知步骤在执行前就失败。已注册的写资源键会被串行化；读步骤可以重叠。任意的技能 Markdown 不会被编译成可执行代码。

内置的 `read_skill` 只暴露选中的不可变能力包里的文件。内置文件工具拒绝目录穿越/符号链接，并在会话工作区里运行。输入出现在 `inputs/<file_id>/<filename>`，产物在 `outputs/<filename>`。

<a id="node-wire-protocol"></a>

## 节点线协议（Node wire protocol）

WebSocket 已连接不等于节点注册完成。worker 发送 `hello` 后最多等待 5 秒；未收到有效的 `welcome` 就按原退避策略重连。注册前不会接任务；HTTP 401/403 仍会停止重连。

若 `welcome.features` 含 `artifact-chunks-v1`，节点可通过当前执行租约回传文件。`artifact_chunk` 包含 RPC 的 `id`、`leaseId`、从零开始的产物序号 `index`、字节偏移 `offset`、总大小 `bytes`、`name`、`sha256` 和 Base64 编码的 `data`（解码后最多 128 KiB）。收到相同租约、序号和偏移的 `artifact_ack` 后才发送下一块。最终结果用 `transferIndex` 与空 `content` 引用对应文件，不传节点本机路径。传输中断将丢弃未确认数据，不自动重放任务。

<a id="node-lifecycle-control"></a>

### 节点生命周期控制

节点管理需要 `admin` scope **并且** owner 的 `agents: ["*"]` 授权。只限定部分智能体的管理员密钥仍可管理它被允许的发布，但不能查看全宿主的节点/后端清单，也不能改变节点准入。调用方 API 密钥与 worker 凭据仍是互相独立的权限。

- `GET /v1/nodes/registrations`：已配置的、已登记的、本机的以及保留的已退役身份，包括已断开/已吊销的记录。从不返回凭据与凭据哈希。离线节点的 `active: null` 表示没有观测到工作，不是零工作。`drained: true` 只对仍连接着、处于排空状态且网关侧已没有任务的节点上报。
- `POST /v1/nodes/{id}/drain`，带 `{reason?: string}`：持久化 `draining` 并停止新的派发。已经在执行的 worker 调用可以正常结束。尚未到达执行的准备工作，在策略变化后不能再启动新的调用。被排空挡住的已接受内核运行变为 `interrupted`，错误码 `node_draining`；已完成的结果/产物仍是检查点。恢复容量后，显式恢复这个运行。这是步骤级的排空，不承诺整个多步任务能在维护期间完成。
- `POST /v1/nodes/{id}/resume`：在已有授权下重新启用一个排空中的身份。它不会自动恢复被中断的任务，也不会扩大宿主权限。
- `POST /v1/nodes/{id}/revoke`：终止性地撤销这个身份的信任，包括已通过 HTTP 升级但还没发 hello 的连接。之后的加入会被拒绝；活跃的执行方拒绝待处理的调用，并在异步关闭套接字之前忽略后续的帧。一个进行中、没有确认结果的写入/原生操作仍然是不确定的，需要对账。重复同一策略是幂等的；已吊销的身份不能被恢复或重新登记。需要替换时，请审查并登记一个新身份。
- `GET /v1/nodes/{id}/history?after=0&limit=50`：限定 owner 的策略审计，每页最多 100 条。策略与审计在派发权限改变之前于同一个事务里提交。审计写入失败不会吊销或暂停该节点。

合成的本机 worker 不受这些远程凭据控制的影响。请改用它已有的本机执行设置或网关生命周期。原生后端配置文件与节点凭据文件不会被策略操作改写。配置文件里的凭据，重启之后仍被它持久化的吊销所拒绝。重复的凭据身份，以及把已保留的身份分配给另一个 owner 的尝试，在启动时直接失败（fail closed）。

控制台提供暂停/恢复/吊销控件，并保留离线/已吊销的行。命令行对应的是 `oaa nodes`、`oaa node drain NODE`、`oaa node resume NODE`、`oaa node revoke NODE` 与 `oaa node history NODE`；`oaa resume RESPONSE_ID` 恢复一个已确认的内核检查点。不向执行任务的调用智能体暴露任何节点管理的 MCP 工具。更新后的 worker 在 HTTP 401/403 握手拒绝后停止重试；旧 worker 可能仍会重试，但仍会被拒绝。

吊销不是对远程进程的证明，不是对之前传出数据的删除，也不是外部副作用已停止的证据。响应会明确报告 `external_effects_stopped: "not_verified"`。已有的分区/资源锁限制仍然适用。Schema v3 持久化节点策略及其审计；较早的 schema v2 网关会拒绝这个数据库，而不是悄悄忽略吊销。升级之前请先备份，并把恢复更早的备份视为恢复更早的权限状态，需要复核。

`hello.execution` 在原有 `advertisement` 对象旁边（而不是里面）加入执行方能力元数据，保持旧版 hello 的形状。它列出内置工具、已启用的脚本运行时、是否支持逐回合的工具列表，以及原生模型映射。新网关在 `welcome.features` 里通告 `execution-capabilities-v1`；只有这时，worker 才会用 `advertisement` 消息发送有变化的元数据。

模型的 `Work` 可以带一个可选的 `maxOutputTokens`（调用方的输出上限，始终低于已发布的 `limits.maxOutputTokens`）；worker 对模型调用采用两者中较小的一个，忽略它的旧版 worker 使用已发布的上限。智能体定义本身与已发布的保持一致。

`welcome.features` 现在是 `execution-capabilities-v1`、`byok-v1`、`sandbox-v1`、`provider-turn-v1`、`client-tools-v1`、`image-input-v1`、`trace-context-v1`、`conversion-profiles-v1`（此外 `/health` 还声明 `prometheus-metrics-v1` 对应 `GET /metrics`，以及 `trace-context-v1` 对应 W3C `traceparent` / `tracestate` 全链路透传）。有了 `trace-context-v1`，worker 会接收 `WorkContext.trace` 与 `WorkContext.subject`（向旧 worker 派发时自动剥离）；有了 `conversion-profiles-v1`，worker 会上报 `execution.adapterProfiles`，使仅存在于远程节点的自定义 `adapter/<name>` 在网关侧呈现真实 `ConversionProfile` 画像。有了 `image-input-v1`，worker 会上报 `execution.imageInput = { providers: {<名字>: "none"|"inline"|"url"}, native: {<引擎>: "native"|"agent-declared"|"workspace-file"} }`；带图片的运行只放到声明覆盖了它的提供方或引擎的 worker 上（放置原因 `image_input_unsupported`），所以旧 worker 永远收不到这种运行（[images.md](images.md)）。有了 `client-tools-v1`，worker 会上报 `execution.clientTools = { native: ["kernel", "codex", "claude", "adapter/<acp name>", …] }`：它能桥接调用方工具的引擎（见 harness.md）。桥接运行只会放到声明了该运行引擎的 worker 上（否则放置原因是 `client_tools_unsupported`）；没有这样的 worker 时，提交返回 `client_tools_bridge_unsupported`（400）。只有这些 worker 会收到 `Work.native.clientTools` 并发送 `client_tool` 事件（`data: { name, arguments, relay_call_id }`），网关像对待审批那样用 `{ output }` 或 `{ error }` 答复它。旧 worker 与旧网关继续工作；旧 worker 只是永远收不到桥接的工作。每次更新都按与最初登记相同的节点身份和凭据授权来校验。空闲的对端在心跳过期后也会失去它的登记。

原生执行要求节点凭据除了智能体别名之外，还授予 `native/<engine>`（或 `*`）。`oaa expose` 只授予它所选的原生执行器。通用适配器使用 `native/adapter/<name>`。已启用的原生可执行文件只检查本机是否可用，不会启动它们；声明的模型映射仍不能证明账号/模型的兼容性。

限流冷却与耗时估计按执行目标记录，而不是按整个 worker。那个 worker 上不相关的模型可以继续。模型线路的统计不含内核的工具执行、人工审批等待、取消与不相关的工具错误。原生适配器仍是不透明的，所以它们成功的线路样本包含内部的智能体工作，扣除桥接的审批等待。晚到的成功调用不会抹掉更新的限流退避。候选调度的估计包含策略先验与传输/冷启动惩罚；它们不是实测的端到端延迟保证。

位于 `/v1/nodes/connect` 的经鉴权的 WSS 要求 `Authorization: Bearer <node token>` 与 `X-OAA-Node-ID`。握手声明 `protocol:"oaa/1"`，以及节点通告的提供方、原生运行时、能力版本、预热的能力包与并发数。

网关发出的 `install` 与 `execute` 请求带有唯一的请求/租约 ID。worker 的回复带同一个租约，流式的 `event` 记录与一条终止的 `result`。心跳与续租默认使用 15 秒的租约。取消与审批的回复限定在一个存活的请求/租约内。断开会中止它名下的任务；迟到的或租约不对的结果不会提交。投递不被表示为对任意外部服务的恰好一次执行。

网关在对上行的每一帧采取行动之前都会校验它（`src/fabric/node-messages.ts`）。不是 JSON 对象、超过 `nodeMessageBytes`（24 MiB）、或带有已知 `type`（`event`、`result`、`advertisement`）但字段形状不对的帧，会以 1008 关闭连接；该连接上其他进行中的调用以 `node_disconnected` 结束。`result` 会与它回应的请求对照检查：`model` 需要 `text` 与 `calls`（`usage`、`finish`、`providerItems`、`providerState` 可选），`tool` 接受缺少 `value`，`native` 需要 `text` 与 `nativeState`。格式错误的 result 让它的调用以 `invalid_protocol` 失败，并标记为不确定（worker 声称它运行过），同时关闭连接。缺失或格式错误的 `usage` 记为未知（`null`）。不是短的 snake_case 标识符的 `error.code` 变成 `worker_failed`，`error.message` 截断到 4,000 个字符。迟到的、重复的、租约不对的或外来 `id` 的帧以及未知的消息类型会被忽略并记录（每个连接在内存里保留最近 50 条问题）。对象允许带额外字段，所以新旧 worker 都能继续工作；没有任何已有字段改名或改变含义。

取消是一个请求，不是停止确认。网关保留被占用的槽位及其内存里的资源锁，直到对应的 result 确认 worker 调用已经返回，或节点断开。取消期间它忽略新的输出/审批事件、停止续租，若在一个租约间隔内没有收到对应的 result，就断开 worker。取消的 HTTP 响应在运行清理之后发出；对远程调用，这包括等待确认或租约宽限期。断开一个卡住的 worker 也会中断它其他进行中的请求；不确定的外部写入需要对账，而不是自动重放。

当前的 worker 在被取消的任务的调用返回之前，一直把它们计入容量。断开或关闭时，它中止自己名下的工作，等这些调用落定，然后才重连或关闭共享的运行时客户端。超出实际容量的新执行在开始之前就以 `worker_capacity_exceeded` 被拒绝；过期的或租约不对的取消/续租/待办控制会被忽略。能力包准备期间的取消，永远不会授权之后的工具启动。要得到这些生命周期保证，请同时升级网关与 worker；旧 worker 的重连行为无法从不变的 `oaa/1` 线格式推出。

这些是本机运行时的生命周期保证，不能证明外部 HTTP 适配器、上游提供方或脱离控制的子进程已经停止了它们的副作用。一个永远不落定的进程内处理器，会刻意让那个 worker 保持不可用，而不是被错误地宣布已停止。任意代码无法被安全抢占，内存里的资源锁也不是跨分区或网关重启的分布式围栏机制。

第一个版本只有一个权威网关。它不是多主网状结构，也没有多网关故障切换。宿主绑定的密钥从不打进能力包。文件放置约束覆盖已声明的传输，不是对任意模型生成文本或不受信任工具内容的语义级信息流分析。

<a id="mcp-tool-bindings"></a>

## MCP 工具绑定

一个准备好的 MCP 工具是一个普通的宿主绑定能力，带有明确的节点、副作用等级、审批策略、导出策略与不可变的版本。它的公开处理器只是 `{kind:"node",reference:"..."}`。私有的 worker 覆盖层把这个引用映射到 `{kind:"mcp",server:"configured-name",tool:"selected-tool",descriptorSha256:"..."}`。连接配置与凭据引用都留在 worker 上。`prepare` 只发送初始化/目录请求；它从不调用该工具，也不修改正在运行的节点。副作用未知、必须审批与禁止导出结果是默认值。

描述符摘要覆盖选中的名称、描述、schema 与注解提示。执行之前会与当前元数据对照检查；不一致就阻止这次调用。它不是服务端代码的签名，也不能证明实现的行为与它声称的一致。`readOnlyHint` 之类的提示永远不会覆盖运营者的副作用与审批声明。同一个节点上可以并存不同的能力版本，各有各的私有引用；选择时比较的是完整的带版本元数据，而不只是第一个匹配的能力 ID。

MCP 客户端连接按 owner/会话/能力包摘要划分。传输配置或凭据变化后，旧连接不再用于新工作；活跃的调用可以在清理之前结束。普通的领域错误不会关闭共用该会话的其他调用。声明了但缺失的 HTTP 凭据引用直接失败（fail closed），也不会被通告为可用。连接缓存最多保留 16 个空闲项，60 秒后过期；私有的 MCP 进程状态不是持久的平台状态。

## 控制台概览：修订号、ETag 与事件流

> 本节为新增内容（2026-11-07）。

**修订号（revision）**：网关为每个 owner 维护一个单调递增的整数修订号，覆盖 `GET /v1/overview` 报告的全部内容。它在以下情况推进：运行摘要/统计提交后（`runs`）、发布智能体或路由健康变化（`catalog`）、节点上线/下线/通告变化/调度开始与结束/节点策略变化/本机后端开关（`nodes`），以及冷却期到期等纯时间驱动的状态变化。修订号起点取自启动时刻的微秒级时钟，因此网关重启后仍继续增大，旧 ETag 不会与重启后的新状态碰撞。文件系统、环境变量等没有事件的输入，最多 5 秒后会被重新核对，只有内容确实变化时才推进修订号。

**`GET /v1/overview`**（需要 `read`）：

- 响应体新增 `revision` 字段；其余字段不变。
- `metrics` 新增 `queued`、`in_progress`、`requires_action` 三个计数（2026-11-08），与 `active` 同口径：owner 加密钥的 agents 授权范围、按运行当前状态统计，三者之和恒等于 `active`。`requires_action` 即正在等待审批的运行数，可直接用于「需要处理」提示或 Dock 角标，不受 `runs` 只列最近 12 条的限制。
- 响应头 `ETag: W/"ov.<revision>.<身份摘要>"`，身份摘要由调用方 owner、密钥名、`keyId`、scopes、agents 授权以及解析后的公开地址计算。
- 请求带 `If-None-Match`（可为列表或 `*`，按弱比较）且命中时返回 `304`，无响应体。
- `runs[]` 的行与 `GET /v1/runs` 同样带可选的 `waiting_on`（0.3.0）：只在 `status` 为 `requires_action` 且有待处理待办时出现，`caller` 表示待办全是调用方工具（只在等调用方回传，不需要 owner 处理），`owner` 表示有需要人工处理的待办。待办的创建与解决会刷新运行摘要并推进修订号（`runs`），所以 `waiting_on` 变化时 ETag 随之失效。
- 智能体可用性、节点清单与统计按修订号缓存；`runs` 列表在每个 `200` 响应中重新读取，以便运行中的任务给出当前的 `elapsed_ms`。`304` 表示自上次 `200` 以来修订号未变，客户端应基于 `created_at` 自行计算运行中任务的耗时。

**`GET /v1/overview/events`**（SSE，需要 `read`；鉴权只走 `Authorization` 头，令牌不放进 URL）：

```text
event: ready
data: {"revision":1794312000123456}

event: changed
data: {"revision":1794312000123460,"reasons":["runs","nodes"]}

: ping
```

- 连接后立即发送 `ready`；之后的变化约每 250 ms 合并为一个 `changed`，`reasons` 为 `runs`、`catalog`、`nodes` 的子集（固定顺序）。收到 `changed` 后用 `If-None-Match` 重新请求 `/v1/overview`。
- 每 20 秒发送一行 `: ping` 心跳；每次心跳都会重新校验密钥，密钥被删除或授权变化时立即关闭连接。
- 每个 API 密钥最多同时保持 4 条概览事件流，超出返回 `429 too_many_streams`。
- 事件只包含修订号与原因，不携带运行内容；只通知同一 owner 的变化（同一 owner 下受 agents 限制的密钥也会收到该 owner 其它智能体的变化通知）。
- 旧版本网关没有该路由时返回 `404`，客户端应退回轮询。

**存储**：本次改动不修改 SQLite 结构（`PRAGMA user_version` 仍为 3），持久化语义不变（WAL + `synchronous=FULL`，检查点与其输出事件在同一事务中提交）。修订号与缓存只在内存中，不落盘。

## 可观测内核：运行时间线、活动脉搏、排队与能力协商

> 本节为新增内容（2026-11-08）。全部数据从已持久化的状态推导：生命周期事件、执行步骤，以及检查点里的模型轮次标记。不调用模型或工具，不新增事件类型，不修改 SQLite 结构（`user_version` 仍为 3）。兼容端点（OpenAI / Claude / Gemini / UAP）的输出流与事件序号不变；测试按 `bench/protocol-speed.ts` 的同一工作量逐字节核对：UAP NDJSON 10,238 字节，OpenAI Chat SSE 55,219 字节。

### `GET /v1/runs/{id}/timeline`

需要 `read` scope 和该智能体的授权，与其它运行检查接口一致：别的 owner 的运行返回 `404 run_not_found`，未授权的智能体返回 `403 scope_denied`。响应头 `ETag: W/"tl.<last_event_id>.<status>"`；`If-None-Match` 命中时返回 `304`。运行中的任务在没有新事件时也会返回 `304`，此时前端用 `now` 自行推算进行中 span 的时长。

| 字段 | 说明 |
| --- | --- |
| `id`、`status` | 运行 ID 与当前状态 |
| `created_at`、`ended_at`、`now` | 毫秒级 epoch；`ended_at` 是最近一个终止事件的时间，未结束为 `null` |
| `total_ms` | `(ended_at ?? now) - created_at` |
| `last_event_id` | 该运行最后一个事件的 ID（也用于 ETag） |
| `spans[]` | 时间段列表，按开始时间排序，最多 200 个 |
| `critical_path_ms` | 关键路径上各 span 覆盖的时长之和；`total_ms - critical_path_ms` 是没有被任何关键 span 覆盖的空隙 |
| `breakdown_ms` | `{queue, model, tools, approval, other}`，沿关键路径归因，各项之和恒等于 `total_ms`；空隙计入 `other` |
| `truncated` | span 超过 200 个时为 `true`；会优先保留关键路径上的 span，`critical_path_ms` / `breakdown_ms` 仍按全部 span 计算 |

每个 span：

| 字段 | 说明 |
| --- | --- |
| `id` | `sp_1`、`sp_2`…（同一 `last_event_id` 下稳定） |
| `kind` | `queue`、`model`、`tool`、`approval`、`client_tool`、`subagent`、`interrupted`、`native`（`client_tool` 是桥接的运行在等调用方执行它自己的工具，归入 `tools`） |
| `label` | 机器可读标识，中文由前端按 `kind` 渲染：排队原因（`admission`、`fairness`、`approval`、`agent_fallback`、`node`）、模型路由 ID、工具名、需要审批或在等调用方的工具名、原生审批类型、子智能体名、原生引擎名 |
| `ref` | `{turn, attempt?}`（模型）、`{step_id, tool}`（工具）、`{approval_id, step_id?}`（审批、client_tool）、`{step_id, child_run_id?}`（子智能体） |
| `lane` | 泳道：0 号放主线（排队、模型、原生执行、审批），并行的工具/子智能体由服务端从 1 号起贪心打包；节点等待 span 与对应工具同一泳道 |
| `start_ms`、`end_ms` | 相对本运行 `created_at` 的毫秒偏移（不是 epoch 时间戳）；`end_ms` 进行中为 `null` |
| `status` | `completed`、`failed`、`cached`、`running`、`waiting`、`uncertain`、`cancelled` |
| `critical` | 是否在关键路径上 |
| `depends_on` | 依赖的 span ID：工具依赖发起它的模型轮次、它的审批、以及执行图中 `$ref` / `depends_on` 指向的步骤；主线 span 依赖前一个主线 span 和期间完成的整批工具 |
| `estimated` | 仅在推导值上出现，值为 `true`（见下文「旧运行」） |

规则与口径：

- **关键路径**：从最晚结束的 span 出发，沿「最晚结束的依赖」回溯到起点。并行工具只有决定时长的那一个会被计入，不会重复计时。
- **原生/ACP 智能体**：整段执行记为 `native`，归入 `model`（平台看不到其内部工具耗时）；原生审批会把执行切成「执行—审批—执行」三段。
- **节点等待**：工具从排队到开始执行、模型轮次从开始到节点接手、原生智能体从开始到节点接手，等待超过 10 ms 时单独显示为 `queue`（`label: "node"`）。
- **中断与恢复**：网关重启或失败后被显式恢复的运行，在中断事件与恢复执行之间显示 `interrupted`，归入 `other`。
- **旧运行**：本版本之前完成的运行没有模型轮次标记，模型 span 由工具批次之间的空隙推导，并带 `estimated: true`。
- 检查点中最多保留 400 个模型轮次标记。

### `GET /v1/overview/activity?window=24h|7d`

需要 `read` scope，默认 `24h`；其它取值返回 `400 invalid_request`。统计范围与 `/v1/overview` 的 `runs` 相同（owner + 密钥的 agents 授权）。ETag 绑定**运行修订号**、`window`、当前桶起点和调用方身份（`W/"act.<revision>.<摘要>"`），命中时返回 `304`。运行修订号只随运行摘要的变化推进，发布智能体、节点上下线或负载变化不会让活动统计重算，也不会改变它的 ETag（1 万个运行时，目录变化后的读取从约 11 ms 降到约 0.06 ms）。运行变化后采用增量读取：已完成、失败、取消、未完成的运行不会再变，每个视图缓存已解析的行，之后只读取新插入的运行和仍可能变化的运行（进行中、排队、待审批、可恢复的中断），1 万个运行时约 1.8 ms（原先每次全量扫描约 11 ms）；结果与全量扫描逐字段一致，有测试保证。没有变化的轮询约 0.05 ms。概览的 `metrics` 同样只随运行修订号重算。

| 字段 | 说明 |
| --- | --- |
| `window`、`revision`、`generated_at`（ISO）、`bucket_ms` | 窗口、运行修订号（只随运行变化推进，不大于 `/v1/overview` 的 `revision`）、计算时间、桶宽 |
| `buckets[]` | `{start(ISO), started, completed, failed, cancelled, interrupted, active}`。`24h` 为 24 个 UTC 整点对齐的 1 小时桶，`7d` 为 28 个按 UTC 00/06/12/18 点对齐的 6 小时桶；最后一个桶是当前（未满）的桶 |
| `totals` | 同上各计数之和，外加 `success_rate` |
| `latency_ms` | `{p50, p95, samples}`：窗口内已结束运行的端到端耗时（最后一次检查点时间 − 创建时间），最近秩法分位 |
| `breakdown_ms` | `{queue, model, tools, approval, other, runs}`：窗口内最近 ≤100 个已结束运行按时间线算法逐项求和（`runs` 为实际聚合的运行数）；没有已结束运行时为 `null`。已结束运行的时间线按运行缓存 |
| `agents[]` | `{agent, runs, completed, failed, p50_ms}`，按运行数降序取前 8（同数按智能体 ID） |

口径：运行按 `created_at` 落桶、按**当前状态**计数；`failed` 包含 `incomplete`（截止时间、轮次或 token 上限）；`active` 为 queued / in_progress / requires_action；`success_rate = completed / (completed + failed + interrupted)`，取消不算失败也不计入分母，分母为 0 时为 `null`，保留 4 位小数。窗口内运行数越多计算越慢（O(窗口内运行数)），窗口之外的历史不会被扫描。

### 排队透明（`queue`）

`/v1/overview` 的 `runs[]` 和 `GET /v1/runs/{id}/state` 在以下情况增加 `queue` 字段：运行 `status` 为 `queued`（等待内核准入）；或运行为 `in_progress`，但当前这一步工作还在节点队列里等待。

| 字段 | 说明 |
| --- | --- |
| `position`、`ahead` | 在队列中的位置（从 1 开始计，`ahead = position − 1`）和排在前面的数量，**只统计同一 owner 的运行**；队列中找不到时（例如网关尚未开始调度）为 `null` |
| `reason` | `admission`（等待运行槽位）、`fairness`（在检查点让出后重新排队）、`approval`（审批通过后重新排队）、`node_busy`（节点满载）、`cooling_down`（目标在限流冷却中）、`unknown` |
| `estimated_start_ms` | 预计还需等待的毫秒数：相对于响应生成时刻的时长，**不是 epoch 时间戳**；是估计、不是承诺；未知时为 `null`。内核准入采用**槽位模拟**：每个执行槽位记一个「预计空出时间」，正在运行的任务按其智能体历史占用时长计算经验平均剩余寿命（已运行越久，按同类更长的样本推算剩余时间；超出全部样本时取中位数的 1/4，至少 250 ms），排在前面的每个运行（按全局顺序）依次占用最早空出的槽位、时长取其智能体的典型占用；目标运行拿到槽位的时刻即估计值。样本优先用内核启动后实测的槽位占用（每个 owner+智能体最近 50 次），不足 5 次时用数据库里该智能体最近 50 个已完成运行的耗时；没有任何样本的智能体借用其它已知样本的中位数。确定性模拟（`npm run bench:queue`）中，负载 0.7 / 0.85 / 1.05 时平均绝对误差比旧公式分别降低 49.6% / 74.4% / 78.5%；节点冷却：剩余冷却时间；节点满载：该目标在节点上的平均执行时间（无历史时模型 1000 ms、工具 50 ms） |

多租户隐私：数量类字段从不包含其它 owner 的运行；估计值使用全局排位，因为这才决定实际等待时间，但只暴露时长，不暴露其它 owner 的数量。概览返回 `304` 时，`estimated_start_ms` 是上次 `200` 时的值。

### 能力协商：`GET /health`

`/health`（以及 `/healthz`）仍然公开，不含任何秘密或负载信息，新增排好序的 `features` 数组，供控制台、CLI、SDK 判断可选接口是否存在，不必靠 404 试探：

`a2a-adapters-v1`、`acp-adapters-v1`、`adapter-stream-v1`、`approval-policy-v1`、`catalog-events-v1`、`client-tools-policy-v1`、`conversion-profile-v1`、`error-catalog-v1`、`error-codes-v1`、`harness-bridge-acp-v1`、`harness-bridge-v1`、`image-input-v1`、`local-backends-v1`、`oaa-lang-roundtrip-v1`、`overview-activity-v1`、`overview-etag-v1`、`overview-events-v1`、`platform-setup-v1`、`queue-insight-v1`、`run-timeline-v1`、`structured-output-v1`、`webhooks-v1`、`workflow-output-v1`；配置了 `platform` 段时再加上 `platform-v1`。

（2026-11-11 新增）`client-tools-policy-v1`：按 `X-OAA-Client-Tools`（或 `metadata["oaa.client_tools"]`）处理调用方传入的工具（auto / managed / reject；bridge 见 `harness-bridge-v1`），智能体继续用自己的工具时响应带 `X-OAA-Client-Tools: ignored`，工具交给了智能体时带 `bridge`；画像含 `client_tools` 字段。网关配置 `clientTools.default`（缺省 `auto`，也可以是 `managed` / `bridge` / `reject`）决定请求什么都没选时得到什么。`harness-bridge-v1`：内核智能体经 Chat Completions、Responses 与 Claude Messages 支持 `bridge`（调用方工具以 `tool_calls` 交回调用方执行，同一个运行续接）。见 [harness.md](harness.md)。

（0.3.0 新增）`harness-bridge-acp-v1`：ACP 外部智能体同样支持 `bridge`：调用方工具经 `oaa-caller` MCP 中继交给内层智能体，等待期间内层进程保持存活；新事件 `run.awaiting_caller`。见 [harness.md](harness.md)「外部智能体的桥接是怎么工作的」。

（2026-11-08 新增）`adapter-stream-v1`：worker 支持 `oaa/1-stream` 双向流式适配器 ABI；`a2a-adapters-v1`：支持 `transport: "a2a"` 远程智能体；`conversion-profile-v1`：`GET /v1/agents`、`GET /v1/overview` 的智能体、`GET /v1/catalog/agent`（`section=overview`，MCP `oaa_inspect_agent` 同源）以及 `GET /v1/local/backends` 的每一项都带 `conversion` 转换能力画像。字段与取值见 `docs/adapters.md`「转换能力画像」；画像只由网关本机的静态配置推导（同一进程内不变，因此不影响概览 ETag），远程节点独有的 `adapter/<名称>` 报告为 `access: "unknown"`。

本节接口不引入新的错误码，可能返回的码均已列在下一节：`run_not_found`、`scope_denied`、`invalid_request`、`unauthorized`、`rate_limited`。

## 失败自动换智能体（`oaa.agent_fallback`，2026-11-10）

提交时在 `metadata` 里给出备选智能体：`{"oaa.agent_fallback": "agent/b,agent/c"}`（逗号分隔，最多 4 个）。所有入口（`/v1/invoke`、Responses、Chat、Messages、UAP）都通过元数据生效，不改请求结构。

- **什么时候换**：当前智能体**还没做任何事**就失败——没有任何输出、没有任何工具步骤、外部智能体也还没被启动（例如模型提供方不可用、所有线路都失败、执行机器离线）。此时同一个请求改由下一个备选智能体重新排队执行，请求 ID 不变，调用方不需要重试。
- **什么时候不换**：已经有输出或已经执行过步骤（换人重做可能重复副作用）；被取消、超时、网关正在关闭；副作用结果未知；达到轮数或用量上限；权限或执行等级不允许；使用调用方自带模型密钥（BYOK）的运行。
- **提交时校验**：每个备选智能体都必须存在，调用方必须对它有 `invoke` 权限并满足它的执行等级要求，否则提交即被拒绝（`scope_denied`、`isolation_required` 或 `agent_not_found`）。
- **留痕**：换人时写入事件 `run.queued`，`data` 为 `{reason: "agent_fallback", from, to, error}`；运行的 `metadata["oaa.fallback_from"]` 记录被换下的智能体，`oaa.agent_fallback` 更新为剩余的备选。运行在目录里的归属随之改为新智能体，原来的失败不会产生 `response.failed` 事件。
- **怎么选下一个**：按链的顺序找第一个当前可用的备选——调用方仍有权限、满足与提交时相同的执行等级检查（含它的委托链），并且它的模型线路此刻在节点上有可用的执行者（看节点、沙箱等级与输入文件放置）。不满足的直接跳过，换到链上的下一个；都不满足时运行以原来的错误结束。
- **新智能体看到什么**：会话里的对话文字（用户消息）、输入文件；不带上一个智能体的系统指令、provider 状态或会话句柄。
- **截止时间**：继承原截止时间，不重新计时——备选智能体只有原请求剩下的时间。
- 不声明备选时行为与之前完全相同。

## 一键启用已安装的智能体（2026-11-10）

`POST /v1/local/presets/{id}/enable`（owner 管理员密钥）把「写入配置、重启、打开开关」合成一步：

- `{id}` 是「支持的智能体」目录里的预设 ID（如 `gemini`、`qwen`、`opencode`）。本机 `PATH` 上找不到对应程序时返回 `backend_unavailable`，不会安装任何东西。
- 配置里还没有这个智能体时，按 `oaa doctor --write` 相同的内容新增一条适配器记录并立即生效，不需要重启；网关由 `oaa serve` 启动时同时写回配置文件（文件里仍记为停用，启用状态记在数据库，与手动开关一致）。已有记录时只打开开关。
- 返回 `{engine, enabled: true, preset, configured: "added"|"existing", persisted}`。`persisted: false` 表示网关不是从配置文件启动的，新增记录只在本次运行期间有效。
- 这是显式的管理员操作：网关不会自己发现后自动启用，也不会调用模型。启用之后还需要「发布」才会成为可调用的智能体。

## 智能体交接（`handoff`，2026-11-10）

同一个会话里可以换另一个智能体接着干，也可以让同一个智能体换一条模型线路继续。

- **怎么用**：续接请求带上 `previous_response_id`，并显式声明交接——`POST /v1/invoke` 用 `"handoff": true`；OpenAI Responses、UAP 等兼容入口不改请求结构，用 `metadata: {"oaa.handoff": "true"}`。`POST /v1/agents/preview` 同样接受 `handoff`，可在切换前先检查新智能体现在能不能用。
- **不声明就不变**：没有交接标记时，续接到另一个智能体仍返回 `invalid_continuation`，续接时换模型仍返回 `model_switch_requires_new_session`。
- **前提**：上一轮必须已经 `completed`；调用方必须对新智能体有 `invoke` 权限。
- **继承**：会话 ID、输入文件、之前生成的文件。
- **不继承**：上一个智能体的模型线路与版本固定、它私有的原生会话句柄（`nativeState`）、provider 原生轮次状态、它的工具调用细节与系统指令。
- **对话怎么带过去**：只带用户消息和智能体的最终文字回复。内核智能体把它当作消息历史；外部智能体（Claude Code、Codex、Antigravity、ACP、A2A、适配器）自己管理会话，所以在本轮输入前面加一段有上限（12,000 字符，单条 2,000 字符，文件名最多 50 个）的「交接说明」。运行记录里的 `input` 仍是调用方的原始输入。交接说明只在交接的那一轮发送一次，之后该智能体正常续接自己的会话。
- **留痕**：跨智能体交接的运行在 `metadata` 里带 `oaa.handoff_from: <上一个智能体 id>`。同一智能体只换线路时不写。
- **边界**：交接说明只含对话文字和文件名，不读取文件内容，也不是权限边界——新智能体能访问什么仍由它自己的发布内容和调用方密钥决定。

## 结构化输出（`structured-output-v1`）

请求要求 JSON 时（Chat 的 `response_format` 为 `json_object` / `json_schema`，Responses 的 `text.format`，Gemini 的 `generationConfig.responseMimeType: "application/json"` 加 `responseSchema` / `responseJsonSchema`，Claude 的 `output_config.format`），它成为这次运行的输出契约：成功的响应就是能解析、合乎 schema 的 JSON（Ajv：draft-07、2019-09 与 2020-12，`format` 也校验），否则运行以 `structured_output_invalid` 失败（422；Responses 为 `status: "failed"`）。智能体的答案在校验通过前先扣着，所以流式响应在最后一次性送出最终的 JSON，其间有心跳保持连接。答案不合格时送回去修正（`structuredOutput.maxRepairs`，缺省 1 次；外部智能体只在会话可续接时才重问）。网关无法如实校验的 schema 在请求时就被拒绝：`output_schema_unsupported`（或 `invalid_schema` / `schema_dialect_unsupported`）。细节、限制与确切规则见 [structured-output.md](structured-output.md)。

## 流式过程（`stream-progress-v1`）

兼容入口的流可以带上每个运行阶段的一行说明（排队、开始执行、每次工具调用及其结果、审批、切换备选、结构化输出的修复轮），用各协议自己的思考形状：Chat 用 `delta.reasoning_content`；Responses 用 `output_index` 0 处的 `reasoning` 输出项与 `response.reasoning_summary_*` 帧（之后的 `output_index` 加一）；Claude 用 index 0 的 `thinking` 块（签名 `oaa-progress-v1`）；Gemini 用 `thought: true` 的 part。答案文字、非流式响应体与用量不变。按次用 `X-OAA-Progress: reasoning | off` 或 `metadata["oaa.progress"]`；网关缺省值 `streamProgress`（Chat 关、Responses 开、Claude 关、Gemini 开）。`response.reasoning_summary_*` 是线上帧，不是运行事件。结构化输出的一次修复轮会写一条 `tool.progress` 事件 `{source: "gateway", event: "output_repair", round}`。细节与客户端对照表：[progress.md](progress.md)。

## 工作流返回契约

`GET /health` 的 `workflow-output-v1` 表示网关支持工作流的 `output` / `outputSchema` 与动态 `execute_graph.output`；`oaa-lang-roundtrip-v1` 表示 DSL 格式化会重新编译并比较契约。它们不要求客户端改变现有请求：未指定返回投影时仍返回完整步骤结果。详见 [OAA-Lang 执行契约](language.md)。

## 运行事件回调（`webhooks-v1`）

owner 级管理员密钥可以登记接收运行事件的 HTTPS 端点：`run.requires_action`、`run.completed`、`run.failed`、`run.cancelled`、`run.incomplete`、`run.interrupted`（与状态机的运行状态一一对应），另有 `webhook.test`。完整说明、载荷、签名校验与走查见 [webhooks.md](webhooks.md)；这里是摘要。

| 接口 | 请求体 / 结果 |
| --- | --- |
| `GET /v1/webhooks` | `{data: [endpoint]}` |
| `POST /v1/webhooks` | `{url, events?, agents?, include_output?, enabled?, description?, allow_insecure_http?, allow_private_network?}` → 201 endpoint，外加 `secret`（只在这里和轮换时返回） |
| `GET /v1/webhooks/{id}` | endpoint |
| `PATCH /v1/webhooks/{id}` | `POST` 中的任意字段 → endpoint |
| `DELETE /v1/webhooks/{id}` | 204；排队中的投递一并删除 |
| `POST /v1/webhooks/{id}/rotate-secret` | `{id, secret}` |
| `POST /v1/webhooks/{id}/test` | 202 delivery（`webhook.test`） |
| `GET /v1/webhooks/{id}/deliveries?limit=20` | `{data: [delivery]}`，新的在前，`limit` 最多 200 |
| `POST /v1/webhooks/{id}/deliveries/{delivery}/redeliver` | 202 delivery（投递编号不变） |

- 其它密钥得到 403 `scope_denied`；别的 owner 的端点是 404 `webhook_not_found`。调用方不能在请求里带回调地址。
- 每次投递是带 JSON 请求体 `{id, type, created_at, data}` 的 `POST`；`data` 是运行摘要（`run_id`、`agent`、`agent_version`、`status`、`error`、`usage`、`key_id`、`subject`、时间，`run.requires_action` 另有 `pending_actions`），从不包含任务输入；只有 `include_output: true` 时才带最终输出（最多 32 KiB，超出标记 `truncated`）。
- 请求头：`X-OAA-Signature: t=<秒>,v1=<hex(HMAC-SHA256(secret, t + "." + 请求体))>`、`X-OAA-Event`、`X-OAA-Delivery`（重试时不变）、`User-Agent: OpenAgentAPI/<版本>`。
- 投递至少一次，来自持久队列：超时 10 秒，不跟随重定向，`2xx` 为成功，共尝试 6 次，退避从约 5 秒到 30 分钟；同一端点一次只发一条。
- 地址：只允许 `http`/`https`，不能带凭据；除回环地址外必须 `https`（除非 `allow_insecure_http`）；`security.profile` 为 `"public"` 时拒绝私网、回环、链路本地与云元数据地址，除非 `allow_private_network`。

## 开发者平台

只在网关配置了 `platform` 段时存在，`/health` 的 `features` 含 `platform-v1`；未配置时下面的路径都是 404 `route_not_found`，`/openapi.json` 也不含它们。定位、配置、计费规则与运营流程见 [platform.md](platform.md)，这里只列接口。错误响应沿用 `{ "error": { "code", "message", "type" } }`，新增的 `platform` 类错误码见本文「错误码」一章的「开发者平台」小节。金额单位是「点」，时间是毫秒时间戳；分页的 `next_cursor` 是数字或 `null`。

**两种凭据互不通用**：门户会话令牌 `oas_…`（`Authorization: Bearer`）只用于 `/v1/portal/*` 的会话接口，拿 API 密钥 `sk-oaa-…`（旧的 `oaa_…` 同样）访问它们得到 `session_invalid`（401）；会话令牌访问调用接口（如 `/v1/responses`）得到 `unauthorized`（401）。`/v1/portal/*` 与 `/portal`、`/portal/*` 不要求 API 密钥，Host 白名单与 Origin 检查照常生效，在控制台域名与 API 域名上都可用。

### 公开接口（不需要凭据）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /v1/portal/site` | `{site_name, registration, base_url, endpoints, version}`，`endpoints` 与 `GET /v1/me` 的目录相同，`version` 与 `/health` 同源 |
| `GET /v1/portal/agents` | `{data: ListedAgent[]}`，只含已上架且智能体已发布的 |
| `GET /v1/portal/agent?id=` | 一个 `ListedAgent`；未上架 404 `agent_not_found` |
| `POST /v1/portal/signup` | `{email, password, name?, invite_code?}` → 201 `{account, session}`；按来源 IP 限流 |
| `POST /v1/portal/login` | `{email, password}` → `{account, session}`；按来源 IP 与邮箱限流 |
| `POST /v1/portal/password-reset` | `{email, code, new_password}` → 204，该账号的全部会话作废；按来源 IP 与邮箱限流（数值与登录相同）；邮箱不存在、码不对、过期或已用一律 400 `invalid_code` |

### 门户会话接口（`Authorization: Bearer oas_…`）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /v1/portal/logout` | 204 |
| `GET /v1/portal/account` | `{account}` |
| `POST /v1/portal/account/password` | `{current_password, new_password}` → 204，该账号的全部会话作废 |
| `GET /v1/portal/keys` | `{data: PortalKey[]}`，新的在前；已删除的密钥不列出 |
| `POST /v1/portal/keys` | `{name}` → 201 `PortalKey + {token}`，明文只此一次 |
| `DELETE /v1/portal/keys/:id` | 204；密钥立即失效，且不再出现在列表里 |
| `POST /v1/portal/redeem` | `{code}` → `{account, credited}` |
| `GET /v1/portal/usage?days=30` | `Usage`，`days` 为 1–90 |
| `GET /v1/portal/ledger?limit=50&cursor=` | `{data: LedgerEntry[], next_cursor}`，新的在前 |
| `GET /v1/portal/runs?limit=20&cursor=&agent=` | `{data: RunItem[], next_cursor}`，本账号发起的任务（来自流水的 `kind: run` 行），新的在前；`agent` 可选 |
| `GET /v1/portal/runs/:id` | `RunDetail`；不是本账号的任务或不存在 404 `run_not_found` |

`RunItem` 是 `{id, agent, status, tokens, charge, created_at}`；`RunDetail` 是 `{id, agent, status, created_at, completed_at, usage, error, charge, price, output_text, timeline}`。`status` 与流水行一致（未结算是 `in_progress`，结算后是运行的终态）；`charge` 是已收的点数（正数）；`price` 是任务开始时记下的价格；`usage` 是运行的用量对象原样带出；`error` 是 `{code, message}` 或 `null`；`output_text` 是最终输出文本（各段以空行相接，与 `GET /v1/runs/:id/output.txt` 相同），超过 200,000 个字符时截断并以 `…` 结尾；`timeline` 是 `GET /v1/runs/:id/timeline` 的响应对象原样带出；`completed_at` 是运行进入终态的时间，未结束为 `null`。运行已被清理而流水行还在时，`timeline` 为 `null`、`output_text` 为空串、`usage`、`error`、`completed_at` 为 `null`。

### 运营者接口（`/v1/platform/*`）

要求 owner 级管理员密钥（`admin` 权限且 `agents` 含 `*`）且属于平台的 `owner`，否则 403 `scope_denied`；管理员密钥只能在控制台域名上使用（API 域名上是 `admin_host_denied`）。例外：`GET /v1/platform/accounts` 与 `POST /v1/platform/accounts/:id/credit` 也接受带 `billing` 权限、owner 等于平台 `owner` 的密钥（供支付回调使用）；`billing` 不是 `admin`，不受 `consoleHosts` 限制；它调用 `credit` 时 `amount` 必须大于 0，扣减得到 403 `scope_denied`。`billing` 不授予其它任何接口。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /v1/platform/setup` | `{enabled, source, managed_by_config, pending_restart, owner, settings, desired}`；平台未启用时也可用（特性 `platform-setup-v1`），需要 owner 级管理员密钥；设置归首次启用它的 owner，其它 owner 403 `scope_denied` |
| `PUT /v1/platform/setup` | `{enabled, site_name?, registration?, signup_credits?}`（严格校验）→ 与 GET 相同；保存在网关数据库，重启后生效；写审计 `platform_setup`；配置文件有 `platform` 段时 409 `platform_managed_by_config` |
| `GET /v1/platform/summary` | 账号数、余额合计、累计消耗、任务数、token 数、上架数 |
| `GET /v1/platform/accounts?query=&limit=&cursor=` | `{data: AdminAccount[], next_cursor}` |
| `POST /v1/platform/accounts` | `{email, password, name?, credits?}` → 201 `{account}`，不受 `registration` 限制 |
| `POST /v1/platform/accounts/:id/status` | `{status: "active" \| "disabled"}` → `{account}`；写审计 |
| `POST /v1/platform/accounts/:id/credit` | `{amount, note, reference?}`，可正可负，结果不得小于 0（402 `insufficient_balance`）→ `{account, entry}`；写审计。`reference` 是 1–200 个字符的外部单号：同一单号再次提交不再入账，返回第一次的 `{account, entry}` 并多一个 `duplicate: true`（不另写审计）；金额或账号与第一次不同得到 409 `reference_conflict`。带单号入账的 `entry` 多一个 `reference` 字段，其它流水行不带这个字段 |
| `POST /v1/platform/accounts/:id/password` | `{new_password}` → 204；写审计 |
| `POST /v1/platform/accounts/:id/reset-code` | — → 201 `{code, expires_at}`，明文只此一次，24 小时有效、一次有效，生成新码使旧码失效；写审计（`platform_password_reset`，`detail` 为 `reset_code`） |
| `GET /v1/platform/accounts/:id/ledger?limit=&cursor=` | `{data: LedgerEntry[], next_cursor}` |
| `GET /v1/platform/listings` | `{data: Listing[]}` |
| `PUT /v1/platform/listings` | `{agent_id, title?, summary?, tags?, price?, enabled?, host_execution?}` → `Listing`；智能体不存在 404 `agent_not_found`；400 `usage_pricing_unsupported`；`host_execution` 见 [platform.md](platform.md#对外提供外部智能体) |
| `DELETE /v1/platform/listings?agent_id=` | 204；没有上架记录 404 `listing_not_found` |
| `GET /v1/platform/codes` | `{data: Code[]}`，不含明文 |
| `POST /v1/platform/codes` | `{kind, credits?, max_uses?, count?, expires_at?, note?}` → 201 `{data: (Code + {code})[]}`，明文只此一次 |
| `DELETE /v1/platform/codes/:id` | 204（作废） |
| `GET /v1/platform/usage?days=30` | `Usage + {by_account}`；`by_account` 最多 50 个账号，按消耗从高到低 |

请求体都按严格模式校验，多余字段得到 400 `invalid_request`。启用平台时，网关启动后会对流水里仍是 `in_progress` 的任务行对账一次（不阻塞启动）：运行已是终态的按终态结算（仍在库里的已中断运行按它已用的 token 结算），运行记录已不存在的记为 `interrupted` 并按 0 token 结算（用量已无从得知），仍在排队或等待的不动；对账是幂等的。账号密钥调用 `GET /v1/me` 时，响应多一个 `account: {id, balance}`，其它密钥的响应不变。

### 审计与页面

调整余额、停用或启用账号、重置密码成功后各写一条审计记录（`GET /v1/audit`），错误码分别是 `platform_credit_adjusted`、`platform_account_status`、`platform_password_reset`；记录带 `account_id` 与一句不含机密的 `detail`（如 `amount=-5 balance_after=10`、`status=disabled`），不含密码、备注或兑换码。门户页面在 `/portal/`（静态文件在 `web/portal/`，CSP 与控制台相同）；配置了 `consoleHosts` 时，非控制台域名上的 `GET /` 跳转到 `/portal/`。

## 错误码（`error.code`）

> 本节为新增内容（2026-11-07）。

HTTP 错误响应默认使用形状 `{"error":{"code":"…","message":"…","type":"invalid_request_error"}}`；OpenAI 兼容入口多一个 `param`，Claude 与 Gemini 入口用各自协议的形状，网关错误码在 Claude 的 `error.code`、Gemini 的 `details[0].reason`（见「兼容入口的参数、错误与结束原因」）。`code` 是稳定的机器可读标识，客户端应按 `code` 分支并自行本地化；`message` 仅供阅读，可能变化，不应解析。运行（response）对象的 `error.code` 使用同一套码。框架层错误也映射为稳定码：畸形 JSON 为 `invalid_json`，请求体过大为 `payload_too_large`，不支持的 Content-Type 为 `unsupported_media_type`，畸形 multipart 为 `invalid_multipart`，未知路由或方法为 `route_not_found`；其它未分类的 4xx 为 `invalid_request`，未分类的服务端异常为 `execution_failed`。远程 worker 失败会透传 worker 侧的错误码（缺省为 `worker_failed`），子智能体失败会透传子运行的错误码（子运行结果未知且委托步骤不是只读时为 `effect_outcome_unknown`，委托超时为 `delegate_timeout`）；子运行的产物不并入父运行，只在委托结果的 `artifacts` 里给出引用。测试会检查源码中出现的每个错误码都在本节列出。

全部错误码登记在 `src/core/errors.ts` 的错误目录里，也可以通过 `GET /v1/errors`（需要 `read` 权限）读取：返回 `{ object: "list", revision, categories, data }`，`data` 每项为 `{ code, status, statuses?, category, retryable, zh, next?, en, nextEn?, routeRetryable?, fallbackExempt?, uncertainWhenStarted? }`（`en` / `nextEn` 是 `zh` / `next` 的英文版）。后三个是内核调度标记，只在为 `true` 时出现：`routeRetryable` 表示第一轮模型调用失败时网关会换一条线路重试；`fallbackExempt` 表示这类失败不会触发换用备选智能体；`uncertainWhenStarted` 表示外部执行已经开始后出现该错误时，副作用结果按未知处理。`status` 为 `null` 表示该码不作为 HTTP 响应出现；`retryable` 表示原样重试有可能成功；`zh` 是给使用者看的中文说明。`revision` 是目录内容的 sha256 前 16 位，响应带 `ETag`，`If-None-Match` 命中时返回 `304`。`/health` 的 `features` 含 `error-catalog-v1` 时可用。

### 错误说明的语言（0.0.64）

错误码与响应形状与语言无关，只有 `message` 的文字随语言变化：

- HTTP 请求看 `Accept-Language`：权重最高的明确语言以 `zh` 开头时用中文，其他明确语言（如 `en-US`、`fr`）用英文。没有这个头、或只有 `*` 时，用网关进程的默认语言。
- 进程默认语言：环境变量 `OAA_LOCALE`（`zh` 或 `en`）优先；否则依次看 `LC_ALL`、`LC_MESSAGES`、`LANG`（`C` / `POSIX` 跳过），再不行看系统区域（`Intl.DateTimeFormat().resolvedOptions().locale`）；以 `zh` 开头为中文，其余为英文。中文系统上的已有部署照旧是中文，英文系统上开箱是英文。命令行 `oaa` 的帮助与提示也跟随进程默认语言，CLI 访问网关时会带上相应的 `Accept-Language`。
- 大多数错误说明本来就是英文，两种语言下都原样返回。少数带中文说明的错误（ACP 智能体、本机后端等）提供中英两版，按上面的规则选择；英文下若遇到只有中文说明的错误，返回错误目录里该码的英文说明，并附上原说明里的字段名、路径等细节。
- 已经写入运行记录的错误（运行对象的 `error.message`、流里的错误事件）按发生时网关进程的默认语言记录，读取时不再转换。

### 请求、鉴权与限额

| code | HTTP | 含义 |
| --- | --- | --- |
| `unauthorized` | 401 | 缺少或无效/已删除的 API 密钥 |
| `key_expired` | 401 | API 密钥已过期 |
| `scope_denied` | 403 | 密钥缺少所需 scope，或无权访问该智能体/资源 |
| `quota_exceeds_own` | 403 | 新密钥的额度不能高于你自己密钥的额度 |
| `invalid_host` | 403 | Host 不在允许列表中 |
| `origin_denied` | 403 | 跨源请求的 Origin 未被允许 |
| `admin_host_denied` | 403 | 配置了 `consoleHosts` 后，在非控制台域名上使用了带 `admin` 的密钥 |
| `isolation_required` | 403 | 智能体（或它委派的智能体）需要的权限超出该密钥允许的执行等级（`workspace` / `sandbox`） |
| `sandbox_unavailable` | 503 | 需要在 OS 沙箱里运行的脚本没有可用节点；或 worker 没有通过自检的沙箱，拒绝在宿主机上执行 |
| `authorization_changed` | 403 | 长连接期间密钥授权发生变化，需用当前授权重连 |
| `rate_limited` | 429 | 超出该密钥每分钟请求数（默认 600） |
| `concurrency_limit` | 429 | owner 的活跃请求过多 |
| `admission_busy` | 503 | 尚未创建运行：数据库写锁等待超时或准入等待队列已满。请遵守 `Retry-After` 并沿用同一幂等键。 |
| `subject_concurrency_limit` | 429 | 同一调用方（subject）的未完成请求达到 `maxActiveRunsPerSubject` |
| `key_concurrency_limit` | 429 | 达到该密钥的并发运行上限 |
| `run_quota_exceeded` | 429 | 该密钥的运行次数配额已用完 |
| `token_quota_exceeded` | 429 | 该密钥的 token 配额已用完 |
| `storage_quota_exceeded` | 413 | 该调用方存储的文件已达上限 |
| `too_many_streams` | 429 | 该密钥（或 owner）同时打开的事件流已达上限：概览事件流每个密钥 4 条；运行事件流（`/events`、`/wait`、`GET /v1/responses/:id?stream=true` 与兼容入口的流式请求）每个调用方 64 条、每个 owner 256 条 |
| `invalid_request` | 400/404 | 请求字段无效或缺失（Gemini 路径格式错误时为 404） |
| `client_tools_unsupported` | 400 | 请求带了调用方工具，但选择了拒绝模式（reject），见 [harness.md](harness.md) |
| `client_tools_bridge_unsupported` | 400 | 请求了桥接模式（bridge），但这个智能体（ACP 以外的外部智能体）不支持，或者没有在线的执行机器声明了 `client-tools-v1`（需要升级执行机器，或改用 managed） |
| `client_tool_conflict` | 400 | 桥接的调用方工具与已发布的工具、工作流、委托、`execute_graph` 或另一个调用方工具重名（比较的是内部别名） |
| `client_tools_too_many` | 400 | 已发布工具加调用方工具超过 100 个 |
| `invalid_client_tool` | 400 | 调用方工具的名字不符合 `^[a-zA-Z0-9_-]{1,64}$`、格式不对，或参数 schema 无法编译 |
| `tool_choice_unmet` | 422 | 桥接模式下请求强制了 `tool_choice`（`required`、`any` 或指定函数名），但外部智能体在纠正轮之后仍未调用所要求的调用方工具 |
| `output_schema_unsupported` | 400 | 请求的输出 schema（`response_format`、`text.format`、`responseSchema`、`output_config.format`）里有网关无法如实校验的内容：`$async`、文档外的 `$ref`、没人实现的 `format`、很长或会指数回溯的正则、超过 40 层的嵌套；请改写 schema |
| `invalid_json` | 400 | 请求体不是合法 JSON，或声明了 JSON 却为空 |
| `payload_too_large` | 413 | 请求体或数据超过大小上限 |
| `unsupported_media_type` | 415 | 不支持的 Content-Type |
| `unsupported_parameter` | 400 | 严格端点（`/v1/chat/completions`、`/v1/responses`）不支持这个参数或取值（工具、JSON 输出格式、强制工具选择、`logprobs: true`、未知字段）；`error.param` 是字段名，可改用 `/v1/compat/*` |
| `unsupported_content` | 400 | 内容块类型不被支持（音频、未知块），或这个智能体不接受图片；`error.param` 指到内容段（[images.md](images.md)） |
| `image_invalid` | 400/500 | 图片无法使用：不是合法的 base64、不是 PNG / JPEG / GIF / WebP，或声明的类型与实际内容不符（[images.md](images.md)） |
| `image_too_large` | 413 | 单张图片或一次请求的图片总量超过配置的上限 |
| `too_many_images` | 400 | 这次请求的图片张数超过 `images.maxImagesPerRequest` |
| `image_fetch_failed` | 400 | 网关代取图片 URL 失败（只在开启 `images.fetchRemote` 时）：重定向、不是图片、超时、私网地址 |
| `protocol_undetected` | 400 | `/v1/universal` 无法判定请求属于 OpenAI Chat 还是 Claude Messages；改用专用端点或 `X-OAA-Protocol` 头 |
| `invalid_url` | 400 | URL 无法解析 |
| `invalid_multipart` | 400/406 | multipart 请求体畸形或不是 multipart |
| `route_not_found` | 404 | 没有匹配该方法与路径的路由 |
| `not_found` | 404 | 静态资源不存在 |
| `invalid_cursor` | 400 | 事件或输出游标无效 |
| `invalid_idempotency_key` | 400 | Idempotency-Key 格式无效 |
| `idempotency_conflict` | 409 | 同一 Idempotency-Key 用于了不同输入（输入相同、但一次带自带的提供方密钥 `X-OAA-Provider-Key` 一次不带，或换了一把密钥，也算不同输入；指纹只并入密钥的 sha256，密钥本身不落库） |
| `wait_timeout` | 408 | 等待截止时间已到（任务可能仍在运行） |
| `wait_cancelled` | 499 | 等待被取消 |
| `shutting_down` | 503 | 网关正在关闭 |
| `gateway_already_running` | 409 | 另一个网关进程占用了同一数据目录（启动时） |
| `schema_too_new` | 409 | 数据目录来自更新版本的网关（启动时） |

### 智能体、模型与目录

| code | HTTP | 含义 |
| --- | --- | --- |
| `agent_not_found` | 404 | 智能体或指定版本不存在 |
| `agent_version_required` | 400 | 后续详情分页需要带上返回的 agent_version |
| `ambiguous_model` | 400 | 多条路由使用同一模型名，请指定路由 ID |
| `model_not_supported` | 400 | 所选模型不受该智能体/后端支持（未发送任务） |
| `model_switch_requires_new_session` | 409 | 续接会话保持原模型路由，切换模型需新会话 |
| `model_unavailable` | 503 | 智能体当前没有可用的执行者（引擎未装或未启用、缺提供方环境变量，或会话固定的路由不可用） |
| `version_conflict` | 409 | 续接会话必须保持原智能体版本 |
| `catalog_capacity` | 429 | 目录视图或订阅过多 |
| `catalog_changed` | 409 | 授权的发布列表已变化，需从 offset 0 重新开始 |
| `catalog_closed` | 409 | 目录订阅已关闭 |
| `invalid_catalog_cursor` | 400 | 目录游标无效 |
| `invalid_catalog_limit` | 400 | 目录分页大小须为 1-32 |
| `metadata_item_too_large` | 413 | 单项元数据过大，请使用版本固定的元数据资源 |
| `resource_too_large` | 413 | MCP 资源超过 4 MiB 上限 |
| `invalid_agent_uri` | 400 | MCP 智能体资源 URI 无效 |
| `invalid_file_id` | 400 | MCP 文件 URI 无效 |

### 发布与能力包

| code | HTTP | 含义 |
| --- | --- | --- |
| `invalid_engine` | 400 | 引擎名无效（原生名或 `adapter/<名称>`） |
| `backend_not_enabled` | 409 | 适配器未在任何在线节点上启用，不能发布 |
| `bundle_integrity` | 400 | 能力包内容摘要不匹配 |
| `bundle_owner_conflict` | 409 | 该能力包摘要属于其他 owner |
| `bundle_too_large` | 400/413 | 能力包超过大小上限 |
| `invalid_manifest` | 400 | 能力包清单无效 |
| `invalid_skill` | 400 | SKILL.md 缺少 YAML frontmatter 等 |
| `missing_script` | 400 | 引用的脚本不在能力包中 |
| `missing_skill` | 400 | 引用的技能不在能力包中 |
| `metadata_too_deep` | 400 | 能力元数据嵌套过深 |
| `secret_in_bundle` | 400 | 公开元数据中疑似含有凭据，拒绝发布 |
| `unsafe_bundle` | 400 | 能力包路径被禁止或重复 |
| `oaa_syntax_error` | 400 | OAA-Lang 源码语法错误或超过编译上限 |
| `oaa_roundtrip_error` | 400 | 格式化后的编译契约与原源码不一致，拒绝输出可能改变执行行为的源码 |
| `oaa_validation_error` | 400 | OAA-Lang 源码语法正确，但声明的值不符合智能体契约（如 `max_turns = 0`、无效的引擎名）；报错带出问题所在声明的行列号 |
| `invalid_schema` | 400 | JSON Schema 无效或引用了不可用的外部 schema |
| `schema_dialect_unsupported` | 400 | 不支持异步 JSON Schema |

### 运行生命周期

| code | HTTP | 含义 |
| --- | --- | --- |
| `run_not_found` | 404 | 运行（response）不存在 |
| `session_busy` | 409 | 该会话已有进行中的任务 |
| `invalid_continuation` | 409 | 续接需要同一智能体的已完成响应 |
| `invalid_run_transition` | 500 | 运行状态转移不合法，写入被拒绝（内部错误；合法转移见 [architecture.md](architecture.md#32-运行状态机) 的 3.2 节「运行状态机」） |
| `not_resumable` | 409 | 只有 interrupted 状态的运行可以恢复 |
| `reconciliation_required` | 409 | 恢复前需先核对不确定的副作用 |
| `run_not_attached` | 409 | 运行显示为进行中，但不在本网关进程中执行（数据不一致或由别的进程持有），取消请求没有被受理 |
| `run_key_inactive` | 409 | 运行所属的密钥已过期、被吊销或已删除（或其账号已不存在），不能恢复。由 owner 的管理员密钥代为恢复别人的运行时出现；原密钥自己发起恢复时，过期与吊销在鉴权阶段就以 `key_expired` / `unauthorized` 拒绝 |
| `invalid_reconciliation` | 409 | 没有匹配的待核对步骤 |
| `effect_outcome_unknown` | 409 | 有副作用的操作结果未确认（运行记为 interrupted） |
| `gateway_restarted` | — | 网关重启导致执行中断（运行错误码） |
| `run_timeout` | — | 运行超过截止时间（运行错误码，状态 incomplete） |
| `cancelled` | 409 | 任务已取消 |
| `turn_limit` | — | 达到智能体轮次上限（运行错误码，状态 incomplete；兼容入口非流式按运行未正常结束返回 422、`x-should-retry: false`，流式在流里给出错误） |
| `token_budget` | — | 达到观测到的 token 预算（运行错误码，状态 incomplete；兼容入口的表现同 `turn_limit`） |
| `max_output_tokens` | — | 模型输出被截断（运行错误码，状态 incomplete；各兼容入口按截断照常 200） |
| `context_limit` | 409 | 上下文超过 2 MB（2,000,000 字节），请新建会话 |
| `output_contract` | 422 | 最终答案不符合声明的输出 schema |
| `structured_output_invalid` | 422 | 请求要求了结构化输出，但智能体的答案即使经过修复轮，仍不是合乎请求的 JSON；`error.message` 只说第一个问题，不含答案本身 |
| `output_too_large` | 413/502 | 智能体输出超过上限 |
| `files_too_large` | 413 | 输入文件总量超过 8 MiB |
| `workspace_too_large` | 413 | 工作区传输超过上限 |
| `delegation_depth_exceeded` | 409 | 子智能体委派深度超过上限 |
| `subagent_failed` | 502 | 子智能体以 failed 结束且没有给出具体错误码（`subagent_${status}`） |
| `subagent_cancelled` | 502 | 子智能体以 cancelled 结束且没有给出具体错误码（`subagent_${status}`） |
| `subagent_interrupted` | 502 | 子智能体以 interrupted 结束且没有给出具体错误码（`subagent_${status}`） |
| `subagent_incomplete` | 502 | 子智能体以 incomplete 结束且没有给出具体错误码（`subagent_${status}`） |
| `delegate_timeout` | 504 | 委托的子智能体在委托超时内没有结束（子运行已被取消） |
| `parent_interrupted` | — | 父运行已不活跃，排队中的子运行不再执行（运行错误码，状态 cancelled） |
| `capability_unavailable` | 503 | 所需执行能力当前不可用 |
| `node_draining` | 503 | 原本可用的节点正在排空 |
| `action_required` | 422 | 兼容端点：任务在等审批，运行已创建（非流式 Chat / Claude / Gemini；带 `x-should-retry: false`，不要重发） |
| `requires_action` | 409 | 兼容端点：运行处于 requires_action |
| `incomplete` | 422 | 兼容端点：运行未完整完成 |
| `persistence_failed` | 500 | 输出无法持久化，执行已停止 |
| `step_checkpoint_failed` | 500 | 工具结果无法提交，执行已停止 |
| `invalid_output_event` | 500 | 输出事件状态转换无效（内部不变量被破坏） |
| `execution_failed` | 500/502 | 未分类的执行失败 |

### 审批与步骤

| code | HTTP | 含义 |
| --- | --- | --- |
| `approval_expired` | 409 | 审批已过期 |
| `client_tool_timeout` | 409 | 调用方没有在 `approvalTimeoutMs` 内回传调用方工具的结果，运行以 `failed` 结束 |
| `client_tool_abandoned` | 409 | 外部智能体（经 `oaa-caller` 中继）在调用方回传结果之前放弃了这次调用（关掉了 MCP 服务，或它的 MCP 请求超时后重启了服务）：对应步骤以此失败、待办标为 `expired`，运行不因此失败；之后再回传这个 `call_id` 不会续接（按新请求处理） |
| `action_kind_mismatch` | 409 | `POST /v1/runs/{id}/actions/{action}` 指向一个 `client_tool` 待办：它只能由调用方经桥接回传结果 |
| `approval_not_found` | 404 | 审批不存在 |
| `stale_approval` | 409 | 审批已不再待处理 |
| `permission_denied` | 403 | 操作未获批准；进程正常结束不能作为成功依据。所有接入方式一致：owner 拒绝（Codex 的 `declined` 项、Claude 的 `permission_denials`、ACP/`oaa/1-stream` 的拒绝、内核工具审批）都以此码失败 |
| `tool_denied` | 403 | 该工具/图执行被禁用 |
| `step_not_found` | 404 | 执行步骤不存在 |
| `step_scope_mismatch` | 403 | 步骤属于其他运行 |
| `invalid_step_artifact` | 403 | 步骤产物不属于该运行 |
| `invalid_step_checkpoint` | 409 | 步骤检查点与运行不匹配 |

### 文件与记忆

| code | HTTP | 含义 |
| --- | --- | --- |
| `file_not_found` | 404 | 文件不存在 |
| `file_too_large` | 413 | 文件超过 8 MiB |
| `file_required` | 400 | multipart 上传缺少文件部分 |
| `file_integrity` | 400/500 | 文件内容摘要不匹配 |
| `invalid_file` | 400/413 | 文件字段、引用或大小无效 |
| `invalid_file_field` | 400 | 仅支持 purpose=user_data 或 assistants |
| `invalid_path` | 400 | 路径必须是不含穿越的相对路径 |
| `data_placement_denied` | 403 | 输入文件不允许发送到该节点 |
| `memory_too_large` | 413 | 记忆条目超过 256 KB |
| `artifact_integrity` | 502 | 原生产物摘要不匹配 |
| `artifacts_too_large` | 413 | 原生产物导出超过上限 |
| `unsafe_artifact` | 403 | 产物中含符号链接，拒绝自动导出 |

### 工具、图与 MCP

| code | HTTP | 含义 |
| --- | --- | --- |
| `invalid_tool_arguments` | 400 | 工具参数不符合 schema |
| `tool_not_published` | 403 | 工具未在该能力包中发布 |
| `result_export_denied` | 403 | 该能力不允许结果离开执行者 |
| `capability_bound_elsewhere` | 403 | 能力绑定在其他主机 |
| `capability_mismatch` | 403 | 节点工具元数据与发布的绑定不一致 |
| `manifest_mismatch` | 403 | 执行内容与已发布的智能体不一致 |
| `script_disabled` | 403 | 该 worker 不允许此脚本运行时 |
| `skill_not_published` | 404 | 文件不在能力包中 |
| `invalid_tool_calls` | 502 | 模型返回了重复或无效的工具调用 ID |
| `invalid_tool_result` | 502 | worker 返回了无效的工具结果 |
| `tool_arguments_too_large` | 502 | 模型给出的工具参数超过上限 |
| `invalid_graph` | 400 | 执行图无效 |
| `invalid_graph_output` | 400 | 图的返回投影引用了不存在的步骤或作用域外的变量 |
| `workflow_output_contract` | 422 | 工作流返回值不符合发布的输出契约；不会启动下一轮模型，也不会回滚已确认的工具操作 |
| `invalid_concurrency` | 400 | 图或叶子执行池的并发上限必须为正整数 |
| `invalid_expression` | 400 | 图表达式无效或超过上限 |
| `invalid_reference` | 400 | 图引用（JSON pointer）无效 |
| `expression_budget_exceeded` | 400 | 表达式结果超过预算 |
| `foreach_limit_exceeded` | 400 | foreach 数量超过 max_items |
| `unsafe_graph_fallback` | 400 | fallback 不能掩盖非幂等写操作 |
| `unsafe_graph_retry` | 400 | 步骤的 `retry` / `timeout_ms` 用在了会修改且不可安全重试（`write` / `unknown`）的工具上 |
| `step_timeout` | 504 | 执行图里某个步骤的一次尝试超过了它声明的 `timeout_ms`；重试用尽后才会让运行失败 |
| `mcp_unconfigured` | 503/400 | 所选 MCP 服务器未在该 worker 上配置 |
| `mcp_connection_failed` | 503 | MCP 服务器初始化失败 |
| `mcp_connection_retired` | 503 | MCP 连接在执行前已更换，请重试 |
| `mcp_credentials_unavailable` | 503 | 声明的 MCP 凭据环境变量不可用 |
| `mcp_executable_unavailable` | 503 | MCP 可执行文件不可用 |
| `mcp_tool_not_found` | 404 | MCP 服务器未列出该工具 |
| `mcp_tool_changed` | 409 | MCP 工具元数据已变化，需准备新的能力版本 |
| `mcp_tool_failed` | 502 | MCP 工具返回 isError=true |
| `mcp_ambiguous_tool` | 502 | MCP 服务器返回了重复的工具名 |
| `mcp_catalog_limit` | 400/502 | MCP 工具发现超过分页上限 |
| `mcp_invalid_catalog` | 502 | MCP 工具分页没有推进 |

### 模型提供方

| code | HTTP | 含义 |
| --- | --- | --- |
| `provider_unavailable` | 503 | 该节点未配置模型提供方 |
| `model_not_configured` | 503 | 未设置提供方 API 密钥环境变量 |
| `upstream_rate_limited` | 429/502 | 上游模型限流 |
| `upstream_failed` | 429/502 | 上游模型响应失败 |
| `upstream_auth_failed` | 502 | 上游模型服务拒绝了提供方的 API 密钥（HTTP 401/403） |
| `upstream_model_not_found` | 502 | 上游模型服务不认识这个模型名或接口路径（HTTP 404） |
| `upstream_incompatible` | 502 | 兼容服务不接受请求里的某个字段（如 max_completion_tokens、stream_options、工具或图片） |
| `upstream_incomplete` | 502 | 上游以非正常原因结束 |
| `upstream_truncated` | 502 | 上游未给出终止响应就结束 |
| `upstream_output_limit` | 502 | 上游 HTTP 响应累计超过 8 MiB，或 SSE 事件超过 2 MiB；停止读取并释放连接 |
| `upstream_timeout` | 504 | Anthropic/Gemini 请求超过配置的提供方截止时间，不等同于用户取消 |
| `invalid_model_result` | 502 | worker 返回了无效的模型结果 |
| `invalid_provider_key` | 400 | `X-OAA-Provider-Key` 格式不对（只允许 1–4096 个可见 ASCII 字符），或这个头出现了多次 |
| `byok_not_supported` | 400 | 调用方自带密钥只适用于 kernel 智能体；或该节点的提供方没有开启 `byok`；或续跑的运行本来就没用调用方密钥 |
| `provider_key_required` | 400 | `sandbox` 级密钥调用沙箱里的原生智能体时，必须带 `X-OAA-Provider-Key`（只用调用方自己的密钥） |
| `byok_key_required` | 409 | 运行使用调用方密钥，但网关已经不再持有它（重启或过期），需要带上 `X-OAA-Provider-Key` 重新续跑 |
| `invalid_provider_state` | 502 | 提供方原生轮次状态（Provider Turn State）缺失、畸形、校验失败、与归一化结果不匹配，或底层 SDK 无法安全重放；表明状态损坏或被篡改，调用方应开始新会话 |
| `provider_state_mismatch` | 409 | 续接会话时提供方协议、端点、模型、工具或对话前缀改变，或尝试跨不兼容协议重放原生状态；调用方需恢复原始配置或新建会话 |
| `provider_state_too_large` | 413 | 提供方单轮原生状态超过 2 MiB 上限；调用方应精简该轮输出/工具数据或新建会话 |
| `provider_state_unsupported` | 502/503 | worker 节点或驱动不支持保留该提供方的原生轮次状态、网关未协商原生状态能力，或流式输出包含无法安全保留的状态增量；调用方需路由至支持的节点或新建会话 |

### 原生智能体与适配器（含 ACP）

| code | HTTP | 含义 |
| --- | --- | --- |
| `native_disabled` | 503 | 该原生引擎未在 worker 上启用 |
| `native_incomplete` | 502 | 原生智能体未完整完成或提前退出；`oaa/1-stream` 适配器退出时没有结果；A2A 流结束时没有最终状态或智能体取消了任务 |
| `native_truncated` | 502 | 原生智能体结束时没有结果 |
| `image_delivery_failed` | 502 | 把图片交给外部智能体这一步失败（工作目录里找不到图片文件）（[images.md](images.md)） |
| `native_closed` | 502 | 原生智能体进程已关闭 |
| `native_protocol_error` | 502 | 原生/ACP 协议错误，或智能体拒绝了请求 |
| `native_model_mismatch` | 409 | 智能体未确认所选模型（未发送任务） |
| `native_resume_unsupported` | 409 | 智能体无法续接上一轮会话 |
| `adapter_disabled` | 503 | 适配器未启用 |
| `adapter_not_configured` | 503 | 适配器所需令牌环境变量未设置 |
| `adapter_unavailable` | 503 | 适配器进程无法启动 |
| `adapter_auth_required` | 503 | 外部智能体（ACP 智能体、内置的 Claude Code 等）要求先在其自身 CLI 中登录；A2A 端点返回 401/403 |
| `adapter_timeout` | 504 | ACP 握手阶段超时 |
| `adapter_failed` | 502 | HTTP / A2A 适配器返回错误状态或 JSON-RPC 错误；A2A 握手检查找不到 agent card |
| `adapter_incomplete` | 502 | 适配器报告未完成（A2A 任务 `failed`/`rejected`）；适配器提供的错误文本会脱敏 |
| `adapter_output_limit` | 502 | 适配器输出超过 2 MiB（A2A 响应/流超过 8 MiB） |
| `approval_failed` | 500 | 审批桥内部错误 |
| `event_failed` | 500 | 事件写入失败 |
| `process_failed` | 502 | 受管子进程非零退出 |
| `invalid_protocol` | 502 | worker 或子进程输出了无效协议数据（含 `oaa/1-stream` 未知消息类型、A2A 非法 JSON） |

### 本机后端与节点

| code | HTTP | 含义 |
| --- | --- | --- |
| `backend_not_configured` | 404 | 本地 worker 配置中没有该后端 |
| `backend_unavailable` | 409 | 后端可执行文件缺失或不可执行，未启用 |
| `backend_conflict` | 409 | 一键启用时，本机配置里已有同名但不同类型的适配器，不会覆盖 |
| `worker_required` | 409/400 | 一键启用时，配置文件里没有本机执行机器（`localWorker`）；该码也由命令行在本地产生 |
| `check_unsupported` | 400 | 握手检查只适用于 ACP 与 A2A 适配器 |
| `local_node_policy` | 409 | 远程凭据控制不能改变本地 worker |
| `local_connection_unavailable` | 409 | 本地客户端、发布策略或配置路径不支持自动连接 |
| `local_connection_conflict` | 409 | 客户端配置已变化、正在写入或预览过期 |
| `local_connection_invalid` | 400 | 本地客户端配置格式、权限或文件类型不安全，不覆盖 |
| `local_connection_not_found` | 404 | 本地连接记录不存在 |
| `local_connection_failed` | 500 | 本地连接写入失败，新建密钥已撤销 |
| `node_not_found` | 404 | 节点注册不存在 |
| `node_exists` | 409 | 该节点 ID 已注册 |
| `node_owner_conflict` | 409 | 节点身份被其他 owner 占用 |
| `node_revoked` | 409 | 节点已吊销（不可逆） |
| `node_policy_integrity` | 500 | 节点策略记录不一致 |
| `node_already_connected` | 409 | 同一身份的节点已连接 |
| `node_identity_reserved` | 409 | 该本地节点 ID 被远程生命周期策略保留 |
| `node_credentials_conflict` | 409 | 节点凭据身份不唯一（启动时） |
| `node_scope_denied` | 403 | 节点通告超出其授权 |
| `node_disconnected` | 503 | worker 连接已关闭 |
| `node_backpressure` | 503 | worker 连接超过缓冲上限 |
| `queue_full` | 429 | 节点队列已满 |
| `work_timeout` | 504 | worker 超过执行截止时间 |
| `worker_failed` | 502 | 远程 worker 执行失败（未带具体码时） |
| `worker_capacity_exceeded` | 503 | 远程 worker 已满载，拒绝新任务 |
| `invalid_context` | 403 | worker 归属或会话不匹配 |
| `bundle_not_loaded` | 409 | 所需能力包尚未安装到 worker |
| `insecure_endpoint` | 400 | 远程端点必须使用 TLS 且不得包含凭据 |
| `invalid_credential` | 500 | 服务或节点令牌少于 24 个字符（配置错误） |
| `key_not_found` | 404 | 该 owner 下找不到 API 密钥 |
| `node_authentication_denied` | — | worker 侧：网关拒绝节点凭据，停止重连 |
| `node_connection_failed` | — | worker 侧：连接网关失败 |
| `invalid_config` | 400 | worker 侧：配置无效（如缺少 gatewayUrl）；只在 worker 进程本地启动时产生（`connectWorker`），不作为 HTTP 响应返回，400 是 `Fault` 的默认状态 |

### 开发者平台

只在网关配置了 `platform` 段时出现。

| code | HTTP | 含义 |
| --- | --- | --- |
| `registration_closed` | 403 | 这个站点不开放自助注册 |
| `invite_required` | 403 | 注册需要邀请码 |
| `invalid_code` | 400 | 兑换码、邀请码或重置码无效、已用完、已过期或已被本账号用过 |
| `email_taken` | 409 | 邮箱已注册 |
| `invalid_credentials` | 401 | 邮箱或密码不正确 |
| `session_invalid` | 401 | 门户会话无效或已过期 |
| `account_disabled` | 403 | 账号已停用（会话与账号密钥都被拒绝） |
| `account_not_found` | 404 | 账号不存在 |
| `insufficient_balance` | 402 | 余额不足（提交任务时在创建运行之前拒绝；运营者调整余额后结果小于 0 时也返回此码） |
| `key_limit_reached` | 409 | 账号的密钥数量已到上限 |
| `listing_not_found` | 404 | 该智能体没有上架记录 |
| `usage_pricing_unsupported` | 400 | 上架项给不上报 token 用量的智能体设了按用量的价格（这种智能体只接受按次定价） |
| `code_not_found` | 404 | 兑换码不存在 |
| `reference_conflict` | 409 | 这个外部单号已经用于另一笔金额不同、或另一个账号的入账 |
| `platform_managed_by_config` | 409 | 配置文件里已有 `platform` 段，`PUT /v1/platform/setup` 不能修改平台设置 |

### 事件回调错误

由 `/v1/webhooks` 系列接口返回（[webhooks.md](webhooks.md)）。

| code | HTTP | 含义 |
| --- | --- | --- |
| `webhook_not_found` | 404 | （该 owner 下）没有这个编号的事件回调端点 |
| `webhook_url_invalid` | 400 | 回调地址无效：只允许不带用户名密码的 http/https，回环地址以外必须用 https（除非 `allow_insecure_http`） |
| `webhook_target_denied` | 400 | `public` 安全档位下，地址指向私网、回环、链路本地或云元数据地址（除非 `allow_private_network`） |
| `webhook_limit_reached` | 409 | 该 owner 已有 20 个事件回调端点 |
| `webhook_delivery_not_found` | 404 | 这个端点下没有这个编号的投递 |
| `webhook_delivery_pending` | 409 | 这条投递还在队列里，暂时不能重发 |

### 调度原因码（`reasons[].code`）

出现在智能体可用性/路由检查的 `reasons` 中，说明为什么某个节点或路由当前不可用，不是 HTTP 错误：`agent_scope`、`agent_node_restriction`、`session_node_affinity`、`file_node_restriction`、`provider_unavailable`、`tool_selection_unreported`、`capability_scope`、`native_disabled`、`native_model_unsupported`、`native_model_unreported`、`host_binding`、`result_export_denied`、`builtin_unreported`、`script_runtime_disabled`、`capability_unavailable`、`capability_mismatch`、`byok_unsupported`（节点的这个提供方不接受调用方密钥）、`provider_state_unsupported`（worker 无法保留该提供方的原生轮次状态）、`sandbox_unavailable`（节点没有通过自检的脚本沙箱）、`no_online_nodes`、`node_busy`、`node_draining`、`node_revoked`、`target_cooling_down`、`required_tool_unavailable`。

### 仅 CLI / 客户端本地

例外：本地模型管理也会返回 `provider_conflict`（409，同名提供方配置不同）与 `provider_unreachable`（503，本机模型服务不可达）。这两项与 CLI 共用；下方其余错误仍仅来自客户端本地。

以下只由 `oaa` 命令行或 `GatewayClient` 在本地产生，网关不会返回：`arguments`、`unknown_command`、`dsh_overlay_required`、`exposure_conflict`、`native_not_installed`、`node_startup_failed`、`startup_failed`、`startup_timeout`、`tunnel_binary_missing`、`tunnel_exited`、`tunnel_timeout`、`worker_required`、`output_exists`、`tool_conflict`、`mcp_descriptor_too_large`、`mcp_task_mode_unsupported`、`host_binding`（工具导入时所选工具属于另一个节点）、`gateway_error`、`gateway_response_too_large`、`gateway_timeout`、`invalid_gateway_path`、`invalid_gateway_response`、`request_cancelled`、`token_required`、`gateway_unreachable`（连不上网关）、`not_running`（`oaa stop` 找不到由 `--detach` 启动的网关）、`port_in_use`（`oaa quickstart` 要用的端口被占用）、`sample_agent_missing`（找不到随附的离线示例智能体）、`agent_conflict`（`oaa connect` 不覆盖同名的其它引擎智能体）、`provider_conflict`（`oaa connect <预设>` 不覆盖同名但设置不同的模型提供方）、`provider_unreachable`（连不上模型提供方的端点）、`key_file_insecure`（`oaa connect --key-file` 给的密钥文件不私有或不是单行密钥）、`approval_ambiguous`（`oaa approve/deny` 的运行有多个待审批项却没指定哪一项）、`approval_declined`（`oaa approve` 确认时选了不批准）。
