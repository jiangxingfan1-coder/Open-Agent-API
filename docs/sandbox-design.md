# Sandbox worker design (the last P1 item)

English · [简体中文](zh-CN/sandbox-design.md)

> Status: S1 is implemented. The code for S2a (Claude and Codex inside the sandbox) is implemented and verified with protocol stand-ins, but **has not been tested against the real CLIs and real models** (see "Still to be tested" in §4.1). S3 has not started (2026-11-08).
> - `@anthropic-ai/sandbox-runtime@0.0.82` is installed, with `--ignore-scripts`. The zod 3 it bundles has an audit warning of the memory-exhaustion kind; srt only uses it to validate configuration that we build and that has length limits, and external input cannot reach that path.
> - Where it lives: `src/engines/sandbox.ts` (`SrtLauncher`, the self-check), `src/engines/process.ts` (the sandbox parameters of `collectProcess`), `src/fabric/worker.ts` (the `sandbox` config option; script tools run in the sandbox), `src/kernel/kernel.ts` and `src/fabric/placement.ts` (the `sandbox` level, scheduling and negotiation).
> - Tests: `test/sandbox-routing.test.ts` (opens no ports) and `test/sandbox-srt.test.ts` (starts srt proxies, **runs only after authorization**).
> - Trade-offs made in the implementation: one worker runs only one sandboxed process at a time (§5); `parentProxy` is not enabled by default.
> - Finding from S2: srt's `credentials.envVars` (`mode: "mask"` plus `injectHosts`) lets a native agent in the sandbox see only placeholders, while the real BYOK key is substituted by the host-side proxy when the request goes out to the provider.
> - Every step that involves downloading dependencies, listening on ports, or outbound network rules must be confirmed individually at implementation time (see §8).

## 1. Decisions already made

| Decision | Outcome |
|---|---|
| First isolation backend | **Anthropic sandbox-runtime (srt)**: `sandbox-exec` on macOS, bubblewrap on Linux; the network is allowed by domain through a proxy on the host |
| First executions to go into the sandbox | **Publisher script tools + native agents** (Codex, Claude, Antigravity, DSH) |
| Outbound network policy | **Deny everything by default, plus an allowlist** |
| Production platform | Not decided yet, so the interface is platform-independent; a gVisor backend can be added on Linux later |

## 2. Current state and goal

Today every external process a worker starts runs with the host's privileges: publisher scripts (the `handler.kind === 'script'` branch in `src/fabric/worker.ts`), native agents (`src/engines/native.ts`), and ACP and stdio adapters. All of them are started through `ownedProcess` / `collectProcess` in `src/engines/process.ts`, which is the single place where the sandbox plugs in.

Goal: a `sandbox`-level key can run these agents, and their processes:

- can read and write only the workspace of this session; the capability pack directory and the runtime directories are read-only; every other path is denied, including home, `~/.ssh`, the OAA data directory, and the workspaces of other sessions.
- can reach only the domains on the allowlist. They cannot reach localhost, including the gateway at `127.0.0.1:8787`, and they cannot reach the local network or cloud-provider metadata addresses.
- cannot obtain the host's credentials or sign-in state.
- are limited in CPU, memory, number of processes, and duration.

## 3. Architecture

```
kernel ──schedules──▶ worker
                       ├─ built-in tools (workspace level, in-process, unchanged)
                       └─ SandboxLauncher.spawn(spec) ──▶ backend
                             ├─ none   (host level, same as today)
                             ├─ srt    (this phase)
                             └─ gvisor (later, Linux only)
```

### 3.1 The `SandboxLauncher` interface (`src/engines/sandbox.ts`, a new file)

```ts
type SandboxSpec = {
  command: string; args: string[];
  workspace: string;            // the only writable directory
  readOnly: string[];           // capability pack, runtimes (node/python/CLI install directories)
  env: Record<string, string>;  // environment variables already computed from nativeEnv / BYOK
  allowedDomains: string[];     // the outbound allowlist, already intersected
  limits: { cpuSeconds: number; memoryMb: number; processes: number; wallMs: number };
};
interface SandboxLauncher {
  readonly backend: 'srt' | 'gvisor';
  spawn(spec: SandboxSpec, signal: AbortSignal): ChildProcessWithoutNullStreams;
}
```

