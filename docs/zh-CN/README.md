# 文档导航

[English](../README.md) · 简体中文

欢迎查阅 Open Agent API 文档。如果你是第一次接触本项目，建议直接从 **[五分钟上手：从发布智能体到第一次调用](quickstart.md)** 与 **[可运行示例集（Cookbook）](../../examples/cookbook/README.zh-CN.md)** 开始。

---

## 我想快速上手

- **五分钟走完「发布智能体 → 生成密钥 → SDK 实机调用」全流程**：[quickstart.md](quickstart.md)（或参阅仓库首页 [三分钟跑起来](../../README.zh-CN.md#三分钟跑起来)）
- 各平台安装与卸载指南（macOS / Windows / Linux 桌面端、一键脚本、Docker、npm 包）：[install.md](install.md)
- 控制台各功能视图说明（概览、对话工作台 `#workbench`、任务时间线、事件回调与开发者平台）：[console.md](console.md)
- 命令行速查表（按启动网关、接入智能体、终端审批、密钥管理、真机验收分组）：[cli.md](cli.md)
- Windows 环境运行与路径说明：[windows.md](windows.md)
- 本机启动配置与后台常驻细节：[operations.md「本机启动」](operations.md#本机启动)

## 我想调用智能体与编排任务

- **直接复制运行的调用代码**（涵盖 cURL 及 OpenAI / Claude / Gemini 的 Python 与 Node 示例）：[示例集 Cookbook](../../examples/cookbook/README.zh-CN.md)
- 自动选路（`@fast` / `@best` / `@eco`）、仅输出方案（`recommend`）、多智能体协作与模型实测评估：[智能选路与编排](intelligence.md)
- 跨会话共享项目记忆（SQLite FTS5）、持久长任务、可视化 DAG 工作流（Cron / Webhook 触发）与大体积媒体产物：[工作台与工作流](workstation.md)
- 一键把已发布智能体注入本机 IDE 与客户端（支持 OpenCode / Codex / DSH API 通道与 Cursor / Windsurf / Claude Desktop / Claude Code MCP 通道）：[本地互联](local-connections.md)
- 查看 Token 消耗统计、单把密钥预算上限与上游额度快照：[用量与额度](usage-monitor.md)
- 使用 OpenAI SDK 或原生 `oaa/1` 接口发起调用与交接（Handoff）：[operations.md「发布与调用」](operations.md#发布与调用)
- 四大协议字段对照、文件上传、流式事件、审批恢复与取消语义：[protocol.md「Compatibility」](protocol.md#compatibility)、[「Execution and actions」](protocol.md#execution-and-actions)
- 保证符合 JSON Schema 的结构化输出（原生下推、自动修正轮与失败契约）：[structured-output.md](structured-output.md)
- 发送截图与本地图片（各协议格式、大小上限与隐私策略）：[images.md](images.md)
- 在流式响应中实时透传智能体执行阶段进度：[progress.md](progress.md)
- 让智能体回调调用方自己定义的本地函数（`auto` / `managed` / `bridge` / `reject` 双层工具桥接）：[双层 Harness 指南](harness.md)
- 官方 SDK 实连测试范围与主流第三方客户端（Open WebUI、Dify、n8n、Continue、Cline、Zed 等）配置表：[compatibility.md](compatibility.md)
- 通过 MCP 协议暴露智能体给编辑器调用：[operations.md「MCP 与插件入口」](operations.md#mcp-与插件入口)、[MCP 技能说明](../../integrations/open-agent-api/SKILL.md)

## 我想发布与接入智能体

- 用 OAA-Lang 编写自带工具与流水线的内置智能体：[language.md](language.md)
- 为内置智能体配置本地模型运行器（Ollama、LM Studio、vLLM 等）或云厂商 API：[models.md](models.md)
- 接入本机外部 CLI、ACP 智能体、A2A 远程节点或编写自定义 `oaa/1` 适配器：[接入外部智能体](adapters.md)
- 导入指定的外部 MCP 工具到内置智能体：[operations.md「导入选定的 MCP 工具」](operations.md#导入选定的-mcp-工具)

## 我想接收通知或对接外部系统

- 订阅任务完成、失败或待审批事件（HMAC-SHA256 签名 HTTPS Webhook 与持久化重试队列），或把审批接入自有IM/工单系统：[webhooks.md](webhooks.md)

## 我想部署上线或向团队分发

- 开启自助式开发者门户（多租户账号隔离、自助密钥管理、启动预扣点数与混合计量）：[开发者平台](platform.md)
- 公网反向代理、TLS、允许域名与安全检查清单：[公网部署手册](deploy-public.md)、[公网化设计方案](public-deployment.md)
- 权限模型、密钥作用域与威胁边界说明：[安全模型](security-model.md)
- POSIX 多槽位 `srt` 沙箱隔离策略设计：[沙箱执行设计](sandbox-design.md)
- 接入多台远程执行机器（Workers）：[operations.md「执行机器（Workers）」](operations.md#执行机器workers)
- 长稳压测记录、平滑升级路径与历史数据清理（`oaa prune`）：[稳定性与数据保留](stability.md)

## 我想了解架构、实测证据与参与贡献

- 分层架构设计与持久任务状态机：[architecture.md](architecture.md)
- 真实智能体（Qoder、Antigravity、Codex 等）端到端验收档案与[配对基准测量](../../bench/paired/README.md)：[验证证据](evidence.md)
- 代码分层门禁、新增错误码规范与本地验证命令：[工程规范](engineering.md)
- 多平台桌面端打包与版本发布流程：[发布指南](releasing.md)
- 版本更新历史与后续规划：[CHANGELOG.zh-CN.md](../../CHANGELOG.zh-CN.md)、[ROADMAP.zh-CN.md](../../ROADMAP.zh-CN.md)
- 贡献指南、行为准则与安全漏洞上报：[CONTRIBUTING.zh-CN.md](../../CONTRIBUTING.zh-CN.md)、[CODE_OF_CONDUCT.zh-CN.md](../../CODE_OF_CONDUCT.zh-CN.md)、[SECURITY.zh-CN.md](../../SECURITY.zh-CN.md)
- 品牌视觉标志使用规范：[brand/README.md](../brand/README.md)

## 我想排查报错

- 全量错误码与 HTTP 状态码对照表（运行时也可请求 `GET /v1/errors`）：[protocol.md「错误码」](protocol.md#错误码errorcode)
- 各兼容协议的错误返回格式与重试响应头：[protocol.md「兼容入口的参数、错误与结束原因」](protocol.md#兼容入口的参数错误与结束原因060)
- 中断任务的核验与恢复处理（含结果未知的外部写操作保护）：[operations.md「查看与恢复请求」](operations.md#查看与恢复请求)
