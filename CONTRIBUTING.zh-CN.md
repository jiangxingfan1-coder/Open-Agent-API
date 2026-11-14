# 参与贡献

[English](CONTRIBUTING.md) · 简体中文

感谢你愿意改进 Open Agent API。本文说明怎么搭环境、怎么验证改动、代码要守哪些约定，以及怎么提 issue 和 PR。更细的工程规则见 [docs/zh-CN/engineering.md](docs/zh-CN/engineering.md)，规则与仓库里的检查不一致时，以检查为准。

参与本项目即表示你同意遵守[行为准则](CODE_OF_CONDUCT.zh-CN.md)。安全漏洞请不要公开提 issue，按 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 私下报告。

## 语言约定

项目面向中文和英文两类读者，所以仓库是双语的。约定如下：

- **代码注释、测试名、提交信息、issue 与 PR**：以英文为主，中文同样欢迎，不会因为语言而拒绝任何贡献。现有代码里还有不少中文注释和测试名，你不需要翻译自己没改动的代码；新写的代码请用英文。
- **文档**：以英文为主。每份文档 `docs/X.md` 都有对应的中文版 `docs/zh-CN/X.md`，根目录的文件对应 `*.zh-CN.md`（`README.zh-CN.md`、`CONTRIBUTING.zh-CN.md`、`SECURITY.zh-CN.md`、`CODE_OF_CONDUCT.zh-CN.md`、`CHANGELOG.zh-CN.md`、`ROADMAP.zh-CN.md`）。改了一边，请在同一个 PR 里同步另一边；只会一种语言的话，在 PR 说明里讲一声，维护者会帮忙补另一种。
- **面向用户的文案必须中英双语**，尤其是：
  - 控制台文案：`web/lib/messages-*-zh.js` 与 `web/lib/messages-*-en.js`（开发者门户用 `web/portal/messages-zh.js` 与 `web/portal/messages-en.js`），两种语言的键必须完全一致；
  - 错误说明：`src/core/errors.ts` 的 `zh` / `next`，以及 `src/core/errors-en.ts` 的 `en` / `nextEn`；
  - 命令行与网关消息：用 `src/core/locale.ts` 的 `bi(zh, en)` 写双语；
  - 展示页 `site/index.html`（中文）与 `site/en/index.html`（英文）。
- 协议字段、JSON 字段名、错误码、命令与文件路径始终保持英文。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。按该许可证第 5 条，你有意提交到本项目的贡献，除非你明确另行声明，否则按同一许可证授权。请不要提交你无权以该许可证授权的代码、图标或文档；引入第三方素材时，请同时更新 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 并附上许可证原文（放在 `licenses/`）。

## 环境要求

- Node.js 24.18 及以上的 24.x（`package.json` 的 `engines` 为 `>=24.18.0 <25`，CI 用 Node 24，即最新的 24.x）。
- 不需要 Docker、Redis 或全局安装的包。

```sh
npm ci --omit=optional --ignore-scripts
npm run build
```

CI（`.github/workflows/ci.yml`）用的就是上面的安装参数，然后运行 `npm run verify`。

## 构建与测试

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 只做类型检查 |
| `npm run format` / `npm run format:check` | 用 Prettier 排版 / 只检查排版（单引号、行宽 100、尾随逗号） |
| `npm run test:offline` | 先 build，再运行**不监听端口**的测试 |
| `npm test` | 先 build，再运行全部测试 |
| `npm run verify` | `check` + `format:check` + `test`，提交 PR 前请跑通 |

测试用 Node 自带的 `node:test`，源码在 `test/*.test.ts`。其中一部分测试（文件里含 `.listen(`、`WebSocketServer(` 或 `createServer(` 的，目前 17 个）会在 `127.0.0.1` 的随机端口上临时监听，用本地替身代替真实模型，不访问外网；其余测试不监听任何端口，可以用 `npm run test:offline` 单独跑。改动过程中可以频繁跑 `npm run check` 与 `npm run test:offline`，提交前再跑完整的 `npm run verify`。测试里用到的外部智能体、模型提供方都是本地夹具，不需要真实账号或密钥。

## 代码约定

