# 智能 Agent API

[English](../intelligence.md) · 简体中文

## 本轮已实现

实现已继续推进到后续能力。[持久 Agent 工作台](workstation.md) 说明了项目记忆、持久检查点、可视化／可复用工作流及触发器、媒体任务、真实任务反馈、公开 JSON 资料和跨平台桌面构建。

- `/v1/agents/publish-native` 新发布默认自动批准。已有发布保留显式策略；签名包发布不会被改写。需要人工审批时设置 `approvals: "ask"` 或显式 `access.approval`。宿主权限与密钥限制仍然生效。Antigravity 优先使用 ACP 审批桥，无 ACP 时使用仅本次启动的自动批准参数，不改变原智能体全局设置。
- 新外部智能体编排发布默认使用 `scope: "agent"`。固定模型不启动编排；智能模式即使遇到短任务也先调用规划模型。规划、分析、复核只在选定 Agent 的模型池内进行。旧发布保留原有快捷路径。
- `X-OAA-Orchestration: recommend` 或 `metadata["oaa.orchestration_action"]: "recommend"` 只规划，不执行计划阶段。返回文本为包含 `agent`、`mode`、`stages`、`executed: false` 的 JSON。正常执行用 `execute` 或省略；仅规划要求自动选模且发布已启用编排。它不是权限审批。
- 模型评测有控制台弹窗、私有 SQLite 记录、设置版本检查、每日调用上限和单路后台队列。本机可执行文件、配置、发布定义或模型目录变化会使旧测量失效。目前测量算术推理、代码推演、指令遵循和结构化数据四个维度。小型生成题目不等于综合智力测试，也不能证明工具使用能力。
- 至少四个有效样本后，实测分数和耗时参与选路。传输、认证失败与答案错误分开记录；七天后证据过期。不从模型名称猜测强弱。
- 新鲜、身份无歧义的额度快照可排除智能模式的不可用线路；未知或过期信息不阻断调用。有可用订阅窗口时，API 点数为零不会阻断订阅。存在多个账号但无法对应运行身份时，不据此自动排除。固定模型不会偷偷更换。
- 执行机器页和 API 均可导入本机 EverythingACP 的 `client.json`。导入后保持停用，启用并发布后才能调用；重启后保留，不复制或改动包装器，不导入环境密钥。转换核心仍由独立 EverythingACP 项目维护。

## API 示例

使用发现接口返回的模型，不猜测供应商模型标识：

```json
{
  "id": "agent/my-agent",
  "engine": "antigravity",
  "models": ["MODEL_FROM_DISCOVERY"],
  "model_policy": {"mode": "discover", "allow": ["MODEL_FROM_DISCOVERY"]},
  "access": {"modes": ["managed"], "defaultMode": "managed", "approval": "auto", "trust": "private"},
  "orchestration": {"enabled": true, "scope": "agent"}
}
```

现有兼容接口接受 `agent/my-agent@<线路>` 固定模型、`agent/my-agent@fast`、`@best`、`@eco`，或 `agent/my-agent` 自动选择。仅规划请求：

```json
{
  "model": "agent/my-agent@best",
  "input": "为请求的任务制定方案",
  "metadata": {"oaa.orchestration_action": "recommend"}
}
```

以下本机管理接口要求本地安全配置、直接回环连接、同源及所有者全域管理员：

| 接口 | 用途 |
| --- | --- |
| `GET /v1/local/evaluations?agent=...` | 设置、`settings_revision`、支持状态、分数与最近错误 |
| `POST /v1/local/evaluations/settings` | `{agent, revision, settings:{enabled, intervalHours, maxCallsPerDay}}` |
| `POST /v1/local/evaluations/run` | `{agent}`，在已开启的每日预算内安排评测 |
| `POST /v1/local/everything-acp/import` | `{id, client_file}`，导入网关机器上 `client.json` 的绝对路径 |

智能体详情的 **API 执行策略** 弹窗用于显式迁移已有发布。`POST /v1/agents/policy` 接受 `{agent, version, approval:"ask"|"auto", orchestration:boolean}`，创建新的不可变版本并保留其余定义和包文件，拒绝过期版本。没有 access 策略的内核智能体仍需显式编辑定义，因为其审批声明在每个工具上。

评测默认关闭，开启后每 24 小时一轮，每个已发布 Agent 每日最多 48 次样本调用，每模型每轮八题。主动开启即授权这些调用；题目之间让正常任务优先。不向评测模型发送用户的私人任务正文，也不自动联网搜索榜单。

## 验证与剩余工作

2026-11-17 在隔离的 macOS 网关中，真实 Codex 和 Antigravity 返回了指定的固定文本；Claude Code 因命令行未登录返回 `adapter_auth_required`。独立生成的 EverythingACP Codex 包装器已通过 OAA 完成真实调用。Antigravity 使用两个发现到的模型选项，跑通固定模型、仅规划、速度和质量场景。这些小任务只证明调用路径，不证明更快或更强：固定调用约 10 秒，仅规划约 61 秒，速度模式约 83 秒，质量模式约 96 秒。质量复核来自 Agent，不是独立正确性证据。

一次未完成的真实评测发现：代码题答案正确，但模型无视 JSON-only 要求套上 Markdown。更新后的题库将推理／代码正确性与严格格式遵循分开；指令和结构化输出仍严格评分。修订后的八题评测随后在 Antigravity 当前默认模型上完成，八题全部通过，平均每题约 40 秒。这只是一次小型能力采样，不是与其他模型的排名比较；测试后的临时评测设置已恢复关闭。

另一次真实 Antigravity 调用在不回 OAA 审批的情况下生成 `outputs/proof.txt`，下载内容与 `OAA_ARTIFACT_OK` 完全一致，没有待处理操作。这只验证了一条真实产物流，不代表任意文件任务都可靠。

原生 Codex 通道也完成了免确认的文件写入，下载的 `codex-proof.txt` 与 `OAA_CODEX_AUTO_OK` 完全一致。两次探测都没有修改已安装桌面应用的配置。

Codex 与通用 ACP 适配器现已支持强制禁用工具的无工具推理轮次（`toolsDisabled`），不透明外部引擎也可绑定已授权的专职 `orchestration.planner` 智能体（`plan` / `review` 路由至规划器、`execute` 保留在主智能体）或运行 `scope: "helpers"` 跨智能体分工流水线，并配备结构化 `handoff` 与第 5 维 `tool_calling` 评测；流式大文件产物默认上限已提升至 `64 MiB`（最高可配至 `256 MiB`）。现已能在显式选定的目录里发现任意已生成的 EverythingACP 包装器，不依赖品牌白名单，也不执行它们。剩余边界包括广泛独立模型质量评测、配置 JSON 来源之外的通用网页搜索、未确认宿主副作用的恢复，以及 Windows/Linux 真机验收。本轮不宣称所有 Agent、综合智力排名、编解码质量或生产发布均已完成。
