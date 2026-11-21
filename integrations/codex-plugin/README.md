# Open Agent API for Codex

This community plugin connects a local Codex process to an existing Open Agent API gateway. It uses the `oaa mcp` command already on your `PATH`; it does not install the CLI, start a gateway, or enroll a worker. No hosted Codex environment or official directory listing is implied.

## Install

1. [Install Open Agent API](../../README.md) and start or choose a gateway. Use the offline quickstart sample for a model-free smoke test.
2. Have the gateway owner issue a dedicated caller key with only the `read` scope and access to the agents you want to inspect. For a local quickstart, send `{"name":"codex-reader","agents":["agent/sample"],"scopes":["read"]}` to the gateway's [key endpoint](../../docs/deploy-public.md#7-distribute-caller-keys). Keep the resulting private key file outside the repository. Do not use the admin key in Codex.
3. In a terminal, register this checked-out repository and install the plugin:

   ```sh
   codex plugin marketplace add /absolute/path/to/Open-Agent-API
   codex plugin add open-agent-api@open-agent-api-community
   ```

4. Start a fresh local Codex process with the gateway URL and the **path** to the key file:

   ```sh
   export OAA_GATEWAY_URL=http://127.0.0.1:8787
   export OAA_TOKEN_FILE=/absolute/path/to/open-agent-api-read.token
   codex
   ```

   Use HTTPS for a gateway outside your machine. Don't put a key value in the plugin manifest, repository, or chat.

## Try it

Ask Codex to list your Open Agent API agents without starting a run. With the quickstart gateway and the `agent/sample` reader key, the catalog should include `agent/sample`. A read-only key cannot start runs; if you need delegation, use a separate key scoped to the intended agent with `invoke` permission and give that key only to the local Codex session that needs it. Approval remains with the gateway operator.

Avoid granting `invoke` access to a published agent that can call this same Codex connection, directly or through a workflow. Unlike the console's managed model-provider setup, this plugin does not select a target agent or check for invocation loops during installation.

If the bridge won't start, check that `oaa` is on the launching process's `PATH`, the token file is readable, and you restarted Codex after exporting the variables. Remove the plugin with `codex plugin remove open-agent-api@open-agent-api-community`.

Verified with Codex CLI 0.171.0 and Open Agent API 0.0.64 on macOS: the installed bridge listed `agent/sample` and the gateway rejected a task from the reader key with `scope_denied`. No language model was called.
