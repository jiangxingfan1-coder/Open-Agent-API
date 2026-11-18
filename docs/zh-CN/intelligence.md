# 智能选路、多智能体编排与模型评测

[English](../intelligence.md) · 简体中文

当你把一个智能体发布成 API 后，调用方不仅能固定走某一条模型线路，还可以让网关根据**速度、质量、成本、实时配额与本地实测得分**自动选路，或把复杂任务拆解给多个智能体协同完成。

---

## 调用时的选路语法

在 OpenAI、Claude、Gemini 等所有兼容入口中，`model` 字段支持统一的选路后缀：

| `model` 写法 | 行为说明 |
| --- | --- |
| `agent/coder`（或 `@auto`） | **自动选路**：综合配置的线路优先级、近期延迟、上游冷却状态与本地评测分数动态选择可用模型 |
| `agent/coder@fast` | **速度优先**：优先选择实测响应延迟最低的合格模型线路 |
| `agent/coder@best` | **质量优先**：优先选择评测得分更高、并在启用编排时附带规划与质量复核的线路 |
| `agent/coder@eco` | **成本优先**：优先选择单位成本更低或订阅配额充裕的线路 |
| `agent/coder@<具体模型名>` | **固定线路**：直接指定已声明或已发现的模型标识，跳过自动编排，且绝不暗中更换模型 |

### 仅输出执行方案（`recommend` 规划模式）

如果你想先看网关打算怎么拆解任务、选哪个模型，而不实际执行工具调用，可以在请求中开启 `recommend` 模式：

```json
{
  "model": "agent/coder@best",
  "input": "重构订单导出接口并补齐并发回归测试",
  "metadata": {
    "oaa.orchestration_action": "recommend"
  }
}
```

也可以通过请求头 `X-OAA-Orchestration: recommend`（或在控制台「对话工作台」勾选「仅生成编排建议」）触发。网关会运行无工具规划器（`toolsDisabled`），直接返回包含 `agent`、`mode`、`stages` 与 `executed: false` 的结构化 JSON 方案。

---

## 跨引擎智能编排与多智能体流水线

无论底层是内置内核智能体，还是 Codex、Antigravity、Qoder 等外部智能体，均可在发布时开启编排能力：

1. **单智能体多模型池编排（`scope: "agent"`）**：在同一个智能体挂载的多条模型线路之间分工完成规划（`plan`）、执行（`execute`）与复核（`review`）。
2. **专职规划器绑定（`orchestration.planner`）**：对于不便直接做无工具规划的外部引擎，可显式指定另一个已授权智能体担任 `planner`，将规划与复核交由规划器完成，主执行阶段仍留在目标引擎。
3. **跨智能体协作流水线（`scope: "helpers"`）**：在发布配置中声明可协作的 `helpers` 智能体集合，由编排器按阶段自动拆分子任务、通过结构化 `handoff` 传递上下文与文件产物。

### 发布配置示例（自动模型发现 + 编排开启）

```json
{
  "id": "agent/my-agent",
  "engine": "antigravity",
  "models": ["default"],
  "model_policy": { "mode": "discover" },
  "access": {
    "modes": ["managed"],
    "defaultMode": "managed",
    "approval": "ask",
    "trust": "private"
  },
  "orchestration": {
    "enabled": true,
    "scope": "agent"
  }
}
```

对于已发布的智能体，可在控制台智能体详情页打开 **「API 执行策略」** 弹窗（底层调用 `POST /v1/agents/policy`），一键切换人工审批 / 自动批准（`ask` / `auto`）或启停自动编排，网关会自动生成新的不可变版本。

---

## 本地五维模型评测与配额感知

为了避免只靠模型名字盲猜强弱，网关内置了可选的轻量级本地评测器与配额快照联动：

- **五大实测维度**：涵盖算术推理、代码推演、指令遵循、结构化数据输出与工具调用（`tool_calling`）五个维度。
- **克制的后台预算**：默认关闭；手动开启后每 24 小时最多运行一轮（单智能体每日上限 48 次样本调用，正常业务请求始终优先插队）。累积满 4 个有效样本后，实测准确率与耗时才会纳入自动选路权重；模型配置变更或超过 7 天后旧样本自动失效。
- **人工反馈与公开参数源**：管理员可通过 `POST /v1/local/evaluations/feedback` 对真实运行结果标记通过/未通过（不额外消耗模型调用），也可配置无凭据公开 HTTPS JSON 数据源映射上下文窗口与参考单价。
- **实时配额避障**：当上游账号提供明确的额度快照（见 [用量与额度](usage-monitor.md)）且某条线路配额耗尽时，自动选路会主动绕开该线路。

---

## 导入 EverythingACP 本地适配器

如果你使用 [EverythingACP](https://agentclientprotocol.com) 将其他 CLI 工具包装成了 ACP 客户端，可在控制台 **「执行机器」** 页直接选择输出目录自动发现包装器，或通过接口导入 `client.json`：

| 本机管理接口 | 用途 |
| --- | --- |
| `GET /v1/local/evaluations?agent=...` | 查询指定智能体的评测配置、支持状态、各维度得分与最近记录 |
| `POST /v1/local/evaluations/settings` | 更新评测开关、周期间隔与每日调用上限 |
| `POST /v1/local/evaluations/run` | 在每日预算范围内立即排入一次后台评测 |
| `POST /v1/local/evaluations/feedback` | 记录管理员对某次真实任务（`run_id`）的质量反馈 |
| `POST /v1/local/everything-acp/import` | 按本机绝对路径导入 EverythingACP 的 `client.json` 描述文件（导入后默认停用，确认启用并发布后生效） |
