# 接入其他智能体

[English](../adapters.md) · 简体中文

内置适配器并不是平台的边界。owner 可以安装 stdio 或 HTTP 适配器，在 worker 上启用它，再用 `engine: "adapter/<名称>"` 发布一个 AgentDefinition。适用于有自己的 SDK、API 或受支持的无头接口的智能体。只安装 MCP 并不能补上原智能体本身没有暴露的执行接口。

## AgentAPI 转换契约（2026-11-08）

当前 Codex 适配器只接受自身会话和轮次的事件及审批，取消时先发送协议级 `turn/interrupt` 并在宽限期后再终止顽固进程，保留脱敏后的上游错误，兼容完整消息快照且不重复流式文本，并限制初始化和退出等待时间。模型目录可能包含模型与思考强度的组合；统一的资源安全上限为 1,024 个模型/路由。超限目录会明确携带 `truncated: true`，界面也会标记列表不完整。模型发现或握手通过**不等于**真实生成验证通过。Codex 与全部 ACP 后端现已支持强制禁用工具的无工具推理轮次（`toolsDisabled`），不透明外部引擎也可显式绑定专职 `orchestration.planner` 智能体参与自动编排。下表 Antigravity 一行描述旧 stream-json 路径；新策略或混合工具发布使用 ACP，见 [Harness](harness.md)。

> 本节为新增内容。回答两个问题：一个智能体经由哪条链路变成 AgentAPI；每条链路在流式、运行中审批、取消、续接、工具可见性上**实际**能保证什么。表中结论由 `test/conformance.test.ts` 用协议级假智能体逐类验证（不调用任何真实模型或智能体，不监听端口）；未经测试的条目明确标注。

### 转换链路

```
智能体 ──接入方式──▶ worker ──oaa/1 节点协议──▶ 内核（持久运行、审批、事件） ──▶ 外部协议
        内置原生 4 种                                                   oaa/1 · OpenAI Responses / Chat
        ACP stdio                                                       Claude Messages · Gemini · UAP/1
        oaa/1 stdio / oaa/1-stream / oaa/1 HTTP                         MCP 桥
        A2A（远程）
```

所有接入方式最终都被归一为同一种运行：文本增量 → `response.output_text.delta`，工具/状态进度 → `tool.progress`，审批 → `run.requires_action` + `/v1/runs/{id}/actions`，结束 → 带稳定 `error.code` 的终止事件。外部协议只是对这同一条运行记录的不同渲染，所以「一个智能体能不能成为 AgentAPI」只取决于它的接入方式能提供哪些信号。

### 接入方式审计

✅ 完整支持　⚠️ 部分支持（说明见格内）　❌ 不支持

| 接入方式 | 流式文本 | 运行中审批 | 取消 | 续接 | 工具可见 | 用量 | 产物 | 模型选择 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 内核 `kernel` | ✅ token | ✅ 工具 `requiresApproval` 停车等待 | ✅ 协作式（中止模型调用） | ✅ 回放会话历史 | ✅ 步骤与 `tool.*` | ✅ 每轮 | ✅ `write_file` | 路由（多路由、故障转移） |
| 原生 `codex`（app-server JSON-RPC） | ✅ token | ✅ 命令/文件/权限/提问/MCP elicitation 全部桥接 | ✅ `turn/interrupt` + 2.5 秒宽限后终止 | ✅ `thread/resume` | ✅ item 进度 | ✅ 累计用量增量（`thread/tokenUsage/updated`）；旧会话无基线时为未知 | ✅ `outputs/` | 发出提示前确认模型，拒绝静默回退 |
| 原生 `claude`（Agent SDK） | ✅ token（`includePartialMessages` `stream_event` 增量，与末尾整包去重） | ✅ `canUseTool` 桥接 | ⚠️ abort 后终止 | ✅ `--resume` | ✅ 工具名（不含参数） | ✅ | ✅ | 声明式 |
| 原生 `antigravity`（stream-json） | ✅ token | ⚠️ 不桥接：智能体自身拒绝时以 `permission_denied` 失败 | ⚠️ 终止 | ✅ `--conversation` | ✅ step 工具 | ⚠️ 仅首轮（会话累计值不当作每轮用量） | ✅ | 智能体确认（init 回报的模型不符即失败，不发送任务） |
| 原生 `dsh`（headless） | ❌ 仅最终结果 | ❌ | ⚠️ 终止 | ❌ `native_resume_unsupported` | ❌ | ❌ | ✅ | 白名单（owner 模型映射） |
| ACP stdio | ✅ token | ✅ 只选 `allow_once` | ✅ `session/cancel` + 宽限后终止 | ⚠️ 取决于智能体声明 `loadSession`/`resume`（握手检查可确认） | ✅ `tool_call`/`plan` | ⚠️ 智能体上报（ACP 不稳定字段；三项全为 0 按未知处理） | ✅ | 智能体确认（`configOptions`） |
| `oaa/1` stdio（最终结果 ABI） | ❌ 仅最终结果 | ❌ | ⚠️ 终止 | ✅ `state` 回传 | ❌ | ✅ 若上报 | ✅ | 声明式 |
| `oaa/1-stream` stdio | ✅ token | ✅ 桥接 | ✅ 协作式 `cancel` + 3 秒后终止 | ✅ `state` 回传 | ✅ `progress` | ✅ 若上报 | ✅ | 声明式 |
| `oaa/1` HTTP | ❌ 仅最终结果 | ❌ | ⚠️ 中止请求（远端可能继续执行） | ✅ `state` 回传 | ❌ | ✅ 若上报 | ❌ 无共享工作区 | 声明式 |
| A2A（远程） | ✅ SSE（`message/stream`） | ❌ 不桥接：`input-required` 以智能体的问题结束本轮，回复时续接同一任务 | ✅ `tasks/cancel` | ✅ `contextId`（`input-required` 时续接 `taskId`） | ⚠️ 仅任务状态 | ❌ | ❌ | 声明式（A2A 没有模型选择） |

「运行中审批」一列是缺省（`approvals: "ask"`）的行为；发布时设为 `auto` 的外部智能体，桥接的权限请求由策略直接批准并留下记录，见下文「发布时的审批策略」。

所有接入方式都满足的公共底线（测试逐项断言）：最终文本正确；仅最终结果的接入方式在每种流式协议里仍以恰好 1 个增量送达；失败带 `docs/protocol.md` 中列出的稳定错误码，且适配器/智能体提供的错误文本会脱敏；取消后已经开始的外部智能体回合记为 `interrupted`（`effect_outcome_unknown`，无法排除副作用），内核回合记为 `cancelled`；只有内核会调用模型提供方。

### 外部协议审计

