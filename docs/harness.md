# 双层 Harness：调用方自己也是智能体时

## 问题是什么

传统的调用是「应用 → 模型」。OAA 是「应用 → 智能体 → 模型」。而调用方往往自己也是一个智能体（Cursor、Cline、Codex CLI、Claude Code、各种 Agent SDK）：它有自己的循环、自己的系统提示、自己的工具，把 OAA 当成一个「模型」来调。于是一次调用里有两层 Harness（工具循环）：

```text
外层 Harness（调用方智能体：自己的工具、自己的循环）
      │  OpenAI / Claude / Gemini 协议 —— 它以为对面是模型，请求里带着 tools
      ▼
OAA 内核（准入、身份、持久化、审批、事件）
      │
      ▼
内层 Harness（被发布的智能体：内核循环，或 Codex / Claude Code / ACP 智能体自己的循环）
      │
      ▼
    模型
```

两层各有一套工具。如果只是把外层的 `tools` 悄悄丢掉，外层系统提示里「必须调用 edit_file」之类的话会原样交给内层智能体，而内层并没有这个工具，容易在正文里编造工具调用。所以 OAA 让调用方明确选择外层工具怎么处理。

## 三种模式

| 模式 | 含义 | 谁执行工具 | 适用场景 |
| --- | --- | --- | --- |
| `managed` 托管（默认） | 内层智能体全权完成任务。外层传入的工具不执行，并明确告知：响应头 `X-OAA-Client-Tools: ignored`；同时在交给智能体的输入末尾加一段固定说明（外部工具在这里不可用，请用自己的工具完成并直接给出结果，不要在正文里写工具调用） | 内层智能体 | 把 OAA 智能体当作「会自己干活的模型」接进现有工具 |
| `bridge` 桥接 | 外层的工具投射给内层智能体；内层调用时运行停车，以标准 `tool_calls` 返回给调用方，调用方执行后回传结果，同一个运行接着做 | 调用方（由内层发起） | 工具必须在调用方本机执行（例如编辑调用方工作区里的文件） |
| `reject` 拒绝 | 只要传了工具就报错 `client_tools_unsupported`，不降级 | — | 需要严格语义、不接受工具被忽略的调用方 |

> **桥接已对内置内核智能体提供，支持 Chat Completions、Responses、Claude Messages 与 Gemini `generateContent`。** 不支持桥接的外部智能体请求 `bridge` 会得到 `client_tools_bridge_unsupported`（400），UAP/1 不接受 `tools` 字段；这些情况下任何运行都不会创建。

只有请求里的 `tools` 是**非空数组**时才会按模式处理。没有 `tools`、或者 `tools: []`，行为与以前完全相同，模式请求头也不起作用。

## 怎么选

- 不确定就用默认的 `managed`：调用方照常拿到最终结果，响应头告诉你工具被忽略了。
- 调用方必须知道「工具没被执行」并据此改变行为（例如换一个模型）时，用 `reject`，按错误码分支。
- 智能体必须调用你本机的工具才能完成任务、而且背后是内核智能体或 ACP 外部智能体时，用 `bridge`。其它外部智能体可以先把这些工具发布成 OAA 智能体自己的工具（MCP 导入或节点工具），再用 `managed`。

## 怎么传

两种写法，请求头优先：

1. 请求头 `X-OAA-Client-Tools: managed | bridge | reject`（大小写不敏感）。
2. 请求体 `metadata["oaa.client_tools"]`，取值同上。

其它取值报 `invalid_request`（400），消息里列出三个合法值。

Chat Completions（兼容模式），用请求头：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $OAA_KEY" \
  -H "Content-Type: application/json" \
  -H "X-OAA-Compat: true" \
  -H "X-OAA-Client-Tools: reject" \
  -d '{
    "model": "agent/coder",
    "messages": [{ "role": "user", "content": "修复登录页的报错" }],
    "tools": [{ "type": "function", "function": { "name": "edit_file", "parameters": { "type": "object" } } }]
  }'
