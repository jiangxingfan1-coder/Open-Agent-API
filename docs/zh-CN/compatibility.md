# 兼容性

[English](../compatibility.md) · 简体中文

Open Agent API 把一个智能体发布成 API，支持四种协议：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Gemini `generateContent`。调用方在 `model` 里填**智能体名**（例如 `agent/sample`）。本页说明：哪些客户端真正对着网关运行过，哪些是按记录下来的请求形状回放的，哪些未核实，每个客户端怎么配置，以及网关怎么处理它用不上的参数。

本页没有无来源的结论：每个客户端的证据等级都写明了，回放背后的证据在回放文件本身里（`integrations/compat/replays/<客户端>.json`：读过的源码地址与提交或标签，以及日期）。

## 兼容性实验室

`npm run compat` 在 `127.0.0.1` 随机端口起一个隔离的网关（临时数据目录，一把生成的调用方密钥），发布离线示例智能体和一个由确定性夹具模型驱动的智能体，把每个客户端脚本跑一遍，回放记录下来的请求形状，写出 `matrix.json`（机器可读）与 `matrix.md`，最后关掉网关。全程不调用任何模型服务。它需要 `integrations/compat/` 里的 Python 与 Node 包（`requirements.txt`、`package-lock.json`）；缺包的客户端会报告为跳过，绝不会算作通过。

* `integrations/compat/clients/` 里每个客户端一个脚本；脚本跑若干具名场景，报告 `pass`、`fail`、`na`（客户端按设计做不到）或 `skip`。
* `integrations/compat/replays/` 存放装不进测试环境的聊天客户端的请求形状。`test/compat-replays.test.ts` 在常规离线测试里回放同一批文件。
* `.github/workflows/compat.yml` 在每次推送与拉取请求时运行实验室，并每周跑一次（第三方 SDK 在更新，每周的运行能发现哪个 SDK 不再能用）。矩阵作为产物上传，并写进作业摘要。

## 证据等级

### 实际对着网关运行（live）

真实的包经真实的套接字运行。版本是实验室最近一次运行时用的。

| 客户端 | 版本 | 场景覆盖 |
|---|---|---|
| `openai`（Python） | 3.51.0 | Chat 与 Responses：非流式、流式、`include_usage`、system / developer / 历史、内容块、采样与厂商参数、`reasoning_effort`、工具调用往返（流式与否）、`response_format`、后台任务加 `retrieve` 与 `cancel`、`previous_response_id`、错误类（401、403、404、400、422、429）、超时与重试、并发、图片 |
| `anthropic`（Python） | 2.8.0 | Messages：非流式、事件序列、流式辅助、各种 `system` 形态、历史、采样参数、较新的请求字段、`max_tokens`、工具往返、错误类、`models.list/retrieve`、`count_tokens` 与批处理 |
| `google-genai`（Python） | 3.3.0 | `generateContent`、流式、系统指令、chats、配置参数、JSON mime 类型、`MAX_TOKENS`、函数调用（手动与自动）、错误类、`models.list/get`、不支持的端点 |
| `openai`（Node） | 7.57.0 | 同上的 Chat 与 Responses，经套接字 |
| `@anthropic-ai/sdk`（Node） | 1.8.0 | 同上的 Messages |
| `@google/genai`（Node） | 3.3.0 | `generateContent`、流式、chats、函数调用、错误类、`models` |
| Vercel AI SDK | `ai` 7.0.173 | `@ai-sdk/openai`（chat 与 responses）、`@ai-sdk/openai-compatible`、`@ai-sdk/anthropic`、`@ai-sdk/google`：`generateText`、`streamText`、system / 历史 / 采样设置、工具循环 |
| LangChain | `langchain-openai` 1.8.0、`langchain-anthropic` 1.7.10 | `invoke`、`stream`、历史、采样、工具往返、结构化输出、Responses API 模式 |
| LiteLLM（作为库） | 1.109.1 | `openai/`、`anthropic/`、`gemini/` 自定义端点，`responses()`、工具、错误映射 |
| OpenAI Agents SDK（Python） | 0.24.0 | 网关智能体作为 SDK 智能体的模型，经 `OpenAIResponsesModel` 与 `OpenAIChatCompletionsModel`：`run`、`run_streamed`、模型设置、函数工具 |
| LlamaIndex | `llama-index-core` 0.14.26、`llama-index-llms-openai-like` 0.9.0 | `OpenAILike`：`complete`、`chat`、流式、工具。普通的 `OpenAI` 类会在客户端先拒绝智能体名（见下） |

