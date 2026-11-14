# 路线图

[English](ROADMAP.md) · 简体中文

这是 Open Agent API 的公开路线图，写于 0.0.65 版本（2026-11-14）。它是意向，不是承诺：条目可能调整、缩减或放弃，也没有日期。已经完成的见[变更记录](CHANGELOG.zh-CN.md)；现有功能实际验证到了什么程度，见本页末尾。

## 0.0.65 已经做到的

- 在 Linux（x64 与 arm64 的软件包与 `install.sh`）、Docker 里和用 npm tarball 安装；支持 Node.js 24 与 26。
- 完整的测试集在 CI 里的 Windows 上跑通，Windows 上的行为见 [docs/zh-CN/windows.md](docs/zh-CN/windows.md)。
- 一次安全审查及其修复、[安全模型](docs/zh-CN/security-model.md)，以及可选的 `security.profile`。
- 面向官方 SDK、框架和常用聊天客户端的兼容性实验室（[docs/zh-CN/compatibility.md](docs/zh-CN/compatibility.md)）。
- 命令行里的 `oaa approvals`、`oaa approve`、`oaa deny`、`oaa status`、`oaa verify` 与 `oaa webhook`（[docs/zh-CN/cli.md](docs/zh-CN/cli.md)）。
- 运行事件回调（[docs/zh-CN/webhooks.md](docs/zh-CN/webhooks.md)）、强制保证的结构化输出（[docs/zh-CN/structured-output.md](docs/zh-CN/structured-output.md)）与每个入口上的图片输入（[docs/zh-CN/images.md](docs/zh-CN/images.md)）。
- 开发者平台的上架项可以让平台账号调用指定的外部智能体，计费不再透支。
- 英文为主的文档、带搜索的自动生成的文档站点，以及可复制运行的调用示例集（[examples/cookbook](examples/cookbook/README.zh-CN.md)）。
- `oaa connect <预设>` 与 `oaa models`：本地与兼容 OpenAI 的模型提供方预设（Ollama、LM Studio、OpenAI、Anthropic、Gemini、DeepSeek 等），内置智能体一条命令就能跑在某个模型上（[docs/zh-CN/models.md](docs/zh-CN/models.md)）。
- 流式响应里的运行过程，用各协议的思考形状：Responses 与 Gemini 默认开，Chat 与 Claude 默认关（[docs/zh-CN/progress.md](docs/zh-CN/progress.md)）。
- 压测（`npm run soak`）、升级检查（`npm run upgrade-check`）、压测带来的修复，以及带 `oaa prune` 的数据保留（[docs/zh-CN/stability.md](docs/zh-CN/stability.md)）。

## 接下来

- **更长、更接近真实的压测。** 压测最长跑了 62 分钟，对的是假模型和离线示例智能体。跑上许多小时，以及对着真实的模型提供方和真实的智能体命令行跑，才能看到它现在看不到的东西。
- **原生的结构化输出。** 目前网关校验答案并要求智能体修正，但 schema 没有交给模型提供方自己的结构化输出功能（OpenAI 的 `response_format`、Anthropic 的 `output_config.format`、Gemini 的 `responseSchema`）。交给它们能提高一次就答对的比例，但需要逐个提供方处理，并且不能让某个提供方拒绝它今天还接受的请求。
- **强制工具选择。** `tool_choice` 设为 `required` 或某个具名函数时，OpenAI 默认端点会拒绝，其他入口会忽略，因为网关和上游模型都做不到。靠强制工具调用来拿结构的调用方，同样因此得不到服务。
- **用真实的 Codex 与 Claude Code 做端到端验证。** 两者都没有跑过验收场景，向它们交付图片也只是按文档实现的。这需要装了它们的人来做：见下文「怎么帮忙」。
- **桌面应用的图形界面。** 在一台 Apple 芯片的 Mac 上人工检查过五处。还要检查的：端口被占用时的提示、系统语言两个方向的切换、用同一个数据目录重启、应用崩溃后遗留网关的恢复、Intel 芯片的包、在默认端口上的正常安装，以及 Windows 启动器的双语提示。
- **不泄露账号是否存在的注册，以及持久化的登录失败计数。** 开发者平台没有邮箱验证，所以注册时已注册的邮箱会回答 `email_taken`；登录失败计数只在内存里，重启后清零。这两项都已列在[安全模型](docs/zh-CN/security-model.md)的「不防护」里。

