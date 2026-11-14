# 第三方声明 / Third-Party Notices

本文件记录 Open Agent API 仓库中随附的第三方素材及其许可证。许可证全文位于 `licenses/`。

## 智能体标识图标（`web/agents/*.svg`）

控制台用这些图标标识各个智能体运行时。它们整体复用自同一作者的 Possibility 项目（`public/agents/`），来源与许可证沿用 Possibility 的记录：

- `web/agents/{codex,opencode}.svg`：来自 [Open Design](https://github.com/nexu-io/open-design) 提交 `5360b5a4e9c44edf9ab5582001efe0b651d66c49` 的 `apps/web/public/agent-icons/`。Copyright 2026 Open Design contributors，Apache-2.0（`licenses/OpenDesign-APACHE-2.0.txt`）。
- `web/agents/{qoder,antigravity}.svg`：来自 Open Design 提交 `b40f25a1c89552725f1fc31f8c2fad172f92acfe` 的同一目录。Copyright 2026 Open Design contributors，Apache-2.0（`licenses/OpenDesign-APACHE-2.0.txt`）。
- `web/agents/{cursor,kimi,gemini,copilot,kiro,vibe}.svg`：改编自 Open Design 提交 `b40f25a1c89552725f1fc31f8c2fad172f92acfe` 的 agent 图标目录（`cursor.svg` 对应上游 `cursor-agent.svg`；Kiro 图标补全了 1200×1200 背景矩形尺寸，路径、颜色与 viewBox 未改）。Copyright 2026 Open Design contributors，Apache-2.0（`licenses/OpenDesign-APACHE-2.0.txt`）。
- `web/agents/claude.svg`：使用 [Lobe Icons](https://github.com/lobehub/lobe-icons/blob/2e76c48721e91b9aaa40803a0fa2eb8aca7399c4/packages/static-svg/icons/claude-color.svg) 提交 `2e76c48721e91b9aaa40803a0fa2eb8aca7399c4` 的 Claude 标识。Copyright (c) 2023 LobeHub，MIT（`licenses/LobeIcons-MIT.txt`）。上游路径与 `#D97757` 填充未改，仅移除固有尺寸并补充无障碍元数据。
- 其余 `web/agents/*.svg`（如 `deepseek-harness`、`qwen`、`goose`、`cline`、`auggie`、`factory-droid`、`aider`、`devin`、`junie`、`kilo`、`trae-cli`、`claude-acp`、`codex-acp` 等）是为 Possibility 原创绘制的简化识别字形，随同一作者的项目复用。

各产品名称与标识归其各自所有者所有。这些图标仅用于在本地控制台中识别对应的智能体或 CLI，不代表任何背书，许可证也不授予商标权。

## ACP 智能体预设元数据（`src/config/agent-presets.ts`）

ACP 预设目录（命令名、参数、成熟度、文档链接）移植自同一作者的 Possibility 项目（`src/agent-presets.ts`、`shared/agent-onboarding.ts`）。其中的命令元数据改编自 [Open Design](https://github.com/nexu-io/open-design)，Copyright 2026 Open Design contributors，Apache-2.0（`licenses/OpenDesign-APACHE-2.0.txt`）：Vibe 命令形态来自 Open Design 提交 `b40f25a1c89552725f1fc31f8c2fad172f92acfe`；Kimi Code 依据其当前厂商 ACP 文档；固定版本的 `npx` 与二进制分发来自公开的 [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)。

修改说明（Apache-2.0 第 4(b) 条）：为 OAA 改写为「仅展示与发现」的元数据——不做模型探测、不注入 MCP、不处理凭据、不安装包、不自动启用或执行；`npx` 启动器预设不会被发现或运行；说明文字按 OAA 的实际行为重写。文件头保留了上述署名。

核实记录（2026-11-10）：目录里全部 32 个预设的启动命令都已逐个对照厂商自己的文档或 ACP 官方注册表核实，每条记录的 `source_url` 都指向核实所用的官方页面（Trae CLI 的官方文档已迁到 docs.trae.cn）。本次核实更正了 GLM 与 Grok 两个注册表启动器的固定版本，并去掉了 Hermes 预设里的 `--accept-hooks`（该参数会自动批准尚未确认的 shell 钩子）。上面的署名与许可证说明保持不变。

补充说明：「`npx` 启动器预设不会被发现或运行」指的是 OAA 不会用 `npx` 下载或执行这些包；其中 `claude-acp`、`codex-acp`、`codebuddy` 三个预设会在 `PATH` 上查找已经安装好的同名可执行文件，找到后可以由管理员显式启用。

ACP 客户端（`src/acp.ts`）是按公开的 Agent Client Protocol v1 规范独立编写的最小 JSON-RPC 实现，未随附或复制 `@agentclientprotocol/sdk` 的代码；开发时仅参照了该 SDK（Apache-2.0）发布的 `schema.json` 核对字段名。

## 品牌标识

`web/brand.svg`、`docs/brand/` 中的 Open Agent API 标识（O 与 A 互扣的细线字母组合）为本项目原创，由 `scripts/brand-icon.mjs` 生成。

## 界面图标

控制台的界面图标来自 [Lucide](https://lucide.dev)（ISC 许可证），通过已安装的 `lucide` 依赖在 `/icons.js` 提供，许可证全文（ISC，另含来自 Feather 的部分图标所适用的 MIT 许可证）复制在 `licenses/Lucide-ISC.txt`，也随 `node_modules/lucide` 分发。

## 界面字体（`web/fonts/*.woff2`）

控制台与开发者门户随产品发布四款字体，不依赖访问者本机是否安装。文件复制自 Fontsource 的 npm 包（5.3.0 版），许可证均为 SIL Open Font License 1.1（OFL-1.1），许可证全文位于 `licenses/`。`@font-face` 写在 `web/shared/fonts.css` 与 `web/shared/fonts-serif-sc.css`，网关在 `/fonts/` 与 `/portal/fonts/` 下提供。

| 字体 | 来源 | 随附的文件 | 许可证 |
| --- | --- | --- | --- |
| Geist（可变字重） | [vercel/geist-font](https://github.com/vercel/geist-font)，包 `@fontsource-variable/geist` | `geist-latin.woff2`、`geist-latin-ext.woff2` | OFL-1.1（`licenses/Geist-OFL-1.1.txt`） |
| Geist Mono（可变字重） | [vercel/geist-font](https://github.com/vercel/geist-font)，包 `@fontsource-variable/geist-mono` | `geist-mono-latin.woff2`、`geist-mono-latin-ext.woff2` | OFL-1.1（`licenses/GeistMono-OFL-1.1.txt`） |
| Instrument Serif（400，正体与斜体） | [Instrument/instrument-serif](https://github.com/Instrument/instrument-serif)，包 `@fontsource/instrument-serif` | `instrument-serif-latin{,-ext}{,-italic}.woff2` | OFL-1.1（`licenses/InstrumentSerif-OFL-1.1.txt`） |
| Noto Serif SC（600，按 unicode-range 切成 101 片） | Google Fonts，包 `@fontsource/noto-serif-sc` | `noto-serif-sc-<片>-600.woff2` | OFL-1.1（`licenses/NotoSerifSC-OFL-1.1.txt`） |

字体文件未作修改，只是改了文件名并按各包自带的 CSS 重写了 `@font-face`。字体名称归各自所有者所有；OFL 允许随软件再分发，但不得单独出售字体本身。

## npm 运行时依赖

下面是 `package.json` 的 `dependencies`（运行时依赖）。它们不随本仓库源码提交，由使用者执行 `npm ci` 从 npm 安装，各自适用其自带的许可证（许可证文件在安装后的 `node_modules/<包名>/` 下）。表中版本与许可证取自 `package-lock.json` 与已安装包的 `package.json`（2026-11-13 核对）。

| 包 | 版本 | 许可证 | 版权方 |
| --- | --- | --- | --- |
| `@anthropic-ai/sandbox-runtime` | 0.0.82 | Apache-2.0 | Anthropic |
| `@fastify/multipart` | 10.1.8 | MIT | The Fastify team |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | Anthropic, PBC |
| `ajv` | 8.20.0 | MIT | Evgeny Poberezkin |
| `fastify` | 5.12.8 | MIT | The Fastify team |
| `lucide` | 1.71.0 | ISC | Lucide Icons and Contributors |
| `ws` | 8.22.2 | MIT | Einar Otto Stangvik 与贡献者 |
| `yaml` | 2.9.1 | ISC | Eemeli Aro |
| `zod` | 4.6.7 | MIT | Colin McDonnell |
| `@anthropic-ai/claude-agent-sdk` | 0.3.322 | 专有（见下一节） | Anthropic PBC |

`@anthropic-ai/sandbox-runtime`（Apache-2.0，Copyright 2025 Anthropic）用于「沙箱执行」功能，Open Agent API 只把它作为 npm 依赖引用，没有复制或修改其源码。按 Apache-2.0 的要求，其许可证全文随该包分发（`node_modules/@anthropic-ai/sandbox-runtime/LICENSE`）；本项目的 `NOTICE` 里已注明这项依赖。

### 专有许可的依赖：`@anthropic-ai/claude-agent-sdk`

`@anthropic-ai/claude-agent-sdk` 的 `package.json` 写的是 `SEE LICENSE IN README.md`，包内 `LICENSE.md` 的内容是「© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.」。它**不是**开源软件，请注意：

- 它是 Open Agent API 的运行时依赖（`src/engines/native.ts` 等使用），由使用者自行从 npm 安装，使用受 Anthropic 自己的条款约束。
- 本项目的 Apache-2.0 许可证**只覆盖本仓库自己的代码与文档，不覆盖这个包**，也不授予使用它的任何权利。
- 本仓库不包含它的源码或二进制。它还带有按平台分发的可选依赖包（`@anthropic-ai/claude-agent-sdk-<平台>`，许可证同样是 `SEE LICENSE IN LICENSE.md`），同理。
- 再分发（例如自行打包带有 `node_modules` 的安装包）前，请先阅读并遵守上述 Anthropic 条款。

## 传递依赖的许可证核查（运行时依赖闭包）

范围：`package-lock.json` 中未标记 `dev` 的全部 190 个包，也就是从上面 10 个运行时依赖递归引入的全部包；其中 158 个已装进 `node_modules`，另 32 个是可选依赖（`@microsoft/mxc-sdk` 及其 `koffi`、`node-pty`、`node-addon-api`、20 个 `@koromix/koffi-<平台>`；`@anthropic-ai/claude-agent-sdk-<平台>` 8 个），在 `npm ci --omit=optional` 下不会安装，它们的许可证取自 `package-lock.json`。统计按各包 `package.json` 的 `license` 字段（未安装的按锁文件）：

| 许可证 | 数量（已安装 158） | 数量（含 32 个可选，共 190） |
| --- | --- | --- |
| MIT | 133 | 157 |
| ISC | 12 | 12 |
| BSD-3-Clause | 6 | 6 |
| Apache-2.0 | 3 | 3 |
| BSD-2-Clause | 1 | 1 |
| Unlicense（公共领域声明） | 1 | 1 |
| `(BSD-3-Clause OR GPL-2.0)`（双许可） | 1 | 1 |
| 专有（`SEE LICENSE IN ...`，均为 `@anthropic-ai/claude-agent-sdk` 及其平台包） | 1 | 9 |
| GPL / AGPL / LGPL / SSPL / 非商用 | 0 | 0 |
| 未知或缺失许可证字段 | 0 | 0 |

需要说明的几项：

- `node-forge` 1.4.3（由 `@anthropic-ai/sandbox-runtime` 引入）是 BSD-3-Clause 与 GPL-2.0 的双许可，使用者可任选其一；本项目按 **BSD-3-Clause** 使用，不受 GPL 约束。
- `fast-sha256` 1.3.0（经 `@anthropic-ai/sdk` → `standardwebhooks` 引入）是 Unlicense。
- 3 个 Apache-2.0 的包是 `@anthropic-ai/sandbox-runtime`、`@anthropic-ai/sdk`（由 `@anthropic-ai/claude-agent-sdk` 引入）与 `@opentelemetry/api`；它们的许可证文件随包分发。
- `abstract-logging`、`standardwebhooks` 两个包的目录里没有单独的 LICENSE 文件，`package.json` 的 `license` 字段均为 MIT。
- 除上面的专有依赖外，没有发现任何 GPL / AGPL / LGPL / SSPL / 非商用 / 许可证缺失的包。

开发依赖（`devDependencies`：`@anthropic-ai/sdk`、`@types/node`、`@types/ws`、`openai`、`prettier`、`typescript`）只用于构建与测试，不属于运行时，也不随运行时分发。

## Node.js 运行时（发布安装包）

GitHub Releases 上的安装包自带官方 Node.js 运行时（版本见 `.github/workflows/release.yml` 的 `NODE_RUNTIME_VERSION`，取自 https://nodejs.org/dist/ 并按 `SHASUMS256.txt` 校验），只包含 `node` 可执行文件（Windows 为 `node.exe`），未作修改（macOS 上为满足 Gatekeeper 重新签名）。Node.js 以 MIT 许可证发布，Copyright Node.js contributors；其中捆绑的第三方组件（V8、libuv、OpenSSL、ICU 等）的许可证列在同一文件中。完整的 `LICENSE` 随安装包分发：macOS 在 `Open Agent API.app/Contents/Resources/node/LICENSE`，Windows 在 `runtime\LICENSE`。从源码运行时不涉及此项。

公开发布的安装包不包含 `@anthropic-ai/claude-agent-sdk`（及其各平台包、只被它引用的 `@anthropic-ai/sdk`），Claude 原生引擎需要使用者另行安装，见 [docs/releasing.md](docs/releasing.md)。
