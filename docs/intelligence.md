# Smart Routing, Multi-Agent Orchestration & Model Evaluation

English · [简体中文](zh-CN/intelligence.md)

Once an agent is published as an API, callers can either pin a specific model route or let the gateway select routes dynamically based on **latency, quality, cost, live quota windows, and local evaluation scores**—or coordinate multi-stage pipelines across helper agents.

---

## Routing Selectors at Call Time

Across OpenAI, Claude, Gemini, and native endpoints, the `model` field accepts intuitive routing suffixes:

| `model` Value | Behavior |
| --- | --- |
| `agent/coder` (or `@auto`) | **Automatic routing**: balances configured route priority, recent latency, cooldown state, and local evaluation scores |
| `agent/coder@fast` | **Latency-first**: prefers healthy routes with the lowest measured response time |
| `agent/coder@best` | **Quality-first**: prefers top-scoring routes and, when orchestration is enabled, runs planning and review stages |
| `agent/coder@eco` | **Cost-first**: prefers lower-cost routes or subscriptions with ample remaining quota |
| `agent/coder@<route-id>` | **Pinned route**: targets a declared or discovered model directly, bypassing orchestration and never substituting another model |

### Plan-Only Mode (`recommend`)

To inspect how the gateway plans to decompose a task and which routes it would pick—without executing any tools—set `recommend` in request metadata:

```json
{
  "model": "agent/coder@best",
  "input": "Refactor the order export endpoint and add concurrency regression tests",
  "metadata": {
    "oaa.orchestration_action": "recommend"
  }
}
```

You can also pass the `X-OAA-Orchestration: recommend` header or check **Recommend plan only** in `#workbench`. The gateway runs a tool-free planning turn (`toolsDisabled`) and returns structured JSON containing `agent`, `mode`, `stages`, and `executed: false`.

---

## Universal Orchestration & Multi-Agent Pipelines

Orchestration works across built-in kernel agents as well as external engines such as Codex, Antigravity, and ACP presets:

1. **Single-agent model pool (`scope: "agent"`)**: Splits `plan`, `execute`, and `review` stages across the published agent's own discovered or configured model routes.
2. **Dedicated planner agent (`orchestration.planner`)**: Binds an authorized planner agent to handle tool-free `plan` and `review` turns while keeping `execute` on the primary external engine.
3. **Multi-agent helper pipelines (`scope: "helpers"`)**: Chains authorized `helpers` agents across stages, passing context and file deliverables via structured `handoff` envelopes.

### Publication Example (Live Discovery + Orchestration)

```json
{
  "id": "agent/my-agent",
  "engine": "antigravity",
  "models": ["default"],
  "model_policy": { "mode": "discover" },
  "access": {
    "modes": ["managed"],
    "defaultMode": "managed",
    "approval": "ask",
    "trust": "private"
  },
  "orchestration": {
    "enabled": true,
    "scope": "agent"
  }
}
```

Existing publications can be updated in place from the agent detail sheet's **API Execution Policy** dialog (`POST /v1/agents/policy`), which creates a new immutable version with updated `approval` (`ask` / `auto`) or `orchestration` settings.

---

## Five-Dimension Local Evaluation & Quota Awareness

Instead of guessing model capability from marketing names, the gateway includes an opt-in local evaluator and quota-aware router:

- **Five scored dimensions**: Arithmetic reasoning, code tracing, instruction following, strict structured data, and `tool_calling`.
- **Bounded background budget**: Disabled by default. When enabled, runs at most once every 24 hours (capped at 48 sample calls/day per agent, always yielding to live user requests). Scores and latency enter routing weights once 4 valid samples are recorded, and expire automatically after 7 days or when agent configuration changes.
- **Operator feedback & public metadata**: Admins can record pass/fail feedback on real runs via `POST /v1/local/evaluations/feedback` at zero token cost, and map context-window or pricing fields from public HTTPS JSON catalogs.
- **Live quota avoidance**: When unambiguous upstream quota snapshots indicate an exhausted window (see [Usage & Quotas](usage-monitor.md)), automatic routing steers around the depleted route while leaving pinned `@<route-id>` calls untouched.

---

## Importing EverythingACP Wrappers

If you wrap local CLIs with [EverythingACP](https://agentclientprotocol.com), you can scan an output directory from **Execution machines** in the console or import a `client.json` descriptor via the local management API:

| Local Management Endpoint | Purpose |
| --- | --- |
| `GET /v1/local/evaluations?agent=...` | Reads evaluation settings, support status, dimension scores, and recent errors |
| `POST /v1/local/evaluations/settings` | Updates `{agent, revision, settings: {enabled, intervalHours, maxCallsPerDay}}` |
| `POST /v1/local/evaluations/run` | Queues an evaluation pass within the configured daily call cap |
| `POST /v1/local/evaluations/feedback` | Records operator `{run_id, passed}` feedback on a completed run |
| `POST /v1/local/everything-acp/import` | Imports a local EverythingACP `client.json` descriptor (stored disabled until explicitly enabled and published) |