```

Claude Messages，用 metadata：

```json
{
  "model": "agent/coder",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "修复登录页的报错" }],
  "tools": [{ "name": "edit_file", "input_schema": { "type": "object" } }],
  "metadata": { "oaa.client_tools": "managed" }
}
```

Responses（`/v1/compat/responses`）与 Gemini（`tools[].functionDeclarations`）写法相同：带工具的同时加请求头，或在 `metadata` 里写 `oaa.client_tools`。

## 响应头

| 情况 | 响应头 |
| --- | --- |
| `managed` 且请求确实带了工具 | `X-OAA-Client-Tools: ignored`（流式与非流式都有） |
| 没有带工具 | 不出现，响应头集合与以前一致 |
| 请求里有被接受但不转发的参数（`temperature` 等，见 protocol.md「兼容入口的参数、错误与结束原因」） | `X-OAA-Ignored-Params: <参数名, …>`；没有时不出现 |

运行记录的 `metadata` 里同时可见 `oaa.client_tools: "managed"` 与 `oaa.client_tools_ignored: "<工具个数>"`。

## 当前支持矩阵

接入方式 × 模式（智能体画像 `conversion.client_tools` 给出每个智能体的取值：内核与 ACP 为 `bridge`，其余为 `managed`）：

| 智能体接入方式 | `managed` | `reject` | `bridge` |
| --- | --- | --- | --- |
| 内置内核智能体（`engine: kernel`） | 支持 | 支持 | 支持 ✓（Chat、Responses、Claude Messages） |
| ACP 外部智能体（`adapter/<name>`，`transport: "acp"`） | 支持 | 支持 | 支持 ✓（经 MCP 中继，见下文「外部智能体的桥接是怎么工作的」） |
| Codex / Claude Code / Antigravity / DSH | 支持 | 支持 | 仅托管：报 `client_tools_bridge_unsupported` |
| A2A / oaa-1 HTTP 适配器 | 支持 | 支持 | 仅托管：报 `client_tools_bridge_unsupported` |

桥接运行只会放到在握手里声明了 `client-tools-v1`、且对这个引擎声明了支持的执行机器上（内置执行机器总是声明 `kernel` 与已启用的 ACP 适配器）；没有这样的机器时，提交阶段就报 `client_tools_bridge_unsupported`（400），不会建运行。0.2.0 的旧版远程执行机器不声明这个特性，因此不会收到桥接任务（以前是到执行时才报 `manifest_mismatch`）。

外部协议 × 模式：

| 接口 | `managed` | `reject` | `bridge` |
| --- | --- | --- | --- |
| Chat Completions（`X-OAA-Compat: true` 或 `/v1/compat/chat/completions`） | 支持 | 支持 | 支持（内核与 ACP 智能体） |
| Responses（`X-OAA-Compat: true` 或 `/v1/compat/responses`） | 支持 | 支持 | 支持（内核与 ACP 智能体；只接受 `type: "function"` 工具） |
| Claude Messages（`/v1/messages`、`/v1/compat/messages`） | 支持 | 支持 | 支持（内核与 ACP 智能体；带 `type` 的服务端工具被拒） |
| Gemini `generateContent` / `streamGenerateContent`（`/v1beta` 与 `/v1`） | 支持 | 支持 | 支持（内核与 ACP 智能体；只接受 `functionDeclarations`，`googleSearch` 等内置工具被拒） |
| 严格接口（不带 `X-OAA-Compat` 的 `/v1/chat/completions`、`/v1/responses`） | — | — | — |
| UAP/1（`/v1/uap`） | — | — | — |

严格接口与 UAP/1 的请求结构不接受 `tools` 字段，不受模式影响：严格接口报 `unsupported_parameter`（`error.param: "tools"`，0.6.0 起；以前是 `invalid_request`），UAP/1 按未知字段报 `invalid_request`。

## 与人工审批的区别

桥接的「等调用方回传工具结果」和人工审批都会让运行停车，但决定权不同：

- 人工审批由 owner（需要 `approve` 权限）决定是否放行已发布工具的某一步。
- 调用方工具的结果由**调用方自己**回传（同一数据分区、`invoke` 权限即可），不经过 owner。

托管与拒绝模式不会产生任何待办。

## 桥接怎么用（内核智能体）

以 Chat Completions 为例，Responses、Claude Messages 与 Gemini 见下一节。

1. 第一次请求带上 `tools` 和 `X-OAA-Client-Tools: bridge`。智能体调用到调用方工具时，运行停车，响应是标准的 `finish_reason: "tool_calls"`：`message.tool_calls` 列出这一轮全部待执行的调用（并行的多个调用一次给全），`id` 以 `call_` 开头，`function.arguments` 是 JSON 字符串，`message.content` 是这一段新产生的文本（没有则为 `null`）。响应头 `X-Run-ID` 是运行 ID。
2. 调用方执行这些工具，照 OpenAI 的写法在 `messages` 末尾追加 `role: "tool"` 消息（`tool_call_id` 填上一步的 `id`），带着同样的 `tools` 与请求头再发一次。
3. 网关按 `tool_call_id` 找到停车的运行，写入结果，**同一个运行**接着做（`X-Run-ID` 不变），不需要把历史压平重放。响应只含上次交付之后的新输出：可能是最终结果，也可能是下一批 `tool_calls`。只回传了一部分结果时，运行再次停车并返回剩下的调用。

要点：

- 只有 `messages` **末尾连续的** `role: "tool"` 消息算本次回传的结果；更早的历史照旧压平成文本。
- 续接凭据就是 `tool_call_id`。网关要求它属于同一 owner、同一数据分区（或 owner 级可见的密钥）、对该智能体有 `invoke` 权限，且全部属于同一个运行；任何一条不满足（不认识、过期、属于别人）都当作新请求处理，不影响原运行，也不会透露这个 ID 是否存在。
- 同一批结果重复回传（网络重试）不会改写已写入的结果，会接到同一个运行上。
- 流式（`stream: true`）：停车时依次发出角色帧（之前没发过时，`content: null`）、每个调用一帧 `tool_calls` 增量（`index` 从 0 起）、`finish_reason: "tool_calls"` 收尾帧、（请求了 `include_usage` 时）用量帧与 `[DONE]`；续接后的流从上次之后开始，不重放之前的文本。
- 模型给出的参数不符合调用方的 schema 时，这次调用不会交给调用方，而是把 `{"error":"invalid_arguments","detail":...}` 作为工具结果交回模型，让它改了再调。这与已发布工具的参数错误（`invalid_tool_arguments`，运行直接失败）不同：调用方的 schema 不受发布者控制。
- 名字：须匹配 `^[a-zA-Z0-9_-]{1,64}$`；内部别名把 `-` 换成 `_`，首字符不是字母时加 `t_`，对外一律用原名。与已发布的工具、工作流、委托、`execute_graph` 或另一个调用方工具冲突报 `client_tool_conflict`；已发布工具加调用方工具超过 100 个报 `client_tools_too_many`；schema 无法编译报 `invalid_client_tool`。这些都在任何执行之前检查。调用方工具不能出现在 `execute_graph` 与工作流里。
- 等待期限沿用网关的 `approvalTimeoutMs`，到期未回传时运行以 `client_tool_timeout`（409）结束。停车期间不占运行槽，但仍计入未完成请求数上限；可以照常取消。网关重启后，只等调用方的停车运行保持停车，仍可续接。
- 这类待办在 `GET /v1/runs/{id}/actions` 里可见（`kind: "client_tool"`），但 `POST /v1/runs/{id}/actions/{action}` 会报 `action_kind_mismatch`；概览的「需要处理」计数不包含它们（计入进行中，另有 `awaiting_caller` 计数），时间线里显示为 `client_tool` 类的等待。
- 同一个运行里同时有人工审批时，先按人工审批的既有方式呈现：非流式 Chat / Claude 返回 422 `action_required`，带 `x-should-retry: false` 与运行 ID。调用方不要重发请求（那会新建一个运行）：等 owner 用 `POST /v1/runs/{id}/actions/{action_id}` 决定之后，用 `GET /v1/responses/{id}` 读结果，或者继续回传调用方工具的结果。
- **响应 ID 不随续接改变**：续接是同一个运行，返回的仍是同一个 `resp_…`（Chat 的 `chatcmpl_resp_…`、Claude 的 `msg_resp_…`）；调用方续接时把这个 ID 作为 `previous_response_id` 传回。这与 OpenAI「每次 `responses.create` 一个新 Response」不同，是「一个任务一个 ID、一次计费」的有意设计：以响应 ID 为键缓存历史的客户端（例如 Agents SDK 的会话存储）会看到同一个 ID 的内容被新的一段覆盖，`GET /v1/responses/{id}` 只给最新状态，不保留上一段的 `function_call` 快照。需要逐段历史时请在客户端按请求保存。
- 调用方回传的结果写回对话时：能解析成 JSON 对象或数组就按解析后的值写回，否则按原字符串写回、不加引号。
- 待办与协议无关：用一种协议发起的运行可以用另一种协议回传（例如 Chat 发起、Responses 回传），响应按这次请求的协议渲染。原则上建议同一种协议到底。

## Responses、Claude Messages 与 Gemini

**Responses**（`/v1/compat/responses`，或带 `X-OAA-Compat: true` 的 `/v1/responses`）：`tools` 里扁平的 `{"type":"function","name",...,"parameters"}` 是调用方工具，其它类型（如内置的 `web_search`）在 bridge 下报 `client_tools_unsupported`（managed 下照旧忽略）。`input` 末尾连续的 `function_call_output` 条目是回传结果；以 `call_id` 为准找运行，`previous_response_id` 给了但不是那个运行时按未命中处理。

```json
{ "model": "agent/coder", "input": "修复登录页的报错",
  "tools": [{ "type": "function", "name": "edit_file", "parameters": { "type": "object" } }] }
