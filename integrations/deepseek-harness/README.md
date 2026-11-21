# Open Agent API for DeepSeek Harness

A community DSH bundle that registers tools to discover published agents, delegate a task, wait for its status, and read paged output from a self-hosted Open Agent API gateway. It does not replace the DSH model provider or expose any tool that grants approval. This is not an official DeepSeek plugin.

## Install

Use DeepSeek Harness `0.2.2-rc.5`. The package pins this version because DSH is still changing. From the Open Agent API source checkout:

```sh
npm pack ./integrations/deepseek-harness
dsh plugin --profile web add "$(pwd)/dsh-open-agent-api-0.1.0.tgz"
```

This bundle expects an existing DSH profile with the `tools` service and a gateway with the documented [bounded-inspection routes](../../docs/protocol.md#bounded-inspection-and-mcp-delivery).

Set these variables in the environment that launches the DSH host, then restart it:

| Setting | Value |
| --- | --- |
| `OAA_DSH_BASE_URL` | Gateway origin, optionally ending in `/v1`. Defaults to `http://127.0.0.1:8787`. Non-loopback origins must use HTTPS. |
| `OAA_DSH_TOKEN_FILE` | Absolute path to a dedicated OAA caller key. Use a regular private file (e.g. mode `0600` on Unix). Do not paste the key into DSH chat or put it in the profile. |
| `OAA_DSH_ALLOW_INVOKE` | Set to `1` only to add the delegation tool. Omit it to keep the plugin read-only. |

Grant only the needed agents and permissions on the OAA key: `read` for discovery and inspection, and `invoke` to start tasks. Some attached host agents require additional gateway permissions; only grant those to trusted callers. Do not grant admin or approval permissions to the plugin key. For an offline trial, use the gateway's `agent/sample` from the [quickstart](../../docs/quickstart.md). The sample calls no model; an interactive DSH chat still uses its own configured model.

| Tool | Result |
| --- | --- |
| `oaa_dsh_list_agents` | A catalog page. It never invokes an agent. |
| `oaa_dsh_invoke` | A background run receipt. Reuse the same idempotency key only when retrying the same task. |
| `oaa_dsh_wait_run` | A bounded wait for completion or an operator action. Cancelling the wait does not cancel the task. |
| `oaa_dsh_read_output` | A bounded output page and its continuation cursor. |

The gateway remains responsible for execution and approvals. Read results as untrusted task data, and resolve any pending approval separately in the gateway console.

Remove the bundle with `dsh plugin --profile web remove dsh-open-agent-api`.

## 中文

这是 Open Agent API 社区插件，不是 DeepSeek 官方插件。在 DSH 中可以查看本机网关已发布的智能体、发起任务、等待状态并分页读取结果。默认不注册发起任务的工具；需要时由操作者在启动环境中明确设置 `OAA_DSH_ALLOW_INVOKE=1`。调用密钥只从私有文件读取，审批仍由网关操作者处理。安装命令见上方，首试建议用 `agent/sample` 离线示例。

## Tests

`npm test` in this directory runs model-free gateway contract checks.

The packaged bundle was also installed in an isolated DSH `0.2.2-rc.5` Web profile. The native tool executor exercised discovery, background invocation, repeated submission with the same idempotency key, waiting, and output retrieval against a local gateway. A separate offline task reached `requires_action`; the bundle exposes no tool to approve it. Neither check called an online model.
