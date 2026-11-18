# Evidence: which agents were really turned into an Agent API

English · [简体中文](zh-CN/evidence.md)

> 2026-11-11: an integration session on a macOS machine against real agents installed on it (on 2026-11-13 there was also an end-to-end verification of Antigravity, described at the end of this page). Every row is a result that was actually executed and observed; what was not done is marked "not tested", and failures are recorded honestly with their cause. The coverage of test stand-ins (protocol-level fake agents) is in the [conversion contract of adapters.md](adapters.md#agentapi-conversion-contract-2026-11-08) and is not counted on this page.

## Conclusions (boundaries first)

- **This does not prove that "every agent" can be converted.** What it does show is that an agent can be published as an Agent API as long as it offers one of four ways in (built-in native, ACP, an `oaa/1` adapter, A2A). Of the 7 real agents installed on this machine, 3 completed real calls, and the other 4 were blocked by their own account or configuration state (not signed in, twice; an expired key; their own configuration lock), and the gateway returned a clear error instead of a vague failure.
- **"Other agents can use this API" was demonstrated once with a real agent**: Antigravity (Gemini 3.8 Flash), as the caller, called `agent/codex`, which Codex provided, through OAA's MCP entry and got the correct result. Two layers of harness, two different agents, two different models.
- **Since 0.0.64 the automated checks have grown a lot, and the real-agent record has expanded.** CI now runs the whole suite on Linux, macOS and Windows and on Node 24 and 26, builds and smoke-tests the Docker image, and runs a compatibility lab with the official SDKs and replays of popular chat clients (see [Automated checks in CI](#automated-checks-in-ci-2026-11-14)). All of that uses stand-in agents and fixture models. On 2026-11-18, Codex (streaming, cancel, orchestration, usage) and Claude Code (auth error surface) were tested end-to-end for the first time since 2026-11-11, and the compatibility lab grew from 374 to 456 scenarios with zero failures (see [End-to-end verification after 10-module upgrade](#end-to-end-verification-after-10-module-upgrade-2026-11-18)). Codex S8 caller-tool bridging remains unverified against a real agent due to account quota exhaustion (see [What no check covers yet](#what-no-check-covers-yet)).

## As the callee (agent → Agent API)

| Agent | Way in | Handshake | Real call in managed mode | Real call with bridge | Notes |
| --- | --- | --- | --- | --- | --- |
| Antigravity `agy acp` 1.5.5 | ACP | Passed | Passed (Gemini 3.8 Flash, correct reply, usage reported) | **Passed** (a single call; two parallel calls; streamed continuation) | Parallel calls were split into two rounds handed to the caller; use the model name `gemini-3.8-flash` without `-low` |
| Qoder CLI 1.1.52 | ACP | Passed | Passed (correct reply) | **Passed** (a single call) | Before calling a tool it sent a permission request, which the script approved on the owner's behalf this time; the usage it reports is all 0 |
| Codex CLI 0.167.0 | Built-in native (app-server) | n/a | Passed (default model `gpt-6-astra`, correct reply) | Not supported (not implemented) | Does not report usage |
| OpenCode 1.18.29 | ACP | Passed | **Failed: its own API key had expired** | Not tested | The gateway reported `native_protocol_error` carrying the agent's own words, with the key fragment redacted |
| Grok Build | ACP | Passed | **Failed: not signed in yet** | Not tested | The gateway reported `adapter_auth_required`, telling the user to sign in through its own CLI |
| Claude Code | Built-in native (Agent SDK) | n/a | **Failed: the command-line version was not signed in** | Not supported (not implemented) | The gateway reported only `native_incomplete` and did not surface the "not signed in" cause: this was a defect found in this session, see below |
| DeepSeek Harness | ACP | **Failed: its own configuration write lock timed out** | Not tested | Not tested | The process exited during the handshake; unrelated to OAA |

## As the caller (other agents using this API)

| Caller | Entry | Agent called | Result |
| --- | --- | --- | --- |
| Antigravity (Gemini 3.8 Flash), driven over ACP, with the MCP server passed at session level only | OAA's MCP bridge (`oaa mcp`), with the gateway temporarily listening on `127.0.0.1:8799` | `agent/codex` (Codex, `gpt-6-astra`) | **Passed.** It called `oaa_list_agents`, `oaa_invoke`, `oaa_wait_run` and `oaa_read_output` in turn, and finally answered that it had called `agent/codex` and that the reply text was `CODEX-OK-7391` (as requested). The gateway has a matching `completed` request record, taking about 12.5 seconds |

On the OpenAI / Claude / Gemini compatibility side, the real calls of caller-tool bridging are in the "Real call with bridge" column of the table above (there the caller was a test script that sent and received with the OpenAI Chat Completions protocol).

## Found in this session and needing a change

1. **The reason for a Claude Code failure was opaque**: the SDK's result said `Not logged in · Please run /login`, but the gateway reported only "Claude did not complete successfully". It should surface the (redacted, length-limited) reason and classify not being signed in as an authentication-required error. (Fixed)
2. **During bridging, the agent sent permission requests for the caller's tools** (Qoder): those tools are provided and executed by the caller itself, so having the owner approve them again is meaningless and makes an unattended bridge hang. Tools coming from the `oaa-caller` relay should be allowed automatically. (Fixed)
3. **All-zero usage** (Qoder): when an agent reports usage that is all 0, it should be treated as "unknown", not as having really used 0 tokens. (Fixed)
4. **Parallel calls were split into two rounds** (agy): see the [limitations section of harness.md](harness.md#limitations-and-unverified-items).
5. **Thinking effort cannot be specified in ACP** (agy declares it as a separate option).

## Not verified

- A caller returning results more slowly than the agent's own MCP timeout.
- Any real call across machines (remote execution machines).
- What could only be tested after signing in or renewing: OpenCode, Grok Build, Claude Code.
- Real clients such as Cursor and Cline that call OAA as a model (the caller proof on this page went through the MCP entry).

## Re-verification after the fixes (same day)

- Qoder bridging: no owner approval appears any more, the progress has a `permission_auto_allowed` entry, the run goes straight to `tool_calls` and completes after continuing; usage is unknown (no fabricated 0 in the response any more).
- Claude Code: the gateway now reports `adapter_auth_required`, with the agent's own words "Not logged in · Please run /login" in the message.

## End-to-end verification script `examples/live-agents-acceptance.ts` (2026-11-13)

It starts, in process, an isolated gateway that listens only on a random `127.0.0.1` port (the data directory and the agent working directory are both under `--out`, with the developer platform on), and runs 12 scenarios over real HTTP: S1 Chat non-streaming, S2 Chat streaming, S3 Responses and continuation, S4 Claude Messages, S5 Gemini, S6 approval (approve and deny), S7 cancellation (checking that the child process exits, by PID), S8 caller-tool bridging, S9 concurrency, S10 billing, S11 error surface, S12 wrap-up (leftover child processes, secret-value scan). Each scenario calls the agent only once with no automatic retry and has a hard timeout; a capability the engine does not support is recorded as "engine not supported" according to the documented error code, and does not count as a failure.

The scenarios speak the four wire formats (OpenAI Chat Completions and Responses, Claude Messages, Gemini `generateContent`) with Node's built-in `fetch`, not with the official SDKs. Compatibility with the official SDKs is the job of the compatibility lab and of `test/compat-*-sdk.test.ts` (see below), which use a stand-in agent. The scenario code has been shared with `oaa verify` since 2026-11-14 ([cli.md](cli.md#verify-an-agent-yourself)); `oaa verify` runs the subset that makes sense on someone else's machine. The first version of the script produced the record of 2026-11-13 below, and it used the official `openai` and `@anthropic-ai/sdk` clients (with `maxRetries: 0`) for the Chat and Messages scenarios. The scenarios as they are now have been run offline against the fake ACP agent, and have not been repeated against a real agent.

```bash
npm run build
# Offline self-check (the fake ACP agent in the repository, test/fixtures/acp-live-agent.mjs, no cost)
node dist/examples/live-agents-acceptance.js --agent fixture --out /NEW-DIRECTORY
# Real agent (this incurs cost and must be confirmed explicitly; --out must be a directory that does not exist yet)
node dist/examples/live-agents-acceptance.js --agent claude|codex|antigravity --executable /path/to/cli --confirm-live-cost --out /NEW-DIRECTORY [--model default] [--only S1,S5] [--native-env inherit|allowlist] [--scenario-timeout-sec 300] [--agy-mode plan]
```

The evidence is written to `--out/report.json` and `--out/report.md` (a scenario table, "where it differs from the documentation", and the names, only the names, of the environment variables passed to the child process). The report contains no secrets, an agent's output is kept to its first 300 characters, and the exit code is set by whether any scenario failed. The result of one real run against Antigravity is in the next section; Codex and Claude Code have not been run with this script yet. Anyone with one of them installed can run `oaa verify` and attach the report to an issue (the [agent verification report](../.github/ISSUE_TEMPLATE/agent_verification.md) template).

## End-to-end verification of Antigravity (2026-11-13)

With the script above, one run against the real Antigravity (`agy`, model `gemini-3.8-flash-low`): an isolated gateway, a random `127.0.0.1` port, a temporary working directory, each scenario called once with no automatic retry, 12 real calls in total.

| Scenario | Result | Observation |
| --- | --- | --- |
| S1 OpenAI Chat non-streaming (official SDK, `sk-oaa-` key) | Passed | 12.5 seconds; correct answer; `usage` has values |
| S2 OpenAI Chat streaming | Passed | The first delta arrived only after 7.4 seconds, 2 deltas in total: this engine delivers at the end, not progressively |
| S3 Responses and `previous_response_id` continuation | Passed | The second turn gave the code word from the first turn, continuing the same session |
| S4 Claude Messages non-streaming and streaming (official SDK) | Passed | |
| S5 Gemini `generateContent` | Passed | |
| S6 Approval | Engine not supported | No pending approval; the task failed with `permission_denied`, the file was not written, consistent with the documentation |
| S7 Cancellation | Passed | The child process exited after cancellation; status `interrupted`, `effect_outcome_unknown` |
| S8 Caller-tool bridging | Engine not supported | `client_tools_bridge_unsupported`, no task was created |
| S9 Concurrency of 3 tasks | Passed | 12.6 seconds, no crosstalk |
| S10 Billing | Could not be verified | An account key cannot call an external agent (`isolation_required`) and no credits are deducted, so the success path was never reached |
| S11 Error surface | Passed | |
| S12 Wrap-up check | One item failed | No secrets leaked in the records and logs; but 1 leftover process remained, see below |

Also observed:

- The leftover was `agy --bg-updater` (Antigravity's own background updater, with parent process 1). It is spawned by `agy` and detaches from the process group, so the gateway, which ends a task by process group, cannot reach it. So "no leftover processes after a task ends" cannot be guaranteed for external agents.
- Each Antigravity call takes about 13,000 input tokens (its own built-in system prompt), regardless of the length of the task.
- The developer platform's account keys are workspace-level and external agents need host-level, so they are rejected; this is intentional isolation, so for now only built-in agents can be listed and billed on the platform.

**Not verified**: approval and caller-tool bridging (this engine does not support them); the success path of billing (blocked by isolation); real runs of Codex and Claude Code; built-in kernel agents with a real model provider; public network and reverse-proxy environments.

## End-to-end verification after 10-module upgrade (2026-11-18)

After an extensive parallel development of 10 upgrade modules (native bridge enhancements, protocol compatibility, orchestration, security/observability, workstation, local ecosystem, console workbench, desktop unification), an independent verifier ran two rounds of end-to-end acceptance against real agents installed on a macOS machine. The gateway was at commit `a61238a` on the `main` branch (version 0.0.69).

### Real agents tested

| Agent | Scenarios | Result | Observations |
| --- | --- | --- | --- |
| Antigravity 1.5.10 (`agy acp`, `gemini-3.8-flash`) | S1 non-streaming, S7 cancel, S12 wrap-up; ACP bridge with forced named `tool_choice` + `oaa-caller` bridging + `response_format` JSON Schema + W3C `traceparent` | **All passed** | S1: 7.9 s, usage `13328`; S7: 4.3 s, clean exit; S12: 0 leftover processes, 0 secret leaks; bridge: `traceparent` persisted and echoed back |
| Codex CLI 0.167.0 | S2 streaming, S7 cancel, `toolsDisabled=true` orchestration (`recommend`, `agent/codex-orch@fast`), `GET /metrics` Prometheus | **All passed** | S2: 16.2 s, real usage reported (`56801` tokens via `thread/tokenUsage/updated`); S7: protocol-level `turn/interrupt` graceful cancel (4.7 s, clean child exit); orchestration: tool-free reasoning with `recommend` mode; `/metrics`: 200 |
| Codex CLI 0.167.0 | S8 caller-tool bridging (re-test after elicitation fix) | **Blocked by account quota** | Received `native_incomplete` (422): "You've hit your usage limit… try again at Nov 21st". **Not a code bug**: the gateway correctly propagated the external error. The elicitation recognition logic (`mcpServer/elicitation/request` + `_meta.codex_approval_kind === 'mcp_tool_call'`) passed all unit and integration tests |
| Claude Code 2.1.318 | Unauthenticated bridge request | **Passed (expected failure path)** | Correctly returned `422 adapter_auth_required` with the CLI's own message: "Not logged in · Please run /login" (redacted). S12: 0 leftover, 0 leaks |

### Code fixes verified in this session

1. **Codex MCP elicitation auto-allow** (`native-bridge.ts`): Codex 0.167+ sends `mcpServer/elicitation/request` with `_meta.codex_approval_kind = "mcp_tool_call"` for caller-tool approval. `codexCallerTool()` now recognises this pattern and auto-allows when `serverName` and `tool_name` match declared `clientTools`. `codexDecisionPayload()` returns `{ action, content, _meta: null }` with correct form/url mode handling. Unit tests cover real Codex payload structure, wrong server, undeclared tool, and all three response modes.
2. **Claude error capture** (`native.ts`): `assistant` messages with `error: true` are now captured and used for `agentFailure` fallback, surfacing "Not logged in" instead of a silent failure.
3. **`verify-env.ts` expectations aligned**: Claude `streaming: 'token'`, `bridge: true`; Codex `usage: true`, `bridge: true`.
4. **`node-enroll.js` heredoc injection hardened**: replaced unquoted `<<EOF` with `shellSingleQuote()` + `node -e` writer. Shell-injection tests confirm `$(command)`, backticks, and `$VAR` in hostile payloads are inert.

### Compatibility lab (2026-11-18)

The compatibility lab (`npm run compat`) was run twice independently with identical results:

- **456 scenarios passed, 0 failed, 4 not applicable, 0 skipped**
- Covers all 14 clients: `openai` Python + Node, `anthropic` Python + Node, `google-genai` Python + Node, `vercel-ai-sdk`, `langchain`, `litellm`, `openai-agents`, `llamaindex`, `cookbook-python`, `cookbook-node`, `cookbook-curl`
- Up from 374 scenarios (2026-11-14) to 456 — the increase reflects new protocol features (native schema pushdown, `tool_choice` enforcement, `traceparent`, conversion profiles) and additional SDK versions

### Security audit (2026-11-18)

- Host configuration zero pollution: `.codex/config.toml`, `.config/opencode`, `.cursor/mcp.json`, `.claude.json`, Claude Desktop — 0 OAA markers in any
- `node-enroll.js`: shell injection verified impossible with actual `sh -c` execution of hostile payloads
- `innerHTML`: only 1 occurrence, safe i18n key-value call (`static-text.js:12`); `#workbench` chat workspace has no XSS risk
- SSE on-wire byte assertions unchanged even with `traceparent`/`tracestate` headers added

### Not verified in this session

- S8 caller-tool bridging with real Codex end-to-end (blocked by Codex account quota exhaustion until 2026-11-21, not a code issue)
- Real agents on Windows and Linux

### Remaining acceptance & verification completion (2026-11-18, 0.0.70)

Following the 0.0.70 release build, additional live-agent, real-GUI desktop E2E, release DMG, sandbox, and bounded soak checks were completed on Apple silicon macOS:

- **Qoder CLI 1.1.52 (`adapter/qoder`) full `oaa verify` run (11 scenarios, 14 real invocations, 0 failures)**: Passed S1 non-streaming (`8.7 s`), S2 streaming (`8.6 s`), S3 Responses + `previous_response_id` continuation (`15.4 s`), S4 Claude Messages sync + stream (`17.2 s`), S5 Gemini `generateContent` (`8.0 s`), S6 owner approve/deny file writes (`30.8 s`), S7 cancel (`4.6 s`), S8 caller-tool bridging (`10.3 s`), S9 3-way concurrency (`7.9 s`), S11 error paths, and S12 cleanup (all 17 spawned child processes exited, 0 secret leaks). Observation: Qoder CLI currently reports `null`/zero token counts over ACP, so the gateway leaves usage unknown rather than fabricating numbers.
- **Live external-agent Developer Platform `host_execution` billing (S10 complete path)**: Exercised against real `qoder-cli 1.1.52`. With `host_execution` off by default, a developer key received `403 isolation_required` with balance unchanged (`10`); after the owner enabled `host_execution: true` (emitting a `platform_listing_host_execution` audit entry), `POST /v1/chat/completions` succeeded (`LIVE-S10-OK`), debiting balance cleanly (`10 -> 8`) with a settled `-2` row in `/v1/portal/ledger`.
- **Antigravity (`agy` 1.5.10) re-verification across all 0.0.70 scenarios**: Passed S1 (`6.6 s`, usage `13325`), S2 incremental streaming (`8.7 s`, usage `13334`), S3 continuation (`same_session: true`), S4 Messages sync + stream, S5 Gemini (`usage: 13332`), S7 cancel (`4.2 s`), **S8 native caller-tool bridging** (`get_order_status`, `12.1 s`), S9 3-way concurrency (`7.9 s`), S11 errors, and S12 cleanup (15 child processes exited cleanly, 0 leaked processes or secrets); S6 permission approval remained `unsupported` (`approvals_not_bridged`) by design. Aligned `src/client/verify-env.ts` (`bridge: true`) and [adapters.md](adapters.md).
- **Other local ACP probes (single call each, no retries)**: `opencode-acp` (`OpenCode 1.18.29`) passed ACP handshake and faithfully relayed expired API key as HTTP `422 native_protocol_error` (redacted); `grok-build-acp` (`grok 1.0.77`) passed handshake and returned HTTP `422 adapter_auth_required` when unauthenticated; `deepseek-harness` (`dsh`) hit a pre-existing local `~/.dsh/profiles/node_modules.lock` writer lock timeout before gateway work.
- **Release macOS `.dmg` smoke & full Electron desktop Playwright E2E (`desktop:smoke:matrix`)**: Mounted the `--release` `Open-Agent-API-0.0.70-macOS-arm64.dmg`, confirmed `codesign --verify --deep --strict` and exclusion of `@anthropic-ai/claude-agent-sdk` and `typescript`, and passed `scripts/smoke-release.mjs` + `scripts/smoke-flow.mjs` end-to-end (`--help`, `init` in spaced Chinese dir, `doctor` reporting Claude SDK as `requires_separate_install`, `/healthz`, import of all 353 modules in `dist/src`, `quickstart`, OpenAI/Claude/Gemini answers from `agent/sample`, console & icon assets, API + `oaa approvals`/`oaa approve` file creation, `oaa status`, idempotent second `quickstart`, and clean `oaa stop`). In addition, `npm run desktop:smoke:matrix` passed both from source (9 real-GUI scenarios) and against the packaged `/Applications/Open Agent API.app` (8 packaged scenarios): second-start skipping `.seeded` onboarding banner while retaining data; orphan gateway attachment preserving the independent process on close; live `#workbench` inline owner approval + Tray Quick Approval panel (source build) + macOS Dock badge lifecycle; bidirectional `zh`/`en` console switching keeping `sessionStorage` auth across reload; Disconnect + reload recovery; and `portHeldByOther`, `portHeldByGateway`, and `invalidConfigPort` error probes. Caught and fixed three Chromium `/v` `<input pattern>` unescaped-hyphen `SyntaxError`s (guarded in `test/console-assets.test.ts`) and backslash matching in `test/desktop-unified.test.ts`.
- **Sandbox & bounded soak check**: `test/sandbox-srt.test.ts` passed 5/5 on macOS; a 2-minute 4-concurrency soak (`npm run soak -- --minutes 2 --concurrency 4 --retention-minutes 1`) passed all criteria (`ok=2357`, `unexpected=0` (0.000%), `p50/p95/p99 = 104/159/219 ms`, SIGTERM × 2 + SIGKILL × 1 recovery, live `oaa prune`, `integrity_check ok`).

## Automated checks in CI (2026-11-14)

These ran on GitHub Actions on a development branch of the public repository, with the code that became 0.0.65. None of them involves a real agent, a real model provider or an account: they use deterministic fixtures and stand-in agents.

| Check | What ran | Result | What it shows, and what it does not |
| --- | --- | --- | --- |
| The whole offline suite on Linux and macOS, Node 24 and 26 | `ci.yml`: `npm run verify` (type check, format check, every test) on `ubuntu-latest` and `macos-latest`, each on Node 24 and Node 26 | Passed on all four | The code behaves on both Node lines of `engines` on those two systems |
| The whole suite on Windows | `windows.yml`: `node scripts/test-offline.mjs --all --isolate` on `windows-latest`, Node 24: one process per test file; tests that only make sense on POSIX are skipped with a stated reason | Passed (about 10 minutes) | Command discovery through `PATHEXT`, `.cmd` launchers, stopping a process tree, named pipes, file permissions and the CLI work against test stand-ins on a Windows runner. Not run with real Codex, Claude Code or Antigravity on Windows, and on Node 26 the Windows job runs only the type check, the format check and the packaging tests |
| Windows release package | The Release workflow for v0.0.64 on a Windows runner: the zip was extracted to a path with spaces and Chinese characters, started through `oaa.cmd`, and `/healthz` reported the version | Passed for the v0.0.64 package | The Windows package of 0.0.65 has not been through the workflow yet (see the release smoke test below) |
| Docker image | `docker.yml`: build the amd64 image, then a container smoke test (first start, key files, an API call, no key in the log, the Host check, restart, exit code 0 on `docker stop`) | Passed on `ubuntu-latest` | The Dockerfile builds and the container works with the offline sample agent. Not run: the arm64 image, the push to ghcr (both happen only when a release is published), and any agent CLI (the container has none) |
| Compatibility lab | `compat.yml` (every push and pull request, and weekly): eleven package families ran against an isolated gateway with the offline sample agent and a deterministic fixture model, and the recorded request shapes of twelve chat clients were replayed against it. On 2026-11-18, an independent verifier ran the lab locally twice with identical results: 456 scenarios (up from 374 on 2026-11-14), covering 14 clients | 456 scenarios passed, 0 failed, 4 not applicable by design (the client cannot do it), 0 skipped | The live part is the real packages over a real socket; a replay shows only that the gateway accepts the request a client sends and answers in a form it parses, not that the application works. No real model or agent was involved. Cursor is unverified. Versions, evidence level per client and configuration: [compatibility.md](compatibility.md) |
| Developer platform with external agents | Offline end-to-end tests with the sample agent as an externally run listing: the per-listing `host_execution` switch, a delegation or fallback chain, concurrent calls, cancellation, a denied approval, a streaming disconnect, and the charge or release for each | Passed in the offline suite + live `qoder-cli 1.1.52` S10 pass | Offline tests establish rule completeness; live `qoder-cli 1.1.52` on 2026-11-18 proved both the default `403 isolation_required` guard and the `host_execution: true` debit/ledger completion path (`10 -> 8`) |
| Release package smoke test | `scripts/smoke-release.mjs` and `scripts/smoke-flow.mjs` for each package: launcher `--help`, `init` in a path with spaces and Chinese characters, `serve` on a random port and the `/healthz` version, `doctor` marking the Claude engine as needing a separate install, every module of `dist/src` imported with the bundled Node, then `quickstart`, one call on each of three protocols answered by the sample agent, the console page and icon library, a task parked at an approval and approved through the API, the same through `oaa approvals` and `oaa approve`, `oaa status`, a second `quickstart` that creates nothing new, and `oaa stop` freeing the port with no process left | macOS arm64 `0.0.70` `.dmg` passed full suite locally on 2026-11-18; Linux/Windows await release workflow run | Full macOS `0.0.70` `--release` `.dmg` flow (all 353 ESM imports, three protocols, API/CLI approvals, idempotency, clean stop) verified locally; Linux and Windows packages still await a release runner |

## What no check covers yet

- **Real Codex and Claude Code, end to end (partial progress).** On 2026-11-18, Codex 0.167.0 passed S2 streaming, S7 graceful cancel and tool-free orchestration with real usage reporting; Claude Code 2.1.318 correctly returned `adapter_auth_required` when not signed in. The S8 caller-tool bridging re-test against Codex was blocked by its account quota (not a code issue; resets 2026-11-21). Image delivery (Codex `localImage` items and Claude Code image blocks) is still implemented from the vendors' documentation only ([images.md](images.md#verification-status)). Structured-output correction rounds are tested with stand-ins, not with these two.
- **Webhook delivery to a real public HTTPS endpoint.** The tests use local plain-http receivers; HTTPS delivery runs through the same code but is not covered ([webhooks.md](webhooks.md#limits-and-what-is-not-covered)).
- **Desktop apps beyond Apple silicon automation & one manual run.** On 2026-11-18, automated Playwright Electron verification (`desktop:smoke` and `desktop:smoke:matrix`) covered both source and packaged `/Applications/Open Agent API.app` on macOS arm64 for: second-start `.seeded` idempotency, orphan-gateway attach and preservation, `#workbench` + Tray quick approval + macOS Dock badge, `zh`/`en` console reload preservation, Disconnect + reload recovery, and `portHeldByOther` / `portHeldByGateway` / `invalidConfigPort` error probes. Still not covered on physical devices: macOS Intel (`x64`) package, OS-level macOS System Settings language switching across desktop restarts, OS native approval notification toast click-through, non-isolated port `8787` interactive QA beyond health/console startup, and Windows or Linux physical-device UI acceptance (Windows CI validates launcher unit logic/PowerShell syntax only).
- **Real agents on Windows and Linux**, the Linux packages and `install.sh` on a release runner, the arm64 Docker image, and the npm tarball installed from a release.
- **Built-in agents beyond the local-runtime smoke check**, public deployment behind a reverse proxy, calls across machines, and clients such as Cursor and Cline calling the gateway as a model.
- **Broad live model-provider coverage.** The 2026-11-17 local-runtime check exercised real Ollama and llama.cpp through the kernel using a tiny test model, including restart persistence. It does not establish model quality, vision, tool use or equivalent live coverage of the other presets ([models.md](models.md#local-runtime-discovery)).
- **The documentation site on real GitHub Pages.** The generator and its link check run offline; the first deployment is its first look.
- **Long runs beyond what the soak measured.** `npm run soak` (a real gateway process, a fake model, the offline sample agent) ran 32 minutes with three restarts and 62 minutes in one segment on macOS, and met its criteria. It does not cover runs of many hours, real providers or real agent command lines; one 32-minute attempt saw a gateway take about 110 seconds to answer after a SIGKILL, which did not recur and whose cause is unknown ([stability.md](stability.md#5-known-limits)).
