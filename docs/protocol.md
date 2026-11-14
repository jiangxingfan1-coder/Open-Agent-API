# OAA/1 Contract

English · [简体中文](zh-CN/protocol.md)

## Identity and authorization

An invocation resolves `agent -> immutable bundle -> published model route -> eligible worker`. Callers receive a response ID, not an upstream credential. API keys carry an owner, allowed agent IDs, and scopes: `read`, `invoke`, `files`, `approve`, `admin`, `billing` (developer platform only: credit accounts and look them up by email, see [Developer platform](#developer-platform)). Node credentials are separate and cannot call the application API.

`POST /v1/invoke` accepts `protocol: "oaa/1"`, `agent`, `model` (`auto`, route ID, or published model name), text `input`, optional `file_ids`, `previous_response_id`, `stream`, `background`, and string-valued `metadata`. Unknown fields are rejected. `Idempotency-Key` binds the normalized request to a single response; different input with the same key returns 409.

### Caller data isolation (schema v4, 2026-11-08)

Every API key under the same owner has its own data partition, the `subject`, which defaults to the key ID. A subagent run inherits the subject of its parent run. The following data is isolated by subject:

- Runs: listing, reading, event streams, timelines, steps, artifacts, cancellation, resume (`resume`), approvals, reconciliation, and `previous_response_id`.
- Files: uploaded files and run artifacts.
- Memory: the `/v1/memory` endpoints and the agent's `memory_read` / `memory_write` tools.
- `Idempotency-Key`: two callers that use the same key each get their own run.
- Overview metrics and the activity pulse.

A run or file outside the caller's own partition always returns 404 (`run_not_found` / `file_not_found`) and never reveals whether it exists.

**Who can see the data of all callers**

- A key with the `admin` scope, still limited to the agents it is authorized for.
- A key created with `POST /v1/keys` and `"data_scope": "owner"`, for example a read-only monitoring dashboard. For keys defined in the configuration file, use `dataScope: "owner"`.

New keys default to `"data_scope": "own"`. Keys created by older versions have no such field and are treated as `own` after the upgrade: **a non-admin read-only key that used to be able to view other callers' runs must be recreated with `data_scope: "owner"` after upgrading.**

**Memory is stricter.** Memory is not partitioned by agent, so only an owner-level admin (the `admin` scope with `agents: ["*"]`) can read or write another subject's memory through the `subject` parameter, including the `legacy` partition. Any other key that passes another subject gets 403.

**Limit**: in addition to the owner-wide cap (32 unfinished requests), the gateway setting `maxActiveRunsPerSubject` can limit each caller separately. It is unlimited by default; setting it is recommended when you hand out keys to others.

**Upgrade migration**: v3 to v4 runs inside the startup transaction. Before migrating, the database is copied to `<dataDir>/backups/state-v3-before-subjects-<timestamp>.sqlite`, and startup stops if the copy fails. Existing data is assigned as follows:

- Runs: by the key recorded at submission; a subagent run follows its parent run chain.
- Artifacts: follow their run.
- Uploaded files: if every run that uses a file belongs to the same caller, the file belongs to that caller.
- Memory: follows the run when there is a corresponding run.
- Everything else goes into the `legacy` partition, visible only to admins.

An older gateway cannot open a v4 database (it returns `schema_too_new`). To roll back, restore the backup file above.

### Separating the admin plane from the API domain (2026-11-08)

The gateway setting `consoleHosts` lists the hostnames of the admin plane, for example `["console.example.com"]`. Every entry must already be covered by `allowedHosts`, otherwise loading the configuration fails. A wildcard entry (`*.example.com`) requires the identical wildcard entry in `allowedHosts`.

With `consoleHosts` configured:

- The console page and its static assets (`/`, `/console.js`, `/agents/*.svg`, and so on) are served only on these hostnames. On any other hostname they return 404 `route_not_found`, as if the routes did not exist.
- A key with the `admin` scope works only on these hostnames. On any other hostname every endpoint returns 403 `admin_host_denied`, including requests from the MCP bridge and the CLI. So the public API domain accepts caller keys only; publishing, key management, and node management all go through the console domain.
- Caller keys are unaffected and work on any allowed hostname. A worker's `/v1/nodes/connect` uses its own node credential and is also unaffected.

Without `consoleHosts`, behavior is exactly as before. The local desktop app does not configure it by default.

The check is based on the request's `Host` header. A reverse proxy must forward Host unchanged: Caddy does this by default; Nginx needs `proxy_set_header Host $host`.

### Execution levels (P1, 2026-11-08)

Every published agent has a **required execution level**, computed automatically from its engine and tool bindings; publishers do not declare it:

| Level | Which agents | Meaning |
|---|---|---|
| `workspace` | The `kernel` engine using only built-in tools (`read_file`, `write_file`, `list_files`, `read_skill`, `memory_*`) | A model loop plus file and memory tools confined to the session workspace |
| `host` | Native agents (Codex, Claude, Antigravity, DSH), any adapter (including ACP and A2A), and kernel agents with `script` or `node` tools | Runs with the permissions of the worker's host machine |

Every API key has a **maximum allowed level**, `execution`:

- A key with the `admin` scope is always `host`.
- `POST /v1/keys` can pass `"execution": "workspace" | "host"` explicitly. When omitted, the value of the gateway setting `defaultKeyExecution` applies; its default is `host`, the same as before P1. For public deployments, set `defaultKeyExecution` to `workspace`.
- Keys in the configuration file use the `execution` field and default to `host`.
- Keys created by older versions without this field are treated as `host`.

After the version to run is resolved and before any model is called, the gateway checks: if the required level is higher than the key allows, both submit and preview return 403 `isolation_required`. The check also follows the agent's delegation chain (the currently published versions, up to 4 levels). A subagent run inherits the level of its parent run (recorded in the run checkpoint), and is checked again, against the version it actually runs, when the child run is submitted.

`workspace` is a **code-level** restriction (built-in tools can only reach the session workspace), not an OS sandbox.

**The `sandbox` level (sandbox S1, 2026-11-08)**: between `workspace` and `host`; it can be used as a key's `execution` or as `defaultKeyExecution`.

- Besides `workspace`-level agents, such a key can run agents on the **kernel engine whose tools are only built-in tools and `script` scripts**.
- These scripts are **only** dispatched to nodes that have declared an OS sandbox and passed its self-check, and run inside that sandbox. A worker that receives such a task without a usable sandbox rejects it outright (`sandbox_unavailable`) and never falls back to running on the host.
- **Claude Code and Codex (sandbox S2a)** can also be called with a `sandbox`-level key, provided that:
  - the worker's owner lists the engine under `sandbox.native.<engine>.providerDomains` and has enabled it;
  - at startup self-check, the CLI ran `--version` successfully inside the sandbox, so the worker reports `native/<engine>`;
  - the caller sends its own `X-OAA-Provider-Key`; otherwise the gateway returns 400 `provider_key_required`.

  At run time:
  - HOME and the CLI's configuration directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) are both under `.oaa-home/` in the session workspace, so the owner's login and configuration are not visible.
  - The caller's key is injected as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, and no other environment variables are passed beyond the basic ones.
  - Claude is started with `--bare` (API-key authentication only); Codex has its own sandbox turned off and relies on the outer sandbox for isolation.
  - Outbound network access is allowed only to the provider domains the owner listed.
  - An agent in the sandbox **can read** the injected key. It is the caller's own key, and outbound traffic can only reach the provider domains.
- Calling a native agent with a `host`-level key still uses the owner's own configuration and does not accept a caller key (`byok_not_supported`).
- Antigravity, DSH, adapters, and host tools of the `node` kind can still be called only with a `host`-level key.
- A sandbox node's capability is negotiated through `sandbox-v1` and then reported as `execution.sandbox`: `{backend, version, kinds}`.

The worker-side setting `sandbox`:

| Field | Default | Description |
|---|---|---|
| `backend` | `none` | With `none`, nothing is started; with `srt`, `@anthropic-ai/sandbox-runtime` is started, its HTTP and SOCKS proxies listen on localhost, and sandbox capability is reported only after the self-check passes |
| `allowDomains` | `[]` | The upper bound of domains a sandboxed script can reach. What is actually allowed is the intersection with the capability's declared `network.allowedDomains`; `*.` wildcards are supported; an empty intersection means no network at all |
| `cpuSeconds` | `60` | CPU time limit set with `ulimit -t` |
| `denyRead` | `[]` | Extra paths that may not be read. The home directory, external volumes, and the worker data directory are always denied; only the session workspace, the capability bundle, and the language runtime are opened |
| `native` | `{}` | Native engines allowed to run in the sandbox (`claude`, `codex`). Each entry is `{providerDomains: [...], cpuSeconds?: 1800}` |
| `parentProxy` | unset | The upstream proxy srt uses to reach the outside network. When unset, srt connects directly |

Boundaries and limitations of the srt backend:
- It is process-level isolation that shares the kernel with the host; its upstream status is a Beta research preview.
- Each call's network allowlist is bound through a random ID in the proxy username, so one worker **runs only one sandboxed process at a time**.
- It does not limit memory or process count.
- See `docs/sandbox-design.md` for details.

### Caller-supplied model keys (BYOK, P1)

A caller can send its own model-provider key in the `X-OAA-Provider-Key` request header. The header applies to every submission entry: `/v1/responses`, `/v1/invoke`, `/v1/chat/completions`, `/v1/messages`, the compatibility endpoints and the Gemini endpoints, and also to preview (`/v1/agents/preview`) and resume (`/v1/runs/{id}/resume`). With the OpenAI SDK, pass it through `default_headers`.

**How the key flows**

- The gateway keeps the key only in memory, indexed by run ID. It is never written to SQLite (including the WAL), events, checkpoints, timelines, logs, or any response; only a `byok: true` marker is persisted with the run.
- On each model call, the gateway sends the key to the worker together with the task. Remote workers use WSS, and TLS is mandatory for non-loopback addresses. The worker uses the key to **create a new, uncached** model client and discards it after use. If the key appears in an upstream error message, it is replaced with `[redacted]`.
- The key is dropped as soon as the run ends. A run that was interrupted (`interrupted`) keeps it for an extra hour so it can be resumed.

**Never falls back to the publisher's key**

- Every model call of a run that carries a caller key is dispatched only to nodes that explicitly accept caller keys, that is, nodes that declare `byokProviders`.
- A node accepts only if the worker's owner wrote `"byok": true` in the provider configuration, or the injected driver implements `withApiKey`.
- A node having its own key does **not** count as accepting. When no suitable node exists the gateway returns 503 `model_unavailable`, and the reason code in a preview is `byok_unsupported`.
- A worker that receives a caller key it should not receive rejects it outright (`byok_not_supported`) and does not switch to its own key.
- A provider that has `byok` enabled but no configured `apiKeyEnv` value serves only BYOK requests.

**Scope and limits**

- Applies to kernel agents only. Native agents use their own configuration; sending this header returns 400 `byok_not_supported`.
- A kernel subagent reuses the parent run's caller key; a native subagent does not receive it.
- After a gateway restart, all in-memory keys are lost:
  - runs in progress become `interrupted` and must be resumed with this header, otherwise 409 `byok_key_required`;
  - runs that were already queued before the restart fail with `byok_key_required` at their next model call.
- Billing and usage statistics are still recorded against this API key (the caller). Upstream costs are borne by the caller's own provider account.

**Node protocol**: the gateway declares `byok-v1` in `welcome.features`. A new worker reports `execution.byokProviders` through an `advertisement` message only after it receives that; the hello does not carry the field. So a new worker works with an old gateway and an old worker works with a new gateway; an old worker is never assigned BYOK tasks.

### Audit records (P1)

The gateway persistently records events where an **authenticated** request is rejected. The recorded error codes are: `scope_denied`, `admin_host_denied`, `isolation_required`, `concurrency_limit`, `subject_concurrency_limit`, `key_concurrency_limit`, `run_quota_exceeded`, `token_quota_exceeded`.

- Each record contains the time, error code, key ID, subject, HTTP method, path, and the client IP (with `trustProxy`, the first hop of `X-Forwarded-For`).
- Rejections with the same owner, key, error code, and path are written as one record within 60 seconds; the `suppressed` field of the next record gives the number merged in between. This count is kept in process memory and is lost on gateway restart.
- At most 10,000 records are kept per owner; older ones are deleted.

**Not recorded**: unauthenticated failures (401, `invalid_host`, `origin_denied`) and `rate_limited`. Otherwise every rejected request would become a database write, which hands an attacker an amplifier. That traffic should be rate limited and logged at the edge.

`GET /v1/audit?after=<event ID>&limit=50` (at most 200) returns pages from oldest to newest, and `next_after` is where the next page starts. Only an owner-level admin can read it; any other key gets 403 `scope_denied`, and that rejection is itself recorded.

### `/health` and the process ID

`/health` and `/healthz` need no authentication and are available on any allowed hostname, which suits load-balancer health checks. `pid` is returned only for direct local probes, for example `oaa serve --detach` uses it to confirm the background process. A direct local probe must meet all three conditions:

1. Host is a loopback or wildcard listen address (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, `[::]`).
2. The peer address is loopback.
3. The request has no `X-Forwarded-For`, `X-Forwarded-Host`, or `Forwarded` header.

Requests through a reverse proxy and remote requests do not see `pid`; the other fields are unchanged.

## Compatibility

| Interface                        | Implemented subset                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/models`                 | Published agent IDs as callable model aliases                                                                                             |
| `GET /v1/models/{id}`            | One model: the OpenAI Model object; with an `anthropic-version` header Anthropic's ModelInfo, with `x-goog-api-client` Google's Model. The slash in an agent ID may be percent-encoded (SDKs do) or not |
| `POST /v1/responses`             | Text or role/content inputs containing `input_text` and uploaded `input_file.file_id`; streaming, background, metadata, previous response |
| `GET /v1/responses/{id}`         | Authenticated durable response retrieval; `?stream=true` replays the Responses stream from the start (`starting_after=N` skips frames up to `sequence_number` N) |
| `POST /v1/responses/{id}/cancel` | Cancel only the owned response                                                                                                            |
| `POST /v1/chat/completions`      | Text messages, ordinary/streaming output, `stream_options.include_usage`, metadata                                                        |
| `POST /v1/files`                 | OpenAI-style multipart file/purpose, or JSON `{filename,content,encoding,allowed_nodes}`                                                  |
| `GET /v1/files/{id}/content`     | Authenticated input/artifact download                                                                                                     |

Responses `model` selects an agent alias. `metadata["oaa.model"]` optionally selects a route. Unsupported OpenAI input returns an explicit error rather than a silently degraded result: on the strict endpoints an unknown field answers `unsupported_parameter` with `error.param`, and on every OpenAI entry (strict, compatibility and `/v1/universal`) an audio or unknown content part answers 400 `unsupported_content` with `error.param` pointing at the part (for example `messages.1.content.0`); no run is created and nothing of the part reaches the prompt. Image parts (`image_url`, `input_image`) are accepted on every entry and reach the agent as images ([images.md](images.md)); an agent that cannot take images answers the same 400 `unsupported_content` with `error.param` on the image part. Upload other files with `POST /v1/files` and reference them with a `file` / `input_file` part (see [Compatibility-endpoint parameters, errors and finish reasons](#compatibility-endpoint-parameters-errors-and-finish-reasons-060)). Sampling parameters are accepted and reported as ignored. By default (managed mode) the gateway executes the registered agent tools and does not expose them as client-side function calls; caller-defined tools are only handed back to the caller in bridge mode, described next.

Client-defined tools: a request that declares a non-empty `tools` array (or sends tool results back) is handled by mode, chosen with the `X-OAA-Client-Tools` request header or `metadata["oaa.client_tools"]` on every entry. When the request chooses nothing the mode is `auto` (the gateway configuration `clientTools.default` can change that default): the caller's tools are handed to an agent that can take them over (`bridge`, below), and an agent that cannot gets what the entry did before, so only requests for agents that can bridge behave differently from older versions. The fallback is entry-specific: OpenAI's default endpoints (`/v1/chat/completions` and `/v1/responses` without `X-OAA-Compat`) refuse with 400 `unsupported_parameter` (`error.param` `tools`; the message says this agent cannot take the tools over, names the reason, and names the three ways out: the Base URL `<origin>/v1/compat`, `X-OAA-Compat: true`, `X-OAA-Client-Tools: managed`), while the compatibility endpoints, Claude Messages and Gemini carry on as `managed`. Auto falls back as well when a caller tool collides with a published tool or is not a plain function (Gemini `googleSearch`, `codeExecution`, ...), and when the caller forces a tool choice (`tool_choice` `required` or a function; Claude `any` / `tool`; Gemini mode `ANY`): the gateway and the agent cannot honour that, so the default endpoints refuse it (`unsupported_parameter`, `error.param` `tool_choice`) and the other entries ignore it as before. An explicit `managed`, `bridge`, `reject` or `auto` is never overridden. An empty `tools: []` changes nothing; `functions` / `function_call` (legacy) stay refused on the default endpoints, and `/v1/uap` rejects `tools` as an unknown field. The modes: `auto` (default, above), `managed` (the agent uses its own tools, the caller's tools are not executed, and the response carries `X-OAA-Client-Tools: ignored`), `reject` (`client_tools_unsupported`), or `bridge` (kernel agents and ACP agents; the response carries `X-OAA-Client-Tools: bridge`: the agent's calls to caller tools come back in each protocol's standard form — Chat `tool_calls` with `finish_reason: "tool_calls"`, Responses `function_call` items in a `completed` response with `metadata["oaa.status"]="requires_action"`, Claude `tool_use` blocks with `stop_reason: "tool_use"`, Gemini `functionCall` parts (`args` as an object) with `finishReason: "STOP"` — the run parks, and the next request carrying the results (`role: "tool"`, `function_call_output`, `tool_result`, `functionResponse` — paired by `id`, or without `id` by name and order against the previous `model` turn's `functionCall` parts) continues the same run, same `X-Run-ID` and the same response ID (`resp_…` / `chatcmpl_resp_…` / `msg_resp_…` / Gemini `responseId`) — unlike OpenAI, where every `responses.create` returns a new Response; here one task is one ID and one bill, `GET /v1/responses/{id}` shows its latest state, and the earlier `function_call` items are not kept as a separate snapshot; other external agents answer `client_tools_bridge_unsupported`, and non-function / server / built-in tools (Gemini `googleSearch`, `codeExecution`, …) in bridge mode answer `client_tools_unsupported`). An empty or absent `tools` changes nothing. See [harness.md](harness.md).

Responses output uses standard `response.created`, `response.in_progress`, message/content events, `response.output_text.delta`, and terminal events. The official OpenAI JavaScript SDK is tested against both normal and streaming output. `X-Run-ID` identifies the underlying execution. Disconnecting the HTTP client does not cancel an accepted task.

SSE headers are flushed when the stream is accepted, even if a Chat request has not produced text yet. `X-Run-ID` is a single value, and stream responses retain `Cache-Control: no-store, no-cache`; receiving headers is acceptance, not evidence that inference or tools have completed.

Text deltas are persisted before delivery. Cancelled, failed or truncated generations keep partial message content with status `incomplete`, rather than claiming the message completed. A completed model turn can retain a completed message even when a later tool or output-contract check fails. Native event replay remains cursor-based; when explicitly resuming an interrupted run, continue after the last observed event rather than replaying an earlier terminal event from cursor zero.

Under contention a kernel run can return from `in_progress` to `queued` at a confirmed model/tool boundary. Native SSE records `run.queued` with `reason: "fairness"` and the next checkpoint `phase`. The response ID, pinned model/version, output sequence, usage and deadline do not reset, and readmission may produce another `response.in_progress` event. This is not a terminal result or an approval request; clients should keep following the same execution. Ordinary Responses, Chat Completions and MCP waits continue across these scheduling transitions.

Chat `stream_options.include_usage=true` requires `stream=true`: regular chunks carry `usage: null`, followed on successful completion by one `choices: []` usage chunk before `[DONE]`. Unknown or partial totals stay null; no token counts or costs are fabricated. An interrupted stream may end with an error instead of a final usage chunk.

Normal synchronous calls return when complete or parked for approval. Responses represents a pending approval as `in_progress` with `metadata["oaa.status"]="requires_action"`; inspect the native run endpoint for its action. Chat Completions, Claude Messages and Gemini return HTTP 422 `action_required` (with `x-should-retry: false`, the run ID in `X-Run-ID` and in the error body) rather than pretending the task is complete: decide the action with `POST /v1/runs/{id}/actions/{action_id}` (`GET /v1/runs/{id}` lists it), then read the result with `GET /v1/responses/{id}`; do not resend the request, which would start a second run. Long-running or approval-driven clients should use background Responses or `oaa/1` and inspect actions.

(Added 2026-11-08) A streaming Responses request keeps the connection open while it waits for the owner's decision and additionally emits a `response.in_progress` event whose `response.metadata["oaa.status"]` is `requires_action`, consistent with the non-streaming representation; after the decision, the same stream continues until the terminal event. Chat / Claude / Gemini streams end with their own error frames (Chat `error.code: action_required`; Claude `event: error` with `error.type: invalid_request_error` and `error.code: action_required`; Gemini `error.status: FAILED_PRECONDITION` and `details[0].reason: action_required`), and UAP streams end with an `action` frame; the task itself continues in the background and can be queried with `X-Run-ID`. How approval, cancellation and resume differ across protocols is described in [adapters.md](adapters.md#agentapi-conversion-contract-2026-11-08) ("AgentAPI conversion contract").

### Compatibility-endpoint parameters, errors and finish reasons (0.6.0)

You call an agent, not a bare model: sampling parameters are decided by the publisher inside the agent, and the gateway does not forward them. Each entry handles them as follows.

| Endpoint | Honored | Accepted but ignored (listed in `X-OAA-Ignored-Params`) | Rejected |
| --- | --- | --- | --- |
| `/v1/chat/completions` (strict) | `messages` (`name` is dropped), `stream`, `stream_options.include_usage`, `metadata`, `max_tokens` / `max_completion_tokens`, `reasoning_effort` (routing hint: `high` / `xhigh` prefer the quality route, `low` / `minimal` the speed route), `tools` and tool messages (mode `auto`, above), `response_format` (structured output, [structured-output.md](structured-output.md)), `n` (must be 1) | `temperature`, `top_p`, `seed`, `stop` (any number of entries), `presence_penalty`, `frequency_penalty`, `user`, `store`, `service_tier`, `logit_bias`, `top_logprobs`, `tool_choice` (`auto` / `none`), `parallel_tool_calls`, `verbosity`, `prompt_cache_key`, `safety_identifier`, `prediction`, and the vendor sampling knobs `top_k`, `min_p`, `repeat_penalty`, `repetition_penalty`, `repeat_last_n`, `mirostat`, `mirostat_eta`, `mirostat_tau`, `tfs_z`, `typical_p`, `num_ctx`, `num_batch`, `num_keep`, `num_predict`, `keep_alive`, `think`; harmless values `logprobs: false`, `modalities: ["text"]`, `tools: []`, `functions: []`, `response_format: {"type":"text"}`; extra keys on text parts (`cache_control`) and in `stream_options` (`include_obfuscation`) are dropped; `null` for an optional number | Values that change what the gateway must do: `functions` / `function_call` other than `auto` / `none` (legacy; declare `tools`), `tool_choice` `required` or a named function, `logprobs: true`, non-text `modalities`, `n > 1`, `stream_options` without `stream: true` (as OpenAI does), and any field not named in this row (a typo is not swallowed): 400 `unsupported_parameter`, `error.param` is the field name and the message names the way out (`/v1/compat`); content blocks such as `input_audio`: 400 `unsupported_content`; `image_url` parts are accepted ([images.md](images.md)) |
| `/v1/responses` (strict) | `input` (a string, or message items with or without `type: "message"`; parts `input_text`, `output_text`, `input_file`, `input_image`), `instructions`, `stream`, `background`, `previous_response_id`, `metadata`, `max_output_tokens`, `reasoning.effort`, `tools` and their calls and results (mode `auto`), `text.format` (structured output) | `temperature`, `top_p`, `top_logprobs`, `user`, `store`, `service_tier`, `truncation`, `tool_choice` (`auto` / `none`), `parallel_tool_calls`, `include`, `max_tool_calls`, `prompt_cache_key`, `safety_identifier`, `stream_options`, `prompt_cache_retention`; harmless values `text.format` `text`, `tools: []` | A forced `tool_choice` and unknown fields: 400 `unsupported_parameter`; input items other than messages and tool items (`reasoning`, `item_reference`, ...): 400 `unsupported_content` with `error.param` `input.N`; content blocks such as `input_audio`: 400 `unsupported_content` |
| `/v1/compat/chat/completions`, `X-OAA-Compat: true` | The above, plus `tools` (by `X-OAA-Client-Tools` mode), `response_format` (structured output), `reasoning_effort` (routing strategy) | `temperature`, `top_p`, `seed`, `stop`, `presence_penalty`, `frequency_penalty`, `n`, `logit_bias`, `logprobs`, `top_logprobs`, `user`, `store`, `service_tier`, `tool_choice`, `parallel_tool_calls` | `input_audio` and unknown content blocks: 400 `unsupported_content`, with `error.param` pointing at the block (for example `messages.1.content.0`); upload other files with `POST /v1/files` first, then reference them with `{"type":"file","file":{"file_id":"…"}}`; images: [images.md](images.md) |
| `/v1/compat/responses` | The above, plus `instructions`, `tools`, `text.format` (structured output), `reasoning.effort` | `temperature`, `top_p`, `top_logprobs`, `user`, `store`, `service_tier`, `truncation`, `tool_choice`, `parallel_tool_calls` | `input_audio`, unknown content blocks and unknown input items: 400 `unsupported_content` (reference an uploaded file with `{"type":"input_file","file_id":"…"}`); images: [images.md](images.md) |
| `/v1/messages`, `/v1/compat/messages` | `system` (in full, not truncated), `messages`, `stream`, `metadata`, `max_tokens`, `tools`, `output_config.format` (structured output) | `temperature`, `top_p`, `top_k`, `stop_sequences`, `tool_choice`, `thinking`, `service_tier` | Inline base64 / URL documents, unknown content blocks: 400 `unsupported_content` (upload with `POST /v1/files` first, then reference it with `{"type":"document","source":{"type":"file","file_id":"…"}}`); `image` blocks with `base64`, `url` or `file` sources are accepted ([images.md](images.md)) |
| `/v1beta/models/{agent}:generateContent` / `:streamGenerateContent` (same under `/v1/models/...`, and `/v1beta/{agent}:generateContent` without `models/`, which the AI SDK Google provider requests for ids containing a slash) | `contents`, `systemInstruction`, `generationConfig.maxOutputTokens`, `generationConfig.responseMimeType` / `responseSchema` / `responseJsonSchema` (structured output), `fileData`, image `inlineData` ([images.md](images.md)) | The rest of `generationConfig` (`generationConfig.temperature` and so on), `safetySettings`, `toolConfig`, `cachedContent` | Other parts, such as `inlineData` that is not an image: 400 `unsupported_content` (use `{"fileData":{"fileUri":"oaa://files/<id>"}}`) |

- **Output length cap**: the requested cap is written to `metadata["oaa.max_output_tokens"]` (the older compat endpoints still write `oaa.compat_max_tokens`). The kernel takes the smaller of it and the agent's own `limits.maxOutputTokens`, and hands it to the node that runs the model call through the optional node wire field `Work.maxOutputTokens`. A caller can only lower the cap, never raise it. External agents (native execution such as ACP and A2A) do not call models through the gateway and are not bound by this cap. An older node that does not know the field runs with the published cap.
- **Gemini field names**: Google's REST accepts proto-JSON, so a body may use snake_case or camelCase. The gateway renames the known snake_case keys (`system_instruction`, `generation_config`, `max_output_tokens`, `function_declarations`, `parameters_json_schema`, `inline_data`, `file_data`, ...) before parsing; the caller's own data (`args`, `response`, JSON Schemas) is left alone. `google-genai` 3.3 sends tool schemas as `parameters_json_schema`.
- **Base URL tolerance**: runs of slashes in an API path are squeezed and the trailing slash of a `/v1...` or `/v1beta...` path is dropped, so a Base URL typed with a trailing slash (`/v1//chat/completions`, `/v1/models/`) still routes; authentication looks at the same normalized path. A 404 for a path that starts with `/chat/completions`, `/completions`, `/models`, `/responses` or `/embeddings` adds that the OpenAI-style Base URL must end with `/v1`; a path starting with `/v1/v1` adds that the client already appends `/v1`.
- **CORS preflight**: the `Origin` must be the gateway's own or in `allowedOrigins` (otherwise 403 `origin_denied`); the answer to `OPTIONS` then lists the fixed header set plus exactly the well-formed header names the browser asked for in `Access-Control-Request-Headers` (browsers send `user-agent`, `x-stainless-*` and others that a fixed list cannot predict).
- **Body-less POST**: a zero-length body with `Content-Type: application/json` on `DELETE` and on `/cancel`, `/resume` and `/reconcile` is treated as no body (the official SDKs send it for `responses.cancel`); a malformed non-empty body is still 400 `invalid_json`.
- **Tested clients**: which SDKs, frameworks and chat clients were run live or replayed from recorded request shapes is in [compatibility.md](compatibility.md).
- **`X-OAA-Ignored-Params`**: the names of parameters in this request that were accepted but not forwarded, separated by a comma and a space; the header is absent when no parameter was ignored.
- **Content blocks**: Claude `tool_use` / `tool_result` and Gemini `functionCall` / `functionResponse` are handed to the agent as text labeled `[assistant tool_call:<name>]` / `[tool:<id or name>]` (the same as compat Responses); Claude `thinking` blocks and Gemini `thought` parts are not handed to the agent.
- **Detection on `/v1/universal`**: an explicit `X-OAA-Protocol: uap|oaa|gemini|claude|chat|responses` wins. Otherwise: UAP and OAA are recognized by their fields; `contents` means Gemini; with `messages`, only features unique to one vendor count. Claude: the `anthropic-version` or `x-api-key` header, an array-form `system`, `stop_sequences`, `top_k`, `thinking`, `anthropic_version`, tools with `input_schema`, and `image` / `document` / `tool_use` / `tool_result` / `thinking` content blocks. Chat: the `system` / `developer` / `tool` roles, `tool_calls`, `tool_call_id`, `stream_options`, `n`, `response_format`, `max_completion_tokens`, `seed`, `stop` and similar fields, tools with `type: "function"`, and content blocks such as `image_url`. `max_tokens`, a string `system`, `model`, `stream` and `metadata` exist in both and do not take part in detection. When neither or both have features, the gateway returns 400 `protocol_undetected` and does not guess. `input` with `model` means Responses. Whether Gemini through universal streams is decided by the non-standard `body.stream`, and it is always SSE.

**Error shapes**:

| Endpoint | Shape | Where the gateway error code is |
| --- | --- | --- |
| OpenAI (`/v1/chat/completions`, `/v1/responses*`, `/v1/compat/chat/completions`, `/v1/compat/responses`; universal detected as chat / responses) | `{"error":{"code","message","type","param"}}` | `error.code` |
| Claude (`/v1/messages`, `/v1/compat/messages` and their sub-paths such as the 404 of `/v1/messages/count_tokens`; universal detected as claude) | `{"type":"error","error":{"type","message","code"}}`, with `error.type` by HTTP status: 400 `invalid_request_error`, 401 `authentication_error`, 402 `billing_error`, 403 `permission_error`, 404 `not_found_error`, 409 `conflict_error`, 413 `request_too_large`, 429 `rate_limit_error`, 503 / 529 `overloaded_error`, 504 `timeout_error`, other 5xx `api_error`, other 4xx `invalid_request_error` | The additional field `error.code` |
| Gemini (`/v1beta/*`, `/v1/models/{agent}:{method}`, `/v1/models*` with `x-goog-api-client`; universal detected as gemini) | `{"error":{"code":<HTTP status>,"message","status","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason","domain":"open-agent-api"}]}}`, with `status` by HTTP status: 400 `INVALID_ARGUMENT`, 401 `UNAUTHENTICATED`, 403 `PERMISSION_DENIED`, 404 `NOT_FOUND`, 409 `ABORTED`, 422 `FAILED_PRECONDITION`, 429 `RESOURCE_EXHAUSTED`, 503 `UNAVAILABLE`, 504 `DEADLINE_EXCEEDED`, other 5xx `INTERNAL` | `details[0].reason` |
| All other routes | `{"error":{"code","message","type":"invalid_request_error"}}` (unchanged) | `error.code` |

Errors after the run has been created also carry `run_id` (OpenAI, Claude) or `details[0].metadata.run_id` (Gemini). When an error occurs after the stream has started, the error frame carries the real error code and reason: Chat `data: {"error":{"code","message","type","param":null,"run_id"}}` (`type` is `server_error` for server-side failures); Claude `event: error`, with `error.type` mapped from the HTTP status the code has in the catalog; Gemini the same Google error object.

**Retries**: when a run has been created but did not end normally (failed, cancelled, interrupted, awaiting approval), non-streaming Chat / Claude / Gemini return **422** (no longer the 409 that the official SDKs retry automatically by default) with `x-should-retry: false`; Responses still returns a 200 response object (`status: "failed"` and so on). Errors that the error catalog marks as not retryable but whose status code would make an SDK retry (408, 409, 429, 5xx) also carry `x-should-retry: false` (for example quota exhaustion). Retryable 429 / 503 responses carry `Retry-After`: the per-minute rate limit (`rate_limited`) gives the real remaining seconds (1-60) of the current 60-second window, and other capacity limits (including `too_many_streams`, `catalog_capacity`, `key_concurrency_limit`) give 10 seconds.

**Why quota exhaustion (429) and insufficient balance (402) differ**: `run_quota_exceeded` and `token_quota_exceeded` are limits the owner sets on an API key, meaning "this key is used up", so they use 429, like OpenAI's `insufficient_quota`; `insufficient_balance` means a platform account needs a paid top-up, so it uses 402. Neither is retryable: a quota-exhausted 429 carries `x-should-retry: false` and no `Retry-After`, and 402 is not among the status codes the official SDKs retry automatically, so neither is retried by an SDK. The HTTP status of already-published error codes does not change.

**Finish reasons**:

| Run | Chat `finish_reason` | Claude `stop_reason` | Gemini `finishReason` | Responses |
| --- | --- | --- | --- | --- |
| Completed | `stop` | `end_turn` | `STOP` | `status: completed` |
| Model output truncated (`max_output_tokens`) | `length` (200; the text generated so far is returned as usual; a stream still ends with `[DONE]`) | `max_tokens` | `MAX_TOKENS` | `status: incomplete`, `incomplete_details.reason: max_output_tokens` |
| Bridge: waiting for the caller to run a tool | `tool_calls` | `tool_use` | bridge not supported | `completed` + `function_call` items |
| Failed / cancelled / interrupted / other incomplete / awaiting approval | 422 error (stream: error frame) | 422 error (stream: `event: error`) | 422 error (stream: error object) | `failed` / `cancelled` / `incomplete` / `in_progress` |

`stop_sequence` is always `null` (the gateway does not forward stop sequences). Claude's `message_start.usage` is 0: there is no usage yet when output starts, and the real values arrive in `message_delta`. `model` echoes the agent ID, and Gemini's `modelVersion` is `<agent>@<route model>`. The Claude entry does not require `max_tokens` and does not validate role alternation, so it is more lenient than the official API.

**Stream details**: the `sequence_number` of a Responses stream (and the SSE `id:`) is the frame sequence within that stream, consecutive from 0; a stream that continues after a bridge is a new segment and also starts from 0. A Claude stream sends a `ping` event after `message_start`, and when there is no output for a long time the gateway sends an SSE comment heartbeat every 15 seconds. Gemini `:streamGenerateContent?alt=sse` is SSE; without `alt=sse` it is a chunked JSON array (`application/json`, elements separated by `,\r\n`, with whitespace as the heartbeat). Gemini also accepts the REST `?key=` (only on `/v1beta/models[/*]` and `/v1/models/{agent}:{method}`; the gateway does not log full URLs, and audit records keep only the path).

**Official SDK testing**: the Claude Messages entry has regression tests in this repository with the official `@anthropic-ai/sdk` 1.3.0 (`test/compat-anthropic-sdk.test.ts`, `test/compat-anthropic-sdk-errors.test.ts`; in-process, no port listening). They cover: parsing of `messages.create` and `messages.stream()` (`finalMessage()`, `finalText()`, raw event iteration); truncation; system prompts and multi-turn; authentication (SDK 1.3.0 sends `apiKey` as `Authorization: Bearer`; `authToken` and an explicit `x-api-key` header work too; `anthropic-beta` does not affect the request); the error classes (`AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `BadRequestError`, `RateLimitError`, `UnprocessableEntityError`); failures and pending approvals send exactly one request; and bridged tools (`tool_use` blocks, streamed `input_json_delta` assembled into an object, parallel calls, continuing with `tool_result`). Endpoints that the SDK has but the gateway does not (`messages.countTokens`, `messages.batches.*`) return a Claude-shaped 404, which the SDK parses as `NotFoundError` (`type: "not_found_error"`). `GET /v1/models` with an `anthropic-version` request header (the SDK's `models.list()`) returns an Anthropic ModelInfo list (`type: "model"`, `display_name` is the agent ID, `created_at` is an epoch time, `has_more: false`); without that header it is still the OpenAI list shape. The gateway supplies every field that is required in the SDK 1.3.0 types but nullable: on `Message`, `container`, `stop_details` and `diagnostics` are `null`; in `usage`, `input_tokens` and `output_tokens` are the run's real counts, while `cache_creation_input_tokens`, `cache_read_input_tokens` (the gateway does no prompt-cache counting), `cache_creation`, `output_tokens_details`, `server_tool_use`, `service_tier`, `inference_geo` and `speed` are `null`; the message in a streaming `message_start` has the same shape, and the `delta` of `message_delta` carries `stop_details: null` and `container: null`, with its `usage` carrying `MessageDeltaUsage`'s `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens_details` and `server_tool_use` (`null`). Both non-streaming reads and `finalMessage()` see `null`, not `undefined`; fields that are optional in the types are not added. The Gemini entry was tested once with a temporarily installed official `@google/genai` 3.2.0 (probe script `examples/gemini-sdk-probe.mjs`, in-process, no port listening; this SDK is not a project dependency, and regression coverage relies on the wire-format tests `test/compat-claude-gemini.test.ts` and `test/compat-gemini-sdk-findings.test.ts`): the SDK's default `apiVersion` is `v1`, so requests go to `/v1/models/{agent}:generateContent`, and the gateway accepts both `/v1` and `/v1beta`; `generateContent` reads `text`, `candidates`, `finishReason`, `usageMetadata`, `modelVersion` and `responseId`; `generateContentStream` and `chats.sendMessageStream()` use `?alt=sse`, and the last chunk carries `finishReason` and usage; `systemInstruction`, multi-turn and `chats` history enter the prompt by role; truncation by `maxOutputTokens` is `MAX_TOKENS`, and `temperature` / `topP` / `topK` / `stopSequences` are listed in `X-OAA-Ignored-Params`; the SDK authenticates with the `x-goog-api-key` header (`?key=` works too). Errors throw `ApiError`, where `status` is the HTTP status and `message` is the JSON string of the error body, from which `details[0].reason` and `metadata.run_id` can be read; a failure in the middle of a stream is also an `ApiError` (`status: 500`, `INTERNAL`). The SDK does not retry by default (it retries 408, 429 and 5xx only when `httpOptions.retryOptions` is set, ignoring `Retry-After`), and a run failure or pending approval (422) sends one request and creates one run. Caller tools: by default and in managed mode the SDK gets no `functionCalls`, and returned `functionCall` / `functionResponse` parts enter the prompt as text; with `X-OAA-Client-Tools: bridge` (`httpOptions.headers`), `response.functionCalls` from `generateContent` has `id`, `name` and `args` as an object, `finishReason` is `STOP`, and manually returning a `functionResponse` continues the same run (the same `responseId`); two parallel calls, `generateContentStream` (the calls arrive complete in one chunk) and `chats.sendMessage` round trips (the SDK history keeps the `id` of the model turn's `functionCall`, while the caller's `functionResponse` carries no `id` and is paired by name) were all tested; the SDK writes the type of `parameters` in uppercase (`OBJECT`), and the gateway converts it to JSON Schema. `models.list()` / `models.get()`: `GET /v1beta/models[/{agent}]`, and `GET /v1/models[/{agent}]` with the `x-goog-api-client` header (which the SDK always sends), return Google's Model shape (`name: "models/<agent>"`, `displayName`, `supportedGenerationMethods`), all at once with no `nextPageToken`. `countTokens`, `embedContent`, `caches` and `files` do not exist on the gateway and return 404, which the SDK parses normally as `ApiError` (the 404 of `/v1/cachedContents` and `/v1/files` is not Gemini-shaped, but the SDK does not depend on the shape).

Cancelling an already completed response returns 200 with its completed object (OpenAI allows cancelling only background responses). `metadata` gains several `oaa.*` keys (status, version, route, and so on), which can exceed OpenAI's 16-key limit; strip the `oaa.*` keys before forwarding a response object to the real OpenAI.

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

`welcome.features` is now `execution-capabilities-v1`, `byok-v1`, `sandbox-v1`, `provider-turn-v1`, `client-tools-v1`, `image-input-v1`. With `image-input-v1` a worker reports `execution.imageInput = { providers: {<name>: "none"|"inline"|"url"}, native: {<engine>: "native"|"agent-declared"|"workspace-file"} }`; a run with images is placed only on a worker whose declaration covers its provider or engine (placement reason `image_input_unsupported`), so older workers never receive one ([images.md](images.md)). With `client-tools-v1` a worker reports `execution.clientTools = { native: ["kernel", "adapter/<acp name>", …] }`: the engines on which it can bridge caller tools (docs/harness.md). Bridged runs are placed only on workers that declared the run's engine there (placement reason `client_tools_unsupported` otherwise); when no such worker exists, submission answers `client_tools_bridge_unsupported` (400). Only those workers receive `Work.native.clientTools` and send the `client_tool` event (`data: { name, arguments, relay_call_id }`), which the gateway answers like an approval with `{ output }` or `{ error }`. Older workers and older gateways keep working; an older worker simply never receives bridged work. Every update is validated against the same node identity and credential grants as the initial registration. Idle peers also lose their registration when heartbeats expire.

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

## Console overview: revision, ETag and event stream

> Added 2026-11-07.

**Revision**: for each owner the gateway maintains a monotonically increasing integer revision that covers everything `GET /v1/overview` reports. It advances when: run summaries or statistics are committed (`runs`); an agent is published or route health changes (`catalog`); a node goes online or offline, its advertisement changes, scheduling starts or ends, node policy changes, or a local backend is switched (`nodes`); and on purely time-driven state changes such as cooldown expiry. The revision starts from a microsecond clock reading taken at startup, so it keeps increasing across gateway restarts and an old ETag never collides with the new state after a restart. Inputs that have no events, such as the file system and environment variables, are rechecked after at most 5 seconds, and the revision advances only if the content actually changed.

**`GET /v1/overview`** (requires `read`):

- The response body gains a `revision` field; all other fields are unchanged.
- `metrics` gains three counts, `queued`, `in_progress` and `requires_action` (2026-11-08), measured the same way as `active`: within the owner plus the key's agent grants, counted by each run's current status, and the three always add up to `active`. `requires_action` is the number of runs waiting for approval; it can be used directly for a "needs attention" prompt or a Dock badge, and is not limited by `runs` listing only the latest 12.
- The response header is `ETag: W/"ov.<revision>.<identity digest>"`; the identity digest is computed from the caller's owner, key name, `keyId`, scopes, agent grants, and the resolved public address.
- When the request carries `If-None-Match` (a list or `*`, compared weakly) and it matches, the response is `304` with no body.
- The rows of `runs[]` carry the same optional `waiting_on` as `GET /v1/runs` (0.3.0): it appears only when `status` is `requires_action` and there are pending actions; `caller` means all pending actions are caller tools (the run is only waiting for the caller to return results, and there is nothing for the owner to do), and `owner` means there are actions that need a person. Creating and resolving an action refreshes the run summary and advances the revision (`runs`), so the ETag is invalidated when `waiting_on` changes.
- Agent availability, the node list and statistics are cached by revision; the `runs` list is re-read in every `200` response so that running tasks report a current `elapsed_ms`. A `304` means the revision has not changed since the last `200`, and the client should compute the elapsed time of running tasks itself from `created_at`.

**`GET /v1/overview/events`** (SSE, requires `read`; authentication uses only the `Authorization` header, and the token is never put in the URL):

```text
event: ready
data: {"revision":1794312000123456}

event: changed
data: {"revision":1794312000123460,"reasons":["runs","nodes"]}

: ping
```

- `ready` is sent right after connecting; later changes are coalesced into one `changed` about every 250 ms, with `reasons` being a subset of `runs`, `catalog`, `nodes` (in that fixed order). After receiving `changed`, request `/v1/overview` again with `If-None-Match`.
- A `: ping` heartbeat line is sent every 20 seconds; each heartbeat revalidates the key, and the connection is closed immediately if the key was deleted or its authorization changed.
- Each API key can hold at most 4 overview event streams at the same time; more return `429 too_many_streams`.
- Events carry only the revision and reasons, never run content; only changes for the same owner are notified (a key restricted to some agents under the same owner also receives change notifications for that owner's other agents).
- An older gateway without this route returns `404`, and the client should fall back to polling.

**Storage**: this change does not modify the SQLite schema (`PRAGMA user_version` was still 3 when it shipped; the current schema version is 4) and leaves persistence semantics unchanged (WAL + `synchronous=FULL`; a checkpoint and its output events are committed in one transaction). The revision and caches live only in memory and are not written to disk.

## Observable kernel: run timeline, activity pulse, queueing and capability negotiation

> Added 2026-11-08. All data is derived from already persisted state: lifecycle events, execution steps, and the model-turn markers in checkpoints. No model or tool is called, no event type is added, and the SQLite schema is not modified (`user_version` was still 3 at the time). The output streams and event sequence numbers of the compatibility endpoints (OpenAI / Claude / Gemini / UAP) are unchanged; tests check this byte for byte with the same workload as `bench/protocol-speed.ts`: UAP NDJSON 10,238 bytes, OpenAI Chat SSE 55,219 bytes.

### `GET /v1/runs/{id}/timeline`

Requires the `read` scope and authorization for the agent, like the other run-inspection endpoints: another owner's run returns `404 run_not_found`, and an unauthorized agent returns `403 scope_denied`. The response header is `ETag: W/"tl.<last_event_id>.<status>"`; a matching `If-None-Match` returns `304`. A running task also returns `304` when there are no new events, and the frontend then uses `now` to compute the duration of in-progress spans itself.

| Field | Description |
| --- | --- |
| `id`, `status` | The run ID and its current status |
| `created_at`, `ended_at`, `now` | Millisecond epoch; `ended_at` is the time of the latest terminal event, `null` if not ended |
| `total_ms` | `(ended_at ?? now) - created_at` |
| `last_event_id` | The ID of the run's last event (also used for the ETag) |
| `spans[]` | The list of time spans, sorted by start time, at most 200 |
| `critical_path_ms` | The total duration covered by the spans on the critical path; `total_ms - critical_path_ms` is the gap not covered by any critical span |
| `breakdown_ms` | `{queue, model, tools, approval, other}`, attributed along the critical path; the items always add up to `total_ms`; gaps count as `other` |
| `truncated` | `true` when there are more than 200 spans; spans on the critical path are kept first, and `critical_path_ms` / `breakdown_ms` are still computed over all spans |

Each span:

| Field | Description |
| --- | --- |
| `id` | `sp_1`, `sp_2`, ... (stable for the same `last_event_id`) |
| `kind` | `queue`, `model`, `tool`, `approval`, `client_tool`, `subagent`, `interrupted`, `native` (`client_tool` is a bridged run waiting for the caller to execute its own tool; it is counted under `tools`) |
| `label` | A machine-readable identifier, rendered in the user's language by the frontend according to `kind`: the queue reason (`admission`, `fairness`, `approval`, `agent_fallback`, `node`), the model route ID, the tool name, the name of the tool that needs approval or is waiting for the caller, or the native approval type, the subagent name, or the native engine name |
| `ref` | `{turn, attempt?}` (model), `{step_id, tool}` (tool), `{approval_id, step_id?}` (approval, client_tool), `{step_id, child_run_id?}` (subagent) |
| `lane` | The lane: lane 0 holds the main line (queue, model, native execution, approval), and parallel tools and subagents are greedily packed by the server starting from lane 1; a node-wait span sits in the same lane as its tool |
| `start_ms`, `end_ms` | Millisecond offsets relative to the run's `created_at` (not epoch timestamps); `end_ms` is `null` while in progress |
| `status` | `completed`, `failed`, `cached`, `running`, `waiting`, `uncertain`, `cancelled` |
| `critical` | Whether it is on the critical path |
| `depends_on` | The span IDs it depends on: a tool depends on the model turn that issued it, on its approval, and on the steps that `$ref` / `depends_on` points to in the execution graph; a main-line span depends on the previous main-line span and on the whole batch of tools completed in between |
| `estimated` | Appears only on derived values, always `true` (see "Older runs" below) |

Rules and definitions:

- **Critical path**: starting from the span that ends last, trace back through "the latest-ending dependency" to the start. Among parallel tools only the one that determines the duration is counted, so time is never counted twice.
- **Native / ACP agents**: the whole execution is recorded as `native` and counted under `model` (the platform cannot see its internal tool time); a native approval splits the execution into three segments: execute, approve, execute.
- **Node wait**: when a tool waits from queueing to start of execution, a model turn waits from start to node pickup, or a native agent waits from start to node pickup for more than 10 ms, the wait is shown separately as `queue` (`label: "node"`).
- **Interruption and resume**: for a run that was explicitly resumed after a gateway restart or failure, an `interrupted` span is shown between the interrupt event and the resumed execution, counted under `other`.
- **Older runs**: runs completed before this version have no model-turn markers, so their model spans are derived from the gaps between tool batches and carry `estimated: true`.
- A checkpoint keeps at most 400 model-turn markers.

### `GET /v1/overview/activity?window=24h|7d`

Requires the `read` scope; the default is `24h`, and any other value returns `400 invalid_request`. The scope of the statistics is the same as `runs` in `/v1/overview` (owner plus the key's agent grants). The ETag is bound to the **run revision**, the `window`, the start of the current bucket, and the caller identity (`W/"act.<revision>.<digest>"`), and a match returns `304`. The run revision advances only when run summaries change; publishing an agent, a node going online or offline, or a load change does not make the activity statistics recompute or change their ETag (with 10,000 runs, a read after a catalog change dropped from about 11 ms to about 0.06 ms). After runs change, reads are incremental: runs that are completed, failed, cancelled or incomplete never change again, so each view caches the parsed rows and then reads only newly inserted runs and runs that can still change (in progress, queued, awaiting approval, resumable interrupted), about 1.8 ms with 10,000 runs (previously a full scan of about 11 ms each time); the result matches a full scan field by field, which tests guarantee. An unchanged poll takes about 0.05 ms. The overview's `metrics` are likewise recomputed only when the run revision changes.

| Field | Description |
| --- | --- |
| `window`, `revision`, `generated_at` (ISO), `bucket_ms` | The window, the run revision (advances only with run changes and is never greater than the `revision` of `/v1/overview`), the computation time, and the bucket width |
| `buckets[]` | `{start (ISO), started, completed, failed, cancelled, interrupted, active}`. `24h` has 24 one-hour buckets aligned to UTC whole hours, and `7d` has 28 six-hour buckets aligned to 00/06/12/18 UTC; the last bucket is the current (incomplete) one |
| `totals` | The sums of the counts above, plus `success_rate` |
| `latency_ms` | `{p50, p95, samples}`: end-to-end duration of runs that ended within the window (last checkpoint time minus creation time), percentiles by the nearest-rank method |
| `breakdown_ms` | `{queue, model, tools, approval, other, runs}`: the sum, item by item, of the timeline algorithm over the latest at most 100 ended runs in the window (`runs` is the number of runs actually aggregated); `null` when there are no ended runs. The timelines of ended runs are cached per run |
| `agents[]` | `{agent, runs, completed, failed, p50_ms}`, the top 8 by run count in descending order (ties by agent ID) |

Definitions: runs fall into a bucket by `created_at` and are counted by their **current status**; `failed` includes `incomplete` (deadline, turn, or token limits); `active` is queued / in_progress / requires_action; `success_rate = completed / (completed + failed + interrupted)`: cancellation is not a failure and is not in the denominator, it is `null` when the denominator is 0, and it keeps 4 decimal places. The more runs in the window, the slower the computation (O(runs in the window)); history outside the window is not scanned.

### Queue transparency (`queue`)

The `runs[]` of `/v1/overview` and `GET /v1/runs/{id}/state` gain a `queue` field when: the run's `status` is `queued` (waiting for kernel admission); or the run is `in_progress` but its current piece of work is still waiting in a node queue.

| Field | Description |
| --- | --- |
| `position`, `ahead` | The position in the queue (counted from 1, `ahead = position − 1`) and the number ahead, **counting only runs of the same owner**; `null` when the run cannot be found in the queue (for example the gateway has not started scheduling it yet) |
| `reason` | `admission` (waiting for a run slot), `fairness` (re-queued after yielding at a checkpoint), `approval` (re-queued after approval), `node_busy` (node at capacity), `cooling_down` (the target is in a throttling cooldown), `unknown` |
| `estimated_start_ms` | The estimated number of milliseconds still to wait: a duration relative to when the response was generated, **not an epoch timestamp**; an estimate, not a promise; `null` when unknown. Kernel admission uses **slot simulation**: each execution slot records an "expected free time". A running task's remaining life is the empirical average remaining life computed from its agent's historical occupancy (the longer it has run, the more it is extrapolated from longer samples of the same kind; beyond all samples it takes 1/4 of the median, at least 250 ms). Each run ahead (in global order) occupies the earliest free slot in turn, for the typical occupancy of its agent. The moment the target run gets a slot is the estimate. Samples prefer the slot occupancy measured since the kernel started (the latest 50 per owner and agent), and when there are fewer than 5, use the durations of that agent's latest 50 completed runs in the database; an agent with no samples borrows the median of other known samples. In a deterministic simulation (`npm run bench:queue`), at load 0.7 / 0.85 / 1.05 the mean absolute error is 49.6% / 74.4% / 78.5% lower than the old formula. Node cooldown: the remaining cooldown time; node at capacity: the average execution time of that target on the node (1000 ms for a model and 50 ms for a tool when there is no history) |

Multi-tenant privacy: count fields never include other owners' runs; the estimate uses the global position because that is what determines the actual wait, but it exposes only a duration, never another owner's counts. When the overview returns `304`, `estimated_start_ms` is the value from the last `200`.

### Capability negotiation: `GET /health`

`/health` (and `/healthz`) remain public and contain no secrets or load information. They add a sorted `features` array that lets the console, the CLI and SDKs tell whether an optional endpoint exists without probing for a 404:

`a2a-adapters-v1`, `acp-adapters-v1`, `adapter-stream-v1`, `approval-policy-v1`, `catalog-events-v1`, `client-tools-policy-v1`, `conversion-profile-v1`, `error-catalog-v1`, `error-codes-v1`, `harness-bridge-acp-v1`, `harness-bridge-v1`, `image-input-v1`, `local-backends-v1`, `oaa-lang-roundtrip-v1`, `overview-activity-v1`, `overview-etag-v1`, `overview-events-v1`, `platform-setup-v1`, `queue-insight-v1`, `run-timeline-v1`, `structured-output-v1`, `webhooks-v1`, `workflow-output-v1`, and, when the `platform` section is configured, `platform-v1`.

(Added 2026-11-11) `client-tools-policy-v1`: caller tools are handled according to `X-OAA-Client-Tools` (or `metadata["oaa.client_tools"]`) (auto / managed / reject; for bridge see `harness-bridge-v1`), the response carries `X-OAA-Client-Tools: ignored` when the agent keeps its own tools and `bridge` when the tools were handed over; the profile contains a `client_tools` field. Gateway configuration `clientTools.default` (`auto` by default, or `managed` / `bridge` / `reject`) is what a request gets when it chooses nothing. `harness-bridge-v1`: kernel agents support `bridge` through Chat Completions, Responses and Claude Messages (caller tools are handed back to the caller as `tool_calls` to execute, and the same run continues). See [harness.md](harness.md).

(Added 0.3.0) `harness-bridge-acp-v1`: external ACP agents also support `bridge`: caller tools are handed to the inner agent through the `oaa-caller` MCP relay, and the inner process stays alive while it waits; there is a new event `run.awaiting_caller`. See [harness.md](harness.md#how-bridging-works-for-external-agents) ("How bridging works for external agents").

(Added 2026-11-08) `adapter-stream-v1`: workers support the `oaa/1-stream` bidirectional streaming adapter ABI; `a2a-adapters-v1`: `transport: "a2a"` remote agents are supported; `conversion-profile-v1`: every item of `GET /v1/agents`, the agents of `GET /v1/overview`, `GET /v1/catalog/agent` (`section=overview`, the same source as MCP `oaa_inspect_agent`) and `GET /v1/local/backends` carries a `conversion` capability profile. For the fields and values see [adapters.md](adapters.md#conversion-profile-conversion) ("Conversion profile"); the profile is derived only from the gateway machine's static configuration (unchanged within a process, so it does not affect the overview ETag), and an `adapter/<name>` that exists only on a remote node is reported as `access: "unknown"`.

The endpoints in this section introduce no new error codes; the codes they may return are all listed in the next chapter: `run_not_found`, `scope_denied`, `invalid_request`, `unauthorized`, `rate_limited`.

## Agent fallback on failure (`oaa.agent_fallback`, 2026-11-10)

At submission, give fallback agents in `metadata`: `{"oaa.agent_fallback": "agent/b,agent/c"}` (comma separated, at most 4). It takes effect through metadata on every entry (`/v1/invoke`, Responses, Chat, Messages, UAP) and does not change the request structure.

- **When it switches**: the current agent fails **before it has done anything**: no output, no tool steps, and an external agent has not been started yet (for example the model provider is unavailable, every route failed, or the execution machine is offline). The same request is then re-queued under the next fallback agent, the request ID does not change, and the caller does not need to retry.
- **When it does not switch**: output already exists or steps have already run (redoing the work with another agent could repeat side effects); the run was cancelled, timed out, or the gateway is shutting down; the side-effect outcome is unknown; a turn or usage limit was reached; permissions or the execution level do not allow it; runs that use a caller-supplied model key (BYOK).
- **Validated at submission**: every fallback agent must exist, and the caller must have `invoke` permission on it and satisfy its execution-level requirement; otherwise submission is rejected (`scope_denied`, `isolation_required` or `agent_not_found`).
- **Trace**: on a switch the event `run.queued` is written with `data` of `{reason: "agent_fallback", from, to, error}`; the run's `metadata["oaa.fallback_from"]` records the agent that was replaced, and `oaa.agent_fallback` is updated to the remaining fallbacks. The run's ownership in the catalog changes to the new agent, and the original failure does not produce a `response.failed` event.
- **How the next one is chosen**: the first currently usable fallback in chain order: the caller still has permission, it passes the same execution-level check as at submission (including its delegation chain), and its model route currently has an available executor on a node (considering nodes, sandbox level and input file placement). Fallbacks that do not qualify are skipped in favor of the next one in the chain; if none qualifies, the run ends with the original error.
- **What the new agent sees**: the conversation text (user messages) and the input files in the session; not the previous agent's system instructions, provider state or session handle.
- **Deadline**: inherited from the original and not restarted; a fallback agent has only the time the original request has left.
- When no fallback is declared, behavior is exactly as before.

## One-step enablement of installed agents (2026-11-10)

`POST /v1/local/presets/{id}/enable` (owner admin key) combines "write the configuration, restart, switch on" into one step:

- `{id}` is a preset ID in the "supported agents" catalog (such as `gemini`, `qwen`, `opencode`). If the matching program is not on this machine's `PATH`, it returns `backend_unavailable` and installs nothing.
- When the agent is not yet in the configuration, an adapter entry is added with the same content as `oaa doctor --write` and takes effect immediately without a restart; when the gateway was started with `oaa serve`, it also writes the configuration file back (the file still records it as disabled, and the enabled state is kept in the database, consistent with the manual switch). When an entry already exists, only the switch is turned on.
- It returns `{engine, enabled: true, preset, configured: "added"|"existing", persisted}`. `persisted: false` means the gateway was not started from a configuration file, and the added entry is valid only for this run.
- This is an explicit admin action: the gateway never discovers and enables on its own, and it does not call a model. After enabling, you still need to "publish" before it becomes a callable agent.

## Agent handoff (`handoff`, 2026-11-10)

Within one session you can hand over to another agent to carry on, or let the same agent continue on a different model route.

- **How to use it**: a continuation request carries `previous_response_id` and declares the handoff explicitly: `POST /v1/invoke` uses `"handoff": true`; the OpenAI Responses, UAP and other compatibility entries, which do not change the request structure, use `metadata: {"oaa.handoff": "true"}`. `POST /v1/agents/preview` also accepts `handoff`, so you can check whether the new agent is usable now before switching.
- **No declaration, no change**: without the handoff marker, continuing on a different agent still returns `invalid_continuation`, and switching the model on a continuation still returns `model_switch_requires_new_session`.
- **Prerequisites**: the previous turn must be `completed`; the caller must have `invoke` permission on the new agent.
- **Inherited**: the session ID, input files, and previously generated files.
- **Not inherited**: the previous agent's pinned model route and version, its private native session handle (`nativeState`), the provider's native turn state, its tool-call details, and its system instructions.
- **How the conversation is carried over**: only user messages and the agent's final text replies. A kernel agent treats them as message history; external agents (Claude Code, Codex, Antigravity, ACP, A2A, adapters) manage their own sessions, so a size-limited "handoff note" is prepended to this turn's input (12,000 characters, 2,000 characters per entry, at most 50 file names). The `input` in the run record is still the caller's original input. The handoff note is sent only once, on the handoff turn, and afterwards the agent continues its own session normally.
- **Trace**: a run that hands off across agents carries `oaa.handoff_from: <previous agent id>` in `metadata`. It is not written when the same agent only changes route.
- **Boundaries**: the handoff note contains only conversation text and file names, never reads file contents, and is not a permission boundary: what the new agent can access is still determined by its own published content and the caller's key.

## Structured output (`structured-output-v1`)

A request that asks for JSON (Chat `response_format` `json_object` / `json_schema`, Responses `text.format`, Gemini `generationConfig.responseMimeType: "application/json"` with `responseSchema` / `responseJsonSchema`, Claude `output_config.format`) becomes an output contract of the run: a successful response is JSON that parses and fits the schema (Ajv: draft-07, 2019-09 and 2020-12, with `format` enforced), or the run fails with `structured_output_invalid` (422; Responses: `status: "failed"`). The agent's answer is held until it is checked, so a stream delivers the final JSON in one piece, with heartbeats in between. A wrong answer is sent back for correction (`structuredOutput.maxRepairs`, default 1; external agents only when their session can be continued). A schema the gateway cannot honestly enforce is refused at request time with `output_schema_unsupported` (or `invalid_schema` / `schema_dialect_unsupported`). Details, limits and the exact rules: [structured-output.md](structured-output.md).

## Workflow return contract

`workflow-output-v1` in `GET /health` means the gateway supports a workflow's `output` / `outputSchema` and the dynamic `execute_graph.output`; `oaa-lang-roundtrip-v1` means DSL formatting recompiles and compares the contract. Neither requires clients to change existing requests: when no return projection is specified, the full step results are still returned. See the [OAA-Lang execution contract](language.md).

## Run-event webhooks (`webhooks-v1`)

Owner-wide admin keys can register HTTPS endpoints that receive run events: `run.requires_action`, `run.completed`, `run.failed`, `run.cancelled`, `run.incomplete` and `run.interrupted` (one per run status of the state machine), plus `webhook.test`. The full description, payload, signature check and a walkthrough are in [webhooks.md](webhooks.md); this is the summary.

| Endpoint | Body / result |
| --- | --- |
| `GET /v1/webhooks` | `{data: [endpoint]}` |
| `POST /v1/webhooks` | `{url, events?, agents?, include_output?, enabled?, description?, allow_insecure_http?, allow_private_network?}` → 201 endpoint plus `secret` (returned only here and by rotation) |
| `GET /v1/webhooks/{id}` | endpoint |
| `PATCH /v1/webhooks/{id}` | any field of `POST` → endpoint |
| `DELETE /v1/webhooks/{id}` | 204; queued deliveries are deleted |
| `POST /v1/webhooks/{id}/rotate-secret` | `{id, secret}` |
| `POST /v1/webhooks/{id}/test` | 202 delivery (`webhook.test`) |
| `GET /v1/webhooks/{id}/deliveries?limit=20` | `{data: [delivery]}`, newest first, `limit` at most 200 |
| `POST /v1/webhooks/{id}/deliveries/{delivery}/redeliver` | 202 delivery (same delivery ID) |

- Other keys get 403 `scope_denied`; another owner's endpoint is 404 `webhook_not_found`. Callers cannot pass a callback URL with a request.
- Each request is `POST` with a JSON body `{id, type, created_at, data}`; `data` is a run summary (`run_id`, `agent`, `agent_version`, `status`, `error`, `usage`, `key_id`, `subject`, times, and `pending_actions` on `run.requires_action`), never the task input; the final output only with `include_output: true` (at most 32 KiB, marked `truncated`).
- Headers: `X-OAA-Signature: t=<seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`, `X-OAA-Event`, `X-OAA-Delivery` (unchanged across retries), `User-Agent: OpenAgentAPI/<version>`.
- Delivery is at least once from a durable queue: 10-second timeout, no redirects, `2xx` is success, 6 attempts with backoff from about 5 seconds to 30 minutes; one delivery at a time per endpoint.
- URLs: `http`/`https` only, no credentials, `https` except for loopback (unless `allow_insecure_http`); under `security.profile: "public"` private, loopback, link-local and metadata targets are refused unless `allow_private_network`.

## Developer platform

Exists only when the gateway has a `platform` section configured, and `features` in `/health` contains `platform-v1`; when it is not configured, all the paths below are 404 `route_not_found` and `/openapi.json` does not contain them. For positioning, configuration, billing rules and operating flow see [platform.md](platform.md); only the endpoints are listed here. Error responses keep the shape `{ "error": { "code", "message", "type" } }`, and the new `platform` error codes are in the "Developer platform errors" subsection of the "Error codes" chapter of this document. Amounts are in credits, times are millisecond timestamps, and the `next_cursor` for paging is a number or `null`.

**The two kinds of credentials are not interchangeable**: the portal session token `oas_…` (`Authorization: Bearer`) is used only for the session endpoints under `/v1/portal/*`; using an API key `sk-oaa-…` (the older `oaa_…` too) on them gives `session_invalid` (401); using a session token on a calling endpoint (such as `/v1/responses`) gives `unauthorized` (401). `/v1/portal/*`, `/portal` and `/portal/*` do not require an API key; the Host allowlist and Origin check still apply, and they are available on both the console domain and the API domain.

### Public endpoints (no credentials)

| Method and path | Description |
| --- | --- |
| `GET /v1/portal/site` | `{site_name, registration, base_url, endpoints, version}`; `endpoints` is the same directory as `GET /v1/me`, and `version` comes from the same source as `/health` |
| `GET /v1/portal/agents` | `{data: ListedAgent[]}`, only agents that are listed and whose agent is published |
| `GET /v1/portal/agent?id=` | One `ListedAgent`; 404 `agent_not_found` if not listed |
| `POST /v1/portal/signup` | `{email, password, name?, invite_code?}` → 201 `{account, session}`; rate limited by source IP |
| `POST /v1/portal/login` | `{email, password}` → `{account, session}`; rate limited by source IP and email |
| `POST /v1/portal/password-reset` | `{email, code, new_password}` → 204, and all sessions of that account are invalidated; rate limited by source IP and email (same numbers as login); an email that does not exist, a wrong, expired or used code all give 400 `invalid_code` |

### Portal session endpoints (`Authorization: Bearer oas_…`)

| Method and path | Description |
| --- | --- |
| `POST /v1/portal/logout` | 204 |
| `GET /v1/portal/account` | `{account}` |
| `POST /v1/portal/account/password` | `{current_password, new_password}` → 204, and all sessions of that account are invalidated |
| `GET /v1/portal/keys` | `{data: PortalKey[]}`, newest first; deleted keys are not listed |
| `POST /v1/portal/keys` | `{name}` → 201 `PortalKey + {token}`, the plaintext appears only this once |
| `DELETE /v1/portal/keys/:id` | 204; the key stops working immediately and no longer appears in the list |
| `POST /v1/portal/redeem` | `{code}` → `{account, credited}` |
| `GET /v1/portal/usage?days=30` | `Usage`, `days` is 1-90 |
| `GET /v1/portal/ledger?limit=50&cursor=` | `{data: LedgerEntry[], next_cursor}`, newest first |
| `GET /v1/portal/runs?limit=20&cursor=&agent=` | `{data: RunItem[], next_cursor}`, the tasks started by this account (from the `kind: run` rows of the ledger), newest first; `agent` is optional |
| `GET /v1/portal/runs/:id` | `RunDetail`; 404 `run_not_found` if the task is not this account's or does not exist |

`RunItem` is `{id, agent, status, tokens, charge, created_at}`; `RunDetail` is `{id, agent, status, created_at, completed_at, usage, error, charge, price, output_text, timeline}`. `status` matches the ledger row (`in_progress` before settlement, and the run's terminal status after settlement); `charge` is the credits already charged (a positive number); `price` is the price recorded when the task started; `usage` is the run's usage object passed through as is; `error` is `{code, message}` or `null`; `output_text` is the final output text (segments joined by blank lines, the same as `GET /v1/runs/:id/output.txt`), truncated and ending with `…` beyond 200,000 characters; `timeline` is the response object of `GET /v1/runs/:id/timeline` passed through as is; `completed_at` is when the run entered a terminal status, `null` if not ended. When the run has been cleaned up but the ledger row remains, `timeline` is `null`, `output_text` is an empty string, and `usage`, `error` and `completed_at` are `null`.

### Operator endpoints (`/v1/platform/*`)

These require an owner-level admin key (the `admin` permission and `agents` containing `*`) that belongs to the platform's `owner`; otherwise 403 `scope_denied`. Admin keys can be used only on the console domain (on the API domain it is `admin_host_denied`). Exception: `GET /v1/platform/accounts` and `POST /v1/platform/accounts/:id/credit` also accept a key with the `billing` permission whose owner equals the platform `owner` (for payment callbacks); `billing` is not `admin` and is not limited by `consoleHosts`; when it calls `credit`, `amount` must be greater than 0, and a deduction gets 403 `scope_denied`. `billing` grants no other endpoint.

| Method and path | Description |
| --- | --- |
| `GET /v1/platform/setup` | `{enabled, source, managed_by_config, pending_restart, owner, settings, desired}`; also available when the platform is not enabled (feature `platform-setup-v1`), and requires an owner-level admin key; the settings belong to the owner that enabled it first, and any other owner gets 403 `scope_denied` |
| `PUT /v1/platform/setup` | `{enabled, site_name?, registration?, signup_credits?}` (strictly validated) → the same as GET; saved in the gateway database and effective after restart; writes the audit `platform_setup`; 409 `platform_managed_by_config` when the configuration file has a `platform` section |
| `GET /v1/platform/summary` | Account count, total balance, cumulative consumption, task count, token count, listing count |
| `GET /v1/platform/accounts?query=&limit=&cursor=` | `{data: AdminAccount[], next_cursor}` |
| `POST /v1/platform/accounts` | `{email, password, name?, credits?}` → 201 `{account}`, not limited by `registration` |
| `POST /v1/platform/accounts/:id/status` | `{status: "active" \| "disabled"}` → `{account}`; writes an audit |
| `POST /v1/platform/accounts/:id/credit` | `{amount, note, reference?}`, positive or negative, and the result must not go below 0 (402 `insufficient_balance`) → `{account, entry}`; writes an audit. `reference` is an external reference of 1-200 characters: submitting the same reference again does not credit again and returns the first `{account, entry}` with an extra `duplicate: true` (no extra audit); a different amount or account than the first time gets 409 `reference_conflict`. An `entry` credited with a reference has an extra `reference` field; other ledger rows do not carry it |
| `POST /v1/platform/accounts/:id/password` | `{new_password}` → 204; writes an audit |
| `POST /v1/platform/accounts/:id/reset-code` | none → 201 `{code, expires_at}`, the plaintext appears only this once, valid for 24 hours and for one use, and generating a new code invalidates the old one; writes an audit (`platform_password_reset`, with `detail` of `reset_code`) |
| `GET /v1/platform/accounts/:id/ledger?limit=&cursor=` | `{data: LedgerEntry[], next_cursor}` |
| `GET /v1/platform/listings` | `{data: Listing[]}` |
| `PUT /v1/platform/listings` | `{agent_id, title?, summary?, tags?, price?, enabled?, host_execution?}` → `Listing`; 404 `agent_not_found` if the agent does not exist; 400 `usage_pricing_unsupported`; see [platform.md](platform.md#offering-external-agents) for `host_execution` |
| `DELETE /v1/platform/listings?agent_id=` | 204; 404 `listing_not_found` if there is no listing |
| `GET /v1/platform/codes` | `{data: Code[]}`, without plaintext |
| `POST /v1/platform/codes` | `{kind, credits?, max_uses?, count?, expires_at?, note?}` → 201 `{data: (Code + {code})[]}`, the plaintext appears only this once |
| `DELETE /v1/platform/codes/:id` | 204 (revoke) |
| `GET /v1/platform/usage?days=30` | `Usage + {by_account}`; `by_account` has at most 50 accounts, from highest to lowest consumption |

Request bodies are validated strictly, and extra fields get 400 `invalid_request`. When the platform is enabled, after startup the gateway reconciles once the ledger rows whose task is still `in_progress` (without blocking startup): a run that is already terminal is settled by its terminal status (an interrupted run still in the database is settled by the tokens it used), a run record that no longer exists is marked `interrupted` and settled at 0 tokens (usage can no longer be known), and a run still queued or waiting is left alone; reconciliation is idempotent. When an account key calls `GET /v1/me`, the response has an extra `account: {id, balance}`; responses for other keys are unchanged.

### Audit and pages

Adjusting a balance, disabling or enabling an account, and resetting a password each write one audit record (`GET /v1/audit`) on success, with the error codes `platform_credit_adjusted`, `platform_account_status` and `platform_password_reset`; a record carries `account_id` and a one-line, secret-free `detail` (such as `amount=-5 balance_after=10`, `status=disabled`), and contains no passwords, notes or redeem codes. The portal page is at `/portal/` (static files in `web/portal/`, with the same CSP as the console); when `consoleHosts` is configured, `GET /` on a non-console hostname redirects to `/portal/`.

## Error codes (`error.code`)

> Added 2026-11-07.

HTTP error responses use the shape `{"error":{"code":"…","message":"…","type":"invalid_request_error"}}` by default; OpenAI-compatible entries add `param`, and the Claude and Gemini entries use their own protocols' shapes, with the gateway error code in Claude's `error.code` and Gemini's `details[0].reason` (see [Compatibility-endpoint parameters, errors and finish reasons](#compatibility-endpoint-parameters-errors-and-finish-reasons-060)). `code` is a stable, machine-readable identifier: clients should branch on `code` and localize it themselves; `message` is for reading only, may change, and should not be parsed. The `error.code` of a run (response) object uses the same set of codes. Framework-level errors are also mapped to stable codes: malformed JSON is `invalid_json`, an oversized request body is `payload_too_large`, an unsupported Content-Type is `unsupported_media_type`, a malformed multipart body is `invalid_multipart`, and an unknown route or method is `route_not_found`; any other unclassified 4xx is `invalid_request`, and an unclassified server-side exception is `execution_failed`. Failures of a remote worker pass through the worker's own error code (default `worker_failed`), and a subagent failure passes through the child run's error code (`effect_outcome_unknown` when the child run's outcome is unknown and the delegating step is not read-only, and `delegate_timeout` when the delegation times out); a child run's artifacts are not merged into the parent run and are given only as references in the `artifacts` of the delegation result. A test checks that every error code appearing in the source is listed in this chapter.

All error codes are registered in the error catalog in `src/core/errors.ts`, and can also be read through `GET /v1/errors` (requires `read` permission): it returns `{ object: "list", revision, categories, data }`, where each item of `data` is `{ code, status, statuses?, category, retryable, zh, next?, en, nextEn?, routeRetryable?, fallbackExempt?, uncertainWhenStarted? }` (`en` / `nextEn` are the English versions of `zh` / `next`). The last three are kernel scheduling flags and appear only when `true`: `routeRetryable` means the gateway retries on another route when the first model call fails; `fallbackExempt` means this kind of failure does not trigger a switch to a fallback agent; `uncertainWhenStarted` means that when this error occurs after external execution has started, the side-effect outcome is treated as unknown. A `status` of `null` means the code does not appear as an HTTP response; `retryable` means retrying as is may succeed; `zh` is the Chinese description for users. `revision` is the first 16 hex characters of the sha256 of the catalog content; the response carries an `ETag`, and a matching `If-None-Match` returns `304`. Available when `features` in `/health` contains `error-catalog-v1`.

### Language of error messages (0.0.64)

Error codes and response shapes do not depend on language; only the text of `message` changes with the language:

- For HTTP requests, `Accept-Language` decides: when the explicit language with the highest weight starts with `zh`, Chinese is used; any other explicit language (such as `en-US` or `fr`) gets English. Without this header, or with only `*`, the gateway process's default language is used.
- The process default language: the environment variable `OAA_LOCALE` (`zh` or `en`) takes precedence; otherwise `LC_ALL`, `LC_MESSAGES` and `LANG` are checked in turn (`C` / `POSIX` are skipped), and then the system locale (`Intl.DateTimeFormat().resolvedOptions().locale`); a value starting with `zh` means Chinese and anything else means English. Existing deployments on Chinese systems stay in Chinese, and on English systems the default is English out of the box. The help and prompts of the `oaa` command line also follow the process default language, and the CLI sends the matching `Accept-Language` when it contacts the gateway.
- Most error messages were already in English and are returned unchanged in either language. A few errors that carry Chinese text (ACP agents, local backends, and so on) have both Chinese and English versions, chosen by the rules above; if an error that has only Chinese text occurs under English, the English description of that code from the error catalog is returned, with details such as field names and paths from the original message appended.
- Errors already written into a run record (a run object's `error.message`, error events in a stream) are recorded in the gateway process's default language at the time they occurred and are not converted when read.

### Requests, authentication and limits

| code | HTTP | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | The API key is missing, invalid, or deleted |
| `key_expired` | 401 | The API key has expired |
| `scope_denied` | 403 | The key lacks the required scope, or cannot access this agent or resource |
| `quota_exceeds_own` | 403 | A new key's quota cannot exceed the quota of your own key |
| `invalid_host` | 403 | The Host is not in the allowlist |
| `origin_denied` | 403 | The Origin of a cross-origin request is not allowed |
| `admin_host_denied` | 403 | With `consoleHosts` configured, a key with `admin` was used on a non-console hostname |
| `isolation_required` | 403 | The agent (or an agent it delegates to) needs more privileges than the execution level this key allows (`workspace` / `sandbox`) |
| `sandbox_unavailable` | 503 | No node can run a script that requires an OS sandbox; or the worker has no sandbox that passed its self-check and refuses to run on the host |
| `authorization_changed` | 403 | The key's authorization changed during a long-lived connection; reconnect with the current authorization |
| `rate_limited` | 429 | The key exceeded its requests per minute (600 by default) |
| `concurrency_limit` | 429 | The owner has too many active requests |
| `subject_concurrency_limit` | 429 | The same caller (subject) reached `maxActiveRunsPerSubject` unfinished requests |
| `key_concurrency_limit` | 429 | The key reached its concurrent run limit |
| `run_quota_exceeded` | 429 | The key's run quota is used up |
| `token_quota_exceeded` | 429 | The key's token quota is used up |
| `storage_quota_exceeded` | 413 | This caller's stored files have reached the limit |
| `too_many_streams` | 429 | The key (or owner) has too many event streams open at once: 4 overview event streams per key; run event streams (`/events`, `/wait`, `GET /v1/responses/:id?stream=true`, and streaming requests on the compatibility entries) 64 per caller and 256 per owner |
| `invalid_request` | 400/404 | A request field is invalid or missing (404 for a malformed Gemini path) |
| `client_tools_unsupported` | 400 | The request carries caller tools but reject mode was selected; see [harness.md](harness.md) |
| `client_tools_bridge_unsupported` | 400 | Bridge mode was requested, but this agent (an external agent other than ACP) does not support it, or no online execution machine declares `client-tools-v1` (upgrade the execution machine, or use managed) |
| `client_tool_conflict` | 400 | A bridged caller tool has the same name as a published tool, workflow, delegate, `execute_graph`, or another caller tool (the internal alias is compared) |
| `client_tools_too_many` | 400 | Published tools plus caller tools exceed 100 |
| `invalid_client_tool` | 400 | A caller tool's name does not match `^[a-zA-Z0-9_-]{1,64}$`, its format is wrong, or its parameter schema cannot be compiled |
| `output_schema_unsupported` | 400 | The requested output schema (`response_format`, `text.format`, `responseSchema`, `output_config.format`) contains something the gateway cannot honestly enforce: `$async`, a `$ref` outside the document, a `format` nobody implements, a very long or exponentially backtracking regular expression, nesting deeper than 40 levels; rewrite the schema |
| `invalid_json` | 400 | The request body is not valid JSON, or is empty while declared as JSON |
| `payload_too_large` | 413 | The request body or data exceeds the size limit |
| `unsupported_media_type` | 415 | Unsupported Content-Type |
| `unsupported_parameter` | 400 | The strict endpoints (`/v1/chat/completions`, `/v1/responses`) do not support this parameter or value (tools, JSON output formats, forced tool choice, `logprobs: true`, unknown fields); `error.param` is the field name, and `/v1/compat/*` can be used instead |
| `unsupported_content` | 400 | The content block type is not supported (audio, unknown blocks), or the agent does not accept images; `error.param` names the part ([images.md](images.md)) |
| `image_invalid` | 400/500 | The image cannot be used: invalid base64, not PNG / JPEG / GIF / WebP, or the declared type does not match the content ([images.md](images.md)) |
| `image_too_large` | 413 | An image, or all images of one request together, exceed the configured limit |
| `too_many_images` | 400 | The request carries more images than `images.maxImagesPerRequest` |
| `image_fetch_failed` | 400 | The gateway could not fetch an image URL (only with `images.fetchRemote`): redirect, not an image, timeout, private address |
| `protocol_undetected` | 400 | `/v1/universal` cannot tell whether the request is OpenAI Chat or Claude Messages; use a dedicated endpoint or the `X-OAA-Protocol` header |
| `invalid_url` | 400 | The URL cannot be parsed |
| `invalid_multipart` | 400/406 | The multipart body is malformed or not multipart |
| `route_not_found` | 404 | No route matches this method and path |
| `not_found` | 404 | The static asset does not exist |
| `invalid_cursor` | 400 | The event or output cursor is invalid |
| `invalid_idempotency_key` | 400 | The Idempotency-Key format is invalid |
| `idempotency_conflict` | 409 | The same Idempotency-Key was used with different input (the same input with the caller's own provider key `X-OAA-Provider-Key` once and without it once, or with a different key, also counts as different input; the fingerprint includes only the sha256 of the key, and the key itself is never stored) |
| `wait_timeout` | 408 | The wait deadline has passed (the task may still be running) |
| `wait_cancelled` | 499 | The wait was cancelled |
| `shutting_down` | 503 | The gateway is shutting down |
| `gateway_already_running` | 409 | Another gateway process is using the same data directory (at startup) |
| `schema_too_new` | 409 | The data directory comes from a newer gateway version (at startup) |

### Agents, models and catalog

| code | HTTP | Meaning |
| --- | --- | --- |
| `agent_not_found` | 404 | The agent or the requested version does not exist |
| `agent_version_required` | 400 | Paging further details requires the returned agent_version |
| `ambiguous_model` | 400 | Several routes use the same model name; specify the route ID |
| `model_not_supported` | 400 | The selected model is not supported by this agent or backend (the task was not sent) |
| `model_switch_requires_new_session` | 409 | A continued session keeps its original model route; switching models needs a new session |
| `model_unavailable` | 503 | This agent has no available executor right now (engine not installed or not enabled, a provider environment variable missing, or the session-pinned route unavailable) |
| `version_conflict` | 409 | A continued session must keep the original agent version |
| `catalog_capacity` | 429 | Too many catalog views or subscriptions |
| `catalog_changed` | 409 | The authorized listing changed; restart from offset 0 |
| `catalog_closed` | 409 | The catalog subscription is closed |
| `invalid_catalog_cursor` | 400 | The catalog cursor is invalid |
| `invalid_catalog_limit` | 400 | The catalog page size must be between 1 and 32 |
| `metadata_item_too_large` | 413 | A metadata item is too large; use the version-pinned metadata resource |
| `resource_too_large` | 413 | The MCP resource exceeds the 4 MiB limit |
| `invalid_agent_uri` | 400 | The MCP agent resource URI is invalid |
| `invalid_file_id` | 400 | The MCP file URI is invalid |

### Publishing and capability packages

| code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_engine` | 400 | Invalid engine name (a native name or `adapter/<name>`) |
| `backend_not_enabled` | 409 | The adapter is not enabled on any online node, so it cannot be published |
| `bundle_integrity` | 400 | The bundle content digest does not match |
| `bundle_owner_conflict` | 409 | This bundle digest belongs to another owner |
| `bundle_too_large` | 400/413 | The bundle exceeds the size limit |
| `invalid_manifest` | 400 | The bundle manifest is invalid |
| `invalid_skill` | 400 | SKILL.md is invalid, for example missing YAML frontmatter |
| `missing_script` | 400 | A referenced script is not in the bundle |
| `missing_skill` | 400 | A referenced skill is not in the bundle |
| `metadata_too_deep` | 400 | Capability metadata is nested too deeply |
| `secret_in_bundle` | 400 | Public metadata appears to contain a credential; publishing was refused |
| `unsafe_bundle` | 400 | A bundle path is forbidden or duplicated |
| `oaa_syntax_error` | 400 | OAA-Lang source has a syntax error or exceeds a compiler limit |
| `oaa_roundtrip_error` | 400 | The formatted source compiles to a different contract than the original; refusing to output source that could change execution behavior |
| `oaa_validation_error` | 400 | The OAA-Lang syntax is valid, but a declared value violates the agent contract (such as `max_turns = 0` or an invalid engine name); the error carries the line and column of the offending declaration |
| `invalid_schema` | 400 | The JSON Schema is invalid or references an unavailable external schema |
| `schema_dialect_unsupported` | 400 | Async JSON Schema is not supported |

### Run lifecycle

| code | HTTP | Meaning |
| --- | --- | --- |
| `run_not_found` | 404 | The run (response) does not exist |
| `session_busy` | 409 | This session already has a task in progress |
| `invalid_continuation` | 409 | A continuation needs a completed response from the same agent |
| `invalid_run_transition` | 500 | Invalid run status transition; the write was rejected (internal error; for valid transitions see [architecture.md](architecture.md#32-run-state-machine), section 3.2 "Run state machine") |
| `not_resumable` | 409 | Only runs in the interrupted state can be resumed |
| `reconciliation_required` | 409 | Uncertain side effects must be reconciled before resuming |
| `run_not_attached` | 409 | The run shows as in progress but is not executing in this gateway process (inconsistent data, or held by another process); the cancel request was not accepted |
| `run_key_inactive` | 409 | The key that owns the run has expired, been revoked or deleted (or its account no longer exists), so the run cannot be resumed. This appears when the owner's admin key resumes another key's run; when the original key resumes by itself, expiry and revocation are already rejected at authentication with `key_expired` / `unauthorized` |
| `invalid_reconciliation` | 409 | No matching step is waiting for reconciliation |
| `effect_outcome_unknown` | 409 | The outcome of an operation with side effects is unconfirmed (the run is marked interrupted) |
| `gateway_restarted` | — | A gateway restart interrupted execution (run error code) |
| `run_timeout` | — | The run passed its deadline (run error code, status incomplete) |
| `cancelled` | 409 | The task was cancelled |
| `turn_limit` | — | The agent reached its turn limit (run error code, status incomplete; on the compatibility entries a non-streaming request returns 422 with `x-should-retry: false` because the run did not end normally, and a stream reports the error inside the stream) |
| `token_budget` | — | The observed token budget was reached (run error code, status incomplete; behaves like `turn_limit` on the compatibility entries) |
| `max_output_tokens` | — | The model output was truncated (run error code, status incomplete; each compatibility entry returns the truncation as a normal 200) |
| `context_limit` | 409 | The context exceeds 2 MB (2,000,000 bytes); start a new session |
| `output_contract` | 422 | The final answer does not match the declared output schema |
| `structured_output_invalid` | 422 | Structured output was requested, but the agent's answer, even after the correction rounds, is not JSON that fits the request; `error.message` names the first problem, never the answer itself |
| `output_too_large` | 413/502 | The agent output exceeds the limit |
| `files_too_large` | 413 | Input files exceed 8 MiB in total |
| `workspace_too_large` | 413 | The workspace transfer exceeds the limit |
| `delegation_depth_exceeded` | 409 | Subagent delegation is nested too deeply |
| `subagent_failed` | 502 | A subagent ended as failed without a specific error code (`subagent_${status}`) |
| `subagent_cancelled` | 502 | A subagent ended as cancelled without a specific error code (`subagent_${status}`) |
| `subagent_interrupted` | 502 | A subagent ended as interrupted without a specific error code (`subagent_${status}`) |
| `subagent_incomplete` | 502 | A subagent ended as incomplete without a specific error code (`subagent_${status}`) |
| `delegate_timeout` | 504 | A delegated subagent did not finish within the delegation timeout (the child run was cancelled) |
| `parent_interrupted` | — | The parent run is no longer active, so the queued child run will not execute (run error code, status cancelled) |
| `capability_unavailable` | 503 | A required execution capability is unavailable right now |
| `node_draining` | 503 | The node that could run this task is draining |
| `action_required` | 422 | Compat endpoint: the task is waiting for an approval and the run was created (non-streaming Chat / Claude / Gemini; carries `x-should-retry: false`, do not resend) |
| `requires_action` | 409 | Compat endpoint: the run is in requires_action |
| `incomplete` | 422 | Compat endpoint: the run did not complete |
| `persistence_failed` | 500 | The output could not be persisted; execution stopped |
| `step_checkpoint_failed` | 500 | A tool result could not be committed; execution stopped |
| `invalid_output_event` | 500 | Invalid output event transition (an internal invariant was broken) |
| `execution_failed` | 500/502 | Unclassified execution failure |

### Approvals and steps

| code | HTTP | Meaning |
| --- | --- | --- |
| `approval_expired` | 409 | The approval has expired |
| `client_tool_timeout` | 409 | The caller did not return the caller tool's result within `approvalTimeoutMs`, and the run ended as `failed` |
| `client_tool_abandoned` | 409 | The external agent (through the `oaa-caller` relay) gave up on the call before the caller returned a result (it closed the MCP server, or restarted it after its MCP request timed out): the corresponding step fails with this code and the pending action is marked `expired`, but the run does not fail because of it; returning this `call_id` later does not continue anything (it is handled as a new request) |
| `action_kind_mismatch` | 409 | `POST /v1/runs/{id}/actions/{action}` points to a `client_tool` pending action, which can only be answered by the caller returning a result through the bridge |
| `approval_not_found` | 404 | The approval does not exist |
| `stale_approval` | 409 | The approval is no longer pending |
| `permission_denied` | 403 | The operation was not approved; a process ending normally cannot be taken as success. The same for every access method: an owner denial (Codex's `declined` item, Claude's `permission_denials`, an ACP / `oaa/1-stream` refusal, a kernel tool approval) fails with this code |
| `tool_denied` | 403 | This tool or graph execution is disabled |
| `step_not_found` | 404 | The execution step does not exist |
| `step_scope_mismatch` | 403 | The step belongs to another run |
| `invalid_step_artifact` | 403 | The step artifact does not belong to this run |
| `invalid_step_checkpoint` | 409 | The step checkpoint does not match the run |

### Files and memory

| code | HTTP | Meaning |
| --- | --- | --- |
| `file_not_found` | 404 | The file does not exist |
| `file_too_large` | 413 | The file exceeds 8 MiB |
| `file_required` | 400 | The multipart upload has no file part |
| `file_integrity` | 400/500 | The file content digest does not match |
| `invalid_file` | 400/413 | A file field, reference, or size is invalid |
| `invalid_file_field` | 400 | Only purpose=user_data or assistants is supported |
| `invalid_path` | 400 | The path must be relative and must not traverse upward |
| `data_placement_denied` | 403 | Input files are not allowed to be sent to this node |
| `memory_too_large` | 413 | The memory entry exceeds 256 KB |
| `artifact_integrity` | 502 | The native artifact digest does not match |
| `artifacts_too_large` | 413 | The native artifact export exceeds the limit |
| `unsafe_artifact` | 403 | The artifacts contain a symbolic link; automatic export was refused |

### Tools, graphs and MCP

| code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_tool_arguments` | 400 | The tool arguments do not match the schema |
| `tool_not_published` | 403 | The tool is not published in this bundle |
| `result_export_denied` | 403 | This capability does not allow results to leave the executor |
| `capability_bound_elsewhere` | 403 | The capability is bound to another host |
| `capability_mismatch` | 403 | The node's tool metadata does not match the published binding |
| `manifest_mismatch` | 403 | The executed content does not match the published agent |
| `script_disabled` | 403 | This worker does not allow this script runtime |
| `skill_not_published` | 404 | The file is not in the bundle |
| `invalid_tool_calls` | 502 | The model returned duplicate or invalid tool call IDs |
| `invalid_tool_result` | 502 | The worker returned an invalid tool result |
| `tool_arguments_too_large` | 502 | The tool arguments from the model exceed the limit |
| `invalid_graph` | 400 | The execution graph is invalid |
| `invalid_graph_output` | 400 | The graph's return projection references a missing step or an out-of-scope variable |
| `workflow_output_contract` | 422 | The workflow result does not match the published output contract; no further model turn starts and confirmed tool operations are not rolled back |
| `invalid_concurrency` | 400 | The concurrency limit of a graph or leaf pool must be a positive integer |
| `invalid_expression` | 400 | A graph expression is invalid or exceeds a limit |
| `invalid_reference` | 400 | A graph reference (JSON pointer) is invalid |
| `expression_budget_exceeded` | 400 | An expression result exceeds its budget |
| `foreach_limit_exceeded` | 400 | The foreach item count exceeds max_items |
| `unsafe_graph_fallback` | 400 | A fallback cannot mask a non-idempotent write |
| `unsafe_graph_retry` | 400 | A step's `retry` / `timeout_ms` is used on a tool that modifies state and cannot be safely retried (`write` / `unknown`) |
| `step_timeout` | 504 | One attempt of a step in an execution graph exceeded its declared `timeout_ms`; the run fails only after retries are used up |
| `mcp_unconfigured` | 503/400 | The selected MCP server is not configured on this worker |
| `mcp_connection_failed` | 503 | The MCP server failed to initialize |
| `mcp_connection_retired` | 503 | The MCP connection was replaced before execution; retry |
| `mcp_credentials_unavailable` | 503 | The declared MCP credential environment variable is not available |
| `mcp_executable_unavailable` | 503 | The MCP executable is not available |
| `mcp_tool_not_found` | 404 | The MCP server does not list this tool |
| `mcp_tool_changed` | 409 | The MCP tool metadata changed; prepare a new capability version |
| `mcp_tool_failed` | 502 | The MCP tool returned isError=true |
| `mcp_ambiguous_tool` | 502 | The MCP server returned duplicate tool names |
| `mcp_catalog_limit` | 400/502 | MCP tool discovery exceeded the paging limit |
| `mcp_invalid_catalog` | 502 | MCP tool paging did not advance |

### Model providers

| code | HTTP | Meaning |
| --- | --- | --- |
| `provider_unavailable` | 503 | No model provider is configured on this node |
| `model_not_configured` | 503 | The provider API key environment variable is not set |
| `upstream_rate_limited` | 429/502 | The upstream model is rate limited |
| `upstream_failed` | 429/502 | The upstream model response failed |
| `upstream_incomplete` | 502 | The upstream model ended for an abnormal reason |
| `upstream_truncated` | 502 | The upstream response ended without a final message |
| `upstream_output_limit` | 502 | The upstream HTTP response exceeded 8 MiB in total, or an SSE event exceeded 2 MiB; reading stopped and the connection was released |
| `upstream_timeout` | 504 | The Anthropic/Gemini request exceeded the configured provider deadline; this is not a user cancellation |
| `invalid_model_result` | 502 | The worker returned an invalid model result |
| `invalid_provider_key` | 400 | `X-OAA-Provider-Key` is malformed (only 1-4096 visible ASCII characters are allowed), or the header appeared more than once |
| `byok_not_supported` | 400 | A caller-supplied key applies only to kernel agents; or this node's provider does not have `byok` enabled; or the resumed run did not use a caller key in the first place |
| `provider_key_required` | 400 | A `sandbox`-level key calling a native agent in the sandbox must send `X-OAA-Provider-Key` (only the caller's own key is used) |
| `byok_key_required` | 409 | The run uses the caller's key, but the gateway no longer holds it (restart or expiry); resume again with `X-OAA-Provider-Key` |
| `invalid_provider_state` | 502 | The provider's native turn state (Provider Turn State) is missing, malformed, failed verification, does not match the normalized result, or the underlying SDK cannot replay it safely; this indicates corrupted or tampered state, and the caller should start a new session |
| `provider_state_mismatch` | 409 | The provider protocol, endpoint, model, tools, or conversation prefix changed on continuation, or native state was replayed across incompatible protocols; the caller must restore the original configuration or start a new session |
| `provider_state_too_large` | 413 | The provider's native state for one turn exceeds the 2 MiB limit; the caller should trim that turn's output or tool data, or start a new session |
| `provider_state_unsupported` | 502/503 | The worker node or driver cannot keep the provider's native turn state, the gateway did not negotiate native-state capability, or the streamed output contains state deltas that cannot be kept safely; the caller must route to a supported node or start a new session |

### Native agents and adapters (including ACP)

| code | HTTP | Meaning |
| --- | --- | --- |
| `native_disabled` | 503 | This native engine is not enabled on the worker |
| `native_incomplete` | 502 | The native agent did not finish or exited early; an `oaa/1-stream` adapter exited without a result; an A2A stream ended without a final status, or the agent cancelled the task |
| `native_truncated` | 502 | The native agent ended without a result |
| `image_delivery_failed` | 502 | Handing an image to an external agent failed (the image file is missing from the task workspace) ([images.md](images.md)) |
| `native_closed` | 502 | The native agent process has closed |
| `native_protocol_error` | 502 | Native/ACP protocol error, or the agent rejected the request |
| `native_model_mismatch` | 409 | The agent did not confirm the selected model (the task was not sent) |
| `native_resume_unsupported` | 409 | The agent cannot continue the previous session |
| `adapter_disabled` | 503 | The adapter is not enabled |
| `adapter_not_configured` | 503 | The token environment variable required by the adapter is not set |
| `adapter_unavailable` | 503 | The adapter process cannot start |
| `adapter_auth_required` | 503 | The external agent (an ACP agent, the built-in Claude Code, and so on) requires signing in through its own CLI first; or the A2A endpoint returned 401/403 |
| `adapter_timeout` | 504 | The ACP handshake timed out |
| `adapter_failed` | 502 | The HTTP / A2A adapter returned an error status or a JSON-RPC error; the A2A handshake check could not find an agent card |
| `adapter_incomplete` | 502 | The adapter reported the task as incomplete (an A2A task `failed` / `rejected`); the error text provided by the adapter is redacted |
| `adapter_output_limit` | 502 | The adapter output exceeded 2 MiB (8 MiB for an A2A response or stream) |
| `approval_failed` | 500 | Internal error in the approval bridge |
| `event_failed` | 500 | Writing an event failed |
| `process_failed` | 502 | A managed child process exited with a non-zero code |
| `invalid_protocol` | 502 | The worker or child process emitted invalid protocol data (including an unknown `oaa/1-stream` message type and invalid A2A JSON) |

### Local backends and nodes

| code | HTTP | Meaning |
| --- | --- | --- |
| `backend_not_configured` | 404 | The local worker configuration has no such backend |
| `backend_unavailable` | 409 | The backend executable is missing or not executable; it was not enabled |
| `backend_conflict` | 409 | On one-step enablement, a different kind of adapter with the same name already exists in the local configuration; it will not be overwritten |
| `worker_required` | 409/400 | On one-step enablement, the configuration file has no local execution machine (`localWorker`); the command line also produces this code locally |
| `check_unsupported` | 400 | Handshake checks apply only to ACP and A2A adapters |
| `local_node_policy` | 409 | Remote credential controls cannot change the local worker |
| `node_not_found` | 404 | The node registration does not exist |
| `node_exists` | 409 | This node ID is already registered |
| `node_owner_conflict` | 409 | The node identity is held by another owner |
| `node_revoked` | 409 | The node has been revoked (irreversible) |
| `node_policy_integrity` | 500 | The node policy record is inconsistent |
| `node_already_connected` | 409 | A node with the same identity is already connected |
| `node_identity_reserved` | 409 | This local node ID is reserved by a remote lifecycle policy |
| `node_credentials_conflict` | 409 | Node credential identities are not unique (at startup) |
| `node_scope_denied` | 403 | The node advertised more than it is authorized for |
| `node_disconnected` | 503 | The worker connection closed |
| `node_backpressure` | 503 | The worker connection exceeded its buffer limit |
| `queue_full` | 429 | The node queue is full |
| `work_timeout` | 504 | The worker exceeded the execution deadline |
| `worker_failed` | 502 | The remote worker failed (when no specific code was given) |
| `worker_capacity_exceeded` | 503 | The remote worker is at capacity and refused the new task |
| `invalid_context` | 403 | The worker ownership or session does not match |
| `bundle_not_loaded` | 409 | The required bundle is not installed on the worker yet |
| `insecure_endpoint` | 400 | Remote endpoints must use TLS and must not contain credentials |
| `invalid_credential` | 500 | A service or node token is shorter than 24 characters (configuration error) |
| `key_not_found` | 404 | No API key with that ID exists for this owner |
| `node_authentication_denied` | — | Worker side: the gateway rejected the node credential; reconnecting stopped |
| `node_connection_failed` | — | Worker side: could not connect to the gateway |
| `invalid_config` | 400 | Worker side: invalid configuration (for example, missing gatewayUrl); produced only when a worker process starts locally (`connectWorker`) and never returned as an HTTP response; 400 is the default status of `Fault` |

### Developer platform errors

Present only when the gateway has a `platform` section configured.

| code | HTTP | Meaning |
| --- | --- | --- |
| `registration_closed` | 403 | This site does not allow self-service sign-up |
| `invite_required` | 403 | Sign-up requires an invite code |
| `invalid_code` | 400 | The redeem, invite, or reset code is invalid, used up, expired, or already used by this account |
| `email_taken` | 409 | The email is already registered |
| `invalid_credentials` | 401 | Incorrect email or password |
| `session_invalid` | 401 | The portal session is invalid or has expired |
| `account_disabled` | 403 | The account is disabled (both sessions and account keys are rejected) |
| `account_not_found` | 404 | The account does not exist |
| `insufficient_balance` | 402 | Insufficient balance (rejected at task submission before a run is created; also returned when an operator's balance adjustment would take the result below 0) |
| `key_limit_reached` | 409 | The account has reached its key limit |
| `listing_not_found` | 404 | This agent has no listing |
| `usage_pricing_unsupported` | 400 | A listing sets a per-token price for an agent that does not report token usage (only per-run prices are accepted for it) |
| `code_not_found` | 404 | The redeem code does not exist |
| `reference_conflict` | 409 | This external reference was already used for a credit with a different amount, or for another account |
| `platform_managed_by_config` | 409 | The configuration file already has a `platform` section, so `PUT /v1/platform/setup` cannot change the platform settings |

### Webhook errors

Returned by the `/v1/webhooks` endpoints ([webhooks.md](webhooks.md)).

| code | HTTP | Meaning |
| --- | --- | --- |
| `webhook_not_found` | 404 | No webhook endpoint with that ID (for this owner) |
| `webhook_url_invalid` | 400 | Invalid webhook URL: only http/https without user name or password, and https for anything but loopback (unless `allow_insecure_http`) |
| `webhook_target_denied` | 400 | Under the `public` security profile the URL points at a private, loopback, link-local or metadata address (unless `allow_private_network`) |
| `webhook_limit_reached` | 409 | The owner already has 20 webhook endpoints |
| `webhook_delivery_not_found` | 404 | No delivery with that ID for this endpoint |
| `webhook_delivery_pending` | 409 | The delivery is still queued and cannot be redelivered yet |

### Placement reason codes (`reasons[].code`)

These appear in the `reasons` of agent availability and route checks and explain why a node or route is currently unavailable; they are not HTTP errors: `agent_scope`, `agent_node_restriction`, `session_node_affinity`, `file_node_restriction`, `provider_unavailable`, `tool_selection_unreported`, `capability_scope`, `native_disabled`, `native_model_unsupported`, `native_model_unreported`, `host_binding`, `result_export_denied`, `builtin_unreported`, `script_runtime_disabled`, `capability_unavailable`, `capability_mismatch`, `byok_unsupported` (this node's provider does not accept a caller key), `provider_state_unsupported` (the worker cannot keep the provider's native turn state), `sandbox_unavailable` (the node has no script sandbox that passed its self-check), `no_online_nodes`, `node_busy`, `node_draining`, `node_revoked`, `target_cooling_down`, `required_tool_unavailable`.

### CLI and client-local only

These are produced locally only by the `oaa` command line or `GatewayClient` and are never returned by the gateway: `arguments`, `unknown_command`, `dsh_overlay_required`, `exposure_conflict`, `native_not_installed`, `node_startup_failed`, `startup_failed`, `startup_timeout`, `tunnel_binary_missing`, `tunnel_exited`, `tunnel_timeout`, `worker_required`, `output_exists`, `tool_conflict`, `mcp_descriptor_too_large`, `mcp_task_mode_unsupported`, `host_binding` (on tool import, the selected tool belongs to another node), `gateway_error`, `gateway_response_too_large`, `gateway_timeout`, `invalid_gateway_path`, `invalid_gateway_response`, `request_cancelled`, `token_required`, `gateway_unreachable` (the gateway cannot be reached), `not_running` (`oaa stop` finds no gateway started with `--detach`), `port_in_use` (the port `oaa quickstart` needs is taken), `sample_agent_missing` (the bundled offline sample agent cannot be found), `agent_conflict` (`oaa connect` does not overwrite an agent of the same name on another engine), `approval_ambiguous` (the run given to `oaa approve` / `oaa deny` has several pending approvals and none was chosen), `approval_declined` (the answer at the `oaa approve` confirmation was no).
