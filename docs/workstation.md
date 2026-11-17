# Persistent Agent Workstation

English · [简体中文](zh-CN/workstation.md)

These capabilities are available in the current source worktree. They do not imply that an installed application or published release has been updated.

## Projects And Shared Memory

The console has a Projects view and each task can select a shared project. Private tasks and existing caller-private memory stay separate. An owner-wide administrator creates a project and grants `read` or `write` access to individual caller subjects; a key ID is its default subject. Project access does not grant permission to invoke additional agents.

| Endpoint | Operation |
| --- | --- |
| `GET /v1/projects` | List only visible projects |
| `POST /v1/projects` | Owner-admin creates `{id,name}` |
| `GET /v1/projects/{id}/members` | Owner-admin inspects grants |
| `POST /v1/projects/{id}/members` | `{subject,access}` with `read`, `write` or `none` |
| `GET /v1/projects/{id}/memory` | Read shared entries |
| `PUT /v1/projects/{id}/memory` | `{namespace,key,value,revision?}`; `"new"` requires absence |
| `DELETE /v1/projects/{id}/memory` | `{namespace,key,revision}` prevents stale deletion |

Select a project with `metadata["oaa.project"]`. Kernel agents with published `memory_read` / `memory_write` tools can use `scope:"project"`; the default remains private. Other agents receive a bounded reference snapshot. Completed root-task output is retained as an **agent claim**, not verified fact, when the caller has write access; opt out with `oaa.project.remember=false`. A turn cannot move a project conversation into a different project. Raw private memory, system instructions and native session handles are not copied across callers.

## Durable Tasks

`metadata["oaa.durable"]="true"` retains an absolute deadline and a bounded recovery-attempt budget. `oaa.timeout_ms` must fit the publication limit; `oaa.max_resume_attempts` accepts 1-100 (default 10). The API Execution Policy dialog can explicitly raise the publication task limit to at most 168 hours. This does not remove turn, token, key or execution restrictions.

Disconnecting an HTTP client does not cancel accepted work. Quitting the desktop leaves its background gateway running. After a gateway restart, completed checkpoints are reused and safe workspace/tool-free work can resume automatically after the original key is revalidated. The deadline is not reset on recovery. Revoked keys, missing caller-provided credentials, expired deadlines and unconfirmed host side effects prevent automatic recovery. An opaque native process is not blindly replayed; some interrupted native work needs a new explicit run after investigation rather than automatic resume.

## Reusable Workflows

The Workflows view provides an agent-stage graph, dependency editing, JSON editing and natural-language drafting. Drafting uses a verified tool-free path and never publishes or enables the generated workflow. The existing graph engine validates cycles and references and handles transforms, conditions, bounded foreach and parallel dependencies.

On 2026-11-17, a real Sonnet call through the installed Agent returned a schema-validated two-stage draft, still disabled and manually triggered. A separate two-stage offline sample passed the visual editor, execution, child approval and artifact inspection flow. These checks do not establish general model reliability or unattended native-process recovery.

Definitions are private to their creator unless explicitly attached to a shared project. Every caller still needs access to all referenced agents. Each execution freezes its definition and records child run IDs before waiting; restarting reattaches instead of redoing completed stages. There are at most four concurrent stages and 64 expanded agent calls per execution.

```json
{
  "definition": {
    "id": "report-review",
    "name": "Report Review",
    "graph": {
      "steps": [
        {"id":"write","tool":"agent/writer","arguments":{"input":{"$ref":"input#/task"}}},
        {"id":"review","tool":"agent/reviewer","arguments":{"input":{"$ref":"write#/output"}},"depends_on":["write"]}
      ],
      "output": {"$ref":"review#/output"}
    },
    "trigger": {"kind":"manual"},
    "enabled": false
  },
  "revision": "new"
}
```

Publish at `POST /v1/workflows`; start with `POST /v1/workflows/{id}/run` and `{input,file_ids?}`. Inspect `/v1/workflow-runs` and `/v1/workflow-runs/{id}`; `/cancel` cancels active children and `/resume` reattaches a blocked execution after child outcomes are resolved. Existing uncertain-effect rules still apply.

Manual/API triggers are always available. Explicitly enabled interval triggers use 1-10080 minutes and skip missed slots rather than causing catch-up bursts. Completion-event triggers name an agent and default to the creator's subject; workflow child runs do not recursively trigger other workflows. Schedules revalidate the stored key, never store bearer credentials, and expose admission errors in trigger status. Caller-supplied provider credentials are not persisted for scheduled workflows.

