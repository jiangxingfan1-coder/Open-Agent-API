# Compatibility

English · [简体中文](zh-CN/compatibility.md)

Open Agent API publishes an agent as an API that speaks four protocols: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Gemini `generateContent`. The caller puts the **agent name** in `model` (for example `agent/sample`). This page says which clients were actually run against the gateway, which were replayed from their recorded request shapes, which are unverified, how to configure each one, and how the gateway treats parameters it does not use.

Nothing on this page is claimed without a source: the evidence level of every client is stated, and the evidence behind a replay is in the replay file itself (`integrations/compat/replays/<client>.json`: source URL with the commit or tag that was read, and the date).

## The compatibility lab

`npm run compat` starts an isolated gateway on `127.0.0.1` (random port, temporary data directory, one generated caller key), publishes the offline sample agent plus an agent driven by a deterministic fixture model, runs every client script against it, replays the recorded request shapes, writes `matrix.json` (machine readable) and `matrix.md`, and stops the gateway. No model service is called. It needs the Python and Node packages of `integrations/compat/` (`requirements.txt`, `package-lock.json`); a client whose package is missing is reported as skipped, never as passed.

* `integrations/compat/clients/` has one script per client; each runs named scenarios and reports `pass`, `fail`, `na` (the client cannot do it by design) or `skip`.
* `integrations/compat/replays/` holds the request shapes of chat clients that cannot be installed in a test run. `test/compat-replays.test.ts` replays the same files in the ordinary offline test suite.
* `.github/workflows/compat.yml` runs the lab on every push and pull request and once a week (third-party SDKs move; the weekly run notices when one stops working). The matrix is uploaded as an artifact and written into the job summary.

## Evidence levels

### Ran against the gateway (live)

The real package ran over a real socket. Versions are what the lab last ran with.

| Client | Version | What the scenarios cover |
|---|---|---|
| `openai` (Python) | 3.51.0 | Chat and Responses: plain, streaming, `include_usage`, system/developer/history, content parts, sampling and vendor parameters, `reasoning_effort`, tool-call round trip (stream and not), `response_format`, background + `retrieve` + `cancel`, `previous_response_id`, error classes (401, 403, 404, 400, 422, 429), timeouts and retries, concurrency, image input (data URL, uploaded `file_id`, mislabelled type, text-only agent refusal) |
| `anthropic` (Python) | 2.8.0 | Messages: plain, event sequence, stream helper, every `system` form, history, sampling parameters, newer request fields, `max_tokens`, tool round trip, error classes, `models.list/retrieve`, `count_tokens` and batches, image blocks (base64; text-only agent refusal) |
| `google-genai` (Python) | 3.3.0 | `generateContent`, streaming, system instruction, chats, config parameters, JSON mime type, `MAX_TOKENS`, function calling (manual and automatic), error classes, `models.list/get`, unsupported endpoints, image `inline_data` (URL-safe base64) |
| `openai` (Node) | 7.57.0 | Chat and Responses as above, over a socket |
| `@anthropic-ai/sdk` (Node) | 1.8.0 | Messages as above |
| `@google/genai` (Node) | 3.3.0 | `generateContent`, streaming, chats, function calling, error classes, `models`, image `inlineData` |
| Vercel AI SDK | `ai` 7.0.173 | `@ai-sdk/openai` (chat and responses), `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google`: `generateText`, `streamText`, system/history/sampling settings, tool loop, image parts |
| LangChain | `langchain-openai` 1.8.0, `langchain-anthropic` 1.7.10 | `invoke`, `stream`, history, sampling, tool round trip, structured output, Responses API mode, image content blocks |
| LiteLLM (library) | 1.109.1 | `openai/`, `anthropic/` and `gemini/` custom endpoints, `responses()`, tools, error mapping |
| OpenAI Agents SDK (Python) | 0.24.0 | The gateway agent as the SDK agent's model, through `OpenAIResponsesModel` and `OpenAIChatCompletionsModel`: `run`, `run_streamed`, model settings, function tools |
| LlamaIndex | `llama-index-core` 0.14.26, `llama-index-llms-openai-like` 0.9.0 | `OpenAILike`: `complete`, `chat`, streaming, tools. The plain `OpenAI` class rejects the agent name on the client side (see below) |

### Replayed from recorded request shapes

These clients cannot be installed in a test run. Their source (or official documentation) was read, the request each one sends to a custom OpenAI-compatible endpoint was recorded with its source, and the lab replays it against the gateway and checks the response against what the client's own code relies on (fields it reads, whether it needs `delta.role` in the first chunk, how it treats the `usage` chunk, ...). A replay shows that the gateway accepts the request and answers in a form the client parses; it does not show that the application as a whole works.

