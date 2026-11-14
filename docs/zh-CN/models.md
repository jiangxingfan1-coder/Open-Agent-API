# 模型提供方与 `oaa connect <预设>`

[English](../models.md) · 简体中文

内置智能体（网关自己的智能体循环，`engine = kernel`）是能力最全的一类：调用方工具桥接、结构化输出修复轮、
图片输入都以它为准。它需要一个模型提供方。一条命令就能配好并发布一个可用的智能体：

```bash
oaa connect ollama                                   # 本地模型，不需要密钥
oaa connect deepseek --key-file ~/.config/deepseek.key
oaa connect openai --key-env OPENAI_API_KEY --model <模型名>
```

完成后你会得到 `agent/assistant`——一个带工作区文件工具（`list_files`、`read_file`、`write_file`）的通用助手，
以及一条可以直接粘贴运行的 `curl`。不带目标运行 `oaa connect`，会列出本机检测到的外部智能体和全部模型预设。

## `oaa connect <预设>` 做了什么

1. **模型。** 本地服务（回环地址）：向它请求模型列表（`GET <baseUrl>/models`，只发往 127.0.0.1），只有一个模型就用它，
   否则用 `--model` 指定的那个。没有响应时用中英双语说明：服务没在运行或端口不同，以及怎样用 `--base-url` 指定。
   云端服务：模型取自 `--model`（或预设里唯一的建议值），不会向它发任何请求。
2. **提供方。** 把 `localWorker.providers.<名字>` 写进 `.oaa/config.json`（名字为预设名，或 `--name`）。
   已有完全相同的条目则跳过；同名但设置不同则拒绝（`provider_conflict`），绝不覆盖。配置里只存密钥的**引用**。
3. **网关。** 提供方在网关启动时读取，所以新增提供方需要重启网关。网关是从这个数据目录启动的
   （`oaa quickstart`、`oaa serve --detach`）就由 connect 重启；没有网关在运行就启动一个；端口被别的程序占用
   （例如桌面应用）则不去动它，提示你自己重启。
4. **智能体。** 发布 `examples/assistant.oaa`，把线路指向这个提供方和模型（`--agent` 改名字，`--definition FILE.oaa`
   发布你自己的文件，其中的 `default/"configure-your-model"` 线路同样会被改写）。同名智能体已是别的引擎或提供方则拒绝
   （`agent_conflict`）。
5. **密钥与调用。** 确认 quickstart 的调用方密钥能调用它（否则单独建一把只能调用它的密钥），打印 model 名、Base URL
   和一条 `curl`。

重复运行不会改变任何东西，并沿用同一把密钥。**它从不调用模型**——云端调用会花钱。加 `--test` 会经网关发一次最小请求，
且只在端点是回环地址时才发。

## 密钥

密钥绝不通过命令行参数或交互输入传递（会进 shell 历史）：

- `--key-env 变量名`：配置里只存环境变量的**名字**。网关进程启动时读取它，所以必须在启动网关的那个环境里设置。
  connect 或 `oaa serve` 从你这个终端启动的网关会继承终端的变量；桌面应用、服务管理器或别人启动的网关不会。
  变量改了要重启网关。
- `--key-file 文件`：配置里存文件的绝对路径（`apiKeyFile`）。connect 会检查它是普通文件（不接受目录、链接或设备）、
  不超过 8 KiB、只有一行，且在 macOS 与 Linux 上只有你能读（`chmod 600`）。网关每次调用时读取，换密钥不需要重启。
  文件内容从不打印、不写日志、不复制进配置；错误信息里只出现路径。
- 本地预设（`ollama`、`lmstudio`）不需要密钥（`noApiKey: true`，不发认证头）。

## 预设表

下面每一条的端点与差异都对照了该服务的官方文档（2026 年 11 月）。地址写死在代码里，不从网络获取。模型名经常变，
预设最多保留一个建议值，`--model` 永远优先。

| 预设 | 服务 | 协议 | Base URL | 密钥变量 | 预设里写好的已知差异 | 建议模型 |
| --- | --- | --- | --- | --- | --- | --- |
| `ollama` | Ollama（本地） | openai-chat | `http://127.0.0.1:11434/v1` | 不需要 | `max_tokens`；图片内联（base64） | 取本地列表 |
| `lmstudio` | LM Studio（本地） | openai-chat | `http://127.0.0.1:1234/v1` | 不需要 | `max_tokens`；不传图片 | 取本地列表 |
| `openai-compatible` | 任意 OpenAI 兼容地址 | openai-chat | `--base-url` | `--key-env`/`--key-file`，否则无密钥 | `max_tokens`；不要流式用量；不传图片 | `--model` |
| `openai` | OpenAI | openai-responses | `https://api.openai.com/v1` | `OPENAI_API_KEY` | 无 | `--model` |
| `anthropic` | Anthropic | anthropic-messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | `anthropic-version: 2023-06-01` | `claude-sonnet-5-5` |
| `gemini-api` | Google Gemini API | gemini-generate | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` | `x-goog-api-key` 请求头 | `--model` |
| `openrouter` | OpenRouter | openai-chat | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `max_tokens` | `--model` |
| `deepseek` | DeepSeek | openai-chat | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `max_tokens` | `deepseek-flash` |
| `moonshot` | Moonshot（Kimi） | openai-chat | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | `max_tokens`；不要流式用量；不传图片 | `--model` |
| `zhipu` | 智谱（BigModel） | openai-chat | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | `max_tokens`；不要流式用量；不传图片 | `glm-5.3` |
| `siliconflow` | 硅基流动 | openai-chat | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | `max_tokens`；不要流式用量；不传图片 | `--model` |
| `groq` | Groq | openai-chat | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `max_completion_tokens`（它那里 `max_tokens` 已弃用）；不要流式用量 | `--model` |
| `together` | Together AI | openai-chat | `https://api.together.ai/v1` | `TOGETHER_API_KEY` | `max_tokens`；不要流式用量 | `--model` |
| `mistral` | Mistral AI | openai-chat | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `max_tokens`；不要流式用量；不传图片 | `--model` |

