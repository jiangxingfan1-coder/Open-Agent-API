# Workstation: Project Memory, Durable Runs & Workflows

English · [简体中文](zh-CN/workstation.md)

Beyond serving single-turn agent calls, Open Agent API provides cross-session **shared project memory**, crash-resilient **durable runs**, **reusable DAG workflows** with Cron and inbound Webhook triggers, **streaming media artifacts**, and a unified **cross-platform Electron desktop app**.

---

## Projects & Shared Memory (SQLite FTS5)

The **Projects** view in the console lets multiple sessions and agents share structured context while keeping caller-private memory strictly isolated:

- **Subject-level access control**: An owner-admin creates a project and grants `read`, `write`, or `none` permissions per caller subject (defaulting to the API key ID).
- **Zero-dependency BM25 search**: Powered by embedded SQLite FTS5. Built-in kernel agents with `memory_read` / `memory_write` / `memory_search` tools can pass `scope: "project"` to read and write shared entries; external agents running inside a project automatically receive a bounded reference snapshot ranked by BM25 relevance to the current prompt.
- **Selecting a project**: Pass `metadata["oaa.project"] = "<project-id>"` on any compatible endpoint (or choose the project in `#workbench`). Set `metadata["oaa.project.remember"] = "false"` on a call to skip recording its final output summary.

| Project & Memory Endpoint | Operation |
| --- | --- |
| `GET /v1/projects` | Lists projects visible to the current key |
| `POST /v1/projects` | Creates `{id, name}` (owner-admin) |
| `GET /v1/projects/{id}/members` | Lists member access grants |
| `POST /v1/projects/{id}/members` | Sets `{subject, access: "read" \| "write" \| "none"}` |
| `GET /v1/projects/{id}/memory` | Reads shared memory entries |
| `GET /v1/projects/{id}/memory/search` | Runs BM25 full-text search (`?q=...&namespace=...&limit=...`) |
| `PUT /v1/projects/{id}/memory` | Creates or updates `{namespace, key, value, revision?}` |
| `DELETE /v1/projects/{id}/memory` | Deletes `{namespace, key, revision}` with optimistic concurrency |

---

## Durable Runs

Long-running engineering or research jobs run as persistent state machines rather than fragile HTTP transactions:

- **Client-disconnect resilience**: Dropping an HTTP stream or closing the desktop window never aborts accepted work running on the gateway.
- **Checkpoints & bounded recovery**: Set `metadata["oaa.durable"] = "true"` to enable bounded recovery (`oaa.max_resume_attempts` defaults to 10, up to 100; task ceilings scale up to 168 hours via **API Execution Policy**). Across gateway restarts, completed checkpoints are reused; if a run was interrupted mid-flight during an unconfirmed host write, it pauses for explicit operator review rather than blindly replaying side effects.

---

## Reusable Workflows (Visual DAG · Cron · Webhooks)

In the **Workflows** view, you can chain multiple agents into repeatable pipelines using the visual stage graph, JSON editor, or tool-free natural-language drafter:

```json
{
  "definition": {
    "id": "report-review",
    "name": "Weekly Report & Review",
    "graph": {
      "steps": [
        { "id": "write", "tool": "agent/writer", "arguments": { "input": { "$ref": "input#/task" } } },
        { "id": "review", "tool": "agent/reviewer", "arguments": { "input": { "$ref": "write#/output" } }, "depends_on": ["write"] }
      ],
      "output": { "$ref": "review#/output" }
    },
    "trigger": { "kind": "cron", "expression": "0 9 * * 1", "timezone": "America/Los_Angeles" },
    "enabled": true
  },
  "revision": "new"
}
```

### Trigger Modes

1. **Manual & API**: Run anytime from the console or via `POST /v1/workflows/{id}/run` with `{input, file_ids?}`.
2. **Fixed interval (`interval`)**: Schedules runs every `1`–`10080` minutes, skipping missed downtime windows cleanly without catch-up bursts.
3. **Timezone-aware Cron (`cron`)**: Evaluates standard 5-field cron expressions in any IANA timezone (e.g. `Asia/Shanghai`, `America/Los_Angeles`) with per-minute deduplication.
4. **Authenticated inbound Webhook (`webhook`)**: Issues a one-time high-entropy `webhook_token` on creation or rotation (`POST /v1/workflows/{id}/webhook-token`), storing only its SHA-256 digest. External services trigger runs at `POST /v1/webhooks/workflows/{id}` using `Authorization: Bearer <webhook_token>` or `X-OAA-Webhook-Token`.
5. **Agent completion (`event`)**: Finishing a source run commits a pending delivery for each enabled, matching subscription in the same database transaction. A restart between completion and notification does not lose the delivery. Its bounded output preview survives source-history cleanup. Before launch the scheduler rechecks the saved revision and current grant; editing, archiving or revoking a subscription cannot redirect earlier output to a new workflow. One source completion admits at most one execution per workflow revision. At most 256 deliveries wait per owner; overflow is reported as `queue_full` rather than acknowledged. No historical events are backfilled on upgrade, and missed cron slots are not replayed.

Each execution runs up to 4 parallel stages and 64 expanded agent calls, surfaces child approval gates directly inside the workflow inspector, and supports clean archiving (`/archive`) and restoration (`/restore`).

History cleanup keeps the stages and file inputs of queued, running, cancelling and blocked workflows. Once the execution is terminal, the usual retention cutoff applies.

---

## Streaming Media & Large Artifacts

Files generated by agents—reports, images, audio, or video—stream straight back to callers as verified deliverables:

- **Typed output contracts**: Request specific media deliverables via `POST /v1/media/jobs` or `oaa.output_kind` / `oaa.output_format` metadata (`GET /v1/media/formats` lists supported binary signatures).
- **Up to 256 MiB chunked streaming**: Artifacts are written and served with chunked SHA-256 verification, defaulting to a **64 MiB** ceiling and configurable up to **256 MiB** via `maxArtifactBytes`. The console previews images, text, audio, and video via authenticated fetches into temporary local Blob URLs so API keys never appear in media URLs.
- **Remote workers**: With `artifact-chunks-v1`, large outputs travel on the assigned WebSocket lease in acknowledged chunks of at most 128 KiB. The gateway checks byte count and SHA-256 before publishing the result. Shared directories are not required. Upgrade both ends for outputs over 8 MiB; small inline outputs remain compatible with older peers.

---

## Unified Cross-Platform Desktop App

Located in `desktop/cross-platform`, a single hardened Electron shell serves **macOS** (`arm64` / `x64`), **Windows** (`x64`), and **Linux** (`x64` / `arm64`):

- **Zero-config loopback lifecycle**: Bundles Node.js 24, automatically starting or adopting an orphaned gateway belonging to the same data directory while refusing foreign processes on conflicting ports.
- **System-tray quick approvals**: Click the menu-bar / system-tray icon to inspect active runs and approve or deny pending actions without opening the main window—paired with live Dock/tray badges and bilingual OS notifications.
- **Hardened renderer sandbox**: Runs with `nodeIntegration: false`, `contextIsolation: true`, and OS process sandboxing enabled. Common development and packaging scripts:

```bash
npm run desktop:dev           # launch the desktop shell in development
npm run desktop:smoke         # run automated Playwright desktop smoke checks
npm run package:mac           # build macOS bundle (also package:win / package:release:linux)
```
