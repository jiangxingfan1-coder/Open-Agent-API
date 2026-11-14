# Two-layer harness: when the caller is itself an agent

English · [简体中文](zh-CN/harness.md)

## What the problem is

A traditional call is "app → model". OAA is "app → agent → model". And the caller is often an agent itself (Cursor, Cline, Codex CLI, Claude Code, assorted agent SDKs): it has its own loop, its own system prompt, and its own tools, and it calls OAA as if it were a "model". So one call involves two harnesses (tool loops):

```text
Outer harness (the caller agent: its own tools, its own loop)
      │  OpenAI / Claude / Gemini protocol — it thinks a model is on the other side, and the request carries tools
      ▼
OAA kernel (admission, identity, persistence, approval, events)
      │
      ▼
Inner harness (the published agent: the kernel loop, or the loop of a Codex / Claude Code / ACP agent)
      │
      ▼
    model
```

Each layer has its own set of tools. If the outer `tools` were silently dropped, lines in the outer system prompt such as "you must call edit_file" would reach the inner agent unchanged, and the inner agent has no such tool, so it tends to invent a tool call in its text. That is why OAA lets the caller choose explicitly what happens to the outer tools.

## The modes

| Mode | Meaning | Who runs the tools | When to use |
| --- | --- | --- | --- |
| `auto` (default) | The gateway decides when the agent is known: when the agent can take the caller's tools over it behaves as `bridge`, otherwise it does what the entry did before (see "What auto does") | As in the mode it picks | Almost always: callers do not have to know which kind of agent is behind the name |
| `managed` | The inner agent completes the task on its own. The tools passed by the outer layer are not run, and this is stated explicitly: the response header `X-OAA-Client-Tools: ignored`; in addition, a fixed note is appended to the input given to the agent (external tools are not available here; complete the task with your own tools and give the result directly, and do not write tool calls in the text) | The inner agent | Wiring an OAA agent into an existing tool as "a model that does the work by itself", or keeping the behaviour of versions before `auto` |
| `bridge` | The outer tools are projected to the inner agent; when the inner agent calls one, the run parks and returns it to the caller as standard `tool_calls`; the caller runs it and sends the result back, and the same run carries on | The caller (initiated by the inner agent) | The tool must run on the caller's machine (for example editing files in the caller's workspace) |
| `reject` | Any request that passes tools fails with `client_tools_unsupported`, with no fallback | — | Callers that need strict semantics and do not accept tools being ignored |

> **Bridge is available for built-in kernel agents and ACP external agents, and supports Chat Completions, Responses, Claude Messages, and Gemini `generateContent`.** Requesting `bridge` for an external agent that cannot bridge returns `client_tools_bridge_unsupported` (400), and UAP/1 does not accept a `tools` field; in these cases no run is created.

## What auto does

A request that declares tools and chooses no mode gets `auto` (the gateway configuration `clientTools.default` can change that default to `managed`, `bridge` or `reject`; an explicit `auto` in the header beats the configuration). The rule, with the agent known at submit time:

1. The agent can take the tools over (kernel agent, or an ACP agent with an online execution machine that declared `client-tools-v1` for it), the tools are plain functions with names that do not collide with the agent's own, and no tool choice is forced: the request is handled as `bridge`. The response carries `X-OAA-Client-Tools: bridge`; the agent's calls come back as `tool_calls` / `function_call` / `tool_use` / `functionCall`.
2. Anything else gets what the entry did before. OpenAI's default endpoints (`/v1/chat/completions`, `/v1/responses` without `X-OAA-Compat`) refuse with 400 `unsupported_parameter` (`error.param` `tools`): the message says this agent cannot take the tools over, gives the reason (a native engine that runs its own tool loop, no execution machine for client tools, a name collision, tools that are not functions, a forced tool choice), and names the three ways out: the Base URL `<origin>/v1/compat`, `X-OAA-Compat: true`, `X-OAA-Client-Tools: managed`. The compatibility endpoints, Claude Messages and Gemini continue as `managed` (the agent finishes with its own tools; `X-OAA-Client-Tools: ignored`).