### 按记录的请求形状回放

这些客户端装不进测试环境。我们读了它们的源码（或官方文档），记录下每个客户端发给自定义 OpenAI 兼容端点的请求并附上来源，实验室把这些请求回放给网关，并按客户端自己的代码依赖什么来检查响应（读哪些字段、第一个分块是否需要 `delta.role`、怎么处理 `usage` 分块等）。回放能证明网关接受这个请求、并以客户端能解析的形式回答；不能证明整个应用都能正常工作。

| 客户端 | 读过的版本 | 源码证据 | 用例（已核实 / 推断 / 未核实） |
|---|---|---|---|
| Open WebUI | v0.13.3 | verified | 11 / 1 / 0 |
| LibreChat | v0.8.8 | partial（请求体由它所用的 LangChain 源码推出） | 2 / 7 / 1 |
| Chatbox | v1.24.4 | verified | 9 / 4 / 0 |
| Cherry Studio | v2.2.2 | verified | 5 / 5 / 1 |
| LobeChat | v2.3.3 | partial | 4 / 8 / 0 |
| NextChat | main@1d3dc33（最近发布 v2.16.1） | verified | 10 / 0 / 0 |
| Dify（OpenAI-API-compatible 插件） | 插件 0.0.83、SDK 0.10.2 | verified | 10 / 3 / 0 |
| n8n（OpenAI 凭据 / Chat Model） | 2.47.7 | verified | 10 / 4 / 0 |
| Continue | main@5522c6f | verified | 11 / 1 / 0 |
| Cline | main@72b3d71（发布 4.1.26） | verified | 与 Roo Code 共用一个文件：11 / 3 / 0 |
| Roo Code | b867ec9（2026-05-15 已归档） | verified | （同一个文件） |
| Zed | main@f0fa51b | verified | 7 / 2 / 0 |

「已核实」指用例来自该客户端在所述修订上的源码；「推断」指来自它所用的库或有文档的默认值；「未核实」指没有找到可靠来源，用例只是协议骨架。

### 未核实

* **Cursor**（闭源）：只有两个骨架用例，都未核实。Cursor 从它自己的服务器发出请求，所以 `localhost` 地址够不着，需要公网 HTTPS 地址。官方文档没有说 Base URL 是否带 `/v1`。
* 网页版客户端的浏览器行为（Chatbox 网页版、NextChat 自定义端点、LobeChat 客户端请求模式）只按 CORS 预检回放；没有驱动真实浏览器。
* 编码代理（Cline、Roo Code、Continue 智能体模式、Zed 智能体）的工具调用行为按请求形状回放，没有让真实的扩展对着桥接的智能体运行。

## 配置客户端

把 `http://127.0.0.1:8787` 换成你的网关地址。API 密钥是调用方密钥（`sk-oaa-...`）；模型名是智能体名，与 `GET /v1/models` 列出的完全一致（例如 `agent/sample`）。

| 协议 | Base URL | 说明 |
|---|---|---|
| OpenAI（Chat Completions、Responses） | `http://127.0.0.1:8787/v1` | 客户端自己追加 `/chat/completions`、`/responses`、`/models` |
| OpenAI，带调用方工具或 JSON 输出格式 | `http://127.0.0.1:8787/v1/compat` | 见「调用方工具与 JSON 输出」 |
| Anthropic | `http://127.0.0.1:8787` | SDK 自己追加 `/v1/messages`；密钥用 `x-api-key` 或 `Authorization: Bearer` |
| Gemini | `http://127.0.0.1:8787`，API 版本 `v1beta` 或 `v1` | 密钥用 `x-goog-api-key` 或 `?key=` |

Base URL 写错是 404 最常见的原因。网关现在忽略末尾斜杠与重复斜杠（`/v1//chat/completions`），404 的说明也会点出多半是什么错了：缺 `/v1`（`POST /chat/completions`），或多了一个（`/v1/v1/chat/completions`，客户端已经自己加了 `/v1`）。

