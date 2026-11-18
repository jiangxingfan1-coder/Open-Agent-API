# Local Connections

English · [简体中文](zh-CN/local-connections.md)

Local Connections lists local clients as searchable cards. Click a card to open its configuration dialog. Managed receivers support two transactional channels: **API Setup** (`dsh`, `opencode`, `codex`) and **MCP Bridge** (`claude-desktop`, `cursor`, `windsurf`, `claude-code`). Select a published source agent (or all published agents for an MCP bridge), preview the diff, and confirm. OAA mints a minimal-scope dedicated key (`read`, `invoke`, `files` only—never `approve` or `admin`), stores it in a private `0600` file under `local-connections/keys/` (or DSH's private credential store), backs up the original client file, and atomically merges only its owned entry without replacing unrelated providers, MCP servers or conversations.

## Client Discovery

- Discovery covers the native/ACP catalog, configured executable/script entries, fixed installation directories, known macOS application bundles and selected VS Code/Cursor/Windsurf extension directories. It reads installation metadata only: no agent process, package download, login, credential, private project, model prompt or quota query. Generic package managers and leftover settings directories are not installation evidence.
- Native and ACP entries for the same product are deduplicated. Claude Desktop is separate from Claude Code. Presence of an executable, application or extension does not prove authentication, model entitlement, protocol compatibility or that the agent is currently running. Arbitrary custom installations outside these locations need an explicitly configured entry.
- `Detected` and `All` filters, search, and rescan expose both found clients and the known catalog. The API keeps the existing `target`, `sources` and `data` fields, adds `clients`, and accepts `?refresh=1` to bypass the 30-second metadata cache. The same owner-admin, host authority, direct-loopback and origin guards apply.
- DSH supports automatic configuration. Codex, Claude Code, OpenCode and Qoder Desktop offer manual setup with source/model selection, endpoint copying, official documentation and the existing key wizard. They do not have automatic configuration-file writers. Qoder CLI alone does not promise arbitrary custom endpoints. Other cards explicitly show that receiving-client setup is not implemented; source-agent setup remains under local backends. Manual setup does not inherit the managed DSH loop inspection and rollback guarantees.

The manual setup references are the official [Codex configuration](https://developers.openai.com/codex/config-advanced/), [Claude gateway](https://code.claude.com/docs/en/llm-gateway), [OpenCode providers](https://opencode.ai/docs/providers/) and [Qoder custom models](https://docs.qoder.com/qoder/custom-models) documentation. Compatibility still depends on the installed client version and published source capabilities.

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
| GET | `/v1/local/connections` | Target availability (`target` + `targets`), source choices and connection state |
| POST | `/v1/local/connections/preview` | `{target?, channel?, agent?, model?, tool_mode?}`; defaults to `target: "dsh"`, `model: "auto"` |
| POST | `/v1/local/connections/apply` | `{plan_id, target?, channel?}` from the same administrator's unexpired preview |
| POST | `/v1/local/connections/{id}/check` | Endpoint/key/metadata check without generation |
| DELETE | `/v1/local/connections/{id}` | Revoke dedicated key, remove private key file and conditionally clean up owned entries |

Managed API targets merge `provider["open-agent-api"]` into OpenCode (`{file:<private_key_path>}`) and `[model_providers.oaa]` into Codex (`env_key = "OAA_CODEX_API_KEY"` with a private `0600` key file), refusing self-loops (`dsh`, `opencode`, `codex`) and complex conflicting TOML syntax. Managed MCP targets inject `mcpServers["open-agent-api"]` invoking `oaa mcp --url <origin> --token-file <private_key_path>` so no raw token ever appears in client JSON files. Publications requiring sandbox execution of host tools require a separately verified connection and are not automatically configured.
