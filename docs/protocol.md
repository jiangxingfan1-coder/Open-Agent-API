# OAA/1 Contract

## Identity and authorization

An invocation resolves `agent -> immutable bundle -> published model route -> eligible worker`. Callers receive a response ID, not an upstream credential. API keys carry an owner, allowed agent IDs, and scopes: `read`, `invoke`, `files`, `approve`, `admin`, `billing` (developer platform only: credit accounts and look them up by email, see 「开发者平台」). Node credentials are separate and cannot call the application API.

`POST /v1/invoke` accepts `protocol: "oaa/1"`, `agent`, `model` (`auto`, route ID, or published model name), text `input`, optional `file_ids`, `previous_response_id`, `stream`, `background`, and string-valued `metadata`. Unknown fields are rejected. `Idempotency-Key` binds the normalized request to a single response; different input with the same key returns 409.

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

## Compatibility

| Interface                        | Implemented subset                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/models`                 | Published agent IDs as callable model aliases                                                                                             |
| `POST /v1/responses`             | Text or role/content inputs containing `input_text` and uploaded `input_file.file_id`; streaming, background, metadata, previous response |
| `GET /v1/responses/{id}`         | Authenticated durable response retrieval; `?stream=true` replays the Responses stream from the start (`starting_after=N` skips frames up to `sequence_number` N) |
| `POST /v1/responses/{id}/cancel` | Cancel only the owned response                                                                                                            |
| `POST /v1/chat/completions`      | Text messages, ordinary/streaming output, `stream_options.include_usage`, metadata                                                        |
| `POST /v1/files`                 | OpenAI-style multipart file/purpose, or JSON `{filename,content,encoding,allowed_nodes}`                                                  |
| `GET /v1/files/{id}/content`     | Authenticated input/artifact download                                                                                                     |

Responses `model` selects an agent alias. `metadata["oaa.model"]` optionally selects a route. Unsupported OpenAI input returns an explicit error rather than a silently degraded result: on the strict endpoints an unknown field answers `unsupported_parameter` with `error.param`, and on every OpenAI entry (strict, compatibility and `/v1/universal`) an inline image, audio or unknown content part answers 400 `unsupported_content` with `error.param` pointing at the part (for example `messages.1.content.0`); no run is created and nothing of the part reaches the prompt. Upload the file with `POST /v1/files` and reference it with a `file` / `input_file` part instead (see 「兼容入口的参数、错误与结束原因」). Sampling parameters are accepted and reported as ignored. By default (managed mode) the gateway executes the registered agent tools and does not expose them as client-side function calls; caller-defined tools are only handed back to the caller in bridge mode, described next.

Client-defined tools: the strict endpoints (`/v1/chat/completions` and `/v1/responses` without `X-OAA-Compat`, and `/v1/uap`) reject `tools` as an unknown field. The compatibility endpoints (`X-OAA-Compat: true`, `/v1/compat/*`, `/v1/messages`, Gemini `generateContent`) handle a non-empty `tools` array by mode, chosen with the `X-OAA-Client-Tools` request header or `metadata["oaa.client_tools"]`: `managed` (default; the agent uses its own tools, the caller's tools are not executed, and the response carries `X-OAA-Client-Tools: ignored`), `reject` (`client_tools_unsupported`), or `bridge` (kernel agents and ACP agents: the agent's calls to caller tools come back in each protocol's standard form — Chat `tool_calls` with `finish_reason: "tool_calls"`, Responses `function_call` items in a `completed` response with `metadata["oaa.status"]="requires_action"`, Claude `tool_use` blocks with `stop_reason: "tool_use"`, Gemini `functionCall` parts (`args` as an object) with `finishReason: "STOP"` — the run parks, and the next request carrying the results (`role: "tool"`, `function_call_output`, `tool_result`, `functionResponse` — paired by `id`, or without `id` by name and order against the previous `model` turn's `functionCall` parts) continues the same run, same `X-Run-ID` and the same response ID (`resp_…` / `chatcmpl_resp_…` / `msg_resp_…` / Gemini `responseId`) — unlike OpenAI, where every `responses.create` returns a new Response; here one task is one ID and one bill, `GET /v1/responses/{id}` shows its latest state, and the earlier `function_call` items are not kept as a separate snapshot; other external agents answer `client_tools_bridge_unsupported`, and non-function / server / built-in tools (Gemini `googleSearch`, `codeExecution`, …) in bridge mode answer `client_tools_unsupported`). An empty or absent `tools` changes nothing. See [harness.md](harness.md).

Responses output uses standard `response.created`, `response.in_progress`, message/content events, `response.output_text.delta`, and terminal events. The official OpenAI JavaScript SDK is tested against both normal and streaming output. `X-Run-ID` identifies the underlying execution. Disconnecting the HTTP client does not cancel an accepted task.

SSE headers are flushed when the stream is accepted, even if a Chat request has not produced text yet. `X-Run-ID` is a single value, and stream responses retain `Cache-Control: no-store, no-cache`; receiving headers is acceptance, not evidence that inference or tools have completed.

Text deltas are persisted before delivery. Cancelled, failed or truncated generations keep partial message content with status `incomplete`, rather than claiming the message completed. A completed model turn can retain a completed message even when a later tool or output-contract check fails. Native event replay remains cursor-based; when explicitly resuming an interrupted run, continue after the last observed event rather than replaying an earlier terminal event from cursor zero.

Under contention a kernel run can return from `in_progress` to `queued` at a confirmed model/tool boundary. Native SSE records `run.queued` with `reason: "fairness"` and the next checkpoint `phase`. The response ID, pinned model/version, output sequence, usage and deadline do not reset, and readmission may produce another `response.in_progress` event. This is not a terminal result or an approval request; clients should keep following the same execution. Ordinary Responses, Chat Completions and MCP waits continue across these scheduling transitions.

Chat `stream_options.include_usage=true` requires `stream=true`: regular chunks carry `usage: null`, followed on successful completion by one `choices: []` usage chunk before `[DONE]`. Unknown or partial totals stay null; no token counts or costs are fabricated. An interrupted stream may end with an error instead of a final usage chunk.

Normal synchronous calls return when complete or parked for approval. Responses represents a pending approval as `in_progress` with `metadata["oaa.status"]="requires_action"`; inspect the native run endpoint for its action. Chat Completions, Claude Messages and Gemini return HTTP 422 `action_required` (with `x-should-retry: false`, the run ID in `X-Run-ID` and in the error body) rather than pretending the task is complete: decide the action with `POST /v1/runs/{id}/actions/{action_id}` (`GET /v1/runs/{id}` lists it), then read the result with `GET /v1/responses/{id}`; do not resend the request, which would start a second run. Long-running or approval-driven clients should use background Responses or `oaa/1` and inspect actions.

（2026-11-08 新增）流式 Responses 在等待 owner 决定时保持连接，并额外发出一个 `response.in_progress` 事件，其 `response.metadata["oaa.status"]` 为 `requires_action`，与非流式 Responses 的表示一致；决定后同一条流继续输出直到终止事件。Chat / Claude / Gemini 流以各自的错误帧结束（Chat `error.code: action_required`；Claude `event: error`，`error.type: invalid_request_error`、`error.code: action_required`；Gemini `error.status: FAILED_PRECONDITION`、`details[0].reason: action_required`），UAP 流以 `action` 帧结束；任务本身在后台继续，可用 `X-Run-ID` 查询。各协议的审批、取消、续接差异见 `docs/adapters.md`「AgentAPI 转换契约」。

### 兼容入口的参数、错误与结束原因（0.6.0）

调用的是智能体，不是裸模型：采样类参数由发布者在智能体里决定，网关不转发。各入口的处理如下。

| 入口 | 生效 | 接受但忽略（列在 `X-OAA-Ignored-Params`） | 拒绝 |
| --- | --- | --- | --- |
| `/v1/chat/completions`（严格） | `messages`、`stream`、`stream_options`、`metadata`、`max_tokens` / `max_completion_tokens` | `temperature`、`top_p`、`seed`、`stop`、`presence_penalty`、`frequency_penalty`、`n`（只能是 1）、`user`、`store`、`service_tier` | 其余字段（`tools`、`response_format`、`logprobs`、`n > 1`…）：400 `unsupported_parameter`，`error.param` 是字段名，说明里指向 `/v1/compat/chat/completions`；`image_url`、`input_audio` 等内容块：400 `unsupported_content` |
| `/v1/responses`（严格） | `input`、`stream`、`background`、`previous_response_id`、`metadata`、`max_output_tokens` | `temperature`、`top_p`、`top_logprobs`、`user`、`store`、`service_tier`、`truncation` | 其余字段（`instructions`、`tools`、`text`…）：400 `unsupported_parameter`，指向 `/v1/compat/responses`；`input_image`、`input_audio` 等内容块：400 `unsupported_content` |
| `/v1/compat/chat/completions`、`X-OAA-Compat: true` | 同上，加 `tools`（按 `X-OAA-Client-Tools` 模式）、`response_format`（作为输出要求写进输入）、`reasoning_effort`（路由策略） | `temperature`、`top_p`、`seed`、`stop`、`presence_penalty`、`frequency_penalty`、`n`、`logit_bias`、`logprobs`、`top_logprobs`、`user`、`store`、`service_tier`、`tool_choice`、`parallel_tool_calls` | 内联图片（`image_url`）、`input_audio` 与未知内容块：400 `unsupported_content`，`error.param` 指到内容块（如 `messages.1.content.0`）；先 `POST /v1/files` 上传，再用 `{"type":"file","file":{"file_id":"…"}}` 引用 |
| `/v1/compat/responses` | 同上，加 `instructions`、`tools`、`text.format`、`reasoning.effort` | `temperature`、`top_p`、`top_logprobs`、`user`、`store`、`service_tier`、`truncation`、`tool_choice`、`parallel_tool_calls` | `input_image`、`input_audio`、未知内容块与未知输入项：400 `unsupported_content`（用 `{"type":"input_file","file_id":"…"}` 引用已上传的文件） |
| `/v1/messages`、`/v1/compat/messages` | `system`（全文，不截断）、`messages`、`stream`、`metadata`、`max_tokens`、`tools` | `temperature`、`top_p`、`top_k`、`stop_sequences`、`tool_choice`、`thinking`、`service_tier` | 内联的 base64 / URL 图片与文档、未知内容块：400 `unsupported_content`（先 `POST /v1/files` 上传，再用 `{"type":"image","source":{"type":"file","file_id":"…"}}` 引用） |
| `/v1beta/models/{agent}:generateContent` / `:streamGenerateContent`（`/v1/models/...` 相同） | `contents`、`systemInstruction`、`generationConfig.maxOutputTokens`、`fileData` | `generationConfig` 的其余字段（`generationConfig.temperature` 等）、`safetySettings`、`toolConfig`、`cachedContent` | `inlineData` 等其它 part：400 `unsupported_content`（用 `{"fileData":{"fileUri":"oaa://files/<id>"}}`） |

- **输出长度上限**：请求的上限写进 `metadata["oaa.max_output_tokens"]`（旧的 compat 端点仍写 `oaa.compat_max_tokens`），内核取它与智能体自身 `limits.maxOutputTokens` 的较小者，经节点线协议的可选字段 `Work.maxOutputTokens` 交给执行模型调用的节点。调用方只能调低，不能调高。外部智能体（ACP、A2A 等原生执行）不经网关调用模型，不受这个上限约束。不认识该字段的旧节点按已发布的上限执行。
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

## Execution and actions

### Catalog notifications

`GET /v1/agents` returns its normal authorized `data` plus `catalog_cursor`, captured from the same visible metadata. Discovery selects definitions without materializing bundle file bodies in the application. Publication remains durable in SQLite; the notification journal is deliberately separate and in memory.

- `GET /v1/catalog/changes?cursor=...&limit=32&timeout_ms=20000` returns `{cursor,reset,data,has_more,timed_out}`. It requires `read`, is filtered by owner and agent grants, and never invokes a model or tool. `data` contains up to 32 changes with `{cursor,agent,version,reason}`; reasons are `published`, `runtime`, or `removed`. Follow the returned cursor until `has_more` is false. Waiting is bounded to 25 seconds; an empty timed-out page is not a task failure.
- `GET /v1/catalog/events` streams the same changes as `catalog.changed`. Resume with `Last-Event-ID` or `?cursor=...`; conflicting cursors are rejected. Event IDs are opaque catalog cursors, not run-event integers or credentials. Initial connection or a required resync emits `catalog.reset` with a cursor and `refresh: "/v1/agents"`.

On `reset: true`, reload the authorized agent list and continue from its `catalog_cursor`. A missing cursor, gateway restart, different authorization view, evicted view or expired history requires a reset, never silent replay across scopes. Each view retains at most 256 notifications. The gateway keeps at most 64 authorization views, and each owner may have at most 64 live subscriptions/waits. Idle views can be evicted. This is a bounded directory invalidation feed, not a durable publication audit or a complete record of every transient load change.

Publication, worker registration/disconnection, capability updates, execution load and local adapter changes schedule coalesced refreshes. Active views also recheck metadata once per second for clock-driven cooldown expiry and local configuration changes. Same-grant subscribers share a refresh; another owner's or an ungranted agent's updates do not advance this view's cursor. Runtime hints carry no task text, tool payloads, login state or node credentials. Re-fetch route readiness before dispatch: a notification neither reserves a node nor expands access.

SSE preserves the normal CORS and no-store headers and bounds queued output; slow or disconnected readers reconnect with their last received cursor. Revoking a key through the API closes its catalog/run streams and pending waits without cancelling an already accepted task. Already transmitted bytes cannot be recalled. Stream heartbeats recheck credentials without consuming another API request quota unit.

MCP exposes this as the ordinary read-only `oaa_watch_catalog` tool; it is not an unsolicited MCP tool-list change or a claim that every host supports push subscriptions. `oaa_list_agents` includes `catalog_cursor` for notifications and a separate publication `revision` for consistent directory paging. Runtime notifications can advance without changing that publication revision. The CLI equivalent is `oaa catalog --cursor CURSOR --timeout-ms 20000`; omit the cursor to obtain the initial resync receipt. Cancelling a watch only detaches the reader.

### Bounded capability discovery

`GET /v1/catalog/agents?offset=0&limit=20` returns compact summaries, `total`, `next_offset`, `revision` and `catalog_cursor`. Pass `revision` on subsequent pages. It fingerprints only the caller's authorized publication IDs/versions and grants; visible publication changes return `409 catalog_changed` instead of silently combining different lists. Another owner's or ungranted agent's publication does not invalidate it. The byte budget may make a page shorter than its requested `limit` (maximum 50); always follow `next_offset` rather than adding the limit yourself.

Summaries include complete Agent IDs and immutable versions, counts of published tools/skills/model routes, and explicitly marked description/engine previews. They select metadata scalars in SQLite, not every full agent definition or tool schema. `readiness: "not_evaluated"` is deliberate: discovering a publication does not inspect or invoke its runtime. A native agent's zero **published** tool/skill count does not mean its private host toolkit is empty. Use route preview on the chosen version before invocation. The existing full `/v1/agents` endpoint remains available and keeps its live readiness contract.

`GET /v1/catalog/agent?agent=AGENT&agent_version=DIGEST&section=routes&offset=0&limit=20` provides one of `overview`, `routes`, `tools` or `skills`. Omit the version only to resolve a first page to the current publication. Offsets beyond zero require `agent_version`; carry the returned digest through every detail page and the eventual invocation. Model route IDs/names and tool/skill identifiers are never clipped. Tool rows expose effect, approval, required/export flags, and full-schema byte counts/hashes without embedding large schemas. Descriptions are previews with an explicit `description_truncated` flag. The serialized JSON data payload of summary/detail pages is at most 20000 bytes, below the MCP bridge's general fallback threshold; transport envelopes and resource links are additional.

Every detail page links to `metadata_uri` and an authenticated `metadata_url`. `GET /v1/catalog/agent/content?agent=AGENT&agent_version=DIGEST` downloads full **public metadata** for exactly that version: descriptions, all model routes, public capability schemas and skill metadata. It omits prompt bodies, tool handlers, script/file contents, native state and private worker connection configuration. Existing published metadata can itself contain sensitive text; this is not a DLP guarantee. All discovery and metadata reads require owner, Agent grant and `read` scope. The admin-only full bundle endpoint retains its separate permission boundary.

MCP `oaa_list_agents` uses the bounded summary endpoint; `oaa_inspect_agent` exposes the detail sections. Read its `oaa://agents/{encoded_agent}/versions/{digest}` resource only when full descriptions or schemas are needed. MCP resource reads are capped at 4 MiB and fail explicitly without clipping; larger metadata uses authenticated HTTP or `oaa agent AGENT --agent-version DIGEST --out NEW_FILE`. CLI downloads are private and never overwrite existing files. `oaa agents` and `oaa agent AGENT --section routes` expose the same pages.

Summary discovery seeds a lightweight publication-only notification cursor. It does not scan all runtimes to create that cursor; runtime observation starts when watched or refreshed through full discovery. Publication changes between listing and watching are still detected. The publication `revision`, immutable `agent_version` and ephemeral `catalog_cursor` are separate tokens with separate purposes; none grants access.

### Read-only route inspection

`POST /v1/agents/preview` accepts `{agent, model?, agent_version?, file_ids?, previous_response_id?}` and requires read access to the agent. It returns the selected published route, ranked candidates, per-node constraints, required/optional tool availability, and execution-health evidence. It creates no run and does not load or invoke a model. Candidate nodes are limited to this owner and this agent's node grants; it does not expose unrelated nodes to scoped callers.

The same placement checks run again at dispatch. A preview is a snapshot, not a reservation. Full tool availability yields `ready`; optional missing tools yield `degraded`; occupancy yields `busy`; model-target backoff yields `cooling_down`. `available` means a route may be dispatched or queued, not that an upstream account/model has been verified.

`agent_version` pins a new invocation or preview to an immutable publication. OpenAI-compatible requests use `metadata["oaa.agent_version"]`. A continuing session rejects conflicting version/model selections. Unknown or other-owner versions return 404.

Required tools (`required: true` on a ToolBinding) are checked before any provider request. Optional unavailable tools are removed from that turn's tool list, recorded in `tools.unavailable`, and not accepted if the model nevertheless asks to invoke them. Older bundles omit the optional field and retain their original digest. Tool selection itself must be supported by the chosen worker; a legacy worker is not assumed to implement filtering.

- `GET /v1/runs?limit=50`: bounded owned run summaries (`data[]`). A row whose `status` is `requires_action` and that has pending actions carries `waiting_on` (0.3.0): `"caller"` when every pending action is a `client_tool` (the run waits for the caller to return its own tool results; nothing for the owner to do), `"owner"` when at least one action needs a person. The key is absent for every other status, so other rows are byte-for-byte unchanged. Older gateways omit it.
- `GET /v1/runs/{id}`: response, actual route, tool steps, actions, artifact metadata, and execution errors.
- `GET /v1/runs/{id}/events`: native SSE; `Last-Event-ID` or `?after=N` resumes after a durable event cursor.
  Replay is written under backpressure: when more than 1 MiB is buffered for the client the gateway waits for it to read before sending more, and disconnects a client that reads nothing for 30 seconds; a client that stops reading while live events arrive is still disconnected once 2 MiB are buffered. A single large frame is never refused for its size, so the terminal frame (`response.completed` carries the full response, bounded by `outputTextChars`) always arrives, on the first connection or after a resume. The same applies to `GET /v1/responses/{id}?stream=true` and to compatibility streams. Each caller may hold 64 run event streams (`/events`, `/wait`, Responses replay and compatibility streams together) and each owner 256; more answer `429 too_many_streams` with `Retry-After`.
- `POST /v1/runs/{id}/actions/{action}`: `{decision:"approve"|"deny",response?:{...}}`; requires `approve`. Native question answers can be placed in `response.answers`.
- `POST /v1/runs/{id}/resume`: explicitly resume an interrupted kernel run from its checkpoint. Completed steps are reused. Interrupted native processes are never blindly replayed. Resuming re-checks the run's own API key under the submission rules, whoever resumes it (the key itself, or the owner's admin key on another key's run): the key must still be valid (`run_key_inactive` when the admin resumes a run whose key expired or was revoked; the key itself is refused at authentication), its developer-platform account active (`account_disabled`), the agent still granted or listed (`scope_denied`), the balance sufficient for a paid agent (`insufficient_balance`), and its quota not exhausted (`key_concurrency_limit`, `token_quota_exceeded`, `run_quota_exceeded`; the resumed run is the same run, so it does not count again toward `maxRuns`). A refused resume leaves the run `interrupted` with no side effect. A resumed run counts against its key's concurrency again, and its tokens are added to the key's usage only once (the difference from what was already counted when it was interrupted).
- `POST /v1/runs/{id}/reconcile`: `{step_id,outcome:"completed"|"not_executed",value?}`; requires `approve`. This records an **operator assertion**, not newly measured tool success. Resolve an uncertain side effect before resuming.

Unknown usage remains null; partial usage is marked with `oaa.usage_complete=false`. No model pricing or exact billing is inferred from fixture token counts. Model routes do not change within a continuing session. A new publication updates the alias only for new sessions.

`run.awaiting_caller` (`data: { approval_ids }`) is written only for bridged runs of external (ACP) agents: they wait for the caller in process instead of parking, so the kernel announces new pending `client_tool` actions on the next event-loop turn, once for calls that arrived together. Compatibility responses treat it like `run.parked`.

Kernel tool approvals keep the public status `requires_action` while the run is durably parked. `run.parked` means already-started work has settled and the global run slot was released; `run.requires_action` alone does not mean that parallel work or a native process has stopped. Approval wakeups emit `run.queued` and reacquire a run slot before continuing confirmed checkpoints. Repeated partial approvals reuse the original decisions and do not rerun completed steps. Denial, expiry or cancellation ends parked work without a tool grant. The original run timeout includes approval waiting and readmission queue time.

Approval records keep the requested operation in `detail` and the owner's optional reply in `response`; legacy approved kernel records with `detail.response` are still recognized on explicit checkpoint resume. Native approval waits remain attached to their host execution and do not release a run slot. Queued, executing and parked requests all count toward the 32 unfinished-request limit per owner, regardless of which ingress API or new idempotency key is used.

### Approval policy for external agents (`approval-policy-v1`)

`POST /v1/agents/publish-native` accepts `{id, engine, models, approvals?}` and requires `admin`. `approvals` is `"ask"` (default) or `"auto"`; the same optional field exists on the agent definition (bundles, `.oaa` source as `approvals = auto`, CLI `--approvals ask|auto` on `publish-native` and `expose`). It is only meaningful for external agents: a `kernel` agent with `approvals: "auto"` fails validation, because kernel tool approvals are governed by each tool's `requiresApproval`. When the field is absent (or `ask`) it is not written to the definition, so existing digests are unchanged.

With `auto`, a permission request from the agent is still bounded first (details over 256 KiB are denied as before). It then does not enter `requires_action` and does not wait: the kernel stores an approval record with `status: "approved"`, `kind: "native"` and `response: {"auto": true}`, emits `approval.resolved` with `{approval_id, decision: "approve", actor: "policy:auto"}`, and answers the agent with approve. The run stays `in_progress` and no `run.requires_action` is written, so every stream renders the run as if no permission was requested. The `actor` of `approval.resolved` is the approving key's name for owner decisions and `policy:auto` for these policy approvals. `GET /v1/agents` and the overview's agent entries carry `approvals: "auto"` only for such agents; other entries are unchanged. Publishing or updating such an agent (through any publish endpoint) writes an audit row with code `approval_policy_auto` and `agent_id` (`GET /v1/audit`).

Execution level and authorization are not relaxed: external agents still require a caller key with `host` execution, and sandbox, BYOK and node-grant checks are unchanged. **Risk:** auto approval lets callers drive the agent with the owner's own permissions on that machine; nobody reviews commands or file edits before they run. Use it only for trusted callers, with a dedicated API key restricted to that agent, and a sandbox execution level where possible.

An approval decision and its `approval.resolved` event commit in one SQLite transaction; observers are notified only after commit. The same rule applies to a reconciled step and its `step.reconciled` event. A failed audit write rolls back the state change and does not grant execution. Repeating a resolved approval or reconciliation returns 409 rather than changing the recorded decision. A lost HTTP reply is not proof of failure: read the approval/step record before taking another action.

## Bounded inspection and MCP delivery

- `GET /v1/runs/{id}/state`: bounded status, engine, selected route/version, reported usage completeness, step counts, up to five pending approval IDs, an output preview, artifact count and latest committed `event_id`. It does not materialize full model checkpoints or step-result bodies.
- `GET /v1/runs/{id}/steps?offset=0&limit=20&status=uncertain`: step metadata only; optional status is `pending`, `running`, `completed`, `failed` or `uncertain`. Maximum 50 rows; returns `data`, `total` and `next_offset`. `reconciled` means there is operator reconciliation history, not independent verification of the current outcome.
- `GET /v1/runs/{id}/steps/{step}`: step metadata, `arguments` and `result` previews, and the latest `reconciliation` (or null). Each preview contains `preview`, original compact JSON `bytes`, and `truncated`. Truncated JSON is display text, not a parseable substitute for the full record. Preview text is bounded to 8000 serialized bytes, or at most 16000 bytes when a complete value is pretty-printed; envelope fields are additional.
- `GET /v1/runs/{id}/steps/{step}/content`: explicitly download the full stored step as a JSON attachment.
- `GET /v1/runs/{id}/actions?offset=0&limit=5`: pending approvals with bounded `detail` previews using the same preview envelope; maximum 10 rows. Returns `data`, `total` and `next_offset`.
- `GET /v1/runs/{id}/actions/{action}/content`: explicitly download the full approval JSON, including its current decision and optional response. The action must belong to this run.
- `GET /v1/runs/{id}/wait?timeout_ms=20000`: wait for a terminal result or approval, up to 25 seconds. A timeout returns current state with `timed_out: true`; it is not a task failure. Disconnecting or cancelling this wait releases its listener, not the accepted execution.
- `GET /v1/runs/{id}/output?cursor=...&max_bytes=8000`: ordered, lossless output pages. `max_bytes` (256-16000) bounds the serialized text field including JSON escapes; envelope metadata is additional. Follow `next_cursor` until `done`; `waiting_for_output` means the reader reached the current tail. `tail_cursor` can be retained across an explicit interrupted-run resume. Cursors are opaque and bound to a response, not credentials.
- `GET /v1/runs/{id}/output.txt`: explicitly download all currently committed output as UTF-8 text, with messages separated by two newlines. This is a snapshot, not a wait for completion; use paged output to preserve message IDs and status.
- `GET /v1/runs/{id}/artifacts?offset=0&limit=10`: up to 20 file descriptors, plus `next_offset`. Existing HTTP file downloads retain their 8 MiB limit and require file scope and the originating agent grant.

All inspection endpoints require `read` scope and the run's agent grant, even for the same owner. They perform no model/tool calls. Offset pages are current views, not cross-request snapshots; pending approval and filtered step counts can shrink. The console adjusts an invalidated page and preserves approval drafts during refresh. It fetches full records only for explicit downloads, and never resumes an uncertain operation automatically. `reconcile` records a human assertion while leaving the run interrupted; `resume` is a separate invocation-authorized operation. The OpenAPI endpoint catalog includes inspection paths, path parameters and paging bounds; it is not a complete generated schema for every response body.

The MCP bridge reuses these endpoints. A generated launcher is exercised through the official SDK's real stdio client in the no-cost test suite. `oaa_upload_text` accepts only explicitly supplied text, never a local path. `oaa_invoke` supports stable idempotency keys; accepted-task receipts retain IDs rather than embedding entire outputs. `oaa_wait_run`, `oaa_read_output` and `oaa_list_artifacts` complete the retrieval workflow. No approval-granting MCP tool is exposed.

Artifacts are exposed using standard [MCP resource links and resource reads](https://modelcontextprotocol.io/specification/2025-11-25/server/resources). `oaa://files/{id}` returns authenticated base64 file bytes, not a public URL or local filesystem path. MCP reads are limited to 4 MiB to bound transport frames; larger files fail explicitly and use authenticated HTTP or `oaa download`. A resource's content is untrusted data. Host-specific UI and installation behavior are not implied by SDK interoperability. [MCP request cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation) is propagated to the pending HTTP wait/read, while task cancellation stays an explicit `oaa_cancel` operation.

## Capability packages

An `oaa.bundle.v1` contains a validated AgentDefinition, a sorted explicit file list (path, SHA-256, base64 content), and a manifest digest. Publishing never executes scripts. Paths, duplicate files, symlinks, credentials filenames, obvious secret patterns, content hashes, and size limits are checked. Pattern detection is not comprehensive secret/DLP scanning; review selected files before distribution.

Tools declare ID, version, input JSON Schema, placement (`portable` or `host-bound`), effect (`read`, `idempotent-write`, `write`, `unknown`), approval requirement, timeout, optional resource key/cache TTL, and whether results may leave the node. MCP annotations are not automatically trusted as an authorization decision.

Portable tool and skill bindings belong to kernel agents. Native/external agents use their host's own toolkit; incompatible mixed declarations are rejected rather than ignored. Native sessions start in a dedicated task workspace, so user-level configuration and configured runtime profiles are inherited, but another project's workspace-only configuration is not automatically imported. Existing desktop sessions are not attached or taken over.

`execute_graph` accepts up to 32 registered tool steps. `{ "$ref": "stepId#/field" }` creates a dependency; cycles and unknown steps fail before execution. Registered write resource keys are serialized; read steps can overlap. Arbitrary skill Markdown is not compiled into executable code.

Built-in `read_skill` exposes only files from the immutable selected bundle. Built-in file tools reject traversal/symlinks and operate in the session workspace. Inputs appear at `inputs/<file_id>/<filename>` and artifacts at `outputs/<filename>`.

## Node wire protocol

### Node lifecycle control

Node administration requires `admin` scope **and** the owner's `agents: ["*"]` grant. Agent-scoped admin keys may still manage their permitted publications, but cannot inspect the host-wide node/backend inventory or change node admission. Caller API keys and worker credentials remain separate authorities.

- `GET /v1/nodes/registrations`: configured, enrolled, local and retained retired identities, including disconnected/revoked records. Credentials and credential hashes are never returned. `active: null` for an offline node means unobserved work, not zero work. `drained: true` is reported only for a connected draining node with no gateway jobs left.
- `POST /v1/nodes/{id}/drain` with `{reason?: string}`: persist `draining` and stop new dispatch. Already executing worker calls may settle normally. Preparation that has not reached execution cannot start a new call after the policy changes. An accepted kernel run blocked by draining becomes `interrupted` with `node_draining`; completed results/artifacts remain checkpoints. Restore capacity, then explicitly resume the run. This is a step-level drain, not a promise that a whole multi-step task will finish during maintenance.
- `POST /v1/nodes/{id}/resume`: reactivate a draining identity under its existing grants. This does not resume interrupted tasks automatically or widen host permissions.
- `POST /v1/nodes/{id}/revoke`: terminally remove this identity's trust, including connections that passed HTTP upgrade but have not sent their hello yet. Future joins are rejected; active executors reject pending calls and ignore later frames before asynchronous socket closure. An in-flight write/native operation with no confirmed result remains uncertain and requires reconciliation. Repeating the same policy is idempotent; a revoked identity cannot be resumed or re-enrolled. Review and enroll a new identity when replacement is intended.
- `GET /v1/nodes/{id}/history?after=0&limit=50`: owner-scoped policy audit, maximum 100 entries per page. Policy and audit commit in one transaction before dispatch authority changes. A failed audit write does not revoke or pause the node.

The synthetic local worker is protected from these remote credential controls. Use its existing local execution settings or gateway lifecycle instead. Native backend configuration files and node credential files are not rewritten by a policy operation. A config-file credential is still denied by its persisted revocation after restart. Duplicate credential identities and attempts to assign a retained identity to another owner fail closed at startup.

The console exposes pause/resume/revoke controls and retains offline/revoked rows. CLI equivalents are `oaa nodes`, `oaa node drain NODE`, `oaa node resume NODE`, `oaa node revoke NODE`, and `oaa node history NODE`; `oaa resume RESPONSE_ID` resumes a confirmed kernel checkpoint. No node-management MCP tool is exposed to task-calling agents. The updated worker stops retrying after an HTTP 401/403 handshake denial; older workers may retry but remain rejected.

Revocation is not remote process attestation, deletion of previously transferred data, or proof that an external side effect stopped. Responses explicitly report `external_effects_stopped: "not_verified"`. The existing partition/resource-lock limitations still apply. Schema v3 persists node policies and their audit; older schema-v2 gateways reject this database rather than silently ignoring revocations. Back up before upgrade, and treat restoring an older backup as restoring older authority state requiring review.

`hello.execution` adds executor capability metadata alongside (not inside) the original `advertisement` object, preserving the legacy hello shape. It names built-in tools, enabled script runtimes, per-turn tool-list support, and native model mappings. New gateways advertise `execution-capabilities-v1` in `welcome.features`; only then does a worker send changed metadata using `advertisement` messages.

Model `Work` may carry an optional `maxOutputTokens` (the caller's output cap, always below the published `limits.maxOutputTokens`); a worker applies the smaller of the two to the model call, and an older worker that ignores it uses the published limit. The agent definition itself stays identical to the published one.

`welcome.features` is now `execution-capabilities-v1`, `byok-v1`, `sandbox-v1`, `provider-turn-v1`, `client-tools-v1`. With `client-tools-v1` a worker reports `execution.clientTools = { native: ["kernel", "adapter/<acp name>", …] }`: the engines on which it can bridge caller tools (docs/harness.md). Bridged runs are placed only on workers that declared the run's engine there (placement reason `client_tools_unsupported` otherwise); when no such worker exists, submission answers `client_tools_bridge_unsupported` (400). Only those workers receive `Work.native.clientTools` and send the `client_tool` event (`data: { name, arguments, relay_call_id }`), which the gateway answers like an approval with `{ output }` or `{ error }`. Older workers and older gateways keep working; an older worker simply never receives bridged work. Every update is validated against the same node identity and credential grants as the initial registration. Idle peers also lose their registration when heartbeats expire.

Native execution requires the node credential to grant `native/<engine>` (or `*`), in addition to the agent alias. `oaa expose` already grants only its selected native executor. A generic adapter uses `native/adapter/<name>`. Enabled native executables are checked for local availability without starting them; declared model mappings are still not proof of account/model compatibility.

Throttling cooldown and duration estimates are keyed by execution target, not by the entire worker. An unrelated model on that worker can proceed. Model-route statistics exclude kernel tool execution, human approval waits, cancellation, and unrelated tool errors. Native adapters remain opaque, so their successful route samples include their internal agent work, minus bridged approval waits. A late successful call does not erase a newer throttle backoff. Candidate scheduling estimates include policy priors and transfer/cold-start penalties; they are not measured end-to-end latency guarantees.

Authenticated WSS at `/v1/nodes/connect` requires `Authorization: Bearer <node token>` and `X-OAA-Node-ID`. The handshake names `protocol:"oaa/1"` and the node's advertised providers, native runtimes, capability versions, warm bundles, and concurrency.

The gateway issues `install` and `execute` requests with a unique request/lease ID. Worker replies carry the same lease, streaming `event` records and a terminal `result`. Heartbeats and renewals use a 15-second lease by default. Cancellation and approval replies are scoped to a live request/lease. Disconnects abort owned jobs; late or wrong-lease results do not commit. Delivery is not represented as exactly-once execution across arbitrary external services.

The gateway validates every upstream frame before acting on it (`src/fabric/node-messages.ts`). Frames that are not JSON objects, exceed `nodeMessageBytes` (24 MiB), or carry a known `type` (`event`, `result`, `advertisement`) with fields of the wrong shape close the connection with 1008; the other in-flight calls on that connection end as `node_disconnected`. A `result` is checked against the request it answers: `model` needs `text` and `calls` (`usage`, `finish`, `providerItems`, `providerState` optional), `tool` accepts a missing `value`, `native` needs `text` and `nativeState`. A malformed result fails its call with `invalid_protocol` marked uncertain (the worker claims it ran) and closes the connection. A missing or malformed `usage` is recorded as unknown (`null`). An `error.code` that is not a short snake_case identifier becomes `worker_failed`, and `error.message` is truncated to 4,000 characters. Late, duplicate, wrong-lease or foreign `id` frames and unknown message types are ignored and recorded (the last 50 issues are kept in memory per connection). Objects are accepted with extra fields, so older and newer workers keep working; no existing field changed name or meaning.

Cancellation is a request, not a stop acknowledgement. The gateway keeps the occupied slot and its in-memory resource lock until the matching result confirms the worker invocation has returned, or the node disconnects. While cancelling it ignores new output/approval events, stops lease renewal, and disconnects the worker if no matching result arrives within one lease interval. A cancellation HTTP response is sent after run cleanup; for a remote invocation this includes waiting for the acknowledgement or the lease grace period. Disconnecting a stuck worker also interrupts its other in-flight requests; uncertain external writes require reconciliation rather than automatic replay.

The current worker keeps cancelled jobs counted against capacity until their invocation returns. On disconnect or shutdown it aborts owned work, waits for those invocations to settle, and only then reconnects or closes shared runtime clients. New execution beyond the actual capacity is rejected with `worker_capacity_exceeded` before it starts; stale or wrong-lease cancel/renew/action controls are ignored. Cancellation during bundle preparation never authorizes the later tool to start. Upgrade both the gateway and workers to get these lifecycle guarantees; an older worker's reconnect behavior cannot be inferred from the unchanged `oaa/1` wire format.

These are local runtime lifecycle guarantees, not proof that an external HTTP adapter, an upstream provider, or an escaped subprocess stopped its side effects. An in-process handler that never settles deliberately keeps that worker unavailable instead of being falsely declared stopped. Arbitrary code is not safely preempted, and in-memory resource locks are not a distributed fencing mechanism across partitions or gateway restarts.

The first release has a single authoritative gateway. It is not a multi-master mesh and has no multi-gateway failover. Host-bound secrets are never bundled. File placement constraints cover declared transfers, not semantic information-flow analysis of arbitrary model-generated text or an untrusted tool's contents.

## MCP tool bindings

A prepared MCP tool is a normal host-bound capability with an explicit node, effect, approval policy, export policy and immutable version. Its public handler is only `{kind:"node",reference:"..."}`. The private worker overlay maps that reference to `{kind:"mcp",server:"configured-name",tool:"selected-tool",descriptorSha256:"..."}`. Connection configuration and credential references remain on the worker. `prepare` sends only initialization/catalog requests; it never invokes the tool or modifies a running node. Unknown effects, mandatory approval and disabled result export are the defaults.

The descriptor digest covers the selected name, description, schemas and annotation hints. It is checked against current metadata before execution; a mismatch blocks the call. It is not a signature of server code and cannot prove that an implementation behaves as advertised. Hints such as `readOnlyHint` never override the operator's effect or approval declaration. Distinct capability versions can coexist on one node with separate private references; selection compares the complete versioned metadata, not just the first matching capability ID.

MCP client connections are scoped to owner/session/bundle digest. A changed transport configuration or credential retires old connections for new work; active calls can finish before cleanup. Ordinary domain errors do not close other calls sharing that session. Declared missing HTTP credential references fail closed and are not advertised as available. The connection cache holds at most 16 idle entries, expiring after 60 seconds; private MCP process state is not durable platform state.

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
| `kind` | `queue`、`model`、`tool`、`approval`、`subagent`、`interrupted`、`native` |
| `label` | 机器可读标识，中文由前端按 `kind` 渲染：排队原因（`admission`、`fairness`、`approval`、`node`）、模型路由 ID、工具名、需要审批的工具名或原生审批类型、子智能体名、原生引擎名 |
| `ref` | `{turn, attempt?}`（模型）、`{step_id, tool}`（工具）、`{approval_id, step_id?}`（审批）、`{step_id, child_run_id?}`（子智能体） |
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

`a2a-adapters-v1`、`acp-adapters-v1`、`adapter-stream-v1`、`catalog-events-v1`、`client-tools-policy-v1`、`conversion-profile-v1`、`error-catalog-v1`、`error-codes-v1`、`harness-bridge-acp-v1`、`harness-bridge-v1`、`local-backends-v1`、`overview-activity-v1`、`overview-etag-v1`、`overview-events-v1`、`queue-insight-v1`、`run-timeline-v1`。

（2026-11-11 新增）`client-tools-policy-v1`：兼容接口按 `X-OAA-Client-Tools`（或 `metadata["oaa.client_tools"]`）处理调用方传入的工具（managed / reject；bridge 见 `harness-bridge-v1`），托管时响应带 `X-OAA-Client-Tools: ignored`；画像含 `client_tools` 字段。`harness-bridge-v1`：内核智能体经 Chat Completions、Responses 与 Claude Messages 支持 `bridge`（调用方工具以 `tool_calls` 交回调用方执行，同一个运行续接）。见 [harness.md](harness.md)。

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

## 工作流返回契约

`GET /health` 的 `workflow-output-v1` 表示网关支持工作流的 `output` / `outputSchema` 与动态 `execute_graph.output`；`oaa-lang-roundtrip-v1` 表示 DSL 格式化会重新编译并比较契约。它们不要求客户端改变现有请求：未指定返回投影时仍返回完整步骤结果。详见 [OAA-Lang 执行契约](language.md)。

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
| `PUT /v1/platform/listings` | `{agent_id, title?, summary?, tags?, price?, enabled?}` → `Listing`；智能体不存在 404 `agent_not_found` |
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
| `invalid_host` | 403 | Host 不在允许列表中 |
| `origin_denied` | 403 | 跨源请求的 Origin 未被允许 |
| `admin_host_denied` | 403 | 配置了 `consoleHosts` 后，在非控制台域名上使用了带 `admin` 的密钥 |
| `isolation_required` | 403 | 智能体（或它委派的智能体）需要的权限超出该密钥允许的执行等级（`workspace` / `sandbox`） |
| `sandbox_unavailable` | 503 | 需要在 OS 沙箱里运行的脚本没有可用节点；或 worker 没有通过自检的沙箱，拒绝在宿主机上执行 |
| `authorization_changed` | 403 | 长连接期间密钥授权发生变化，需用当前授权重连 |
| `rate_limited` | 429 | 超出该密钥每分钟请求数（默认 600） |
| `concurrency_limit` | 429 | owner 的活跃请求过多 |
| `subject_concurrency_limit` | 429 | 同一调用方（subject）的未完成请求达到 `maxActiveRunsPerSubject` |
| `key_concurrency_limit` | 429 | 达到该密钥的并发运行上限 |
| `run_quota_exceeded` | 429 | 该密钥的运行次数配额已用完 |
| `token_quota_exceeded` | 429 | 该密钥的 token 配额已用完 |
| `too_many_streams` | 429 | 该密钥（或 owner）同时打开的事件流已达上限：概览事件流每个密钥 4 条；运行事件流（`/events`、`/wait`、`GET /v1/responses/:id?stream=true` 与兼容入口的流式请求）每个调用方 64 条、每个 owner 256 条 |
| `invalid_request` | 400/404 | 请求字段无效或缺失（Gemini 路径格式错误时为 404） |
| `client_tools_unsupported` | 400 | 请求带了调用方工具，但选择了拒绝模式（reject），见 [harness.md](harness.md) |
| `client_tools_bridge_unsupported` | 400 | 请求了桥接模式（bridge），但这个智能体（ACP 以外的外部智能体）不支持，或者没有在线的执行机器声明了 `client-tools-v1`（需要升级执行机器，或改用 managed） |
| `client_tool_conflict` | 400 | 桥接的调用方工具与已发布的工具、工作流、委托、`execute_graph` 或另一个调用方工具重名（比较的是内部别名） |
| `client_tools_too_many` | 400 | 已发布工具加调用方工具超过 100 个 |
| `invalid_client_tool` | 400 | 调用方工具的名字不符合 `^[a-zA-Z0-9_-]{1,64}$`、格式不对，或参数 schema 无法编译 |
| `invalid_json` | 400 | 请求体不是合法 JSON，或声明了 JSON 却为空 |
| `payload_too_large` | 413 | 请求体或数据超过大小上限 |
| `unsupported_media_type` | 415 | 不支持的 Content-Type |
| `unsupported_parameter` | 400 | 严格端点（`/v1/chat/completions`、`/v1/responses`）不支持这个参数；`error.param` 是字段名，可改用 `/v1/compat/*` |
| `unsupported_content` | 400 | 内容块类型不被支持（OpenAI / Claude / Gemini 各兼容入口）（内联 base64 图片、URL 图片等）；先上传文件再按文件 ID 引用 |
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
| `model_unavailable` | 503 | 会话固定的路由当前没有可用执行者 |
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
| `invalid_run_transition` | 500 | 运行状态转移不合法，写入被拒绝（内部错误；合法转移见 architecture.md「运行状态机（0.2.0）」） |
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
| `mcp_unconfigured` | 503 | 所选 MCP 服务器未在该 worker 上配置 |
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
| `worker_required` | 409 | 一键启用时，配置文件里没有本机执行机器（`localWorker`）；该码也由命令行在本地产生 |
| `check_unsupported` | 400 | 握手检查只适用于 ACP 与 A2A 适配器 |
| `local_node_policy` | 409 | 远程凭据控制不能改变本地 worker |
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
| `code_not_found` | 404 | 兑换码不存在 |
| `reference_conflict` | 409 | 这个外部单号已经用于另一笔金额不同、或另一个账号的入账 |
| `platform_managed_by_config` | 409 | 配置文件里已有 `platform` 段，`PUT /v1/platform/setup` 不能修改平台设置 |

### 调度原因码（`reasons[].code`）

出现在智能体可用性/路由检查的 `reasons` 中，说明为什么某个节点或路由当前不可用，不是 HTTP 错误：`agent_scope`、`agent_node_restriction`、`session_node_affinity`、`file_node_restriction`、`provider_unavailable`、`tool_selection_unreported`、`capability_scope`、`native_disabled`、`native_model_unsupported`、`native_model_unreported`、`host_binding`、`result_export_denied`、`builtin_unreported`、`script_runtime_disabled`、`capability_unavailable`、`capability_mismatch`、`byok_unsupported`（节点的这个提供方不接受调用方密钥）、`provider_state_unsupported`（worker 无法保留该提供方的原生轮次状态）、`sandbox_unavailable`（节点没有通过自检的脚本沙箱）、`no_online_nodes`、`node_busy`、`node_draining`、`node_revoked`、`target_cooling_down`、`required_tool_unavailable`。

### 仅 CLI / 客户端本地

以下只由 `oaa` 命令行或 `GatewayClient` 在本地产生，网关不会返回：`arguments`、`unknown_command`、`dsh_overlay_required`、`exposure_conflict`、`native_not_installed`、`node_startup_failed`、`startup_failed`、`startup_timeout`、`tunnel_binary_missing`、`tunnel_exited`、`tunnel_timeout`、`worker_required`、`output_exists`、`tool_conflict`、`mcp_descriptor_too_large`、`mcp_task_mode_unsupported`、`host_binding`（工具导入时所选工具属于另一个节点）、`gateway_error`、`gateway_response_too_large`、`gateway_timeout`、`invalid_gateway_path`、`invalid_gateway_response`、`request_cancelled`、`token_required`、`gateway_unreachable`（连不上网关）、`not_running`（`oaa stop` 找不到由 `--detach` 启动的网关）、`port_in_use`（`oaa quickstart` 要用的端口被占用）、`sample_agent_missing`（找不到随附的离线示例智能体）、`agent_conflict`（`oaa connect` 不覆盖同名的其它引擎智能体）。
