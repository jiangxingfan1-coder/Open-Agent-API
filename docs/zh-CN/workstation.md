# 工作台、共享项目记忆与可复用工作流

[English](../workstation.md) · 简体中文

除了把单个智能体包装成无状态 HTTP 接口，Open Agent API 还提供跨会话的**共享项目记忆**、抗中断的**持久长任务**、支持定时与事件触发的**可视化 DAG 工作流**、大体积**流式媒体产物**以及三端统一的 **Electron 桌面应用**。

---

## 项目空间与共享记忆（SQLite FTS5）

控制台左侧的 **「项目」** 视图用于管理多轮任务与多智能体之间的共享上下文，同时与调用方各自的私人记忆严格隔离：

- **细粒度成员授权**：所有者管理员创建项目后，可按调用方身份（默认为 API 密钥 ID）授予 `read`（只读）、`write`（读写）或 `none` 权限。
- **零外部依赖的全文检索**：内置基于 SQLite FTS5 的 BM25 全文检索引擎。配置了 `memory_read` / `memory_write` / `memory_search` 工具的内核智能体可传入 `scope: "project"` 读写共享记忆；外部智能体在执行关联项目的任务时，会自动获得按当前提示词相关性排序的项目记忆摘要。
- **调用方式**：在任意协议请求中传入 `metadata["oaa.project"] = "<项目 ID>"`（或在控制台「对话工作台」左侧下拉框选择项目）即可关联；若某次任务不希望自动沉淀摘要，可传 `metadata["oaa.project.remember"] = "false"`。

| 项目与记忆接口 | 说明 |
| --- | --- |
| `GET /v1/projects` | 列出当前密钥有权访问的项目 |
| `POST /v1/projects` | 管理员创建项目：`{id, name}` |
| `GET /v1/projects/{id}/members` | 查看项目成员权限列表 |
| `POST /v1/projects/{id}/members` | 设置成员权限：`{subject, access: "read" \| "write" \| "none"}` |
| `GET /v1/projects/{id}/memory` | 读取项目共享记忆条目 |
| `GET /v1/projects/{id}/memory/search` | BM25 全文检索（`?q=...&namespace=...&limit=...`） |
| `PUT /v1/projects/{id}/memory` | 新增或按修订号更新条目：`{namespace, key, value, revision?}` |
| `DELETE /v1/projects/{id}/memory` | 按 `{namespace, key, revision}` 安全删除条目 |

---

## 持久长任务（Durable Runs）

对于耗时数十分钟甚至跨天的大型研发或数据处理任务，网关将其作为持久化状态机托管，而非绑死在单条 HTTP 连接上：

- **客户端断连不丢任务**：调用方网络断开或关闭桌面主窗口，都不会中断后台正在执行的任务。
- **检查点与重启恢复**：传入 `metadata["oaa.durable"] = "true"` 可启用持久恢复预算（`oaa.max_resume_attempts` 默认 10 次，最高 100 次；通过「API 执行策略」可将任务总时长上限放宽至最高 168 小时）。网关重启后会复用已落盘的步骤检查点；若中断发生在结果未确认的宿主机写操作阶段，任务会安全停下等待人工确认，绝不盲目重放副作用。

---

## 可复用工作流（DAG 编排 · Cron · 入站 Webhook）

在控制台 **「工作流」** 视图中，你可以用可视化阶段图、JSON 编辑器或自然语言草稿，把多个智能体串联/并联成固定流水线：

```json
{
  "definition": {
    "id": "report-review",
    "name": "周报撰写与交叉复核",
    "graph": {
      "steps": [
        { "id": "write", "tool": "agent/writer", "arguments": { "input": { "$ref": "input#/task" } } },
        { "id": "review", "tool": "agent/reviewer", "arguments": { "input": { "$ref": "write#/output" } }, "depends_on": ["write"] }
      ],
      "output": { "$ref": "review#/output" }
    },
    "trigger": { "kind": "cron", "expression": "0 9 * * 1", "timezone": "Asia/Shanghai" },
    "enabled": true
  },
  "revision": "new"
}
```

### 四类触发方式

1. **手动与 API 触发**：随时在控制台点击运行，或调用 `POST /v1/workflows/{id}/run` 传入 `{input, file_ids?}`。
2. **固定间隔触发（`interval`）**：按 `1`–`10080` 分钟周期调度，停机恢复后自动跳过历史错过的窗口，不产生补跑洪峰。
3. **时区感知 Cron 触发（`cron`）**：支持标准 5 段 Cron 表达式与 IANA 时区（如 `Asia/Shanghai`），按分钟槽精准去重。
4. **签名入站 Webhook 触发（`webhook`）**：启用或轮换（`POST /v1/workflows/{id}/webhook-token`）时生成一次性高熵 `webhook_token`（数据库仅存 SHA-256 哈希）。外部系统向 `POST /v1/webhooks/workflows/{id}` 发送请求并携带 `Authorization: Bearer <webhook_token>` 或 `X-OAA-Webhook-Token` 即可安全触发。

单次工作流运行最多并行推进 4 个阶段、展开 64 次子智能体调用；任何子任务进入「待审批」时，都可直接在工作流检查器内点开处理，也支持归档（`/archive`）与恢复（`/restore`）。

---

## 流式媒体与大文件产物

智能体在工作区生成的报告、图片、音频或视频可作为受管产物直接流式交付给调用方：

- **输出契约校验**：可通过 `POST /v1/media/jobs`（或兼容入口的 `oaa.output_kind` / `oaa.output_format` 元数据）声明期望交付的文件类型（`GET /v1/media/formats` 查看支持格式签名）。
- **最高 256 MiB 流式传输**：产物落盘与下载全程采用分块 SHA-256 流式校验，默认单文件上限 **64 MiB**，可在配置中通过 `maxArtifactBytes` 调高至 **256 MiB**。控制台支持通过带鉴权的本地临时 Blob URL 直接在线预览图片、文本、音视频产物，不在 URL 中拼接任何密钥。

---

## 三端统一跨平台桌面端

`desktop/cross-platform` 提供面向 **macOS**（`arm64` / `x64`）、**Windows**（`x64`）与 **Linux**（`x64` / `arm64`）的统一 Electron 安全沙箱外壳：

- **开箱即用与进程接管**：内置独立 Node.js 24 运行时，自动启动或接管同数据目录的本机回环网关（绝不误连其他程序占用的端口）。
- **系统托盘快捷审批小窗**：无需切回主窗口，点击菜单栏 / 系统托盘图标即可查看运行态势、待审批详情并一键点击「批准 / 拒绝」，配合 Dock 与托盘角标及双语系统通知，让后台长任务协作顺手自然。
- **严格沙箱隔离**：渲染进程全面关闭 `nodeIntegration`，强制开启 `contextIsolation` 与操作系统级进程沙箱。日常开发与打包命令：

```bash
npm run desktop:dev           # 本地开发模式启动桌面外壳
npm run desktop:smoke         # 运行桌面端自动化烟雾测试
npm run package:mac           # 打包 macOS 应用（另提供 package:win / package:release:linux）
```