```

停车响应：`status: "completed"`，`metadata["oaa.status"] = "requires_action"`，`output` 先是本段新文本的 message 条目，再是每个调用一个条目：

```json
{ "type": "function_call", "id": "fc_8c1…", "call_id": "call_8c1…", "name": "edit_file",
  "arguments": "{\"path\":\"login.ts\"}", "status": "completed" }
```

回传：

```json
{ "model": "agent/coder", "previous_response_id": "resp_…", "tools": [ … ],
  "input": [{ "type": "function_call_output", "call_id": "call_8c1…", "output": "已修改" }] }
```

流式：停车时为每个调用依次发 `response.output_item.added`（arguments 为空串）、`response.function_call_arguments.delta`、`response.function_call_arguments.done`、`response.output_item.done`，最后 `response.completed`（response 同非流式）并关闭。`sequence_number`（与 SSE `id:`）：0.6.0 起所有 Responses 流都是这条流里帧的序号，从 0 起连续，合成帧同样计数（以前直接用事件 ID，桥接流取事件 ID 与已发出最大值 + 1 中较大的一个）。续接流是新的一段，从停车游标之后的真实事件开始，序号也从 0 起。序号只在一条流内有意义，不要跨流比较。

**Claude Messages**（`/v1/compat/messages` 与 `/v1/messages`，两者用同一个兼容解析器）：带 `name` 与 `input_schema` 的条目是调用方工具，带 `type` 的服务端工具（`web_search_*`、`bash_*`、`computer_*` 等）在 bridge 下报 `client_tools_unsupported`。最后一条 `user` 消息里的 `tool_result` 块是回传结果（`content` 为字符串或 text 块数组；`is_error: true` 时包成 `{"error": …}` 交给模型）。

```json
{ "model": "agent/coder", "max_tokens": 1024,
  "tools": [{ "name": "edit_file", "input_schema": { "type": "object" } }],
  "messages": [{ "role": "user", "content": "修复登录页的报错" }] }