So only two situations changed: a request to an agent that can bridge now bridges (on the default OpenAI endpoints it used to be a 400; elsewhere it used to be `managed`). Agents that cannot bridge (Codex, Claude Code, Antigravity, A2A, HTTP adapters) behave on every entry exactly as before. Forced tool choices cannot be honoured by the gateway or the upstream model, so they never bridge; on the default endpoints a forced `tool_choice` is refused (`unsupported_parameter`, `error.param` `tool_choice`) and elsewhere it is ignored as before. The permission of an external agent's own approval requests in a bridged turn is unchanged (see "How bridging works for external agents"): `auto` does not widen what is auto-approved.

Modes apply only when `tools` in the request is a **non-empty array**. With no `tools`, or with `tools: []`, behavior is exactly as before and the mode header has no effect.

## How to choose

- When in doubt, keep the default `auto`: an agent that can use your tools gets them, any other agent works as it did before, and the response header (`bridge` or `ignored`) says which happened.
- When the caller must know that "the tools were not run" and change its behavior accordingly (for example switch to another model), use `reject` and branch on the error code.
- When the agent must call tools on your machine to finish the task, and what is behind it is a kernel agent or an ACP external agent, use `bridge`. For other external agents, you can first publish those tools as the OAA agent's own tools (MCP import or node tools) and then use `managed`.

## How to pass it

There are two ways, and the header wins:

1. The request header `X-OAA-Client-Tools: auto | managed | bridge | reject` (case-insensitive).
2. The request body `metadata["oaa.client_tools"]`, with the same values.

Any other value returns `invalid_request` (400), and the message lists the valid values.

Chat Completions (compatibility mode), with the header:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $OAA_KEY" \
  -H "Content-Type: application/json" \
  -H "X-OAA-Compat: true" \
  -H "X-OAA-Client-Tools: reject" \
  -d '{
    "model": "agent/coder",
    "messages": [{ "role": "user", "content": "Fix the error on the login page" }],
    "tools": [{ "type": "function", "function": { "name": "edit_file", "parameters": { "type": "object" } } }]
  }'
