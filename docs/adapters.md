# Add another agent

English · [简体中文](zh-CN/adapters.md)

Built-in adapters are not the boundary of the platform. An owner can install a stdio or HTTP adapter, enable it on a worker, and publish an AgentDefinition with `engine: "adapter/<name>"`. Use this for an agent with its own SDK, API, or supported headless interface. Installing MCP alone does not supply an execution interface that the original agent does not expose.

## AgentAPI conversion contract (2026-11-08)

The current Codex adapter scopes events and approvals to its own thread and turn, sends protocol-level `turn/interrupt` before terminating stubborn processes on cancellation, preserves redacted upstream errors, accepts completed-message snapshots without duplicating streamed text, and bounds initialization and shutdown. Model catalogs may expose model/effort combinations: the shared resource-safety cap is 1,024 models/routes. Oversized catalogs explicitly carry `truncated: true` and the console labels them incomplete. Discovery and a successful handshake are **not** proof of generation. Codex and ACP engines support enforced tool-free reasoning turns (`toolsDisabled`), and opaque external engines can also bind a dedicated `orchestration.planner` agent. The Antigravity row below describes legacy stream-json; policy-aware/hybrid publications use ACP as described in [Harness](harness.md).

> New section. It answers two questions: through which path an agent becomes an AgentAPI, and what each path can **actually** guarantee for streaming, mid-run approval, cancellation, resume, and tool visibility. The conclusions in the tables are verified class by class in `test/conformance.test.ts` with protocol-level fake agents (no real model or agent is called, and no ports are opened); entries that are untested are marked as such.

### Conversion path

```
agent ──connection type──▶ worker ──oaa/1 node protocol──▶ kernel (durable runs, approvals, events) ──▶ external protocol
        4 built-in native                                                                              oaa/1 · OpenAI Responses / Chat
        ACP stdio                                                                                      Claude Messages · Gemini · UAP/1
        oaa/1 stdio / oaa/1-stream / oaa/1 HTTP                                                        MCP bridge
        A2A (remote)
```

Every connection type is ultimately normalized into the same kind of run: text deltas → `response.output_text.delta`, tool/status progress → `tool.progress`, approvals → `run.requires_action` + `/v1/runs/{id}/actions`, completion → a terminal event with a stable `error.code`. External protocols are only different renderings of that one run record, so whether an agent can become an AgentAPI depends only on which signals its connection type can provide.

### Connection type audit

✅ full support　⚠️ partial support (see the cell)　❌ not supported

| Connection type | Streaming text | Mid-run approval | Cancel | Resume | Tool visibility | Usage | Artifacts | Model selection |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Kernel `kernel` | ✅ token | ✅ a tool with `requiresApproval` parks and waits | ✅ cooperative (aborts the model call) | ✅ replays session history | ✅ steps and `tool.*` | ✅ every round | ✅ `write_file` | Routes (multiple routes, failover) |
| Native `codex` (app-server JSON-RPC) | ✅ token | ✅ commands / files / permissions / questions / MCP elicitation are all bridged | ✅ `turn/interrupt`, then terminate after a 2.5s grace period | ✅ `thread/resume` | ✅ item progress | ✅ cumulative deltas (`thread/tokenUsage/updated`); unknown for legacy resumes without a baseline | ✅ `outputs/` | Confirmed before prompting; silent fallback rejected |
| Native `claude` (Agent SDK) | ✅ token (`includePartialMessages` `stream_event` deltas, deduplicated against final snapshot) | ✅ `canUseTool` bridge | ⚠️ terminated after abort | ✅ `--resume` | ✅ tool names (without arguments) | ✅ | ✅ | Declarative |
| Native `antigravity` (stream-json) | ✅ token | ⚠️ not bridged: when the agent itself denies, the run fails with `permission_denied` | ⚠️ terminated | ✅ `--conversation` | ✅ step tools | ⚠️ first round only (a session-cumulative value is not treated as per-round usage) | ✅ | Agent-confirmed (the run fails and the task is not sent if the model reported by init does not match) |
| Native `dsh` (headless) | ❌ final result only | ❌ | ⚠️ terminated | ❌ `native_resume_unsupported` | ❌ | ❌ | ✅ | Allowlist (owner model mapping) |
| ACP stdio | ✅ token | ✅ picks only `allow_once` | ✅ `session/cancel`, then terminate after a grace period | ⚠️ depends on the agent declaring `loadSession`/`resume` (a handshake check can confirm) | ✅ `tool_call`/`plan` | ⚠️ reported by the agent (an unstable ACP field; all three being 0 is treated as unknown) | ✅ | Agent-confirmed (`configOptions`) |
| `oaa/1` stdio (final-result ABI) | ❌ final result only | ❌ | ⚠️ terminated | ✅ `state` is passed back | ❌ | ✅ if reported | ✅ | Declarative |
| `oaa/1-stream` stdio | ✅ token | ✅ bridged | ✅ cooperative `cancel`, then terminate after 3 seconds | ✅ `state` is passed back | ✅ `progress` | ✅ if reported | ✅ | Declarative |
| `oaa/1` HTTP | ❌ final result only | ❌ | ⚠️ aborts the request (the remote side may keep running) | ✅ `state` is passed back | ❌ | ✅ if reported | ❌ no shared workspace | Declarative |
| A2A (remote) | ✅ SSE (`message/stream`) | ❌ not bridged: `input-required` ends the round with the agent's question, and a reply resumes the same task | ✅ `tasks/cancel` | ✅ `contextId` (resumes `taskId` on `input-required`) | ⚠️ task status only | ❌ | ❌ | Declarative (A2A has no model selection) |

The "Mid-run approval" column describes the default behavior (`approvals: "ask"`). For an external agent published with `auto`, a bridged permission request is approved directly by policy and a record is left; see "Approval policy at publish time" below.

The common floor that all connection types meet (asserted item by item in the tests): the final text is correct; a connection type that only gives a final result still delivers exactly 1 delta in each streaming protocol; failures carry the stable error codes listed in `docs/protocol.md`, and error text provided by the adapter or agent is redacted; an external agent round that has already started and is then cancelled is recorded as `interrupted` (`effect_outcome_unknown`, side effects cannot be ruled out), while a kernel round is recorded as `cancelled`; only the kernel calls a model provider.

### External protocol audit

| External protocol | Streaming | How a pending approval is shown | Cancel | Resume | Tool events |
| --- | --- | --- | --- | --- | --- |
| `oaa/1` `POST /v1/invoke` | ✅ | Same as Responses; decisions go through `POST /v1/runs/{id}/actions/{action}` (needs the `approve` scope) | ✅ `POST /v1/responses/{id}/cancel` | ✅ `previous_response_id` | ✅ the native event stream `GET /v1/runs/{id}/events` forwards all events |
| OpenAI Responses | ✅ | Synchronous: `in_progress` + `metadata["oaa.status"]="requires_action"`; streaming: keeps the connection open and emits `response.in_progress` | ✅ | ✅ `previous_response_id` | ❌ Responses has no matching event, so none are forwarded |
| OpenAI Chat Completions | ✅ | Synchronous `422 action_required` (with `X-Run-ID`; SDKs will not retry); streaming ends with an `action_required` error frame | ⚠️ call the cancel endpoint with `X-Run-ID` | ❌ stateless: history is flattened into a new round (the adapter sees a new session) | ❌ |
| Claude Messages | ✅ | Synchronous 409; streaming `event: error` | ⚠️ same | ❌ stateless | ❌ |
| Gemini `generateContent` | ✅ | Synchronous 409; streaming `ABORTED` frame | ⚠️ same | ❌ stateless | ❌ |
| UAP/1 | ✅ NDJSON / SSE | Synchronous `status: "requires_action"`; streaming closes after an `action` frame | ⚠️ same | ✅ `session.previous_id` | ✅ `step` frames |
| MCP bridge | ⚠️ poll `oaa_wait_run` | `oaa_wait_run` returns `requires_action` and `pending_actions`; **deliberately provides no approval tool** | ✅ `oaa_cancel` | ✅ `previous_response_id` | ⚠️ run status only |

