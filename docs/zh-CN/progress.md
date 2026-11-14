# 流式响应里的运行过程

[English](../progress.md) · 简体中文

调用智能体就是一次运行：可能要排队、读文件、调用工具、等审批，最后才回答。没有过程信息时，标准聊天客户端在这整段时间里什么都不显示。开启流式过程后，网关把每个阶段的一行简短说明放进流里，**用各协议自己的「思考 / 推理」形状**，于是已经会显示模型思考过程的客户端，不做任何改动就能显示智能体正在做什么。

## 过程文字写什么

每个阶段一行，信息来自已有的运行事件（没有另造一套事件）。过程文字不带工具的入参与返回内容、提示词、系统指令、内部标识（步骤、线路、节点 ID），也不带审批人的名字。标题类文字经过网关的密钥脱敏，并截断到 120 个字符。语言按请求的 `Accept-Language`，没有时按进程语言（`OAA_LOCALE`，见 [cli.md](../cli.md)）。

| 运行事件 | English | 中文 |
| --- | --- | --- |
| `run.queued`（`fairness`） | Queued: taking turns with other runs for an execution slot | 排队中：与其他运行轮流使用执行名额 |
| `run.queued`（其他原因） | Queued: waiting for an execution slot | 排队中：等待执行名额 |
| `run.queued`（`approval_resolved`） | What it waited for is settled; back in the queue | 等待的事项已处理，重新排队 |
| `run.queued`（`agent_fallback`） | Switching to fallback agent `<agent>` (reason: `<code>`) | 切换到备选智能体 `<agent>`（原因：`<code>`） |
| `response.in_progress`（第一次 / 之后） | Started / Resumed | 开始执行 / 继续执行 |
| `tool.queued`（内核工具） | Calling tool `<name>` (read-only / changes data) | 调用工具 `<name>`（只读 / 会修改数据） |
| `tool.queued`（外部智能体自己的一轮） | Handed to the agent | 交给智能体执行 |
| `tool.started`（第 2 次及以后的尝试） | Retrying tool `<name>` (attempt n) | 重试工具 `<name>`（第 n 次） |
| `tool.completed` / `tool.failed` / `tool.cached` | Tool `<name>` finished / failed (`<code>`) / used a cached result | 工具 `<name>` 完成 / 失败（`<code>`）/ 使用了缓存结果 |
| 外部智能体的 `tool.progress`：工具调用 | Agent tool call: `<title>` · Done: `<title>` · Failed: `<title>` | 智能体调用工具：`<title>` · 完成：`<title>` · 失败：`<title>` |
| 外部智能体的 `tool.progress`：思考（连续只说一次） | The agent is thinking… | 智能体正在思考… |
| 外部智能体的 `tool.progress`：计划 / 权限 | The agent made a plan (n steps) · An operation was not permitted and was refused · Allowed by policy: `<tool>` | 智能体制定了计划（n 步）· 一项操作未获许可，已拒绝 · 按策略自动允许：`<tool>` |
| `tool.progress`（`output_repair`，结构化输出） | The answer did not match the required format; sent back for correction (round n) | 答案不符合要求的格式，退回修改（第 n 轮） |
| `run.requires_action`（调用方工具） | Waiting for the caller to run tool `<name>` | 等待调用方执行工具 `<name>` |
| `run.requires_action`（审批） | Waiting for approval: the owner must approve "`<tool>`" in the console | 等待审批：需要所有者在控制台批准「`<tool>`」 |
| `approval.resolved` | Approved · Approved automatically by policy · Approval denied | 审批通过 · 已按策略自动批准 · 审批被拒绝 |
| `route.failover` | Switched to a backup model route | 模型线路切换到备用线路 |
| `subagent.*` / `workflow.*` | Delegating to sub-agent `<agent>` … / Workflow `<name>` started (n steps) … | 委托子智能体 `<agent>` … / 开始工作流 `<name>`（n 步）… |
| `response.completed`（只在还没有任何答案文字时） | Done | 完成 |

