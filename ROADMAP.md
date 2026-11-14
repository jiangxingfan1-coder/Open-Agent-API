# Roadmap

English · [简体中文](ROADMAP.zh-CN.md)

This is the public roadmap of Open Agent API, written as of version 0.0.64 (2026-11-14). It is a statement of intent, not a promise: items can move, shrink or be dropped, and nothing here has a date. What is already done is in the [changelog](CHANGELOG.md); how far the existing features have actually been verified is at the end of this page.

## Now (next release)

- **Linux packages and a Docker image.** Today the installers are for macOS and Windows; on Linux you run from source. We want installable Linux packages and an official Docker image.
- **Install from an npm tarball.** A way to install and run the gateway from a package tarball without cloning the repository.
- **The full Windows test suite in CI.** The Windows job currently runs only the type check, the format check and the packaging tests, because many tests use POSIX-only constructs (see [docs/releasing.md](docs/releasing.md)). The goal is to run the whole suite there.
- **A security review and a threat model.** A written review of the gateway, and a [security model](docs/security-model.md) that states who can do what, what is exposed by default, and what is not defended.
- **A long-running soak test, the upgrade path and data retention.** Run the gateway for a long time under load, document how to upgrade between versions, and say what data is kept and for how long.
- **A compatibility lab for official SDKs and popular OpenAI-compatible clients.** A repeatable set of checks against the official SDKs and widely used clients, with their versions and results published. Until it exists, compatibility is established by the test suite and the SDK checks listed in [docs/protocol.md](docs/protocol.md), not by testing every client.
- **`oaa approvals`, `oaa status` and `oaa verify` in the CLI.** List and decide approvals, show the state of the gateway and its agents, and run a self-check against a real agent on your machine (see "How to help" below).
- **English-first documentation.** The documentation, the community files and the changelog are English first, with Chinese alongside (this is the change that introduced this page).

## Next

- **Webhooks for run events.** Notify an HTTP endpoint when a run needs approval, completes or fails, so a caller does not have to poll.
- **Enforced structured output.** `response_format: json_schema` is validated before the gateway answers 200; today it is passed to the agent as an output requirement and is not enforced.
- **Image input across the three protocols.** Inline images are currently rejected with `unsupported_content` on every compatibility endpoint, and files have to be uploaded first. We want image input that works the same way through the OpenAI, Claude and Gemini entries.
- **Letting developer-platform account keys call external agents through an explicit opt-in listing.** Today an account key can only be `workspace` or `sandbox` level and cannot call external agents. The idea is that an operator can list a specific external agent for developers on purpose, with the risks spelled out, instead of the platform being limited to built-in agents.

## Later

- **Presets for local and OpenAI-compatible model providers** (Ollama, LM Studio and others) for built-in agents, so that a built-in agent can run on a local model without hand-written configuration.
- **Prometheus metrics** for the gateway.
- **Notarized macOS builds.** The macOS app is currently ad-hoc signed and not notarized, so macOS asks users to open it manually the first time (see [docs/releasing.md](docs/releasing.md)).
- **English source comments throughout.** Many comments and test names in the source are still in Chinese; new code is written in English (see [CONTRIBUTING.md](CONTRIBUTING.md)), and the older code will be converted over time.

## Verification status

The details are in [docs/evidence.md](docs/evidence.md); the short version, kept deliberately cautious:

**What has been verified**

- **The offline test suite** (a local deterministic model, local protocol servers and subprocess fixtures). It proves the gateway's own behavior and its wire formats. It does **not** prove compatibility with real model providers, real cross-machine performance, or account access.
- **Real-agent end-to-end: Antigravity only.** The end-to-end acceptance script (`examples/live-agents-acceptance.ts`) has been run against a real Antigravity, with 12 real calls through the official OpenAI and Anthropic SDKs and plain HTTP. Most scenarios passed; the ones that could not be verified, and the one that failed (a leftover background process), are listed in the evidence file.
- **Approvals and caller tools** are exercised by tests against local stand-ins (a fake ACP agent and protocol-level fakes). In a manual session on 2026-11-11, caller-tool bridging also worked against real ACP agents (Antigravity and Qoder). The Antigravity engine used in the end-to-end run supports neither approvals nor bridging, so the end-to-end run does not cover them.

**What has not been verified**

- **Codex and Claude Code have not been run through the end-to-end script.** The manual session on 2026-11-11 recorded one managed call to Codex that worked and a Claude Code run that failed because its CLI was not signed in; the code has changed since then and neither was repeated.
- Built-in agents with a real model provider, public deployment behind a reverse proxy, calls across machines, and clients such as Cursor and Cline calling Open Agent API as a model have no real end-to-end record.
- Real agents on Linux (CI runs the offline suite on Ubuntu, but there is no real-agent record there), and the Windows package, which has never been run on a Windows machine through the release workflow.

## How to help

The most useful contribution is a real-world check on a machine with an agent installed:

- Once `oaa verify` lands, run it against an agent you have access to (Codex and Claude Code are the ones we are missing) and file the report as an issue, with the redacted output attached. It makes real calls, so it can cost money; read what it will do before you confirm.
- Until then, you can run `examples/live-agents-acceptance.ts` yourself as described in [docs/evidence.md](docs/evidence.md) and attach `report.md`. It contains no secrets, but read it before you post it.
- Tell us about a client or SDK that does not work, with the version, the request and the error code.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to file issues and pull requests.