### 聊天客户端

| 客户端 | 位置 | Base URL | 模型 | 说明 |
|---|---|---|---|---|
| Open WebUI | 管理员设置 > 连接 > OpenAI | `http://<主机>:8787/v1` | 从 `/models` 列出，或在 Model IDs（Filter）里加上智能体名 | 除了聊天本身，它还会向同一个智能体发标题、标签与追问请求，所以每个新对话会运行智能体不止一次；如果每次运行代价高，在设置 > 界面里把它们关掉。自定义的「高级参数」（`top_k`、`min_p`、`repeat_penalty`、`num_ctx`、`think` 等）被接受并忽略；Ollama 的 `format` 参数（JSON 模式）会被明确拒绝。在 Docker 里要用容器能访问到的主机名，并把它加进 `allowedHosts`（见下）。 |
| LibreChat | `librechat.yaml`，`endpoints.custom[]` | `baseURL: "http://<主机>:8787/v1"` | `models.default: ["agent/sample"]`，或 `models.fetch: true` | 每个请求都带 `user`（接受）。除非想要每个对话多跑一次智能体，否则设 `titleConvo: false`。 |
| Chatbox | 提供方 > API Host | `http://<主机>:8787/v1` | 加上智能体名，或拉取模型 | 要写 `http://` 前缀；不写时客户端按 `https://` 处理。API Path 保持 `/chat/completions`。网页版从浏览器直接调用网关：把它的来源加进 `allowedOrigins`。 |
| Cherry Studio | 模型服务 > 添加 > 类型 OpenAI > API Host | `http://<主机>:8787` 或 `.../v1`（两者都行；末尾加 `#` 则原样使用） | 手动添加或拉取 | 请求来自 Electron 主进程（没有 CORS）。检查按钮与自动命名发的是不带 `max_tokens` 的非流式请求。 |
| LobeChat | AI 服务商 > OpenAI（或自定义服务商，格式 OpenAI）> API 代理地址 | `http://<主机>:8787/v1` | 拉取模型或手动添加 | 除非需要，保持服务商的「Responses API」开关关闭。LobeChat 会隐藏 id 里含 `embedding`、`tts`、`whisper`、`ada`、`davinci` 等字样的模型（所以名为 `agent/adapter` 的智能体会从列表里消失：改个名字）。「客户端请求模式」从浏览器调用网关：把来源加进 `allowedOrigins`。 |
| NextChat | 设置 > 自定义接口 > OpenAI 接口地址 | `http://<主机>:8787`，**不带 `/v1`** | 设置 > 自定义模型：`agent/sample` | NextChat 自己追加 `v1/chat/completions`（写成 `.../v1` 会变成 `/v1/v1/...`），而且从不拉取远端模型列表。匹配它视觉模型规则的模型名（`vision`、`vl`、`gpt-4o`、`o3` 等）会被多加 `max_tokens: 4000`。 |
| Dify | 模型供应商 > OpenAI-API-compatible > 添加模型 | Dify 在 Docker 里时用 `http://host.docker.internal:8787/v1` | 模型名 = 智能体名 | Dify 从不调用 `/models`。它的流解析器要求每个分块都有 `choices` 数组（网关的 usage 分块是 `choices: []`），并忽略 `:` 注释帧。 |
| n8n | 凭据 > OpenAI | Base URL `http://<主机>:8787/v1` | OpenAI Chat Model：「By ID」或「From List」 | 凭据的 Test 按钮调用 `GET /v1/models`。节点的「Use Responses API」模式（新版本默认开）与 Chat Completions 模式都建立在 LangChain 上；LangChain 的两种模式在实验室里对网关都能用，n8n 的请求形状按回放验证。挂了工具的 AI Agent 节点会发 `tools`：用 `/v1/compat`（见下）。 |
| Continue | `config.yaml`，`models[]` | `apiBase: http://<主机>:8787/v1` | `model: agent/sample` | 只有在使用 compat Base URL 时才加 `capabilities: [tool_use]`。Tab 自动补全默认用 `POST /v1/completions`，网关不提供：补全留给别的模型，或设 `useLegacyCompletionsEndpoint: false` 让它改发 chat。 |
| Cline / Roo Code | API 提供方「OpenAI Compatible」 | `http://<主机>:8787/v1` | 智能体名 | 两者都总是发 `tools`。默认端点回答一个点明 `/v1/compat` 的清楚的 400；请用 `http://<主机>:8787/v1/compat`，再加自定义头 `X-OAA-Client-Tools: bridge` 让智能体调用编辑器的工具。Roo Code 上游已归档。 |
| Zed | `settings.json`，`language_models.openai_compatible.<名字>` | `api_url: "http://<主机>:8787/v1"` | `available_models[].name: "agent/sample"` | Zed 从不调用 `/models`，所以模型要手工列出。它的智能体配置会发 `tools`（用 compat Base URL）。 |
| Cursor | 设置 > 模型 > 覆盖 OpenAI Base URL | 公网 HTTPS 地址，带 `/v1`（未核实） | 自定义模型名 | 未核实，见上。 |

