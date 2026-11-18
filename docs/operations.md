# Operations manual

English · [简体中文](zh-CN/operations.md)

This document collects the operational details of the command line and the API: publishing and invoking, inspecting routing before a call, exporting an installed agent, the MCP entry, catalog change notifications, inspecting and recovering requests, importing selected MCP tools, execution machines, and verification commands. The content was moved over as is from the 0.1.0 README; the README keeps only the entry points.

For protocol fields see [protocol.md](protocol.md), and for the architectural rationale see [architecture.md](architecture.md).

## Quick overview: switching agents freely, a steadier kernel, an easier language

The full descriptions of the capabilities below are in `docs/protocol.md`, `docs/language.md`, and `docs/architecture.md`.

**Switch to another agent and carry on.** After a request completes, you can have another agent continue in the same session; it first sees the earlier conversation and files:

```json
{ "protocol": "oaa/1", "agent": "agent/codex", "input": "Implement it following this plan",
  "previous_response_id": "resp_...", "handoff": true }
```

With the OpenAI-compatible endpoints the request structure does not change; put it in metadata: `"metadata": {"oaa.handoff": "true"}`. In the console, a completed request has a "Continue" button where you can choose who carries on.

**Switch to a fallback automatically when the primary fails.** Give fallback agents at submission time; if the primary fails before it has started doing anything (for example it cannot reach the model), the same request is completed by the fallback instead, and the caller does not need to retry:

```json
{ "metadata": { "oaa.agent_fallback": "agent/backup,agent/last" } }
```

A task that already has output or has already executed steps is not redone by another agent, to avoid doing the same thing twice.

**When the caller is itself an agent.** Tools such as Cursor, Cline, and Claude Code call OAA as a model and also bring their own `tools`. By default (mode `auto`) the gateway hands those tools to an agent that can take them over (a kernel agent, or an ACP external agent): when the agent needs the caller's tools, it hands the calls back as standard `tool_calls` (Chat Completions, Responses, Claude Messages, Gemini) to run, and after the result is returned the same run carries on; the response header `X-OAA-Client-Tools: bridge` says so. An agent that cannot take them over (Codex, Claude Code, Antigravity, A2A, HTTP adapters) behaves as before: the compatibility endpoints, Claude and Gemini let it finish with its own tools (`X-OAA-Client-Tools: ignored`), and OpenAI's default endpoints refuse with a message that names the three ways out. `X-OAA-Client-Tools: managed | bridge | reject | auto` chooses explicitly, and the gateway setting `clientTools.default` changes what a request that chooses nothing gets (`managed` restores the behaviour of versions before `auto`). For the modes and what is supported, see [docs/harness.md](harness.md).

**Enable an agent already on your computer in one click.** In the list of supported agents on the console's "Execution machines" page, an installed agent shows an "Enable" button; one click and it is usable, with no configuration file to edit and no restart. After that, "Publish" it as a callable agent.

**Every step in a flow can be retried and time-limited.**

```text
flow "load" {
  params { path: string }
  step doc = read_file(path = $input.path) retry(2, backoff=200ms) timeout 30s fallback = "missing"
}
```

This is allowed only on tools where repeating the call is harmless; using it on an ordinary write is reported as an error at check time.

**A language that is easier to write and easier to debug.** Type aliases such as `type Doc = { path: string }` are supported; a misspelled keyword gets a suggestion of the closest spelling (`Did you mean 'description'?`), and several misspellings are reported at once; the output of `oaa fmt` is the same concise form a person would write by hand.

**A faster kernel.** Streamed text arriving in the same batch is merged into one write, and a batch of mixed long and short tools no longer waits for the slowest one. The data safety level and every byte of the wire output are unchanged; for the benchmark numbers and how they were measured see `docs/architecture.md`.

## Local start

Requires Node.js 24.18 or newer on the 24 or 26 line. No Docker, Redis, or global package installation is required.

```sh
npm ci --omit=optional --ignore-scripts
npm run build
npm run oaa -- init
npm start
```

