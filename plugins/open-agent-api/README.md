# Open Agent API

Use Copilot CLI to list published agents, start tasks authorized by your access
token, and retrieve results from your self-hosted gateway. The plugin contains
a single stdio MCP connection. It does not include an approval tool.

## Requirements

- A working [Open Agent API gateway and CLI](https://github.com/jiangxingfan1-coder/Open-Agent-API/releases/tag/v0.0.64).
  Make sure `oaa` is on the PATH of the shell used to launch Copilot CLI.
- A local file containing a scoped gateway token. Start with a read-only token.
- GitHub Copilot CLI with Agent Plugins 1.0 support.

## Install the preview

```sh
git clone --depth 1 --branch copilot-open-agent-api-v0.1.0 https://github.com/jiangxingfan1-coder/Open-Agent-API.git oaa-copilot-plugin
copilot plugin marketplace add "$(pwd)/oaa-copilot-plugin"
copilot plugin install open-agent-api@open-agent-api-plugins
```

Start Copilot CLI from a shell with the gateway origin and token-file path set:

```sh
export OAA_GATEWAY_URL=http://127.0.0.1:8787
export OAA_TOKEN_FILE=/absolute/path/to/scoped-gateway-token
copilot
```

For a remote gateway, use its HTTPS origin. Keep the token itself out of plugin
files, command arguments, and prompts. Use `oaa_list_agents` to check the
connection; read-only credentials cannot start tasks. Add invocation or file
scopes separately only when the client needs them.

## Verification

The preview was installed, used for a read-only catalog call, and uninstalled
with GitHub Copilot CLI 1.0.114 on macOS. The CLI and gateway ran locally with a
scripted model fixture. No hosted model or account was used in this test.
