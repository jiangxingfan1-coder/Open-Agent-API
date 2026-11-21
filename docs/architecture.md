# Architecture and design rationale

English · [简体中文](zh-CN/architecture.md)

This document explains the architecture of Open Agent API by topic: what each design decision is, why it was made, and where the evidence stops. For interface fields and error codes see [protocol.md](protocol.md); for engineering conventions see [engineering.md](engineering.md).

Contents:

1. [Product boundary](#1-product-boundary)
2. [Layers and directories](#2-layers-and-directories)
3. [The kernel](#3-the-kernel)
4. [Two-layer harness](#4-two-layer-harness)
5. [External agent connections](#5-external-agent-connections)
6. [Persistence and streams](#6-persistence-and-streams)
7. [Distribution network](#7-distribution-network)
8. [Observability](#8-observability)
9. [Three catalogs: errors, events, limits](#9-three-catalogs-errors-events-limits)
10. [Evidence and performance](#10-evidence-and-performance)
11. [Known limitations](#11-known-limitations)
12. [References and sources](#12-references-and-sources)
13. [Appendix: unimplemented proposals](#appendix-unimplemented-proposals)

## 1. Product boundary

What Open Agent API offers to the outside is **the capability of an agent**, not merely a model endpoint. The stable `oaa/1` call contract sits above the kernel and the external agent adapters, and below the HTTP / OpenAI-compatible layer, the MCP bridge, and the admin console. An agent and its model route (a model the agent may use, together with its provider) can be chosen separately.

How the three relate:

- **An agent** is the unit that is called, by its call name (put in the `model` field).
- **A model route** is a model and provider that an agent can use. An agent can have several, declared by the publisher.
- **Capabilities** are the tools, skills, and files an agent can use, likewise declared at publish time; external agents bring their own tools.

The kernel handles scheduling, approvals, execution state, events, and artifacts. External agents are opaque execution units: their internal tool graphs, account permissions, and plugins available only on the desktop cannot be inferred from a CLI exit code or an installation probe. The current state of support is listed item by item in the README under "Which agents can be connected" and "Status and limits".

## 2. Layers and directories

Apart from the command-line entry `src/cli.ts`, every file under `src/` lives in a layer directory (`src/<directory>/<file>.ts`). The layers are defined in `LAYERS` in `test/architecture.test.ts`:

| Directory | Layer | Responsibility |
| --- | --- | --- |
| `core/` | 0 | Shared definitions and foundations: contracts, utility functions, schemas, built-in tools, the error / event / limit catalogs, the run status transition table |
| `config/` | 1 | Configuration and agent presets |
| `lang/` | 2 | The OAA-Lang compiler, the execution graph, the immutable capability bundle |
| `store/` | 2 | Persistence: event and checkpoint storage, output projection, bounded viewing, audit |
| `providers/` | 2 | Model provider drivers and the shared stream reader |
| `engines/` | 3 | External agent connections (the inner harness): native, ACP, A2A, adapters, subprocesses, and the sandbox |
| `fabric/` | 4 | Distribution network: node placement, WSS leased tasks, execution machines, MCP connections, tool import, local backends |
| `kernel/` | 5 | The kernel (the outer harness): execution and approval state, scheduling, delegation, handoff, fallback agents, caller tools |
| `gateway/` | 6 | Gateway and protocols: the authentication entry, the compatibility protocols, catalog and discovery, streams, timelines and activity statistics, console static assets |
| `client/` | 7 | Client and the MCP bridge |

The dependency rules are enforced by the architecture test: a file may import only from its own directory or from a lower layer, and different directories in the same layer must not import each other; files must not form import cycles (`import type` counts too); no file may import `cli.ts`; a file over 600 lines gets a registered line budget that may only be lowered; and the number of `any` in `src/` is capped at 0. For details see [engineering.md, section 2](engineering.md#2-directory-layers-and-dependency-rules).

The storage layer is the authoritative source for events and checkpoints (SQLite). Each session has only one active run at a time, guaranteed by a partial unique index.

Change log: since 2026-11-10 the sources are split into layer directories (before that they were flat at the top of `src/`), and the architecture test was added.

## 3. The kernel

### 3.1 Responsibilities

The kernel is the outer harness: Open Agent API itself drives the model rounds, executes tools, manages approvals and run state, and hands execution to the built-in kernel or to an external agent. By responsibility it divides into admission and submission, model rounds (routing and intent analysis are in `kernel/routing.ts`), the tool phase, approval parking, external agent rounds, delegation (`kernel/delegate.ts`), handoff (`kernel/handoff.ts`), fallback agents (`kernel/fallback.ts`), caller tool bridging, and text output writing (`RunTextSink`, `kernel/text-sink.ts`). For the specific files see `src/kernel/`.

The classification of terminal states after a failure is a table of rules in priority order in `src/kernel/run-state.ts` (with unit tests), and its behavior is equivalent to the earlier chain of ifs: once the deadline has passed, the error code is always `run_timeout`.

Change log: 2026-11-10 terminal-state determination became a rule table; a tool batch became its own tool phase, and `execute` shrank from about 690 lines to about 520; routing was separated from the protocol parsing file into `kernel/routing.ts`, so `gateway/protocol.ts` keeps only the wire compatibility layer; `core/builtins.ts` removed the circular dependency between the language compiler and `bundle.ts`.

### 3.2 Run state machine

The legal transitions of `Run.status` are registered in `RUN_TRANSITIONS` in `src/core/run-status.ts` (`src/kernel/run-state.ts` re-exports `canTransition` / `assertTransition`). The table was derived from running the full test suite: at the entry points where the storage layer writes run status, every `(from → to)` was recorded, and after 449 tests ran it was compared entry by entry with the kernel code.

| From | To | Trigger |
| --- | --- | --- |
| (new) | queued | Submission (`submit`); test fixtures can seed any state directly, and `createRun` does not go through the transition table |
| queued | in_progress | Obtained a run slot and started executing |
| queued | cancelled | Cancelled while queued or while scheduling was suspended |
| queued | failed | Approval denied or expired while scheduling was suspended |
| queued | incomplete | Deadline reached while scheduling was suspended |
| in_progress | completed | Finished normally (with `phase = 'done'`) |
| in_progress | queued | Yielded the run slot (scheduling suspended), or requeued with a fallback agent |
| in_progress | requires_action | Raised an approval (including suspension while waiting for approval) |
| in_progress | failed / cancelled / incomplete / interrupted | Failure classification (`classifyFailure`); `recover` turns it into interrupted at startup |
| requires_action | in_progress | An external agent continues after waiting for the approval in-process |
| requires_action | queued | A parked run finds the approval granted and re-enters |
| requires_action | failed / cancelled / incomplete | Approval denied or expired, cancellation, deadline (`finishParked`), or failure classification after an in-process wait |
| requires_action | interrupted | Still waiting for approval at shutdown, or `recover` at startup |
| interrupted | queued | The operator explicitly resumes (`resume`) |

Rules:

- A repeated write of the same state (`from === to`) is always legal; it is a checkpoint update.
- `completed`, `failed`, `cancelled`, and `incomplete` are terminal states and cannot be left; `interrupted` can return to `queued` only through `resume` (`terminal()` still counts it as "finished", for display and statistics).
- When entering `completed`, `checkpoint.phase` must be `done`.
- All the entry points in the storage layer that write run status (`save`, `checkpoint`, `checkpointStep`, `checkpointReassigned`, `recover`) go through the same `UPDATE`: the allowed source states are folded into `WHERE status IN (…)`, adding no SQL round trip, transaction, or fsync; only when nothing was written is the current state read once and `invalid_run_transition` (500) thrown, rolling back the whole transaction, so no event, step, or summary is written.

Change log: added in 0.2.0.

### 3.3 Admission, run slots, and fair yielding

The gateway does not put a global queue lock around every tool execution: runnable node work is asynchronous, writes partitioned by resource are executed serially, and node tasks gain priority as they wait. At confirmed checkpoints, when other runs are waiting, kernel runs also take turns in the gateway's admission queue. There is no real-time preemption of arbitrary model inference or shell commands.

Fairness at the node level alone cannot help requests that have not yet obtained a gateway run slot. When a model call round ends, or a batch of tools has all finished, and other runs are waiting, kernel execution hands the run slot back: it commits a `queued` checkpoint and a `run.queued` event with `reason: "fairness"`, then goes to the tail of the FIFO queue. Uncontended execution still takes the original short path and adds no yield checkpoint. This is round-robin per run, not tenant-weighted scheduling, and it does not guarantee fairness in CPU time.

The dependency graph provides the same boundary between adjacent ready batches. The results and artifact references of completed leaves are already persisted and are reused on re-entry. Rebuilding those results does not count as new progress and does not trigger a loop that keeps yielding without executing the next step. Before the gateway hands the run slot back, all sibling calls that have already started must finish, parallel graphs included. Side effects with unknown outcomes and hard failures take priority over yielding and approval parking.

The original deadline, model route, agent version, usage, and round budget stay unchanged after re-entry. A queued yielded run keeps a deadline / approval timer and counts toward the owner's admission limit. Cancellation removes it from the queue; an approval that is denied or expires ends it before the next tool starts. The gateway can resume a committed queued yield without replaying confirmed work; a run interrupted halfway through execution still needs an explicit operator resume. A yield that failed to commit is a failure, and dispatch must not continue from the uncommitted state.

An external agent session and a single model / tool call are indivisible. A very long opaque call holds the run slot until it returns; the scheduler does not pretend that a cancellation request can safely preempt arbitrary external side effects.

The admission queue is deduplicated per run: when a run is requeued with a fallback agent, cleaning up the old task does not wrongly delete the newly registered one. A run still suspended when the gateway closes always gets the error code `shutting_down`.

Change log: the date cooperative admission was added is not recorded in the original; 2026-11-11 admission queue deduplication and uniform error code on shutdown (T06c).

### 3.4 Model rounds and tool batches

When a model returns several tool calls at once, the tool batch is **backfilled as soon as a slot frees**: at most `toolConcurrency` run at the same time, and the moment any one finishes the next one starts (before, the batch was cut into fixed chunks of `toolConcurrency`, and the slowest call in a chunk held up the whole chunk). Semantics that stay unchanged: after a hard failure (including a side effect with an unknown outcome) no new call is started, and the error is thrown only after everything already started has finished, with an unknown outcome taking priority over an ordinary failure; a call waiting for approval does not block the others; every backfill after the first window is a fair-yield point; results are filled back in the order of the calls the model gave; the "queued" record is still merged per window into one commit. Measured: "one 80 ms call + seven 5 ms calls, concurrency 2" dropped from about 103 ms to about 85 ms (the theoretical optimum is 80 ms).

The execution graph uses a ready queue indexed by dependency, instead of waiting for the slowest one in a whole batch. When a node finishes, the nodes that depend on it are unlocked at once. The items of a `foreach` share the graph's concurrency budget, and the returned array keeps the input order; parallel graphs and nested workflows also share one leaf execution pool within each run segment. Graph / workflow containers do not hold leaf permits themselves, so nesting cannot deadlock the pool. Independent branches can bypass a step that is pending approval and keep running.

Failure, cancellation, and cooperative yielding stop admitting new graph nodes and let the operations already admitted finish before returning. Side effects with unknown outcomes take priority over ordinary errors, scheduling yields, and approvals, inside a map as well. Every confirmed leaf keeps its original durable step ID and checkpoint. A graph whose expanded map / fallback IDs collide with other steps is rejected before dispatch instead of accidentally sharing a checkpoint. Fallback validation propagates a workflow's side effects transitively; delegation is treated as opaque / unknown; and a composed write workflow is not treated as idempotent merely because each tool in it is idempotent.

For step-level retry and timeout, and how to write automatic failover to another agent, see [language.md](language.md) and [protocol.md](protocol.md#agent-fallback-on-failure-oaaagent_fallback-2026-11-10).

The numbers above come from `bench/kernel-core.ts` (an in-process simulated model and tools, which do not represent real model or network time), with the baseline version and the current version run one after the other on the same machine. The other scenarios are flat: a zero-latency single run at about 1 ms, a 16-step execution graph at about 16 ms, and so on, show no obvious change; wide batches and execution graphs are bound by the concurrency limit of the execution machine in the test environment, not by kernel overhead.

Change log: 2026-11-10 tool batches became backfill-as-soon-as-ready.

### 3.5 Checkpoints and persistence

Queued, started, cache-hit, and failed states are committed together with the corresponding audit events. The `running` state and the `tool.started` event must be committed before dispatch. A successful result, new artifact references, the run checkpoint, and `tool.completed` are committed in the same transaction; observers are notified only afterwards. Parallel sibling steps cannot see artifacts staged by another step. The bytes and file records of artifacts are prepared first, so a failed completion may leave unreferenced files behind, but never a wrongly published run artifact.

A non-read-only dispatch invalidates the read cache before executing, including operations whose outcome would become unknown. If a write operation or an operation with unknown effects has already returned but result validation or persistence fails, the step becomes `uncertain`, and its outcome needs explicit human confirmation rather than automatic replay. The local crash tests terminate the child processes they own during and after the completion transaction. They do not prove guarantees about host power loss or remote side effects. Transaction merging reduced the number of commits but did not change `synchronous=FULL`, the durability of output deltas, or the storage schema.

**Text deltas are merged into one write.** Multiple text deltas arriving in the same event-loop turn are collected by the kernel into one `recordOutput` call (one transaction). The number, content, and order of events and the bytes on the wire do not change; the storage layer's contract of "commit first, then notify observers synchronously" is untouched; merging happens only within one loop turn, triggered by `setImmediate` or by the next operation that needs consistent state (a non-text event, finishing, a checkpoint), and there is no timer-based delay window. A persistence failure still stops generation with `persistence_failed` and does not report success. Measured: 2000 deltas dropped from about 102 ms to about 9 ms (`bench/kernel-core.ts`, measured as in 3.4). Deferred commits across calls in the storage layer were tried and abandoned, because they would break the contract that `recordOutput` returns only once committed and notified.

An unknown external write outcome blocks resume. An operator with permission must first explicitly record `completed` (with the result) or `not_executed`, and then resume the kernel run separately. This is an **operator's assertion**, kept visibly in the step history, not a new tool measurement.

**Resume and billing** (`lifecycle.ts resume`, `gateway/key-usage.ts`):

- Before resuming, **the key the run belongs to** (`run.checkpoint.keyId`) is re-checked under the rules at submission time, not the key that initiated the resume: when the original key resumes by itself, what is checked is that key itself (expiry and revocation were already rejected at authentication); when the owner's admin key resumes someone else's run in the console, the gateway finds the original key by ID and refuses when it has expired, been revoked, or been deleted (`run_key_inactive`). Then it checks: whether the original key still grants this agent (for a platform account key, that means whether it is still listed, `scope_denied`), whether the platform account is disabled (`account_disabled`), the balance for a paid agent (`insufficient_balance`), and the key quotas (concurrency, tokens, run count; resuming is the same run and does not count as another run). If any check fails, the run stays `interrupted` and nothing is written.
- A key's concurrency count is in memory only. Resumed runs, and `queued` / `requires_action` runs requeued when the gateway starts, are counted into their key's concurrency again, but do not increase "runs used".
- A run may wrap up multiple times (interrupted, then finished after resuming), each time bringing cumulative tokens. The `api_key_run_tokens` table records the tokens of each run already counted into the key, and only the difference is added. When the table was first created, already interrupted runs were back-filled under the pre-upgrade behavior (counted in full at interruption time), so those runs are not counted again after resuming. Historical usage that had already been double-counted before the upgrade is not rewritten; the owner can reset usage on a key if needed.
- Platform ledger: `interrupted` is a terminal state, and at interruption the tokens used so far are settled (no per-call fee is charged); when a run is resumed, that row goes back to `in_progress`, and after completion the difference is settled. An `in_progress` row left by a gateway crash (which did not pass through finishing) is settled by reconciliation at startup; a row already settled is not touched by reconciliation again, even if the run is cleaned up afterwards.

Change log: 2026-11-10 text delta merging; 2026-11-12 resume re-checks eligibility, resume counts into key concurrency, key tokens are added by difference.

### 3.6 Approval parking

A kernel tool approval is a durable suspension point, not a resident loop that holds a global run slot. After all the parallel work already started has finished, the kernel saves the pending call graph and the approval IDs, hands the run slot back, and waits with a deadline timer. An approved run goes to the tail of the existing admission queue. It reuses the completed step results and artifacts in the same immutable run checkpoint, repeating neither the model rounds nor the tools already confirmed.

Independent graph branches can bypass a blocked approval and keep running. A failed parallel step takes priority over parking, and a side effect with an unknown outcome takes priority over an ordinary failure. A partial approval unlocks only the corresponding ready work; denial, cancellation, expiry, and shutdown invalidate pending approvals and do not approve them implicitly. An approval decision racing with the parking process is checked once more after the execution body has exited.

The original run deadline stays unchanged across parking and re-entry; an explicit operator resume after an interruption starts a new execution deadline. A parked request still counts toward the limit of 32 unfinished requests per owner. Under this limit, an existing idempotent replay can still be read, but a new idempotency key cannot get around it. `maxActiveRuns` limits executing execution bodies; a parked kernel run keeps only durable state and one small timer entry. The "requests in progress" total in the console overview includes queued and approval-waiting requests, not only those holding an execution slot.

An external agent's approval still holds its host process and a global run slot, because these opaque backends have no verified pause protocol. Their approval notifications are event-driven rather than polled, but they are not described as suspendable or migratable.

Caller tool bridging reuses the same parking path; see [harness.md](harness.md).

### 3.7 Delegation and sub-agent consistency

**Side-effect levels.** A step that delegates a task to a sub-agent used to be registered always as read-only; after the background service restarted unexpectedly, a read-only step would be re-run automatically, which would make a sub-agent that can modify files do the same thing again. Now it is registered according to the actual sub-agent: an external agent (what it does inside cannot be seen) and an agent that delegates further are "effects unknown", a built-in agent with only read-only tools is read-only, and one with only read-only and safely retryable tools is "a safely retryable modification". A step with "effects unknown" stops after a restart and waits for human confirmation, and is not re-run automatically. The built-in memory tools are in `kernel/memory-tools.ts`.

**Delegation consistency** (`kernel/delegate.ts`):

- The child record (including its depth, grants and inherited project), the parent step's `childRunId` and the `subagent.started` event commit together. A refused write cannot dispatch the child. The parent can already resolve the link at the first public notification.
- On resume, a completed child's result and usage are reused once; an active child is reattached. Unknown effects still require human confirmation. A failed or cancelled child is delegated again only when its effect allows that, or a human reconciled it as not executed.
- Reattachment checks the owner, caller, parent run and delegate step, not just a child ID. An unreadable or contradictory receipt is not treated as a missing run. A confirmed missing child may be retried automatically only for read-only work.
- If SQLite loses the commit acknowledgement, the gateway checks the freshly allocated run ID before publishing. A confirmed commit is published once. If that read also fails, the parent stops with an uncertain step for reconciliation instead of guessing that no child exists.
- When the wait is interrupted by the parent run being cancelled or the gateway closing, the child run is still cancelled as before; if the step level is not read-only it is recorded as `uncertain` (the child run may already have done something), and read-only is recorded as `failed`. When the gateway closes, the parent run therefore becomes `interrupted` / `effect_outcome_unknown`, and resuming is blocked at human confirmation; when the parent run is cancelled it still ends as `cancelled`. When a child run ends as `interrupted` or `effect_outcome_unknown` and the step level is not read-only, the parent run likewise enters the human confirmation flow.
- Delegation manages its own timeout: a timeout reports `delegate_timeout` (504), the child run is cancelled, and the timer is cleaned up at the end.
- Run slots: while the parent run waits for a child run it lends out its own run slot so the child run can enter. It is counted per parent run, lending out only one regardless of how many delegations are in parallel (0→1 lends, 1→0 takes back; when taking back and there is no free slot, it waits until there is one, and on abort or shutdown it takes back directly). Invariant: number of executing runs = number of runs holding run slots + number of parent runs that lent out run slots, and the number holding is within `[0, maxActiveRuns]` (it may briefly exceed only during abort teardown).
- At startup a queued delegate needs an active parent and a matching parent step in the same owner and caller scope. For older checkpoints without a parent step ID, the gateway checks the child ID already stored on that parent's steps. An unlinked queued child is cancelled with `parent_interrupted`, not guessed from an agent name or sent to a worker.
- A child run's artifacts are not merged into the parent run; they are given as references only in the `artifacts` of the delegation result (file ID, name, sha256, and download URL).

Change log: 2026-11-10 side-effect levels of delegation steps; 2026-11-11 delegation consistency; 2026-11-21 atomic child admission and recovery of older queues.

### 3.8 Handoff and fallback agents

For **agent handoff** see [the "Agent handoff" section of protocol.md](protocol.md#agent-handoff-handoff-2026-11-10) and `src/kernel/handoff.ts`. A handoff carries only conversation-level context, not the previous agent's tool call details, system instructions, native session handle, or provider round state.

**Fallback agents** (`oaa.agent_fallback`, `kernel/fallback.ts`): when the primary fails before it has done anything, the same request is requeued with the next candidate. Candidates are chosen by real availability (execution machine, the caller's own model key BYOK, sandbox conditions) and a complete execution-level check, and candidates that do not qualify are skipped. Which errors do not trigger a switch is decided by the `fallbackExempt` flag in the error catalog (see section 9).

Change log: 2026-11-10 handoff and fallback agents added; 2026-11-11 fallback chosen by real availability (T06c).

## 4. Two-layer harness

When the caller is itself an agent (Cursor, Cline, Claude Code, and so on), the request carries its own `tools`: the outer layer is the caller's harness, and the inner layer is the OAA agent's harness. The request selects the mode, and when it selects none the gateway decides once the agent is known: `auto` (the default) behaves as `bridge` for an agent that can take the tools over (kernel agents and ACP external agents; the caller's tools go back to the caller as standard `tool_calls` to be run, and the same run carries on) and otherwise does what the entry did before; `managed` (the caller's tools are not run, and the response header is `X-OAA-Client-Tools: ignored`), `bridge`, and `reject` (reports `client_tools_unsupported`) can be chosen explicitly. For the contract and the support matrix see [harness.md](harness.md).

The entry points in the kernel are `kernel/harness.ts` and `kernel/client-tools.ts`, and on the gateway side `gateway/client-tools.ts` and `gateway/bridge.ts`.

## 5. External agent connections

External agents (native agents such as Codex and Claude Code, ACP agents, `oaa/1` / `oaa/1-stream` adapters, and A2A remote agents) are connected in `engines/`, and the four ways share `engines/shared.ts`. For the connection contract, the differences in streaming / approval / cancellation / resume among the connection types, and the `conversion` profile, see [adapters.md](adapters.md).

Entry constraints: at the entry the kernel uniformly constrains an external agent's progress (field allowlist, string truncation, adding `source: "agent"`) and approval details (denied directly above 256 KiB); an external agent's artifacts are all verified and persisted before the step is marked complete. For details see [adapters.md, "Entry constraints for external agent events"](adapters.md#entry-constraints-for-external-agent-events-2026-11-11).

## 6. Persistence and streams

### 6.1 The text log

The text log was introduced in schema v2 and has been kept in later versions (currently v4); it stores ordered output events, which are committed before observers or SSE clients are notified. The full model / context snapshot is written at execution checkpoints, not for every text delta. Completing the output and the corresponding checkpoint are atomic; the terminal state, summary, and terminal event are also committed together. There is no timer-based persistence gap, and the SQLite synchronization level was not lowered. For protocol compatibility, the final message event still contains the full text.

On read, a baseline is merged with the output events after it; a bounded projection cache of 128 runs avoids replaying on every read. The messages returned are copies, and ownership is checked before projection. Console queries use small per-owner / per-agent summaries instead of loading all the historical context. Synchronous HTTP calls wait on lifecycle events rather than polling SQLite. None of these changes caches or shares a model conversation between owners or sessions.

An interrupted generation keeps the partial text that was already committed, with message status `incomplete`; only confirmed model / tool checkpoints can be resumed. The case of a process being killed abruptly is covered by a local standalone-process test. This does not prove behavior on host power loss or disk availability, and it is not a real cross-machine acceptance.

### 6.2 Checkpoints

For the commit order of tool checkpoints see [3.5](#35-checkpoints-and-persistence); for the validation of run state writes see [3.2](#32-run-state-machine).

### 6.3 Migrations

Migrations from v1 / v2 run as transactions after the single-gateway lease is obtained. They preserve existing text, events, usage, timestamps, publication records, and credential records. Schema v3 added authoritative node policy and its audit, so that older gateways cannot reopen the database while ignoring revocations. Schema v4 added caller data isolation (see [protocol.md](protocol.md#caller-data-isolation-schema-v4-2026-11-08)). A failed migration rolls back its version number and lease. A newer, unrecognized schema is refused. Before upgrading an existing deployment, keep a private SQLite backup first; do not downgrade the database, and do not casually restore old authorization state.

### 6.4 Upstream streams and compatibility streams

`providers/http-stream.ts` is the bounded response reader shared by the Anthropic / Gemini model drivers, A2A, and the HTTP adapter. Since 2026-11-10 it parses SSE with its own incremental parser (`SseParser` in the same file, written to the WHATWG rules; the `eventsource-parser` it used to reference was removed), with streaming UTF-8 decoding, CR/LF normalization, a bounded event buffer, and a limit on total wire bytes. An unfinished SSE frame at EOF is discarded rather than treated as evidence of termination, per the [WHATWG event-stream rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation). Abort, early return by the consumer, and parse failure all cancel the response body and release the reader; this layer never reconnects and never retries an agent call that may have side effects.

Anthropic completion requires that content blocks be closed and `message_stop` be received, not merely that a `stop_reason` was seen before. Unsupported pause / refusal / unknown reasons are explicit `upstream_incomplete` failures; token / context limits are still truncated results, carrying no dispatchable tool calls. This relies on the documented [message lifecycle](https://platform.claude.com/docs/en/build-with-claude/streaming) and [stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), not on a claim of real provider acceptance. Gemini requires an explicit `finishReason`: only `STOP` is normal completion, `MAX_TOKENS` is truncation; a blocked prompt and every other reason do not count as success and do not trigger a cascading retry. The provider's thinking text is not put in the public answer. See the [GenerateContent contract](https://ai.google.dev/api/generate-content?hl=en#FinishReason).

A2A waits for the local event sink to finish before consuming the next event or returning success, so a persistence failure is not swallowed. Non-streaming response bodies and agent card checks are bounded during reading, not checked after unbounded buffering.

**Model drivers do not depend on vendor SDKs.** The OpenAI Responses / Chat Completions driver (`OpenAIModel`) sends requests directly with `fetch` and parses streams with this project's SSE reader, consistent with the Anthropic and Gemini drivers: no automatic retries, no following redirects, the request body contains only the fields written explicitly in code, and upstream error bodies are not passed through to the caller. The connect timeout covers only up to receiving the response headers (consistent with the earlier SDK behavior), so a long answer that has already started is not cut off by the timeout. When replaying the previous round's Responses items it strips output-only fields itself, and still reports `invalid_provider_state` for item types it does not recognize. The `openai` package is used only in tests to verify the compatibility endpoints and is in `devDependencies`; `eventsource-parser` is no longer referenced by this project's code and has been removed from the direct dependencies (it still exists as an indirect dependency of the MCP SDK).

The encoding of compatibility streams is in `gateway/compat-stream.ts`, where every byte is part of the compatibility contract; for byte-for-byte tests see sections 8 and 10 and [engineering.md, section 7](engineering.md#7-compatibility-red-lines).

Change log: 2026-11-10 own SSE parser, OpenAI driver switched to `fetch`; `server.ts` shrank from about 2,500 lines to about 1,700 (now about 1,540) (wire stream encoding moved to `compat-stream.ts`, the static OpenAPI description to `openapi.ts`, and the three groups of routes for local agent management, memory, audit, and keys to `local-backend-routes.ts`, `memory-routes.ts`, and `key-routes.ts`); these are all moves that do not change behavior, and the full test results are unchanged.

## 7. Distribution network

### 7.1 Nodes and placement

`fabric/` is responsible for placing tasks by capability and data location, WSS leased tasks, local tools on execution machines, provider SDKs, and native processes. Execution machines connect outward on their own initiative; the scheduler does not broadcast task content to every node. For the node wire protocol see [protocol.md, "Node wire protocol"](protocol.md#node-wire-protocol).

### 7.2 Selected tool import and MCP connections

`fabric/tool-import.ts` resolves only the explicitly selected execution machine / MCP server and tools. The discovery phase sends initialization and `tools/list` and never sends `tools/call`; a server the owner configured may still have its own startup behavior. The preparation phase separates public capability bindings from private execution machine override configuration. Node credentials still need the corresponding capability authorization. A reviewed capability bundle can be published without re-reading the mutable source directory.

`fabric/mcp-connections.ts` leases connections by owner, session, and capability bundle digest. On a credential / configuration change, the old entry is retired for new callers and active leases are drained one by one. An ordinary MCP domain error does not invalidate the transport for other callers; failures with side effects are still handled conservatively. Idle connections are capped and temporary. It currently targets the MCP SDK v1 / 2025-11-25 handshake configuration used by the repository, and does not claim that servers supporting only the new 2026 protocol have been verified.

Imported schemas explicitly choose JSON Schema 2020-12 when the MCP description omits the dialect. Existing non-MCP definitions without `$schema` keep draft-07 behavior. 2019-09 and explicit draft-07 schemas are also supported. The validator is bounded and scoped by schema content, so a reused `$id` does not confuse old and new contracts; external references are not downloaded, and asynchronous schemas are rejected. A metadata scan rejects recognizable credential patterns and literal credential fields, but this cannot prove that arbitrary content contains no secrets.

The local `super-backend-codecraft` skill sample was checked without calling a real model: five selected files, one scoped MCP source reader, and one artifact whose source hash matches the selected files. The personal archive it references was neither resolved nor copied. The sample stayed on a dedicated local-only node and did not change the main gateway or global skills. This is wiring evidence, not proof of the skill's semantic quality or of third-party account integration.

### 7.3 Read cache consistency

Read cache entries are scoped by session / capability bundle / tool / input and include the artifact content hash. Generation fences at the start and end of write operations prevent an earlier read that is still in progress from backfilling a cache that has already been invalidated. A read overlapping a write is not cached; cache hits are disabled while a write is in progress. Artifact publication likewise invalidates pending entries. The in-process LRU is limited both to 1,000 entries and to 16 MiB of serialized key-value bytes; a value that is too large or not cacheable does not turn a committed tool result into a failure. Uncacheable calls skip key hashing. This is conservative cache invalidation, not transactional isolation over external systems, and it does not prove that an unknown remote write has stopped.

### 7.4 Catalog and discovery

`gateway/catalog.ts` and `gateway/streams.ts` provide scope-partitioned catalog invalidation views, bounded reconnect history, a shared SSE lifecycle, and live credential revocation. `gateway/discovery.ts` provides a publication revision guard, byte-limited summary / detail paging, and an explicit public metadata projection; prompts, files, and private handlers are not in that projection. For the contract see [protocol.md](protocol.md#catalog-notifications).

## 8. Observability

The goal is to make "where the time of a run goes" and "why it is still waiting" explainable, without changing any existing persistence or wire semantics.

- **Derived only from persisted state.** The timeline (`src/gateway/timeline.ts`) reads three kinds of data: lifecycle events (`response.created/in_progress/terminal`, `run.queued/parked/requires_action`, `approval.resolved`, `tool.*`, `subagent.*`), execution steps, and the model round markers in checkpoints. Output deltas are not read; the large payloads of `response.*` events are replaced by empty objects in SQL. The activity pulse (`src/gateway/activity.ts`) reads run summaries and aggregates the timelines of recently finished runs.
- **Model round markers go in the checkpoint, not in the event log.** The existing log has no "model round start/end" events. Adding events would shift the following event IDs: UAP NDJSON frames carry `seq: <event ID>`, and so do the `id:` line and `sequence_number`, and the wire byte count would change when an ID crosses a digit boundary. So the marker `{turn, attempt, route, start, dispatched, end, status, calls}` is written into the checkpoints that are committed before and after a model call anyway: no added transaction, no added fsync, and no added event. The start time of a native execution is written into the native step record that is written anyway (`startedAt`). The tests check the compatibility streams byte for byte (10,238 / 55,219 bytes) and confirm that the event log has no new event types.
- **Dependencies and the critical path**: the main line (queueing, model, native, approval) is chained by time; a tool depends on the model round that initiated it, its approval, and the `$ref`/`depends_on` of the execution graph; the next model round depends on the whole batch of tools completed in the meantime. The critical path (the chain that determines total time) is traced back from the span that ends last along the dependency that ends last; the time breakdown is attributed along the critical path, gaps count as `other`, so the parts always sum to the total duration, and parallel tools are not timed twice.
- **Caching and cost**: the timeline ETag is bound to the last event ID; activity results are cached by overview revision, and the timelines of finished runs are cached per run (at most 1,024). Activity statistics scan in chunks in reverse order over the `(owner, ordinal)` index of run summaries and stop at the start of the window, at a cost of O(runs in the window).
- **Queue transparency**: the kernel admission queue and the node queue each give a reason and an estimate; quantity fields count only the same owner's runs, to avoid leaking other tenants' load.
- **What was not done**: the SQLite schema was not changed, no index was added (measured as unnecessary), and the worker wire protocol was not changed.

For the interface see [protocol.md, "Observable kernel"](protocol.md#observable-kernel-run-timeline-activity-pulse-queueing-and-capability-negotiation), and for console usage see [console.md](console.md).

Change log: added 2026-11-08.

## 9. Three catalogs: errors, events, limits

- **The error catalog** (`src/core/errors.ts`): all the stable error codes that the gateway, execution nodes, and clients can produce, with category, HTTP status, whether retryable, a description, and a suggested next step, served through `GET /v1/errors` (`features` in `/health` contains `error-catalog-v1`). Three scheduling flags are also registered in the catalog: `routeRetryable` (when the first model call fails, another route may be tried), `fallbackExempt` (does not trigger switching to a fallback agent), and `uncertainWhenStarted` (when this error occurs after external execution has already started, the outcome is treated as unknown); `GET /v1/errors` includes these flags.
- **The event catalog** (`src/core/events.ts`): all run event types `RUN_EVENT_TYPES`, and three subsets: terminal events, output events, and timeline events.
- **The limit catalog** (`src/core/limits.ts`): centrally named limit constants. The limits at the external agent entry are kept separately in `AGENT_LIMITS`.

For how to add an error code or event see [engineering.md, section 4](engineering.md#4-how-to-add-an-error-code--event); for the error code table see [protocol.md, "Error codes"](protocol.md#error-codes-errorcode).

Change log: 0.2.0 added the three catalogs; 2026-11-11 the three scheduling flags were merged into the error catalog (T06c).

## 10. Evidence and performance

What each test and benchmark does and does not prove:

- `npm test` covers the kernel, real local files, real local HTTP / WebSocket / MCP transports, official OpenAI SDK compatibility, and controlled native subprocess fixtures. It calls no paid model. `npm run bench` compares serial and concurrent scheduling with deterministic latency in the same runtime. It deliberately labels its measurements as scheduler microbenchmarks, not as a speedup relative to OpenAI or AgentScope.
- `node dist/bench/kernel-graph.js NEW_REPORT.json` checks a fixed heterogeneous DAG, exact result hashes, tool call counts, and peak concurrency, reporting cold-start and warm-start times separately. It refuses to overwrite an existing report. This is a deterministic scheduler microbenchmark with no model calls, SQLite, or remote execution machines, not an end-to-end provider performance result.
- `bench/kernel-core.ts`: an in-process simulated model and tools; for the numbers and measurement conditions see 3.4 and 3.5.
- `bench/agent-stream.ts` measures a fixed chunked A2A response against an in-process, credential-free fixture and refuses to overwrite a report; it is a parser / adapter benchmark, not real model or network latency.
- `npm run bench:stream -- --label NAME --out NEW_REPORT.json [--compare BASELINE.json]` measures a fixed local streaming workload. SQLite TEMP triggers count the actual number of snapshot writes and serialized snapshot bytes; the runner checks the full output and cursor replay, records source / workload hashes, and refuses to overwrite a report. It measures the instrumented local kernel / storage path (including lifecycle wait overhead), not provider latency. Keep the report from before a change, and use another path after the change.
- `bench/paired/` adds an independent AgentScope 2.0.11 SDK configuration, which is neither an imitation nor a renamed OAA driver. The two adapters use the same scripted I/O controller and reject results with inconsistent trajectories. It tests a generic reasoning / tool loop; it does not involve graph fusion, real model inference, or equivalent product-grade persistence. The report preserves the two systems' differing persistence and system prompt semantics, the startup / first event / text / final times, dependencies, source snapshots, and failed attempts. No positive comparison is inferred from framework names or from earlier single-runtime benchmarks. See [bench/paired/README.md](../bench/paired/README.md).
- Byte-for-byte compatibility stream tests: `test/observability.test.ts` checks UAP NDJSON at 10,238 bytes and OpenAI Chat SSE at 55,219 bytes, using the same workload as `bench/protocol-speed.ts`.

The real target remains: with no degradation in quality or cost, at least a 30% improvement in the end-to-end median for parallel-source workloads, and no more than a 10% regression on simple tasks. That needs authorized paired provider workloads, identical models / tools, separately reported cold / warm measurements, and real remote machines. The numbers from local fixtures do not claim to have reached such a result.

## 11. Known limitations

A single gateway; execution machines need explicit trust; no operating-system sandbox for imported native runtimes or owner-registered scripts. WSS validates the peer certificate, but the gateway / execution machine credentials are bearer tokens rather than mutual TLS. There is no migration of the state of a native agent that is executing, no ownership of inference KV caches, and no speculative duplicate external writes. Context is a bounded envelope, not an unverified semantic summarizer. Native account access, the accuracy of model enumeration, provider pricing, and the consistency of installed desktop connectors all need separate verification.

> Note: the sentence "no operating-system sandbox" is kept as originally written. An optional sandbox execution level was added afterwards (see [sandbox-design.md](sandbox-design.md) and [protocol.md, "Execution levels"](protocol.md#execution-levels-p1-2026-11-08)); its scope and limits are as stated in those two documents.

## 12. References and sources

### Applied research (not claimed as new inventions)

- [Nalar v2, September 2026](https://arxiv.org/html/2601.05109v2): workflow-aware runtime metadata, and separated global / local decisions. Its KV cache management needs control of the inference infrastructure and is not implemented for remote provider APIs.
- [AgentWeave, October 2026](https://arxiv.org/html/2610.14804v1): avoiding head-of-line blocking at safe execution boundaries. The paper requires declaring stream semantics; this project likewise does not assume that an arbitrary application can be split automatically.
- [LLMCompiler](https://arxiv.org/abs/2312.04511): dependency-aware tool parallelism. The graph here is validated against published tools and side-effect / resource constraints, rather than trusting freely generated code.
- [AgentScope 2.0](https://github.com/agentscope-ai/agentscope): a useful feature and service baseline. The earlier AgentScope Runtime repository is being merged into 2.0. Its real-model benchmarks were not run here.
- [OpenAI latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization): reduce unnecessary requests, run independent work in parallel, stable prefixes. Quick acknowledgment is measured separately from actual task completion.

### Influence of Sub2API

[Sub2API](https://github.com/Wei-Shaw/sub2api) and its [composite model route contract](https://github.com/Wei-Shaw/sub2api/blob/main/docs/COMPOSITE_GROUPS.md) were read, with the source inspection based on commit `d851a38477597157e78450d30af2d8504764d085`.

The design ideas adopted are explicit model aliases, scope-aware dispatch keys, sticky sessions, load / health information, and bounded cooldowns. The unit here is an agent plus capabilities and execution location, not just an account. No Sub2API source code was copied; subscription credential extraction, hidden account endpoints, payment systems, and account-sharing pools were not implemented.

### Attribution

The Apache-2.0 attribution in the file header of `src/config/agent-presets.ts` and in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) is preserved.

## Appendix: unimplemented proposals

### W3C Trace Context

It is proposed in three steps, advanced only when the risk of each step is controllable:

1. The call entry points (`/v1/responses`, `/v1/chat/completions`, `/v1/messages`, `/v1/uap`, `/v1/invoke`, the Gemini endpoints) accept and validate `traceparent` (`00-<32 hex>-<16 hex>-<2 hex>`, invalid values ignored) and `tracestate` (length limit 512), recorded in a separate field of the run rather than `metadata`, to avoid changing the idempotency fingerprint and the response object; echo `trace: {trace_id, parent_id}` in the timeline and in `state`.
2. Sub-agent runs inherit the `trace_id` and generate a new parent id; the sub-agent span in the timeline carries the child run's trace.
3. Passing it through to workers needs a new optional field in `WorkContext`. The protocol parsing of remote workers must first be confirmed to tolerate unknown fields, and it must be negotiated through `welcome.features` (for example `trace-context-v1`), otherwise older workers may reject the task. This step changes the node wire protocol and should be reviewed separately.

Why it is not implemented: steps 1 and 2 need the new parameter to be threaded through all call entry points and `kernel.submit`; step 3 would change the node wire protocol. For now the priority is the correctness of the observability interfaces, without changing any wire bytes.

Change log: proposed 2026-11-08.