`ownedProcess` gets one optional parameter, `sandbox?: SandboxSpec`. If it is passed, the launcher starts the process; if not, behavior is as it is now. Scripts, native agents, and adapters only pass this one extra parameter at the call site; the executors themselves do not change.

### 3.2 One more execution level

`workspace < sandbox < host` (added to `executionLevels` in `src/core/contracts.ts`).

- The **required level** of an agent does not change: scripts and native agents are still `host`.
- When a key's allowed level is `sandbox`, such agents are **scheduled only to nodes that declare the sandbox capability**, and run inside the sandbox. If that is not possible, the response is still `isolation_required`.
- Private host tools on a node (handlers of type `node`, for example MCP) **always need `host`**. They exist to reach the owner's private resources, and a sandbox cannot help there.
- For a public deployment, set `defaultKeyExecution` to `sandbox`.

### 3.3 Node declaration and negotiation

This follows the BYOK approach: the gateway adds `sandbox-v1` to `welcome.features`, and only after receiving it does the worker report in `execution`:

```json
{ "sandbox": { "backend": "srt", "version": "x.y.z", "kinds": ["script", "native/claude", "native/codex"] } }
```

`kinds` lists only the execution types **verified on this machine to run inside the sandbox** (see the self-check in §5). The scheduler's condition is: a `sandbox`-level request plus the kind being in the list.

### 3.4 How the outbound allowlist is computed

```
effective allowlist = (publisher-declared ∩ approved by the worker owner) ∪ the native engine's model provider domains
```

- **Publisher-declared**: `capability.network.allowedDomains` (scripts) or `agent.network.allowedDomains` (native agents) is added to the capability pack. This is public metadata made available at publish time and visible during review.
- **Approved by the worker owner**: the worker config `sandbox.allowDomains` is the upper bound. A domain the publisher declares but the owner has not approved does not take effect.
- **Provider domains**: the worker config lists the API domains of each native engine, for example `api.anthropic.com` for Claude. Only the owner can configure these; the publisher cannot add any.
- When the intersection of the two lists is empty, the network is completely off. srt additionally blocks loopback, link-local addresses, metadata addresses, and the host's own addresses (its "resolved-address check").

## 4. Special problems of putting native agents in the sandbox

| Problem | Design |
|---|---|
| **Sign-in state**: CLIs read the owner's sign-in information by default from directories such as `~/.claude` and `~/.codex` | `HOME` inside the sandbox points to a **brand-new empty directory** in the workspace, and the owner's configuration directories are not mounted. An agent controlled by a stranger must never get the owner's subscription sign-in |
| **Which key does it use, then** | By default **the caller must bring their own key (BYOK)**: the caller key is injected into the sandbox as the environment variable the engine expects (for example `ANTHROPIC_API_KEY`). This needs BYOK extended from "kernel only" to "native agents in the sandbox". The owner can also designate a **dedicated low-quota key** for the sandbox, but note that the agent in the sandbox can read it |
| **Nested sandboxes**: on macOS Codex wraps the commands it runs in Seatbelt, and macOS generally does not allow `sandbox-exec` inside `sandbox-exec` | To be verified. If nesting really is impossible, turn off the CLI's own sandbox inside the outer one (for example Codex's full-access mode) and let the outer sandbox do the isolation |
| **The Claude Agent SDK starts the CLI process itself**, bypassing `ownedProcess` | To be verified. Options: point `pathToClaudeCodeExecutable` at a wrapper script that starts the real CLI inside srt, or use a custom spawn hook from the SDK (if there is one) |
| **Approvals**: a native agent asks for permission in the sandbox | The approval flow does not change; whatever is approved takes effect only within the sandbox |
| **Continuing a session**: native session state is kept in the CLI's configuration directory | That directory is saved with the session workspace; once the workspace is deleted by TTL, the session can no longer be continued |

### 4.1 S2 fact check (2026-11-08, read-only, no model called)

