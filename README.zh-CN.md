<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/oaa-mark-inverse.svg" />
    <img src="docs/brand/oaa-mark-ink.svg" alt="Open Agent API 标志：O 与 A 的单线交织" width="64" />
  </picture>
</p>

<h1 align="center">Open Agent API</h1>

<p align="center">
  <strong>把智能体变成 API。</strong><br />
  调用的不是模型，而是自带工具、技能与权限的智能体：一次调用，就是一个任务。
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="LICENSE"><img alt="许可证：Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-0e6b63?style=flat-square" /></a>
  <a href="package.json"><img alt="Node.js 24.18 及以上的 24 或 26 版本线" src="https://img.shields.io/badge/node-%E2%89%A524.18%20%3C27-0e6b63?style=flat-square" /></a>
</p>
<!-- 仓库公开后再加 CI 徽章；star 数等动态徽章同理，不要在公开前放需要仓库数据的徽章。 -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png" />
    <img src="docs/assets/hero-light.png" alt="Open Agent API 控制台概览（示例数据）：顶部是两个等待你处理的任务，下面是任务数、成功率、中位耗时，以及最近活动与智能体列表" width="100%" />
  </picture>
</p>

<p align="center">
  <img src="docs/assets/demo.gif" alt="演示：同一段 OpenAI SDK 代码只改 base_url 与 model 两处，调用本机的 Antigravity 智能体并拿到回答（真实录制，等待时间已加速）" width="100%" />
  <br />
  <sub>真实录制：调用的是本机的 Antigravity 智能体，实际耗时 8.5 秒，画面已加速。</sub>
</p>

## 三十秒看懂

把现有应用里的 Base URL 改一行，它就多了一个会干活、会停下来等你批准的智能体。下面是同一段 OpenAI SDK 代码，只改 `base_url` 与 `model` 两处（`api_key` 换成控制台里创建的密钥）。

```diff
 from openai import OpenAI

 client = OpenAI(
-    base_url="https://api.openai.com/v1",
-    api_key=OPENAI_API_KEY,
+    base_url="http://127.0.0.1:8787/v1",  # 你的 Open Agent API
+    api_key="sk-oaa-…",                   # 在控制台创建的 API 密钥
 )

 resp = client.chat.completions.create(
-    model="<某个模型>",
+    model="agent/research",               # 智能体的调用名
     messages=[{"role": "user", "content": "整理这三份报价单，比较交付周期与总价"}],
 )
 print(resp.choices[0].message.content)
```

Node.js 同理：

```diff
 import OpenAI from 'openai';

 const client = new OpenAI({
-  baseURL: 'https://api.openai.com/v1',
-  apiKey: process.env.OPENAI_API_KEY,
+  baseURL: 'http://127.0.0.1:8787/v1', // 你的 Open Agent API
+  apiKey: process.env.OAA_API_KEY, // 在控制台创建的 API 密钥
 });

 const resp = await client.chat.completions.create({
-  model: '<某个模型>',
+  model: 'agent/research', // 智能体的调用名
   messages: [{ role: 'user', content: '整理这三份报价单，比较交付周期与总价' }],
 });
 console.log(resp.choices[0].message.content);
```

