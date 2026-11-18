# 持久 Agent 工作台

[English](../workstation.md) · 简体中文

以下能力已进入当前源码工作区，不代表已安装应用或公开发布版本已经更新。

## 项目与共享记忆

控制台有项目视图，任务可选择共享项目。私人任务及原有调用方私人记忆仍然隔离。全域所有者管理员创建项目，按调用方 subject 授予只读或读写权限；默认 subject 是密钥 ID。项目权限不会额外授予调用其他智能体的权限。

| 接口 | 操作 |
| --- | --- |
| `GET /v1/projects` | 只列出有权限的项目 |
| `POST /v1/projects` | 所有者管理员创建 `{id,name}` |
| `GET /v1/projects/{id}/members` | 管理员查看授权 |
| `POST /v1/projects/{id}/members` | `{subject,access}`，权限为 `read`、`write` 或 `none` |
| `GET /v1/projects/{id}/memory` | 读取共享条目 |
| `GET /v1/projects/{id}/memory/search` | BM25 全文检索（`?q=...&namespace=...&limit=...`） |
| `PUT /v1/projects/{id}/memory` | `{namespace,key,value,revision?}`；`"new"` 要求条目不存在 |
| `DELETE /v1/projects/{id}/memory` | `{namespace,key,revision}`，拒绝过期删除 |

用 `metadata["oaa.project"]` 选择项目。已发布 `memory_read` / `memory_write` / `memory_search` 的内核智能体可传 `scope:"project"`，默认仍是私人记忆。其他智能体获得按 SQLite FTS5 BM25 与当前任务输入动态排序的相关记忆参考快照（无匹配时回退至最近更新条目）。调用方有写权限时，完成的根任务输出会保存为**智能体陈述**，不是已经验证的事实；可用 `oaa.project.remember=false` 关闭。项目会话不能在下一轮移动到另一个项目。私人记忆、系统指令和原生会话句柄不会被复制给其他调用方。

## 持久任务

`metadata["oaa.durable"]="true"` 保留绝对截止时间及有上限的恢复次数。`oaa.timeout_ms` 不能超过发布定义的上限；`oaa.max_resume_attempts` 接受 1-100，默认 10 次。API 执行策略弹窗可显式把任务上限提高到最多 168 小时，但不会解除轮次、Token、密钥或执行级别限制。

HTTP 调用方断开不会取消已接受任务，退出桌面也不会停止后台网关。网关重启后复用已完成检查点，安全的工作区／强制无工具阶段可在重新检查原密钥后自动恢复，截止时间不会重新起算。密钥撤销、调用方提供的凭据丢失、截止时间过期或宿主副作用未确认时，不会自动恢复。不透明的原生进程不会被盲目重放；某些原生中断需要调查后显式新建任务，而非自动续跑。

## 可复用工作流

工作流视图提供智能体阶段图、依赖编辑、JSON 编辑及自然语言建模。建模使用经过验证的无工具入口，不会自动发布或开启生成的工作流。复用现有图执行引擎检查循环与引用，并支持变换、条件、有上限的 foreach 和并行依赖。

2026-11-17，通过已安装智能体发起的真实 Sonnet 调用返回了通过 Schema 校验的两阶段草稿，仍保持禁用、手动触发。另一个两阶段离线样例跑通了可视化编辑、执行、子任务审批及成果检查。这些检查不代表普遍的模型可靠性，也不代表不透明原生进程可无人值守恢复。

定义默认归创建者私有，显式绑定共享项目后才随项目授权共享；调用者仍需有权调用所有引用的智能体。每次执行冻结定义，并在等待前记录子运行 ID，重启时重新挂接而非重做完成的阶段。每次最多并行四阶段、展开 64 次智能体调用。

```json
{
  "definition": {
    "id": "report-review",
    "name": "Report Review",
    "graph": {
      "steps": [
        {"id":"write","tool":"agent/writer","arguments":{"input":{"$ref":"input#/task"}}},
        {"id":"review","tool":"agent/reviewer","arguments":{"input":{"$ref":"write#/output"}},"depends_on":["write"]}
      ],
      "output": {"$ref":"review#/output"}
    },
    "trigger": {"kind":"manual"},
    "enabled": false
  },
  "revision": "new"
}
```

用 `POST /v1/workflows` 发布，`POST /v1/workflows/{id}/run` 以 `{input,file_ids?}` 启动。通过 `/v1/workflow-runs`、`/v1/workflow-runs/{id}` 查看检查点；`/cancel` 取消活跃子调用，`/resume` 在子运行结果解决后重新挂接阻塞执行。原有副作用核对规则仍然生效。

手动和 API 触发始终可用。显式开启的定时间隔为 1-10080 分钟，错过的时间槽不会形成补跑洪峰。标准 5 段 Cron 触发器（`{kind:"cron",expression,timezone?}`，默认 `UTC`）按 IANA 时区分钟槽去重执行，停机重启后自动跳过已错过窗口。入站 Webhook 触发器（`{kind:"webhook"}`）在启用或轮换（`POST /v1/workflows/{id}/webhook-token`）时生成一次性高熵 `webhook_token` 且数据库仅存 SHA-256 哈希；公开入站端点 `POST /v1/webhooks/workflows/{id}` 通过 `Authorization: Bearer <webhook_token>` 或 `X-OAA-Webhook-Token` 常数时间校验，实施限流与 64 KiB JSON 负载上限，重验创建者密钥权限，并在归档（409）或停用（403）时拒绝触发。完成事件指定来源智能体，默认限于创建者 subject，工作流子运行不会递归触发其他工作流。调度时重新验证原密钥，不保存 Bearer 凭据，并在触发状态中显示准入错误。不会为定时任务持久化调用方提供的模型凭据。

