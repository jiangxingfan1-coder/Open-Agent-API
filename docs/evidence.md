# Evidence: which agents were really turned into an Agent API

English · [简体中文](zh-CN/evidence.md)

> 2026-11-11: an integration session on a macOS machine against real agents installed on it (on 2026-11-13 there was also an end-to-end verification of Antigravity, described at the end of this page). Every row is a result that was actually executed and observed; what was not done is marked "not tested", and failures are recorded honestly with their cause. The coverage of test stand-ins (protocol-level fake agents) is in the [conversion contract of adapters.md](adapters.md#agentapi-conversion-contract-2026-11-08) and is not counted on this page.

## Conclusions (boundaries first)

- **This does not prove that "every agent" can be converted.** What it does show is that an agent can be published as an Agent API as long as it offers one of four ways in (built-in native, ACP, an `oaa/1` adapter, A2A). Of the 7 real agents installed on this machine, 3 completed real calls, and the other 4 were blocked by their own account or configuration state (not signed in, twice; an expired key; their own configuration lock), and the gateway returned a clear error instead of a vague failure.
- **"Other agents can use this API" was demonstrated once with a real agent**: Antigravity (Gemini 3.8 Flash), as the caller, called `agent/codex`, which Codex provided, through OAA's MCP entry and got the correct result. Two layers of harness, two different agents, two different models.
- **Since 0.0.64 the automated checks have grown a lot, and the real-agent record has not.** CI now runs the whole suite on Linux, macOS and Windows and on Node 24 and 26, builds and smoke-tests the Docker image, and runs a compatibility lab with the official SDKs and replays of popular chat clients (see [Automated checks in CI](#automated-checks-in-ci-2026-11-14)). All of that uses stand-in agents and fixture models. End-to-end with a real agent is still Antigravity only, and Codex and Claude Code have not been re-run (see [What no check covers yet](#what-no-check-covers-yet)).

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

## Automated checks in CI (2026-11-14)

These ran on GitHub Actions on a development branch of the public repository, with the code that became 0.0.65. None of them involves a real agent, a real model provider or an account: they use deterministic fixtures and stand-in agents.

| Check | What ran | Result | What it shows, and what it does not |
| --- | --- | --- | --- |
| The whole offline suite on Linux and macOS, Node 24 and 26 | `ci.yml`: `npm run verify` (type check, format check, every test) on `ubuntu-latest` and `macos-latest`, each on Node 24 and Node 26 | Passed on all four | The code behaves on both Node lines of `engines` on those two systems |
| The whole suite on Windows | `windows.yml`: `node scripts/test-offline.mjs --all --isolate` on `windows-latest`, Node 24: one process per test file; tests that only make sense on POSIX are skipped with a stated reason | Passed (about 10 minutes) | Command discovery through `PATHEXT`, `.cmd` launchers, stopping a process tree, named pipes, file permissions and the CLI work against test stand-ins on a Windows runner. Not run with real Codex, Claude Code or Antigravity on Windows, and on Node 26 the Windows job runs only the type check, the format check and the packaging tests |
| Windows release package | The Release workflow for v0.0.64 on a Windows runner: the zip was extracted to a path with spaces and Chinese characters, started through `oaa.cmd`, and `/healthz` reported the version | Passed for the v0.0.64 package | The Windows package of 0.0.65 has not been through the workflow yet (see the release smoke test below) |
| Docker image | `docker.yml`: build the amd64 image, then a container smoke test (first start, key files, an API call, no key in the log, the Host check, restart, exit code 0 on `docker stop`) | Passed on `ubuntu-latest` | The Dockerfile builds and the container works with the offline sample agent. Not run: the arm64 image, the push to ghcr (both happen only when a release is published), and any agent CLI (the container has none) |
| Compatibility lab | `compat.yml` (every push and pull request, and weekly): eleven package families ran against an isolated gateway with the offline sample agent and a deterministic fixture model, and the recorded request shapes of twelve chat clients were replayed against it | 374 scenarios passed, 0 failed, 4 not applicable by design (the client cannot do it), 0 skipped: 244 in the live part, 130 in the replays | The live part is the real packages over a real socket; a replay shows only that the gateway accepts the request a client sends and answers in a form it parses, not that the application works. No real model or agent was involved. Cursor is unverified. Versions, evidence level per client and configuration: [compatibility.md](compatibility.md) |
| Developer platform with external agents | Offline end-to-end tests with the sample agent as an externally run listing: the per-listing `host_execution` switch, a delegation or fallback chain, concurrent calls, cancellation, a denied approval, a streaming disconnect, and the charge or release for each | Passed in the offline suite | The billing rules hold for an external agent that reports no usage. The success path of billing with a real external agent (scenario S10 above) has still not been seen |
| Release package smoke test | `scripts/smoke-release.mjs` and `scripts/smoke-flow.mjs` for each package: launcher `--help`, `init` in a path with spaces and Chinese characters, `serve` on a random port and the `/healthz` version, `doctor` marking the Claude engine as needing a separate install, every module of `dist/src` imported with the bundled Node, then `quickstart`, one call on each of three protocols answered by the sample agent, the console page and icon library, a task parked at an approval and approved through the API, the same through `oaa approvals` and `oaa approve`, `oaa status`, a second `quickstart` that creates nothing new, and `oaa stop` freeing the port with no process left | The first part ran in the v0.0.64 Release workflow; the rest was added afterwards and has not run on a release runner yet | The package carries what it needs and a first-time user can get an answer from the sample agent. Not run: any real agent |

## What no check covers yet

- **Real Codex and Claude Code, end to end.** No call to either has been repeated since the manual session of 2026-11-11, and the end-to-end script has not been run against them. That includes image delivery: the Codex `localImage` items and the Claude Code image blocks are implemented from the vendors' documentation only ([images.md](images.md#verification-status)). Structured-output correction rounds and caller-tool bridging are tested with stand-ins, not with these two.
- **Webhook delivery to a real public HTTPS endpoint.** The tests use local plain-http receivers; HTTPS delivery runs through the same code but is not covered ([webhooks.md](webhooks.md#limits-and-what-is-not-covered)).
- **The desktop apps, beyond one manual check.** The project owner opened a release-mode package of the macOS app once on 2026-11-14 on an Apple silicon Mac, as an isolated run, and confirmed five things: the console opens already connected with no connection dialog, the one-time first-launch note appears, the console is still connected after ⌘R (the hand-over of the admin key through `sessionStorage`), the About box shows the right version, and the menus and dialogs follow the system language (only the owner's current system language was seen). Not verified: the three messages for a port that is in use; the language switch in both directions; that a second start with the same data folder does not show the first-launch note again; recognizing and reusing a gateway left behind by a crashed app; the Intel package; the normal, non-isolated installation (default data folder, port 8787) of this version; the bilingual messages of the Windows launcher (no Windows machine; CI only checks the PowerShell syntax); the approval notifications. The offline tests run the pure logic of the shell (language, port and data-folder handling, whose gateway is on a port, the console sign-in script).
- **Real agents on Windows and Linux**, the Linux packages and `install.sh` on a release runner, the arm64 Docker image, and the npm tarball installed from a release.
- **Built-in agents with a real model provider**, public deployment behind a reverse proxy, calls across machines, and clients such as Cursor and Cline calling the gateway as a model.
- **The model provider presets of `oaa connect`** (Ollama, OpenAI, Anthropic, DeepSeek and the rest): their addresses and differences were checked against each service's documentation, and the tests use fake services; no preset has been run against a real model service ([models.md](models.md)).
- **The documentation site on real GitHub Pages.** The generator and its link check run offline; the first deployment is its first look.
- **Long runs beyond what the soak measured.** `npm run soak` (a real gateway process, a fake model, the offline sample agent) ran 32 minutes with three restarts and 62 minutes in one segment on macOS, and met its criteria. It does not cover runs of many hours, real providers or real agent command lines; one 32-minute attempt saw a gateway take about 110 seconds to answer after a SIGKILL, which did not recur and whose cause is unknown ([stability.md](stability.md#5-known-limits)).