对调用方而言，只有 Base URL 和 API Key 两样东西。`model` 填的是智能体的调用名，不是底层模型的名字；背后用哪个模型，由发布者在发布智能体时声明。Anthropic 与 Gemini 的 SDK 同样只需换服务地址和密钥，见下文[兼容的协议与 SDK](#兼容的协议与-sdk)。

## 三分钟跑起来

下面的源码路线需要 Node.js 24.18 及以上的 24 或 26 版本线（`package.json` 的 `engines` 为 `>=24.18.0 <27`）；安装包与 Linux 包自带 Node.js（其他路线见[其他安装方式](#其他安装方式)）。不需要 Redis，也不需要任何模型密钥。

### 最短路径：一条命令

```sh
git clone https://github.com/jiangxingfan1-coder/Open-Agent-API.git
cd Open-Agent-API
npm ci --omit=optional --ignore-scripts
npm run build
npm run oaa -- quickstart
```

`quickstart` 依次做五件事，并逐步打印：初始化 `.oaa/`（已初始化则跳过）→ 在后台启动网关，只监听 `127.0.0.1`（已在运行则复用）→ 发布离线示例智能体 `agent/sample` → 生成一把调用方密钥，存为私有文件 `.oaa/keys/quickstart.key`（已有且有效则复用，密钥本身不打印）→ 用这把密钥真调一次并打印回答。最后给出 Base URL、`model`、一条可以直接粘贴运行的 curl、一段官方 OpenAI SDK 的最小代码，以及「接上你自己的智能体」的下一步：本机装了 codex、claude 或 agy 时，每个只给一行 `oaa connect codex` 这样的命令；都没有时给出内置智能体加模型密钥的写法。重复运行不会重复创建。

示例智能体是仓库里的 `examples/sample-agent.mjs`：**不调用任何模型、不联网、不花钱**，回答由固定规则生成，开头写明「这是 Open Agent API 的离线示例智能体」。它演示多步执行、一次工具调用，任务里写上「审批」时还会停下来等你批准（在控制台批准，或用调用方密钥调用 `POST /v1/runs/{id}/actions/{action}`），批准后同一个任务接着完成。

默认端口是 8787；被占用时 `quickstart` 会明确报 `port_in_use`，用 `npm run oaa -- quickstart --port 18787` 换一个（端口写进 `.oaa/config.json`，下文的 `8787` 都要跟着换）。停止网关用 `npm run oaa -- stop`。

### 其他安装方式

每条路线最后都是 `oaa quickstart`。各路线的最短步骤、适用范围与卸载方法见 [docs/zh-CN/install.md](docs/zh-CN/install.md)。Linux 包、`install.sh`、npm tarball 与 Docker 镜像从 0.0.65 起随版本发布；0.0.64 只有 macOS 与 Windows 的安装包。

- **macOS 与 Windows 安装包**（`.dmg`、`.zip`）：从[发布页](https://github.com/jiangxingfan1-coder/Open-Agent-API/releases)下载。自带 Node.js；未做公证与代码签名，第一次打开要多点一下（步骤见 install.md）。
- **Linux，x64 与 arm64**（glibc 2.28 及以上；不需要 root，也不需要装 Node.js）：

  ```sh
  curl -fsSL https://github.com/jiangxingfan1-coder/Open-Agent-API/releases/latest/download/install.sh | sh
  oaa quickstart
  ```

  脚本会用发布页的 `SHA256SUMS` 校验下载，装到 `~/.local` 下。
- **Docker**（在仓库目录里 `docker compose up --build -d`）：网关只发布在宿主机的 `127.0.0.1:8787`。容器里没有宿主机上装的命令行智能体（没有 Codex、没有 Claude Code），所以适合：用你自己的模型密钥的内置智能体、ACP / A2A 远程智能体、以及连进来的执行节点。CI 在每次 push 时构建镜像并对容器做烟雾测试；`ghcr.io` 上的镜像（amd64 与 arm64）在发布 Release 时推送。
- **npm tarball**（需要 Node.js 24.18 及以上的 24 或 26 版本线）：`npm install -g <发布页上 open-agent-api-<版本>.tgz 的地址>`，然后 `oaa quickstart`。这个包是 `private` 的，不在 npm 官方源上。

### 接上你自己的智能体：`oaa connect`

`npm run oaa -- connect codex`（或 `claude`、`agy`，以及 `oaa doctor` 列出的 ACP 智能体名）一步完成：检测它是否已安装 → 在本网关启用（只改本网关的记录，不改它自己的配置与登录）→ 发布为 `agent/codex`（已发布则跳过）→ 确认 quickstart 的密钥能调用它 → 打印 `model` 和一条可粘贴的 curl。connect **不会调用**这个智能体：第一次调用会使用它自己在这台机器上的登录状态与额度。没安装时会说明先安装并登录，再运行 quickstart 让网关识别它。

### 给内置智能体接上模型：`oaa connect <预设>`

内置智能体（网关自己的智能体循环）需要一个模型提供方。`oaa connect ollama`（本地模型，不需要密钥）或 `oaa connect deepseek --key-file ~/.config/deepseek.key`（还有 `openai`、`anthropic`、`gemini-api`、`openrouter`、`lmstudio`、`openai-compatible` 等）会把提供方写进 `.oaa/config.json`，重启由这个数据目录启动的网关，发布 `agent/assistant`（一个带工作区文件工具的通用助手），确认 quickstart 的密钥，并打印一条 curl。密钥从不在命令行里输入：`--key-env` 写变量名，`--key-file` 指向一个文件。它不会调用模型，除非你加 `--test`（只对本机地址的端点）；`oaa models` 列出已配置的提供方以及它们的密钥能不能解析。这些预设取自各服务自己的文档，只在假服务上运行过。见 [docs/zh-CN/models.md](docs/zh-CN/models.md)。

### 分步做

要发布真正干活的智能体，需要本机装好并登录过的 Codex、Claude Code、Antigravity 或某个 ACP 智能体（`npm run oaa -- doctor` 会列出找到了哪些），或者一个模型提供方的 API Key（用来跑内置智能体）。下面是 `quickstart` 背后的分步做法：

```sh
npm run oaa -- init                 # 生成 .oaa/config.json 与管理员密钥 .oaa/admin.token
npm run oaa -- serve --detach       # 后台启动，打印 {"url": …, "pid": …}；停止用 npm run oaa -- stop
```

不想后台运行就用 `npm start`（占住当前终端，后面的命令要另开一个终端）。

1. **打开控制台**：浏览器访问 `http://127.0.0.1:8787`，在连接设置里选择 `.oaa/admin.token`。这个管理员密钥不要分享。
2. **发布一个智能体**：在控制台点「发布智能体」。用源码或命令行（`oaa init`）初始化时，发现的外部智能体默认是**停用**的，需要先在控制台「执行机器」里启用；macOS 桌面应用为了开箱即用，启动时会把检测到已安装的本机智能体（codex、claude、agy、dsh）设为启用，网关只监听本机回环地址 `127.0.0.1`，不想让某个智能体可被调用就在「执行机器」里把它停用（选择记在本地数据库里）。开关只记在本平台里，不改动外部智能体自己的全局配置，也不提取或修改已有的凭据。命令行的等价写法（`default` 表示沿用外部智能体自己配置的模型）：

   ```sh
   npm run oaa -- publish-native --id agent/codex --engine codex --models default \
     --url http://127.0.0.1:8787 --token-file .oaa/admin.token
   ```

   也可以用 OAA-Lang 或 JSON 定义一个内置智能体，见 [docs/zh-CN/language.md](docs/zh-CN/language.md) 与 [操作手册](docs/zh-CN/operations.md)（那需要一个模型提供方：上面的 `oaa connect <预设>` 可以配好，`examples/` 里的定义模板用的是占位符）。
3. **创建 API 密钥**：控制台「API 密钥」页点「生成密钥」，结果页会给出服务地址（Base URL）、API Key（形如 `sk-oaa-…`，只显示一次）和模型名，各自可以一键复制。为每个调用方应用单独创建一把。命令行的等价写法（密钥写进私有文件，不打印到屏幕上）：

   ```sh
   npm run oaa -- key create --name myapp --agent agent/codex \
     --url http://127.0.0.1:8787 --token-file .oaa/admin.token
   ```

   输出里的 `token_file` 是存放密钥的文件（默认 `.oaa/keys/myapp.key`），`base_url` 和 `model` 就是上面 SDK 代码要填的两样，`try` 是一条可以直接粘贴运行的 curl 命令。默认权限是调用、读取、上传文件；要让这把密钥也能批准审批，加 `--approve`。
4. **第一次调用**：把上面的 Python 或 Node 代码里的三样东西换成你的，或者直接运行上一步输出的 `try` 命令。命令行也可以提交后台任务：

   ```sh
   npm run oaa -- invoke agent/codex --input '你的任务' \
     --url http://127.0.0.1:8787 --token-file .oaa/keys/myapp.key
   npm run oaa -- wait <上一步输出的 id> --url http://127.0.0.1:8787 --token-file .oaa/keys/myapp.key
   ```

   `invoke` 立即返回任务 `id`（状态 `queued`），`wait` 等它结束，`output` 读取输出文字。不想每次都写 `--url` 与 `--token-file`，可以设置环境变量 `OAA_GATEWAY_URL` 与 `OAA_TOKEN_FILE`。这次调用会出现在控制台的任务列表里。

模型别名由发布者声明，并不代表上游账号确实可用。

### 常见报错

| 现象 | 原因与下一步 |
| --- | --- |
| HTTP 401 `unauthorized` | 没带密钥或密钥无效。OpenAI / Claude / Gemini 的 SDK 分别用 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key` 发送，填上第 3 步的密钥 |
| HTTP 403 `scope_denied` | 这把密钥没有授权这个 `model`。最常见的原因是 `model` 写错了：用这把密钥请求 `GET /v1/models` 看它能调用哪些智能体 |
| HTTP 404 `agent_not_found` | 网关里没有这个智能体（用管理员密钥调用时才会看到这个码）。同样先看 `GET /v1/models` |
| HTTP 503 `model_unavailable` | 智能体已发布，但没有能执行它的地方：外部智能体没安装或没在「执行机器」里启用，或内置智能体的模型提供方没配好（例如没有设置 `OPENAI_API_KEY`）。`npm run oaa -- doctor` 列出本机找到的智能体 |
| 命令行 `gateway_unreachable`，SDK 报 `Connection error` | 网关没启动或地址不对：`npm run oaa -- serve --detach`，或检查 `--url` 与 `.oaa/config.json` 里的端口 |

### 不装任何智能体也能看的能力

`quickstart` 发布的 `agent/sample` 就是为此准备的：用它可以亲手看到多步执行与工具调用（任务检查器的时间线与步骤），以及任务里写「审批」时的持久审批。它不能续接会话（带 `previous_response_id` 的调用会被 `native_resume_unsupported` 拒绝，因为它的 ACP 进程既没有声明 `session/load` 也没有声明 `session/resume`），取消时运行以 `incomplete` 而不是 `cancelled` 结束。需要续接、取消、恢复、异常等更多行为时，仓库的 `test/fixtures/acp-agent.mjs` 是测试用的 ACP 替身（只在源码目录里有），接法与示例智能体相同：在 `.oaa/config.json` 的 `localWorker.adapters` 里加一项 `{"transport":"acp","command":"<node 绝对路径>","args":["<仓库绝对路径>/test/fixtures/acp-agent.mjs","stream"],"enabled":true}`，重启网关后 `publish-native --engine adapter/<名字>`；输入里带 `MODE:permission` 时停在待审批，带 `MODE:hang` 时一直运行，可以用 `npm run oaa -- cancel <id>` 取消。

另有 `npm run demo`：在进程内用本地确定性模型跑一遍内核（不启动网关），写出 `.oaa-demo/report.md`。

## 它和模型中转平台有什么不同

模型中转平台分发的是模型的推理额度；这里分发的是完整的智能体。它借用了那类平台的形态（账号、密钥、额度、用量、后台），不借用它们的供给方式：不做订阅池，不中转登录态。

| | 模型中转平台 | Open Agent API |
| --- | --- | --- |
| 分发的东西 | 模型的推理额度 | 智能体：自带工具、技能、模型线路与权限的完整执行单元 |
| `model` 填什么 | 模型名 | 智能体的调用名，如 `agent/research` |
| 一次调用是什么 | 一次模型补全 | 一个任务：多轮工具循环，可审批、可中断、可恢复，有产物 |

## 能接入哪些智能体

被调用的智能体可以是用 OAA-Lang 或 JSON 定义、由内置内核驱动的智能体，也可以是本机已安装的外部智能体。外部智能体自带工具、模型和权限，网关负责把它变成 API：调度、审批、检查点与恢复由网关统一处理。

| 接入方式 | 流式文本 | 运行中审批 | 调用方工具桥接 | 图片输入 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 内置内核（OAA-Lang / JSON 定义） | 逐 token | 支持，工具声明需要审批时停车等待 | 支持 | 模型线路接受图片时支持 | 用你配置的模型提供方，可多线路与故障转移 |
| Codex | 逐 token | 支持 | 不支持 | 原生支持（没有对真实智能体运行过） | 专用的 app-server 接入，支持会话续接 |
| Claude Code | 按消息 | 支持 | 不支持 | 原生支持（没有对真实智能体运行过） | 官方 Agent SDK，使用单独安装的命令行与它自己的配置 |
| Antigravity | 逐 token | 不支持：智能体自身拒绝时任务以 `permission_denied` 失败 | 不支持 | 作为工作区里的文件 | `stream-json` 接入，是目前唯一做过真实验证的外部智能体 |
| ACP 智能体 | 逐 token | 支持（只选 `allow_once`） | 支持 | 智能体声明支持时用 ACP 图片块，否则作为文件 | [Agent Client Protocol](https://agentclientprotocol.com)，内置了常见 ACP 智能体的接入预设 |
| 自写适配器（`oaa/1` stdio、`oaa/1-stream`、HTTP） | 取决于所选形式 | `oaa/1-stream` 支持 | 不支持 | stdio：作为文件；HTTP：不支持 | 给没有现成接入的智能体包一层 |
| A2A 远程智能体 | 支持（SSE） | 不桥接：`input-required` 以智能体的问题结束本轮 | 不支持 | 不支持 | 经 `contextId` 续接同一任务 |

这张表是摘要，每种接入方式在每个协议下的取消、续接、用量与产物能力见 [docs/zh-CN/adapters.md](docs/zh-CN/adapters.md#agentapi-转换契约2026-11-08)，每个智能体的 `conversion` 字段也会给出同样的画像。几点说明：

- 能力差异在「交互深度」，不在「能不能接入」。四类接入方式都可以把智能体发布成 Agent API。
- 外部智能体的权限是继承的，网关不对它做沙箱隔离：一次调用可以读取或修改宿主运行时允许的任何内容。调用方的密钥需要具备 `host` 执行等级才能调用外部智能体；对外分发时请阅读[公网部署](docs/zh-CN/deploy-public.md)里的建议。
- 发布外部智能体时可以把权限请求设为自动批准（`--approvals auto`）。这等于让调用方以你在这台机器上的权限驱动它，只对你信任的调用方开放，风险说明见 [docs/zh-CN/protocol.md](docs/zh-CN/protocol.md#approval-policy-for-external-agents-approval-policy-v1)。
- 调用方自己也是智能体（Cursor、Cline、Claude Code 之类）时，它传来的 `tools` 默认（`auto` 模式）会交给能接管它们的智能体（调用以标准 `tool_calls` 交回调用方执行，结果回传后同一个任务接着做）；接管不了的智能体照旧用自己的工具。也可以显式选 `managed`、`bridge`、`reject`、`auto`，`clientTools.default` 可以改变缺省值。见 [docs/zh-CN/harness.md](docs/zh-CN/harness.md)。
- 把图片发给不能用图片的智能体，会在运行创建之前被拒绝；`GET /v1/models` 里每个智能体都有 `image_input`。每种智能体怎么接收图片、上限，以及网关缺省不抓取远程图片 URL：见 [docs/zh-CN/images.md](docs/zh-CN/images.md)。
- 调用方也可以经 MCP 入口发现并调用智能体：`npm run oaa -- mcp --url … --token-file …` 或 `npm run oaa -- integration` 生成启动配置，见[操作手册](docs/zh-CN/operations.md)。出于安全考虑，MCP 入口刻意不提供批准审批的工具。

## 兼容的协议与 SDK

| 入口 | 官方 SDK 的验证情况 |
| --- | --- |
| OpenAI Chat Completions 与 Responses（流式与非流式） | 仓库里有常驻的回归测试，用官方 `openai` Node SDK 经进程内网关运行，不监听端口；下面的兼容性实验室还会让 Python 与 Node 的 SDK 经套接字运行 |
| Claude Messages | 同样有常驻的回归测试，用官方 `@anthropic-ai/sdk` 1.3.0；实验室运行 Python SDK 和更新的 Node SDK |
| Gemini `generateContent` / `streamGenerateContent` | 实验室运行 `google-genai`（Python）与 `@google/genai`（Node）；回归测试按线上格式断言。更早的一次性实测用临时安装的 `@google/genai` 3.2.0，探测脚本在 [examples/gemini-sdk-probe.mjs](examples/gemini-sdk-probe.mjs) |
| `oaa/1` 原生协议、UAP/1、MCP | 见 [docs/zh-CN/protocol.md](docs/zh-CN/protocol.md) |

除这些回归测试外，兼容性实验室（`npm run compat`，CI 里每次 push 与每周都会跑）用真实的包去打一个隔离的离线网关，网关里的智能体是示例智能体或确定性夹具，不是真实的智能体：官方 `openai`、`anthropic`、`google-genai` 的 Python SDK 与对应的 Node SDK、Vercel AI SDK、LangChain、LiteLLM、OpenAI Agents SDK、LlamaIndex。Open WebUI、LibreChat、Chatbox、Cherry Studio、LobeChat、NextChat、Dify、n8n、Continue、Cline / Roo Code、Zed 没法在测试里装起来跑，所以按它们源码里读到的请求形状回放；Cursor 闭源，未核实。哪些是实际运行、哪些是回放，各客户端怎么配置，以及不支持或被忽略的参数怎么处理，见 [docs/zh-CN/compatibility.md](docs/zh-CN/compatibility.md)。

任何兼容这几家协议的客户端，只要填 Base URL 和 API 密钥就能用；`Authorization: Bearer`、`x-api-key`、`x-goog-api-key` 三种鉴权头都接受。不支持的输入会明确报错，而不是悄悄降级：例如音频和其他内联的二进制内容一律返回 400 `unsupported_content`，需要先经 `POST /v1/files` 上传再引用；只影响采样的参数（`temperature`、`top_k` 等）会被接受并忽略，响应头 `X-OAA-Ignored-Params` 会说明忽略了哪些。见 [docs/zh-CN/protocol.md](docs/zh-CN/protocol.md#兼容入口的参数错误与结束原因060)。

**流式里的过程。** 流式调用还可以显示智能体在做什么：运行的每个阶段（排队、调用了某个工具、等待审批）发一行简短的说明，用各协议自己的思考形状，所以已经会显示模型思考的客户端不用改动就能显示它。Responses 与 Gemini 默认开，Chat Completions 与 Claude Messages 默认关；可以按请求用 `X-OAA-Progress: reasoning | off` 切换，也可以在配置里按协议用 `streamProgress` 设置。答案本身不会变。见 [docs/zh-CN/progress.md](docs/zh-CN/progress.md)。

除了文字，调用方还可以要求两样东西：每个入口上的**图片**（[docs/zh-CN/images.md](docs/zh-CN/images.md)），以及**保证符合某个 schema 的 JSON**（`response_format`、`text.format`、`responseSchema`、`output_config.format`）：网关校验答案，把答错的发回给智能体修正，仍然不对就让运行以 `structured_output_invalid` 失败，而不是返回一段只是看起来像 JSON 的文字（[docs/zh-CN/structured-output.md](docs/zh-CN/structured-output.md)）。

## 控制面：让人留在回路里

智能体会读文件、跑命令、写代码。网关把「人什么时候介入」做成了持久的状态，而不是一次性的弹窗。

- **审批**：智能体要做需要批准的操作时，任务停在「待审批」。你可以在控制台、在终端里（`oaa approvals`、`oaa approve`、`oaa deny`），或用带 `approve` 权限的密钥调用接口批准或拒绝，之后同一个任务接着做。审批是持久的挂起点，不是一次性的弹窗。
- **事件回调**：运行事件（完成、失败、等待审批等）可以推送到你自己的一个 HTTPS 端点，带签名并会重试（`oaa webhook add`），调用方不用轮询，审批请求也可以送进你的聊天工具或自己的系统。见 [docs/zh-CN/webhooks.md](docs/zh-CN/webhooks.md)。
- **中断与恢复**：任务可以随时取消。被中断的任务可以恢复；结果未知的外部写入（例如命令执行到一半被中断），必须人工确认结果后才能恢复。
- **幂等**：带 `Idempotency-Key` 请求头时（每个入口都认它），同一个键只对应一个任务；同键不同输入返回 409。
- **任务检查器**：每个任务的时间线、关键路径、执行步骤、审批与产物都能查看，也能回放事件流。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/inspector-dark.png" />
    <img src="docs/assets/inspector-light.png" alt="任务检查器（示例数据）：一个代码智能体的任务停在待审批，展开后能看到它要执行的命令 npm test，右下角是拒绝与批准按钮" width="100%" />
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/runs-dark.png" />
    <img src="docs/assets/runs-light.png" alt="任务列表（示例数据）：按全部、进行中、需处理、已完成、失败筛选，每行是智能体、任务内容、状态与耗时" width="100%" />
  </picture>
</p>

控制台创建 API 密钥后的结果页，给出的就是调用方需要的全部：

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/api-key-dark.png" />
    <img src="docs/assets/api-key-light.png" alt="创建 API 密钥后的结果页（示例数据）：服务地址 https://api.example.com/v1、示例密钥 sk-oaa-exampleexample…，以及模型名 agent/research，各有一个复制按钮" width="560" />
  </picture>
</p>

控制台的使用说明见 [docs/zh-CN/console.md](docs/zh-CN/console.md)。

## 作为开发者平台对外提供

网关可以作为开发者平台对外提供：开发者自助注册，在门户里创建自己的 API 密钥，按任务计点调用你上架的智能体。在控制台「开发者平台」页点「启用」即可（保存后重启网关生效），你在同一页上架智能体、定价、发放点数、管理账号；也可以在配置文件里写 `platform` 段。不启用时这些功能都不存在，网关的行为不变。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/portal-dark.png" />
    <img src="docs/assets/portal-light.png" alt="开发者门户首页（示例数据）：标题是调用的不是模型，而是智能体，下面是服务地址、与模型中转平台的三点不同" width="100%" />
  </picture>
</p>

默认情况下，开发者只能调用内置智能体。运营者也可以把一个外部智能体（Codex、Claude Code、ACP 智能体）上架给平台账号，逐个上架项放开，开关默认关闭：打开后这个智能体以运行网关的系统用户的权限运行，所以请先读安全说明。每个任务的价格在任务开始时预扣，任务没有完成就退回；按 token 的扣费不会把余额扣成负数；不上报 token 用量的智能体只能按次定价。

点数是运营者发放的记账单位，平台不接支付、不发邮件。计费规则、接口与限制见 [docs/zh-CN/platform.md](docs/zh-CN/platform.md)。

## 桌面应用与命令行

- **命令行**：`oaa --help`（在源码检出目录里是 `npm run oaa -- --help`）列出全部子命令，包括 `quickstart`、`connect`、`init`、`serve`、`stop`、`status`、`doctor`、`models`、`prune`、`key create`、`publish`、`publish-native`、`invoke`、`wait`、`approvals`、`approve`、`deny`、`webhook`、`verify`、`cancel`、`resume`、`nodes`、`mcp`；`check` 与 `fmt` 用来检查和格式化 OAA-Lang 源码，编译、检查和格式化都不调用模型。`oaa connect <预设>` 与 `oaa models` 为内置智能体配置并列出模型提供方，`oaa prune` 删除旧的已结束运行（除非你设置了 `retention` 或运行它，否则什么都不会被删），`oaa status` 显示网关和它的智能体怎么样了，`oaa verify` 在你的机器上对一个真实智能体做自检（它会先打印要做什么，加 `--confirm-live-cost` 之前什么都不会启动）。每条命令按任务分组的说明见 [docs/zh-CN/cli.md](docs/zh-CN/cli.md)。
- **macOS 桌面应用**：源码在 `desktop/macos`，内嵌的是同一个控制台，提供 Dock 角标与审批通知；它的菜单与对话框跟随系统语言，端口取自它自己的 `config.json`，也可以与已安装的副本隔离运行（`OAA_DESKTOP_HOME`、`OAA_DESKTOP_PORT`，见 [install.md](docs/zh-CN/install.md#macos)）。可以用 `npm run package:mac` 从源码打包（`npm run package:win` 对应 Windows）。安装包在发布页（[安装路线](docs/zh-CN/install.md)）；macOS 与 Windows 的安装包未经公证、没有代码签名，自己打包的也一样。这个版本的改动由所有者在一台 Apple 芯片的 Mac 上以隔离方式人工检查过一次；检查覆盖了什么、没覆盖什么，见 [docs/zh-CN/releasing.md](docs/zh-CN/releasing.md#发布前的人工检查)。

## 文档

按「我想……」组织的完整索引在 [docs/zh-CN/README.md](docs/zh-CN/README.md)。常用入口：[安装](docs/zh-CN/install.md)、[命令行](docs/zh-CN/cli.md)、[操作手册](docs/zh-CN/operations.md)、[协议](docs/zh-CN/protocol.md)、[与 SDK 和客户端的兼容](docs/zh-CN/compatibility.md)、[结构化输出](docs/zh-CN/structured-output.md)、[图片输入](docs/zh-CN/images.md)、[事件回调](docs/zh-CN/webhooks.md)、[模型提供方](docs/zh-CN/models.md)、[流式里的运行过程](docs/zh-CN/progress.md)、[稳定性与数据保留](docs/zh-CN/stability.md)、[双层 Harness](docs/zh-CN/harness.md)、[OAA-Lang](docs/zh-CN/language.md)、[接入外部智能体](docs/zh-CN/adapters.md)、[控制台](docs/zh-CN/console.md)、[Windows](docs/zh-CN/windows.md)、[公网部署](docs/zh-CN/deploy-public.md)、[安全模型](docs/zh-CN/security-model.md)、[开发者平台](docs/zh-CN/platform.md)、[架构](docs/zh-CN/architecture.md)、[验证证据](docs/zh-CN/evidence.md)、[工程规范](docs/zh-CN/engineering.md)、[变更记录](CHANGELOG.zh-CN.md)、[路线图](ROADMAP.zh-CN.md)。可复制运行的调用示例（curl、Python、Node）在[示例集](examples/cookbook/README.zh-CN.md)里。`node tools/docs-site/build.mjs` 会把全部文档（中英文，带搜索）生成为静态站点，由 Pages 工作流发布。

## 现状与边界

下面写的是做过什么、没做什么，不是路线图。带日期的细节见 [docs/zh-CN/evidence.md](docs/zh-CN/evidence.md)。

**测试与 CI**

- 项目用 `node:test` 写了 1,101 项测试，`npm run verify` 跑类型检查、排版检查与全量测试，`npm run test:offline` 只跑不监听端口的那部分。
- CI 在 Ubuntu 与 macOS 上用 Node 24 与 Node 26 跑全量测试，也在 Windows 上跑（Node 24；只在 POSIX 上有意义的测试带明确原因跳过）。它还会构建 Docker 镜像并对容器做烟雾测试，并运行兼容性实验室。
- 测试用本地确定性模型、本地协议服务器和替身智能体。它们**不能**证明真实提供方、真实智能体的兼容性、真实的跨机器性能或账号访问。流式、公平性与配对基准都是本地测量，条件与限定见[操作手册](docs/zh-CN/operations.md)与 [docs/zh-CN/architecture.md](docs/zh-CN/architecture.md)。
- 兼容性实验室让官方 SDK 与几个框架对着一个智能体是示例或夹具的网关运行，并回放聊天客户端记录下来的请求。回放只说明客户端的请求被接受、并以它能解析的形式回答，不说明整个应用可用。Cursor 未核实。见 [docs/zh-CN/compatibility.md](docs/zh-CN/compatibility.md)。
- 压测（`npm run soak`，macOS 与 Linux）让一个真实的网关进程在混合负载下跑过 32 分钟（带三次重启）和 62 分钟单段，并检查了从 0.0.64 的升级（`npm run upgrade-check`）。两者用的都是假模型和离线示例智能体。数字、压测带来的修复、崩溃恢复的语义和已知限制见 [docs/zh-CN/stability.md](docs/zh-CN/stability.md)。

**真实智能体验证**

- 经过真实验证的只有 Antigravity：一次端到端验证（2026-11-13）共 12 次真实调用，通过了 OpenAI Chat 非流式与流式、Responses 续接、Claude Messages、Gemini `generateContent`、取消与并发。这只验证了那一条本地线路和那一个引擎；审批与调用方工具桥接在 Antigravity 下不支持。验证脚本是 [examples/live-agents-acceptance.ts](examples/live-agents-acceptance.ts)，`oaa verify` 在你的机器上运行同一批场景。
- Codex、Claude Code、内置智能体搭配真实模型提供方（包括 `oaa connect` 的预设）、公网部署，**尚未**做过这样的端到端验证。向 Codex 与 Claude Code 交付图片是按厂商文档实现的，没有对真实智能体运行过。[docs/zh-CN/evidence.md](docs/zh-CN/evidence.md) 记录了更早的一次手工联调：它的结论是 Codex 的一次托管调用通过，Claude Code 因命令行未登录而失败，之后代码有过改动，没有复测。如果你装了 Codex 或 Claude Code，运行 `oaa verify` 并用[智能体验证报告](https://github.com/jiangxingfan1-coder/Open-Agent-API/issues/new/choose)模板把报告发给我们，是最有用的帮助。

**安装与平台**

- Docker 镜像在 CI 里构建并通过烟雾测试（amd64）。Linux 包、`install.sh`、npm tarball 与多架构镜像还没有走过发布工作流；第一个包含它们的版本就是它们的第一次运行。
- Windows：完整测试在 CI 里通过，但没有在 Windows 上用真实的 Codex、Claude Code 或 Antigravity 试过，那里也没有沙箱。
- macOS 桌面应用由项目所有者在一台 Apple 芯片的 Mac 上以隔离方式人工检查过一次：打开就是已连接状态，首次启动说明只出现一次，刷新后仍然已连接，版本号正确，菜单与对话框跟随系统语言。没有检查的：端口被占用时的提示、系统语言两个方向的切换、用同一个数据目录重启、应用崩溃后遗留网关的恢复、Intel 芯片的包、在默认端口上的正常安装，以及 Windows 启动器的双语提示。
- macOS 与 Windows 的安装包未经公证、没有代码签名。

**开发者平台**

- 单网关加 SQLite：不支持多实例与 Postgres，也不做多个发布者各自结算。
- 没有真实的支付渠道：点数不接支付；没有邮箱验证，也没有邮件找回密码（重置码由运营者经其它渠道交给开发者）。限流计数在进程内存里，重启后清零。
- 账号密钥只能调用内置智能体，除非运营者为某个上架项打开 `host_execution`，那样这个外部智能体会以运行网关的系统用户的权限运行。这条路径用离线示例智能体测过；真实外部智能体的计费成功路径没有见到过。
- 没有在真实公网部署上验证过。

**其它**

- 要求的 JSON schema 由网关自己强制保证，没有交给模型提供方自己的结构化输出功能；强制工具选择（`tool_choice` 为 required）不支持；不支持音频输入。
- 外部智能体可能不报告 token 用量，此时只有按次价格生效；报告的 token 数不是费用估算，token 上限也不作为可强制执行的花费上限。
- 事件回调只对本机的接收端测过，没有对公网 HTTPS 端点测过。
- 数据保留到你删除为止：默认的 `retention` 什么都不删，所以数据库会随使用增长。`oaa prune`，或用 `retention.runsDays` 设一个定时器，会清理早于某个时间点的已结束运行；`oaa doctor` 会报告数据库大小（[docs/zh-CN/stability.md](docs/zh-CN/stability.md#4-数据保留与-oaa-prune)）。
- 文档站点已经构建、链接也检查过，但还没有在真实的 GitHub Pages 上看过。
- 网关不防护什么（例如注册没有邮箱验证、登录失败计数只在内存里）见 [docs/zh-CN/security-model.md](docs/zh-CN/security-model.md)。
- 不扫描用户主目录寻找密钥，不训练基础模型，不实现订阅池或隐藏的认证中转。

## 参与、安全与行为准则

欢迎提 issue 与 Pull Request：见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。发现安全漏洞请阅读 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)，不要公开提交。参与即表示同意遵守 [CODE_OF_CONDUCT.zh-CN.md](CODE_OF_CONDUCT.zh-CN.md)。

## 许可与署名

本项目以 [Apache License 2.0](LICENSE) 授权，版权声明与必须保留的署名见 [NOTICE](NOTICE)。第三方组件的许可与署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。注意：运行时依赖 `@anthropic-ai/claude-agent-sdk` 是 Anthropic 的专有软件，由使用者自行从 npm 安装并受其自身条款约束，本项目的许可证不覆盖它（详见 THIRD_PARTY_NOTICES.md）。

ACP 智能体接入预设的元数据，以及部分智能体图标，改编自 [Open Design](https://github.com/nexu-io/open-design)（Apache-2.0，Copyright 2026 Open Design contributors），具体范围与许可证文本见 [NOTICE](NOTICE) 与 [licenses/OpenDesign-APACHE-2.0.txt](licenses/OpenDesign-APACHE-2.0.txt)。界面使用的字体（Geist、Geist Mono、Instrument Serif、Noto Serif SC）均为 SIL OFL 1.1 许可，许可证文本在 [licenses/](licenses/) 目录。