```

Claude Messages, with metadata:

```json
{
  "model": "agent/coder",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "Fix the error on the login page" }],
  "tools": [{ "name": "edit_file", "input_schema": { "type": "object" } }],
  "metadata": { "oaa.client_tools": "managed" }
}
```

Responses (`/v1/compat/responses`) and Gemini (`tools[].functionDeclarations`) work the same way: send the header together with the tools, or put `oaa.client_tools` in `metadata`.

## Response headers

| Case | Response header |
| --- | --- |
| The agent keeps its own tools and the request did carry tools (`managed`, or `auto` falling back) | `X-OAA-Client-Tools: ignored` (both streaming and non-streaming) |
| The tools were handed to the agent (`bridge`, or `auto` choosing it) | `X-OAA-Client-Tools: bridge` |
| No tools carried | Absent; the set of response headers is the same as before |
| The request has parameters that are accepted but not forwarded (`temperature` and so on; see "Parameters, errors and finish reasons of the compatibility endpoints" in protocol.md) | `X-OAA-Ignored-Params: <parameter name, …>`; absent when there are none |

The run record's `metadata` also shows the mode that was used: `oaa.client_tools: "managed"` with `oaa.client_tools_ignored: "<number of tools>"`, or `oaa.client_tools: "bridge"`.

## Current support matrix

Agent connection type × mode (the agent profile's `conversion.client_tools` gives each agent's value: `bridge` for kernel and ACP, `managed` for the rest; `auto` picks the one in that column):

| Agent connection type | `managed` | `reject` | `bridge` |
| --- | --- | --- | --- |
| Built-in kernel agent (`engine: kernel`) | Supported | Supported | Supported ✓ (Chat, Responses, Claude Messages) |
| ACP external agent (`adapter/<name>`, `transport: "acp"`) | Supported | Supported | Supported ✓ (through an MCP relay; see "How bridging works for external agents" below) |
| Codex / Claude Code / Antigravity / DSH | Supported | Supported | Managed only: returns `client_tools_bridge_unsupported` |
| A2A / oaa-1 HTTP adapters | Supported | Supported | Managed only: returns `client_tools_bridge_unsupported` |

A bridged run is placed only on an execution machine that declared `client-tools-v1` in the handshake and declared support for this engine (the built-in execution machine always declares `kernel` and the enabled ACP adapters). When there is no such machine, submission returns `client_tools_bridge_unsupported` (400) and no run is created. Legacy 0.2.0 remote execution machines do not declare this feature, so they never receive bridged tasks (previously this surfaced only at execution time as `manifest_mismatch`).

External protocol × mode:

| Endpoint | `managed` | `reject` | `bridge` |
| --- | --- | --- | --- |
| Chat Completions (`X-OAA-Compat: true` or `/v1/compat/chat/completions`) | Supported | Supported | Supported (kernel and ACP agents) |
| Responses (`X-OAA-Compat: true` or `/v1/compat/responses`) | Supported | Supported | Supported (kernel and ACP agents; only `type: "function"` tools are accepted) |
| Claude Messages (`/v1/messages`, `/v1/compat/messages`) | Supported | Supported | Supported (kernel and ACP agents; server tools that carry a `type` are rejected) |
| Gemini `generateContent` / `streamGenerateContent` (`/v1beta` and `/v1`) | Supported | Supported | Supported (kernel and ACP agents; only `functionDeclarations` are accepted, and built-in tools such as `googleSearch` are rejected) |
| Strict endpoints (`/v1/chat/completions` and `/v1/responses` without `X-OAA-Compat`) | Supported (explicit header) | Supported (explicit header) | Supported (kernel and ACP agents); with no mode chosen an agent that cannot bridge is refused (see "What auto does") |
| UAP/1 (`/v1/uap`) | — | — | — |

The strict endpoints take part in the modes like the others; what is different is only the fallback of `auto` (a refusal instead of `managed`). `functions` / `function_call` (legacy) stay refused there, and an empty `tools: []` is accepted as no tools. UAP/1 does not take part: it returns `invalid_request` for a `tools` field.

## How this differs from human approval

Bridge's "wait for the caller to return the tool result" and human approval both park a run, but the decision belongs to different parties:

- Human approval is decided by the owner (who needs the `approve` scope) and lets one step of a published tool go ahead.
- The result of a caller tool is returned by **the caller itself** (the same data partition, and the `invoke` scope is enough), without going through the owner.

Managed and reject modes never create any pending item.

## Using bridge (kernel agents)

Chat Completions is the example here; Responses, Claude Messages, and Gemini are in the next section.

1. The first request carries `tools` and `X-OAA-Client-Tools: bridge`. When the agent calls a caller tool, the run parks and the response is the standard `finish_reason: "tool_calls"`: `message.tool_calls` lists all the calls to execute in this round (parallel calls are all given at once), `id` starts with `call_`, `function.arguments` is a JSON string, and `message.content` is the new text produced in this segment (`null` if there is none). The response header `X-Run-ID` is the run ID.
2. The caller runs the tools, appends `role: "tool"` messages to the end of `messages` the OpenAI way (`tool_call_id` is the `id` from the previous step), and sends the request again with the same `tools` and the same header.
3. The gateway finds the parked run by `tool_call_id`, writes in the results, and the **same run** carries on (`X-Run-ID` does not change); the history does not need to be flattened and replayed. The response contains only the new output since the last delivery: it may be the final result, or the next batch of `tool_calls`. If only some of the results were returned, the run parks again and returns the remaining calls.

Key points:

- Only the **consecutive** `role: "tool"` messages at the **end** of `messages` count as the results returned this time; earlier history is flattened into text as before.
- The continuation credential is the `tool_call_id`. The gateway requires that it belong to the same owner and the same data partition (or an owner-level visible key), that the key have the `invoke` scope on the agent, and that all of them belong to the same run; if any condition fails (unknown, expired, belongs to someone else), the request is treated as new, the original run is not affected, and it is not revealed whether the ID exists.
- Returning the same batch of results twice (a network retry) does not overwrite results already written; it attaches to the same run.
- Streaming (`stream: true`): when the run parks, the frames are sent in this order: the role frame (with `content: null`, if one has not been sent before), one `tool_calls` delta frame per call (`index` starting at 0), the closing frame with `finish_reason: "tool_calls"`, then (if `include_usage` was requested) the usage frame and `[DONE]`. After continuation, the stream starts from where the last one ended and does not replay earlier text.
- When the arguments the model produces do not match the caller's schema, the call is not handed to the caller. Instead `{"error":"invalid_arguments","detail":...}` is returned to the model as the tool result so that it can fix the call and try again. This differs from argument errors of published tools (`invalid_tool_arguments`, where the run fails outright): the caller's schema is not under the publisher's control.
- Names: must match `^[a-zA-Z0-9_-]{1,64}$`. The internal alias replaces `-` with `_` and prepends `t_` when the first character is not a letter; the original name is always used externally. A conflict with a published tool, workflow, delegate, `execute_graph`, or another caller tool returns `client_tool_conflict`; more than 100 published tools plus caller tools returns `client_tools_too_many`; a schema that cannot be compiled returns `invalid_client_tool`. All of these are checked before any execution. Caller tools cannot appear in `execute_graph` or in workflows.
- The wait period follows the gateway's `approvalTimeoutMs`; if the caller has not returned results by then, the run ends with `client_tool_timeout` (409). A parked run does not occupy a run slot but still counts toward the limit on unfinished requests, and it can be cancelled as usual. After a gateway restart, a run that is waiting only for the caller stays parked and can still be continued.
- These pending items are visible in `GET /v1/runs/{id}/actions` (`kind: "client_tool"`), but `POST /v1/runs/{id}/actions/{action}` returns `action_kind_mismatch` for them. The "needs attention" count in the overview does not include them (they count as in progress, and there is a separate `awaiting_caller` count), and the timeline shows them as a wait of kind `client_tool`.
- When the same run also has a human approval, it is presented the way human approvals already are: non-streaming Chat / Claude returns 422 `action_required`, with `x-should-retry: false` and the run ID. The caller must not resend the request (that would create a new run): after the owner decides with `POST /v1/runs/{id}/actions/{action_id}`, read the result with `GET /v1/responses/{id}`, or keep returning the results of the caller tools.
- **The response ID does not change on continuation**: continuing is the same run, so the same `resp_…` is returned (`chatcmpl_resp_…` for Chat, `msg_resp_…` for Claude); when continuing, the caller passes this ID back as `previous_response_id`. This differs from OpenAI's "a new Response for every `responses.create`" and is a deliberate "one task, one ID, one charge" design: a client that caches history keyed by response ID (for example the session store of the Agents SDK) will see the content under the same ID overwritten by a new segment, and `GET /v1/responses/{id}` gives only the latest state, without keeping a snapshot of the previous segment's `function_call`. If you need per-segment history, save it on the client, per request.
- When the results the caller returns are written back into the conversation: a result that parses as a JSON object or array is written back as the parsed value; otherwise it is written back as the original string, without quotation marks.
- Pending items are independent of the protocol: a run started with one protocol can have its results returned with another (for example started with Chat and returned with Responses), and the response is rendered in the protocol of that request. In principle we recommend using the same protocol throughout.

## Responses, Claude Messages, and Gemini

**Responses** (`/v1/compat/responses`, or `/v1/responses` with `X-OAA-Compat: true`): the flat `{"type":"function","name",...,"parameters"}` entries in `tools` are caller tools; other types (such as the built-in `web_search`) return `client_tools_unsupported` under bridge (they are still ignored under managed). The consecutive `function_call_output` entries at the end of `input` are the returned results; the run is found by `call_id`, and a `previous_response_id` that is given but is not that run is treated as a miss.

```json
{ "model": "agent/coder", "input": "Fix the error on the login page",
  "tools": [{ "type": "function", "name": "edit_file", "parameters": { "type": "object" } }] }