Open [the console](http://127.0.0.1:8787). In connection settings, select `.oaa/admin.token`. Do not share this admin key. Create a scoped API key for each calling application. Tokens are stored locally with restricted permissions, not embedded in URLs.

The generated configuration is `.oaa/config.json`. Native executables are discovered but **disabled** until explicitly enabled on the console's **Execution machines** page. The macOS desktop app is the exception: for an out-of-the-box start it enables the local native agents it detects at launch (the gateway listens only on `127.0.0.1`); disabling one in the console is recorded in the local database and wins over that on later launches. `oaa quickstart` adds and enables only the offline sample agent `adapter/oaa-sample` (`examples/sample-agent.mjs`, calls no model) and records newly found codex / claude / agy as disabled. The toggle persists only in this platform's local database; it does not edit the native app's global configuration. Model credentials are environment references on the worker. No existing app credentials are extracted or modified.

For a managed local background process: `npm run oaa -- serve --detach`. Its PID and log are in the configured data directory. The default port is 8787; change `port` in your own configuration if occupied. Stop it with `npm run oaa -- stop` (it signals only the PID that `/health` reports). Create a caller key without the console with `npm run oaa -- key create --name myapp --agent agent/codex --url URL --token-file .oaa/admin.token`; the key is written to `.oaa/keys/myapp.key` (mode 0600) and not printed.

## Publish and invoke

Set the provider and model in your own configuration and agent definition. `examples/research.agent.json` deliberately contains a model placeholder, not an invented working connection.

```sh
npm run oaa -- publish examples/research.agent.json \
  --skill /absolute/path/to/a/selected/skill \
  --url http://127.0.0.1:8787 --token-file .oaa/admin.token

npm run oaa -- publish-native --id agent/codex --engine codex \
  --models default,gpt-model-you-have-access-to \
  --url http://127.0.0.1:8787 --token-file .oaa/admin.token

# Unattended: its permission requests are approved automatically (risks below)
npm run oaa -- publish-native --id agent/codex-auto --engine codex --approvals auto \
  --url http://127.0.0.1:8787 --token-file .oaa/admin.token

npm run oaa -- invoke agent/codex --model auto --input 'Your task' \
  --url http://127.0.0.1:8787 --token-file /path/to/scoped.token
```

`--approvals auto` makes the agent's permission requests (commands, file edits, tool calls) approved by policy instead of waiting for the owner; each one is still recorded (`actor: "policy:auto"`). This lets callers drive the agent with your permissions on this machine. Give such an agent a dedicated API key restricted to it, expose it only to trusted callers, and use a sandbox execution level where possible. See [protocol.md](protocol.md#approval-policy-for-external-agents-approval-policy-v1).

`default` on a native backend preserves its configured model. Model aliases are owner-declared, not proof of upstream account access. Automatic routing selects only published eligible routes using configured priority, observed latency, failures, and cooldown. Continuing sessions retain their route and bundle version; model changes require a new session. It never switches models halfway through an uncertain operation.

Standard OpenAI SDK usage:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=YOUR_SCOPED_KEY)
response = client.responses.create(
    model="agent/research", input="Analyze the supplied sources.",
    metadata={"oaa.model": "auto"}, background=True,
)
result = client.responses.retrieve(response.id)
```

The explicit native protocol is `POST /v1/invoke`:

```json
{
  "protocol": "oaa/1",
  "agent": "agent/codex",
  "model": "auto",
  "input": "Your task",
  "background": true
}
```

See [protocol and compatibility](protocol.md) for supported fields, file upload, streaming, approval, resume, and cancellation.

## Inspect routing before execution

```sh
npm run oaa -- preview agent/codex --model auto \
  --url http://127.0.0.1:8787 --token-file /path/to/scoped.token