| 外部协议 | 流式 | 待审批的呈现 | 取消 | 续接 | 工具事件 |
| --- | --- | --- | --- | --- | --- |
| `oaa/1` `POST /v1/invoke` | ✅ | 同 Responses；决定走 `POST /v1/runs/{id}/actions/{action}`（需 `approve` 权限） | ✅ `POST /v1/responses/{id}/cancel` | ✅ `previous_response_id` | ✅ 原生事件流 `GET /v1/runs/{id}/events` 转发全部事件 |
| OpenAI Responses | ✅ | 同步：`in_progress` + `metadata["oaa.status"]="requires_action"`；流式：保持连接并发出 `response.in_progress` | ✅ | ✅ `previous_response_id` | ❌ Responses 没有对应事件，不转发 |
| OpenAI Chat Completions | ✅ | 同步 `422 action_required`（带 `X-Run-ID`，SDK 不会重试）；流式以 `action_required` 错误帧结束 | ⚠️ 用 `X-Run-ID` 调取消接口 | ❌ 无状态：历史被扁平化为新一轮（适配器看到的是新会话） | ❌ |
| Claude Messages | ✅ | 同步 409；流式 `event: error` | ⚠️ 同上 | ❌ 无状态 | ❌ |
| Gemini `generateContent` | ✅ | 同步 409；流式 `ABORTED` 帧 | ⚠️ 同上 | ❌ 无状态 | ❌ |
| UAP/1 | ✅ NDJSON / SSE | 同步 `status: "requires_action"`；流式 `action` 帧后关闭 | ⚠️ 同上 | ✅ `session.previous_id` | ✅ `step` 帧 |
| MCP 桥 | ⚠️ 轮询 `oaa_wait_run` | `oaa_wait_run` 返回 `requires_action` 与 `pending_actions`；**刻意不提供审批工具** | ✅ `oaa_cancel` | ✅ `previous_response_id` | ⚠️ 仅运行状态 |

MCP 不提供批准/拒绝工具是有意的安全边界：调用方往往本身就是一个 AI 智能体，若它能批准自己发起的写操作，人工审批就失去意义。决定应由 owner 在控制台或用带 `approve` 权限的密钥调用 HTTP 接口完成。断开连接不会取消已接受的任务，取消必须显式调用。

### 结论

1. **四类接入方式都能把智能体变成 AgentAPI**：内置原生、ACP、`oaa/1`（stdio / 流式 / HTTP）、A2A。10 种具体路径在同一套假智能体测试里通过了基本回合、续接（或诚实拒绝）、审批、产物、失败、取消六类检查，6 种外部协议加 MCP 桥渲染同一条运行。
2. **差异在「交互深度」，不在「能不能接入」**：现在由 `conversion` 画像显式说明，调用方不必靠试错。分三级：`basic`（最终结果 + 稳定错误 + 取消）、`streaming`（再加增量文本）、`interactive`（再加运行中审批）。当前 `interactive`：内核、Codex、Claude、ACP、`oaa/1-stream`；`streaming`：Antigravity、A2A；`basic`：DSH、`oaa/1` stdio / HTTP。
3. **已修正的不一致**：Codex 中被 owner 拒绝的操作原来报 `native_incomplete`，现在与其它引擎一致报 `permission_denied`；Claude 的工具调用原来不可见，现在记为进度（只记工具名）；`oaa/1` 适配器返回的错误文本原来原样写入运行记录，现在脱敏；流式 Responses 在等待审批时原来完全静默，现在报告待审批状态；自定义适配器原来只能交付最终结果，现在可选 `oaa/1-stream` 获得流式、审批与协作式取消；新增 A2A 远程接入。
4. **已补齐的缺口与保留边界**：Codex 取消现已先发协议级 `turn/interrupt` 并在有界宽限期后再终止进程；Claude 已支持 token 级增量流式（`includePartialMessages: true`）且与末尾快照严格去重；Codex、Claude 与 Antigravity 原生引擎均已通过 `oaa-caller` MCP 支持调用方工具桥接（`permission_auto_allowed`）；协商了 `conversion-profiles-v1` 的远程节点会同步自定义 `adapter/<名称>` 的静态 `ConversionProfile` 画像，网关侧不再显示为 `unknown`。保留边界：Antigravity 旧版 stream-json 路径仍不支持运行中无头权限审批桥接（需要交互审批请走其 `agy acp` 路径）；Chat / Claude / Gemini 因协议本身无状态，无法原生续接会话或展示 OAA 工具事件。真机端到端实测记录见 [evidence.md](evidence.md)。

### 转换能力画像（`conversion`）

`src/engines/conformance.ts` 按接入方式给出画像，出现在 `GET /v1/agents`、`GET /v1/overview` 的智能体、`GET /v1/catalog/agent?section=overview`（MCP `oaa_inspect_agent` 同源）和 `GET /v1/local/backends` 的 `data` 与 `presets` 中；`/health` 的 `features` 含 `conversion-profile-v1`。

| 字段 | 取值 |
| --- | --- |
| `access` | `kernel`、`native`、`acp`、`oaa-adapter`、`a2a`、`unknown`（网关本机未配置该适配器，且没有远程节点经 `conversion-profiles-v1` 通告其画像） |
| `transport` | 具体线协议：`oaa-kernel`、`codex-app-server`、`claude-agent-sdk`、`antigravity-stream-json`、`dsh-headless`、`acp-stdio`、`oaa/1`、`oaa/1-stream`、`oaa/1-http`、`a2a-jsonrpc` |
| `tier` | `basic`、`streaming`、`interactive`（见上文结论 2） |
| `streaming` | `token`、`message`、`final` |
| `approvals` | `bridged`（owner 的批准/拒绝送达智能体）、`denied`（智能体自身的权限提示使运行失败）、`none` |
| `cancel` | `cooperative`（先发协议级取消再停止进程）、`terminate`（停止受管进程组）、`request-abort`（只中止 HTTP 请求） |
| `resume` | `native`（智能体自己的会话/上下文）、`agent-declared`（取决于握手声明）、`adapter-state`（适配器的不透明状态）、`none`（续接被拒绝） |
| `tool_events` | `tool`、`status`、`none` |
| `usage` | `reported`、`agent-reported`、`partial`、`none` |
| `artifacts` | `outputs/` 下的文件是否导出为产物 |
| `model_selection` | `route`、`declared`、`agent-confirmed`、`allowlist` |
| `client_tools` | 调用方在兼容接口里传入的工具怎么处理（见 [harness.md](harness.md)）：`managed`（智能体用自己的工具完成，调用方工具不执行）、`bridge`（调用方工具交回调用方执行）。内核、Codex、Claude Code 与 ACP 智能体为 `bridge`（Chat Completions、Responses、Claude Messages 与 Gemini 均可），其余外部智能体为 `managed` |
| `image_input` | 图片怎样到达智能体（[images.md](images.md)）：`route`（内核；按模型线路，`providers.*.imageInput`）、`native`（Codex 的 `localImage`、Claude Code 的图片块、握手声明了 `promptCapabilities.image` 的 ACP 智能体）、`agent-declared`（握手检查之前的 ACP：声明了就发图片块，否则用工作目录文件）、`workspace-file`（图片文件放在 `inputs/` 下并在输入里写明路径：Antigravity、DSH、stdio `oaa/1` 适配器、不支持图片的 ACP）、`none`（拒绝：A2A、HTTP 适配器、`imageFiles: false`） |

画像只由静态配置推导，同一进程内不变，所以不会让概览 ETag 失效。owner 触发的握手检查只细化 `/v1/local/backends` 中的条目：ACP 握手若声明了 `loadSession` 或 `resume`，`resume` 变为 `native`，都未声明则为 `none`。同理，握手声明了 `promptCapabilities.image` 时 `image_input` 变为 `native`，未声明时为 `workspace-file`（设了 `imageFiles: false` 则为 `none`）。

### 外部智能体事件的入口约束（2026-11-11）

外部智能体（engine 不是 `kernel`）经由接入方式送来的进度与审批，在内核落盘之前统一收口（`src/kernel/agent-events.ts`）；内核工具自身的 `tool.progress` 不经过这里，形状不变。