```

Parked response: `status: "completed"`, `metadata["oaa.status"] = "requires_action"`, and `output` is first a message item with the new text of this segment, then one item per call:

```json
{ "type": "function_call", "id": "fc_8c1…", "call_id": "call_8c1…", "name": "edit_file",
  "arguments": "{\"path\":\"login.ts\"}", "status": "completed" }
```

Returning results:

```json
{ "model": "agent/coder", "previous_response_id": "resp_…", "tools": [ … ],
  "input": [{ "type": "function_call_output", "call_id": "call_8c1…", "output": "Done" }] }
```

Streaming: when the run parks, each call gets, in order, `response.output_item.added` (with an empty-string arguments), `response.function_call_arguments.delta`, `response.function_call_arguments.done`, and `response.output_item.done`, and finally `response.completed` (the response is the same as in non-streaming), and the stream closes. `sequence_number` (and the SSE `id:`): since 0.6.0 every Responses stream uses the sequence number of the frame within that stream, consecutive from 0, with synthesized frames counted too (previously the event ID was used directly, and a bridged stream took the larger of the event ID and the maximum already sent + 1). A continuation stream is a new segment: it starts from the real events after the parking cursor, and its sequence numbers also start at 0. Sequence numbers are meaningful only within one stream; do not compare them across streams.

**Claude Messages** (`/v1/compat/messages` and `/v1/messages`, which use the same compatibility parser): entries with `name` and `input_schema` are caller tools, while server tools that carry a `type` (`web_search_*`, `bash_*`, `computer_*`, and so on) return `client_tools_unsupported` under bridge. `tool_result` blocks in the last `user` message are the returned results (`content` is a string or an array of text blocks; with `is_error: true` it is wrapped as `{"error": …}` and given to the model).

```json
{ "model": "agent/coder", "max_tokens": 1024,
  "tools": [{ "name": "edit_file", "input_schema": { "type": "object" } }],
  "messages": [{ "role": "user", "content": "Fix the error on the login page" }] }