### SDK 与框架

| 包 | 配置 |
|---|---|
| `openai` | `OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=...)`，`model="agent/sample"` |
| `anthropic` | `Anthropic(base_url="http://127.0.0.1:8787", api_key=...)` |
| `google-genai` | `genai.Client(api_key=..., http_options=types.HttpOptions(base_url="http://127.0.0.1:8787", api_version="v1beta"))` |
| Vercel AI SDK | `createOpenAI({ baseURL: ".../v1" })`（`.chat()` 与 `.responses()` 都行）、`createOpenAICompatible({ name, baseURL: ".../v1" })`、`createAnthropic({ baseURL: ".../v1" })`、`createGoogleGenerativeAI({ baseURL: ".../v1beta" })`；智能体名原样作为模型 id |
| LangChain | `ChatOpenAI(model=..., base_url=".../v1", stream_usage=True)`（自定义 `base_url` 时 LangChain 不会自己请求流式用量），`ChatAnthropic(model=..., anthropic_api_url="http://127.0.0.1:8787")` |
| LiteLLM | `litellm.completion(model="openai/agent/sample", api_base=".../v1")`；也可用 `anthropic/agent/sample` 加 `api_base="http://127.0.0.1:8787"`，以及 `gemini/agent/sample` 加 `api_base=".../v1beta"` |
| OpenAI Agents SDK | `Agent(model=OpenAIResponsesModel(model="agent/sample", openai_client=AsyncOpenAI(base_url=".../v1", api_key=...)))` 或 `OpenAIChatCompletionsModel(...)`。调用 `set_tracing_disabled(True)`，否则 SDK 会把追踪上传给 OpenAI。函数工具需要 compat Base URL |
| LlamaIndex | `OpenAILike(model="agent/sample", api_base=".../v1", api_key=..., is_chat_model=True)`。`OpenAI` 类在发任何请求之前会按 OpenAI 自己的列表检查模型名，并拒绝智能体名 |

## 调用方工具与 JSON 输出

默认情况下，智能体使用它自己的工具。请求里声明调用方定义的 `tools`（或 `functions`、工具结果消息、assistant 的 `tool_calls`），要求 JSON 输出格式（`response_format` 为 `json_object` / `json_schema`、`text.format`），强制指定工具，或要求 `logprobs`，在默认端点上会被**拒绝**，返回 `400 unsupported_parameter`（Responses 输入里的工具项是 `unsupported_content`）。`error.param` 写明字段，错误信息写明出路：

* 用 Base URL `http://<主机>:8787/v1/compat`（或带 `X-OAA-Compat: true`）。compat 端点按模式处理 `tools`，模式由请求头 `X-OAA-Client-Tools` 选择：`managed`（默认：智能体继续用自己的工具，响应带 `X-OAA-Client-Tools: ignored`）、`reject`，或 `bridge`（智能体对你的工具的调用以协议的正常形式交回，运行从你回传的结果接着往下做）。JSON 格式作为尽力而为的指令写进智能体的输入；并不约束智能体一定产出合法 JSON。
* Anthropic 与 Gemini 入口本来就是 compat 入口。

