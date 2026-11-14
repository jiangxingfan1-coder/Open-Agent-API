# 示例

[English](README.md) · 简体中文

本目录里的所有东西，按「给谁用」分组。第一部分是想调用智能体时该看的；其余是发布智能体用的，或是给开发网关本身的人用的。

## 给调用智能体的人

| 是什么 | 在哪里 | 说明 |
|---|---|---|
| **示例集（Cookbook）** | [`cookbook/`](cookbook/README.zh-CN.md) | 按「我想做什么」组织、可以直接复制运行的示例：第一次调用、长任务、审批、调用方工具、结构化输出、图片、错误与重试、接入常用工具。curl，以及官方 `openai`、`anthropic`、`google-genai` SDK 的 Python 与 Node 写法。每个都由兼容性实验室（`npm run compat`）在隔离的网关上自动运行，所以不会悄悄过期。从这里开始。 |
| 事件回调接收端 | [`webhook-receiver.mjs`](webhook-receiver.mjs) | 运行事件回调的最小接收端（只用 Node 内置模块）：校验签名、打印每个事件；只有带 `--auto-approve` 才会批准等待审批的事项。完整的走查在 [docs/zh-CN/webhooks.md](../docs/zh-CN/webhooks.md)；示例集里还有一个在单个进程里跑完整个来回的版本（[`03-approvals/webhook_approve.mjs`](cookbook/03-approvals/webhook_approve.mjs)）。 |

## 离线示例智能体

| 是什么 | 在哪里 | 说明 |
|---|---|---|
| 示例智能体 | [`sample-agent.mjs`](sample-agent.mjs) | 一个 ACP 智能体进程（stdio 上的 JSON-RPC），**不调用任何模型、不联网**。它按固定规则回答、做一次假的工具调用，任务里带有「approve」时请求一次审批。`oaa quickstart` 把它发布成 `agent/sample`，这样还没有任何模型密钥时也有东西可以调用。它不会调用你的工具，不能应对结构化输出请求，也不能接续会话；哪些示例它能演示、哪些不能，见示例集的 README。 |
| 它的定义 | [`sample-agent.json`](sample-agent.json) | `quickstart` 发布的智能体定义（`agent/sample`，引擎 `adapter/oaa-sample`）。 |

这两个文件都包含在 npm 包里。

## 智能体定义模板

发布你自己的智能体时的起点。里面有意写成模型占位符（`configure-your-model`）：这里没有任何编造出来的「可用连接」。用 `oaa check` 检查，用 `oaa publish` 发布（见 [docs/zh-CN/language.md](../docs/zh-CN/language.md)、[docs/cli.md](../docs/cli.md)，命令行参考目前只有英文）。

| 文件 | 说明 |
|---|---|
| [`research.oaa`](research.oaa) | OAA-Lang 写的研究型智能体：主模型与快速模型两条路由、内置文件工具、一个工作流。 |
| [`research.agent.json`](research.agent.json) | 同样的想法，用纯 JSON 定义（`oaa publish examples/research.agent.json`）。 |
| [`projected-workflow.oaa`](projected-workflow.oaa) | 一个小的 OAA-Lang 智能体，带一个经过检查的工作流（`read_file`，有界的输出结构）；[docs/zh-CN/language.md](../docs/zh-CN/language.md) 里用的就是它。 |
| [`agy-gemini-3.8-flash.oaa`](agy-gemini-3.8-flash.oaa) | 把本机的 Antigravity 命令行（`agy`）封装成用 Gemini 3.8 Flash 的智能体。需要已安装并登录 `agy`。 |

`.oaa` 文件与 `research.agent.json` 包含在 npm 包里。

## 给开发网关的人（内部验收与演示脚本）

这些不是给调用方看的示例。它们在进程内起一个隔离的网关，端到端地跑产品；有的会花钱。它们是 TypeScript 文件，由 `npm run build` 编译到 `dist/examples/`，所以放在这里而不是 `tools/`。都不在 npm 包里。

| 文件 | 做什么 | 费用 |
|---|---|---|
| [`demo.ts`](demo.ts) | `npm run demo`：用确定性的本地模型，对三个小文件做一次研究型智能体运行，写出 `.oaa-demo/report.md`。 | 无 |
| [`platform-walkthrough.ts`](platform-walkthrough.ts) | 用示例智能体走一遍开发者平台（上架、放开、兑换码、注册、建密钥、调用、扣费、余额不足、充值），只用临时数据目录与 127.0.0.1 的随机端口。`node dist/examples/platform-walkthrough.js`。 | 无 |
| [`local-capability-acceptance.ts`](local-capability-acceptance.ts) | 把选定的一个 MCP 工具（读笔记的测试 MCP 服务）和你指定的技能目录接进一个由夹具模型驱动的 kernel 智能体，检查能力被导入、被调用、被审计（`--skill DIR --out NEW_DIR`）。 | 无（不调用真实模型） |
| [`live-agents-acceptance.ts`](live-agents-acceptance.ts) | 端到端的智能体验证，场景 S1 到 S12，与 `oaa verify` 共用。`--agent fixture` 用仓库里的假 ACP 智能体。 | `fixture` 无；真实智能体（claude、codex、antigravity）需要 `--confirm-live-cost` |
| [`live-native-acceptance.ts`](live-native-acceptance.ts) | 经网关对原生 Antigravity 可执行文件做一次真实调用（必须给出精确的模型 ID 与可执行文件路径）。 | 真实花费，需要 `--confirm-live-cost` |
| [`gemini-sdk-probe.mjs`](gemini-sdk-probe.mjs) | 用装在仓库之外的官方 `@google/genai` SDK 对 Gemini 兼容入口做一次性探测。不属于自动测试；现在示例集和兼容性实验室已经覆盖同一个 SDK。 | 无（进程内，不联网） |

想确认**面向用户**的示例还能用，请运行兼容性实验室，而不是这些脚本：`npm run compat`（见 [docs/zh-CN/compatibility.md](../docs/zh-CN/compatibility.md#兼容性实验室)）。