```

Parked response: `stop_reason: "tool_use"`, and `content` is first a text block with the new text of this segment, then `{"type":"tool_use","id":"call_8c1…","name":"edit_file","input":{"path":"login.ts"}}`. `tool_use.id` is the pending item ID as is (with the `call_` prefix, not Claude's usual `toolu_`), and clients should treat it as an opaque string. Returning results:

```json
{ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "call_8c1…", "content": "Done" }] }
```

Streaming: when the run parks, `message_start` is sent first (if it has not been sent yet); a text block that is already open gets `content_block_stop`; each call then gets `content_block_start` (tool_use, `input: {}`), one `input_json_delta` (the complete JSON), and `content_block_stop`, with the index increasing; finally `message_delta` (`stop_reason: "tool_use"`) and `message_stop`, and the stream closes.

**Gemini** (`/v1beta/models/{agent}:generateContent` and `:streamGenerateContent`, and the same under `/v1/models/...`): `tools[].functionDeclarations[]` are caller tools, and the parameters are taken from `parametersJsonSchema` (JSON Schema, as is) or `parameters` (Gemini's OpenAPI subset: uppercase types such as `type: "OBJECT"` are converted to lowercase, and `nullable: true` is merged into the type). Built-in tools such as `googleSearch`, `codeExecution`, and `urlContext` (or ones written in the same entry as `functionDeclarations`) return `client_tools_unsupported` under bridge and are still ignored under managed. `toolConfig` (including the `mode` and `allowedFunctionNames` of `functionCallingConfig`) is not forwarded, just like `tool_choice` in other protocols, and is listed in `X-OAA-Ignored-Params`.

```json
{ "contents": [{ "role": "user", "parts": [{ "text": "Fix the error on the login page" }] }],
  "tools": [{ "functionDeclarations": [{ "name": "edit_file", "parameters": { "type": "OBJECT" } }] }] }