The MCP bridge offering no approve/deny tool is a deliberate security boundary: the caller is often an AI agent itself, and if it could approve the write operations it started, human approval would lose its meaning. The decision must be made by the owner in the console, or by calling the HTTP endpoint with a key that has the `approve` scope. Disconnecting does not cancel an accepted task; cancelling must be an explicit call.

### Conclusions

1. **All four classes of connection types can turn an agent into an AgentAPI**: built-in native, ACP, `oaa/1` (stdio / streaming / HTTP), and A2A. The 10 concrete paths pass six classes of checks in the same fake-agent test suite (basic round, resume (or an honest refusal), approval, artifacts, failure, cancellation), and 6 external protocols plus the MCP bridge render the same run.
2. **The difference is in "depth of interaction", not in "whether it can be connected"**: this is now stated explicitly by the `conversion` profile, so callers do not have to find out by trial and error. There are three tiers: `basic` (final result + stable errors + cancel), `streaming` (plus incremental text), and `interactive` (plus mid-run approval). Currently `interactive`: kernel, Codex, Claude, ACP, `oaa/1-stream`; `streaming`: Antigravity, A2A; `basic`: DSH, `oaa/1` stdio / HTTP.
3. **Inconsistencies fixed**: an operation denied by the owner in Codex used to report `native_incomplete` and now reports `permission_denied`, as the other engines do; Claude tool calls used to be invisible and are now recorded as progress (tool name only); error text returned by `oaa/1` adapters used to be written into the run record as is and is now redacted; streaming Responses used to be completely silent while waiting for approval and now report the pending-approval status; custom adapters used to be able to deliver only a final result and can now opt into `oaa/1-stream` for streaming, approval, and cooperative cancellation; A2A remote connections were added.
4. **Gaps closed & remaining boundaries**: Codex cancellation now sends protocol-level `turn/interrupt` with a bounded grace period before terminating; Claude now streams per-token deltas (`includePartialMessages: true`) without duplicating the assistant snapshot; Codex, Claude, and Antigravity native engines now bridge caller tools via `oaa-caller` MCP (`permission_auto_allowed`); remote nodes negotiating `conversion-profiles-v1` synchronize static `ConversionProfile` metadata for custom `adapter/<name>` entries so the gateway no longer reports `unknown`. Remaining boundaries: Antigravity's legacy stream-json path still has no mid-run headless approval bridge (use its `agy acp` path when interactive owner approval is required); Chat / Claude / Gemini cannot resume sessions natively or show OAA tool events, which follows from those protocols being stateless. See [evidence.md](evidence.md) for live end-to-end verification records.

### Conversion profile (`conversion`)

`src/engines/conformance.ts` gives a profile per connection type. It appears in `GET /v1/agents`, in the agents of `GET /v1/overview`, in `GET /v1/catalog/agent?section=overview` (the same source as MCP `oaa_inspect_agent`), and in the `data` and `presets` of `GET /v1/local/backends`; `features` in `/health` contains `conversion-profile-v1`.

| Field | Values |
| --- | --- |
| `access` | `kernel`, `native`, `acp`, `oaa-adapter`, `a2a`, `unknown` (the adapter is not configured on the gateway and no remote node advertised its profile via `conversion-profiles-v1`) |
| `transport` | The concrete wire protocol: `oaa-kernel`, `codex-app-server`, `claude-agent-sdk`, `antigravity-stream-json`, `dsh-headless`, `acp-stdio`, `oaa/1`, `oaa/1-stream`, `oaa/1-http`, `a2a-jsonrpc` |
| `tier` | `basic`, `streaming`, `interactive` (see conclusion 2 above) |
| `streaming` | `token`, `message`, `final` |
| `approvals` | `bridged` (the owner's approve/deny reaches the agent), `denied` (the agent's own permission prompt makes the run fail), `none` |
| `cancel` | `cooperative` (send a protocol-level cancel first, then stop the process), `terminate` (stop the managed process group), `request-abort` (only abort the HTTP request) |
| `resume` | `native` (the agent's own session/context), `agent-declared` (depends on the handshake declaration), `adapter-state` (the adapter's opaque state), `none` (resume is refused) |
| `tool_events` | `tool`, `status`, `none` |
| `usage` | `reported`, `agent-reported`, `partial`, `none` |
| `artifacts` | Whether files under `outputs/` are exported as artifacts |
| `model_selection` | `route`, `declared`, `agent-confirmed`, `allowlist` |
| `client_tools` | How tools that the caller passes on a compatibility endpoint are handled (see [harness.md](harness.md)): `managed` (the agent finishes with its own tools and the caller's tools are not run), `bridge` (the caller's tools are handed back to the caller to run). `bridge` for the kernel, Codex, Claude Code, and ACP agents (Chat Completions, Responses, Claude Messages, and Gemini), `managed` for the other external agents |
| `image_input` | How images reach the agent ([images.md](images.md)): `route` (kernel; per model route, `providers.*.imageInput`), `native` (Codex `localImage`, Claude Code image blocks, an ACP agent whose handshake declared `promptCapabilities.image`), `agent-declared` (ACP before a handshake check: image blocks if declared, else workspace files), `workspace-file` (image files under `inputs/` named in the input: Antigravity, DSH, stdio `oaa/1` adapters, ACP without image support), `none` (refused: A2A, HTTP adapters, `imageFiles: false`) |

The profile is derived from static configuration only and does not change within a process, so it does not invalidate the overview ETag. A handshake check triggered by the owner only refines the entries in `/v1/local/backends`: if the ACP handshake declares `loadSession` or `resume`, `resume` becomes `native`; if neither is declared, it is `none`. Likewise `image_input` becomes `native` when the handshake declares `promptCapabilities.image`, and `workspace-file` (or `none` with `imageFiles: false`) when it does not.

### Entry constraints for external agent events (2026-11-11)

The progress and approvals that an external agent (an engine other than `kernel`) sends through its connection type are funneled through one place before the kernel persists them (`src/kernel/agent-events.ts`); the `tool.progress` of the kernel's own tools does not pass through here and its shape is unchanged.