选择拒绝而不是忽略的原因：发 `tools` 的客户端期待拿回工具调用，发 `response_format` 的客户端期待拿回 JSON。悄悄丢掉它们，会让编码代理在「你没有调用工具」上循环，也会让解析器稍后以更难懂的错误失败。

## 参数策略

规则：只影响采样的参数会被**接受并忽略**（智能体的采样由它的发布者决定）；被忽略的名字列在响应头 `X-OAA-Ignored-Params` 里。取值会改变网关要做的事、而网关满足不了的参数，会被**明确拒绝**。网关完全不认识的名字也会被拒绝，所以拼写错误（`max_token`）不会被吞掉。

| 入口 | 生效 | 接受并忽略（列在 `X-OAA-Ignored-Params`） | 拒绝 |
|---|---|---|---|
| `/v1/chat/completions` | `model`、`messages`（角色 system、developer、user、assistant；`name` 被丢弃）、`stream`、`stream_options.include_usage`、`max_tokens` / `max_completion_tokens`（只会调低智能体自己的上限）、`metadata`、`reasoning_effort`（路由提示：`high` / `xhigh` 倾向质量路线，`low` / `minimal` 倾向速度路线）、`n` = 1 | `temperature`、`top_p`、`seed`、`stop`（条数不限）、`presence_penalty`、`frequency_penalty`、`logit_bias`、`top_logprobs`、`user`、`store`、`service_tier`、`tool_choice` 为 `auto` / `none`、`parallel_tool_calls`、`verbosity`、`prompt_cache_key`、`safety_identifier`、`prediction`、厂商采样旋钮（`top_k`、`min_p`、`repeat_penalty`、`repetition_penalty`、`repeat_last_n`、`mirostat`、`mirostat_eta`、`mirostat_tau`、`tfs_z`、`typical_p`、`num_ctx`、`num_batch`、`num_keep`、`num_predict`、`keep_alive`、`think`）；无害取值：`logprobs: false`、`modalities: ["text"]`、`tools: []`、`response_format: {type: "text"}`；文本内容块上的多余键（`cache_control`）与 `stream_options` 里的多余键（`include_obfuscation`）被丢弃；可选数值字段允许 `null` | 非空的 `tools` / `functions`，`function_call` 不是 `auto` / `none`，工具结果消息与 assistant 的 `tool_calls`，`tool_choice` 为 `required` 或指定函数，`logprobs: true`，非文本 `modalities`，`response_format` 为 `json_object` / `json_schema`，`n` 大于 1，不带 `stream: true` 的 `stream_options`（与 OpenAI 一致），未知字段（`unsupported_parameter`）；内联图片、音频与未知内容块（`unsupported_content`） |
| `/v1/responses` | `model`、`input`（字符串，或带或不带 `type: "message"` 的消息项，内容块 `input_text`、`output_text`、`input_file`）、`instructions`、`stream`、`background`、`previous_response_id`、`metadata`、`max_output_tokens`、`reasoning.effort` | `temperature`、`top_p`、`top_logprobs`、`user`、`store`、`service_tier`、`truncation`、`tool_choice` 为 `auto` / `none`、`parallel_tool_calls`、`include`、`max_tool_calls`、`prompt_cache_key`、`safety_identifier`、`stream_options`、`prompt_cache_retention`、`text.format` 为 `text`、`tools: []` | 非空 `tools`、强制的 `tool_choice`、`text.format` 为 `json_object` / `json_schema`、未知字段（`unsupported_parameter`）；消息以外的输入项，如 `function_call` / `function_call_output` / `reasoning`（`unsupported_content`，`error.param` 是 `input.N`）；内联图片与音频 |
| `/v1/compat/*`、`X-OAA-Compat: true` | 上面所有，加按模式处理的 `tools`、作为指令的 `response_format` / `text.format`、工具消息 | 上面的采样类名字、`logprobs`、`n`、`tool_choice`；未知的额外字段透传 | 内联图片、音频与未知内容块（`unsupported_content`） |
| `/v1/messages` | `system`（字符串或块，全文）、`messages`、`stream`、`metadata`、`max_tokens`、按模式处理的 `tools` | `temperature`、`top_p`、`top_k`、`stop_sequences`、`tool_choice`、`thinking`、`service_tier`；较新的请求字段（`cache_control`、`inference_geo`、`speed`、`output_config`）被接受 | 内联 base64 / URL 图片与文档、未知块（`unsupported_content`） |
| `generateContent` | `contents`、`systemInstruction`、`generationConfig.maxOutputTokens`、按模式处理的 `tools` | `generationConfig` 的其余字段、`safetySettings`、`toolConfig`、`cachedContent` | `inlineData` / `fileData` 部分（`unsupported_content`） |

