# 结构化输出

[English](../structured-output.md) · 简体中文

调用方要求了结构，成功的响应就意味着答案**就是**那个结构：能解析、合乎 schema 的 JSON。网关做不到，运行就带着清楚的错误失败，而不是返回一段只是看上去像的文本。本页是确切的契约；用官方 SDK 的辅助函数检查它的实验室见 [compatibility.md](compatibility.md)。

## 怎么要求

| 入口 | 字段 | 写法 |
|---|---|---|
| Chat Completions（`/v1/chat/completions`、`/v1/compat/chat/completions`） | `response_format` | `{"type":"json_object"}`；`{"type":"json_schema","json_schema":{"name","schema","strict"}}` |
| Responses（`/v1/responses`、`/v1/compat/responses`） | `text.format` | `{"type":"json_object"}`；`{"type":"json_schema","name","schema","strict"}` |
| Gemini `generateContent` | `generationConfig.responseMimeType: "application/json"` | 加 `responseSchema`（SDK 发的 OpenAPI 子集，类型大写）、加 `responseJsonSchema`（普通 JSON Schema），或单独用（任意 JSON） |
| Claude Messages | `output_config.format` | `{"type":"json_schema","schema":{...}}`（官方 SDK 的字段，TypeScript 1.3 与 Python 2.8 都有） |

`text` / `text/plain` 格式表示没有契约，和以前一样。Gemini 的 `text/x.enum` 被拒绝（`invalid_request`）。两个 OpenAI 端点都接受这些字段，默认端点不再拒绝它们。`strict` 会被记录并回显，但对检查没有额外作用：被强制的是 schema 本身，想要 `required` 和 `additionalProperties: false` 就写进 schema 里。

## 网关保证什么

1. **智能体工作期间，答案先扣着。** 一次可能事后被判错的尝试，不会写进运行的输出，也不会发给任何流。
2. **最终答案会被解开包装、解析、校验。** 代码围栏、JSON 前后的一句话、空白都不算答案：网关先取整段文本，不行就取代码块，再不行就取最外层的花括号或方括号，用第一个能解析成 JSON 的形式。`json_object` 要求是 JSON 对象；`json_schema` 用 Ajv 校验（draft-07、2019-09 与 2020-12；`format` 通过 ajv-formats 强制，MCP SDK 本来就带着它）。
3. **合格的答案以规范化的形式返回**：紧凑的 JSON，没有围栏，没有解释，一次性写出。Chat 是 `message.content`；Responses 是输出文本，响应的 `text.format` 回显你的格式对象；Claude 是文本块；Gemini 是文本 part。
4. **不合格的答案送回去修正**（见下）。几轮之后仍不合格：运行以 `structured_output_invalid` 失败（Chat、Claude、Gemini 是 HTTP 422 加 `x-should-retry: false`；Responses 与所有失败的运行一样，是带错误码的 `failed` 响应）。信息点出第一个问题，从不引用答案本身。
5. **无法如实强制的 schema 在请求到达时就被拒绝**（见下）；不创建运行。

## 修正轮

* **内核智能体**：不合格的答案留在对话里，后面跟一条 user 消息（以 `[Structured output repair]` 开头，点明问题、附一份缩短的答案副本，要求只回修正后的 JSON）。模型多跑一个回合；回合数与 token 用量和其它回合一样计入。
* **外部智能体**（ACP、Codex、Claude Code、Antigravity）：只有会话能续接时才重问，因为再问一次不能把活重做一遍：声明了 `loadSession` / `resumeSession` 的 ACP 智能体，或返回了会话 / 线程句柄的原生引擎。提示发到同一个会话，是单独的一步；用量累加。A2A 与 HTTP 适配器，以及不能加载会话的 ACP 智能体，**不会**被重问：运行失败，信息里会说明。
* **几次**：网关设置 `structuredOutput.maxRepairs`（0 到 3，缺省 1）。`0` 表示第一次不合格就失败。已经用掉的次数记在运行里，所以审批后或重启后恢复的运行不会从头计。
* 运行里写有 `metadata["oaa.output_contract"]`（`json_object`、`json_any` 或 `json_schema`）与 `metadata["oaa.output_repairs"]`；控制台的任务检查器把两者显示在用量旁边，`GET /v1/runs/{id}/state` 有 `output_contract: {kind, repairs}`。

## 请求时就拒绝的情形