## 以后

- **导出运行指标**（例如 Prometheus 格式）。
- **经过公证的 macOS 构建。** macOS 应用目前只做临时签名、没有公证，所以第一次打开时 macOS 会要求手动打开（见 [docs/zh-CN/releasing.md](docs/zh-CN/releasing.md)）。
- **Windows 与 Linux 上的真实智能体。** CI 用替身覆盖了这两个系统；在这两个系统上用真实的 Codex、Claude Code 或 Antigravity 的记录并不存在。
- **全面改用英文源码注释。** 源码里仍有不少中文注释和测试名；新代码用英文写（见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)），旧代码会逐步转换。

## 验证状况

细节见 [docs/zh-CN/evidence.md](docs/zh-CN/evidence.md)；下面是刻意保守的简版：

**已验证的**

- **离线测试套件**（本地确定性模型、本地协议服务器与替身智能体），在 CI 里于 Linux、macOS 与 Windows、Node 24 与 26 上运行。它证明网关自身的行为与线上格式，**不能**证明与真实模型提供方、真实智能体的兼容性、真实的跨机器性能或账号访问。
- **兼容性实验室**：官方 SDK 与几个框架对着一个带示例智能体的隔离网关运行，十几个聊天客户端记录下来的请求被回放。过程中没有真实的模型或智能体，Cursor 未核实。
- **真实智能体的端到端：只有 Antigravity。** 验收脚本（`examples/live-agents-acceptance.ts`）对真实的 Antigravity 跑过一次，共 12 次真实调用。多数场景通过；没能验证的场景和未通过的一项（残留的后台进程）都列在 evidence 文件里。
- **审批与调用方工具**由针对替身的测试覆盖。在 2026-11-11 的一次手工联调里，调用方工具桥接也对真实的 ACP 智能体（Antigravity 与 Qoder）跑通过。
- **长时间运行与升级，用的是假模型**：`npm run soak` 对一个真实的网关进程跑过 32 分钟（带三次重启：SIGTERM、SIGKILL、SIGTERM）和 62 分钟单段，都满足了它的判据；`npm run upgrade-check` 与一个真实的 0.0.64 数据库覆盖了从上一版的升级。细节与限制见 [docs/zh-CN/stability.md](docs/zh-CN/stability.md)。
- **Docker 镜像**在 CI 里能构建，容器通过了烟雾测试（amd64）。
- **macOS 应用，人工检查过一次**：在一台 Apple 芯片的 Mac 上隔离运行，打开就是已连接状态，显示首次启动说明，刷新后仍然已连接，版本号正确，并且跟随系统语言。

**没有验证的**

- **Codex 与 Claude Code 没有跑过验收场景。** 2026-11-11 的手工联调记录了一次 Codex 托管调用成功、Claude Code 因命令行没有登录而失败；之后代码有变化，两者都没有重做。向它们交付图片没有验证。
- 内置智能体搭配真实模型提供方（`oaa connect` 的预设只对照各服务的文档核对过，并只在假服务上运行过）、真实 GitHub Pages 上的文档站点、反向代理后面的公网部署、跨机器调用、向公网 HTTPS 端点投递事件回调，以及 Cursor、Cline 之类把 Open Agent API 当作模型来调的客户端，都没有真实的端到端记录。
- Windows 与 Linux 上的真实智能体；Linux 包、`install.sh`、npm tarball 与多架构镜像，它们还没有走过发布工作流。
- 「接下来」里列出的桌面应用各项。

## 怎么帮忙

最有用的贡献，是在装了智能体的机器上做一次真实检查：

- 运行 `oaa verify codex`（或 `claude`、`agy`，或你在用的某个 ACP 智能体）先看计划，这一步什么都不会启动。我们缺的是 Codex 与 Claude Code。如果你同意，再加上 `--confirm-live-cost`：它会用智能体自己的登录发起真实调用，可能产生费用；它在隔离的网关上运行，不碰你自己的数据。读一遍脱敏后的 `report.md`，再用「智能体验证报告」issue 模板提交。
- 告诉我们哪个客户端或 SDK 不能用，附上版本、请求与错误码。
- 试一试桌面应用、Linux 包或 Docker 镜像，告诉我们哪里出了问题。

怎么提 issue 与 Pull Request 见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。
