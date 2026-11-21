# Open Agent API Power for Kiro

Community preview. This Power connects Kiro's local MCP client to an existing
Open Agent API gateway. It does not use Kiro as a model provider, install a
gateway, or change the Kiro default model.

## Try from a local folder

1. Install the `oaa` CLI and ensure that it is on Kiro's process PATH. Start
   a local gateway with the [offline quickstart](../../README.md#running-in-three-minutes)
   if you want to try this without a model account.
2. Create a dedicated reader key for the agents you want to inspect. For an
   offline trial, send this body to the gateway's admin-only `POST /v1/keys`:

   ```json
   {"name":"kiro-reader","agents":["agent/sample"],"scopes":["read"]}
   ```

   Store the returned token in a private local file (mode `0600` on Unix).
   Do not put its value in `mcp.json`, chat, or Git.
3. In the environment Kiro receives, set `OAA_GATEWAY_URL` to your gateway
   origin (for example `http://127.0.0.1:8787`, without `/v1`) and
   `OAA_TOKEN_FILE` to the absolute path of the reader key file. Restart
   Kiro if you need it to pick up the environment.
4. In Kiro, open **Powers -> Add Custom Power -> Import power from a folder**
   and select this directory. Ask it to list agents from the Open Agent API
   gateway. Expected result for the offline sample: `agent/sample`.

The gateway key, not the Power or the client, enforces permission to execute.
Use a key scoped to `read` only, not an admin or quickstart token. The MCP
tool catalog can include commands that the gateway denies to that key. Keep
the gateway local to a trusted machine unless you have a separate deployment
and authentication plan.

## Verification and support

The manifests validate against Agent Plugins 1.0.0. With the environment
placeholders resolved in a test harness, MCP Inspector ran the configured
stdio command against an isolated Open Agent API
0.0.64 gateway: a scoped reader listed the offline sample and could not
invoke it. No additional run or live model call was made. Kiro IDE import
and activation have not been tested, and this is not an official Kiro
Registry listing.

- [Kiro custom Power documentation](https://kiro.dev/docs/powers/installation/)
- [Open Agent API support and feedback](https://github.com/jiangxingfan1-coder/Open-Agent-API/issues)
- [Apache-2.0 license](../../LICENSE)