```

停车响应：`stop_reason: "tool_use"`，`content` 先是本段新文本的 text 块，再是 `{"type":"tool_use","id":"call_8c1…","name":"edit_file","input":{"path":"login.ts"}}`。`tool_use.id` 直接用待办 ID（`call_` 前缀，不是 Claude 惯例的 `toolu_`），客户端应把它当作不透明字符串。回传：

```json
{ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "call_8c1…", "content": "已修改" }] }
```

流式：停车时（还没发过时）先补发 `message_start`；已打开的 text 块先 `content_block_stop`；每个调用 `content_block_start`（tool_use，`input: {}`）、一个 `input_json_delta`（完整 JSON）、`content_block_stop`，index 依次递增；最后 `message_delta`（`stop_reason: "tool_use"`）与 `message_stop`，然后关闭。

**Gemini**（`/v1beta/models/{agent}:generateContent` 与 `:streamGenerateContent`，`/v1/models/...` 相同）：`tools[].functionDeclarations[]` 是调用方工具，参数取 `parametersJsonSchema`（JSON Schema，原样）或 `parameters`（Gemini 的 OpenAPI 子集：`type: "OBJECT"` 等大写类型转成小写，`nullable: true` 并入类型）。`googleSearch`、`codeExecution`、`urlContext` 等内置工具（或与 `functionDeclarations` 写在同一条里）在 bridge 下报 `client_tools_unsupported`，managed 下照旧忽略。`toolConfig`（含 `functionCallingConfig` 的 `mode`、`allowedFunctionNames`）与其它协议的 `tool_choice` 一样不转发，列在 `X-OAA-Ignored-Params` 里。

```json
{ "contents": [{ "role": "user", "parts": [{ "text": "修复登录页的报错" }] }],
  "tools": [{ "functionDeclarations": [{ "name": "edit_file", "parameters": { "type": "OBJECT" } }] }] }