- **进度**：仍是 `tool.progress` 事件。只保留下表列出的白名单字段；字符串截断（`event` / `status` / `state` / `kind` 40 字符，`tool` 160，其余 240）；有限数字、布尔与 `null` 原样保留；数组（如 `entries`）至多 20 项且只保留其中的标量；其它类型（对象、非有限数字等）丢弃。最后加 `source: "agent"`，表示这条进度来自外部智能体的报告，用来与内核工具执行自身发出的 `tool.progress`（不带 `source`）区分；智能体自己送来的 `source` 字段会被覆盖。
- **审批**：审批详情序列化后超过 256 KiB（262,144 字符）时不创建待审批项，直接向接入层回答拒绝，并记一条进度 `{ event: "permission_denied", reason: "approval_too_large" }`。与 `oaa/1-stream`、ACP 接入层原有的「过大则拒绝」一致；Claude、Codex 的审批带完整参数，从此也受这一上限约束。被拒绝的操作按各接入方式原有规则使本轮以 `permission_denied` 结束。
- **发布时的审批策略（`approvals`）**：外部智能体的定义可带 `approvals: "auto"`（缺省 `ask`）。设为 `auto` 时，上一条的大小上限照旧先检查（超限仍拒绝）；之后不进入 `requires_action`、不等待，内核直接落一条 `status: "approved"`、`response: { auto: true }` 的审批记录，并发出 `approval.resolved`（`decision: "approve"`、`actor: "policy:auto"`），然后向接入层回答批准。运行一直是 `in_progress`，不产生 `run.requires_action`，各协议的流与「没有权限请求」时一致。适用于所有表中「运行中审批」为桥接的接入方式（Codex、Claude、ACP、`oaa/1-stream`）；不桥接审批的接入方式（Antigravity、A2A 等）不受影响。内核智能体写 `auto` 在校验阶段报错——内核工具的审批由工具声明的 `requiresApproval` 控制。执行等级、沙箱、BYOK 与节点授权的检查都不变（外部智能体仍要求调用方密钥具备 `host`）；桥接回合里对调用方工具的自动放行与本字段无关，两者并存。**风险**：自动批准等于让调用方以所有者在这台机器上的权限驱动这个智能体——它执行命令、修改文件前不再有人把关，调用方拿到的就是它直接执行的结果。只对你信任的调用方开放：给它单独发一把 API 密钥、把密钥限定到这一个智能体（`agents`），必要时用沙箱执行等级运行。
- **事件回调失败**：任何接入方式发出的文本或进度事件被网关拒收（例如落盘失败）时，本轮以明确错误结束，不会成为未处理的 Promise 拒绝：进度落盘失败记为 `persistence_failed` 并中止运行（与文本增量相同）；执行节点上模型增量送不出去时，本轮以该错误结束。

各接入方式的进度字段（`source: "agent"` 由内核统一加上，表中略去）：

| 接入方式 | `native` | `event` | 其它字段 |
| --- | --- | --- | --- |
| 原生 `claude` | `claude` | `tool`；`permission_auto_allowed`；`permission_denied` | `tool`（工具名，不含参数）；`permission_auto_allowed`：`tool`（桥接回合自动放行的调用方工具）；`permission_denied`：`reason` |
| 原生 `codex` | `codex` | `item`；`permission_auto_allowed`；`permission_denied` | `itemType`（Codex 的 item 类型，保留）、`status`、`kind`（`commandExecution` `fileChange` `mcpToolCall` `dynamicToolCall` `collabAgentToolCall` `webSearch` `imageView` 为 `tool`，其它为 `status`）；`permission_auto_allowed`：`tool`；`permission_denied`：`reason` |
| 原生 `antigravity` | `antigravity` | `initialized`；`tool` | `initialized`：`model` `tool_count` `permission_mode`；`tool`：`tool`（工具名）、`state` |
| 原生 `dsh` | — | — | 不发进度 |
| ACP stdio | `acp` | `initialized` `thinking` `tool` `plan` `content_skipped` `permission_denied` `permission_auto_allowed` | `adapter`；`initialized`：`agent` `version` `load_session` `resume_session`；`tool`：`tool_call_id` `title` `kind` `status`；`plan`：`entries`（条数）；`content_skipped`：`content_type`；`permission_denied`：`reason`；`permission_auto_allowed`：`tool`（桥接回合里自动放行的调用方工具名） |
| `oaa/1-stream` stdio | `adapter` | 适配器给出的 `event`（缺省 `progress`） | `adapter`、`title`、`status`、`tool` |
| A2A | `a2a` | `status` | `adapter`、`state`、`title` |
| 任意外部智能体 | 同上 | `permission_denied` | `reason: "approval_too_large"`（审批详情过大，见上） |

只增加字段，没有删除或改名；事件名仍是 `tool.progress`。

其它几条统一规则：

- **产物先落盘、步骤后完成**：外部智能体交回的产物逐个校验摘要并落盘，全部成功之后，步骤完成、产物 ID 与运行检查点才在同一次提交里落盘。任何一个摘要不符即以 `artifact_integrity` 失败，这一步不会被记为 `completed`。
- **Antigravity 的拒绝与工具失败**：只有能明确识别为拒绝的（stderr 或工具步骤的 `tool_info.error` 中出现 `soft-denied`、`permission … denied`、`requires approval` 这类措辞）才以 `permission_denied` 失败；其它工具错误不再把整轮判为被拒，由智能体自己的后续输出决定结果，没有给出成功结果时按 `native_incomplete` 失败。详见下文 Antigravity 一节。
- **文本以流式送出的为准**：一轮里已经流式送出过文本时，最终输出就是这些流式文本，接入方式在结束时给出的整段结果文本（例如 Claude 的 `result`）不再写入；只有一轮里没有任何流式文本时，才把结果文本作为输出（仍以恰好 1 个增量送达）。

### 一个智能体要满足什么才能接入

| 等级 | 最低要求 | 推荐接入方式 |
| --- | --- | --- |
| `basic` | 可以无人值守地接收一个任务并在结束时给出最终文本；失败时以非零退出或 `failed` 状态说明原因；不在输出里泄露凭据 | `oaa/1` stdio（包装任意 CLI 的 headless/print 模式）或 `oaa/1` HTTP |
| `streaming` | 运行中逐段输出文本 | `oaa/1-stream`、ACP、A2A（`message/stream`） |
| `interactive` | 需要人工确认的操作在执行**前**发出请求，并真正遵守批准/拒绝结果 | ACP（`session/request_permission`）或 `oaa/1-stream`（`approval`） |
| 可续接 | 能用不透明状态或会话 id 恢复上下文；做不到时必须明确拒绝，不能悄悄开新会话 | 任意方式；在 `state` / 会话 id 中保存 |

OAA 自身保证的部分不需要智能体实现：持久运行记录、事件回放、审批的过期与权限检查、产物收集、限额、多协议渲染与 MCP 暴露。

## `oaa/1` 最终结果 ABI

worker 配置：

```json
{
  "adapters": {
    "my-agent": {
      "transport": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/my-agent-adapter.mjs"],
      "enabled": true
    }
  }
}
```

进程从 stdin 收到一个 JSON 对象，必须在 stdout 写出一个结果对象。诊断信息写 stderr。这个进程归 worker 所有，遇到取消、超时或输出超限时会被终止。HTTP 形式用 `{transport:"http",url:"https://...",tokenEnv:"MY_ADAPTER_TOKEN",enabled:true}`，请求体与结果体相同。

请求：

```json
{
  "protocol": "oaa/1",
  "type": "invoke",
  "agent": "agent/my-agent",
  "model": "an-explicit-published-model",
  "input": "任务内容",
  "instructions": "owner 发布的指令，按原生智能体自己的规则应用",
  "run_id": "resp_...",
  "session_id": "session_...",
  "workspace": "/owned/task/workspace",
  "previous_state": null
}
```

