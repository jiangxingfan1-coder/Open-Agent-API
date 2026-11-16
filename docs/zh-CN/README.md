# 文档地图

[English](../README.md) · 简体中文

按「我想…」找文档。每份文档都有英文版（上一级目录）和中文版（本目录）。

## 我想上手

- 安装、初始化、启动、打开控制台：[README「三分钟跑起来」](../../README.zh-CN.md#三分钟跑起来)
- 控制台各页面怎么用：[console.md](console.md)
- 安装方式（安装包、Linux 软件包、Docker、npm tarball）：[install.md](install.md)
- 在 Windows 上运行：[windows.md](windows.md)
- 每一条 `oaa` 命令，按「想做什么」分组（启动并照看网关、接上智能体、在终端里审批、事件回调、验证智能体、密钥、发布、调用）：[cli.md](cli.md)
- 本地启动的更多细节（配置文件、后台运行）：[operations.md「本机启动」](operations.md#本机启动)

## 我想调用智能体

- 不手动复制密钥，把已发布智能体配入本机 DSH，并可预览和撤销：[本地互联](local-connections.md)

- 用 OpenAI SDK 或 `oaa/1` 调用：[operations.md「发布与调用」](operations.md#发布与调用)
- 支持的协议与字段、文件上传、流式、审批、恢复、取消：[protocol.md「Compatibility」](protocol.md#compatibility)、[「Execution and actions」](protocol.md#execution-and-actions)
- 兼容入口的参数、错误形状、422 不重试与结束原因（`finish_reason`、`stop_reason` 等）：[protocol.md「兼容入口的参数、错误与结束原因」](protocol.md#兼容入口的参数错误与结束原因060)
- 调用前查看选路：[operations.md「调用前查看选路」](operations.md#调用前查看选路)
- 失败自动换智能体、交接给另一个智能体：[protocol.md「失败自动换智能体」](protocol.md#失败自动换智能体oaaagent_fallback2026-11-10)、[「智能体交接」](protocol.md#智能体交接handoff2026-11-10)
- 通过 MCP 调用：[operations.md「MCP 与插件入口」](operations.md#mcp-与插件入口)、[MCP 技能说明](../../integrations/open-agent-api/SKILL.md)
- 哪些 SDK 与框架实际运行过、哪些聊天客户端按请求形状回放、各自怎么配置、哪些参数被忽略或拒绝：[compatibility.md](compatibility.md)
- 拿到保证合乎 schema 的 JSON（`response_format`、`text.format`、`responseSchema`、`output_config.format`），修正轮、流式行为与限制：[structured-output.md](structured-output.md)

## 我想发布智能体

- 用 OAA-Lang 写智能体：[language.md](language.md)
- 发布 JSON 定义或外部智能体：[operations.md「发布与调用」](operations.md#发布与调用)
- 导入选定的 MCP 工具：[operations.md「导入选定的 MCP 工具」](operations.md#导入选定的-mcp-工具)
- 一键启用已安装的智能体：[protocol.md](protocol.md#一键启用已安装的智能体2026-11-10)、[operations.md「导出已安装的智能体」](operations.md#导出已安装的智能体)

## 我想接入外部智能体

- 接入契约与各方式的能力差异：[adapters.md「AgentAPI 转换契约」](adapters.md#agentapi-转换契约2026-11-08)
- 写一个 `oaa/1` / `oaa/1-stream` 适配器：[adapters.md](adapters.md#oaa1-最终结果-abi)
- ACP 与 A2A 智能体：[adapters.md「ACP 智能体」](adapters.md#acp-智能体agent-client-protocol)、[「A2A 远程智能体」](adapters.md#a2a-远程智能体2026-11-08)
- 已支持的外部智能体与它们的边界：[README「能接入哪些智能体」](../../README.zh-CN.md#能接入哪些智能体)

## 我想在运行结束或需要审批时收到通知

- 把运行事件（完成、失败、等待审批等）带签名、带重试地推送到你自己的 HTTPS 地址，并把审批接进你自己的系统：[webhooks.md](webhooks.md)

## 我想把截图等图片发给智能体

- 各入口的图片内容段、上限、存储、URL 策略，以及各类智能体怎样拿到图片：[images.md](images.md)

## 我想让内置智能体用我的模型

- `oaa connect <预设>`（Ollama、LM Studio、OpenAI、Anthropic、Gemini、DeepSeek 等）、密钥、`oaa models` 与提供方配置项：[models.md](models.md)

## 我想让聊天客户端看见智能体在做什么

- 以各协议的思考 / 推理形状送出运行过程、开关与客户端对照表：[progress.md](progress.md)

## 我想让调用方的工具参与

- 调用方工具的 auto / 托管 / 桥接 / 拒绝模式与支持矩阵：[harness.md](harness.md)
- 桥接的用法：[harness.md「桥接怎么用」](harness.md#桥接怎么用内核智能体)、[「Responses、Claude Messages 与 Gemini」](harness.md#responsesclaude-messages-与-gemini)

## 我想部署到公网或接入更多执行机器

- 公网部署手册：[deploy-public.md](deploy-public.md)
- 公网化设计方案：[public-deployment.md](public-deployment.md)
- 沙箱执行设计：[sandbox-design.md](sandbox-design.md)
- 谁能做什么、默认暴露什么、对外开放前要做什么：[security-model.md](security-model.md)
- 用开发者平台分发给开发者自助使用：[deploy-public.md「用开发者平台分发」](deploy-public.md#用开发者平台分发)
- 接入远程执行机器：[operations.md「执行机器（Workers）」](operations.md#执行机器workers)、[protocol.md「Node wire protocol」](protocol.md#node-wire-protocol)
- 长时间运行测试、升级路径与数据保留：[stability.md](stability.md)

## 我想把智能体开放给开发者自助使用

- 定位、启用、运营者与开发者的操作流程、接口：[platform.md](platform.md)
- 计费规则（按次与按 token 怎么结算）：[platform.md「计费规则」](platform.md#计费规则)
- 接口一览与错误码：[platform.md「接口一览」](platform.md#接口一览)、[platform.md「错误码」](platform.md#错误码)
- 接入自己的支付（`billing` 密钥、按外部单号防重）：[platform.md「接入你自己的支付」](platform.md#接入你自己的支付)
- 安全要点与限制：[platform.md「安全要点」](platform.md#安全要点)、[platform.md「限制」](platform.md#限制)
- 简介：[README「作为开发者平台对外提供」](../../README.zh-CN.md#作为开发者平台对外提供)

## 我想理解架构

- 架构与设计依据：[architecture.md](architecture.md)
- 运行状态机：[architecture.md 3.2](architecture.md#32-运行状态机)
- 测试与基准证明了什么、没证明什么：[architecture.md 第 10 节](architecture.md#10-证据与性能)、[配对基准](../../bench/paired/README.md)
- 对真实智能体做过哪些联调、结果与没验证的部分：[evidence.md](evidence.md)；想在自己的机器上验证一个智能体，见 [cli.md「自己验证一个智能体」](cli.md#自己验证一个智能体)
- 版本变化：[CHANGELOG.md](../../CHANGELOG.zh-CN.md)
- 接下来要做什么、哪些已验证哪些没有：[ROADMAP.zh-CN.md](../../ROADMAP.zh-CN.md)
- 网关怎么防护、哪些不防护：[security-model.md](security-model.md)
- 稳定性、升级路径与数据保留：[stability.md](stability.md)

## 我想参与开发

- 工程规范（命令、分层、编码约定、提交格式、兼容性红线）：[engineering.md](engineering.md)
- 怎么加错误码与事件：[engineering.md 第 4 节](engineering.md#4-怎么加一个错误码--事件)
- 验证命令：[operations.md「验证」](operations.md#验证)
- 怎么发一个版本：[releasing.md](releasing.md)
- 贡献流程与社区约定：[CONTRIBUTING.md](../../CONTRIBUTING.zh-CN.md)、[CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.zh-CN.md)；报告安全问题：[SECURITY.md](../../SECURITY.zh-CN.md)
- 品牌标识与规则：[brand/README.md](../brand/README.md)（目前只有中文）

## 我想排查错误

- 错误码表：[protocol.md「错误码」](protocol.md#错误码errorcode)，运行时也可以读 `GET /v1/errors`
- 兼容入口各家协议的错误形状与重试头：[protocol.md「兼容入口的参数、错误与结束原因」](protocol.md#兼容入口的参数错误与结束原因060)
- 查看与恢复请求、结果未知的写入怎么处理：[operations.md「查看与恢复请求」](operations.md#查看与恢复请求)
- 某个请求为什么慢、为什么还在等：[protocol.md「可观测内核」](protocol.md#可观测内核运行时间线活动脉搏排队与能力协商)、[console.md](console.md)
- Windows 上的专有问题：[windows.md](windows.md)
