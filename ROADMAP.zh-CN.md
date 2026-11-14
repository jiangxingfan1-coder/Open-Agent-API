# 路线图

[English](ROADMAP.md) · 简体中文

这是 Open Agent API 的公开路线图，写于 0.0.64 版本（2026-11-14）。它是意向，不是承诺：条目可能调整、缩减或放弃，也没有日期。已经完成的见[变更记录](CHANGELOG.zh-CN.md)；现有功能实际验证到了什么程度，见本页末尾。

## 现在（下一个版本）

- **Linux 软件包与 Docker 镜像。** 目前安装包只有 macOS 与 Windows，Linux 上要从源码运行。我们想提供可安装的 Linux 软件包和官方 Docker 镜像。
- **用 npm tarball 安装。** 不用克隆仓库，直接从一个软件包 tarball 安装并运行网关。
- **完整的 Windows 测试在 CI 里跑通。** Windows 作业目前只跑类型检查、格式检查与打包相关的测试，因为不少测试用到 POSIX 专用写法（见 [docs/zh-CN/releasing.md](docs/zh-CN/releasing.md)）。目标是在那里跑完整套测试。
- **安全审查与威胁模型。** 对网关做一次书面审查，并给出[安全模型](docs/zh-CN/security-model.md)：谁能做什么、默认暴露什么、哪些不防护。
- **长时间运行测试、升级路径与数据保留。** 让网关在负载下长时间运行，写清版本之间怎么升级，并说明哪些数据保留多久。
- **官方 SDK 与常用兼容 OpenAI 的客户端的兼容性实验室。** 一套可重复的检查，针对官方 SDK 与广泛使用的客户端，公布它们的版本与结果。在它出现之前，兼容性靠测试套件和 [docs/zh-CN/protocol.md](docs/zh-CN/protocol.md) 里列出的 SDK 实测来保证，而不是测遍所有客户端。
- **命令行里的 `oaa approvals`、`oaa status` 与 `oaa verify`。** 列出并处理审批、查看网关与智能体的状态，并对本机的真实智能体做一次自检（见下文「怎么帮忙」）。
- **英文为主的文档。** 文档、社区文件与变更记录以英文为主，中文并行（引入本页的就是这项改动）。

## 接下来

- **运行事件的 webhook。** 运行需要审批、完成或失败时通知一个 HTTP 地址，调用方不必轮询。
- **强制的结构化输出。** `response_format: json_schema` 在网关返回 200 之前先校验；目前它只是作为输出要求交给智能体，并不强制。
- **三个协议统一的图片输入。** 目前所有兼容入口都以 `unsupported_content` 拒绝内联图片，要先上传文件。我们想让图片输入在 OpenAI、Claude、Gemini 三个入口里以同样的方式工作。
- **让开发者平台的账号密钥通过显式的选择加入上架来调用外部智能体。** 目前账号密钥只能是 `workspace` 或 `sandbox` 等级，调不了外部智能体。设想是运营者可以有意识地把某个外部智能体上架给开发者，并把风险写清楚，而不是平台只能提供内置智能体。

## 以后

- **本地与兼容 OpenAI 的模型提供方预设**（Ollama、LM Studio 等），供内置智能体使用，这样内置智能体不用手写配置就能跑在本地模型上。
- **Prometheus 指标**。
- **经过公证的 macOS 构建。** macOS 应用目前只做临时签名、没有公证，所以第一次打开时 macOS 会要求手动打开（见 [docs/zh-CN/releasing.md](docs/zh-CN/releasing.md)）。
- **全面改用英文源码注释。** 源码里仍有不少中文注释和测试名；新代码用英文写（见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)），旧代码会逐步转换。

## 验证状况

细节见 [docs/zh-CN/evidence.md](docs/zh-CN/evidence.md)；下面是刻意保守的简版：

**已验证的**

- **离线测试套件**（本地确定性模型、本地协议服务器与子进程夹具）。它证明网关自身的行为与线上格式，**不能**证明与真实模型提供方的兼容性、真实的跨机器性能或账号访问。
- **真实智能体的端到端：只有 Antigravity。** 端到端验收脚本（`examples/live-agents-acceptance.ts`）对真实的 Antigravity 跑过一次，经官方 OpenAI 与 Anthropic SDK 和纯 HTTP 共 12 次真实调用。多数场景通过；没能验证的场景和未通过的一项（残留的后台进程）都列在 evidence 文件里。
- **审批与调用方工具**由针对本地替身（假 ACP 智能体与协议级假智能体）的测试覆盖。在 2026-11-11 的一次手工联调里，调用方工具桥接也对真实的 ACP 智能体（Antigravity 与 Qoder）跑通过。端到端那次用的 Antigravity 引擎既不支持审批也不支持桥接，所以端到端验证没有覆盖它们。

**没有验证的**

- **Codex 与 Claude Code 没有用端到端脚本跑过。** 2026-11-11 的手工联调记录了一次 Codex 托管调用成功、Claude Code 因命令行没有登录而失败；之后代码有变化，两者都没有重做。
- 内置智能体搭配真实模型提供方、反向代理后面的公网部署、跨机器调用，以及 Cursor、Cline 之类把 Open Agent API 当作模型来调的客户端，都没有真实的端到端记录。
- Linux 上的真实智能体（CI 在 Ubuntu 上跑离线测试，但那里没有真实智能体的记录），以及 Windows 安装包：它从未通过发布工作流在 Windows 机器上运行过。

## 怎么帮忙

最有用的贡献，是在装了智能体的机器上做一次真实检查：

- `oaa verify` 上线后，对你能用的智能体跑一遍（我们缺的是 Codex 与 Claude Code），把报告作为 issue 提交，附上脱敏后的输出。它会发起真实调用，可能产生费用；确认之前请先看它要做什么。
- 在那之前，你可以按 [docs/zh-CN/evidence.md](docs/zh-CN/evidence.md) 的说明自己运行 `examples/live-agents-acceptance.ts`，并附上 `report.md`。里面不含密钥，但贴出前请先看一遍。
- 告诉我们哪个客户端或 SDK 不能用，附上版本、请求与错误码。

怎么提 issue 与 Pull Request 见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。
