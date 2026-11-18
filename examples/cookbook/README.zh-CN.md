# 示例集（Cookbook）

[English](README.md) · 简体中文

这里收录了按实际开发场景分类的、可直接复制运行的智能体调用脚本。每个脚本都是单文件：文件开头几行写明了用途、前置条件与运行命令，涵盖 `curl` 以及官方 `openai`、`anthropic`、`google-genai` SDK 的 Python 与 Node.js 写法。所有脚本均通过环境变量读取配置，不含任何硬编码密钥。

> 提示：除了直接运行本目录的脚本，你也可以打开控制台左侧的 **「对话工作台」**（`#workbench`），选好智能体、图片或外层工具后点击右上角 **「复制代码」**，一键导出与当前会话完全一致的四协议调用代码。

本目录中的每一个可执行脚本都会在 CI 的[兼容性实验室](../../docs/zh-CN/compatibility.md#兼容性实验室)（`npm run compat`）中针对隔离网关自动跑通并校验退出码与输出内容（测试编排见 [`integrations/compat/cookbook.mjs`](../../integrations/compat/cookbook.mjs)）。

---

## 运行准备

所有示例共用以下三个环境变量：

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OAA_BASE_URL` | 网关根地址（不带 `/v1` 路径） | `http://127.0.0.1:8787` |
| `OAA_API_KEY` | 在控制台或命令行创建的调用方密钥（`sk-oaa-…`） | 必填 |
| `OAA_AGENT` | 目标智能体的调用名（与 `GET /v1/models` 返回的 `id` 一致） | `agent/sample` |

可选变量 `OAA_PROMPT`（长任务脚本另支持 `OAA_LONG_PROMPT`）用于自定义发送给智能体的任务描述。

### 1. 先用离线示例智能体零配置跑通

不需要准备任何模型密钥，两条命令即可在本地跑通第一批示例：

```bash
oaa quickstart                                        # 启动本机网关并发布离线智能体 agent/sample
export OAA_API_KEY="$(cat .oaa/keys/quickstart.key)"  # 读取调用方密钥（具备调用、读取、文件与审批权限）
```

> 第 3 组中的「注册事件回调 Webhook」属于网关管理操作，需要额外导出管理员令牌：`export OAA_ADMIN_KEY="$(cat .oaa/admin.token)"`。

### 2. 切换为你发布的真实智能体

当你通过控制台或 `oaa connect codex` / `oaa connect ollama` 发布了真实智能体后，只需改一行 `OAA_AGENT`，同一批脚本就能直接驱动真实智能体执行任务：

```bash
export OAA_AGENT="agent/codex"  # 或 agent/antigravity、agent/assistant 等
```

### 3. 安装对应语言的官方 SDK

只安装你要运行的那门语言即可（`curl` 脚本无需额外依赖）：

```bash
pip install openai anthropic google-genai
npm install openai @anthropic-ai/sdk @google/genai
```

注意：自己新建测试脚本时，请避免将文件命名为 `openai.py` 或 `anthropic.py`，否则会与同名官方包产生导入冲突。

---

## 场景示例速查表

| 我想实现的场景（点击进入目录） | cURL | Python | Node.js |
| --- | --- | --- | --- |
| [01 · 完成第一次同步与流式调用（三家协议对照）](01-first-call/) | [`hello.sh`](01-first-call/hello.sh) | [OpenAI](01-first-call/hello_openai.py)、[Anthropic](01-first-call/hello_anthropic.py)、[Gemini](01-first-call/hello_genai.py) | [OpenAI](01-first-call/hello_openai.mjs)、[Anthropic](01-first-call/hello_anthropic.mjs)、[Gemini](01-first-call/hello_genai.mjs) |
| [02 · 后台提交长任务、轮询状态、取消，并用 `previous_response_id` 多轮续接](02-long-running/) | [`long_task.sh`](02-long-running/long_task.sh) | [`long_task_openai.py`](02-long-running/long_task_openai.py) | [`long_task_openai.mjs`](02-long-running/long_task_openai.mjs) |
| [03 · 检测任务停在「待审批」，并通过 API 批准或拒绝](03-approvals/) | [`approve.sh`](03-approvals/approve.sh) | [`approve_openai.py`](03-approvals/approve_openai.py) | [`approve_openai.mjs`](03-approvals/approve_openai.mjs) |
| [03 · 通过签名 Webhook 接收待审批通知并自动完成审批闭环](03-approvals/) | — | — | [`webhook_approve.mjs`](03-approvals/webhook_approve.mjs)（独立常驻接收端见 [`examples/webhook-receiver.mjs`](../webhook-receiver.mjs)） |
| [04 · 让智能体回调你业务代码里的本地函数（外层工具桥接循环）](04-caller-tools/) | — | [OpenAI](04-caller-tools/tools_openai.py)、[Anthropic](04-caller-tools/tools_anthropic.py)、[Gemini](04-caller-tools/tools_genai.py) | [OpenAI](04-caller-tools/tools_openai.mjs)、[Anthropic](04-caller-tools/tools_anthropic.mjs)、[Gemini](04-caller-tools/tools_genai.mjs) |
| [05 · 获取严格符合 JSON Schema 的结构化输出及异常兜底处理](05-structured-output/) | [`structured.sh`](05-structured-output/structured.sh) | [OpenAI](05-structured-output/structured_openai.py)、[Anthropic](05-structured-output/structured_anthropic.py)、[Gemini](05-structured-output/structured_genai.py) | [OpenAI](05-structured-output/structured_openai.mjs) |
| [06 · 向智能体发送本地图片或截图进行多模态分析](06-images/) | [`image.sh`](06-images/image.sh) | [OpenAI](06-images/image_openai.py)、[Anthropic](06-images/image_anthropic.py)、[Gemini](06-images/image_genai.py) | [OpenAI](06-images/image_openai.mjs)、[Anthropic](06-images/image_anthropic.mjs)、[Gemini](06-images/image_genai.mjs) |
| [07 · 区分可重试与不可重试错误，利用 `Idempotency-Key` 安全重试](07-errors-and-retries/) | [`errors.sh`](07-errors-and-retries/errors.sh) | [`retries_openai.py`](07-errors-and-retries/retries_openai.py) | [`retries_openai.mjs`](07-errors-and-retries/retries_openai.mjs) |
| [08 · 仅凭环境变量将现有 SDK 工具链指向网关](08-connect-tools/) | — | [`env_check.py`](08-connect-tools/env_check.py) | [`env_check.mjs`](08-connect-tools/env_check.mjs) |

在 `examples/cookbook` 目录下直接运行任意脚本即可：

```bash
python 01-first-call/hello_openai.py
node 04-caller-tools/tools_anthropic.mjs
sh 05-structured-output/structured.sh
```

---

## 离线 `agent/sample` 与真实智能体的能力对照

`quickstart` 默认发布的 `agent/sample`（源码位于 [`examples/sample-agent.mjs`](../sample-agent.mjs)）是一个不联网、不调大模型的规则型进程，适合零成本验证链路，但部分高级协议特性需要真实模型或完整智能体才能完整走通：

| 示例分组 | 使用离线 `agent/sample` 时的表现 | 完整体验所需的目标智能体 |
| --- | --- | --- |
| **01 首次调用** | 直接跑通，返回固定规则文本 | 任意智能体 |
| **02 长任务与续接** | 后台提交与轮询正常；因该示例进程未实现会话恢复，取消会记为 `incomplete`（`effect_outcome_unknown`），`previous_response_id` 会返回 `native_resume_unsupported` | 内置内核智能体，或支持会话恢复的 Codex / ACP 智能体 |
| **03 人工与自动审批** | 直接跑通：输入含 `approve` 时会发起写文件审批，批准即完成，拒绝则返回 `permission_denied` | 配置了审批拦截的智能体 |
| **04 外层工具桥接** | 示例进程不会主动发起外层函数调用（脚本以退出码 `3` 提示说明） | 内置内核智能体，或 Codex / Claude Code / Antigravity / ACP 智能体（详见 [双层 Harness](../../docs/zh-CN/harness.md)） |
| **05 结构化 JSON 输出** | 演示校验未通过分支（返回 `structured_output_invalid`，退出码 `3`） | 内置内核智能体，或支持多轮修正的真实智能体（详见 [结构化输出](../../docs/zh-CN/structured-output.md)） |
| **06 图片输入** | 可正常接收图片载荷，固定文本不会描述画面内容 | 具备视觉能力的智能体（见 `GET /v1/models` 中的 `image_input` 标记） |
| **07 错误与幂等重试** | 直接跑通 | 任意智能体 |
| **08 工具链环境接入** | 直接跑通 | 任意智能体 |

各脚本统一的退出码约定：`0` 表示成功跑完目标流程；`2` 表示请求参数或目标智能体能力不匹配（例如向纯文本智能体传图）；`3` 表示脚本正常执行完毕，但当前离线智能体未触发该高级动作（如未发起外层 `tool_calls`）。

---

## 接入常用 IDE、聊天桌面端与自动化平台

- **本机客户端一键配置（推荐）**：对于本机已安装的 **Cursor**、**Windsurf**、**Claude Desktop**、**Claude Code**、**OpenCode**、**Codex CLI** 与 **DSH**，无需手工改配置文件，直接在控制台左侧打开 **[本地互联](../../docs/zh-CN/local-connections.md)** 页面即可一键注入 API 提供方或 MCP 桥。
- **通用三要素配置**：其他兼容 OpenAI / Claude / Gemini 接口的应用只需填入 **Base URL**、**API Key** 与 **智能体调用名**（完整兼容细节见 [客户端兼容性指南](../../docs/zh-CN/compatibility.md#聊天客户端)）：

| 客户端 / 平台 | 配置入口 | Base URL 填法 | 模型名字段填法 | 现成配置模板 |
| --- | --- | --- | --- | --- |
| **Open WebUI** | Admin Settings → Connections → OpenAI | `http://<host>:8787/v1` | 自动拉取 `/models`，或填入 Model IDs | — |
| **LibreChat** | `librechat.yaml` → `endpoints.custom[]` | `http://<host>:8787/v1` | `models.default` 或开启 `models.fetch: true` | [`librechat.yaml`](08-connect-tools/librechat.yaml) |
| **Chatbox** | Provider → API Host | `http://<host>:8787/v1` | 拉取模型列表或手动填入智能体名 | — |
| **Cherry Studio** | Model Provider → Add → OpenAI → API Host | `http://<host>:8787` 或带 `/v1` | 拉取列表或手动添加 | — |
| **LobeChat** | AI Service Provider → OpenAI → API Proxy URL | `http://<host>:8787/v1` | 拉取模型列表或手动添加 | — |
| **NextChat** | Settings → Custom Endpoint → OpenAI Endpoint | `http://<host>:8787`（不带 `/v1`） | Settings → Custom Models | — |
| **Dify** | Model Provider → OpenAI-API-compatible | Docker 部署填 `http://host.docker.internal:8787/v1` | Model Name 填智能体调用名 | — |
| **n8n** | Credentials → OpenAI | `http://<host>:8787/v1` | 从列表选择或按 ID 填写 | — |
| **Continue** | `config.yaml` → `models[]` | `http://<host>:8787/v1` | `model: agent/sample`（或真实智能体名） | [`continue.config.yaml`](08-connect-tools/continue.config.yaml) |
| **Cline / Roo Code** | API Provider 选 `OpenAI Compatible` | `http://<host>:8787/v1` | 智能体调用名 | — |
| **Zed** | `settings.json` → `language_models.openai_compatible` | `http://<host>:8787/v1` | `available_models[].name` | [`zed.settings.json`](08-connect-tools/zed.settings.json) |

**常见配置小贴士**：
1. **注意 `/v1` 后缀差异**：OpenAI 生态 SDK 与绝大多数第三方客户端的 Base URL 以 `/v1` 结尾；Anthropic 与 Gemini 官方 SDK 的 Base URL **不带** `/v1`：

   ```bash
   export OPENAI_BASE_URL="$OAA_BASE_URL/v1"   OPENAI_API_KEY="$OAA_API_KEY"
   export ANTHROPIC_BASE_URL="$OAA_BASE_URL"   ANTHROPIC_API_KEY="$OAA_API_KEY"
   ```

2. **容器与跨域访问**：当 Dify、Open WebUI 等客户端运行在 Docker 容器内时，通过 `host.docker.internal` 访问宿主机网关需将该主机名加入网关配置的 `allowedHosts`；纯浏览器前端直连时需将页面源加入 `allowedOrigins`。
3. **自带 `tools` 的客户端**：Cline、Continue Agent 模式、Zed 等客户端会在请求里附带自身工具定义。支持工具桥接的智能体（内核智能体、Codex、Claude Code、Antigravity、ACP）会自动接管并回传 `tool_calls`；若目标适配器不支持外层工具，可改用兼容入口 `http://<host>:8787/v1/compat` 让网关忽略外层工具定义。