结果：

```json
{
  "protocol": "oaa/1",
  "type": "result",
  "status": "completed",
  "output_text": "答案",
  "state": { "upstream_session": "your-own-opaque-session-reference" },
  "usage": null
}
```

`state` 是适配器自己持有的不透明续接数据，不是授权凭证。要保持所选模型，做不到就返回失败；不要悄悄换成别的账号或模型。只有底层智能体确认完成后才报告 `completed`；否则用 `failed` 或 `incomplete` 加一段 `error` 字符串。凭据必须留在 worker / 适配器的环境里，不能放进 state 返回。

最初的通用适配器 ABI 是「最终结果 JSON」，并不声称提供通用的 token 级流式或审批传输。（需要流式输出、运行中审批与协作式取消时，改用下文的 `oaa/1-stream`，或接入 ACP / A2A。）API 仍然可以把完成后的文本以流的形式送出，并返回持久的任务状态。丰富的增量与审批流程目前属于受支持的内置适配器。stdio 适配器可以把交付物放到 `outputs/` 下，由 worker 有界的产物收集器收走。HTTP 适配器不会自动获得本地工作区路径的访问权。原生 / 外部智能体使用它们原有的工具集：可移植的 `tools` / `skills` 绑定只有内核引擎接受，不会被悄悄忽略。

要自写一个嵌入式执行器，实现 `src/fabric/worker.ts` 里导出的 `Executor` 接口。远程 worker 使用 `protocol.md` 中记载的带租约的 `oaa/1` 协议。这些扩展点让其他智能体无需修改原智能体的代码、也无需取出它私有的认证状态就能参与进来。

## `oaa/1-stream`：流式适配器 ABI（2026-11-08）

> 本节为新增内容。在 stdio 适配器上加 `"protocol": "oaa/1-stream"` 即可启用；不写或写 `"oaa/1"` 时仍是上面的最终结果 ABI，两者互不影响。

```json
{
  "adapters": {
    "my-agent": {
      "transport": "stdio",
      "protocol": "oaa/1-stream",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/my-agent-adapter.mjs"],
      "enabled": true
    }
  }
}
```

双向都是 NDJSON（每行一个 JSON 对象）：

- **OAA → 适配器（stdin，保持打开）**：第一行是与最终结果 ABI 相同的请求对象，另加 `"stream": true`；之后可能出现 `{"type":"approval_result","id":"…","decision":"approve"|"deny"}` 和 `{"type":"cancel"}`。收到结果后 OAA 关闭 stdin。
- **适配器 → OAA（stdout）**：
  - `{"type":"delta","text":"…"}`：增量文本，立即写入持久输出（累计上限 1 MB）。
  - `{"type":"progress","event":"tool","tool":"…","title":"…","status":"…"}`：进度，记为 `tool.progress`（字段均可选，按长度截断）。
  - `{"type":"approval","id":"a1","title":"…","kind":"edit","input":{…}}`：请求 owner 审批，**在执行前**发出，然后等待 `approval_result`。详情超过 256 KiB、或当前没有审批通道时 OAA 直接回复 `deny`。
  - 最后一行：与最终结果 ABI 相同的 `result` 对象（`protocol`、`type: "result"`、`status`、`output_text`、`state`、`usage`、可选 `error`）。若已经发送过 `delta`，最终输出以增量为准。
- 规则：出现未知 `type` 以 `invalid_protocol` 失败；进程退出时没有 `result` 为 `native_incomplete`；`status` 不是 `completed` 为 `adapter_incomplete`（`error` 文本会脱敏）；本轮有任何审批被拒绝，即使随后报告 `completed`，也以 `permission_denied` 失败。
- 取消：OAA 先发送 `{"type":"cancel"}`，3 秒内未退出则终止整个进程组。与其它外部智能体一样，已开始的回合被取消后记为 `interrupted`。
- 诊断信息写 stderr。工作目录就是任务工作区，`outputs/` 下的文件收集为产物。

参考实现：`test/fixtures/stream-adapter.mjs`（同时演示最终结果 ABI 与流式 ABI）。

## ACP 智能体（Agent Client Protocol）

> 本节为新增内容（2026-11-07）。上面的 `oaa/1` 最终结果 ABI 仍然有效；ACP 是另一种 `transport`，提供流式输出、审批与取消。