下面每一条都能在仓库里找到依据（`docs/zh-CN/engineering.md` 或 `test/architecture.test.ts`）。

- **分层与引用方向**：`src/` 下除 `src/cli.ts` 外，每个文件都放在一个分层目录里（`core`、`config`、`lang`、`store`、`providers`、`engines`、`fabric`、`kernel`、`gateway`、`client`），只能引用同目录或更低层的目录，不能形成循环引用（`import type` 也算）。新增文件前先想清楚它属于哪一层。
- **文件行数**：每个文件默认不超过 600 行；少数超过的文件登记在 `test/architecture.test.ts` 的 `LINE_BUDGETS`，上限只许调低，不许调高或新增登记，文件太长先拆分。
- **不许用 `any`**：`as any` 与 `: any` 的数量上限为 0。外部输入先用 `unknown` 接住，再用 zod 校验或 `typeof` 收窄。
- **错误码走错误目录**：新增错误码要在 `src/core/errors.ts` 的 `ROWS` 里登记（英文说明写在 `src/core/errors-en.ts`），用 `new Fault(code, message, status)` 抛出，并在 `docs/protocol.md` 与 `docs/zh-CN/protocol.md` 的错误码表里各补一行；`test/error-catalog.test.ts` 会核对。已发布的错误码、事件字段是稳定接口，不要改名或复用旧码表达新含义。运行事件同理，见 `docs/zh-CN/engineering.md` 第 4 节。
- **TypeScript 与命名**：ES 模块，相对引用写 `.js` 后缀；文件名小写短横线；类型与类 PascalCase，函数与变量 camelCase，模块级常量 UPPER_SNAKE_CASE；协议字段与错误码保持英文，错误码用 snake_case。
- **文案**：面向用户的文案必须中英双语（见上文「语言约定」）；注释用英文。
- **依赖**：不随意新增运行时依赖；确需新增时单独提交并说明理由。
- **兼容性红线**：既有请求在既有条件下的线上输出一个字节都不能变，也不改 SQLite 结构、节点线协议已有字段、已发布的错误码与事件（见 `docs/zh-CN/engineering.md` 第 7 节）。
- **署名**：`src/config/agent-presets.ts` 文件头与 `THIRD_PARTY_NOTICES.md` 里的 Apache-2.0 署名必须保留。
- **测试**：功能改动先写会失败的测试，再实现；纯重构不改测试断言，只允许改 import 路径。

## 提交信息

- 英文为主，中文同样欢迎。格式为 `范围：做了什么`（英文写作 `scope: what changed`），例如 `工程：新增离线测试入口 test:offline 与一键校验 verify`、`类型：消除 src 里全部 any`。常见范围：`工程`、`结构`、`类型`、`测试`、`排版`、`依赖`、`规划`、`OAA-Lang`、`文档`（英文：`engineering`、`structure`、`types`、`tests`、`formatting`、`deps`、`planning`、`OAA-Lang`、`docs`）。
- 一个提交只做一件事；只 `git add` 自己改的文件，不用 `git add -A`。
- 有用户可见的变化时，在 `CHANGELOG.md` 顶部的 `## Unreleased` 下记一笔（`CHANGELOG.zh-CN.md` 的 `## 未发布` 下同步记）。

## 提 issue

issue 与 PR 模板是英文的，用中文填写也可以。

- 缺陷：请使用 Bug 报告模板，写清楚版本（`package.json` 的 `version`）、Node 版本、操作系统、复现步骤、期望与实际结果。**不要贴密钥、令牌、`.oaa/admin.token` 的内容或未脱敏的日志。**
- 功能建议：请使用功能建议模板，先讲你要解决的问题，再讲想要的做法。
- 安全问题：不要提公开 issue，见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 提 Pull Request

1. 在 issue 里先说一下你想做的事，较大的改动尤其如此，避免白做。
2. 从 `main` 切出分支，改动保持小而聚焦。
3. 本地跑通 `npm run verify`；改了排版相关文件就先 `npm run format`。
4. 按模板填写 PR 说明：改了什么、为什么、怎么验证、有没有兼容性影响。
5. 维护者会在评审中提出意见；请在同一个 PR 里更新，不要另开新的。
