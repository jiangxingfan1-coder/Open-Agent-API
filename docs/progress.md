# Run progress in streams

English · [简体中文](zh-CN/progress.md)

A call to an agent is a run: it may queue, read files, call tools, wait for an approval and only
then answer. Without progress, a standard chat client shows nothing for that whole time. With stream
progress, the gateway puts a short human-readable line for each phase into the stream, **in the
protocol's own "thinking / reasoning" shape**, so a client that already shows a model's thinking
also shows what the agent is doing, with no changes on the client side.

## What a progress line says

One line per phase, from the run events that already exist (no separate event stream). Lines never
carry tool arguments, tool results, prompts, system instructions, internal identifiers (step, route
or node ids) or the names of the people who approved something. Titles pass through the gateway's
secret redaction and are cut to 120 characters. The language follows the request's
`Accept-Language`, else the process language (`OAA_LOCALE`, see [cli.md](cli.md)).

| Run event | English | 中文 |
| --- | --- | --- |
| `run.queued` (`fairness`) | Queued: taking turns with other runs for an execution slot | 排队中：与其他运行轮流使用执行名额 |
| `run.queued` (other reasons) | Queued: waiting for an execution slot | 排队中：等待执行名额 |
| `run.queued` (`approval_resolved`) | What it waited for is settled; back in the queue | 等待的事项已处理，重新排队 |
| `run.queued` (`agent_fallback`) | Switching to fallback agent `<agent>` (reason: `<code>`) | 切换到备选智能体 `<agent>`（原因：`<code>`） |
| `response.in_progress` (first / later) | Started / Resumed | 开始执行 / 继续执行 |
| `tool.queued` (kernel tool) | Calling tool `<name>` (read-only / changes data) | 调用工具 `<name>`（只读 / 会修改数据） |
| `tool.queued` (the external agent's own turn) | Handed to the agent | 交给智能体执行 |
| `tool.started` (attempt 2 and later) | Retrying tool `<name>` (attempt n) | 重试工具 `<name>`（第 n 次） |
| `tool.completed` / `tool.failed` / `tool.cached` | Tool `<name>` finished / failed (`<code>`) / used a cached result | 工具 `<name>` 完成 / 失败（`<code>`）/ 使用了缓存结果 |
| `tool.progress` from an external agent: tool call | Agent tool call: `<title>` · Done: `<title>` · Failed: `<title>` | 智能体调用工具：`<title>` · 完成：`<title>` · 失败：`<title>` |
| `tool.progress` from an external agent: thinking (said once in a row) | The agent is thinking… | 智能体正在思考… |
| `tool.progress` from an external agent: plan / permission | The agent made a plan (n steps) · An operation was not permitted and was refused · Allowed by policy: `<tool>` | 智能体制定了计划（n 步）· 一项操作未获许可，已拒绝 · 按策略自动允许：`<tool>` |
| `tool.progress` (`output_repair`, structured output) | The answer did not match the required format; sent back for correction (round n) | 答案不符合要求的格式，退回修改（第 n 轮） |
| `run.requires_action` (caller tool) | Waiting for the caller to run tool `<name>` | 等待调用方执行工具 `<name>` |
| `run.requires_action` (approval) | Waiting for approval: the owner must approve "`<tool>`" in the console | 等待审批：需要所有者在控制台批准「`<tool>`」 |
| `approval.resolved` | Approved · Approved automatically by policy · Approval denied | 审批通过 · 已按策略自动批准 · 审批被拒绝 |
| `route.failover` | Switched to a backup model route | 模型线路切换到备用线路 |
| `subagent.*` / `workflow.*` | Delegating to sub-agent `<agent>` … / Workflow `<name>` started (n steps) … | 委托子智能体 `<agent>` … / 开始工作流 `<name>`（n 步）… |
| `response.completed` (only before any answer text) | Done | 完成 |

The external agent's titles come from what each integration already reports: ACP agents report a
title per tool call (`tool_call` / `tool_call_update`), Claude Code and Antigravity report the tool
name, Codex reports the item type (`commandExecution`, `fileChange`, …). ACP
`agent_thought_chunk` text is **not** forwarded: it is the agent's own thinking, can be long and can
quote file contents or secrets, and it would have to be stored in the run's event log first; the
gateway keeps reporting only "The agent is thinking…". Those paths are tested against stand-ins, not
the real agents.

The summary is a pure function (`src/gateway/progress.ts`, `summarize(event, state, locale)`).

## The shapes on the wire

Progress never enters the answer: the non-streaming `content` / `output_text` / `text` is unchanged,
the concatenated answer deltas of a stream are byte-for-byte the non-streaming answer, and usage
counts do not include progress text.

| Protocol | Shape | Placement |
| --- | --- | --- |
| OpenAI Chat Completions | `choices[0].delta.reasoning_content` (the de facto field of DeepSeek, vLLM, SGLang and many gateways) | before and between `content` deltas |
| OpenAI Responses | one `reasoning` output item at `output_index` 0: `response.output_item.added`, `response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta` …, then `.done` and `response.output_item.done` | before the answer; every later frame's `output_index` is one higher, and response snapshots (`response.in_progress`, `response.completed`) list the item first |
| Claude Messages | a `thinking` content block at index 0 (`thinking_delta` …, then a `signature_delta` with the fixed signature `oaa-progress-v1`), closed before the text block, which becomes index 1 | before the answer; progress after the text has started is not sent |
| Gemini | parts with `"thought": true` | before and between text parts |

Examples captured from the gateway (shortened):

```text
data: {"id":"chatcmpl_run_…","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{"reasoning_content":"Calling tool list_files (read-only)\n"},"finish_reason":null}]}
data: {"id":"chatcmpl_run_…",…,"choices":[{"index":0,"delta":{"content":"The file"},"finish_reason":null}]}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","sequence_number":4,"item_id":"rs_run_…","output_index":0,"summary_index":0,"delta":"Started\n"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Started\n"}}

data: {"responseId":"run_…","modelVersion":"agent/test@fixture","candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Started\n","thought":true}]}}]}
```

Sent back by the client on the next turn, these items are ignored cleanly: Claude `thinking` blocks,
Responses `reasoning` input items and Gemini `thought` parts are dropped before the agent sees the
conversation.

## Choosing it

Per request, either the header or the metadata key, in the same style as `X-OAA-Client-Tools`
([harness.md](harness.md)):

```text
X-OAA-Progress: reasoning | off
metadata: { "oaa.progress": "reasoning" | "off" }
```

The header wins over the metadata. Unknown values count as not given. Without either, the gateway
configuration decides, per protocol:

```json
{ "streamProgress": { "chat": "off", "responses": "reasoning", "claude": "off", "gemini": "reasoning" } }
```

Those are the defaults. A reconnecting Responses stream (`GET /v1/responses/{id}?stream=true`) uses
the same rules; send the same header so that `sequence_number` and `starting_after` line up. Non-streaming
requests are unaffected; the `X-Run-ID` response header already names the run whose progress the
timeline endpoint `GET /v1/runs/{id}/timeline` returns. `/health` lists `stream-progress-v1` in
`features`.

## Why these defaults: protocol × client

A protocol is on by default when every SDK and framework that the compatibility lab runs accepts
the shape (ignores it or shows it, no errors, no change to the answer) and no replayed chat client is
known to misbehave. Live results come from `npm run compat` (each runs a `*.stream_progress` scenario
comparing the answer with progress on and off); for chat clients only Dify was checked
against its published source; the replay files assert that a default Chat stream carries no
`reasoning_content`.

| Protocol | Client | Behaviour |
| --- | --- | --- |
| Chat | openai (Node 7.57, Python 3.x) | ignores in `content`; `delta.reasoning_content` readable |
| Chat | Vercel AI SDK `@ai-sdk/openai` chat | ignores |
| Chat | Vercel AI SDK `@ai-sdk/openai-compatible` | **shows** as reasoning |
| Chat | LangChain `ChatOpenAI`, LlamaIndex `OpenAILike` | ignores |
| Chat | LiteLLM | passes `reasoning_content` through (shows) |
| Chat | OpenAI Agents SDK (chat completions model) | accepts; final output unchanged |
| Chat | Dify (OpenAI-API-compatible provider) | **problem**: wraps `reasoning_content` into the answer as `<think>…</think>` (`_wrap_thinking_by_reasoning_content` in dify-plugin-sdks) |
| Chat | Open WebUI, LobeChat, Cherry Studio, Chatbox, NextChat, LibreChat, Cline / Roo Code | known to support DeepSeek-style `reasoning_content` as a thinking section; not checked against their source here and not run |
| Chat | Cursor, Continue, Zed, n8n | not verified; expected to ignore unknown delta fields |
| Responses | openai (Node, strict output-position checks; Python) | accepts; summary events readable; `output_text` unchanged |
| Responses | Vercel AI SDK `@ai-sdk/openai` responses | **shows** as reasoning |
| Responses | OpenAI Agents SDK (responses model) | accepts; final output unchanged |
| Claude | @anthropic-ai/sdk (Node), anthropic (Python) | accepts; `thinking` events readable; echoing the block back works |
| Claude | Vercel AI SDK `@ai-sdk/anthropic` | **shows** as reasoning |
| Claude | LangChain `ChatAnthropic` | accepts, but streamed `content` becomes a list of blocks: code that joins `chunk.content` as strings breaks (use `.text`) |
| Gemini | @google/genai (Node, Python) | `.text` skips thought parts; thoughts readable |
| Gemini | Vercel AI SDK `@ai-sdk/google` | **shows** as reasoning |

So: **Chat is off** by default (Dify would put the progress into the answer; other clients that
concatenate unknown fields may too); **Responses and Gemini are on**; **Claude is off** (thinking
blocks change `content[0]` and the shape of streamed content in frameworks, carry a signature and
may be sent back; being conservative). Note for Responses: code that reads
`response.output[0]` of a streamed `response.completed` event gets the reasoning item — the same as
with OpenAI's own reasoning models; read `output_text` or the `message` item instead. Turn a
protocol on or off for your gateway with `streamProgress`, or per request with the header.

## Interaction with other features

- **Structured output** ([structured-output.md](structured-output.md)): while the answer is held back
  for checking, progress keeps flowing (including correction rounds), so the stream is no longer
  silent.
- **Caller tool bridge** ([harness.md](harness.md)): progress before the hand-off (`tool_calls`,
  `function_call`, `tool_use`, `functionCall`), and again on the resumed stream. Claude `tool_use`
  blocks follow the thinking block with consistent indexes.
- **Approvals**: the wait is announced once; heartbeats keep the connection open meanwhile. A Chat,
  Claude or Gemini stream still ends at an approval with the protocol's error; a Responses stream
  stays open and shows the decision.
- **Cancellation and failure**: the stream ends with the protocol's own error frame; progress sent
  before does not change it.
- **Images and continuation**: unaffected; progress starts fresh on every stream.