```

Parked response: `candidates[0].content.parts` is first a text part with the new text of this segment, then one `{"functionCall":{"id":"call_8c1…","name":"edit_file","args":{"path":"login.ts"}}}` per call (`args` is an object; parallel calls are multiple parts), with `finishReason: "STOP"` (a Gemini function call ends with STOP anyway), `usageMetadata` as usual, and `responseId` is the run ID, unchanged on continuation. Returning results: a `functionResponse` part in the last entry of `contents` (`role: "user"` or `"function"`):

```json
{ "role": "user", "parts": [{ "functionResponse": { "id": "call_8c1…", "name": "edit_file", "response": { "output": "Done" } } }] }
```

`response` is written into the conversation as JSON. When `id` is present, pairing is by `id`. When it is absent (the official `@google/genai` `chats` keep the model turn's `functionCall`, with its `id`, in the history as is, but a `functionResponse` the caller writes itself often has no `id`), pairing is by the `name` and order of occurrence of the `functionCall` parts in the previous `role: "model"` content. When pairing fails (an unknown `id`, no `functionCall` to pair with, or a name mismatch), it is the same as an unknown ID in other protocols: the whole request is treated as new and the original run stays parked.

Streaming (`?alt=sse` or a chunked JSON array): when the run parks, one chunk delivers all the `functionCall` parts (Gemini does not chunk arguments), the same chunk carries `finishReason: "STOP"` and `usageMetadata`, and then the stream closes; text already streamed earlier is not repeated.

<a id="外部智能体的桥接是怎么工作的"></a>
## How bridging works for external agents

An ACP external agent has its own tool loop, and OAA cannot get into it. But when ACP creates a session it can hand the agent a set of MCP servers (`mcpServers` in `session/new`; the stdio form is the baseline ACP requires every agent to support), and OAA uses that opening to give it your tools:

```
caller ─tools─▶ gateway ─▶ kernel ─task (with caller tools)─▶ execution machine
                                                               │ session/new { mcpServers: [oaa-caller] }
                                                               ▼
                                              ACP agent ─MCP tools/call─▶ relay process (oaa mcp-relay)
                                                                            │ local Unix domain socket
                                              execution machine ◀───────────┘
                                                 ▼
                       the kernel registers a pending item, the run enters requires_action ─▶ the gateway hands it to the caller as tool_calls
                       the caller returns the result ─▶ the result goes back along the same path to the MCP tools/call, and the agent carries on