「不要流式用量」指文档没有承诺 `stream_options.include_usage`，预设就不发它（`streamUsage: false`）；运行照常，
只是不报告 token 数。「不传图片」指文档没有以网关可以依赖的方式描述这个端点的图片输入，预设关掉图片
（`imageInput: "none"`）；用视觉模型时自己设 `imageInput`。

预设名不会与外部智能体重名：`gemini` 仍是 Gemini CLI（ACP），`kimi`、`qwen`、`glm` 仍是这些工具的 ACP 预设，
所以这里用 `gemini-api`、`moonshot`、`zhipu`。

**未收录：** 阿里云百炼（通义千问）。它现行文档给出的端点带有你自己的业务空间 ID
（`https://{WorkspaceId}.<地域>.maas.aliyuncs.com/compatible-mode/v1`），没有固定地址可写进预设；而且文档说明
工具调用暂时不能与 `stream=true` 同时使用，内置智能体总是流式调用。如果你的模型支持流式工具调用，可以用
`openai-compatible --base-url …` 填你的业务空间地址。

## 提供方配置项

`localWorker.providers.<名字>`（以及执行节点的 `providers`）接受：

| 字段 | 含义 |
| --- | --- |
| `kind` | `openai-chat`、`openai-responses`、`anthropic-messages`、`gemini-generate` |
| `baseUrl` | 端点；非回环地址必须是 https |
| `apiKeyEnv` | 存放密钥的环境变量（缺省 `OPENAI_API_KEY`） |
| `apiKeyFile` | 新增。存放密钥的文件；每次调用时读取；优先于 `apiKeyEnv` |
| `noApiKey` | 新增。`true`：端点不需要密钥，不发认证头 |
| `maxTokensField` | `max_completion_tokens`（缺省）或 `max_tokens` |
| `streamUsage` | 新增。`false`：不发 `stream_options.include_usage` |
| `imageInput` | `none`、`inline` 或 `url`（见 [images.md](images.md)） |
| `preset` | 新增。条目来自哪个预设（仅作说明） |
| `byok`、`timeoutMs`、`anthropicVersion` | 不变 |

## `oaa models`

```bash
oaa models [--dir .oaa] [--check] [--json]
```

列出已配置的提供方：协议、端点、密钥从哪里来以及能否解析（有网关在运行时按网关进程的视角，否则按当前终端）、
端点是否响应、有哪些模型、哪些智能体在用它。回环地址自动探测；云端端点只在加 `--check` 时才联系，而且只请求
模型列表接口（不生成内容，不产生 token 费用）。

## 运行失败时

错误信息会点名提供方、它的端点以及该改什么：

| 错误码 | 原因 | 怎么改 |
| --- | --- | --- |
| `model_not_configured` | 网关进程里密钥引用解析不了 | 设置变量后重启，或修好密钥文件 |
| `upstream_auth_failed` | HTTP 401/403 | 密钥不对、地域不对或缺权限 |
| `upstream_model_not_found` | HTTP 404 或「模型不存在」 | 改正模型名（`oaa models --check`）或 `baseUrl` |
| `upstream_incompatible` | HTTP 400/422 且点名某个字段 | 信息里会写明要改的配置：`maxTokensField`、`streamUsage`、`imageInput`，或换支持工具的模型 |
| `upstream_rate_limited` | HTTP 429 | 稍后重试或检查额度 |

上游的响应内容只用来判断失败类型，从不复制进调用方看到的错误信息。

## 控制台

**发布智能体 → OAA-Lang 2.0** 里有「模型提供方」下拉框，列出已配置的提供方；选中后会改写源码里每条 `route` 的提供方。
内置智能体的卡片会显示它用的提供方；网关进程读不到密钥时以需要处理的颜色标出。

## 安全

- `--base-url` 只接受 http 与 https，不能带用户名密码、查询串或 #；非回环地址必须 https。不提供放宽开关：
  网关的模型驱动本来就拒绝明文 http 的远程端点。
- 预设里的地址是代码的一部分，不从网络下载。
- `security.profile: public` 时行为不变：提供方仍是管理员配置。

这些预设对照官方文档核实，只在假服务上实际跑过。真实服务可能变化；某个服务失效时，`oaa models --check`
和上面的错误码会告诉你该改哪一项。