外部智能体的标题来自各接入方式已经上报的内容：ACP 智能体为每次工具调用报标题（`tool_call` / `tool_call_update`），Claude Code 与 Antigravity 报工具名，Codex 报条目类型（`commandExecution`、`fileChange` 等）。ACP 的 `agent_thought_chunk` 文字**不转出**：那是智能体自己的思考，可能很长、可能引用文件内容或密钥，而且要先写进运行的事件记录；网关只继续报「智能体正在思考…」。这些路径只在替身上测过，没有在真实智能体上验证。

摘要生成是一个纯函数（`src/gateway/progress.ts` 的 `summarize(event, state, locale)`）。

## 线上的形状

过程绝不进入答案：非流式响应的 `content` / `output_text` / `text` 不变，流里正文增量拼起来与非流式的答案逐字相同，用量统计不包含过程文字。

| 协议 | 形状 | 位置 |
| --- | --- | --- |
| OpenAI Chat Completions | `choices[0].delta.reasoning_content`（DeepSeek、vLLM、SGLang 与许多网关事实上使用的字段） | 在 `content` 增量之前或之间 |
| OpenAI Responses | `output_index` 0 处的一个 `reasoning` 输出项：`response.output_item.added`、`response.reasoning_summary_part.added`、`response.reasoning_summary_text.delta` …，然后 `.done` 与 `response.output_item.done` | 在答案之前；之后每一帧的 `output_index` 加一，响应快照（`response.in_progress`、`response.completed`）把它排在第一项 |
| Claude Messages | index 0 的 `thinking` 内容块（`thinking_delta` …，然后带固定签名 `oaa-progress-v1` 的 `signature_delta`），在文字块之前结束，文字块变成 index 1 | 在答案之前；正文开始之后的过程不再发送 |
| Gemini | 带 `"thought": true` 的 part | 在文字 part 之前或之间 |

从网关抓到的例子（有删节）：

```text
data: {"id":"chatcmpl_run_…","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{"reasoning_content":"Calling tool list_files (read-only)\n"},"finish_reason":null}]}
data: {"id":"chatcmpl_run_…",…,"choices":[{"index":0,"delta":{"content":"The file"},"finish_reason":null}]}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","sequence_number":4,"item_id":"rs_run_…","output_index":0,"summary_index":0,"delta":"Started\n"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Started\n"}}

data: {"responseId":"run_…","modelVersion":"agent/test@fixture","candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Started\n","thought":true}]}}]}
```

客户端在下一轮把这些内容原样回传时会被干净地忽略：Claude 的 `thinking` 块、Responses 的 `reasoning` 输入项、Gemini 的 `thought` part 都在交给智能体之前丢弃。

## 怎么选

每次请求可以用请求头或元数据键，写法与 `X-OAA-Client-Tools` 一致（[harness.md](harness.md)）：

```text
X-OAA-Progress: reasoning | off
metadata: { "oaa.progress": "reasoning" | "off" }
```

请求头优先于元数据，不认识的值按没给处理。两者都没有时按网关配置，每个协议各一项：

```json
{ "streamProgress": { "chat": "off", "responses": "reasoning", "claude": "off", "gemini": "reasoning" } }
```

上面就是缺省值。重新接上的 Responses 流（`GET /v1/responses/{id}?stream=true`）用同样的规则；请带上同样的请求头，`sequence_number` 与 `starting_after` 才对得上。非流式请求不受影响；响应头 `X-Run-ID` 已经给出了运行 ID，时间线接口 `GET /v1/runs/{id}/timeline` 返回它的过程。`/health` 的 `features` 里有 `stream-progress-v1`。

## 缺省值的依据：协议 × 客户端