| Engine | Version on this machine | Config directory | API-key-only auth | Built-in sandbox | How to take over launch | Conclusion |
|---|---|---|---|---|---|---|
| Claude Code | 2.1.318, a single Mach-O binary | `CLAUDE_CONFIG_DIR` | In `--bare` mode it uses **only** `ANTHROPIC_API_KEY`, and reads neither OAuth nor the keychain | Off by default | The Agent SDK's `spawnClaudeCodeProcess` hook | **Do first in S2a** |
| Codex | 0.167.0, a `#!/usr/bin/env node` script | `CODEX_HOME` | To be tested (`OPENAI_API_KEY`) | Yes, overridden with `-s` / `-c sandbox_mode=…` | We start the app-server ourselves | **Do first in S2a**; auth method to be tested |
| Antigravity (agy) | 1.5.3 | Not documented in its help | Unknown | Optional `--sandbox` | We start it ourselves | **Deferred**, pending tests |
| DSH | 0.1.5-rc.1, a node script | `$DSH_HOME` | Unknown | — | We start it ourselves | **Deferred**, pending tests |

The design that follows from this:

- **The caller must always bring their own key.** A native agent in the sandbox can use only the caller's key (BYOK), which the worker injects into the environment variable the engine expects (`ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex). If a `sandbox`-level key calls a native agent without `X-OAA-Provider-Key`, submission returns 400 `provider_key_required`. A "sandbox-only key" paid for by the owner is left for later.
- **Configuration directory isolation.** Inside the sandbox, HOME and the configuration directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) both point to `.oaa-home/` in the session workspace, so the same session can be continued but can never read the owner's configuration. For Claude, `--bare` is added and `settingSources: []` is set.
- **How it is started**:
  - Claude: the SDK hook requires a process object to be returned synchronously, while srt's wrapping is asynchronous. So a proxy object bridged with pipes is returned first; once the wrapping finishes, the real process is started and connected to the pipes.
  - Codex: wait for the sandbox wrapping to finish, then start the app-server.
  - A CLI in the form of a node script is always started with the real node path plus the real path of the script. Symbolic links in `~/.local/bin` sit under the home directory, which is denied for reading, so they cannot be used directly.
- **Read-only directories**: the CLI's install directory. For a node package, the package root; for a single binary, the directory it lives in. A node script also needs the node runtime directory.
- **Outbound**: only the provider domains the owner configured in `sandbox.native.<engine>.providerDomains` are allowed. In S2a a publisher cannot add domains for a native agent.
- **Reporting the capability**: `native/<engine>` is reported only when all of these hold: the owner configured the engine, the engine is enabled, and the startup self-check passed (running `<cli> --version` in the sandbox).
- **The key is visible to the agent**: the key is injected as a plain-text environment variable, and the agent in the sandbox can read it. Since it is the caller's own key and outbound access is limited to the provider domains, the risk is manageable. Later this can be hardened with srt's `credentials.envVars` masking (which needs experimental TLS termination), so the agent sees only a placeholder.
- **Still to be tested** (needs srt to be started and real model calls): whether Codex can authenticate with `OPENAI_API_KEY` when `CODEX_HOME` is empty; whether the two CLIs need extra writable paths or mach services in srt; how nested Seatbelt behaves on macOS.

## 5. Implementation notes for the srt backend