`POST /v1/workflows/{id}/archive` 与 `/restore` 需要 `{revision}` 及所有者管理员权限。归档会停用触发器并从默认列表隐藏定义，不会取消已接受的执行或删除历史；`GET /v1/workflows?archived=true` 查看归档项。恢复后触发器仍保持关闭，归档定义须恢复后才能编辑或新建执行。未归档定义即使停用自动触发器，仍可手动／API 执行。

执行列表的 `progress` 提供有上限的阶段计数及等待发布者／调用方的信息，执行详情另有逐阶段状态。检查器自动跟进状态，并可打开已有子任务审批界面。取消前先持久化 `cancelling` 意图，重启后继续清理子调用；清理失败保留 `blocked` 与 `cancel_requested=true`，应重试取消，而不是恢复执行。取消已完成、失败或已取消的执行不会改写其结果。取消清理优先于排队工作流，其余活跃执行按较早提交优先准入。

## 媒体成果

任务弹窗可选择图片、文档、音频或视频文件。`GET /v1/media/formats` 列出格式签名；`POST /v1/media/jobs` 接受 `{agent,model?,input,kind,format?,file_ids?,metadata?}` 并建立普通持久任务，`GET /v1/media/jobs/{id}` 返回实际产物。现有兼容接口也可传 `oaa.output_kind`、`oaa.output_format` 元数据。工作流阶段支持 `output_kind`、`format` 参数。

它使用所选智能体已安装的工具，不是 OAA 新增了一套图片、语音或视频模型。没有新的匹配产物时输出契约失败。格式签名检查不能证明文档结构、编解码完整性、创意质量或事实正确性；产物落盘与下载采用分块 SHA-256 流式校验，默认上限提升至 64 MiB（可通过 `maxArtifactBytes` 配置至最高 256 MiB），普通上传仍保持 8 MiB 上限。图片、文本、音频、视频预览通过鉴权下载及临时本地 Blob URL 展示，不把密钥放入媒体 URL，也不自动播放声音。

2026-11-17 的真实 Codex 任务生成并下载了一秒 PCM WAV 和 H.264 MP4，独立 `ffprobe` 识别成功。它们是技术测试信号与画面，不是艺术性 AI 生成质量的证明。

## 模型证据

管理员可用 `POST /v1/local/evaluations/feedback` 和 `{run_id,passed}` 记录人工任务反馈。每个运行去重，绑定调用时捕获的执行身份，并与测试样本分别标记来源；不存任务正文、不增加评测调用。认证、传输和取消失败不会被当作模型质量差。至少四条有效样本后才参与实测选路。

公开资料在 `/v1/local/evaluations/sources` 与 `/sources/refresh` 中按 `{agent,route}` 配置，默认关闭。仅获取无凭据、无查询字符串、无重定向的公开 HTTPS JSON；连接时检查 DNS 和目标地址，限制响应体。所有者用 JSON Pointer 映射有上限的上下文长度、输入／输出价格和图片支持字段，以 `priceScale` 明确单位；可按模型 ID 选择 JSON 数组记录。修改映射会清空旧报告，七天后证据过期。

规划器只获得提取后的数字、布尔值、时效和来源哈希，不接收任意网页指令、全文或 URL 路径。这些是发布方资料，不是实测质量、实际扣费承诺或宿主能力授权。网络与解析探测已从 [OpenAI 发布的 gpt-oss 配置](https://huggingface.co/openai/gpt-oss-20b/raw/main/config.json) 提取声明的上下文长度，但没有把它当作性能评测。

## 跨平台桌面

跨平台统一 Electron 外壳位于 `desktop/cross-platform`，已完整吸收原归档 macOS Swift 外壳的全部体验（52pt `hiddenInset` 内嵌红绿灯顶栏、Dock 与托盘实时角标、双语审批通知、端口归属三态诊断与自家孤儿网关接管、`.seeded` 首次启动引导），并新增沙箱化系统托盘快捷审批小窗与开机自启开关，统一承载 macOS（`arm64` / `x64`）、Windows（`x64`）与 Linux 三端构建。它只启动或连接匹配的私人回环网关，只向自己的顶层窗口注入本地密钥，关闭渲染进程 Node 集成并开启上下文隔离、进程沙箱，参照 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。

```sh
npm install --prefix desktop/cross-platform
npm run desktop:dev
npm run desktop:smoke
node desktop/cross-platform/fetch-runtime.mjs --platform win32 --arch x64 --version 24.18.0
npm run desktop:package -- --platform win32 --arch x64 --node-dir ABSOLUTE_RUNTIME_DIRECTORY --node-version 24.18.0
```

运行时下载器在解压前核验官方 Node SHA-256 清单。打包沿用根项目版本、筛选网关生产依赖、保留第三方声明，只写新输出目录，不安装、不发布、不改全局 CLI 链接，也不代替签名／公证。本地已构建 Windows x64、Linux x64 压缩包和 macOS arm64 应用；macOS 已验证启动、私人自动连接、创建项目及退出桌面后网关存活。Windows/Linux 真机验收仍未完成，新增桌面 smoke 矩阵本轮没有远程运行。

可用 `--oaa-data-dir ABSOLUTE_PATH` 选择独立本地数据目录。有托盘时关闭窗口只隐藏；**Quit desktop** 保留已接受的网关任务。只有本外壳确实启动了网关时才提供 **Stop gateway and quit**，并沿用 CLI 通过记录和实际健康信息核对进程。
