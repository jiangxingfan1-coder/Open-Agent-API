# Command-line reference

English · [简体中文](zh-CN/cli.md)

`oaa` is the command line of Open Agent API. This page lists every command, grouped by what you want
to do, with one line on what it does and one example. Run `oaa` (or `oaa --help`) for the same list in
your language. From a source checkout write `npm run oaa --` instead of `oaa`.

- **Language.** Output follows the system locale; set `OAA_LOCALE=zh` or `OAA_LOCALE=en` to pin it.
- **Errors.** A failed command prints `error_code: message` on stderr (plus a `Next:` line when the
  error catalog has advice) and exits with 1. Error codes are listed in [protocol.md](protocol.md).
- **Where the gateway and the key come from.** Commands that talk to a running gateway take
  `--url URL` and `--token-file FILE`; when they are omitted the environment variables
  `OAA_GATEWAY_URL` and `OAA_TOKEN_FILE` are used, and the address defaults to `http://127.0.0.1:8787`.
  `connect`, `status`, `approvals`, `approve`, `deny` and `verify` can also find them in a local data
  directory (`--dir`, default `.oaa`): the address comes from its `config.json` and the key is the owner
  admin key written by `oaa init`. Pass `--token-file` to use a different key.
- **Keys are never printed.** Commands that create keys write them to a private file (mode 0600).

## Contents