| 错误码 | 什么时候 |
|---|---|
| `invalid_schema`（400） | schema 缺失、超过 64 KiB，或编译不过 |
| `schema_dialect_unsupported`（400） | `$schema` 不是 draft-07、2019-09 或 2020-12；`$async` |
| `output_schema_unsupported`（400） | Ajv 会悄悄跳过、或可能伤到网关的内容：指向文档之外的 `$ref`、没人实现的 `format`（ajv-formats 的标准名字都会被强制）、超过 256 个字符或带嵌套量词（如 `(a+)+`）的 `pattern` 或 `patternProperties` 键、超过 40 层的嵌套 |
| `invalid_request`（400） | `response_format.type`、`text.format.type` 或 `responseMimeType` 不是支持的取值，`json_schema` 没带 schema |

`error.param` 点明问题所在的字段（例如 `response_format.json_schema.schema`）。没有「尽量校验」这回事：不被强制的契约比没有契约更糟。

## 流式

默认情况下（当 `structuredOutput.maxRepairs > 0`，或该 schema 未作为严格原生 schema 下推时），流式请求会在生成期间暂存答案，避免一旦需要静默修复而把错误片段提前发给客户端：校验通过后再把最终 JSON 作为**一个**文本分块按协议标准序列发出（等待期间每 15 秒发送 `: heartbeat` 保活；校验失败则以协议错误帧结束且此前无正文）。当内核路由已将兼容的严格 `json_schema` 原生下推给上游模型驱动且 `structuredOutput.maxRepairs === 0` 时，token 增量直接流式直出，并在收尾时仍经 Ajv 做最终断言。不便长连时可改用非流式或 `background: true`。

## 与其它功能的关系

* **调用方工具（桥接）**：先走工具回合，只检查最后的答案。工具调用之前的文本不算输出。契约属于这次运行，所以回传工具结果的后续请求，在同一个契约下继续同一个运行。
* **审批、恢复、重启**：运行照常等待；契约与已用掉的修正次数在它的检查点里。
* **取消**：运行以 `cancelled` 结束，没有输出。
* **截断**（达到 `max_tokens` / `max_output_tokens`）：运行和以前一样以 `incomplete` 结束，没有输出，因为被截断的答案没法检查。
* **备选智能体**（`oaa.agent_fallback`）照旧；它们在任何输出出现之前生效。
* 智能体**已发布的 `outputSchema`** 在调用方的契约之后仍然生效；不合格的话和以前一样是 `output_contract`。

## 原生下推与边界

* **原生 Schema 下推与平滑降级**：对内核智能体，兼容的输出契约会在最终回答轮次原生下推至四大模型驱动（OpenAI Chat 的 `response_format`、OpenAI Responses 的 `text.format`、Anthropic Messages 的 `output_config.format`、Gemini 的 `generationConfig.responseMimeType = "application/json"` 加 `responseSchema` / `responseJsonSchema`；当首轮同时存在强制调用方工具时，工具轮优先执行 `toolChoice`，最终文本轮再生效 `outputContract`）。超出某厂商严格子集的 schema（如 strict 模式不支持的自由对象）会自动平滑降级为提示词约束加网关 Ajv 校验，不会因上游挑剔而报 400。
* `json_object` 只接受对象；顶层是数组要用 `json_schema`（或 Gemini 的普通 JSON mime 类型）。
* `strict` 在兼容的原生 `json_schema` 下推时一并透传并回显；网关侧始终对 schema 本身做完整校验。
* **强制工具调用（`tool_choice`）**：靠强制工具调用提取结构的调用方（例如 LangChain 的 `with_structured_output(method="function_calling")` 或 `jsonTool` 模式的 `@ai-sdk/anthropic`）在支持桥接的智能体（`kernel`、`codex`、`claude`、Antigravity ACP 与 ACP 适配器，见 [harness.md](harness.md)）上已受支持：内核驱动首轮原生下推 `tool_choice` 并在续接轮自动收敛回 `auto`；外部桥接智能体注入必调约束并在未命中时执行最多 1 轮会话续接纠正（仍未调用则返回 422 `tool_choice_unmet`）。

## 示例

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $OAA_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "agent/sample",
    "messages": [{"role": "user", "content": "谁写了《哈姆雷特》？用 JSON 回答。"}],
    "response_format": {"type": "json_schema", "json_schema": {
      "name": "author", "strict": true,
      "schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"], "additionalProperties": false}}}
  }'
```

官方 SDK 的辅助函数原样可用：`client.chat.completions.parse(..., response_format=Model)` 与 `client.responses.parse(..., text_format=Model)`（OpenAI），`messages.parse(..., output_format=Model)`（Anthropic），`response_schema=Model` 加 `response_mime_type="application/json"`（Gemini），`generateObject`（Vercel AI SDK），`with_structured_output(Model, method="json_schema")`（LangChain）。
