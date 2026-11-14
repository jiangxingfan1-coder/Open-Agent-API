# 文档地图

按「我想…」找文档。

## 我想上手

- 安装、初始化、启动、打开控制台：[README「三分钟跑起来」](../README.zh-CN.md#三分钟跑起来)
- 控制台各页面怎么用：[console.md](console.md)
- 本地启动的更多细节（配置文件、后台运行）：[operations.md「Local start」](operations.md#local-start)

## 我想调用智能体

- 用 OpenAI SDK 或 `oaa/1` 调用：[operations.md「Publish and invoke」](operations.md#publish-and-invoke)
- 支持的协议与字段、文件上传、流式、审批、恢复、取消：[protocol.md「Compatibility」](protocol.md#compatibility)、[「Execution and actions」](protocol.md#execution-and-actions)
- 兼容入口的参数、错误形状、422 不重试与结束原因（`finish_reason`、`stop_reason` 等）：[protocol.md「兼容入口的参数、错误与结束原因」](protocol.md#兼容入口的参数错误与结束原因060)
- 调用前查看选路：[operations.md「Inspect routing before execution」](operations.md#inspect-routing-before-execution)
- 失败自动换智能体、交接给另一个智能体：[protocol.md「失败自动换智能体」](protocol.md#失败自动换智能体oaaagent_fallback2026-11-10)、[「智能体交接」](protocol.md#智能体交接handoff2026-11-10)
- 通过 MCP 调用：[operations.md「MCP and plugin entry」](operations.md#mcp-and-plugin-entry)、[MCP 技能说明](../integrations/open-agent-api/SKILL.md)

## 我想发布智能体

- 用 OAA-Lang 写智能体：[language.md](language.md)
- 发布 JSON 定义或外部智能体：[operations.md「Publish and invoke」](operations.md#publish-and-invoke)
- 导入选定的 MCP 工具：[operations.md「Import selected MCP tools」](operations.md#import-selected-mcp-tools)
- 一键启用已安装的智能体：[protocol.md](protocol.md#一键启用已安装的智能体2026-11-10)、[operations.md「Export an installed agent」](operations.md#export-an-installed-agent)

## 我想接入外部智能体

- 接入契约与各方式的能力差异：[adapters.md「AgentAPI 转换契约」](adapters.md#agentapi-转换契约2026-11-08)
- 写一个 `oaa/1` / `oaa/1-stream` 适配器：[adapters.md](adapters.md#oaa1-最终结果-abi)
- ACP 与 A2A 智能体：[adapters.md「ACP 智能体」](adapters.md#acp-智能体agent-client-protocol)、[「A2A 远程智能体」](adapters.md#a2a-远程智能体2026-11-08)
- 已支持的外部智能体与它们的边界：[README「能接入哪些智能体」](../README.zh-CN.md#能接入哪些智能体)

## 我想让调用方的工具参与

- 托管 / 桥接 / 拒绝三种模式与支持矩阵：[harness.md](harness.md)
- 桥接的用法：[harness.md「桥接怎么用」](harness.md#桥接怎么用内核智能体)、[「Responses、Claude Messages 与 Gemini」](harness.md#responsesclaude-messages-与-gemini)

## 我想部署到公网或接入更多执行机器

- 公网部署手册：[deploy-public.md](deploy-public.md)
- 公网化设计方案：[public-deployment.md](public-deployment.md)
- 沙箱执行设计：[sandbox-design.md](sandbox-design.md)
- 用开发者平台分发给开发者自助使用：[deploy-public.md「用开发者平台分发」](deploy-public.md#用开发者平台分发)
- 接入远程执行机器：[operations.md「Workers」](operations.md#workers)、[protocol.md「Node wire protocol」](protocol.md#node-wire-protocol)

## 我想把智能体开放给开发者自助使用

- 定位、启用、运营者与开发者的操作流程、接口：[platform.md](platform.md)
- 计费规则（按次与按 token 怎么结算）：[platform.md「计费规则」](platform.md#计费规则)
- 接口一览与错误码：[platform.md「接口一览」](platform.md#接口一览)、[platform.md「错误码」](platform.md#错误码)
- 接入自己的支付（`billing` 密钥、按外部单号防重）：[platform.md「接入你自己的支付」](platform.md#接入你自己的支付)
- 安全要点与限制：[platform.md「安全要点」](platform.md#安全要点)、[platform.md「限制」](platform.md#限制)
- 英文开发者指南（调用、计费、任务记录、忘记密码）：[platform.en.md](platform.en.md)
- 英文简介：[README.md](../README.md)

## 我想理解架构

- 架构与设计依据：[architecture.md](architecture.md)
- 运行状态机：[architecture.md 3.2](architecture.md#32-运行状态机)
- 测试与基准证明了什么、没证明什么：[architecture.md 第 10 节](architecture.md#10-证据与性能)、[配对基准](../bench/paired/README.md)
- 对真实智能体做过哪些联调、结果与没验证的部分：[evidence.md](evidence.md)
- 版本变化：[CHANGELOG.md](../CHANGELOG.md)

## 我想参与开发

- 工程规范（命令、分层、编码约定、提交格式、兼容性红线）：[engineering.md](engineering.md)
- 怎么加错误码与事件：[engineering.md 第 4 节](engineering.md#4-怎么加一个错误码--事件)
- 验证命令：[operations.md「Verification」](operations.md#verification)
- 贡献流程与社区约定：[CONTRIBUTING.md](../CONTRIBUTING.md)、[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)；报告安全问题：[SECURITY.md](../SECURITY.md)

## 我想排查错误

- 错误码表：[protocol.md「错误码」](protocol.md#错误码errorcode)，运行时也可以读 `GET /v1/errors`
- 兼容入口各家协议的错误形状与重试头：[protocol.md「兼容入口的参数、错误与结束原因」](protocol.md#兼容入口的参数错误与结束原因060)
- 查看与恢复请求、结果未知的写入怎么处理：[operations.md「Inspect and recover work」](operations.md#inspect-and-recover-work)
- 某个请求为什么慢、为什么还在等：[protocol.md「可观测内核」](protocol.md#可观测内核运行时间线活动脉搏排队与能力协商)、[console.md](console.md)