- **Progress**: still a `tool.progress` event. Only the allowlisted fields in the table below are kept; strings are truncated (`event` / `status` / `state` / `kind` to 40 characters, `tool` to 160, the rest to 240); finite numbers, booleans, and `null` are kept as is; arrays (such as `entries`) are limited to 20 items and keep only their scalars; other types (objects, non-finite numbers, and so on) are dropped. Finally `source: "agent"` is added, which marks the entry as reported by an external agent and distinguishes it from the `tool.progress` that kernel tool execution emits itself (which has no `source`); a `source` field that the agent sends itself is overwritten.
- **Approvals**: when the serialized approval detail exceeds 256 KiB (262,144 characters), no pending approval is created; a denial is answered directly to the connection layer, and a progress entry `{ event: "permission_denied", reason: "approval_too_large" }` is recorded. This matches the existing "refuse if too large" rule in the `oaa/1-stream` and ACP connection layers; the approvals of Claude and Codex carry full arguments and are from now on subject to this limit too. The denied operation ends the round with `permission_denied` according to each connection type's existing rules.
- **Approval policy at publish time (`approvals`)**: an external agent's definition can carry `approvals: "auto"` (default `ask`). When it is `auto`, the size limit in the previous item is still checked first (over the limit is still denied); after that, the run does not enter `requires_action` and does not wait: the kernel directly writes an approval record with `status: "approved"` and `response: { auto: true }`, emits `approval.resolved` (`decision: "approve"`, `actor: "policy:auto"`), and then answers the connection layer with an approval. The run stays `in_progress`, no `run.requires_action` is produced, and the streams of each protocol are the same as when there is "no permission request". It applies to all connection types whose "Mid-run approval" in the table is bridged (Codex, Claude, ACP, `oaa/1-stream`); connection types that do not bridge approvals (Antigravity, A2A, and so on) are unaffected. For a kernel agent, writing `auto` is an error at validation time: approval of kernel tools is controlled by the `requiresApproval` that the tool declares. The checks for execution level, sandbox, BYOK, and node authorization do not change (an external agent still requires the caller key to have `host`); the automatic allowance of caller tools in a bridged round is unrelated to this field, and the two coexist. **Risk**: automatic approval lets the caller drive this agent with the owner's privileges on this machine: nobody checks before it runs commands or modifies files, and what the caller gets is the result of what it executed directly. Open it only to callers you trust: give them a separate API key, limit that key to this one agent (`agents`), and if needed run it at the sandbox execution level.
- **Event callback failures**: when a text or progress event emitted by any connection type is refused by the gateway (for example persistence fails), the round ends with an explicit error and does not become an unhandled Promise rejection: a progress persistence failure is recorded as `persistence_failed` and aborts the run (the same as for text deltas); when a model delta cannot be sent out on an execution node, the round ends with that error.

Progress fields per connection type (`source: "agent"` is added uniformly by the kernel and omitted from the table):

