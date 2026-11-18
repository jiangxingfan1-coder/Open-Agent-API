# Local Connections: One-Click IDE & Client Wiring

English · [简体中文](zh-CN/local-connections.md)

The **Local Connections** view in the console scans developer tools and desktop clients installed on your machine so you can wire published agents into your daily editor or chat app in a few clicks—without hunting down config paths or pasting plaintext API keys.

---

## Dual-Channel Managed Setup

Local Connections provides two transactional configuration channels, each showing a full diff preview before writing and supporting clean, non-destructive rollback:

| Channel | Supported Local Clients | What Gets Written & How Keys Stay Isolated |
| --- | --- | --- |
| **API Provider Setup** | **OpenCode**, **Codex CLI**, **DeepSeek Harness (DSH)** | Mints a minimal-scope key stored in a private `0600` file; merges `provider["open-agent-api"]` into OpenCode (`{file:<private_key_path>}`), appends `[model_providers.oaa]` into Codex, or writes `llm-pi-ai.providers.oaa-*` + local credential refs into DSH |
| **MCP Bridge Injection** | **Cursor**, **Windsurf**, **Claude Desktop**, **Claude Code** | Merges `mcpServers["open-agent-api"]` invoking `oaa mcp --url <origin> --token-file <private_key_path>` for either a selected agent or all published agents—zero raw tokens ever appear in client JSON files |

For clients without an automated config writer (such as **Qoder Desktop**), clicking the card opens a guided setup sheet to pick a source agent, copy the endpoint, and jump straight to the client's custom-provider docs ([Codex config](https://developers.openai.com/codex/config-advanced/), [Claude gateway](https://code.claude.com/docs/en/llm-gateway), [OpenCode providers](https://opencode.ai/docs/providers/), [Qoder custom models](https://docs.qoder.com/qoder/custom-models)).

---

## How It Works in Three Steps

1. **Pick a client card**: Open **Local Connections** in the sidebar, filter by `Detected` or `All`, and click the client you want to wire up.
2. **Select a source agent & preview the diff**:
   - Choose a published agent (or all agents for MCP), a default routing mode (`auto`, `@fast`, `@best`), and a tool boundary mode.
   - Generating a preview computes the exact configuration diff without minting a key or touching any file on disk.
3. **Apply & verify**:
   - Confirming mints a dedicated key scoped strictly to `read`, `invoke`, and `files` (never `approve` or `admin`), backs up the original config under `local-connections/backups/`, and atomically merges only the managed entry—leaving all other providers, MCP servers, and comments intact.
   - Use **Check** anytime to verify loopback reachability and key validity without running a model, or **Sync** after publishing new agents or routes.

---

## Safety & Loop Prevention

- **Strict loopback guard**: Local connection endpoints require a direct `127.0.0.1` loopback request, same-origin headers, and an owner-wide admin key. Requests arriving over public networks or reverse proxies can never write host client files.
- **Self-loop rejection**: If a published agent is itself powered by DSH, OpenCode, or Codex (directly or through declared helpers), the gateway blocks wiring that agent back into the same client to prevent recursive loops.
- **Fingerprint-checked disconnect**: Clicking **Disconnect** revokes the dedicated key immediately, removes its private key file, and deletes only config entries that still match the recorded fingerprint. If you edited an entry by hand, your changes are preserved and reported rather than overwritten by an older backup.

---

## Management API Reference

Advertised under the `local-connections-v1` feature flag on `GET /health`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/local/connections` | Lists detected and known clients (`clients` / `targets`), source agents, and connection states (`?refresh=1` forces a fresh scan) |
| `POST` | `/v1/local/connections/preview` | Computes a configuration plan: `{target?, channel?, agent?, model?, tool_mode?}` |
| `POST` | `/v1/local/connections/apply` | Commits an unexpired preview plan: `{plan_id, target?, channel?}` |
| `POST` | `/v1/local/connections/{id}/check` | Verifies endpoint, key, and model metadata over loopback without model generation |
| `DELETE` | `/v1/local/connections/{id}` | Revokes the dedicated key, deletes its private key file, and cleans up owned config entries |
