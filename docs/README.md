# Documentation Map

English · [简体中文](zh-CN/README.md)

Welcome to the Open Agent API documentation. If you are setting up your first gateway, start with the **[Five-Minute Quickstart](quickstart.md)** and the copy-and-run **[Cookbook](../examples/cookbook/README.md)**.

---

## Getting started

- **End-to-end walkthrough (publish an agent → issue a key → call via SDK)**: [quickstart.md](quickstart.md) (or see [README, "Running in three minutes"](../README.md#running-in-three-minutes))
- Platform installers & clean uninstall steps (macOS / Windows / Linux desktop app, Linux one-liner, Docker, npm tarball): [install.md](install.md)
- Tour of the web console (Overview, `#workbench`, Run Inspector timeline, Webhooks, and Developer Platform): [console.md](console.md)
- CLI command reference grouped by task (gateway lifecycle, connecting agents, terminal approvals, keys, live verification): [cli.md](cli.md)
- Running on Windows: [windows.md](windows.md)
- Local configuration files and background daemon details: [operations.md, "Local start"](operations.md#local-start)

## Calling agents & orchestrating work

- **Copy-and-run code recipes** (cURL plus Python & Node examples for OpenAI, Anthropic, and Gemini SDKs): [Cookbook](../examples/cookbook/README.md)
- Smart model routing (`@fast` / `@best` / `@eco`), plan-only `recommend` mode, multi-agent pipelines, and local evaluations: [Intelligent Agent API](intelligence.md)
- Shared project memory (SQLite FTS5), durable runs, visual DAG workflows (Cron & Webhook triggers), and streaming media artifacts: [Persistent Agent Workstation](workstation.md)
- One-click wiring into local IDEs and clients (API providers for OpenCode / Codex / DSH and MCP bridges for Cursor / Windsurf / Claude Desktop / Claude Code): [Local Connections](local-connections.md)
- Token usage tracking, per-key budgets, and upstream quota snapshots: [Usage & Quotas](usage-monitor.md)
- Invoking via the OpenAI SDK, native `oaa/1`, and cross-agent handoffs: [operations.md, "Publish and invoke"](operations.md#publish-and-invoke)
- Wire protocol reference, file uploads, streaming events, approvals, resume, and cancellation: [protocol.md, "Compatibility"](protocol.md#compatibility) and ["Execution and actions"](protocol.md#execution-and-actions)
- Guaranteed JSON Schema structured output (native pushdown, bounded repair turns, and failure contracts): [structured-output.md](structured-output.md)
- Sending screenshots and local images across protocols: [images.md](images.md)
- Streaming live execution-phase progress in reasoning blocks: [progress.md](progress.md)
- Letting agents call functions in your own application (`auto` / `managed` / `bridge` / `reject` dual-layer tool bridging): [Dual-Layer Harness](harness.md)
- Live SDK compatibility lab & configuration guide for popular chat/IDE clients (Open WebUI, Dify, n8n, Continue, Cline, Zed): [compatibility.md](compatibility.md)
- Exposing agents over MCP: [operations.md, "MCP and plugin entry"](operations.md#mcp-and-plugin-entry) and [MCP skill guide](../integrations/open-agent-api/SKILL.md)

## Publishing & connecting agents

- Authoring built-in agents and typed flows in OAA-Lang: [language.md](language.md)
- Connecting local LLM runners (Ollama, LM Studio, vLLM) or cloud model providers: [models.md](models.md)
- Connecting local CLI agents, ACP presets, remote A2A nodes, or custom `oaa/1` adapters: [Connecting External Agents](adapters.md)
- Importing selected external MCP tools into built-in agents: [operations.md, "Import selected MCP tools"](operations.md#import-selected-mcp-tools)

## Notifications & webhooks

- Pushing HMAC-SHA256 signed run events (completed, failed, awaiting approval) to your HTTPS endpoints with durable retries: [webhooks.md](webhooks.md)

## Deployment, security & team distribution

- Self-service developer portal (tenant-isolated accounts, self-serve keys, upfront credit reservation, and hybrid metering): [Developer Platform](platform.md)
- Reverse proxy, TLS, allowed hosts, and production checklist: [Public Deployment Runbook](deploy-public.md) and [Public Deployment Design](public-deployment.md)
- Permission boundaries, key scopes, and threat model: [Security Model](security-model.md)
- POSIX multi-slot `srt` sandboxing architecture: [Sandboxed Execution Design](sandbox-design.md)
- Joining remote execution machines (Workers): [operations.md, "Workers"](operations.md#workers)
- Soak stability records, upgrade path, and retention cleanup (`oaa prune`): [Stability & Retention](stability.md)

## Architecture, evidence & contributing

- Layered architecture and persistent run state machine: [architecture.md](architecture.md)
- Dated end-to-end verification records against live agents (Qoder, Antigravity, Codex) and [paired benchmarks](../bench/paired/README.md): [Verification Evidence](evidence.md)
- Code conventions, layer ratchets, and how to add error codes or events: [Engineering Conventions](engineering.md)
- Desktop packaging and release runbook: [Releasing](releasing.md)
- Release history and roadmap: [CHANGELOG.md](../CHANGELOG.md) and [ROADMAP.md](../ROADMAP.md)
- Contributing, code of conduct, and security reporting: [CONTRIBUTING.md](../CONTRIBUTING.md), [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md), and [SECURITY.md](../SECURITY.md)
- Brand assets and usage guidelines: [brand/README.md](brand/README.md) (Chinese only for now)

## Troubleshooting

- Complete error-code and HTTP status catalog (also served live at `GET /v1/errors`): [protocol.md, "Error codes"](protocol.md#error-codes-errorcode)
- Per-protocol error envelopes and retry headers: [protocol.md, "Compatibility-endpoint parameters, errors and finish reasons"](protocol.md#compatibility-endpoint-parameters-errors-and-finish-reasons-060)
- Inspecting stalled runs and safely recovering interrupted writes: [operations.md, "Inspect and recover work"](operations.md#inspect-and-recover-work)