1. [Start and look after a local gateway](#start-and-look-after-a-local-gateway)
2. [Connect an agent you have installed](#connect-an-agent-you-have-installed)
3. [Approvals from the terminal](#approvals-from-the-terminal)
4. [Webhooks](#webhooks)
5. [Verify an agent yourself](#verify-an-agent-yourself)
6. [Keys and the calling identity](#keys-and-the-calling-identity)
7. [Write and publish agents](#write-and-publish-agents)
8. [Call agents and read results](#call-agents-and-read-results)
9. [Worker nodes](#worker-nodes)
10. [MCP and integrations](#mcp-and-integrations)
11. [Share a gateway](#share-a-gateway)

## Start and look after a local gateway

| Command | What it does | Example |
| --- | --- | --- |
| `oaa quickstart [--dir .oaa] [--port 8787]` | Initializes the data directory, starts a gateway in the background, publishes the offline sample agent `agent/sample`, creates a caller key and makes the first call; safe to repeat. | `oaa quickstart --port 18787` |
| `oaa init [--dir .oaa]` | Creates the data directory with `config.json` and the admin key file `admin.token`; installed agent CLIs are recorded as disabled. | `oaa init --dir ./gateway-data` |
| `oaa serve [--config .oaa/config.json] [--dir DIR] [--detach] [--tool-config FILE]...` | Runs the gateway (in the background with `--detach`, which writes `server.pid`); `--tool-config` adds prepared MCP tool bindings to the local worker. | `oaa serve --detach` |
| `oaa stop [--config .oaa/config.json]` | Stops the gateway that `oaa serve --detach` started, after checking that `/health` reports that process. | `oaa stop` |
| `oaa status [--dir .oaa] [--url URL] [--token-file FILE] [--json]` | One read-only answer to "how is my gateway doing": address, version, process ID, uptime, data directory and database size, published agents and whether each can run now (with the reason when not), agents found on this machine but not connected, running, queued and awaiting-approval tasks, recent failed tasks with their error codes, the number of keys, and the security profile from the local configuration (with a warning line when the gateway looks reachable from outside while the profile is still `local`, the same check as the `security_exposure` field of `oaa doctor`). Exits with 1 when the gateway is not running. | `oaa status` |
| `oaa doctor [--config .oaa/config.json] [--write]` | Reports which agent CLIs and ACP agents are installed and what the configuration holds; nothing is executed. `--write` records newly found ACP agents as disabled adapters. | `oaa doctor --write` |

`status` only reads. A key that may not read some part (for example the key list needs the admin key)
still gets the rest, with a note naming the missing part. `--json` prints the same facts as JSON.

## Connect an agent you have installed

| Command | What it does | Example |
| --- | --- | --- |
| `oaa connect NAME [--dir .oaa]` | Detects `codex`, `claude`, `agy` or an ACP agent (preset or adapter name), enables it on the running gateway, publishes it as `agent/NAME`, makes sure the caller key can call it and prints a `curl` to try. It does not call the agent. | `oaa connect codex` |
| `oaa connect [--dir .oaa]` | With no target: lists the external agents found on this machine and every model preset, with the command to type next. | `oaa connect` |
| `oaa connect PRESET [--model M] [--key-env NAME \| --key-file FILE] [--base-url URL] [--agent agent/assistant] [--name NAME] [--definition FILE.oaa] [--test] [--dir .oaa]` | Gives the built-in agent a model: probes a local service (loopback only), writes the provider into the configuration (key reference only; same entry skipped, different entry refused), restarts the gateway only if this data directory started it, publishes `agent/assistant`, checks the caller key and prints a `curl`. Never calls a model; `--test` sends one minimal request, only for loopback endpoints. Presets and keys: [models.md](models.md). | `oaa connect deepseek --key-file ~/.config/deepseek.key` |
| `oaa models [--dir .oaa] [--check] [--json]` | Lists configured model providers: protocol, endpoint, whether the key reference resolves, whether the endpoint answers (loopback automatically, hosted only with `--check`, which requests the model list only) and which agents use each. | `oaa models --check` |
| `oaa publish-native --id ID --engine ENGINE [--models default] [--approvals ask\|auto] --url URL --token-file FILE` | Publishes a built-in engine (`codex`, `claude`, `antigravity`, `dsh`) or an enabled adapter (`adapter/NAME`) as an agent. `--approvals auto` approves the agent's permission requests by policy instead of waiting for you. | `oaa publish-native --id agent/codex --engine codex --url http://127.0.0.1:8787 --token-file .oaa/admin.token` |
| `oaa expose ENGINE\|definition.oaa [--models default] [--approvals ask\|auto] [--id ID] [--dir DIR] [--detach] --url URL --token-file FILE` | Runs an agent CLI on this machine as a worker node of a (possibly remote) gateway and publishes it there. | `oaa expose codex --detach --url https://gw.example.com --token-file admin.token` |

## Approvals from the terminal

On a server without the console, a task that needs your decision waits as "awaiting approval". These
commands use the same API as the console (`GET /v1/runs`, `GET /v1/runs/{id}/actions`,
`POST /v1/runs/{id}/actions/{action}`).

| Command | What it does | Example |
| --- | --- | --- |
| `oaa approvals [--watch] [--json] [--dir .oaa]` | Lists every pending approval: run ID, agent, action ID, when it expires and a one-line summary of the requested operation. With `--watch` it keeps polling (every 2 seconds) and prints each new pending item once; Ctrl+C ends it. With `--json` it prints JSON (one object per line when watching). | `oaa approvals --watch` |
| `oaa approve RESPONSE_ID [--action ACTION_ID] [--all] [--yes] [--dir .oaa]` | Approves the pending item(s) of a run. | `oaa approve resp_0123 --action approval_4567` |
| `oaa deny RESPONSE_ID [--action ACTION_ID] [--all] [--reason TEXT] [--dir .oaa]` | Denies them. The run then fails with `permission_denied`. `--reason` is stored with the approval record; it is not sent to the agent. | `oaa deny resp_0123 --reason "not on production"` |

Behavior:

- **The operation is printed first.** Before anything is decided, `approve` and `deny` print what is
  being decided (kind, run and the full bounded detail of the request).
- **Several pending items.** A run can hold more than one. Without `--action` or `--all` on such a run
  nothing is decided and the command fails with `approval_ambiguous`, listing the items. `--action ID`
  decides one item, `--all` decides every item of the run. A run with no pending item fails with
  `approval_not_found`.
- **Interactive or not.** In a terminal, `approve` asks `[y/N]` after printing the operation (`--yes`
  skips the question; `deny` never asks; answering no decides nothing and fails with `approval_declined`). When stdin or stderr is not a terminal (pipes, scripts, cron)
  nothing is asked and the command decides at once; the result is the exit code (0 when every item was
  decided, 1 otherwise). `--json` prints the per-item results.
- **Calls to your own tools are not approvals.** A run waiting for a tool result from the caller
  (`client_tool`) is neither listed nor decidable here; the caller returns the result (see
  [harness.md](harness.md)).
- **Permissions are the API's.** Deciding needs a key with the `approve` scope (the admin key has it)
  and access to the agent. A caller key made with `oaa key create --approve` can decide the runs it
  may see; a key without the scope is refused up front with a message that says how to fix it, and
  nothing is sent. A stale item (already decided or expired) is reported as failed for that item.

## Webhooks

Run events (completed, failed, waiting for approval and so on) can be pushed to an HTTPS endpoint of
yours, signed and retried; see [webhooks.md](webhooks.md). These commands need the owner admin key and
find the gateway and the key like `approvals` does (`--dir`, `--url`, `--token-file`). All take
`--json`.

| Command | What it does | Example |
| --- | --- | --- |
| `oaa webhook add URL [--event EVENT]... [--agent AGENT]... [--include-output] [--out SECRET_FILE]` | Adds an endpoint. `--event` (repeatable) picks events from `run.requires_action`, `run.completed`, `run.failed`, `run.cancelled`, `run.incomplete`, `run.interrupted` (default: all); `--agent` limits it to agents; `--include-output` adds the final output (at most 32 KiB) to run events. Prints the signing secret once, or with `--out` writes it to a new file with mode 0600 and does not print it. | `oaa webhook add https://hooks.example.com/oaa --event run.completed --out webhook.secret` |
| `oaa webhook list` | Lists endpoints with their events, agents, state (`ok`, `failing`, `disabled`), queued deliveries, consecutive failures and the latest delivery. | `oaa webhook list` |
| `oaa webhook remove ID` | Deletes an endpoint and its queued deliveries. | `oaa webhook remove wh_0123` |
| `oaa webhook test ID` | Queues a `webhook.test` event, waits up to 15 seconds for the first attempt and prints it; exits with 1 when it failed. | `oaa webhook test wh_0123` |
| `oaa webhook deliveries ID [--limit 20]` | Recent deliveries, newest first: event, status, HTTP status, duration, attempts and the last error. | `oaa webhook deliveries wh_0123` |

Enabling, disabling, changing filters, rotating the secret and redelivering go through the API
(`PATCH /v1/webhooks/{id}`, `POST /v1/webhooks/{id}/rotate-secret`,
`POST /v1/webhooks/{id}/deliveries/{delivery}/redeliver`).

## Verify an agent yourself

| Command | What it does | Example |
| --- | --- | --- |
| `oaa verify AGENT [--model default] [--scenarios LIST] [--out DIR] [--executable PATH] [--timeout-ms 300000] [--dir .oaa] [--json]` | Prints the plan: which scenarios, how many real agent calls, and what happens on your machine. Runs nothing. | `oaa verify codex` |
| `oaa verify AGENT ... --confirm-live-cost` | Runs the scenarios and writes `report.json` and `report.md` to `--out` (default `oaa-verify-AGENT-TIME` in the current directory; it must not exist yet). | `oaa verify codex --confirm-live-cost` |

`AGENT` is what `oaa connect` takes (`codex`, `claude`, `agy`, an ACP preset or adapter name), or the
published id `agent/NAME`. The program is found through the local configuration, then `PATH`;
`--executable` overrides it for a built-in engine.

**What it runs.** An isolated gateway inside the command process (127.0.0.1, random port, data and the
agent's working directories in a temporary directory that is deleted at the end). Your own gateway,
data directory and keys are not read or changed. The scenarios (use `--scenarios chat,approvals` or
`S1,S6` to choose; default is all, and the free `cleanup` check always runs):

| Key | Id | Agent calls | What it checks |
| --- | --- | --- | --- |
| `chat` | S1 | 1 | OpenAI Chat Completions, non-streaming. |
| `chat-stream` | S2 | 1 | The same with `stream: true`: how deltas arrive, the final frame. |
| `responses` | S3 | 2 | OpenAI Responses and `previous_response_id` continuation. |
| `claude-messages` | S4 | 2 | Claude Messages, plain and streaming. |
| `gemini` | S5 | 1 | Gemini `generateContent`. |
| `approvals` | S6 | 2 | A task that needs approval: approved then continues; denied then fails with `permission_denied`. |
| `cancel` | S7 | 1 | A background task is cancelled; its child processes must exit. |
| `client-tools` | S8 | 1 | The agent calls a tool the caller provides and continues with the result. |
| `concurrency` | S9 | 3 | Three tasks at once do not mix up answers. |
| `errors` | S11 | 0 | Wrong key, no access and malformed bodies on three wire formats. |
| `cleanup` | S12 | 0 | No child process or key left behind. |
| `usage` | S13 | 0 | Whether the earlier responses reported token usage (derived, no call). |

Each scenario is judged `pass`, `FAIL`, `unsupported` (the engine does not offer the capability, as
documented) or `skipped`. Nothing is retried, a failed scenario never stops the others, and every
scenario has a hard timeout (`--timeout-ms`). Ctrl+C ends the run cleanly: the running task is
cancelled, the agent processes are stopped, the remaining scenarios are marked `skipped` and a partial
report is still written (exit code 130). Exit code: 0 when nothing failed, 1 when a scenario or the
setup failed.

**Real calls cost something.** Every scenario sends real prompts to the agent, using the agent's own
sign-in and quota, with your permissions on this machine; the approvals scenario has it create a file
in the temporary directory. Without `--confirm-live-cost` nothing is started. Before the scenarios the
agent is started once without a prompt (the ACP `initialize` handshake, or `--version`) to read its
self-reported name and version; this calls no model.

**The reports** contain the gateway version, the agent's name and self-reported version, the operating
system and architecture, Node.js version, each scenario's result, time and failure reason, and the
differences from [adapters.md](adapters.md). They are scrubbed before they are written: keys and
tokens, your user name, host name, home and other local paths, e-mail and LAN addresses are removed.
Read `report.md` once before posting it; the
[Agent verification report](../.github/ISSUE_TEMPLATE/agent_verification.md) issue template asks for it.

The same scenarios back `examples/live-agents-acceptance.ts` (the script that produced the Antigravity
evidence in [evidence.md](evidence.md)), which keeps its own command line.

## Keys and the calling identity

| Command | What it does | Example |
| --- | --- | --- |
| `oaa key create --name NAME [--agent AGENT]... [--approve] [--out FILE] --url URL --token-file ADMIN_TOKEN` | Creates a caller key (scopes `invoke`, `read`, `files`; plus `approve` with `--approve`) for the given agents (default all) and writes it to a private file. | `oaa key create --name ci --agent agent/codex --approve --token-file .oaa/admin.token` |
| `oaa me --url URL --token-file FILE` (alias `whoami`) | Shows who the key is: owner, scopes, granted agents, quota and live usage. | `oaa me --token-file .oaa/keys/ci.key` |

## Write and publish agents

| Command | What it does | Example |
| --- | --- | --- |
| `oaa check definition.oaa` | Checks an `.oaa` source and prints diagnostics and workflow plans; exits with 1 when invalid. | `oaa check examples/research.oaa` |
| `oaa fmt definition.oaa [--out FILE]` | Prints the formatted source (or writes a new file); comments are not kept. | `oaa fmt a.oaa --out formatted.oaa` |
| `oaa decompile definition.json [--out FILE]` | Turns a definition JSON into `.oaa` source. | `oaa decompile agent.json --out agent.oaa` |
| `oaa build definition.oaa\|definition.json [--skill DIR]... [--tool-binding FILE]... --out bundle.json` | Builds a reviewable bundle file without contacting a gateway. | `oaa build a.oaa --skill ./skills/research --out bundle.json` |
| `oaa publish definition.oaa\|definition.json [--skill DIR]... [--tool-binding FILE]... --url URL --token-file FILE` | Builds and publishes in one step. | `oaa publish examples/research.oaa --token-file .oaa/admin.token` |
| `oaa publish-bundle BUNDLE.json --url URL --token-file FILE` | Publishes a bundle you reviewed, with nothing added. | `oaa publish-bundle bundle.json --token-file .oaa/admin.token` |

## Call agents and read results

| Command | What it does | Example |
| --- | --- | --- |
| `oaa agents [--offset 0] [--limit 20] [--revision REVISION]` | Pages through the catalog of published agents. | `oaa agents --limit 5` |
| `oaa agent AGENT [--section overview\|routes\|tools\|skills] [--offset N] [--limit N] [--agent-version DIGEST]` | Shows one agent. | `oaa agent agent/codex --section routes` |
| `oaa agent AGENT [--agent-version DIGEST] --out NEW_FILE` | Downloads the agent's full public metadata (the file must not exist). | `oaa agent agent/codex --out codex.json` |
| `oaa catalog [--cursor CURSOR] [--limit 32] [--timeout-ms 20000]` | Long-polls the catalog change feed. | `oaa catalog --limit 10` |
| `oaa preview AGENT [--model auto] [--agent-version DIGEST] [--file-id ID]... [--previous-response-id ID]` | Shows how a call would be routed, without running it. | `oaa preview agent/codex` |
| `oaa invoke AGENT --input TASK [--model auto] [--agent-version DIGEST] [--file-id ID]... [--previous-response-id ID] [--idempotency-key KEY]` | Starts a background task and prints its run ID. | `oaa invoke agent/sample --input "hello"` |
| `oaa get RESPONSE_ID` | Prints the run's state. | `oaa get resp_0123` |
| `oaa wait RESPONSE_ID [--timeout-ms 20000]` | Waits for the run to change state (up to the timeout). | `oaa wait resp_0123` |
| `oaa output RESPONSE_ID [--cursor CURSOR] [--max-bytes 8000]` | Reads the run's output a page at a time. | `oaa output resp_0123` |
| `oaa artifacts RESPONSE_ID [--offset 0] [--limit 10]` | Lists the files the run produced. | `oaa artifacts resp_0123` |
| `oaa cancel RESPONSE_ID` | Cancels a run. | `oaa cancel resp_0123` |
| `oaa resume RESPONSE_ID` | Resumes an interrupted run. | `oaa resume resp_0123` |
| `oaa upload SELECTED_FILE [--allowed-node NODE]...` | Uploads one file you chose and prints its file ID. | `oaa upload report.pdf` |
| `oaa download FILE_ID --out NEW_FILE` | Downloads a file; an existing file is never overwritten. | `oaa download file_0123 --out result.txt` |

## Worker nodes

| Command | What it does | Example |
| --- | --- | --- |
| `oaa node join --config worker.json [--tool-config FILE]...` | Runs this machine as a worker node that connects to a gateway. | `oaa node join --config worker.json` |
| `oaa nodes` | Lists node registrations. | `oaa nodes` |
| `oaa node drain\|resume\|revoke NODE_ID [--reason TEXT]` | Stops sending new work to a node, resumes it, or revokes it. | `oaa node drain laptop --reason maintenance` |
| `oaa node history NODE_ID [--cursor EVENT_ID] [--limit 50]` | Shows a node's audit history. | `oaa node history laptop` |

## MCP and integrations

| Command | What it does | Example |
| --- | --- | --- |
| `oaa mcp --url URL --token-file FILE` | Serves the gateway to an MCP client over stdio. | `oaa mcp --token-file .oaa/admin.token` |
| `oaa mcp inspect --config worker.json --server NAME [--tool NAME] [--cursor CURSOR]` | Lists the tools of an MCP server configured on a worker. | `oaa mcp inspect --config worker.json --server files` |
| `oaa mcp prepare --config worker.json --server NAME --tool NAME --capability private/name --out NEW_DIRECTORY [--name N] [--version V] [--effect E] [--approval A] [--export-result] [--optional]` | Prepares a reviewable capability binding for one MCP tool. | `oaa mcp prepare --config worker.json --server files --tool read --capability private/read --out ./prepared` |
| `oaa integration --out FILE --token-file FILE [--url URL]` | Writes an MCP client configuration (`mcpServers`) that starts `oaa mcp`; nothing is installed. | `oaa integration --out mcp.json --token-file .oaa/admin.token` |

`oaa mcp-relay` is started by ACP agents from their session configuration; it is not for people.

## Share a gateway

| Command | What it does | Example |
| --- | --- | --- |
| `oaa tunnel [URL\|none] [--public-url URL] [--detach] --url URL --token-file FILE` | Registers the public base URL of the gateway; without one it opens an HTTPS tunnel with `cloudflared` if installed. `none` clears the setting. | `oaa tunnel --public-url https://agents.example.com --token-file .oaa/admin.token` |