| Client | Version read | Source evidence | Cases (verified / inferred / unverified) |
|---|---|---|---|
| Open WebUI | v0.13.3 | verified | 11 / 1 / 0 |
| LibreChat | v0.8.8 | partial (request body derived from the LangChain source it uses) | 2 / 7 / 1 |
| Chatbox | v1.24.4 | verified | 9 / 4 / 0 |
| Cherry Studio | v2.2.2 | verified | 5 / 5 / 1 |
| LobeChat | v2.3.3 | partial | 4 / 8 / 0 |
| NextChat | main@1d3dc33 (last release v2.16.1) | verified | 10 / 0 / 0 |
| Dify (OpenAI-API-compatible plugin) | plugin 0.0.83, SDK 0.10.2 | verified | 10 / 3 / 0 |
| n8n (OpenAI credential / Chat Model) | 2.47.7 | verified | 10 / 4 / 0 |
| Continue | main@5522c6f (latest releases v2.0.0-vscode and v2.1.0-vscode, a pre-release) | verified | 11 / 1 / 0 |
| Cline | main@72b3d71 (release 4.1.26) | verified | shared file with Roo Code: 11 / 3 / 0 |
| Roo Code | b867ec9 (archived 2026-05-15) | verified | (same file) |
| Zed | main@f0fa51b (rolling main; no release tag was read) | verified | 7 / 2 / 0 |

"verified" means the case was derived from the client source at the stated revision; "inferred" means derived from a library the client uses or from documented defaults; "unverified" means no reliable source was found and the case is a protocol skeleton.

### Unverified

* **Cursor** (closed source): only two skeleton cases, both unverified. Cursor sends the request from its own servers, so a `localhost` URL is not reachable; a public HTTPS URL is needed. Official documentation does not say whether the Base URL includes `/v1`.
* Browser behaviour of the web builds (Chatbox web, NextChat custom endpoint, LobeChat client request mode) is replayed as CORS preflights only; no real browser was driven.
* The tool-calling behaviour of coding agents (Cline, Roo Code, Continue agent mode, Zed agent) is replayed as request shapes. The real extensions were not run against a bridged agent.

## Configure a client

Replace `http://127.0.0.1:8787` with your gateway address. The API key is a caller key (`sk-oaa-...`); the model name is the agent name exactly as `GET /v1/models` lists it (for example `agent/sample`).

| Protocol | Base URL | Notes |
|---|---|---|
| OpenAI (Chat Completions, Responses) | `http://127.0.0.1:8787/v1` | the client appends `/chat/completions`, `/responses`, `/models` |
| OpenAI, when the caller wants to force how its tools are handled | `http://127.0.0.1:8787/v1/compat` | only needed to keep older behaviour; see "Caller tools" |
| Anthropic | `http://127.0.0.1:8787` | the SDK appends `/v1/messages`; key as `x-api-key` or `Authorization: Bearer` |
| Gemini | `http://127.0.0.1:8787` with API version `v1beta` or `v1` | key as `x-goog-api-key` or `?key=` |

A wrong Base URL is the most common cause of a 404. The gateway now ignores a trailing slash and doubled slashes (`/v1//chat/completions`), and its 404 says what is probably wrong: a missing `/v1` (`POST /chat/completions`) or a doubled one (`/v1/v1/chat/completions`, a client that already adds `/v1`).

### Chat clients