```

The console shows the same read-only preview in the agent dialog. It reports eligible nodes, file placement, native model mappings, unavailable tools, target-specific cooldowns, and observed versus estimated latency. This does not start a model or reserve capacity.

Pin the reviewed publication with `agent_version` on `/v1/invoke`, `metadata["oaa.agent_version"]` on OpenAI-compatible requests, or `--agent-version <digest>` in the CLI. The console uses the displayed version for both preview and submission.

Tool bindings marked `required: true` must have an eligible executor before a request is accepted. Otherwise the request is rejected before model use. Unmarked bindings remain optional for compatibility: unavailable tools are reported and omitted from the current model request, not silently claimed to be loaded. Native agents still use their original host toolkits rather than portable kernel bindings.

## Export an installed agent

```sh
npm run oaa -- expose codex --models default --detach \
  --url http://127.0.0.1:8787 --token-file .oaa/admin.token
```

This explicit command enrolls a dedicated worker, enables only the selected native adapter, and publishes an agent bound to that node. It starts no model request. Its private configuration, credential, PID and log are kept under `.oaa/exposed/<engine>/`. It opens a new owned agent session when called; it does not commandeer an existing desktop conversation. Use an admin key only for setup, then distribute scoped invoke keys. `expose dsh` initially uses its native default model; extra model routes require explicit profile overlay mappings.

## MCP and plugin entry

```sh
npm run oaa -- integration --out /absolute/path/to/mcp.json \
  --url http://127.0.0.1:8787 --token-file /absolute/path/to/scoped.token
```

This generates MCP launcher JSON using the common `mcpServers` convention, with absolute executable paths. A particular host may require its own configuration format; this command does **not** overwrite any agent's global configuration. The accompanying [skill](../integrations/open-agent-api/SKILL.md) can be installed in the caller's existing skill/plugin system. A real stdio MCP client is tested against the generated launcher, not just an in-memory transport.

The MCP task workflow is `oaa_upload_text` (optional), `oaa_preview_route`, `oaa_invoke`, `oaa_wait_run`, then `oaa_read_output` and `oaa_list_artifacts`. Also available: `oaa_list_agents`, compact `oaa_get_run`, `oaa_cancel`, and admin-only `oaa_publish` / `oaa_publish_native`. Reuse an invocation's `idempotency_key` for retries of the same intended task. Cancelling a wait does not cancel the accepted task. Approvals remain in the separate owner console/API; the bridge does not automatically approve its own tool use.

Discovery is progressive: `oaa_list_agents` returns compact summaries, not full tool schemas or measured readiness. Follow `next_offset` with the same `revision`; a changed publication list returns an explicit conflict. Use `oaa_inspect_agent` with the selected version and `section: "routes"`, `"tools"` or `"skills"` to inspect complete identifiers in bounded pages. Read the linked version-pinned metadata resource only when full descriptions/schemas are needed. It contains no prompt bodies, script files or private worker configuration; published metadata itself still needs owner review. Resource reads over 4 MiB fail explicitly and can use the authenticated HTTP metadata link.

CLI equivalents are `oaa agents --limit 20`, `oaa agent AGENT --section routes --agent-version DIGEST`, and `oaa agent AGENT --agent-version DIGEST --out NEW_METADATA_FILE`. Summary/detail JSON payloads fit within 20000 bytes; page sizes shrink rather than cutting off JSON or Agent/model IDs. The older full `/v1/agents` API remains unchanged for existing console clients.

Output text has lossless cursors; large results no longer hide response IDs or artifact references behind a truncated JSON preview. Artifact links are authenticated `oaa://files/{id}` resources. MCP resource reads are limited to 4 MiB to keep base64 frames bounded; larger files use authenticated HTTP or `oaa download` (up to the existing 8 MiB file limit). Access still requires file scope and the originating agent grant. There are no tokens in resource URLs.

CLI callers can complete the same workflow without the console: `oaa upload SELECTED_FILE`, `oaa invoke ... --idempotency-key KEY`, `oaa wait RESPONSE_ID`, `oaa output RESPONSE_ID`, `oaa artifacts RESPONSE_ID`, and `oaa download FILE_ID --out NEW_FILE`. Use `--url` and `--token-file` or `OAA_GATEWAY_URL` / `OAA_TOKEN_FILE`. Downloads never overwrite an existing file.