除内置的 `codex`、`claude`、`antigravity`、`dsh` 外，worker 还可以通过 `transport: "acp"` 接入任何实现了 [Agent Client Protocol](https://agentclientprotocol.com) v1 的本地智能体（Gemini CLI、Qwen Code、Kimi Code、OpenCode、Goose、Cursor、Copilot CLI、Kiro、Qoder 等，完整目录见下表）。发布后的引擎名为 `adapter/<名称>`。

```json
{
  "adapters": {
    "gemini": {
      "transport": "acp",
      "command": "/opt/homebrew/bin/gemini",
      "args": ["--acp"],
      "enabled": false,
      "preset": "gemini"
    }
  }
}
```

- `command`/`args`：owner 明确配置或由发现写入的可执行文件；OAA 只运行 `enabled: true` 的条目，绝不运行 `npx`、不下载或安装任何包。
- `preset`：仅用于图标与目录展示（对应 `web/agents/<preset>.svg`），不授予任何能力。缺省时若适配器名本身是预设 id，则按名称匹配。
- 适配器名必须符合 `[a-z0-9_-]+`，否则不会被通告，也无法发布。

### 每一轮的执行流程

1. 以任务的受管工作区为 `cwd` 启动进程（独立进程组，环境变量剔除 `OAA_*`）。
2. `initialize`：协议版本必须为 `1`；OAA 声明**不提供**文件系统与终端回调（`fs.readTextFile/writeTextFile=false`、`terminal=false`），智能体使用其原生工具在工作区内工作。
3. 新会话：`session/new {cwd, mcpServers: []}`（不注入任何 MCP 服务器；桥接调用方工具时例外，见下文「调用方工具（`mcpServers`）」）。续接：若上一轮 `nativeState.sessionId` 存在，优先 `session/resume`（智能体声明 `sessionCapabilities.resume` 时），否则 `session/load`（声明 `loadSession` 时）；两者都不支持则以 `native_resume_unsupported` 失败，**不会**悄悄开新会话丢失上下文。`session/load` 回放的历史消息不会写入新一轮输出。
4. 模型：`default` 表示沿用智能体自己的模型。显式模型必须出现在会话返回的 `configOptions`（`category: "model"`）或旧版 `models` 中，并经 `session/set_config_option` 确认已选中；否则以 `model_not_supported` / `native_model_mismatch` 失败，且不发送任务。续接的会话若没有返回任何模型配置，只有当请求的模型与上一轮 OAA 已确认的模型（`nativeState.model`）相同时才继续。
5. `session/prompt`：提示词为「已发布 instructions + 任务 + 输入文件清单 + outputs/ 约定」。`agent_message_chunk` 的文本流实时写入 OAA 持久输出；思考内容（`agent_thought_chunk`）不进入输出，只记一次 `thinking` 进度；`tool_call`/`tool_call_update`/`plan` 作为进度事件记录（标题、类型、状态）。
6. 只有 `stopReason: "end_turn"` 且没有任何被拒绝的权限请求时才报告完成；`max_tokens`、`max_turn_requests`、`refusal` 等记为 `native_incomplete`。
7. 结束后关闭 stdin，等待自行退出（默认 2 秒），否则终止整个进程组（SIGTERM，1.5 秒后 SIGKILL）。`outputs/` 下的文件按原生引擎同样的规则收集为产物。

### 调用方工具（`mcpServers`）

画像的 `client_tools` 为 `bridge`：调用方请求 `X-OAA-Client-Tools: bridge` 并带了工具时，`session/new` / `session/load` / `session/resume` 的 `mcpServers` 里放一个 stdio 条目，其余情况仍是 `[]`（线上字节不变）：

```json
{
  "name": "oaa-caller",
  "command": "/usr/local/bin/node",
  "args": ["/opt/oaa/dist/src/cli.js", "mcp-relay", "--socket", "/tmp/oaa-r-x1/relay.sock", "--token-file", "/tmp/oaa-r-x1/token"],
  "env": []
}
```

- 字段形状依据 ACP 规范的公开描述（stdio 形式：`name`、`command`、`args`、`env` 为名值对数组），**未对真实智能体联调**。 （2026-11-11 更新：已对本机 Antigravity 命令行（`agy` 1.5.5）的 ACP 入口用 Gemini 3.8 Flash 做过一次真实联调，托管与桥接各一次调用均通过，`mcpServers` 的 stdio 条目形状被接受；并行调用、流式、慢回传与其它 ACP 智能体仍未验证。联调结果见 [evidence.md](evidence.md)。）
- 中继是 `oaa mcp-relay`：stdio MCP 服务，`tools/list` 返回调用方工具，`tools/call` 经本机 Unix 域套接字（0600，0700 私有目录，一次性令牌）转给执行机器；不监听网络端口，日志只写 stderr。回合结束时套接字关闭、文件删除，中继退出。
- 执行机器在握手里声明 `client-tools-v1` 后，才会收到带调用方工具的任务。
- 详见 [harness.md](harness.md)「外部智能体的桥接是怎么工作的」。

### 权限审批

`session/request_permission` 接入与 Claude/Codex 相同的原生审批桥：在 OAA 中生成一条 `kind: "native"` 的待审批项，`detail` 包含 `native: "acp"`、适配器名、工具标题/类型、`rawInput`、涉及路径和可选项。

- owner 批准时只选择智能体提供的 `allow_once`，**从不**选择 `allow_always`，一次批准不会变成长期授权。
- 下列情况默认拒绝（选择 `reject_once`，若无则回复 `cancelled`）：owner 拒绝；审批桥不可用；智能体未提供 `allow_once`；审批详情超过 256 KiB（不以截断内容取得批准）。
- 只要本轮有任何请求被拒绝，即使智能体随后正常结束，也以 `permission_denied` 失败——进程正常退出不是成功依据。

### 取消、超时与失败

- 取消或运行截止时间到达：先发送 `session/cancel`，最多等待 3 秒让智能体以 `stopReason: "cancelled"` 确认，再终止进程组。与其它原生引擎一致，已经开始执行的原生任务被取消后记为 `interrupted`（`effect_outcome_unknown`），因为无法排除已经产生的副作用。
- 握手阶段（initialize、会话创建/恢复、模型设置）每一步最多 60 秒，超时为 `adapter_timeout`。
- 进程提前退出：`native_incomplete`（附脱敏后的 stderr 末尾）；stdout 出现非 JSON-RPC 内容或单条消息超过 8 MiB：`native_protocol_error`；智能体返回 JSON-RPC `-32000`：`adapter_auth_required`——请在该智能体自己的 CLI 中登录，OAA 不会调用 `authenticate`、不保存任何凭据。
- 用量：仅当 `PromptResponse.usage`（ACP 标注为不稳定字段，单轮用量）的三项都是非负整数、且不全为 0 时记录（全为 0 的上报，如 Qoder，按「用量未知」处理，不当作用了 0 个 token）；`usage_update` 只作为上下文占用写入 `nativeState`，不当作计费，也不推算费用。

### 预设目录与发现

预设从同一作者的 Possibility 项目移植（来源与 Apache-2.0 署名见 `src/config/agent-presets.ts` 文件头与 `THIRD_PARTY_NOTICES.md`）。成熟度沿用厂商自己的标注：`documented` 表示厂商公开了 ACP 入口，`preview` 表示厂商仍标注为预览/实验/抢先体验，`community` 表示厂商没有 ACP 入口、只有 ACP Registry 收录的第三方或 ACP 组织适配器（2026-11-08 新增）。「核实」列是对照厂商官方文档（community 条目对照 Registry）检查命令与成熟度的日期，API 中为 `verified`，`null` 即「待验证」。

| 预设 id | 名称 | 命令模板 | 成熟度 | PATH 发现 | 核实 |
| --- | --- | --- | --- | --- | --- |
| `qoder` | Qoder CLI | `qoder --acp` | documented | `qoder` / `qodercli` | 2026-11-08 |
| `deepseek-harness` | DeepSeek Harness ACP | `dsh --profile acp` | documented | `dsh` | 2026-11-10 |
| `kimi` | Kimi Code CLI | `kimi acp` | documented | `kimi` | 2026-11-08 |
| `vibe` | Mistral Vibe CLI | `vibe-acp` | documented | `vibe-acp` | 2026-11-10 |
| `gemini` | Gemini CLI | `gemini --acp` | documented | `gemini` | 2026-11-08 |
| `antigravity-acp` | Google Antigravity ACP | `agy_acp_server.par` | documented | `agy_acp_server.par` | 2026-11-10 |
| `amp-acp` | Amp ACP | `amp-acp` | community | `amp-acp` | 2026-11-08 |
| `cortex-code` | Snowflake Cortex Code | `cortex acp serve` | documented | `cortex` | 2026-11-10 |
| `pi-acp` | pi ACP | `npx -y pi-acp@0.0.34` | documented | 不自动发现（npx 启动器） | 2026-11-10 |
| `deepagents` | DeepAgents | `npx -y deepagents-acp@0.1.7` | documented | 不自动发现（npx 启动器） | 2026-11-10 |
| `junie` | JetBrains Junie | `junie --acp=true` | preview（EAP） | `junie` | 2026-11-08 |
| `opencode-acp` | OpenCode ACP | `opencode acp` | documented | `opencode` | 2026-11-08 |
| `copilot` | GitHub Copilot CLI | `copilot --acp --stdio` | preview（预览） | `copilot` | 2026-11-08 |
| `goose` | Goose CLI | `goose acp` | documented | `goose` | 2026-11-08 |
| `kiro` | Kiro CLI | `kiro-cli acp` | documented | `kiro-cli` | 2026-11-08 |
| `cursor` | Cursor Agent CLI | `agent acp` | documented | `agent` / `cursor-agent`（真实路径需含 cursor） | 2026-11-08 |
| `qwen` | Qwen Code CLI | `qwen --acp` | documented | `qwen` | 2026-11-08 |
| `auggie` | Auggie CLI | `auggie --acp` | documented | `auggie` | 2026-11-08 |
| `factory-droid` | Factory Droid | `droid exec --output-format acp-daemon` | documented | `droid` | 2026-11-08 |
| `cline` | Cline CLI | `cline --acp` | documented | `cline` | 2026-11-08 |
| `devin` | Devin for Terminal | `devin acp` | documented | `devin` | 2026-11-10 |
| `hermes` | Hermes | `hermes acp` | documented | `hermes` | 2026-11-10 |
| `kilo` | Kilo Code | `kilo acp` | documented | `kilo` | 2026-11-10 |
| `reasonix` | DeepSeek Reasonix | `reasonix acp` | documented | `reasonix` / `dsnix` | 2026-11-10 |
| `trae-cli` | Trae CLI | `traecli acp serve` | documented | `traecli` | 2026-11-10 |
| `grok-build-acp` | Grok Build ACP | `grok agent stdio` | documented | `grok` | 2026-11-10 |
| `claude-acp` | Claude Agent ACP | `npx -y @agentclientprotocol/claude-agent-acp@0.85.1` | community | 不自动发现（npx 启动器）；查找 `claude-agent-acp`/`claude-code-acp` | 2026-11-08 |
| `codex-acp` | Codex ACP | `npx -y @agentclientprotocol/codex-acp@2.1.1` | community | 不自动发现（npx 启动器）；查找 `codex-acp` | 2026-11-08 |
| `codebuddy` | CodeBuddy Code | `npx -y @tencent-ai/codebuddy-code@2.161.1 --acp` | documented | `codebuddy`（发现已安装的原生 `codebuddy --acp`） | 2026-11-08 |
| `minimax-code` | MiniMax Code | `npx -y @minimax-ai/code@0.2.7 acp` | documented | 不自动发现（npx 启动器） | 2026-11-10 |
| `glm` | GLM Agent | `npx -y glm-acp-agent@1.17.0` | documented | 不自动发现（npx 启动器） | 2026-11-10 |
| `grok` | Grok Build Agent | `npx -y @xai-official/grok@1.0.79 agent stdio` | documented | 不自动发现（npx 启动器） | 2026-11-10 |

- `oaa init`：在 PATH 中按文件名查找上表的可执行文件（只读取文件元数据，不执行），把找到的写入 `localWorker.adapters`，**全部为停用**。
- `oaa doctor`：列出已发现的 ACP 智能体及其是否已配置；`oaa doctor --write` 只把尚未配置的追加为停用条目（不改动已有条目，可重复执行），写入后需重启网关。
- 同名文件可能属于其他工具（如 `goose`、`copilot`、`kilo`、`hermes`、`cortex`），发现结果只是「文件名匹配」；启用前可用下面的握手检查确认身份。`agent` 只有在真实路径包含 `cursor` 时才视为 Cursor。
- `npx` 启动器预设只是模板。`claude-acp`、`codex-acp` 在全局安装后会查找 `claude-agent-acp`/`claude-code-acp`、`codex-acp`（按包名推断的可执行文件名，未逐一核验）。

### 控制台接口

- `GET /v1/local/backends`（owner 管理员密钥）：`data` 为已配置的后端，每项 `{engine, kind: "native"|"acp"|"adapter", transport?, preset?, name, executable, args?, enabled, maturity?, docs_url?, verified?, publishable, evidence, handshake?, conversion}`（A2A/HTTP 适配器的 `executable` 为端点 URL，没有 `args`）；原生项保留 `model_overrides`。`publishable` 表示已启用且可执行文件存在（http 适配器为端点与令牌就绪）。`evidence` 为 `installed_not_exercised`、`not_installed` 或 `handshake_passed`。另返回 `presets`：4 个原生引擎与 32 个 ACP 预设的完整目录（含 `configured`、`engine`、`installed_executable`、`launcher`、`notes`、`verified`、`conversion`）。
- `POST /v1/local/backends/:engine` `{enabled}`：`:engine` 为原生名或 URL 编码的 `adapter%2F<名称>`（也接受 `/v1/local/backends/adapter/<名称>`）。只改本平台数据库与内存中的 worker 配置，不改原生应用的全局配置；可执行文件变化后，已保存的启用状态自动失效。
- `POST /v1/local/backends/adapter%2F<名称>/check`：owner 显式触发的握手检查，不会启用适配器。ACP 只在空的临时目录中执行 `initialize`，不创建会话、不发送提示、不调用模型，结果记为 `handshake_passed`（含智能体名称、版本、`load_session`、认证方式），并据此细化该条目 `conversion.resume`；A2A 只读取 agent card（见「A2A 远程智能体」）。其它适配器返回 `400 check_unsupported`。
- `POST /v1/agents/publish-native` `{id, engine, models, approvals?}`（`approvals` 为 `ask` 或 `auto`，见上文「发布时的审批策略」）：`engine` 可为原生名，或任一在线节点已启用（已通告）的 `adapter/<名称>`；未启用时返回 `409 backend_not_enabled`。`models` 中的 `default` 表示沿用该智能体自己的模型。CLI：`oaa publish-native --engine adapter/gemini --models default`。
- `/v1/overview`：智能体的 `engine` 保持 `adapter/<名称>`，并新增可选的 `preset`（图标 id）与 `conversion`（转换能力画像，见上文）。

### 尚未验证的边界

- 普通测试只使用本地假智能体（`test/fixtures/acp-agent.mjs`；转换契约矩阵另用 `native-full.mjs`、`claude-code.mjs`、`stream-adapter.mjs` 与进程内 HTTP/A2A 假远端），覆盖握手、流式输出、会话续接、审批批准/拒绝、取消与强制终止、模型确认和各类失败；**尚未对任何真实 ACP 或 A2A 智能体做过联调**，各厂商实现差异（认证流程、`session/resume` 支持、显式模型选择方式、A2A 1.0/0.3 实现细节等）需要逐一确认。
- 厂商扩展方法（如 Cursor 的问答/计划、Kiro 扩展）不桥接，按 `-32601` 不支持处理；图片/音频等非文本输出只记进度、不写入输出。图片**输入**是支持的，见 [images.md](images.md)。
- 只在 macOS 上验证；Windows 的进程组终止与 PATH 发现尚未测试。
- 远程 worker 通过同一 `oaa/1` 协议转发流式文本与审批，但 ACP 在远程节点上的端到端路径尚未单独测试。

## A2A 远程智能体（2026-11-08）

> 本节为新增内容。`transport: "a2a"` 把一个实现 [A2A（Agent2Agent）协议](https://a2a-protocol.org/latest/specification/) 的远程智能体发布为 `adapter/<名称>`。

```json
{
  "adapters": {
    "research-peer": {
      "transport": "a2a",
      "url": "https://agents.example.com/a2a",
      "tokenEnv": "RESEARCH_PEER_TOKEN",
      "enabled": false
    }
  }
}
```

- 版本：A2A 1.0.0 于 2026-03-12 发布（当前 1.0.1），方法名、对象形状和枚举都与 0.3 不同。OAA 默认按 **1.0** 发送：`SendStreamingMessage`（SSE）/ `SendMessage` / `CancelTask`，请求头 `A2A-Version: 1.0`，`role: "ROLE_USER"`，文本 part 为 `{"text": …}`（不带 `kind`）。对方只支持 0.3 时设置 `"protocolVersion": "0.3"`，改用 `message/stream` / `message/send` / `tasks/cancel`、`kind` 判别字段和 `blocking: true`。无论选哪种，两种版本的响应都能读取（1.0 的 `task` / `message` / `statusUpdate` / `artifactUpdate` 成员与 `TASK_STATE_*` 状态，0.3 的 `kind` 与小写状态），这也是 1.0 迁移说明对客户端的建议。只实现 JSON-RPC 绑定，gRPC 与 HTTP+JSON 绑定未实现。
- 传输：非本机地址必须是 `https:`，URL 不能含账号密码，不跟随重定向。`"streaming": false` 时改用非流式请求。`tokenEnv` 指定的环境变量以 `Authorization: Bearer` 发送，值只留在 worker 环境中；变量缺失时以 `adapter_not_configured` 失败且不发出请求。
- 请求：一条用户消息，续接时带上一轮的 `contextId`；`acceptedOutputModes` 为 `text/plain`、`text/markdown`。已发布的 instructions 放在任务文本前面。
- 映射：智能体消息与 artifact 更新中的文本 part 写入输出；非终止的状态更新记为进度。任务进入终止或中断状态即结束本轮（1.0 的状态更新没有 `final` 字段，流在这些状态后关闭）：`completed` 成功；`failed`/`rejected` 为 `adapter_incomplete`；`canceled` 为 `native_incomplete`；`input-required`/`auth-required` 以智能体的问题作为本轮输出，用 `previous_response_id` 回复时续接同一 `taskId`。流在非终止状态结束（含 0.3 的 `final: true` 停在 `working`）为 `native_incomplete`。
- 取消：中止请求，并尽力发送 `CancelTask`（0.3 为 `tasks/cancel`，5 秒超时）。
- 失败：HTTP 401/403 为 `adapter_auth_required`；其它非 2xx 或 JSON-RPC 错误为 `adapter_failed`（错误文本脱敏）；非法 JSON 或无法识别的结果为 `invalid_protocol`；响应或流超过 8 MiB 为 `adapter_output_limit`。
- 握手检查：`POST /v1/local/backends/adapter%2F<名称>/check` 只读取 `/.well-known/agent-card.json`（1.0 与 0.3 相同；再尝试旧路径 `/.well-known/agent.json`），返回名称、版本、`protocol_versions`（0.3 的 `protocolVersion` 与 1.0 `supportedInterfaces[].protocolVersion`）、`bindings`（如 `JSONRPC`）、是否声明流式与技能数量，可据此判断是否需要 `protocolVersion: "0.3"`；不发送消息、不创建任务、不调用模型，也不会启用适配器。
- 只有在任务运行或 owner 请求检查时才会联系配置的端点。

取舍：A2A 让 OAA 能把「别处托管的智能体」纳入同一个目录与审批/记录体系，但它天然没有共享工作区（`artifacts: false`）、没有运行中审批通道（只有 `input-required` 的问答式交接）、也不报告用量；远端是否真正停止由远端实现决定。因此它适合把远程智能体当作「可调用的同事」，不适合需要在本机工作区里改文件、或需要逐项人工审批的任务——后者应在本机用 ACP 或 `oaa/1-stream` 接入。目前核实到提供官方 A2A 服务的只有 Gemini CLI（`@google/gemini-cli-a2a-server`，标注 experimental），其余主流编码智能体的 A2A 支持均为「待验证」。

参考：`src/engines/a2a.ts`；测试中的进程内 A2A 假智能体（同时模拟 1.0 与 0.3）见 `test/conformance.test.ts`。

## 主流智能体接入核实（2026-11-08）

> 逐个对照厂商官方文档（只读调研，未安装、未运行任何智能体）核实程序化接入方式。「核实」列为日期的条目已对照官方来源；标「待验证」的没有找到官方来源或未覆盖。等级是按推荐方式接入后 OAA 能提供的上限（即 `conversion.tier`）；真实智能体是否真的逐段输出、是否在执行前发出审批请求，没有经过联调。

| 智能体 | OAA 推荐接入 | 预设 / 引擎 | 成熟度 | 等级 | 核实 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | 内置原生（Agent SDK） | `claude`；ACP 另有 `claude-acp` | 原生 / community | interactive | 2026-11-08 | Anthropic 没有原生 ACP，`claude-acp` 是 ACP 组织维护的适配器。⚠️ Anthropic 文档写明：未经批准，第三方产品不得向用户提供 claude.ai 登录或订阅额度，须使用 API key——把基于个人订阅的 Claude Code 发布给他人调用前请确认合规。headless 另有 `claude -p --output-format stream-json`（`-p` 自 v2.1.302 起默认拒绝无人批准的请求）。[^claude] |
| Codex CLI | 内置原生（app-server） | `codex`；ACP 另有 `codex-acp` | 原生（官方标注 Experimental）/ community | interactive | 2026-11-08 | OpenAI 没有原生 ACP；`codex exec --json` 为 JSONL headless，默认只读沙箱；`codex mcp-server` 已移除。[^codex] |
| Gemini CLI | ACP（或 A2A） | `gemini` | documented | interactive | 2026-11-08 | `--experimental-acp` 为已弃用别名；2026-06-18 起免费层与 Google One 用户由 Antigravity CLI 取代。官方 A2A 服务 `@google/gemini-cli-a2a-server`（experimental）可用 `transport: "a2a"` 接入（streaming 等级）。[^gemini] |
| Antigravity CLI | 内置原生（stream-json） | `antigravity`；ACP `antigravity-acp` | 原生 / documented | streaming | 原生已核实（2026-11-02）；ACP 启动命令已核实（2026-11-10） | 无头模式没有审批桥接通道，智能体自身拒绝即 `permission_denied`。 |
| Qwen Code | ACP | `qwen` | documented | interactive | 2026-11-08 | `--experimental-acp` 已弃用；另有 `qwen serve` HTTP+SSE 守护进程（未接入）。[^qwen] |
| Kimi Code | ACP | `kimi` | documented | interactive | 2026-11-08 | 支持 `session/load`、`resume`、`fork`；`kimi -p` headless 不请求人工审批（按 auto 策略执行）。[^kimi] |
| OpenCode | ACP | `opencode-acp` | documented | interactive | 2026-11-08 | v2 的 HTTP API 与 SDK 有破坏性变更；OAA 只用 `opencode acp`（stdio）。[^opencode] |
| Goose | ACP | `goose` | documented | interactive | 2026-11-08 | 官方推荐以 ACP 作为客户端集成接口；`goose serve` 的 HTTP/WS ACP 需密钥（未接入）。[^goose] |
| Cursor Agent | ACP | `cursor` | documented | interactive | 2026-11-08 | `agent acp`（帮助中标为 advanced 并隐藏；Registry 写作 `cursor-agent acp`）。[^cursor] |
| GitHub Copilot CLI | ACP | `copilot` | preview（公开预览） | interactive | 2026-11-08 | `copilot --acp --stdio`；Copilot SDK 已于 2026-06-02 GA（未接入）。[^copilot] |
| Cline | ACP | `cline` | documented | interactive | 2026-11-08 | ACP 模式默认不自动批准；命令行任务模式默认自动批准，包装 headless 时须显式关闭。[^cline] |
| Amp | ACP（社区适配器）或 `oaa/1-stream` 包装 | `amp-acp` | community | interactive | 2026-11-08 | Amp 官方没有 ACP；官方程序化接口为 `amp -x --stream-json`（称尽量兼容 Claude Code 格式）与 `@ampcode/sdk`。[^amp] |
| Augment Auggie | ACP | `auggie` | documented | interactive | 2026-11-08 | 1.x（预发布）改了 headless 参数，不影响 ACP。[^auggie] |
| Factory Droid | ACP | `factory-droid` | documented | interactive | 2026-11-08 | 官方 Zed 文档写作 `droid exec --output-format acp`，Registry 为 `acp-daemon`（预设采用后者）。[^factory] |
| Kiro CLI | ACP | `kiro` | documented | interactive | 2026-11-08 | Registry 额外传 `--agent-engine=v3`。[^kiro] |
| Qoder CLI | ACP | `qoder` | documented | interactive | 2026-11-08 | iFlow 官方建议迁移到 Qoder。[^qoder] |
| Mistral Vibe | ACP | `vibe` | documented | interactive | 2026-11-08 | `vibe-acp` 随 CLI 安装。[^vibe] |
| JetBrains Junie | ACP | `junie` | preview（EAP） | interactive | 2026-11-08 | Junie CLI 仍处于抢先体验阶段。[^junie] |
| CodeBuddy Code | ACP | `codebuddy` | documented | interactive | 2026-11-08 | 厂商原生 `codebuddy --acp`；支持发现已安装的 `codebuddy`。[^codebuddy] |
| TRAE CLI | ACP | `trae-cli` | documented | interactive | 2026-11-08 | 全局参数须写在 `acp serve` 之前；与开源 bytedance/trae-agent 不是同一工具。[^trae] |
| Aider | `oaa/1` stdio 包装 | 无预设 | — | basic | 2026-11-08 | 没有 ACP，也没有 JSON 输出；可包装 `aider --message "…" --yes --no-stream`，只有最终结果。[^aider] |
| OpenHands | ACP（手动配置） | 无预设 | — | interactive（未测试） | 2026-11-08 | 有 `openhands acp`，但官方声明 CLI 不再维护，且控制台没有图标，未加入预设。[^openhands] |
| iFlow CLI | 不接入 | 无预设 | — | — | 2026-11-08 | 已于 2026-04-17 停服。[^iflow] |
| DeepSeek Harness、Snowflake Cortex Code、pi、DeepAgents、Devin、Hermes、Kilo、Reasonix、Grok Build、MiniMax Code、GLM | ACP | 见预设目录 | 沿用 Registry 标注 | — | 2026-11-10（启动命令） | 启动命令已对照厂商文档或 Registry 核实（见预设目录）；接入等级没有逐一核实。 |

包装 headless CLI（`oaa/1` / `oaa/1-stream`）时要特别注意审批默认值：Claude、Vibe、Copilot 在无人值守时默认拒绝需审批的调用；Codex、Factory 默认只读；Cline 命令行任务、Amp、Goose `GOOSE_MODE=auto` 默认放行。适配器必须显式设置这些参数并配合沙箱，否则「最终结果」可能来自未经审批的操作。能用 ACP 的智能体应优先用 ACP，以获得 OAA 的逐项审批。

[^claude]: https://code.claude.com/docs/en/agent-sdk/quickstart ；https://code.claude.com/docs/en/headless ；https://code.claude.com/docs/en/cli-reference
[^codex]: https://learn.chatgpt.com/docs/app-server ；https://learn.chatgpt.com/docs/non-interactive-mode ；https://learn.chatgpt.com/docs/developer-commands?surface=cli
[^gemini]: https://geminicli.com/docs/cli/acp-mode/ ；https://geminicli.com/docs/cli/headless/ ；https://github.com/google-gemini/gemini-cli/tree/main/packages/a2a-server
[^qwen]: https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/ ；https://qwenlm.github.io/qwen-code-docs/en/developers/examples/daemon-client-quickstart/
[^kimi]: https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.md ；https://moonshotai.github.io/kimi-code/en/reference/kimi-command.md
[^opencode]: https://docs.opencode.ai/docs/acp/ ；https://opencode.ai/docs/migrate-v1/
[^goose]: https://goose-docs.ai/docs/gdk/acp/ ；https://goose-docs.ai/docs/guides/goose-cli-commands/
[^cursor]: https://cursor.com/docs/cli/acp ；https://cursor.com/docs/cli/reference/parameters
[^copilot]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server ；https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/
[^cline]: https://docs.cline.bot/usage/acp ；https://docs.cline.bot/cli/cli-reference
[^amp]: https://ampcode.com/docs/cli/execute-mode ；https://ampcode.com/docs/cli/streaming-json ；https://ampcode.com/docs/sdk
[^auggie]: https://docs.augmentcode.com/cli/reference ；https://docs.augmentcode.com/cli/whats-new
[^factory]: https://docs.factory.com/integrations/zed ；https://docs.factory.com/reference/cli-reference
[^kiro]: https://kiro.dev/docs/cli/acp/ ；https://kiro.dev/docs/cli/headless/
[^qoder]: https://docs.qoder.com/cli/cli-reference
[^vibe]: https://docs.mistral.ai/vibe/code/use-vibe-in-other-ides ；https://docs.mistral.ai/vibe/code/cli/work-with-cli
[^junie]: https://junie.jetbrains.com/docs/junie-cli-acp.html ；https://junie.jetbrains.com/docs/parameters.html
[^codebuddy]: https://codebuddy.ai/docs/cli/cli-reference ；https://codebuddy.ai/docs/cli/headless
[^trae]: https://docs.trae.cn/cli_agent-client-protocol ；https://docs.trae.cn/cli_get-started-with-trae-cli
[^aider]: https://aider.chat/docs/scripting.html
[^openhands]: https://docs.openhands.dev/openhands/usage/cli/command-reference
[^iflow]: https://platform.iflow.cn/en/cli/changelog

## Antigravity 协议核实

内置适配器遵循官方的[无头 stream-JSON 约定](https://antigravity.google/docs/cli/headless/)：输入使用带 `message.content` 的 `event: "user"`，而不是 Claude 风格的 `type: "user"` 信封。它先等待 `init`，精确确认显式选择的模型，之后才发送任务。模型缺失或不一致时，在发送提示词之前就失败。拒绝与不成功的终止结果不会被「进程退出码为 0」掩盖。某个工具步骤的 `tool_info.error`（字符串，或按其 JSON 文本读取的对象）与 stderr 中的拒绝措辞（`soft-denied`、`permission … denied`、`requires approval`）相符时，本轮以 `permission_denied` 失败；其它工具错误视为智能体可以自行恢复的工具失败，由它自己的终止结果决定本轮，没有成功结果的一轮为 `native_incomplete`。已发布的约定没有规定 `tool_info.error` 的确切形状，也没有在真实的拒绝中观察到过；措辞规则偏保守。

首轮会话的用量在三项提供方计数器都是有效的非负整数时记录。该 CLI 在文档里说明其用量是会话累计值，所以续接后的总数只作为观察到的原生状态保留，不当作每次调用的计费。不推算任何金额。

2026-11-02，一次经授权的隔离 `gemini-3.8-flash-low` 任务通过：init 事件确认了该模型；两次原生 `read_file` 操作读到了提供的夹具文件；回答里有正确的总数和一个无法预测的文件标记。第一次尝试在流式输入校验处失败，单独保留。这并不是对每个已安装插件、其它原生模型、跨机器执行或生产就绪程度的核实。常规测试套件从不调用真实模型；单独的验收脚本需要显式的费用确认标志和一个全新的输出目录。

### agy（Antigravity）的 ACP 入口：实测记录（2026-11-11）

`agy acp` 是 Antigravity 命令行自带的 ACP stdio 服务（1.5.3 起可用）。把它配成 ACP 适配器即可发布，不需要额外安装：

```json
{ "adapters": { "agy": { "transport": "acp", "command": "/path/to/agy", "args": ["acp"], "enabled": true } } }
```

- 模型名用它在 ACP 会话里声明的取值：`gemini-3.8-flash`、`gemini-4-argon`、`claude-opus-5-5`、`claude-sonnet-5-5` 等。命令行里的 `gemini-3.8-flash-low` 这类带思考强度后缀的名字不是 ACP 的模型选项，用它会在发送任务前得到 `model_not_supported`。思考强度是单独的选项 `thought_level`，目前沿用 agy 的默认值。
- 支持会话续接（声明了 `loadSession` 与 `resume`）与调用方工具桥接；调用 MCP 工具时默认模式下不发起权限请求。
- 与内置的 `antigravity` 原生引擎（`agy --print` 的 stream-json）是两条独立的接入路径。