| Client | Where | Base URL | Model | Notes |
|---|---|---|---|---|
| Open WebUI | Admin Settings > Connections > OpenAI | `http://<host>:8787/v1` | listed from `/models`, or add the agent name under Model IDs (Filter) | Besides the chat it sends title, tag and follow-up requests to the same agent, so each new chat runs the agent more than once; switch those off in Settings > Interface if each run is expensive. Custom "Advanced Params" (`top_k`, `min_p`, `repeat_penalty`, `num_ctx`, `think`, ...) are accepted and ignored; the Ollama `format` parameter (JSON mode) is refused explicitly. In Docker use a host name the container can reach and allow it in `allowedHosts` (below). |
| LibreChat | `librechat.yaml`, `endpoints.custom[]` | `baseURL: "http://<host>:8787/v1"` | `models.default: ["agent/sample"]`, or `models.fetch: true` | Sends `user` on every request (accepted). Set `titleConvo: false` unless you want an extra agent run per conversation. |
| Chatbox | Provider > API Host | `http://<host>:8787/v1` | add the agent name, or fetch models | Type the `http://` prefix; without it the client assumes `https://`. The API Path stays `/chat/completions`. The web build calls the gateway from the browser: add its origin to `allowedOrigins`. |
| Cherry Studio | Model Provider > Add > type OpenAI > API Host | `http://<host>:8787` or `.../v1` (both work; a trailing `#` uses the host verbatim) | add manually or fetch | Requests come from the Electron main process (no CORS). The Check button and auto-naming send non-streaming requests without `max_tokens`. |
| LobeChat | AI Service Provider > OpenAI (or a custom provider, format OpenAI) > API Proxy URL | `http://<host>:8787/v1` | fetch models or add by hand | Keep the provider's "Responses API" switch off unless needed. LobeChat hides models whose id contains words such as `embedding`, `tts`, `whisper`, `ada`, `davinci` (so an agent named `agent/adapter` disappears from the list: rename it). "Client request mode" calls the gateway from the browser: add the origin to `allowedOrigins`. |
| NextChat | Settings > Custom Endpoint > OpenAI Endpoint | `http://<host>:8787` **without `/v1`** | Settings > Custom Models: `agent/sample` | NextChat adds `v1/chat/completions` itself (`.../v1` becomes `/v1/v1/...`) and never lists remote models. Model names that match its vision patterns (`vision`, `vl`, `gpt-4o`, `o3`, ...) get `max_tokens: 4000` added. |
| Dify | Model Provider > OpenAI-API-compatible > Add Model | `http://host.docker.internal:8787/v1` when Dify runs in Docker | Model Name = agent name | Dify never calls `/models`. Its stream parser needs every chunk to have a `choices` array (the gateway's usage chunk has `choices: []`) and ignores `:` comment frames. |
| n8n | Credentials > OpenAI | Base URL `http://<host>:8787/v1` | OpenAI Chat Model: "By ID" or "From List" | The credential Test button calls `GET /v1/models`. The node's "Use Responses API" mode (default on in new versions) and its Chat Completions mode are both built on LangChain; LangChain's two modes work against the gateway in the lab, and the n8n request shapes are replayed. An AI Agent node that attaches tools works with the same Base URL when the agent can take the tools over (below); otherwise it gets the clear refusal. |
| Continue | `config.yaml`, `models[]` | `apiBase: http://<host>:8787/v1` | `model: agent/sample` | Add `capabilities: [tool_use]` to let Agent mode send tools: with a kernel or ACP agent they are handed to the agent, on the same Base URL. Tab autocomplete uses `POST /v1/completions` by default, which the gateway does not serve: keep autocomplete on another model, or set `useLegacyCompletionsEndpoint: false` to send it as chat. |
| Cline / Roo Code | API Provider "OpenAI Compatible" | `http://<host>:8787/v1` | the agent name | Both always send `tools`. With a kernel or ACP agent the same Base URL works and the tools are handed to the agent (`X-OAA-Client-Tools: bridge` in the response); an agent that cannot take them over (a native engine) gets a clear 400 that names the way out. Roo Code is archived upstream. |
| Zed | `settings.json`, `language_models.openai_compatible.<name>` | `api_url: "http://<host>:8787/v1"` | `available_models[].name: "agent/sample"` | Zed never calls `/models`, so models are listed by hand. Its agent profile sends `tools`; with a kernel or ACP agent they are handed to the agent, on the same Base URL. |
| Cursor | Settings > Models > Override OpenAI Base URL | public HTTPS URL, with `/v1` (unverified) | custom model name | Unverified, see above. |

### SDKs and frameworks

| Package | Configuration |
|---|---|
| `openai` | `OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=...)`, `model="agent/sample"` |
| `anthropic` | `Anthropic(base_url="http://127.0.0.1:8787", api_key=...)` |
| `google-genai` | `genai.Client(api_key=..., http_options=types.HttpOptions(base_url="http://127.0.0.1:8787", api_version="v1beta"))` |
| Vercel AI SDK | `createOpenAI({ baseURL: ".../v1" })` (`.chat()` and `.responses()` both work), `createOpenAICompatible({ name, baseURL: ".../v1" })`, `createAnthropic({ baseURL: ".../v1" })`, `createGoogleGenerativeAI({ baseURL: ".../v1beta" })`; the agent name goes in as the model id unchanged |
| LangChain | `ChatOpenAI(model=..., base_url=".../v1", stream_usage=True)` (with a custom `base_url` LangChain does not request streamed usage on its own), `ChatAnthropic(model=..., anthropic_api_url="http://127.0.0.1:8787")` |
| LiteLLM | `litellm.completion(model="openai/agent/sample", api_base=".../v1")`; also `anthropic/agent/sample` with `api_base="http://127.0.0.1:8787"` and `gemini/agent/sample` with `api_base=".../v1beta"` |
| OpenAI Agents SDK | `Agent(model=OpenAIResponsesModel(model="agent/sample", openai_client=AsyncOpenAI(base_url=".../v1", api_key=...)))` or `OpenAIChatCompletionsModel(...)`. Call `set_tracing_disabled(True)`, otherwise the SDK uploads traces to OpenAI. Function tools work on the ordinary Base URL when the agent can take them over (see "Caller tools" below) |
| LlamaIndex | `OpenAILike(model="agent/sample", api_base=".../v1", api_key=..., is_chat_model=True)`. The `OpenAI` class checks the model name against OpenAI's list before any request and refuses the agent name |

## Caller tools

A request that declares `tools` and chooses no mode is handled as `auto` (docs/harness.md):

* An agent that can take the tools over (a kernel agent, Codex, Claude Code, Antigravity ACP, or an ACP adapter) gets them: its calls come back as `tool_calls` / `function_call` / `tool_use` / `functionCall`, the run continues from your results, and the response carries `X-OAA-Client-Tools: bridge`. This is what coding agents and agent frameworks (Cline, Roo Code, Continue, Zed, the OpenAI Agents SDK, LangChain, the Vercel AI SDK, ...) need, on the ordinary Base URL, without a header.
* An agent that cannot (DSH, A2A, HTTP adapters) behaves as before. OpenAI's default endpoints refuse with `400 unsupported_parameter` (`error.param` `tools`; the message gives the reason and the three ways out: the Base URL `http://<host>:8787/v1/compat`, `X-OAA-Compat: true`, `X-OAA-Client-Tools: managed`); the compat endpoints, Claude and Gemini let the agent finish with its own tools (`X-OAA-Client-Tools: ignored`).
* Tool choice (`tool_choice` `auto` / `none` / `required` / a named function, Claude `tool_choice`, and Gemini `toolConfig.functionCallingConfig`) is honoured: `none` withholds caller tools for the turn; forced choices push down natively to kernel model drivers (converging back to `auto` on continuation) and enforce prompt + 1-round continuation repair on bridged external agents (failing with `422 tool_choice_unmet` if unmet, or `400 client_tools_unsupported` when `managed` / unbridgeable).
* `X-OAA-Client-Tools: managed | bridge | reject | auto` (or `metadata["oaa.client_tools"]`) chooses explicitly and is never overridden; the gateway setting `clientTools.default` changes what a request that chooses nothing gets.

## Structured output

`response_format` (`json_object`, `json_schema`), Responses `text.format`, Gemini `responseMimeType: "application/json"` with `responseSchema` / `responseJsonSchema`, and Claude `output_config.format` are a contract: compatible schemas push down natively to the model drivers (with automatic fallback to prompt + Ajv when outside a provider's strict subset), a successful response is JSON that parses and fits the schema, and a wrong answer is sent back for correction or fails with `structured_output_invalid` (422). Streams hold until checked (or stream deltas directly when a kernel route uses strict native pushdown with `maxRepairs === 0`, asserting Ajv at completion). Both JSON-schema helpers and forced-tool-call helpers (LangChain `method="function_calling"`, `@ai-sdk/anthropic` `jsonTool`) are supported. Details: [structured-output.md](structured-output.md).

## Stream progress

Streams can show what the agent is doing in each protocol's thinking / reasoning shape (Chat `reasoning_content`, Responses `reasoning` item, Claude `thinking` block, Gemini `thought` parts) without changing the answer. Every live client runs a `*.stream_progress` scenario (same answer on and off, progress readable where the SDK exposes it). By default Responses and Gemini are on; Chat is off because Dify folds `reasoning_content` into the answer as `<think>…</think>`, and Claude is off as a precaution (thinking blocks change `content[0]` and LangChain's streamed content shape). Turn it on per request with `X-OAA-Progress: reasoning`. The full protocol × client table: [progress.md](progress.md).

## Parameter policy

Rule: parameters that only influence sampling are **accepted and ignored** (an agent's sampling is decided by its publisher); the names that were ignored are listed in the response header `X-OAA-Ignored-Params`. Parameters whose value changes what the gateway has to do, and that it cannot satisfy, are **refused** with a clear error. A name the gateway does not know at all is refused too, so a typo (`max_token`) is not swallowed.

| Endpoint | Applied | Accepted and ignored (listed in `X-OAA-Ignored-Params`) | Refused |
|---|---|---|---|
| `/v1/chat/completions` | `model`, `messages` (roles system, developer, user, assistant; `name` is dropped), `stream`, `stream_options.include_usage`, `max_tokens` / `max_completion_tokens` (only lowers the agent's own limit), `metadata`, `reasoning_effort` (routing hint: `high`/`xhigh` prefer the quality route, `low`/`minimal` the speed route), `tools`, `tool_choice` (`auto`/`none`/`required`/named function), and tool messages (mode `auto`), `response_format` (structured output), `n` = 1 | `temperature`, `top_p`, `seed`, `stop` (any number of entries), `presence_penalty`, `frequency_penalty`, `logit_bias`, `top_logprobs`, `user`, `store`, `service_tier`, `parallel_tool_calls`, `verbosity`, `prompt_cache_key`, `safety_identifier`, `prediction`, vendor sampling knobs (`top_k`, `min_p`, `repeat_penalty`, `repetition_penalty`, `repeat_last_n`, `mirostat`, `mirostat_eta`, `mirostat_tau`, `tfs_z`, `typical_p`, `num_ctx`, `num_batch`, `num_keep`, `num_predict`, `keep_alive`, `think`); harmless values: `logprobs: false`, `modalities: ["text"]`, `tools: []`, `response_format: {type: "text"}`; extra keys on text content parts (`cache_control`) and in `stream_options` (`include_obfuscation`) are dropped; `null` for an optional number | `functions` / `function_call` other than `auto`/`none` (legacy), invalid/unbridgeable forced `tool_choice` (`invalid_request` / `client_tools_unsupported`), `logprobs: true`, non-text `modalities`, `n` greater than 1, `stream_options` without `stream: true` (as OpenAI does), unknown fields (`unsupported_parameter`); audio and unknown content parts (`unsupported_content`); `image_url` parts are accepted ([images.md](images.md)) |
| `/v1/responses` | `model`, `input` (string or message items with or without `type: "message"`, parts `input_text`, `output_text`, `input_file`), `instructions`, `stream`, `background`, `previous_response_id`, `metadata`, `max_output_tokens`, `reasoning.effort`, `tools`, `tool_choice` (`auto`/`none`/`required`/named function), and their calls and results (mode `auto`), `text.format` (structured output) | `temperature`, `top_p`, `top_logprobs`, `user`, `store`, `service_tier`, `truncation`, `parallel_tool_calls`, `include`, `max_tool_calls`, `prompt_cache_key`, `safety_identifier`, `stream_options`, `prompt_cache_retention`, `text.format` `text`, `tools: []` | invalid/unbridgeable forced `tool_choice`, unknown fields (`unsupported_parameter`); input items other than messages and tool items, such as `reasoning` (`unsupported_content`, `error.param` is `input.N`); audio (`input_image` is accepted, [images.md](images.md)) |
| `/v1/compat/*`, `X-OAA-Compat: true` | everything above, plus `tools` and `tool_choice` by mode, `response_format` / `text.format` (structured output), tool messages | the sampling names above, `logprobs`, `n`; unknown extra fields pass through | audio and unknown content parts (`unsupported_content`) |
| `/v1/messages` | `system` (string or blocks, in full), `messages`, `stream`, `metadata`, `max_tokens`, `tools` and `tool_choice` by mode, `output_config.format` (structured output) | `temperature`, `top_p`, `top_k`, `stop_sequences`, `thinking`, `service_tier`; newer request fields (`cache_control`, `inference_geo`, `speed`, `output_config`) are accepted | inline base64/URL documents, unknown blocks (`unsupported_content`); `image` blocks are accepted ([images.md](images.md)) |
| `generateContent` | `contents`, `systemInstruction`, `generationConfig.maxOutputTokens`, `responseMimeType` / `responseSchema` / `responseJsonSchema` (structured output), `tools` and `toolConfig.functionCallingConfig` by mode | the other `generationConfig` fields, `safetySettings`, non-function `toolConfig` fields, `cachedContent` | `inlineData` that is not an image (`unsupported_content`); image `inlineData` / `fileData` are accepted ([images.md](images.md)) |

Gemini bodies may be written in camelCase or snake_case (`system_instruction`, `generation_config`, `parameters_json_schema`, ...); Google's REST accepts both, and `google-genai` 3.3 sends tool schemas as `parameters_json_schema`. `POST /v1beta/{agent}:generateContent` (without `models/`) is accepted because the AI SDK Google provider treats any model id that contains a slash as a full resource name.

Error bodies keep the shape of the protocol that was called (OpenAI `{error:{code,message,type,param}}`, Claude `{type:"error",error:{type,message,code}}`, Gemini `{error:{code,message,status,details}}`); the gateway's stable code is in `error.code` (OpenAI), `error.code` (Claude) and `details[].reason` (Gemini). See `GET /v1/errors`.

## Known unsupported

* **Audio and other non-image inline binary parts**: refused with `400 unsupported_content`; `error.param` points at the part (for example `messages.0.content.1`) and the message tells how to upload the file and reference it (`POST /v1/files`, then a `file` / `input_file` part). Images are accepted on every entry; an agent that cannot take them refuses with `unsupported_content` before a run exists ([images.md](images.md)).
* **Legacy completions** (`POST /v1/completions`): used by tab autocomplete and fill-in-the-middle (Continue, Zed edit prediction). Not served; the client gets an ordinary 404.
* **Other OpenAI endpoints**: embeddings, moderations, audio, images, fine-tuning, assistants, `GET /v1/files` listing, `responses/{id}/input_items`. A clean 404 in the OpenAI shape.
* **Anthropic**: `count_tokens` and batches answer a Claude-shaped 404 (`not_found_error`), which the SDKs raise as `NotFoundError`.
* **Gemini**: `countTokens`, `embedContent`, caches and files answer 404.
* **Several choices** (`n > 1`), token probabilities, forced tool choice: an agent run returns one text answer, and the agent decides which tool to call.
* **Sampling control**: ignored by design; the publisher of the agent decides.

## Behaviours worth knowing

* **A disconnected client does not cancel the run.** The SDKs retry a timed-out request (OpenAI SDKs: `max_retries=2` by default) and every retry starts another run of the agent; the abandoned runs keep executing and use capacity (`maxActiveRuns`, default 8). Set `max_retries=0` and a generous timeout on agent calls, or use `background: true` with `responses.retrieve`, and cancel with `POST /v1/responses/{id}/cancel`. Failed runs are not retried by the SDKs (the gateway answers `422` with `x-should-retry: false`); `/v1/responses` reports a failed run as HTTP 200 with `status: "failed"`, like the Responses API.
* **Retry safely with an `Idempotency-Key`.** Every entry (Chat, Responses, Claude Messages, Gemini, the `/v1/compat/*` entries and `POST /v1/invoke`) honours the `Idempotency-Key` header: a repeated request with the same key and input attaches to the run that already exists instead of starting another (same `X-Run-ID`); the same key with different input is `409 idempotency_conflict`. Send one key per logical task and repeat it on every retry ([protocol.md](protocol.md#compatibility-endpoint-parameters-errors-and-finish-reasons-060)); the cookbook's [errors and retries](../examples/cookbook/07-errors-and-retries/) examples do this.
* **What cancelling leaves behind.** A built-in agent ends `cancelled`. An external agent (ACP, Codex, Claude Code, ...) cancelled after it started ends `interrupted` with `effect_outcome_unknown` (the Responses entry shows `status: "incomplete"`, `incomplete_details.reason: "effect_outcome_unknown"`; Chat, Claude and Gemini answer 422), because its side effects cannot be ruled out; one cancelled before it started ends `cancelled`. Treat both as normal outcomes and check for side effects in the second case.
* **Streams** end with `data: [DONE]` (Chat); the first chunk carries `delta.role: "assistant"`; with `include_usage` the last chunk before `[DONE]` has `choices: []` and the usage. Agents that report no token usage (external agents such as the sample agent) produce `usage: null`. A `: heartbeat` comment frame is sent every 15 seconds on idle streams.
* **Docker and other hosts**: the gateway answers only the `Host` names in `allowedHosts` (default `127.0.0.1`, `localhost`, `[::1]`). A container that reaches the gateway as `host.docker.internal` gets `403 invalid_host` until that name is added to `allowedHosts` and the gateway listens on an address the container can reach. That is a deliberate default; the lab does not change it. Browser-direct clients need their origin in `allowedOrigins`; the preflight then answers exactly the headers the browser asks for.
* **A key restricted to some agents** gets `403` (`PermissionDeniedError` in the SDKs) for the others; a key over its `rpm` quota gets `429` with `Retry-After`.
