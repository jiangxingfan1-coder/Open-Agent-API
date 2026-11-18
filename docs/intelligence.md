# Intelligent Agent API

English · [简体中文](zh-CN/intelligence.md)

## Implemented In This Increment

The implementation continued beyond this initial increment. [Persistent Agent Workstation](workstation.md) documents project memory, durable checkpoints, visual/reusable workflows and triggers, media jobs, real-task feedback, public JSON facts and cross-platform desktop builds.

- New `/v1/agents/publish-native` publications default to automatic approval. Existing publications keep their explicit policy; signed bundle publication does not rewrite its manifest. Use `approvals: "ask"` or an explicit `access.approval` to request human approval. Host authority and key restrictions still apply. Antigravity uses its ACP approval bridge when available, otherwise its per-invocation automatic-permission flag; no global agent settings change.
- New native orchestration publications default to `scope: "agent"`. Fixed models bypass orchestration; automatic modes call a planner even for short tasks. Planning, analysis and review stay within the selected agent's model pool. Legacy publications keep their previous shortcut behavior.
- `X-OAA-Orchestration: recommend` or `metadata["oaa.orchestration_action"]: "recommend"` runs the planner but not its execution stages. The response text is JSON containing `agent`, `mode`, `stages` and `executed: false`. Use `execute` or omit the field for normal execution. Recommendation requires automatic selection and an orchestration-enabled publication. It is not a permission approval.
- Model evaluations have a console dialog, private SQLite records, revision-checked settings, a daily call cap, and a single background lane. Changes to a local executable, its configuration, the published agent or model catalog invalidate earlier measurements. Four measured dimensions are available: arithmetic reasoning, code tracing, instruction following and structured data. These small generated samples are not a general intelligence benchmark or proof of tool proficiency.
- Measured scores and latency contribute to routing after four scored samples. Transport/authentication failures are recorded separately from wrong answers. Evidence expires after seven days. Model names never determine measured strength.
- Fresh, unambiguous account-quota snapshots can exclude automatic routes. Unknown/stale snapshots do not block execution. A zero API-credit balance does not disable a subscription with usable quota windows. Multiple accounts without an explicit runtime identity mapping are not used for automatic exclusion. Fixed selection never silently changes models.
- A local EverythingACP `client.json` can be imported from the execution-machines page or API. The descriptor is stored disabled until enabled and published. It survives restart without modifying or copying the wrapper. Environment secrets are not imported. The conversion core remains owned by the separate EverythingACP project.

## API Examples

Publish using a model returned by discovery, rather than guessing a provider model identifier:

```json
{
  "id": "agent/my-agent",
  "engine": "antigravity",
  "models": ["MODEL_FROM_DISCOVERY"],
  "model_policy": {"mode": "discover", "allow": ["MODEL_FROM_DISCOVERY"]},
  "access": {"modes": ["managed"], "defaultMode": "managed", "approval": "auto", "trust": "private"},
  "orchestration": {"enabled": true, "scope": "agent"}
}
```

The existing compatible endpoints accept `agent/my-agent@<route>` for a fixed model, `agent/my-agent@fast`, `@best`, `@eco`, or `agent/my-agent` for automatic selection. A recommendation request is:

```json
{
  "model": "agent/my-agent@best",
  "input": "Plan the requested task",
  "metadata": {"oaa.orchestration_action": "recommend"}
}
```

Local management endpoints require a directly connected, same-origin, owner-wide administrator in the local security profile:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/local/evaluations?agent=...` | Settings, `settings_revision`, support status, scores and latest errors |
| `POST /v1/local/evaluations/settings` | `{agent, revision, settings:{enabled, intervalHours, maxCallsPerDay}}` |
| `POST /v1/local/evaluations/run` | `{agent}` schedules work within the enabled daily budget |
| `POST /v1/local/everything-acp/import` | `{id, client_file}` imports an absolute `client.json` path on the gateway machine |

The agent sheet's **API Execution Policy** dialog migrates an existing publication explicitly. Its `POST /v1/agents/policy` call takes `{agent, version, approval:"ask"|"auto", orchestration:boolean}` and creates a new immutable version while preserving the remaining definition and bundle files. It rejects stale versions. Kernel definitions without an access policy must still be edited explicitly because their approvals are declared per tool.

Evaluation defaults are disabled, every 24 hours, at most 48 sample calls per day per published agent; each cycle has eight questions per model. Enabling it explicitly authorizes these calls. User work takes priority between questions. No public web lookup or private task transcript is sent to an evaluator.

## Verification And Remaining Work

On 2026-11-17 in an isolated macOS gateway, a real Codex and a real Antigravity returned the requested fixed response; Claude Code returned `adapter_auth_required` because its CLI was not signed in. A separately generated EverythingACP Codex wrapper completed a real call through OAA. Antigravity completed fixed, recommendation-only, speed and quality scenarios using two discovered model choices. These small tasks prove those paths, not superior speed or quality: the measured fixed call took about 10 seconds, recommendation about 61 seconds, speed about 83 seconds, and quality about 96 seconds. The quality check was an agent review, not independent correctness evidence.

A partial real evaluation exposed an important scoring distinction: code answers were correct but wrapped in Markdown despite the JSON-only instruction. The updated suite tolerates fences for reasoning/code correctness, but keeps instruction and structured-output scoring strict. The revised eight-question suite subsequently completed on Antigravity's current default model with eight passes, averaging about 40 seconds per question. This is one small capability sample, not a comparison against other models; its temporary evaluation setting was restored to disabled.

A further real Antigravity call created `outputs/proof.txt` without an OAA approval stop. The downloaded file matched `OAA_ARTIFACT_OK` exactly, with no pending action. This verifies one real artifact flow, not arbitrary filesystem task reliability.

The native Codex path also completed an automatically approved file-writing call: the downloaded `codex-proof.txt` matched `OAA_CODEX_AUTO_OK` exactly. Neither probe changed the installed desktop application's configuration.

Codex and general ACP adapters now support enforced tool-free reasoning turns (`toolsDisabled`), and opaque external engines can also bind an authorized `orchestration.planner` agent (`plan` / `review` routed to the planner while `execute` stays on the primary agent) or run multi-agent `scope: "helpers"` pipelines with structured handoffs and a 5th `tool_calling` evaluation dimension; streaming artifacts scale up to `64 MiB` by default (configurable up to `256 MiB`). Generated EverythingACP wrappers can also be discovered in an explicitly selected output directory without a brand allowlist or execution. Remaining limits include broad independent model-quality evaluation, general web search beyond configured JSON sources, recovery of unconfirmed host effects, and Windows/Linux physical-device acceptance. No all-agent, comprehensive-intelligence, codec-quality or production-release claim is made.
