# Documentation map

English · [简体中文](zh-CN/README.md)

Find documents by "I want to…". Every document is available in English (this folder) and in Chinese (`zh-CN/`).

## I want to get started

- Install, initialize, start and open the console: [README, "Running in three minutes"](../README.md#running-in-three-minutes)
- Installation options (installers, Linux packages, Docker, npm tarball): [install.md](install.md)
- Running on Windows: [windows.md](windows.md)
- How to use each console page: [console.md](console.md)
- More details on starting locally (configuration file, running in the background): [operations.md, "Local start"](operations.md#local-start)

## I want to call an agent

- Call with the OpenAI SDK or `oaa/1`: [operations.md, "Publish and invoke"](operations.md#publish-and-invoke)
- Supported protocols and fields, file upload, streaming, approvals, resume, cancellation: [protocol.md, "Compatibility"](protocol.md#compatibility) and ["Execution and actions"](protocol.md#execution-and-actions)
- Parameters of the compatibility entries, error shapes, why 422 is not retried, and finish reasons (`finish_reason`, `stop_reason` and so on): [protocol.md, "Compatibility-endpoint parameters, errors and finish reasons"](protocol.md#compatibility-endpoint-parameters-errors-and-finish-reasons-060)
- Inspect routing before a call: [operations.md, "Inspect routing before execution"](operations.md#inspect-routing-before-execution)
- Switch automatically to another agent on failure, or hand a session over to another agent: [protocol.md, "Agent fallback on failure"](protocol.md#agent-fallback-on-failure-oaaagent_fallback-2026-11-10) and ["Agent handoff"](protocol.md#agent-handoff-handoff-2026-11-10)
- Call through MCP: [operations.md, "MCP and plugin entry"](operations.md#mcp-and-plugin-entry) and the [MCP skill description](../integrations/open-agent-api/SKILL.md)
- Which SDKs and frameworks were run live, which chat clients were replayed from their request shapes, how to configure each, which parameters are ignored or refused: [compatibility.md](compatibility.md)

## I want to publish an agent

- Write an agent in OAA-Lang: [language.md](language.md)
- Publish a JSON definition or an external agent: [operations.md, "Publish and invoke"](operations.md#publish-and-invoke)
- Import selected MCP tools: [operations.md, "Import selected MCP tools"](operations.md#import-selected-mcp-tools)
- Enable an installed agent in one step: [protocol.md, "One-step enablement of installed agents"](protocol.md#one-step-enablement-of-installed-agents-2026-11-10) and [operations.md, "Export an installed agent"](operations.md#export-an-installed-agent)

## I want to connect an external agent

- The access contract and the capability differences between ways of access: [adapters.md, "AgentAPI conversion contract"](adapters.md#agentapi-conversion-contract-2026-11-08)
- Write an `oaa/1` / `oaa/1-stream` adapter: [adapters.md, "The `oaa/1` final-result ABI"](adapters.md#the-oaa1-final-result-abi)
- ACP and A2A agents: [adapters.md, "ACP agents"](adapters.md#acp-agents-agent-client-protocol) and ["A2A remote agents"](adapters.md#a2a-remote-agents-2026-11-08)
- Which external agents are supported and where their limits are: [README, "Which agents can be connected"](../README.md#which-agents-can-be-connected)

## I want to be told when a run ends or needs approval

- Push run events (completed, failed, waiting for approval…) to your own HTTPS endpoint, signed, with retries; route approvals into your own system: [webhooks.md](webhooks.md)

## I want the caller's tools to take part

- The managed / bridge / reject modes and the support matrix: [harness.md](harness.md)
- How to use bridging: [harness.md, "Using bridge (kernel agents)"](harness.md#using-bridge-kernel-agents) and ["Responses, Claude Messages, and Gemini"](harness.md#responses-claude-messages-and-gemini)

## I want to deploy to the public internet or add more execution machines

- The public deployment runbook: [deploy-public.md](deploy-public.md)
- The public deployment design: [public-deployment.md](public-deployment.md)
- Who can do what, what is exposed by default, and what to do before exposing a gateway: [security-model.md](security-model.md)
- Sandboxed execution design: [sandbox-design.md](sandbox-design.md)
- Hand out access to developers through the developer platform: [deploy-public.md, "Distributing through the developer platform"](deploy-public.md#distributing-through-the-developer-platform)
- Connect a remote execution machine: [operations.md, "Workers"](operations.md#workers) and [protocol.md, "Node wire protocol"](protocol.md#node-wire-protocol)
- Soak testing, the upgrade path and data retention: [stability.md](stability.md)

## I want to open my agents to developers for self-service use

- Positioning, enabling, the operator and developer flows, and the endpoints: [platform.md](platform.md)
- Billing rules (how per-task and per-token charges settle): [platform.md, "Billing rules"](platform.md#billing-rules)
- The endpoint overview and error codes: [platform.md, "Endpoint overview"](platform.md#endpoint-overview) and [platform.md, "Error codes"](platform.md#error-codes)
- Connect your own payments (the `billing` key, de-duplication by external reference): [platform.md, "Connect your own payments"](platform.md#connect-your-own-payments)
- Security notes and limits: [platform.md, "Security notes"](platform.md#security-notes) and [platform.md, "Limits"](platform.md#limits)
- A short introduction: [README, "Offer it as a developer platform"](../README.md#offer-it-as-a-developer-platform)

## I want to understand the architecture

- The architecture and its rationale: [architecture.md](architecture.md)
- The run state machine: [architecture.md, 3.2](architecture.md#32-run-state-machine)
- What the tests and benchmarks prove and what they do not: [architecture.md, section 10](architecture.md#10-evidence-and-performance) and the [paired benchmark](../bench/paired/README.md)
- Which real agents were integration tested, with the results and what was not verified: [evidence.md](evidence.md)
- How the gateway defends itself and where it does not: [security-model.md](security-model.md)
- What changed between versions: [CHANGELOG.md](../CHANGELOG.md)
- What is planned next, and what is verified and what is not: [ROADMAP.md](../ROADMAP.md)
- Stability, the upgrade path and data retention: [stability.md](stability.md)

## I want to contribute

- Engineering conventions (commands, layers, coding conventions, commit format, compatibility red lines): [engineering.md](engineering.md)
- How to add an error code or an event: [engineering.md, section 4](engineering.md#4-how-to-add-an-error-code--event)
- Verification commands: [operations.md, "Verification"](operations.md#verification)
- How to cut a release: [releasing.md](releasing.md)
- The contribution process and community conventions: [CONTRIBUTING.md](../CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md); to report a security problem: [SECURITY.md](../SECURITY.md)
- The brand mark and its rules: [brand/README.md](brand/README.md) (Chinese only for now)

## I want to troubleshoot an error

- The error-code table: [protocol.md, "Error codes"](protocol.md#error-codes-errorcode); at run time you can also read `GET /v1/errors`
- The error shapes and retry headers of each compatibility protocol: [protocol.md, "Compatibility-endpoint parameters, errors and finish reasons"](protocol.md#compatibility-endpoint-parameters-errors-and-finish-reasons-060)
- View and recover requests, and what to do with writes whose outcome is unknown: [operations.md, "Inspect and recover work"](operations.md#inspect-and-recover-work)
- Why a request is slow or still waiting: [protocol.md, "Observable kernel"](protocol.md#observable-kernel-run-timeline-activity-pulse-queueing-and-capability-negotiation) and [console.md](console.md)
- Windows-specific problems: [windows.md](windows.md)