对某个协议，如果兼容性实验室实际运行的所有 SDK 与框架都能安然接受这个形状（忽略或显示，不报错、不改变答案），并且回放的聊天客户端里没有已知会出问题的，就缺省开启。实际运行的结果来自 `npm run compat`（每个客户端都有 `*.stream_progress` 场景，比较开启与关闭时的答案）；聊天客户端里只有 Dify 对照了公开源码；回放文件断言缺省的 Chat 流里没有 `reasoning_content`。

| 协议 | 客户端 | 表现 |
| --- | --- | --- |
| Chat | openai（Node 7.57、Python 3.x） | `content` 不受影响；`delta.reasoning_content` 可读 |
| Chat | Vercel AI SDK `@ai-sdk/openai` chat | 忽略 |
| Chat | Vercel AI SDK `@ai-sdk/openai-compatible` | **显示**为推理过程 |
| Chat | LangChain `ChatOpenAI`、LlamaIndex `OpenAILike` | 忽略 |
| Chat | LiteLLM | 原样透传 `reasoning_content`（显示） |
| Chat | OpenAI Agents SDK（chat completions 模型） | 接受；最终输出不变 |
| Chat | Dify（OpenAI-API-compatible 模型供应商） | **出问题**：把 `reasoning_content` 用 `<think>…</think>` 包起来拼进答案（dify-plugin-sdks 的 `_wrap_thinking_by_reasoning_content`） |
| Chat | Open WebUI、LobeChat、Cherry Studio、Chatbox、NextChat、LibreChat、Cline / Roo Code | 已知支持 DeepSeek 式的 `reasoning_content` 并显示为思考过程；这里没有逐一核对源码，也没有运行 |
| Chat | Cursor、Continue、Zed、n8n | 未验证；预计忽略不认识的增量字段 |
| Responses | openai（Node，严格校验输出位置；Python） | 接受；摘要事件可读；`output_text` 不变 |
| Responses | Vercel AI SDK `@ai-sdk/openai` responses | **显示**为推理过程 |
| Responses | OpenAI Agents SDK（responses 模型） | 接受；最终输出不变 |
| Claude | @anthropic-ai/sdk（Node）、anthropic（Python） | 接受；`thinking` 事件可读；把块回传给下一轮没有问题 |
| Claude | Vercel AI SDK `@ai-sdk/anthropic` | **显示**为推理过程 |
| Claude | LangChain `ChatAnthropic` | 接受，但流式 `content` 变成块列表：把 `chunk.content` 当字符串拼接的代码会出错（应当用 `.text`） |
| Gemini | @google/genai（Node、Python） | `.text` 跳过 thought part；思考内容可读 |
| Gemini | Vercel AI SDK `@ai-sdk/google` | **显示**为推理过程 |

所以：**Chat 缺省关闭**（Dify 会把过程拼进答案，其他把未知字段拼进正文的客户端也可能如此）；**Responses 与 Gemini 缺省开启**；**Claude 缺省关闭**（thinking 块会改变 `content[0]` 和框架里流式内容的形状，带签名，还可能被回传；从严处理）。Responses 的提醒：读取流式 `response.completed` 事件里 `response.output[0]` 的代码会拿到推理项——与 OpenAI 自己的推理模型相同；请读 `output_text` 或 `message` 项。用 `streamProgress` 为整个网关开关某个协议，或用请求头按次选择。

## 与其他能力的关系

- **结构化输出**（[structured-output.md](structured-output.md)）：答案被扣住校验期间过程照常送出（包括修复轮），流里不再一片空白。
- **调用方工具桥接**（[harness.md](harness.md)）：交给调用方（`tool_calls`、`function_call`、`tool_use`、`functionCall`）之前有过程，续接后的流里也有。Claude 的 `tool_use` 块排在 thinking 块之后，索引连续。
- **审批**：等待只报一次，期间靠心跳保持连接。Chat、Claude、Gemini 的流遇到审批照旧以该协议的错误结束；Responses 的流保持打开，并显示审批结果。
- **取消与失败**：流以该协议自己的错误帧结束，之前发出的过程不改变它。
- **图片输入与续接**：不受影响；每条流的过程从头开始。