```

What users need to know:

- **The relay**: in each round the agent is given a stdio MCP server with the fixed name `oaa-caller`. It is a small process started by the `oaa mcp-relay` subcommand that does only two things: `tools/list` lists your tools (names, descriptions, and parameter schemas given as is), and `tools/call` is forwarded to the execution machine through a local Unix domain socket. The socket sits in a 0700 directory private to that run (when the workspace path is too long, a short path under the system temp directory is used instead), the socket and the one-time token file are both 0600, and only the first connection holding the token is accepted; it listens on no network port. When the round ends (completed, failed, cancelled, timed out), the socket is closed, the files are deleted, and the relay exits with it.
- **From your side** it is the same as for a kernel agent: the response has standard `tool_calls` (or `function_call`, `tool_use`), the names are your original names, and after you return results the **same run** carries on. Multiple calls issued at the same moment are all given at once (the relay merges calls arriving within 5 milliseconds into one forward, and the kernel merges notifications in the next event loop turn); calls the agent issues a little later are returned together the next time you send results.
- **The tool names the inner agent sees** follow MCP naming and are decided by the agent itself (a common choice is to prefix the server name, for example `edit-file` under `oaa-caller`). An external agent has no published tools, so no aliases are made, and `-` in the original name is also legal in MCP.
- **The inner process stays alive while waiting**: as with human approval for an external agent, it holds the process and a run slot; this is not a migratable park. The period follows `approvalTimeoutMs`, and on expiry the run ends with `client_tool_timeout`; it can be cancelled as usual.
- **A gateway restart interrupts this kind of run** (`interrupted`, like other external agent runs); unlike a kernel agent, it does not stay parked waiting for you to continue.
- When the arguments do not match your schema, or the agent calls a name that is not on the list, the call is not handed to you; an MCP error result (`isError: true`) is returned straight to the agent instead, and the run does not fail.
- Run events: after a new caller pending item appears, `run.awaiting_caller` is emitted (its payload is the IDs of all pending items at that moment); in a bridged run of an external agent it replaces the kernel's `run.parked`.
- **Permission requests for caller tools are allowed automatically**: some agents (such as Qoder) send `session/request_permission` before calling an MCP tool. These tools are provided and executed by you, so only in a bridged round, and only when the request really targets a tool provided by the relay, OAA directly picks "allow once" (`allow_once`), creates no owner approval, and records a progress entry `{ event: "permission_auto_allowed", tool }`. The judgment is conservative, and every condition must hold: `oaa-caller` appears in the title or in the tool identifier of `rawInput` (case-insensitive); after tokenizing the title, one token equals one of your tool names, or ends with `_<tool name>` (covering the `mcp_oaa-caller_<name>` form); every other token of the title is filler (`run`, `call`, `calling`, `use`, `using`, `tool`, `mcp`, `server`, `oaa-caller`), so a shell command whose title merely mentions the relay and a tool name is not allowed automatically; and the call is not one that the agent itself classifies, through the ACP tool `kind`, as running a command or changing files (`execute`, `edit`, `delete`, `move`), whatever its title says. **Security boundary**: automatic allowance happens only in bridged rounds and only for tools provided by the relay; permission requests for the agent's own tools (reading and writing files, running commands, and so on) still go through owner approval as before.
- Text output before a call ends as one output message, and the new text after continuation is a new one; the response contains only the new output since the last delivery.

<a id="限制与未验证项"></a>
### Limitations and unverified items

- **Not tested together with a real ACP agent.** The tests use a protocol-level fake agent (`test/fixtures/acp-caller-agent.mjs`: it reads `mcpServers`, starts the relay with the MCP SDK, then does `tools/list` and `tools/call`). The field shape of an `mcpServers` entry (`{ name, command, args, env: [{ name, value }] }`) follows the public description of the ACP specification; the repository has no ACP type definitions to compare against. (Updated 2026-11-11: the ACP entry of the local Antigravity command line (`agy` 1.5.5) was tested for real once with Gemini 3.8 Flash; one managed call and one bridged call both passed, and the stdio entry shape of `mcpServers` was accepted. Parallel calls, streaming, slow returns, and other ACP agents are still unverified. For the results see [evidence.md](evidence.md).)
- The agent's own MCP call timeout (for example the MCP SDK's default of 60 seconds) may be shorter than `approvalTimeoutMs`: if the caller returns results too slowly, the agent may give up on the call first.
  - **Keep-alive**: while waiting for the caller, the relay sends a `notifications/progress` every 15 seconds for a `tools/call` whose request carries `_meta.progressToken` (`progress` increases, and `message` says it is waiting for the caller; the interval can be changed with `oaa mcp-relay --progress-interval-ms` or the environment variable `OAA_MCP_RELAY_PROGRESS_MS`). Without a token, nothing is sent. This does **not** guarantee a longer timeout: the agent's MCP client must have enabled "reset the timeout on progress" (the MCP SDK's `resetTimeoutOnProgress`), and it must actually have provided a progressToken. We recommend aligning the gateway's `approvalTimeoutMs` with the agent's MCP request timeout (not longer than the latter), or raising the agent's MCP timeout.
  - **Cleanup after abandonment**: if the agent closes the relay when it gives up on the call (shuts down the MCP server, or restarts it after a timeout), the socket from the relay to the execution machine disconnects, and the call still waiting ends with `client_tool_abandoned`: the corresponding step fails, the pending item is marked expired, and the run does not fail because of it (the agent is still going); when there are no other pending items, the status goes back to `in_progress`. Returning that `call_id` afterwards does not continue anything and is treated as a new request. If the agent merely lets the request time out without closing the relay, the call still hangs until `approvalTimeoutMs` and the run ends with `client_tool_timeout`.
- Only ACP connections are supported; Codex, Claude Code, Antigravity, DSH, A2A, and oaa-1 adapters remain managed only.

## Roadmap

- Available: `bridge` for built-in kernel agents and ACP external agents over Chat Completions, Responses, Claude Messages, and Gemini (`features` in `/health` contains `harness-bridge-v1` and `harness-bridge-acp-v1`). UAP/1 has no bridging. The wire-format tests for Gemini bridging used only kernel agents; ACP agents go through the same protocol-independent parking and continuation, and have not been tested separately through the Gemini endpoint.
- Later: other external agents (the in-process MCP server of the Claude Agent SDK, the MCP configuration of Codex) must be tested engine by engine.

When `features` in `/health` contains `client-tools-policy-v1`, the managed and reject modes described on this page are available. For error codes see the "Error codes" chapter of [protocol.md](protocol.md).