`POST /v1/workflows/{id}/archive` and `/restore` require `{revision}` and owner-admin authority. Archiving pauses triggers and hides the definition from the default list, without cancelling accepted executions or deleting history. `GET /v1/workflows?archived=true` lists archived definitions. Restoring leaves triggers disabled; archived definitions cannot be edited or started until restored. Manual/API invocation remains available for unarchived definitions even when their automatic triggers are disabled.

Execution lists include bounded `progress` counts and owner/caller waiting information; execution details include per-stage states. The inspector follows these states automatically and opens existing child-run approval controls. Cancellation persists a `cancelling` intent before draining child calls, so restart can finish cleanup. A failed cleanup stays `blocked` with `cancel_requested=true`: retry cancellation instead of resuming task execution. Cancelling a completed, failed or cancelled execution is a no-op and cannot rewrite its result. Cancellation jobs take priority over queued workflows; otherwise active workflow jobs are admitted oldest first.

## Media Deliverables

The task dialog can request an image, document, audio or video file. `GET /v1/media/formats` lists supported format signatures. `POST /v1/media/jobs` accepts `{agent,model?,input,kind,format?,file_ids?,metadata?}` and starts a normal persistent run; `GET /v1/media/jobs/{id}` exposes its actual artifacts. Existing compatibility APIs can instead set `oaa.output_kind` and `oaa.output_format` metadata. Workflow stages support `output_kind` and `format` arguments too.

This uses the selected agent's installed tools, not a new OAA-owned image, speech or video model. A missing or mismatched new artifact fails the output contract. Signature checks do not certify a document's full structure, codec correctness, creative quality or factual content. The existing 8 MiB artifact export limit remains explicit. Image, text, audio and video artifact previews use authenticated fetches and temporary local blob URLs; keys are never put into media URLs and playback does not auto-start.

On 2026-11-17, real Codex tasks generated and downloaded a one-second PCM WAV and H.264 MP4; independent `ffprobe` decoding recognized both. These are technical test signals/patterns, not evidence of artistic AI media quality.

## Model Evidence

Owner-admin task feedback is recorded at `POST /v1/local/evaluations/feedback` with `{run_id,passed}`. It is deduplicated per run, bound to the captured execution identity and separated from test samples. It stores no task body and consumes no evaluation calls. Authentication, transport and cancellation failures do not become false quality failures. At least four scored samples are required before measured scores affect routing.

Public facts are optional at `/v1/local/evaluations/sources` and `/sources/refresh`, keyed by `{agent,route}`. Sources must be public credential-free HTTPS JSON without query strings or redirects. DNS is checked at the connection, responses are bounded, and collection is off by default. Owners map JSON pointers to bounded context-window, input/output price or image-support fields; `priceScale` makes the source unit explicit. A selector can match a model ID in a JSON array. Changing mappings clears the old reports; evidence expires after seven days.

Only extracted numbers and booleans, freshness and a source hash reach the planner. Raw web instructions, arbitrary source text and URL paths do not. These are publisher reports, not measured quality, actual billing guarantees or host capability grants. As a network/parser probe, the public reader extracted the declared context-window field from [OpenAI's published gpt-oss configuration](https://huggingface.co/openai/gpt-oss-20b/raw/main/config.json); it did not treat that report as a performance benchmark.

## Cross-Platform Desktop

The new independent Electron shell is under `desktop/cross-platform`; the existing macOS Swift shell and CLI packages remain intact. It starts or attaches to a matching private loopback gateway, injects the local key only into its own top frame, and keeps renderer Node integration off with context isolation and process sandboxing. The design follows [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

```sh
npm install --prefix desktop/cross-platform
npm run desktop:dev
npm run desktop:smoke
node desktop/cross-platform/fetch-runtime.mjs --platform win32 --arch x64 --version 24.18.0
npm run desktop:package -- --platform win32 --arch x64 --node-dir ABSOLUTE_RUNTIME_DIRECTORY --node-version 24.18.0
```

The runtime downloader checks the official Node SHA-256 list before extraction. Packaging uses the root product version, filters production gateway dependencies, preserves third-party notices, and writes only new output directories. It does not install, publish, alter global CLI links or sign/notarize a release. Supported build targets are Windows, Linux and macOS; the local work produced Windows x64 and Linux x64 archives and a macOS arm64 app. macOS startup, private auto-connection, project creation and gateway survival after desktop exit were exercised. Windows/Linux physical-device acceptance is still outstanding; the added desktop smoke matrix has not been run remotely by this task.

Use `--oaa-data-dir ABSOLUTE_PATH` for a separate local data directory. Closing the window hides to the tray when available; **Quit desktop** leaves accepted gateway work alive. **Stop gateway and quit** is available only when this shell started that gateway, and verifies its recorded process through the existing CLI stop path.
