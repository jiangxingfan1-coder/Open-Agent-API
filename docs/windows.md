# Open Agent API on Windows

This page describes how Open Agent API (OAA) behaves on Windows 10/11 and Windows Server, how it
differs from macOS and Linux, and what is known not to work. The full test suite runs on
`windows-latest` in `.github/workflows/windows.yml`; tests that only make sense on POSIX are
skipped there with a stated reason.

## Install

- **Release zip** (`Open-Agent-API-<version>-win-x64.zip`): unzip, then run `oaa.cmd quickstart`
  from that folder in Command Prompt or PowerShell. The zip bundles the Node runtime; nothing else
  is needed. The packages are not code-signed, so SmartScreen may warn on first run.
- **From source**: install Node.js 24, then `npm ci`, `npm run build`, `node dist/src/cli.js
  quickstart`.

Data and logs of the desktop launcher live in `%LOCALAPPDATA%\OpenAgentAPI`. A gateway started with
`oaa serve --detach` writes `server.log` and `server.pid` into its data directory.

## Connecting installed agents

Agents installed with npm on Windows are `.cmd` launchers (`codex.cmd`, `claude.cmd`,
`gemini.cmd`, ...). OAA handles them as follows:

- **Discovery** (`oaa init`, `oaa quickstart`, `oaa connect`, `oaa doctor`, ACP presets) resolves a
  bare name through `PATH` and `PATHEXT` the way `where` does, and records the full path including
  the extension, for example `C:\Users\me\AppData\Roaming\npm\codex.cmd`.
- **npm launchers** (`cmd-shim`) are not run through `cmd.exe` at all: OAA reads the JavaScript entry
  point from the launcher and starts it with node directly, so arguments reach the agent unchanged.
- **Other `.cmd` / `.bat` files** are started with `cmd.exe /d /s /c`, every argument quoted for the
  Windows argument parser and caret-escaped twice (for `cmd.exe` and for the batch file's `%*`), so
  `&`, `|`, `%VAR%`, `!VAR!`, quotes and spaces in caller input are passed as text and never run as
  commands. Arguments containing line breaks cannot be passed through `cmd.exe` safely; OAA refuses
  them with `invalid_request` instead of truncating. This affects the DSH engine (its prompt is an
  argument) only when DSH is installed as a plain batch file.
- **`.exe`** files and `.js` / `.mjs` / `.cjs` scripts are started directly (scripts through node).
- The Claude Agent SDK starts the Claude Code CLI itself; OAA passes it the npm launcher's
  JavaScript entry point (or `claude.exe`) instead of `claude.cmd`.

## Stopping processes

Windows has no SIGTERM for console programs, and killing a `.cmd` launcher leaves the program it
started running. OAA therefore ends an agent's whole process tree with `taskkill /pid <pid> /T /F`
on cancel, timeout and gateway shutdown. This is a hard stop: the agent gets no chance to clean up.

`oaa stop` first asks the detached gateway to close itself through `POST /v1/gateway/shutdown`
(owner-wide admin key, accepted only from a loopback address), waits for it to drain requests and
close the database, and only falls back to terminating the process if it is still running after
ten seconds. Before signalling, `oaa stop` checks that the gateway answering on the configured
port reports the recorded pid, so a reused pid is never killed.

The database is SQLite in WAL mode with `synchronous=FULL`; a hard stop loses at most a request in
flight, not committed data.

`Ctrl+C` in a console running `oaa serve` closes the gateway cleanly (Node maps it to SIGINT).

## Files and permissions

- Mode bits such as `0600` are ignored on Windows. When OAA writes a private file (`admin.token`,
  caller keys, `server.pid`) it additionally runs `icacls <file> /inheritance:r /grant:r
  <DOMAIN>\<user>:F` so only the current user can read it. This is best effort: if `icacls` fails,
  the file keeps the ACL of its folder. Keep the data directory inside your user profile (the
  default) so that folder ACL is already private.
- Relative file names that Windows treats specially are rejected (`invalid_path`): names with `:`
  (alternate data streams), reserved device names (`CON`, `NUL`, `COM1`, ...), and names ending in
  a dot or space.
- Paths with spaces and non-ASCII user names (`C:\Users\名字 带空格\`) are supported.
- Caller-tool relays use a named pipe (`\\.\pipe\oaa-relay-<random>`) instead of a Unix socket;
  every connection must present the per-run token from a file in the run's private directory.

## Sandbox

The OS sandbox for native agents (`@anthropic-ai/sandbox-runtime`) supports macOS and Linux only.
On Windows a sandboxed run fails with `sandbox_unavailable`; it never runs unsandboxed silently.

## Console output

Node writes Unicode to the Windows console directly, so Chinese output displays correctly in
Windows Terminal, PowerShell and Command Prompt without `chcp 65001`. When output is redirected to a
file it is UTF-8. The `.cmd` launchers in the release zip contain only ASCII.

## Known limitations

- No sandbox (see above).
- Agent processes are always stopped forcibly (`taskkill /F`).
- Line breaks cannot be passed as command-line arguments to non-npm batch-file launchers.
- The release packages are unsigned.
- Behaviour has been verified by the automated test suite on GitHub's Windows runners, not by
  manual use with real Codex, Claude Code or Antigravity installations on Windows.