Gemini 的请求体可以写 camelCase 或 snake_case（`system_instruction`、`generation_config`、`parameters_json_schema` 等）；Google 的 REST 两种都接受，`google-genai` 3.3 就把工具 schema 发成 `parameters_json_schema`。不带 `models/` 的 `POST /v1beta/{agent}:generateContent` 也受理，因为 AI SDK 的 Google provider 把任何含斜杠的模型 id 都当作完整的资源名，不会再补 `models/`。

错误体保持被调用协议的形状（OpenAI 为 `{error:{code,message,type,param}}`，Claude 为 `{type:"error",error:{type,message,code}}`，Gemini 为 `{error:{code,message,status,details}}`）；网关稳定的错误码在 `error.code`（OpenAI）、`error.code`（Claude）与 `details[].reason`（Gemini）里。见 `GET /v1/errors`。

## 已知不支持

* **图片、音频与其它内联二进制内容**：返回 `400 unsupported_content`；`error.param` 指向那个内容块（例如 `messages.0.content.1`），信息说明如何上传文件并引用（`POST /v1/files`，再用 `file` / `input_file` 内容块）。图片输入计划在后续版本支持。
* **旧版补全**（`POST /v1/completions`）：Tab 自动补全与 fill-in-the-middle 在用（Continue、Zed 的编辑预测）。不提供；客户端得到普通的 404。
* **其它 OpenAI 端点**：embeddings、moderations、音频、图片、微调、assistants、`GET /v1/files` 列表、`responses/{id}/input_items`。OpenAI 形状的干净 404。
* **Anthropic**：`count_tokens` 与批处理返回 Claude 形状的 404（`not_found_error`），SDK 会抛 `NotFoundError`。
* **Gemini**：`countTokens`、`embedContent`、缓存与文件返回 404。
* **多个候选**（`n > 1`）、token 概率、强制工具选择：一次智能体运行只返回一个文本答案。
* **采样控制**：按设计忽略；由智能体的发布者决定。

## 值得知道的行为

* **客户端断开不会取消运行。** SDK 会重试超时的请求（OpenAI SDK 默认 `max_retries=2`），每次重试都会再启动一个智能体运行；被放弃的运行继续执行并占用容量（`maxActiveRuns`，默认 8）。对智能体调用请设 `max_retries=0` 和较宽裕的超时，或用 `background: true` 加 `responses.retrieve`，并用 `POST /v1/responses/{id}/cancel` 取消。失败的运行 SDK 不会重试（网关回答 `422` 加 `x-should-retry: false`）；`/v1/responses` 像 Responses API 一样，把失败的运行报告为 HTTP 200 加 `status: "failed"`。
* **流**（Chat）以 `data: [DONE]` 结束；第一个分块带 `delta.role: "assistant"`；带 `include_usage` 时，`[DONE]` 之前的最后一个分块是 `choices: []` 加用量。不报告 token 用量的智能体（例如示例智能体这样的外部智能体）产生 `usage: null`。空闲的流每 15 秒发一次 `: heartbeat` 注释帧。
* **Docker 与其它主机**：网关只回应 `allowedHosts` 里的 `Host` 名（默认 `127.0.0.1`、`localhost`、`[::1]`）。把网关当作 `host.docker.internal` 访问的容器，在这个名字被加进 `allowedHosts`、且网关监听在容器能到达的地址之前，会得到 `403 invalid_host`。这是有意的默认值；实验室不会去改它。浏览器直连的客户端需要把它们的来源加进 `allowedOrigins`；之后预检会回答浏览器要求的那些头。
* **限定了某些智能体的密钥**调用其它智能体得到 `403`（SDK 里是 `PermissionDeniedError`）；超过 `rpm` 配额的密钥得到 `429`，带 `Retry-After`。