```

停车响应：`candidates[0].content.parts` 先是本段新文本的 text part，再是每个调用一个 `{"functionCall":{"id":"call_8c1…","name":"edit_file","args":{"path":"login.ts"}}}`（`args` 是对象，并行调用是多个 part），`finishReason: "STOP"`（Gemini 的函数调用本来就以 STOP 结束），`usageMetadata` 照常，`responseId` 是运行 ID、续接时不变。回传：`contents` 最后一条（`role: "user"` 或 `"function"`）里的 `functionResponse` part：

```json
{ "role": "user", "parts": [{ "functionResponse": { "id": "call_8c1…", "name": "edit_file", "response": { "output": "已修改" } } }] }
```

`response` 按 JSON 写回对话。带 `id` 时按 `id` 配对；不带 `id` 时（官方 `@google/genai` 的 `chats` 会把模型回合的 `functionCall`（含 `id`）原样留在历史里，但调用方自己写的 `functionResponse` 往往不带 `id`），按上一条 `role: "model"` 内容里 `functionCall` 的 `name` 与出现顺序配对。配不上（不认识的 `id`、没有可配对的 `functionCall`、名字对不上）时与其它协议的未知 ID 一样，整体当作新请求处理，原运行保持停车。

流式（`?alt=sse` 或分块 JSON 数组）：停车时一个分片给出全部 `functionCall` part（Gemini 不对参数分片），同一分片带 `finishReason: "STOP"` 与 `usageMetadata`，然后关闭；此前已流式发出的文本不重复。

## 外部智能体的桥接是怎么工作的

ACP 外部智能体有自己的工具循环，OAA 插不进去。但 ACP 建会话时可以交给智能体一组 MCP 服务（`session/new` 的 `mcpServers`，stdio 形式是 ACP 要求所有智能体都支持的基线），OAA 就用这个口子把你的工具交给它：

```
调用方 ─tools─▶ 网关 ─▶ 内核 ─任务（带调用方工具）─▶ 执行机器
                                                       │ session/new { mcpServers: [oaa-caller] }
                                                       ▼
                                        ACP 智能体 ─MCP tools/call─▶ 中继进程（oaa mcp-relay）
                                                                       │ 本机 Unix 域套接字
                                        执行机器 ◀─────────────────────┘
                                           ▼
                        内核登记待办，运行进入 requires_action ─▶ 网关以 tool_calls 交给调用方
                        调用方回传结果 ─▶ 结果原路回到 MCP tools/call，智能体接着做
