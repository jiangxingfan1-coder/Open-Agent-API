# Local Connections

English · [简体中文](zh-CN/local-connections.md)

Local Connections is separate from API key creation. Its first target is DeepSeek Harness (DSH): an owner selects an already published source agent, previews the changes, and confirms. OAA creates a dedicated key and adds a provider to DSH. It does not replace an existing provider, change the current conversation, publish an agent automatically, or alter the original API-key workflow.

## Scope

- Direct loopback access, owner-wide administrator key, local worker, local security profile and HTTP gateway are required. Public/proxied administration cannot write client files.
- The supported DSH desktop composition uses the standard settings-file, credentials-local and llm-pi-ai providers. Custom or disabled stores require manual configuration.
- DSH's shared `settings.yaml` receives one `llm-pi-ai.providers.oaa-*` entry; `.credentials.yaml` receives one `refs.OAA_DSH_*` value. The provider is shared by profiles using these stores. Existing `profiles/desktop/cordis.patch.yml` content remains untouched. DSH's file providers support live reload; a missed watcher notification may still require a client reload.
- The key grants only `read`, `invoke` and `files` for the selected source agent, with caller-owned data. Tool execution defaults to the publication's default mode (otherwise managed); only boundaries supported by the source and its publication policy are offered. Client mode bridges DSH tools, managed mode uses the source's tools, and hybrid permits both. Unproven native client-only isolation is not offered. Changing the boundary requires a confirmed key repair, not a silent sync. The key grants neither administration nor approval rights. The source publication's publisher/native approval policy remains authoritative. Native sources still use trusted host execution, not an OS sandbox.
- A source using DSH, a declared delegate/helper leading to DSH, or a local provider/HTTP adapter pointing back to this gateway is refused. Opaque native behavior and remote configuration cannot be exhaustively inspected for cycles.

## Lifecycle

Configuration documents are limited to 4 MiB. Shared YAML anchors/aliases in edited paths and annotations added to owned entries are refused instead of being overwritten; unrelated annotations and anchors are preserved. The preview fixes whether the operation is a new grant, sync or repair, and administrator authority is revalidated at commit. A revoked key cannot turn a previously confirmed sync into an unconfirmed new grant.

Disconnect does not cancel already accepted tasks. Repair replaces a dedicated key, so resources belonging to its old caller identity may require the original key. Declared helper/delegate agents are not implicitly granted; composite workflows needing additional agent grants can still use the separate API-key workflow.

Preview does not create a key or write client configuration. Apply checks the source and file revisions again, holds the same `<file>.lock` writer locks used by DSH, and writes credentials before the provider through atomic sibling replacements. Existing locks are never stolen. Invalid YAML, unsafe file types, unsafe credential permissions and conflicting edits are refused without replacing those files. First-write backups under the gateway's private `local-connections/backups/` directory may contain credentials and must remain private.

Repeated application of the same preview is idempotent. Sync updates only the owned provider and reuses its key; repairing an invalid key revokes the old dedicated grant before creating its replacement. A journal reconciles interrupted installation/sync operations, and an origin marker lets recovery revoke grants minted before journal persistence. No token is stored in connection metadata or returned by the connection API.

Disconnect revokes the dedicated key even when a client edit prevents cleanup. It removes only values still matching the module's recorded fingerprints; external changes remain and the connection reports a conflict. It never restores an entire old file over unrelated newer changes. Other API keys remain untouched.

The connection check sends only a direct loopback model-metadata request, bypassing proxy environment settings. It is **not** a generation, entitlement or model-quality test. Provider-level automatic retries are disabled because an agent request can have side effects. Models are a snapshot of the published catalog: use Sync after the publication, model list or local gateway port changes. Existing conversations are not switched automatically.

## API

`local-connections-v1` advertises these optional owner-local operations:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/local/connections` | Target availability, source choices and connection state |
| POST | `/v1/local/connections/preview` | `{agent, model, tool_mode?}`; default model is `auto` |
| POST | `/v1/local/connections/apply` | `{plan_id}` from the same administrator's unexpired preview |
| POST | `/v1/local/connections/{id}/check` | Endpoint/key/model-metadata check without generation |
| DELETE | `/v1/local/connections/{id}` | Revoke and conditionally remove owned entries |

The first implementation does not automatically configure Codex or Claude clients. Publications requiring sandbox execution of host tools require a separately verified connection and are not automatically configured. It does not upgrade third-party packages or make closed-source tool isolation guarantees.