Publishing a native agent requires an enabled worker adapter as well as the MCP entry. Merely reading an MCP server does not export the caller's process, private plugins, or desktop login state.

## Follow published capabilities

Use the `catalog_cursor` from `GET /v1/agents` or `oaa_list_agents` to wait for visible publication, version, node and runtime changes. HTTP clients can use `/v1/catalog/events` (SSE) or `/v1/catalog/changes` (bounded wait); MCP callers use `oaa_watch_catalog`. The CLI supports `oaa catalog --cursor CURSOR --timeout-ms 20000` with the usual `--url` and `--token-file` options. Omitting the cursor returns an initial resync receipt without waiting.

A `reset` means reload the directory, not replay an execution. Notifications are coalesced, scoped metadata hints with a bounded in-memory history; gateway restarts and expired cursors explicitly request resynchronization. They neither distribute credentials nor dispatch tasks. API key revocation closes open readers without implicitly cancelling accepted work. See the [catalog contract](protocol.md#catalog-notifications).

## Inspect and recover work

The console's request inspector uses bounded state and paged output, steps, approvals and artifacts instead of repeatedly downloading entire execution records. Approval replies stay editable across refreshes. Full text, step JSON and approval JSON are downloaded only on request; all reads retain the caller's owner, scope and agent checks. The [native inspection API](protocol.md#bounded-inspection-and-mcp-delivery) supports the same workflow without the console.

The overview is an operations cockpit (approvals waiting on you, success rate, P50/P95 latency, an activity pulse and a critical-path breakdown of where time went), and each request has a timeline with parallel lanes and its critical path. See the [console guide](console.md).

An unknown external write outcome blocks Resume. An authorized operator must explicitly record `completed` with a result, or `not_executed`, before separately resuming a kernel run. This is an **operator assertion**, visibly retained in the step history, not a new tool measurement. Both reconciliation and approval decisions commit with their audit events before execution can continue. A native black-box session is not presented as a replayable checkpoint, and a failed HTTP response is not permission to repeat an external write.

## Data retention and backups

On `GET /metrics`, `oaa_run_outcomes_total{agent,status}` is the counter for completion and failure rates. It counts transitions into terminal states and survives history pruning and restarts. At first upgrade it starts from the terminal runs still retained, not already-deleted history. The older `oaa_runs_total`, `oaa_run_errors_total`, `oaa_run_tokens_total` and `oaa_tokens_total` series retain their names and snapshot values, but are gauges: do not apply `rate()` to them.

Nothing is deleted automatically unless you ask for it. `oaa prune [--older-than 30d] [--dry-run] [--vacuum]` deletes finished runs older than the given age with their events, steps, artifacts and webhook approval announcements, plus uploads (including stored image inputs) and session workspaces that no kept run uses. Queued, running, waiting and `interrupted` runs are never touched, nor is a run whose developer-platform ledger line is still unsettled. Ledger lines, key usage totals, memories and webhook delivery logs are records and stay. To prune on a schedule, set `"retention": {"runsDays": 30}` in `config.json`; `oaa doctor` and `oaa status` warn when the database grows past `retention.warnDatabaseMb` (default 1024).

Before a schema migration the gateway copies the database to `backups/state-v<old>-before-subjects-<time>.sqlite`; only the newest 3 copies per source version are kept. Details, measured soak results and crash-recovery semantics: [stability.md](stability.md).

## Import selected MCP tools

An existing owner-configured MCP server can be inspected and prepared without executing a tool or copying its connection credentials:

```sh
npm run oaa -- mcp inspect --config worker.json --server private_notes
npm run oaa -- mcp prepare --config worker.json --server private_notes \
  --tool read_note --capability private/notes --effect read --export-result \
  --out prepared-notes
npm run oaa -- node join --config worker.json --tool-config prepared-notes/worker-tool.json
npm run oaa -- build agent.json --tool-binding prepared-notes/binding.json \
  --skill /explicitly/selected/skill --out reviewed-bundle.json
npm run oaa -- publish-bundle reviewed-bundle.json \
  --url http://127.0.0.1:8787 --token-file /path/to/admin.token
```

`prepare` writes a public binding, a private worker-tool overlay and a review summary into a **new** directory. It changes no running configuration. The default effect is `unknown`, approval is required, and result export is disabled unless explicitly opted in. Upstream `readOnlyHint` annotations are hints, not authority. `--approval none` is an explicit operator policy choice, not an inferred optimization. The prepared tool is required by default; `--optional` permits degraded execution without it.

The binding contains selected tool metadata and a host reference; connection commands, URLs, tokens and environment values are not copied from the worker configuration. The selected worker config keeps its MCP connection under `mcp`; gateway configs with `localWorker` also work for inspection/preparation. `serve --tool-config ...` can apply an overlay to that local worker for the current process. Existing references/capability versions cannot be silently replaced. `publish-bundle` publishes the reviewed bundle version without re-reading skill directories. Metadata can itself contain private information, so review it; credential scanning is heuristic, not a privacy proof.

MCP connections are isolated by owner, session, agent version and connection credentials. They are reused only within that scope, expire after 60 seconds idle, and have a bounded idle cache. A domain error does not close another caller's parallel request. Prepared metadata fingerprints are checked before tool calls; drift requires a new review/version. Task-required MCP tools are explicitly rejected by this synchronous worker profile. This is not an attestation or sandbox of a third-party server's implementation/global state, and its process-local state is not promised to survive idle eviction or a gateway restart.

## Workers

Enroll a node using the admin console/API (`POST /v1/nodes/enroll`). Give it its own credential and only the intended agent/capability grants. A worker JSON file has this shape:

```json
{
  "nodeId": "workstation-2",
  "owner": "owner",
  "dataDir": "/private/path/oaa-worker",
  "gatewayUrl": "https://your-gateway.example",
  "tokenFile": "/private/path/node.token",
  "concurrency": 4,
  "providers": {
    "default": { "kind": "openai-responses", "apiKeyEnv": "OPENAI_API_KEY" }
  }
}
```

```sh
npm run oaa -- node join --config /private/path/worker.json
```

Workers connect outbound. Non-loopback connections require WSS/HTTPS with certificate validation. Configure gateway TLS or use a correctly configured trusted reverse proxy, plus explicit `allowedHosts` and `allowedOrigins`. There is no public deployment or system network configuration performed by this repository. For a public gateway serving trusted callers (per-caller data isolation, `consoleHosts`, `nativeEnv` allowlist, reverse proxy examples), see the [public deployment runbook](deploy-public.md).

Portable bundles contain only explicitly selected files. Host-bound tools name a node and remain there. Node-side tool configuration binds MCP references, selected read-only directories, or owner-approved scripts. The scheduler does not broadcast task contents to every node. Explicit file `allowed_nodes` constraints are checked before dispatch and again by the worker.

An owner-wide admin can manage remote nodes in the console or through `oaa nodes`, `oaa node drain NODE`, `oaa node resume NODE`, `oaa node revoke NODE` and `oaa node history NODE`. Pausing dispatch lets already-started calls settle, but blocks later steps; affected kernel tasks keep confirmed checkpoints and can be explicitly continued with `oaa resume RESPONSE_ID` after capacity returns. Revocation is terminal for that node identity and survives gateway restart, including config-file credentials. It closes trusted input immediately but does not claim that remote side effects or escaped processes stopped. Unknown writes still require reconciliation. No existing credential file is modified, and the local worker is protected from remote revocation controls.

## Native backend boundaries

| Backend     | Integration                                                                               | Current boundary                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Dedicated stdio app-server, model selection, session continuation, approval bridge        | Installed schema inspected; fixture-tested, no live provider test                                                                                                                             |
| Claude      | Official Agent SDK using the separately installed CLI and native configuration            | Type-checked; no live SDK/credential test                                                                                                                                                     |
| Antigravity | Stream-JSON `event: "user"`, confirmed init model before sending a prompt, observed usage | One authorized Gemini 3.8 Flash Low file-reading task passed locally; other models, continuation accounting and cross-machine behavior remain unverified; interactive approval is unavailable |
| DSH         | Installed `dsh --profile headless`, owned one-shot process                                | Final text only; no native continuation or tool trace. Explicit model changes need owner-configured `native.dsh.models` overlay arguments                                                     |

Native permissions are inherited, not sandboxed by this gateway. A native invocation may read or modify anything the host runtime allows. The self-built kernel's built-in file tools use a dedicated session workspace; explicitly registered host tools and scripts retain their declared host authority. This is not an isolation boundary against a malicious node, script, or same-user local process.

## Verification

```sh
npm test
npm run demo
npm run bench
npm run bench:stream -- --label local --out .oaa-bench/streaming-new.json
npm run bench:fair -- --label local --out .oaa-bench/fairness-new.json
npm run oaa -- doctor
```

Tests use local deterministic models, local protocol servers, and owned subprocess fixtures. The demo writes `.oaa-demo/report.md`; the scheduler microbenchmark writes `.oaa-bench/runtime.json`. These do **not** establish real provider compatibility, real cross-machine performance, account access, or superiority to OpenAI/AgentScope. Live model usage and external deployment require explicit access and cost authorization.

Separately, one authorized read-only `agy` task using `gemini-3.8-flash-low` passed on 2026-11-02: two actual `read_file` operations, correct arithmetic and an unpredictable marker read from the supplied file. The prior malformed-input attempt is retained as a failure, not relabelled as success. This verifies that specific local route and task only. The live runner is `examples/live-native-acceptance.ts`; it is never part of `npm test`, requires `--confirm-live-cost`, makes one native invocation per new output directory and does not retry. Native token limits are not advertised as enforceable spending caps, and reported tokens are not a cost estimate.

The streaming benchmark counts actual SQLite snapshot writes and checks durable output replay on fixed workloads. Reports are never overwritten; choose a new output path for each run. `--compare BASELINE.json` compares only matching workload hashes. Storage schema v4 (current) retains the checkpointed v2 text journal, adds persistent node admission/revocation audits (v3) and caller data isolation (v4); existing data migrates transactionally, and a v3 database is backed up automatically before the v4 migration. Back up before upgrade. Do not downgrade with an older gateway binary or restore stale credential authority without review.

The fairness benchmark measures a short request alone and behind long tool/graph work with one gateway slot. It reports first event, first text, completion and total workload time, separates the first fixture request from warm samples, and verifies identical model/tool counts and outputs. Kernel tasks yield only at confirmed boundaries when another task is waiting; active operations and native sessions are not forcibly split. These local queue-latency measurements do not establish the separate 30% real-model performance target or a monetary cost advantage.

An optional [paired runtime benchmark](../bench/paired/README.md) runs the actual AgentScope 2.0.11 SDK alongside OAA, with serial and parallel profiles, a shared credential-free scripted model/tool oracle, fresh-session trials and source/dependency records. It verifies call counts, dependency results and actual concurrency instead of comparing unrelated demos. OAA's SQLite durability and AgentScope's default in-memory state remain explicitly different. These measurements are not live-model, fee, full-service or cross-machine acceptance, and do not establish the 30% target.

Architecture and source rationale: [architecture](architecture.md). No user home is scanned for secrets, no foundation model is trained, and no subscription pool or hidden authentication relay is implemented.

OAA-Lang supports checked workflow results and semantics-preserving formatting. A flow's explicit `return` selects what reaches the next model turn without removing tool execution records or bypassing approvals. See the [language reference](language.md) and [document excerpt example](../examples/projected-workflow.oaa).