- **Dependency**: the npm package `@anthropic-ai/sandbox-runtime`, pinned. Linux also needs `bubblewrap` (0.5 or later recommended), `socat`, and `ripgrep`.
- **Usage**: `SandboxManager.initialize(config)` starts an HTTP proxy and a SOCKS5 proxy on the host's localhost; `wrapWithSandbox(command)` returns the wrapped command, and then the process is started as usual.
- **Per-call allowlist**: set separately for each call with `registerCommandNetworkLists(commandId, { allowedDomains })`. Note: srt's documentation states plainly that the command ID is only an ownership tag and **not a security boundary**. So calls of different trust levels should ultimately be handled by **different SandboxManager instances** (or different processes), and must not share one set of proxies. The first phase is conservative: one instance is shared by only one caller subject at a time.
- **File rules**: srt's default is "allow all reads, deny all writes". You must explicitly `denyRead` home, the OAA data directory, `/Volumes`, and so on, and open up only the runtime directories with `allowRead`. We add a layer outside srt: the spec lists only the allowed paths, and everything else is denied by default.
- **Resource limits**: srt itself does not limit CPU or memory. On macOS use `setrlimit` (CPU time, address space, number of processes); on Linux use `prlimit` or cgroups. Exceeding the time limit is enforced by the existing `AbortSignal` and `terminateOwned`.
- **Startup self-check**: when the worker starts, it runs a set of probes in the sandbox: reading `~/.ssh` should fail, writing outside the workspace should fail, reaching a domain not on the allowlist should fail, reaching `127.0.0.1` should fail, and DNS for an allowlisted domain should resolve. Only when all behave as expected does it report the corresponding `kinds`.

## 6. Known limitations (to be stated honestly to the outside)

- srt is **process-level** isolation and shares the host's kernel, so a kernel vulnerability can break out of it. Its official status is **Beta research preview**, and the configuration format may change.
- Apple has marked macOS `sandbox-exec` as deprecated, but it still works.
- The domain allowlist depends on DNS: whoever controls the DNS of an allowlisted domain decides where it resolves.
- When truly opening up to strangers at scale, switch to gVisor on Linux, or run one micro-VM per run (Firecracker / Apple container). The interface already leaves room for this.

## 7. Phases and acceptance

**S1: interface + srt + script tools**
- `SandboxLauncher`, the srt backend, the `sandbox` execution level, `sandbox-v1` negotiation, the startup self-check.
- Acceptance (automated tests): a script in the sandbox cannot read `~/.ssh`; cannot write outside the workspace; reaching a domain not on the allowlist and `127.0.0.1:8787` both fail; reaching an allowlisted domain works; the environment contains only the allowed variables; exceeding the process count or CPU limit ends the process.

**S2: native agents in the sandbox**
- One adaptation per engine: isolated HOME, BYOK environment variable injection, provider domains, turning off the CLI's own sandbox, the session continuation directory.
- BYOK extended to native agents in the sandbox.
- Acceptance: run one real task per engine (**the operator must authorize the cost of real model calls**), and do one escape test: have the agent try to read the owner's `~/.claude` and similar directories, which must fail.

**S2a implementation notes (2026-11-08)**
- Implementation: `src/engines/native.ts` (`sandboxPlan`; Claude through the SDK's `spawnClaudeCodeProcess` plus a `DeferredProcess` bridge; Codex starts the app-server directly), `src/engines/sandbox.ts` (`cliLaunch`, `nativeSandboxProfiles`, the CLI probe in the startup self-check), `src/fabric/worker.ts` (`nativeSandbox`, rejecting tasks dispatched by mistake), `src/kernel/kernel.ts` (`provider_key_required`, the isolation marker and key for native tasks).
- Tests: `test/sandbox-native.test.ts`, 5 tests, opens no ports, uses protocol stand-ins.
- A defect fixed during implementation: for a CLI in script form, if no `package.json` was found nearby, the read-only scope used to widen to an ancestor directory more than 4 levels up. Now only the script's own directory is opened.

**S3 (once the platform is decided): the gVisor backend**, as production-grade isolation on Linux.

## 8. Things you need to confirm individually at implementation time

1. Downloading `@anthropic-ai/sandbox-runtime` from npm, pinning the version, and writing it into `package.json` and the lock file.
2. srt **listens on two proxy ports** (HTTP and SOCKS5) on the worker machine's localhost, including during tests.
3. The list of provider domains to allow for each native engine.
4. The real model calls in S2 (these incur cost).
5. Installing `bubblewrap`, `socat`, and `ripgrep` on a Linux server (once the platform is decided).

## References

- [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime): API, configuration format, limitations, Beta status
- [gVisor release notes](https://github.com/google/gvisor/releases/tag/release-20261005.0)
- [apple/container](https://github.com/apple/container): one lightweight VM per container, version 1.0 (2026-06)
