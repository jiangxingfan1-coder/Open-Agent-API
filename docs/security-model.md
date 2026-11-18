# Security model

English · [简体中文](zh-CN/security-model.md)

This document describes who can do what in an Open Agent API (OAA) gateway, what is exposed by
default, what you must do before exposing a gateway to the internet, and where the gateway does
**not** defend you. It describes the code as of version 0.0.65. Report vulnerabilities as described in
[`SECURITY.md`](../SECURITY.md).

## Parties and trust boundaries

| Party | Authenticates with | Trusted with |
| --- | --- | --- |
| **Owner / admin** | API key with `admin` scope (`sk-oaa-…`, legacy `oaa_…`, or a key from the config file) | Everything of its owner: publishing agents (including engines, model routes, MCP servers, HTTP/A2A adapter URLs, `approvals: auto`), creating keys, enrolling nodes, platform settings. An admin is equivalent to the operator of the machine. |
| **Agent-limited admin** | `admin` key whose `agents` is not `*` | Admin actions limited to its agents. It cannot manage node lifecycle, read the audit trail, or revoke / re-quota keys outside its agents or its own key. When it has a quota, keys it creates or changes must set every limit of that quota no higher than its own (`quota_exceeds_own`). Each such key has its own counters, so several keys together can still use more than one key's quota. |
| **Caller** | Non-admin API key | Calling the agents its key grants, with the scopes it holds (`invoke`, `read`, `files`, `approve`, `billing`). Sees only its own runs, files, artifacts, memories and idempotency keys (its *subject*), unless the key has `data_scope: owner`. |
| **Portal user** | Portal session `oas_…` (developer platform) | Its own account, keys, balance, usage and runs. Account keys get `invoke/read/files` on listed agents only, at the platform's execution level (`workspace` or `sandbox`). Exception, per listing: when the owner turns on a listing's `host_execution`, account keys may run **that agent** at `host`, i.e. as the gateway's OS user (each delegate, hand-off or fallback target needs its own listing switch). Its permission requests are decided by the owner only; account keys have no `approve` scope. Switch changes are audited (`platform_listing_host_execution`). See [platform.md](platform.md#offering-external-agents). |
| **Execution node** | Node token `oan_…` over `/v1/nodes/connect` | Running the work the gateway assigns for the agents it was enrolled for. See "Execution nodes" below. |
| **Agent** (model or external CLI agent) | — | Nothing by itself. Its output is untrusted data. An external agent at execution level `host` runs as the gateway's OS user with that user's files and (inherited) environment. |

Boundaries that are enforced on every entry point (OpenAI Chat/Responses, Claude Messages,
Gemini, native `/v1/runs`, files, timeline, event streams):

- **Key → owner**: every query is filtered by the key's owner.
- **Key → subject**: run, file, artifact and memory reads are filtered by the caller's subject
  (`visibleSubject` in `src/core/contracts.ts`); another caller's IDs return `404` without
  revealing existence. Cancel, resume, approve and reconcile use the same filter.
- **Key → agents**: `authorize()` checks the agent grant for every read and action on a run.
- **Key → execution level**: a key below `host` cannot start an agent that needs `host`
  (external agents, host tools), checked along the delegation chain and fallback chain before
  any work (`isolation_required`). The only widening is the developer platform's per-listing
  `host_execution` switch, which opens `host` for that one agent and never for the agents it
  delegates to; an owner who turns it on accepts that platform accounts can make that agent act
  as the gateway's OS user, bounded by its `approvals` policy and working directory.
- **Revocation / expiry / account disabled** take effect on the next request; open event
  streams re-validate their key and close when it stops being valid (measured: a
  `/v1/catalog/events` stream ended within milliseconds of `DELETE /v1/keys/:id`).

## Execution nodes

- A node connects with `Authorization: Bearer oan_…` plus `x-oaa-node-id`; the gateway stores
  only the token's SHA-256 and compares in constant time. Its advertisement must stay within the
  capabilities it was enrolled for (`node_scope_denied`). Revoking a node closes its sockets
  immediately; draining stops new work.
- Every message is schema-checked and capped at 24 MiB per frame. Results and events are only
  accepted for a request the gateway sent to *that* socket with a matching random lease ID, so a
  node cannot read or answer work placed on other nodes, and never receives API keys, other
  callers' runs, or the gateway's own secrets.
- What a malicious or compromised node **can** do: see everything in the work placed on it
  (agent instructions, caller input, input files, and the caller's own BYOK provider key if the
  run uses one); return forged output, artifacts and token usage for those runs (usage drives
  quotas and platform billing); claim an isolation level (`workspace`/`sandbox`) it does not
  really enforce; send many events or 24 MiB frames for its own pending runs.