```

使用者需要知道的几点：

- **中继**：每一轮给智能体一个固定名为 `oaa-caller` 的 stdio MCP 服务。它是 `oaa mcp-relay` 子命令启动的小进程，只做两件事：`tools/list` 列出你的工具（名字、说明、参数 schema 原样给出），`tools/call` 经本机 Unix 域套接字转给执行机器。套接字放在该运行私有的 0700 目录里（工作区路径过长时改用系统临时目录下的短路径），套接字与一次性令牌文件都是 0600，只接受持有令牌的第一个连接；不监听任何网络端口。这一轮结束（完成、失败、取消、超时）时套接字关闭、文件删除，中继随之退出。
- **对你来说**和内核智能体一样：响应里是标准的 `tool_calls`（或 `function_call`、`tool_use`），名字是你的原名，回传后**同一个运行**接着做。同一时刻发出的多个调用一次给全（中继把 5 毫秒内到达的调用合成一次转发，内核在下一个事件循环合并通知）；智能体晚一点才发出的调用，在你下一次回传时一并返回。
- **内层智能体看到的工具名**是 MCP 的命名，由智能体自己决定（常见的是加服务名前缀，例如 `oaa-caller` 下的 `edit-file`）。外部智能体没有已发布的工具，不做别名，原名里的 `-` 在 MCP 里也合法。
- **等待期间内层进程保持存活**：这与外部智能体的人工审批一样，占着进程与运行槽，不是可迁移的停车。期限沿用 `approvalTimeoutMs`，到期以 `client_tool_timeout` 结束；可以照常取消。
- **网关重启会中断这类运行**（`interrupted`，与其它外部智能体运行一致），不会像内核智能体那样保持停车等你续接。
- 参数不符合你的 schema、或智能体调用了清单里没有的名字时，不会交给你，而是直接以 MCP 的错误结果（`isError: true`）交回智能体，运行不失败。
- 运行事件：新的调用方待办出现后发出 `run.awaiting_caller`（载荷是此刻全部待处理的待办 ID），它在外部智能体的桥接运行里代替内核的 `run.parked`。
- **对调用方工具的权限请求自动放行**：有的智能体（如 Qoder）在调用 MCP 工具前先发 `session/request_permission`。这些工具由你自己提供、自己执行，所以只在桥接回合里、且请求针对的确实是中继提供的工具时，OAA 直接选「允许一次」（`allow_once`），不创建 owner 审批，并记一条进度 `{ event: "permission_auto_allowed", tool }`。判断是保守的，两条必须同时满足：标题或 `rawInput` 的工具标识里出现 `oaa-caller`（大小写不敏感）；标题分词后有一个词等于你的某个工具名，或以 `_<工具名>` 结尾（覆盖 `mcp_oaa-caller_<name>` 写法）。不按 `kind` 判断。**安全边界**：自动放行只发生在桥接回合、只针对中继提供的工具；智能体自带工具（读写文件、执行命令等）的权限请求照旧走 owner 审批。
- 调用前已经输出的文本作为一条输出消息结束，续接后的新文本是新的一条；响应只含上次交付之后的新输出。

### 限制与未验证项

- **没有对真实 ACP 智能体联调**。测试用的是协议级假智能体（`test/fixtures/acp-caller-agent.mjs`：读取 `mcpServers`、用 MCP SDK 启动中继、`tools/list`、`tools/call`）。`mcpServers` 条目的字段形状（`{ name, command, args, env: [{ name, value }] }`）依据 ACP 规范的公开描述，仓库里没有 ACP 的类型定义可以对照。 （2026-11-11 更新：已对本机 Antigravity 命令行（`agy` 1.5.5）的 ACP 入口用 Gemini 3.8 Flash 做过一次真实联调，托管与桥接各一次调用均通过，`mcpServers` 的 stdio 条目形状被接受；并行调用、流式、慢回传与其它 ACP 智能体仍未验证。联调结果见 [evidence.md](evidence.md)。）
- 智能体自己的 MCP 调用超时（例如 MCP SDK 默认 60 秒）可能比 `approvalTimeoutMs` 短：调用方回传太慢时，智能体可能先放弃这次调用。
  - **保活**：等待调用方期间，中继对请求里带了 `_meta.progressToken` 的 `tools/call` 每 15 秒发一次 `notifications/progress`（`progress` 递增，`message` 说明在等调用方；间隔可用 `oaa mcp-relay --progress-interval-ms` 或环境变量 `OAA_MCP_RELAY_PROGRESS_MS` 调整）。没带令牌时不发。这**不保证**能延长超时：要智能体的 MCP 客户端启用了「收到进度即重置超时」（MCP SDK 的 `resetTimeoutOnProgress`），而且它确实给了 progressToken。建议把网关的 `approvalTimeoutMs` 与智能体的 MCP 请求超时对齐（不长于后者），或把智能体的 MCP 超时调大。
  - **放弃后的收尾**：智能体放弃调用时如果关掉了中继（关闭 MCP 服务，或超时后重启服务），中继到执行机器的套接字会断开；仍在等待的调用随即以 `client_tool_abandoned` 结束：对应步骤失败、待办标为过期，运行不因此失败（智能体还在继续），没有其它待办时状态回到 `in_progress`。之后再回传这个 `call_id` 不会续接，按新请求处理。智能体只是让请求超时、却不关闭中继时，这次调用仍会挂到 `approvalTimeoutMs`，以 `client_tool_timeout` 结束运行。
- 只支持 ACP 接入；Codex、Claude Code、Antigravity、DSH、A2A 与 oaa-1 适配器仍是仅托管。

## 路线

- 已提供：内置内核智能体与 ACP 外部智能体在 Chat Completions、Responses、Claude Messages、Gemini 上的 `bridge`（`/health` 的 `features` 含 `harness-bridge-v1`、`harness-bridge-acp-v1`）。UAP/1 不做桥接。Gemini 的桥接线上格式测试只用了内核智能体；ACP 智能体走的是与协议无关的同一套停车与续接，没有单独经 Gemini 入口测试。
- 后续：其它外部智能体（Claude Agent SDK 的进程内 MCP 服务、Codex 的 MCP 配置）要逐个引擎联调。

`/health` 的 `features` 含 `client-tools-policy-v1` 时，本页描述的托管与拒绝模式可用。错误码见 [protocol.md](protocol.md)「错误码」一章。