| Connection type | `native` | `event` | Other fields |
| --- | --- | --- | --- |
| Native `claude` | `claude` | `tool`; `permission_auto_allowed`; `permission_denied` | `tool` (tool name, without arguments); `permission_auto_allowed`: `tool` (bridged caller tool); `permission_denied`: `reason` |
| Native `codex` | `codex` | `item`; `permission_auto_allowed`; `permission_denied` | `itemType` (Codex's item type, kept), `status`, `kind` (`tool` for `commandExecution` `fileChange` `mcpToolCall` `dynamicToolCall` `collabAgentToolCall` `webSearch` `imageView`, `status` for the others); `permission_auto_allowed`: `tool`; `permission_denied`: `reason` |
| Native `antigravity` | `antigravity` | `initialized`; `tool` | `initialized`: `model` `tool_count` `permission_mode`; `tool`: `tool` (tool name), `state` |
| Native `dsh` | — | — | Sends no progress |
| ACP stdio | `acp` | `initialized` `thinking` `tool` `plan` `content_skipped` `permission_denied` `permission_auto_allowed` | `adapter`; `initialized`: `agent` `version` `load_session` `resume_session`; `tool`: `tool_call_id` `title` `kind` `status`; `plan`: `entries` (the count); `content_skipped`: `content_type`; `permission_denied`: `reason`; `permission_auto_allowed`: `tool` (the name of the caller tool that was allowed automatically in a bridged round) |
| `oaa/1-stream` stdio | `adapter` | The `event` the adapter gives (default `progress`) | `adapter`, `title`, `status`, `tool` |
| A2A | `a2a` | `status` | `adapter`, `state`, `title` |
| Any external agent | same as above | `permission_denied` | `reason: "approval_too_large"` (the approval detail is too large; see above) |

Only fields were added; none was removed or renamed; the event name is still `tool.progress`.

A few other uniform rules:

- **Artifacts are persisted first, the step completes afterwards**: artifacts returned by an external agent are verified by digest and persisted one by one; only after all succeed are the step completion, the artifact IDs, and the run checkpoint written in the same commit. Any digest mismatch fails with `artifact_integrity`, and the step is not recorded as `completed`.
- **Antigravity denials and tool failures**: only what can be clearly identified as a denial (wording such as `soft-denied`, `permission … denied`, or `requires approval` in stderr or in a tool step's `tool_info.error`) fails with `permission_denied`; other tool errors no longer make the whole round count as denied, the agent's own subsequent output decides the outcome, and when it gives no successful result the round fails with `native_incomplete`. See the Antigravity section below.
- **Streamed text wins**: when text has already been streamed during a round, the final output is that streamed text, and the complete result text that the connection type gives at the end (for example Claude's `result`) is no longer written; only when a round has no streamed text at all is the result text used as the output (still delivered as exactly 1 delta).

### What an agent must satisfy to be connected

| Tier | Minimum requirements | Recommended connection type |
| --- | --- | --- |
| `basic` | Can accept a task unattended and give final text at the end; on failure explains why with a non-zero exit or a `failed` status; does not leak credentials in its output | `oaa/1` stdio (wrapping the headless/print mode of any CLI) or `oaa/1` HTTP |
| `streaming` | Outputs text piece by piece during the run | `oaa/1-stream`, ACP, A2A (`message/stream`) |
| `interactive` | Sends a request **before** performing an operation that needs human confirmation, and actually honors the approve/deny result | ACP (`session/request_permission`) or `oaa/1-stream` (`approval`) |
| Resumable | Can restore context from opaque state or a session ID; when it cannot, it must refuse explicitly and must not quietly open a new session | Any type; keep it in `state` / the session ID |

What OAA itself guarantees needs no work from the agent: durable run records, event replay, approval expiry and permission checks, artifact collection, quotas, multi-protocol rendering, and MCP exposure.

## The `oaa/1` final-result ABI

Worker configuration:

```json
{
  "adapters": {
    "my-agent": {
      "transport": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/my-agent-adapter.mjs"],
      "enabled": true
    }
  }
}
```

The process receives one JSON object on stdin and must write one result object on stdout. Diagnostics belong on stderr. The worker owns this process and will terminate it on cancellation, timeout, or an output-limit violation. The HTTP form uses `{transport:"http",url:"https://...",tokenEnv:"MY_ADAPTER_TOKEN",enabled:true}` and the same request/result bodies.

Request:

```json
{
  "protocol": "oaa/1",
  "type": "invoke",
  "agent": "agent/my-agent",
  "model": "an-explicit-published-model",
  "input": "The task",
  "instructions": "Owner-published instructions to apply with the native agent's own rules",
  "run_id": "resp_...",
  "session_id": "session_...",
  "workspace": "/owned/task/workspace",
  "previous_state": null
}
```

Result:

```json
{
  "protocol": "oaa/1",
  "type": "result",
  "status": "completed",
  "output_text": "The answer",
  "state": { "upstream_session": "your-own-opaque-session-reference" },
  "usage": null
}
```

`state` is opaque adapter-owned continuation data, not an authorization grant. Preserve the selected model or return a failure; do not silently select another account/model. Only report `completed` after the underlying agent confirms completion. Use `failed` or `incomplete` plus an `error` string otherwise. Credentials must remain in the worker/adapter environment and must not be returned in state.

The initial generic adapter ABI is final-result JSON, not a claimed universal token-level stream or approval transport. (If you need streaming output, mid-run approval, and cooperative cancellation, use `oaa/1-stream` below, or connect through ACP / A2A.) The API can still stream the completed text and return durable task status. Rich incremental and approval flows currently belong to the supported built-in adapters. Stdio adapters can put deliverables under `outputs/` for the worker's bounded artifact collector. HTTP adapters do not automatically gain access to the local workspace path. Native/external agents use their original toolkits: portable `tools`/`skills` bindings are accepted only by the kernel engine rather than silently ignored.

For a custom embedded executor, implement the exported `Executor` interface in `src/fabric/worker.ts`. Remote workers speak the leased `oaa/1` protocol documented in `protocol.md`. These extension points let other agents participate without editing the original agent's code or extracting its private authentication state.

## `oaa/1-stream`: the streaming adapter ABI (2026-11-08)

> New section. Add `"protocol": "oaa/1-stream"` to a stdio adapter to enable it; when it is omitted or set to `"oaa/1"`, the final-result ABI above still applies, and the two do not affect each other.

```json
{
  "adapters": {
    "my-agent": {
      "transport": "stdio",
      "protocol": "oaa/1-stream",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/my-agent-adapter.mjs"],
      "enabled": true
    }
  }
}
```

Both directions are NDJSON (one JSON object per line):

- **OAA → adapter (stdin, kept open)**: the first line is the same request object as in the final-result ABI, plus `"stream": true`; after that there may be `{"type":"approval_result","id":"…","decision":"approve"|"deny"}` and `{"type":"cancel"}`. After receiving the result, OAA closes stdin.
- **Adapter → OAA (stdout)**:
  - `{"type":"delta","text":"…"}`: incremental text, written to the durable output immediately (cumulative limit 1 MB).
  - `{"type":"progress","event":"tool","tool":"…","title":"…","status":"…"}`: progress, recorded as `tool.progress` (all fields optional, truncated by length).
  - `{"type":"approval","id":"a1","title":"…","kind":"edit","input":{…}}`: asks the owner for approval, sent **before the operation**, and then waits for `approval_result`. When the detail exceeds 256 KiB, or there is currently no approval channel, OAA replies `deny` directly.
  - The last line: a `result` object that is the same as in the final-result ABI (`protocol`, `type: "result"`, `status`, `output_text`, `state`, `usage`, optional `error`). If any `delta` was sent, the final output is whatever the deltas gave.
- Rules: an unknown `type` fails with `invalid_protocol`; a process that exits without a `result` is `native_incomplete`; a `status` other than `completed` is `adapter_incomplete` (the `error` text is redacted); if any approval was denied during the round, the round fails with `permission_denied` even if it then reports `completed`.
- Cancellation: OAA first sends `{"type":"cancel"}`, and if the process has not exited within 3 seconds it terminates the whole process group. As with other external agents, a round that had already started and is then cancelled is recorded as `interrupted`.
- Write diagnostics to stderr. The working directory is the task workspace, and files under `outputs/` are collected as artifacts.

Reference implementation: `test/fixtures/stream-adapter.mjs` (it demonstrates both the final-result ABI and the streaming ABI).

## ACP agents (Agent Client Protocol)

> New section (2026-11-07). The `oaa/1` final-result ABI above is still valid; ACP is another kind of `transport` that provides streaming output, approval, and cancellation.

Besides the built-in `codex`, `claude`, `antigravity`, and `dsh`, a worker can connect any local agent that implements [Agent Client Protocol](https://agentclientprotocol.com) v1 through `transport: "acp"` (Gemini CLI, Qwen Code, Kimi Code, OpenCode, Goose, Cursor, Copilot CLI, Kiro, Qoder, and others; see the table below for the full catalog). The engine name after publishing is `adapter/<name>`.

```json
{
  "adapters": {
    "gemini": {
      "transport": "acp",
      "command": "/opt/homebrew/bin/gemini",
      "args": ["--acp"],
      "enabled": false,
      "preset": "gemini"
    }
  }
}
```

- `command`/`args`: an executable the owner configured explicitly or that discovery wrote; OAA runs only entries with `enabled: true`, never runs `npx`, and never downloads or installs any package.
- `preset`: used only for icon and catalog display (it corresponds to `web/agents/<preset>.svg`) and grants no capability. When omitted, if the adapter name is itself a preset ID, matching is by name.
- The adapter name must match `[a-z0-9_-]+`; otherwise it is not advertised and cannot be published.

### Flow of each round

1. Start the process with the task's managed workspace as `cwd` (in its own process group, with `OAA_*` environment variables removed).
2. `initialize`: the protocol version must be `1`; OAA declares that it **does not provide** filesystem and terminal callbacks (`fs.readTextFile/writeTextFile=false`, `terminal=false`), and the agent works in the workspace with its native tools.
3. New session: `session/new {cwd, mcpServers: []}` (no MCP server is injected, except when caller tools are bridged; see "Caller tools (`mcpServers`)" below). Resume: if the previous round's `nativeState.sessionId` exists, `session/resume` is preferred (when the agent declares `sessionCapabilities.resume`), otherwise `session/load` (when it declares `loadSession`); if neither is supported, the round fails with `native_resume_unsupported` and **does not** quietly open a new session and lose context. History messages replayed by `session/load` are not written into the new round's output.
4. Model: `default` means keep the agent's own model. An explicit model must appear in the `configOptions` returned by the session (`category: "model"`) or in the legacy `models`, and must be confirmed as selected through `session/set_config_option`; otherwise the round fails with `model_not_supported` / `native_model_mismatch` and the task is not sent. If a resumed session returns no model configuration at all, it continues only when the requested model is the same as the model OAA confirmed in the previous round (`nativeState.model`).
5. `session/prompt`: the prompt is "published instructions + task + input file list + the outputs/ convention". The text stream of `agent_message_chunk` is written to OAA's durable output in real time; thinking content (`agent_thought_chunk`) does not enter the output and only records one `thinking` progress entry; `tool_call`/`tool_call_update`/`plan` are recorded as progress events (title, kind, status).
6. Completion is reported only when `stopReason: "end_turn"` and no permission request was denied; `max_tokens`, `max_turn_requests`, `refusal`, and so on are recorded as `native_incomplete`.
7. After the round, stdin is closed and the process is given time to exit by itself (2 seconds by default); otherwise the whole process group is terminated (SIGTERM, then SIGKILL after 1.5 seconds). Files under `outputs/` are collected as artifacts by the same rules as native engines.

### Caller tools (`mcpServers`)

The profile's `client_tools` is `bridge`: when the caller requests `X-OAA-Client-Tools: bridge` and passes tools, the `mcpServers` of `session/new` / `session/load` / `session/resume` holds one stdio entry; in all other cases it is still `[]` (the bytes on the wire are unchanged):

```json
{
  "name": "oaa-caller",
  "command": "/usr/local/bin/node",
  "args": ["/opt/oaa/dist/src/cli.js", "mcp-relay", "--socket", "/tmp/oaa-r-x1/relay.sock", "--token-file", "/tmp/oaa-r-x1/token"],
  "env": []
}
```

- The field shape follows the public description of the ACP specification (stdio form: `name`, `command`, `args`, and `env` as an array of name-value pairs) and has **not been tested with a real agent**. (Updated 2026-11-11: the ACP entry of the local Antigravity command line (`agy` 1.5.5) was tested for real once with Gemini 3.8 Flash; one managed call and one bridged call both passed, and the stdio entry shape of `mcpServers` was accepted. Parallel calls, streaming, slow returns, and other ACP agents are still unverified. For the results see [evidence.md](evidence.md).)
- The relay is `oaa mcp-relay`: a stdio MCP server whose `tools/list` returns the caller's tools and whose `tools/call` is forwarded to the execution machine over a local Unix domain socket (0600, in a private 0700 directory, with a one-time token); it listens on no network port and logs only to stderr. When the round ends, the socket is closed, the files are deleted, and the relay exits.
- An execution machine receives tasks with caller tools only after declaring `client-tools-v1` in the handshake.
- See [harness.md](harness.md), "How bridging works for external agents".

### Permission approval

`session/request_permission` is connected to the same native approval bridge as Claude/Codex: a pending approval with `kind: "native"` is created in OAA, and its `detail` contains `native: "acp"`, the adapter name, the tool title/kind, `rawInput`, the paths involved, and the options.

- When the owner approves, only the `allow_once` the agent offers is chosen, **never** `allow_always`; one approval never becomes a long-term grant.
- The following cases are denied by default (`reject_once` is chosen, or `cancelled` is answered if there is none): the owner denies; the approval bridge is unavailable; the agent offers no `allow_once`; the approval detail exceeds 256 KiB (approval is never obtained with truncated content).
- If any request was denied during the round, the round fails with `permission_denied` even if the agent then ends normally: a normal process exit is not grounds for success.

### Cancellation, timeouts, and failures

- On cancellation or when the run deadline arrives: `session/cancel` is sent first, and the agent is given up to 3 seconds to confirm with `stopReason: "cancelled"`; then the process group is terminated. Consistent with the other native engines, a native task that had already started executing and is then cancelled is recorded as `interrupted` (`effect_outcome_unknown`), because side effects already produced cannot be ruled out.
- Each handshake step (initialize, session creation/resume, model setting) takes at most 60 seconds; a timeout is `adapter_timeout`.
- The process exits early: `native_incomplete` (with the redacted tail of stderr attached); stdout carries non-JSON-RPC content or a single message exceeds 8 MiB: `native_protocol_error`; the agent returns JSON-RPC `-32000`: `adapter_auth_required`. Sign in within that agent's own CLI; OAA never calls `authenticate` and stores no credentials.
- Usage: recorded only when all three fields of `PromptResponse.usage` (marked unstable in ACP, per-round usage) are non-negative integers and not all 0 (an all-zero report, as from Qoder, is treated as "usage unknown" and not as having used 0 tokens); `usage_update` is written to `nativeState` only as context occupancy, not treated as billing, and no cost is inferred.

### Preset catalog and discovery

The presets were ported from the author's own Possibility project (see the file header of `src/config/agent-presets.ts` and `THIRD_PARTY_NOTICES.md` for the source and Apache-2.0 attribution). Maturity follows the vendors' own labeling: `documented` means the vendor publishes an ACP entry point, `preview` means the vendor still labels it preview/experimental/early access, and `community` means the vendor has no ACP entry point and only a third-party or ACP-organization adapter listed in the ACP Registry (added 2026-11-08). The "Verified" column is the date on which the command and maturity were checked against the vendor's official documentation (against the Registry for community entries); in the API it is `verified`, and `null` means "to be verified".

| Preset ID | Name | Command template | Maturity | PATH discovery | Verified |
| --- | --- | --- | --- | --- | --- |
| `qoder` | Qoder CLI | `qoder --acp` | documented | `qoder` / `qodercli` | 2026-11-08 |
| `deepseek-harness` | DeepSeek Harness ACP | `dsh --profile acp` | documented | `dsh` | 2026-11-10 |
| `kimi` | Kimi Code CLI | `kimi acp` | documented | `kimi` | 2026-11-08 |
| `vibe` | Mistral Vibe CLI | `vibe-acp` | documented | `vibe-acp` | 2026-11-10 |
| `gemini` | Gemini CLI | `gemini --acp` | documented | `gemini` | 2026-11-08 |
| `antigravity-acp` | Google Antigravity ACP | `agy_acp_server.par` | documented | `agy_acp_server.par` | 2026-11-10 |
| `amp-acp` | Amp ACP | `amp-acp` | community | `amp-acp` | 2026-11-08 |
| `cortex-code` | Snowflake Cortex Code | `cortex acp serve` | documented | `cortex` | 2026-11-10 |
| `pi-acp` | pi ACP | `npx -y pi-acp@0.0.34` | documented | not discovered (npx launcher) | 2026-11-10 |
| `deepagents` | DeepAgents | `npx -y deepagents-acp@0.1.7` | documented | not discovered (npx launcher) | 2026-11-10 |
| `junie` | JetBrains Junie | `junie --acp=true` | preview (EAP) | `junie` | 2026-11-08 |
| `opencode-acp` | OpenCode ACP | `opencode acp` | documented | `opencode` | 2026-11-08 |
| `copilot` | GitHub Copilot CLI | `copilot --acp --stdio` | preview | `copilot` | 2026-11-08 |
| `goose` | Goose CLI | `goose acp` | documented | `goose` | 2026-11-08 |
| `kiro` | Kiro CLI | `kiro-cli acp` | documented | `kiro-cli` | 2026-11-08 |
| `cursor` | Cursor Agent CLI | `agent acp` | documented | `agent` / `cursor-agent` (the real path must contain cursor) | 2026-11-08 |
| `qwen` | Qwen Code CLI | `qwen --acp` | documented | `qwen` | 2026-11-08 |
| `auggie` | Auggie CLI | `auggie --acp` | documented | `auggie` | 2026-11-08 |
| `factory-droid` | Factory Droid | `droid exec --output-format acp-daemon` | documented | `droid` | 2026-11-08 |
| `cline` | Cline CLI | `cline --acp` | documented | `cline` | 2026-11-08 |
| `devin` | Devin for Terminal | `devin acp` | documented | `devin` | 2026-11-10 |
| `hermes` | Hermes | `hermes acp` | documented | `hermes` | 2026-11-10 |
| `kilo` | Kilo Code | `kilo acp` | documented | `kilo` | 2026-11-10 |
| `reasonix` | DeepSeek Reasonix | `reasonix acp` | documented | `reasonix` / `dsnix` | 2026-11-10 |
| `trae-cli` | Trae CLI | `traecli acp serve` | documented | `traecli` | 2026-11-10 |
| `grok-build-acp` | Grok Build ACP | `grok agent stdio` | documented | `grok` | 2026-11-10 |
| `claude-acp` | Claude Agent ACP | `npx -y @agentclientprotocol/claude-agent-acp@0.85.1` | community | not discovered (npx launcher); looks for `claude-agent-acp`/`claude-code-acp` | 2026-11-08 |
| `codex-acp` | Codex ACP | `npx -y @agentclientprotocol/codex-acp@2.1.1` | community | not discovered (npx launcher); looks for `codex-acp` | 2026-11-08 |
| `codebuddy` | CodeBuddy Code | `npx -y @tencent-ai/codebuddy-code@2.161.1 --acp` | documented | `codebuddy` (discovers an installed native `codebuddy --acp`) | 2026-11-08 |
| `minimax-code` | MiniMax Code | `npx -y @minimax-ai/code@0.2.7 acp` | documented | not discovered (npx launcher) | 2026-11-10 |
| `glm` | GLM Agent | `npx -y glm-acp-agent@1.17.0` | documented | not discovered (npx launcher) | 2026-11-10 |
| `grok` | Grok Build Agent | `npx -y @xai-official/grok@1.0.79 agent stdio` | documented | not discovered (npx launcher) | 2026-11-10 |

- `oaa init`: looks up the executables in the table above by file name on PATH (it reads only file metadata and executes nothing), and writes what it finds into `localWorker.adapters`, **all disabled**.
- `oaa doctor`: lists the ACP agents it discovered and whether each is configured; `oaa doctor --write` only appends the not-yet-configured ones as disabled entries (it does not touch existing entries and can be run repeatedly), and the gateway must be restarted after writing.
- A file of the same name may belong to another tool (such as `goose`, `copilot`, `kilo`, `hermes`, `cortex`); a discovery result is only a "file name match", and before enabling you can confirm the identity with the handshake check below. `agent` is treated as Cursor only when its real path contains `cursor`.
- The `npx` launcher presets are only templates. After a global install, `claude-acp` and `codex-acp` look for `claude-agent-acp`/`claude-code-acp` and `codex-acp` (executable names inferred from the package names, not verified one by one).

### Console API

- `GET /v1/local/backends` (the owner's admin key): `data` is the configured backends, each `{engine, kind: "native"|"acp"|"adapter", transport?, preset?, name, executable, args?, enabled, maturity?, docs_url?, verified?, publishable, evidence, handshake?, conversion}` (for an A2A/HTTP adapter `executable` is the endpoint URL and there is no `args`); native entries keep `model_overrides`. `publishable` means it is enabled and the executable exists (for an http adapter, the endpoint and token are ready). `evidence` is `installed_not_exercised`, `not_installed`, or `handshake_passed`. It also returns `presets`: the full catalog of the 4 native engines and 32 ACP presets (including `configured`, `engine`, `installed_executable`, `launcher`, `notes`, `verified`, `conversion`).
- `POST /v1/local/backends/:engine` `{enabled}`: `:engine` is a native name or the URL-encoded `adapter%2F<name>` (`/v1/local/backends/adapter/<name>` is also accepted). It changes only this platform's database and the in-memory worker configuration, not the native app's global configuration; after the executable changes, the saved enabled state is invalidated automatically.
- `POST /v1/local/backends/adapter%2F<name>/check`: a handshake check explicitly triggered by the owner; it does not enable the adapter. For ACP it runs only `initialize` in an empty temporary directory, creates no session, sends no prompt, and calls no model; the result is recorded as `handshake_passed` (including the agent name, version, `load_session`, and authentication methods) and refines that entry's `conversion.resume` accordingly; for A2A it only reads the agent card (see "A2A remote agents"). Other adapters return `400 check_unsupported`.
- `POST /v1/agents/publish-native` `{id, engine, models, approvals?}` (`approvals` is `ask` or `auto`; see "Approval policy at publish time" above): `engine` can be a native name, or any `adapter/<name>` enabled (advertised) on any online node; when it is not enabled it returns `409 backend_not_enabled`. `default` in `models` means keep that agent's own model. CLI: `oaa publish-native --engine adapter/gemini --models default`.
- `/v1/overview`: an agent's `engine` stays `adapter/<name>`, and the optional `preset` (icon ID) and `conversion` (the conversion profile, see above) are added.

### Boundaries not yet verified

- Ordinary tests use only local fake agents (`test/fixtures/acp-agent.mjs`; the conversion contract matrix additionally uses `native-full.mjs`, `claude-code.mjs`, `stream-adapter.mjs`, and in-process HTTP/A2A fake remotes), covering the handshake, streaming output, session resume, approval approve/deny, cancellation and forced termination, model confirmation, and the various failures; **no real ACP or A2A agent has been tested end to end yet**, and differences between vendor implementations (authentication flows, `session/resume` support, how an explicit model is selected, A2A 1.0/0.3 implementation details, and so on) must be confirmed one by one.
- Vendor extension methods (such as Cursor's Q&A/plan or Kiro extensions) are not bridged and are handled as unsupported with `-32601`; non-text output such as images/audio only records progress and is not written to the output. Image **input** is supported: see [images.md](images.md).
- Verified only on macOS; process-group termination and PATH discovery on Windows are untested.
- A remote worker forwards streaming text and approvals through the same `oaa/1` protocol, but the end-to-end path of ACP on a remote node has not been tested separately.

## A2A remote agents (2026-11-08)

> New section. `transport: "a2a"` publishes a remote agent that implements the [A2A (Agent2Agent) protocol](https://a2a-protocol.org/latest/specification/) as `adapter/<name>`.

```json
{
  "adapters": {
    "research-peer": {
      "transport": "a2a",
      "url": "https://agents.example.com/a2a",
      "tokenEnv": "RESEARCH_PEER_TOKEN",
      "enabled": false
    }
  }
}
```

- Version: A2A 1.0.0 was released on 2026-03-12 (currently 1.0.1), and its method names, object shapes, and enums differ from 0.3. OAA sends **1.0** by default: `SendStreamingMessage` (SSE) / `SendMessage` / `CancelTask`, the request header `A2A-Version: 1.0`, `role: "ROLE_USER"`, and text parts as `{"text": …}` (without `kind`). When the other side supports only 0.3, set `"protocolVersion": "0.3"` to use `message/stream` / `message/send` / `tasks/cancel`, the `kind` discriminator, and `blocking: true`. Whichever you choose, responses of both versions can be read (1.0's `task` / `message` / `statusUpdate` / `artifactUpdate` members and `TASK_STATE_*` states, 0.3's `kind` and lowercase states), which is also what the 1.0 migration notes recommend for clients. Only the JSON-RPC binding is implemented; the gRPC and HTTP+JSON bindings are not.
- Transport: a non-local address must be `https:`, the URL must not contain a username and password, and redirects are not followed. With `"streaming": false`, non-streaming requests are used instead. The environment variable named by `tokenEnv` is sent as `Authorization: Bearer`, and the value stays only in the worker environment; if the variable is missing, the round fails with `adapter_not_configured` and no request is sent.
- Request: one user message, carrying the previous round's `contextId` when resuming; `acceptedOutputModes` is `text/plain`, `text/markdown`. The published instructions are placed before the task text.
- Mapping: text parts in agent messages and artifact updates are written to the output; non-terminal status updates are recorded as progress. A task entering a terminal or interrupted state ends the round (1.0's status updates have no `final` field, and the stream closes after those states): `completed` succeeds; `failed`/`rejected` is `adapter_incomplete`; `canceled` is `native_incomplete`; `input-required`/`auth-required` use the agent's question as the round's output, and replying with `previous_response_id` resumes the same `taskId`. A stream that ends in a non-terminal state (including 0.3's `final: true` stopping at `working`) is `native_incomplete`.
- Cancellation: aborts the request and sends `CancelTask` on a best-effort basis (`tasks/cancel` for 0.3, with a 5-second timeout).
- Failures: HTTP 401/403 is `adapter_auth_required`; other non-2xx responses or JSON-RPC errors are `adapter_failed` (error text redacted); invalid JSON or an unrecognizable result is `invalid_protocol`; a response or stream over 8 MiB is `adapter_output_limit`.
- Handshake check: `POST /v1/local/backends/adapter%2F<name>/check` only reads `/.well-known/agent-card.json` (the same for 1.0 and 0.3; it then tries the legacy path `/.well-known/agent.json`) and returns the name, version, `protocol_versions` (0.3's `protocolVersion` and 1.0's `supportedInterfaces[].protocolVersion`), `bindings` (such as `JSONRPC`), whether streaming is declared, and the number of skills, from which you can tell whether `protocolVersion: "0.3"` is needed; it sends no message, creates no task, calls no model, and does not enable the adapter.
- The configured endpoint is contacted only when a task runs or the owner requests a check.

Trade-offs: A2A lets OAA bring "agents hosted elsewhere" into the same catalog and approval/record system, but by nature it has no shared workspace (`artifacts: false`), no mid-run approval channel (only the question-and-answer handoff of `input-required`), and it reports no usage; whether the remote side actually stops is decided by the remote implementation. So it suits treating a remote agent as a "colleague you can call", and does not suit tasks that need to edit files in a local workspace or need item-by-item human approval; those should be connected locally through ACP or `oaa/1-stream`. At present the only vendor found to offer an official A2A service is Gemini CLI (`@google/gemini-cli-a2a-server`, labeled experimental); A2A support in the other mainstream coding agents is "to be verified".

Reference: `src/engines/a2a.ts`; the in-process fake A2A agent in the tests (which simulates both 1.0 and 0.3) is in `test/conformance.test.ts`.

## Verified connections for mainstream agents (2026-11-08)

> Programmatic connection methods checked one by one against vendors' official documentation (read-only research; no agent was installed or run). Entries with a date in the "Verified" column were checked against official sources; entries marked "to be verified" had no official source found or were not covered. The tier is the upper bound OAA can provide when connected the recommended way (that is, `conversion.tier`); whether a real agent actually streams piece by piece and whether it sends an approval request before executing has not been tested end to end.

| Agent | Recommended OAA connection | Preset / engine | Maturity | Tier | Verified | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | Built-in native (Agent SDK) | `claude`; ACP also has `claude-acp` | native / community | interactive | 2026-11-08 | Anthropic has no native ACP, and `claude-acp` is an adapter maintained by the ACP organization. ⚠️ Anthropic's documentation states that without approval, third-party products must not offer claude.ai sign-in or subscription limits to users and must use an API key; before publishing a Claude Code based on a personal subscription for others to call, confirm that it complies. For headless there is also `claude -p --output-format stream-json` (since v2.1.302, `-p` refuses by default any request that nobody approves). [^claude] |
| Codex CLI | Built-in native (app-server) | `codex`; ACP also has `codex-acp` | native (officially labeled Experimental) / community | interactive | 2026-11-08 | OpenAI has no native ACP; `codex exec --json` is JSONL headless, with a read-only sandbox by default; `codex mcp-server` has been removed. [^codex] |
| Gemini CLI | ACP (or A2A) | `gemini` | documented | interactive | 2026-11-08 | `--experimental-acp` is a deprecated alias; since 2026-06-18, free-tier and Google One users are served by the Antigravity CLI instead. The official A2A service `@google/gemini-cli-a2a-server` (experimental) can be connected with `transport: "a2a"` (streaming tier). [^gemini] |
| Antigravity CLI | Built-in native (stream-json) | `antigravity`; ACP `antigravity-acp` | native / documented | streaming | native verified (2026-11-02); ACP launch command verified (2026-11-10) | Headless mode has no approval bridge channel, and the agent's own denial is `permission_denied`. |
| Qwen Code | ACP | `qwen` | documented | interactive | 2026-11-08 | `--experimental-acp` is deprecated; there is also a `qwen serve` HTTP+SSE daemon (not connected). [^qwen] |
| Kimi Code | ACP | `kimi` | documented | interactive | 2026-11-08 | Supports `session/load`, `resume`, and `fork`; headless `kimi -p` does not ask for human approval (it runs under the auto policy). [^kimi] |
| OpenCode | ACP | `opencode-acp` | documented | interactive | 2026-11-08 | The v2 HTTP API and SDK have breaking changes; OAA uses only `opencode acp` (stdio). [^opencode] |
| Goose | ACP | `goose` | documented | interactive | 2026-11-08 | The vendor recommends ACP as the client integration interface; the HTTP/WS ACP of `goose serve` needs a key (not connected). [^goose] |
| Cursor Agent | ACP | `cursor` | documented | interactive | 2026-11-08 | `agent acp` (labeled advanced and hidden in the help; the Registry writes it as `cursor-agent acp`). [^cursor] |
| GitHub Copilot CLI | ACP | `copilot` | preview (public preview) | interactive | 2026-11-08 | `copilot --acp --stdio`; the Copilot SDK became GA on 2026-06-02 (not connected). [^copilot] |
| Cline | ACP | `cline` | documented | interactive | 2026-11-08 | ACP mode does not auto-approve by default; command-line task mode auto-approves by default, so it must be turned off explicitly when wrapping headless. [^cline] |
| Amp | ACP (community adapter) or an `oaa/1-stream` wrapper | `amp-acp` | community | interactive | 2026-11-08 | Amp has no official ACP; the official programmatic interfaces are `amp -x --stream-json` (said to be compatible with the Claude Code format as far as possible) and `@ampcode/sdk`. [^amp] |
| Augment Auggie | ACP | `auggie` | documented | interactive | 2026-11-08 | 1.x (pre-release) changed the headless parameters, which does not affect ACP. [^auggie] |
| Factory Droid | ACP | `factory-droid` | documented | interactive | 2026-11-08 | The official Zed documentation writes `droid exec --output-format acp`, and the Registry uses `acp-daemon` (the preset uses the latter). [^factory] |
| Kiro CLI | ACP | `kiro` | documented | interactive | 2026-11-08 | The Registry additionally passes `--agent-engine=v3`. [^kiro] |
| Qoder CLI | ACP | `qoder` | documented | interactive | 2026-11-08 | iFlow officially recommends migrating to Qoder. [^qoder] |
| Mistral Vibe | ACP | `vibe` | documented | interactive | 2026-11-08 | `vibe-acp` is installed with the CLI. [^vibe] |
| JetBrains Junie | ACP | `junie` | preview (EAP) | interactive | 2026-11-08 | Junie CLI is still in early access. [^junie] |
| CodeBuddy Code | ACP | `codebuddy` | documented | interactive | 2026-11-08 | The vendor's native `codebuddy --acp`; discovery of an installed `codebuddy` is supported. [^codebuddy] |
| TRAE CLI | ACP | `trae-cli` | documented | interactive | 2026-11-08 | Global flags must come before `acp serve`; it is not the same tool as the open-source bytedance/trae-agent. [^trae] |
| Aider | `oaa/1` stdio wrapper | no preset | — | basic | 2026-11-08 | No ACP and no JSON output; `aider --message "…" --yes --no-stream` can be wrapped, giving only a final result. [^aider] |
| OpenHands | ACP (manual configuration) | no preset | — | interactive (untested) | 2026-11-08 | Has `openhands acp`, but the vendor declares that the CLI is no longer maintained and the console has no icon for it, so it was not added to the presets. [^openhands] |
| iFlow CLI | Not connected | no preset | — | — | 2026-11-08 | Shut down on 2026-04-17. [^iflow] |
| DeepSeek Harness, Snowflake Cortex Code, pi, DeepAgents, Devin, Hermes, Kilo, Reasonix, Grok Build, MiniMax Code, GLM | ACP | see the preset catalog | follows the Registry labels | — | 2026-11-10 (launch commands) | Launch commands were checked against vendor documentation or the Registry (see the preset catalog); the access tier was not checked one by one. |

When wrapping a headless CLI (`oaa/1` / `oaa/1-stream`), pay special attention to the default approval behavior: Claude, Vibe, and Copilot deny calls that need approval by default when unattended; Codex and Factory are read-only by default; Cline command-line tasks, Amp, and Goose with `GOOSE_MODE=auto` allow by default. An adapter must set these parameters explicitly and be combined with a sandbox; otherwise the "final result" may come from operations nobody approved. An agent that can use ACP should use ACP first, to get OAA's item-by-item approval.

[^claude]: https://code.claude.com/docs/en/agent-sdk/quickstart ; https://code.claude.com/docs/en/headless ; https://code.claude.com/docs/en/cli-reference
[^codex]: https://learn.chatgpt.com/docs/app-server ; https://learn.chatgpt.com/docs/non-interactive-mode ; https://learn.chatgpt.com/docs/developer-commands?surface=cli
[^gemini]: https://geminicli.com/docs/cli/acp-mode/ ; https://geminicli.com/docs/cli/headless/ ; https://github.com/google-gemini/gemini-cli/tree/main/packages/a2a-server
[^qwen]: https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/ ; https://qwenlm.github.io/qwen-code-docs/en/developers/examples/daemon-client-quickstart/
[^kimi]: https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.md ; https://moonshotai.github.io/kimi-code/en/reference/kimi-command.md
[^opencode]: https://docs.opencode.ai/docs/acp/ ; https://opencode.ai/docs/migrate-v1/
[^goose]: https://goose-docs.ai/docs/gdk/acp/ ; https://goose-docs.ai/docs/guides/goose-cli-commands/
[^cursor]: https://cursor.com/docs/cli/acp ; https://cursor.com/docs/cli/reference/parameters
[^copilot]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server ; https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/
[^cline]: https://docs.cline.bot/usage/acp ; https://docs.cline.bot/cli/cli-reference
[^amp]: https://ampcode.com/docs/cli/execute-mode ; https://ampcode.com/docs/cli/streaming-json ; https://ampcode.com/docs/sdk
[^auggie]: https://docs.augmentcode.com/cli/reference ; https://docs.augmentcode.com/cli/whats-new
[^factory]: https://docs.factory.com/integrations/zed ; https://docs.factory.com/reference/cli-reference
[^kiro]: https://kiro.dev/docs/cli/acp/ ; https://kiro.dev/docs/cli/headless/
[^qoder]: https://docs.qoder.com/cli/cli-reference
[^vibe]: https://docs.mistral.ai/vibe/code/use-vibe-in-other-ides ; https://docs.mistral.ai/vibe/code/cli/work-with-cli
[^junie]: https://junie.jetbrains.com/docs/junie-cli-acp.html ; https://junie.jetbrains.com/docs/parameters.html
[^codebuddy]: https://codebuddy.ai/docs/cli/cli-reference ; https://codebuddy.ai/docs/cli/headless
[^trae]: https://docs.trae.cn/cli_agent-client-protocol ; https://docs.trae.cn/cli_get-started-with-trae-cli
[^aider]: https://aider.chat/docs/scripting.html
[^openhands]: https://docs.openhands.dev/openhands/usage/cli/command-reference
[^iflow]: https://platform.iflow.cn/en/cli/changelog

## Antigravity protocol verification

The built-in adapter follows the official [headless stream-JSON contract](https://antigravity.google/docs/cli/headless/): input uses `event: "user"` with `message.content`, not the Claude-style `type: "user"` envelope. It waits for `init`, confirms an explicitly selected model exactly, and only then sends the task. A missing or different model fails before the prompt is sent. Denials and unsuccessful terminal results cannot be hidden by process exit code zero. A tool step whose `tool_info.error` (a string, or an object read as its JSON text) matches the same denial wording as stderr (`soft-denied`, `permission … denied`, `requires approval`) fails the turn as `permission_denied`; any other tool error is treated as a tool failure the agent may recover from, so its own terminal result decides the turn, and a turn without a successful result is `native_incomplete`. The exact shape of `tool_info.error` is not specified by the published contract and has not been observed on a live denial; the wording rule is conservative.

Initial-session usage is recorded when all three provider counters are valid nonnegative integers. The CLI documents its usage as session-cumulative, so continuation totals are retained as observed native state, not presented as per-call billing. No monetary cost is inferred.

On 2026-11-02, an authorized isolated `gemini-3.8-flash-low` task passed: the init event confirmed that model; two native `read_file` operations retrieved the supplied fixture files; the response contained the correct total and an unpredictable file marker. The first attempt failed at stream-input validation and is retained separately. This is not verification of every installed plugin, other native models, cross-machine execution, or production readiness. The ordinary test suite never calls a live model; the separate acceptance runner requires an explicit cost-confirmation flag and a fresh output directory.

### The ACP entry of agy (Antigravity): test record (2026-11-11)

`agy acp` is the ACP stdio server that ships with the Antigravity command line (available since 1.5.3). Configure it as an ACP adapter and it can be published, with nothing extra to install:

```json
{ "adapters": { "agy": { "transport": "acp", "command": "/path/to/agy", "args": ["acp"], "enabled": true } } }
```

- Model names use the values it declares in the ACP session: `gemini-3.8-flash`, `gemini-4-argon`, `claude-opus-5-5`, `claude-sonnet-5-5`, and so on. Names with a thinking-effort suffix such as `gemini-3.8-flash-low` from the command line are not ACP model options, and using one gets `model_not_supported` before the task is sent. Thinking effort is a separate option, `thought_level`, which currently keeps agy's default.
- It supports session resume (it declares `loadSession` and `resume`) and caller tool bridging; in the default mode, no permission request is sent when it calls an MCP tool.
- It is an independent connection path from the built-in `antigravity` native engine (the stream-json of `agy --print`).