- What a malicious **gateway** can make a node do: run the agents and tools the node itself has
  configured and enabled (native/ACP agents, MCP servers, script runtimes listed in `scripts`)
  with gateway-chosen prompts, files and isolation level. Only enable on a node what you would
  let the gateway's admin run on that machine, and connect only to gateways you trust (`wss://`
  is required for non-local gateways).

## External agents, ACP and MCP

- ACP agents are offered **no** client file-system or terminal capability
  (`fs.readTextFile/writeTextFile: false`, `terminal: false`); any `fs/*` or `terminal/*`
  request is answered "method not found". ACP agents read and write files and run commands with
  their *own* tools, inside their own process, as the gateway's OS user. Their
  `session/request_permission` requests go to the owner approval flow and only one-shot
  "allow once" options are ever selected. In a bridged turn, a permission request is approved
  automatically only when its title names exactly a caller-supplied relay tool (a title that
  merely mentions the relay and a tool name, such as a shell command, still needs approval).
- Text that agents report (titles, tool names, paths, output) is shown in the console with
  `textContent`, never as HTML.
- MCP servers are configured by name in the worker config: stdio servers get their `command`, the
  MCP SDK's basic environment (such as `PATH`, `HOME`) and only the extra names listed in
  `envNames`; HTTP servers need `https` (except loopback)
  and take their bearer token from `tokenEnv`. Callers cannot add or change servers; agents can
  only use servers the admin published. Tool descriptions and results from an MCP server are
  passed to the model as-is: a malicious or compromised MCP server can prompt-inject the agent.
- `oaa mcp` (the gateway as an MCP server) is a local stdio process that calls the gateway with
  the API key you give it; it has exactly that key's rights. The caller-tool relay
  (`oaa mcp-relay`) talks over a Unix socket in a `0700` directory and must present a random
  per-turn token.

## Credential storage

- Managed API keys, portal sessions, node tokens, reset codes and redeem codes are stored as
  SHA-256 hashes only; the plaintext is shown once. Keys from the config file are read from env
  or files at startup and kept in memory.
- Comparisons use `timingSafeEqual` over hashes.
- Portal passwords use scrypt (N=32768, r=8, p=3, 16-byte salt); unknown emails cost one scrypt
  too. Changing or resetting a password, or disabling an account, ends all its sessions.
- Login, signup, password reset and credit-code redemption failures are rate-limited per client IP,
  per email and per account, persisted in SQLite (`platform_rate_limits`) across restarts.
- When `platform.verificationWebhookUrl` is configured, signup and self-service password reset
  return a uniform verification prompt (eliminating `email_taken` enumeration) and deliver signed
  verification events asynchronously over HTTPS.
- Error messages pass through `redact()`, which removes `sk-…`, `oaa_…`, `oan_…`, `oas_…`,
  `Bearer …`, Google `AIza…`, GitHub, Slack and AWS access-key formats and `key=value` secrets.
  Redaction is a safety net, not a guarantee.

## Browser surface

- The console and portal are same-origin pages that send `Authorization: Bearer`. No cookies are
  used, so there is no CSRF surface. The admin key lives in `sessionStorage`, the portal session
  in `localStorage`; any XSS on the gateway origin could read them.
- All console/portal HTML and scripts are served from a fixed allowlist with a strict CSP
  (`script-src 'self'`, no inline script or style, `frame-ancestors 'none'`). User-controlled
  text (agent output, inputs, names, errors) is rendered with `textContent`.
- Every request's `Host` must match `allowedHosts` (default: `127.0.0.1`, `localhost`, `[::1]`),
  which blocks DNS rebinding against a local gateway. A request with an `Origin` other than its
  own host is refused unless listed in `allowedOrigins`.
- With `consoleHosts` set, the console and admin keys only work on those hosts.

## Default exposure

A fresh `oaa init` / `oaa quickstart` gateway (security profile `local`):

- listens on `127.0.0.1` only, with the loopback `allowedHosts`;
- has one owner-wide admin key;
- creates new keys at execution level `host` unless `defaultKeyExecution` says otherwise;
- external agents inherit the gateway's environment (minus `OAA_*`) unless `nativeEnv` is set to
  an allowlist;
- the developer platform is off.

