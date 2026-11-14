# 示例集（Cookbook）

[English](README.md) · 简体中文

按「我想做什么」组织的、可以直接复制运行的调用示例。每个示例是一个文件，开头几行写明它演示什么、需要什么、怎么运行。语言：curl，以及官方 `openai`、`anthropic`、`google-genai` SDK 的 Python 与 Node 写法。所有示例都不含密钥，只读环境变量。

每个可运行的示例都会被[兼容性实验室](../../docs/zh-CN/compatibility.md#兼容性实验室)（`npm run compat`）在隔离的网关上自动跑一遍，并断言退出码与关键输出：改动弄坏了某个示例，构建就会失败。文件与跑它们的场景见 [`integrations/compat/cookbook.mjs`](../../integrations/compat/cookbook.mjs)。

## 开始之前

所有示例用同样的三个环境变量：

| 变量 | 含义 | 缺省值 |
|---|---|---|
| `OAA_BASE_URL` | 网关地址，不带路径 | `http://127.0.0.1:8787` |
| `OAA_API_KEY` | 调用方密钥（`sk-oaa-…`） | 无，必填 |
| `OAA_AGENT` | 智能体名，与 `GET /v1/models` 列出的完全一致 | `agent/sample` |

`OAA_PROMPT`（长任务示例还有 `OAA_LONG_PROMPT`）可以选填，用来替换任务文字。

```bash
oaa quickstart                                        # 启动本机网关并发布 agent/sample
export OAA_API_KEY="$(cat .oaa/keys/quickstart.key)"  # 调用方密钥：可调用、读取、上传文件、审批
```

`oaa quickstart` 写下的密钥能调用所有智能体，也能处理审批。事件回调（第 3 组）只有管理员密钥才能配置：`export OAA_ADMIN_KEY="$(cat .oaa/admin.token)"`。

装上用到的 SDK 即可（别的都不需要；curl 示例只要有 `curl`）：

```bash
pip install openai anthropic google-genai
npm install openai @anthropic-ai/sdk @google/genai
```

自己的脚本不要叫 `openai.py` 或 `anthropic.py`：Python 文件与它要导入的包同名，会把那个包遮住。示例因此都叫 `hello_openai.py`、`tools_genai.py` 这样的名字。

## 示例清单

| 我想…（点开进入目录） | curl | Python | Node |
|---|---|---|---|
| [完成第一次调用，阻塞与流式，三种协议都有](01-first-call/) | [`hello.sh`](01-first-call/hello.sh) | [OpenAI](01-first-call/hello_openai.py)、[Anthropic](01-first-call/hello_anthropic.py)、[Gemini](01-first-call/hello_genai.py) | [OpenAI](01-first-call/hello_openai.mjs)、[Anthropic](01-first-call/hello_anthropic.mjs)、[Gemini](01-first-call/hello_genai.mjs) |
| [把长任务放到后台、轮询、取消，并用 `previous_response_id` 接着聊](02-long-running/) | [`long_task.sh`](02-long-running/long_task.sh) | [`long_task_openai.py`](02-long-running/long_task_openai.py) | [`long_task_openai.mjs`](02-long-running/long_task_openai.mjs) |
| [发现任务停在待审批，并用 API 批准或拒绝](03-approvals/) | [`approve.sh`](03-approvals/approve.sh) | [`approve_openai.py`](03-approvals/approve_openai.py) | [`approve_openai.mjs`](03-approvals/approve_openai.mjs) |
| [由事件回调告诉我任务需要审批，并在回调里批准](03-approvals/) | | | [`webhook_approve.mjs`](03-approvals/webhook_approve.mjs)（常驻进程可用 [`examples/webhook-receiver.mjs`](../webhook-receiver.mjs)） |
| [让智能体调用我程序里的函数（工具循环）](04-caller-tools/) | | [OpenAI](04-caller-tools/tools_openai.py)、[Anthropic](04-caller-tools/tools_anthropic.py)、[Gemini](04-caller-tools/tools_genai.py) | [OpenAI](04-caller-tools/tools_openai.mjs)、[Anthropic](04-caller-tools/tools_anthropic.mjs)、[Gemini](04-caller-tools/tools_genai.mjs) |
| [拿到合乎 JSON Schema 的 JSON，并处理「做不到」的情况](05-structured-output/) | [`structured.sh`](05-structured-output/structured.sh) | [OpenAI](05-structured-output/structured_openai.py)、[Anthropic](05-structured-output/structured_anthropic.py)、[Gemini](05-structured-output/structured_genai.py) | [OpenAI](05-structured-output/structured_openai.mjs) |
| [把一张本地图片发给智能体](06-images/) | [`image.sh`](06-images/image.sh) | [OpenAI](06-images/image_openai.py)、[Anthropic](06-images/image_anthropic.py)、[Gemini](06-images/image_genai.py) | [OpenAI](06-images/image_openai.mjs)、[Anthropic](06-images/image_anthropic.mjs)、[Gemini](06-images/image_genai.mjs) |
| [分清可重试与不可重试的错误，重试时不重复起一个运行](07-errors-and-retries/) | [`errors.sh`](07-errors-and-retries/errors.sh) | [`retries_openai.py`](07-errors-and-retries/retries_openai.py) | [`retries_openai.mjs`](07-errors-and-retries/retries_openai.mjs) |
| [把网关接进我常用的工具](08-connect-tools/) | | [`env_check.py`](08-connect-tools/env_check.py) | [`env_check.mjs`](08-connect-tools/env_check.mjs) |

按文件开头写的方式运行即可，例如：

```bash
python 01-first-call/hello_openai.py
node 04-caller-tools/tools_anthropic.mjs
sh 05-structured-output/structured.sh
```

## 离线示例智能体能演示什么、不能演示什么

`agent/sample`（[`examples/sample-agent.mjs`](../sample-agent.mjs)）不调用任何模型：它是一个 ACP 进程，用固定规则回答、做一次假的工具调用，任务里带有「approve」时请求一次审批。没有模型密钥时用它试这些示例最合适，但它只能演示其中一部分；带模型密钥的内置（kernel）智能体或真实的外部智能体能演示全部。

| 示例 | 用 `agent/sample` | 需要什么智能体 |
|---|---|---|
| 1 第一次调用 | 可以；回答是固定文字 | 任意 |
| 2 长任务 | 后台运行与轮询可以。取消后运行以 `incomplete`、原因 `effect_outcome_unknown` 结束（外部智能体在某一步中间被停下，网关无法知道它做了什么）；用 `previous_response_id` 接着聊会被拒绝（`native_resume_unsupported`），因为它的 ACP 进程既没有声明 `session/load` 也没有声明 `session/resume` | 想看到干净的 `cancelled` 与会话续接，用内置智能体 |
| 3 审批 | 可以：任务文字里有「approve」，它就请求写文件。批准后运行完成，拒绝后运行以 `permission_denied` 失败 | 会请求审批的智能体 |
| 4 调用方工具 | 演示不了：它接受你的工具，但从不调用（示例以退出码 3 结束并说明） | 内置智能体，或支持 MCP 的 ACP 智能体（[harness.md](../../docs/zh-CN/harness.md)） |
| 5 结构化输出 | 走到失败那一支：它不能被再问一次，调用以 `structured_output_invalid` 失败（示例以退出码 3 结束） | 内置智能体，或会话可以接续的外部智能体（[structured-output.md](../../docs/zh-CN/structured-output.md)） |
| 6 图片 | 图片会被接收，固定回答不会描述它 | 接受图片的智能体（`GET /v1/models` 里的 `image_input`） |
| 7 错误与重试 | 可以 | 任意 |
| 8 接入工具 | 可以 | 任意 |

所有示例约定的退出码：`0` = 完成；`2` = 请求被拒绝，或这个智能体不适用（例如不接受图片）；`3` = 示例跑完了，但智能体没有做到示例要演示的事（没有调用工具，或 `structured_output_invalid`）。

## 接入常用工具

聊天客户端、编辑器和自动化工具只需要 Base URL、密钥和智能体名。下表是 [docs/zh-CN/compatibility.md](../../docs/zh-CN/compatibility.md#聊天客户端) 的简写，那里还写明了每个客户端是怎样核对的、有什么脾气。把 `<host>` 换成网关地址；密钥用调用方密钥；model 填智能体名，与 `GET /v1/models` 列出的完全一致。

| 工具 | 在哪里配 | Base URL | 模型 | 依据 | 现成文件 |
|---|---|---|---|---|---|
| Open WebUI | Admin Settings > Connections > OpenAI | `http://<host>:8787/v1` | 从 `/models` 列出，或填进 Model IDs (Filter) | 按客户端源码回放 | |
| LibreChat | `librechat.yaml` 的 `endpoints.custom[]` | `http://<host>:8787/v1` | `models.default`，或 `models.fetch: true` | 部分为推断 | [`librechat.yaml`](08-connect-tools/librechat.yaml) |
| Chatbox | Provider > API Host | `http://<host>:8787/v1` | 手动添加，或拉取模型列表 | 按客户端源码回放 | |
| Cherry Studio | Model Provider > Add > OpenAI > API Host | `http://<host>:8787` 或 `.../v1` | 手动添加，或拉取 | 按客户端源码回放 | |
| LobeChat | AI Service Provider > OpenAI > API Proxy URL | `http://<host>:8787/v1` | 拉取模型列表，或手动添加 | 部分为推断 | |
| NextChat | Settings > Custom Endpoint > OpenAI Endpoint | `http://<host>:8787`，不带 `/v1` | Settings > Custom Models | 按客户端源码回放 | |
| Dify | Model Provider > OpenAI-API-compatible > Add Model | Dify 在 Docker 里时用 `http://host.docker.internal:8787/v1` | Model Name 填智能体名 | 按客户端源码回放 | |
| n8n | Credentials > OpenAI | `http://<host>:8787/v1` | By ID 或 From List | 按客户端源码回放 | |
| Continue | `config.yaml` 的 `models[]` | `http://<host>:8787/v1` | `model: agent/sample` | 按客户端源码回放 | [`continue.config.yaml`](08-connect-tools/continue.config.yaml) |
| Cline / Roo Code | API Provider 选「OpenAI Compatible」 | `http://<host>:8787/v1` | 智能体名 | 按客户端源码回放 | |
| Zed | `settings.json` 的 `language_models.openai_compatible.<name>` | `http://<host>:8787/v1` | `available_models[].name` | 按客户端源码回放 | [`zed.settings.json`](08-connect-tools/zed.settings.json) |
| Cursor | Settings > Models > Override OpenAI Base URL | 公网 HTTPS 地址，多半带 `/v1` | 自定义模型名 | **未验证** | |

几条适用于多个工具的提醒（都出自兼容性文档）：Base URL 少了 `/v1` 是 404 最常见的原因；跑在 Docker 里的客户端用 `host.docker.internal` 访问网关，这个名字要加进网关的 `allowedHosts`；网页版客户端需要把它的来源加进 `allowedOrigins`；会发 `tools` 的客户端（Cline、Roo Code、Continue 的 Agent 模式、Zed）对能接管工具的智能体可以直接用，对不能接管的（Codex、Claude Code 这类原生引擎）会得到一个写明出路的 400：改用 Base URL `http://<host>:8787/v1/compat`。

凡是建立在官方 SDK 上的东西，只靠环境变量就能指向网关。[`env_check.py`](08-connect-tools/env_check.py) 与 [`env_check.mjs`](08-connect-tools/env_check.mjs) 对 OpenAI 与 Anthropic 两家 SDK 验证了这一点：

```bash
export OPENAI_BASE_URL="$OAA_BASE_URL/v1"   OPENAI_API_KEY="$OAA_API_KEY"      # OpenAI 系 SDK：Base URL 以 /v1 结尾
export ANTHROPIC_BASE_URL="$OAA_BASE_URL"   ANTHROPIC_API_KEY="$OAA_API_KEY"   # Anthropic 系 SDK：不带 /v1
```

## 这些示例怎样被验证

`npm run compat` 在 `127.0.0.1` 的随机端口、临时数据目录里启动一个隔离网关（一把生成的密钥），带离线示例智能体和确定性的夹具模型智能体；把本目录复制到临时目录，从那里像你一样逐个运行示例，并断言退出码与输出里的关键行。实验室里有三个客户端做这件事：`cookbook-curl`、`cookbook-python`、`cookbook-node`。夹具模型靠提示词里的一个词决定怎么答（实验室为此设置 `OAA_PROMPT`，你用不到），例如 `CALLTOOL` 让它调用你的工具，`ALWAYSBAD` 让它对结构化输出请求只回散文。

实验室**不**运行的东西，以及原因：

| 文件 | 原因 |
|---|---|
| [`08-connect-tools/continue.config.yaml`](08-connect-tools/continue.config.yaml)、[`zed.settings.json`](08-connect-tools/zed.settings.json)、[`librechat.yaml`](08-connect-tools/librechat.yaml) | 第三方应用的配置，不是程序。实验室里没有这些应用；离线测试会解析每个文件，并对照兼容性文档与实验室回放的客户端请求记录核对其中的键 |
| 真实模型 | 没有任何示例调用真实模型：每个示例都只对着示例智能体或夹具模型运行。真实模型的表现（例如它多常需要结构化输出的修复轮）这里看不到 |
