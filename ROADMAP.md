# Roadmap

English · [简体中文](ROADMAP.zh-CN.md)

This is the public roadmap of Open Agent API, written as of version 0.0.65 (2026-11-14). It is a statement of intent, not a promise: items can move, shrink or be dropped, and nothing here has a date. What is already done is in the [changelog](CHANGELOG.md); how far the existing features have actually been verified is at the end of this page.

## Shipped in 0.0.65

- Installing on Linux (x64 and arm64 packages and `install.sh`), in Docker, and from an npm tarball; Node.js 24 and 26.
- The whole test suite on Windows in CI, and the Windows behavior in [docs/windows.md](docs/windows.md).
- A security review with its fixes, the [security model](docs/security-model.md), and the optional `security.profile`.
- A compatibility lab for the official SDKs, frameworks and popular chat clients ([docs/compatibility.md](docs/compatibility.md)).
- `oaa approvals`, `oaa approve`, `oaa deny`, `oaa status`, `oaa verify` and `oaa webhook` in the command line ([docs/cli.md](docs/cli.md)).
- Run-event webhooks ([docs/webhooks.md](docs/webhooks.md)), enforced structured output ([docs/structured-output.md](docs/structured-output.md)) and image input on every entry ([docs/images.md](docs/images.md)).
- Developer-platform listings that let platform accounts call a chosen external agent, with billing that no longer overdraws.
- English-first documentation.

## Next

- **A long-running soak test, the upgrade path and data retention.** Run the gateway for a long time under load, document how to upgrade between versions, and say what data is kept and for how long. This is in progress and is not part of 0.0.65 yet.
- **Native structured output.** Today the gateway validates the answer and asks the agent to correct it, but the schema is not passed to the model provider's own structured-output feature (`response_format` of OpenAI, `output_config.format` of Anthropic, `responseSchema` of Gemini). Passing it would raise the share of answers that are right the first time. It needs per-provider handling and must not make a provider reject a request it accepts today.
- **Forced tool choice.** `tool_choice` set to `required`, or to a named function, is refused on OpenAI's default endpoints and ignored elsewhere, because neither the gateway nor the upstream model can honor it. Callers that get structure through a forced tool call are not served for the same reason.
- **Real Codex and Claude Code, end to end.** Neither has been run through the acceptance scenarios, and image delivery to both is implemented from documentation only. This needs people who have them installed: see "How to help" below.
- **The desktop app's graphical interface.** Five things were checked by hand on one Apple silicon Mac. Still to check: the messages for a port that is in use, switching the system language in both directions, restarting with the same data folder, recovering a gateway left by a crashed app, the Intel package, the normal installation on the default port, and the bilingual messages of the Windows launcher.
- **Sign-up that does not leak and login failures that persist.** The developer platform has no email verification, so sign-up answers `email_taken` for a registered address, and login failure counters live in memory and reset on restart. Both are listed as not defended in the [security model](docs/security-model.md).

## Later

- **Presets for local and OpenAI-compatible model providers** (Ollama, LM Studio and others) for built-in agents, so that a built-in agent can run on a local model without hand-written configuration.
- **Exporting run metrics** (for example in the Prometheus format) from the gateway.
- **Notarized macOS builds.** The macOS app is currently ad-hoc signed and not notarized, so macOS asks users to open it manually the first time (see [docs/releasing.md](docs/releasing.md)).
- **Real agents on Windows and Linux.** CI covers both with stand-ins; a record with real Codex, Claude Code or Antigravity on those systems does not exist.
- **English source comments throughout.** Many comments and test names in the source are still in Chinese; new code is written in English (see [CONTRIBUTING.md](CONTRIBUTING.md)), and the older code will be converted over time.

## Verification status

The details are in [docs/evidence.md](docs/evidence.md); the short version, kept deliberately cautious:

**What has been verified**

- **The offline test suite** (a local deterministic model, local protocol servers and stand-in agents), run in CI on Linux, macOS and Windows, and on Node 24 and 26. It proves the gateway's own behavior and its wire formats. It does **not** prove compatibility with real model providers, real agents, real cross-machine performance, or account access.
- **The compatibility lab**: the official SDKs and several frameworks run against an isolated gateway with a sample agent, and the recorded requests of a dozen chat clients are replayed. No real model or agent is involved, and Cursor is unverified.
- **Real-agent end-to-end: Antigravity only.** The acceptance script (`examples/live-agents-acceptance.ts`) was run once against a real Antigravity, with 12 real calls. Most scenarios passed; the ones that could not be verified, and the one that failed (a leftover background process), are listed in the evidence file.
- **Approvals and caller tools** are exercised by tests against stand-ins. In a manual session on 2026-11-11, caller-tool bridging also worked against real ACP agents (Antigravity and Qoder).
- **The Docker image** builds and its container passes a smoke test in CI (amd64).
- **The macOS app, by hand, once**: it opens already connected, shows the first-launch note, stays connected after a reload, shows the right version, and follows the system language, on an Apple silicon Mac in an isolated run.

**What has not been verified**

- **Codex and Claude Code have not been run through the acceptance scenarios.** The manual session on 2026-11-11 recorded one managed call to Codex that worked and a Claude Code run that failed because its CLI was not signed in; the code has changed since then and neither was repeated. Image delivery to both is not verified.
- Built-in agents with a real model provider, public deployment behind a reverse proxy, calls across machines, webhook delivery to a public HTTPS endpoint, and clients such as Cursor and Cline calling Open Agent API as a model have no real end-to-end record.
- Real agents on Windows and Linux; the Linux packages, `install.sh`, the npm tarball and the multi-architecture image, which have not yet been through the release workflow.
- The desktop app items listed under "Next".

## How to help

The most useful contribution is a real-world check on a machine with an agent installed:

- Run `oaa verify codex` (or `claude`, `agy`, an ACP agent you use) to see the plan, which starts nothing. Codex and Claude Code are the ones we are missing. If you are happy with it, add `--confirm-live-cost`: it makes real calls with the agent's own sign-in, so it can cost money, and it runs on an isolated gateway and leaves your own data alone. Read the scrubbed `report.md`, then file it with the "Agent verification report" issue template.
- Tell us about a client or SDK that does not work, with the version, the request and the error code.
- Try the desktop app, the Linux package or the Docker image and tell us what broke.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to file issues and pull requests.