The desktop apps (macOS app, Windows launcher) run the same gateway on `127.0.0.1`, by default on
port 8787 (the `port` in the app's own `config.json`; the macOS app can also run isolated from a
temporary data folder, see [install.md](install.md#macos)). Before it uses a gateway that is already
on its port, the macOS app checks that the gateway belongs to its own data folder; it does not
connect to, or give the admin key to, any other program on that port.
On every launch the macOS app sets `enabled: true` for each native engine in `localWorker.native`
whose executable exists (for example Codex, Claude Code, Antigravity). That makes the engine
*available* to the local worker; an agent still has to be published before any key can call it.
On a first launch it also publishes the offline sample agent `agent/sample` (it calls no model) and,
when `agy` is installed, the Antigravity example `agent/antigravity`, and tells you once in a
dialog what it enabled and published (see [install.md](install.md#macos)).
The Windows launcher runs `oaa quickstart`, which also creates a caller key
(`keys\quickstart.key`) for all agents (`*`) with the `approve` scope. Because new keys default
to execution level `host`, such a key can call any host-level agent you publish later, and that
agent runs on your machine as your user with the files, commands and environment it can reach.
As long as the gateway stays on loopback and the keys stay on your machine, this is the intended
local use. It becomes remote code execution for whoever holds a key once the port is reachable
from elsewhere (port forwarding, a tunnel, `host: 0.0.0.0`). To sign the console in
automatically, the macOS app puts the admin key into the page's `sessionStorage` (it belongs to the
window's page and is not part of the persistent web storage that `localStorage` is) on every load of
the console, in the main frame and only on the gateway's own origin. Earlier versions also wrote it to the persistent `localStorage` (and
under two more names that nothing read); the app now deletes those copies whenever it loads the
console. The key file `admin.token` stays in the data folder.

## Before exposing a gateway to the internet

0. Set `"security": {"profile": "public"}`. For every setting your config leaves unset it uses:
   `defaultKeyExecution: workspace`, `localWorker.nativeEnv: {mode: allowlist}`,
   `maxStoredBytesPerSubject: 256 MiB`, and `security.requestTimeoutMs: 120000` (the time to
   *receive* one request; responses and streams are not limited). Any value you set explicitly
   wins. The default profile `local` changes nothing. `oaa doctor` reports
   `security_exposure` when the config looks exposed (`host` not loopback, `publicBaseUrl` set,
   or open platform registration) while the profile is still `local`; it cannot see a tunnel
   started at runtime. Remote worker configs are separate files: set `nativeEnv` there yourself.
1. Terminate TLS (built-in `tls` or a reverse proxy) and set `allowedHosts` to your public
   name. Set `trustProxy: true` only behind a proxy you control, otherwise IP-based limits are
   either shared by everyone (all traffic looks like the proxy) or spoofable.
2. Set `consoleHosts` to a separate, non-public host name (or VPN-only) so admin keys and the
   console are not reachable from the public name.
3. Set `defaultKeyExecution: workspace` (or `sandbox`), and do not grant `host`-level agents to
   keys you hand out. A `host` agent is remote code execution as your OS user by design.
4. Set `nativeEnv` to an allowlist so external agents do not see your provider keys and other
   secrets. With inherited environment, a caller can ask a tool-using agent to print it.
5. Give every caller key a quota (`rpm`, `maxRuns`, `maxTokens`, `expiresAt`) and set
   `maxActiveRunsPerSubject` and `maxStoredBytesPerSubject`. Files are never deleted
   automatically; without `maxStoredBytesPerSubject` a caller with the `files` scope (including
   every portal account key) can fill the disk.
6. Put a reverse proxy with connection limits and body/header timeouts in front. Under the
   `local` profile the gateway does not limit the time to receive a request (`requestTimeoutMs`
   unset), so slow uploads are only bounded by the proxy. The unauthenticated portal forms
   (login, signup, password reset) accept at most 64 KiB bodies in every profile.
7. Treat `approvals: auto` as "no human in the loop": every tool call of that agent runs without
   asking. Its publication is audited.
8. Review MCP servers, HTTP/A2A adapter URLs and model `baseUrl`s you publish: the gateway calls
   them (no redirects) and does not block private or metadata addresses, because these are set
   by the admin, not by callers.

## Known gaps (not defended)

- **Prompt injection**: caller input and fetched content reach the agent. An agent with file,
  shell or network tools can be steered to use them within its execution level and approvals.
- **Environment inheritance** (default): see item 4 above.
- **Agent-limited admins** with a quota can create several keys, each up to their own quota.
- **Account enumeration (when `verificationWebhookUrl` is unset)**: without an outbound verification
  webhook configured, portal signup answers `email_taken` for a registered email so synchronous
  local/invite signups can return a usable session immediately. Set `platform.verificationWebhookUrl`
  on public sites for a uniform verification response.
- **Single-node rate-limit scope**: portal rate limits persist in SQLite across gateway restarts,
  while per-key API RPM counters remain in memory per gateway process.
- **Compromised execution nodes** see the runs placed on them (including BYOK keys) and can
  return forged results and usage.
- **Stored data** (SQLite and files) is not encrypted at rest; protect the data directory with
  file permissions and disk encryption.
- **The macOS app's engine switch** is not an opt-out: each launch sets `enabled: true` again for
  every native engine whose executable exists, so turning one off in the config file does not
  last. What keeps an engine from running is that no agent that uses it is published.
- **Old copies of the admin key** that earlier versions of the macOS app left in the web view's
  `localStorage` are removed when the console is loaded from the same origin (same port). If the
  port was changed after such a version, the copy under the old port's origin stays in the app's
  web storage until the console is opened on that port again.
