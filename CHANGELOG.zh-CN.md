# 变更记录

[English](CHANGELOG.md) · 简体中文

## 未发布

## 0.0.65（2026-11-14）

这一版让网关能装在更多地方，也拿更多的客户端检验了它，并让一次请求可以带上文字以外的东西。它可以装在 Linux（自带 Node.js 的 tar.gz 与 `install.sh`）、Docker 里和用 npm tarball 安装，支持 Node 24 与 26，完整测试在 CI 的 Windows 上通过。一个兼容性实验室让官方 Python 与 Node SDK 和几个框架实际对着网关运行，并回放十几个聊天客户端的请求；实验室发现不兼容的地方，网关都做了修改。调用方可以发图片，也可以要求保证符合某个 schema 的 JSON；运行事件可以推送到你自己的端点；审批可以在命令行里处理。一次安全审查带来了一批修复。一条命令（`oaa connect <预设>`）现在能让内置智能体接上本地或托管的模型提供方；一次长时间压测找出并修复了内存与数据库的增长，并且有了清理旧数据的办法。有几处默认值是有意改变的，列在「行为变化」里，有办法恢复旧行为的会写明怎么恢复。没有验证过的部分列在「尚未验证」里。

下面出现的文件名、命令与配置项都是仓库里的；提到的文档在 `docs/` 下。

### 行为变化

- **调用方带工具时的缺省模式是 `auto`。** 请求带了 `tools` 又没有选模式时，以前在兼容入口、Claude Messages 与 Gemini 上按 `managed` 处理（智能体用自己的工具完成，响应里写 `X-OAA-Client-Tools: ignored`），在 OpenAI 的默认端点（`/v1/chat/completions`、`/v1/responses`）上则以 400 `unsupported_parameter` 拒绝。现在缺省是 `auto`：智能体能接管这些工具时（内置内核智能体，或执行机器为它声明了 `client-tools-v1` 的 ACP 智能体）就桥接：智能体的调用以 `tool_calls`（或该协议的对应形式）交回，调用方执行后，同一个任务继续；响应带 `X-OAA-Client-Tools: bridge`。其他所有智能体（Codex、Claude Code、Antigravity、A2A、HTTP 适配器）在每个入口上的行为与以前完全一样。要让所有智能体回到旧的处理方式，请求里发 `X-OAA-Client-Tools: managed`，或把 `clientTools.default` 设为 `managed`。仍有一处差别：缺省设为 `managed` 后，OpenAI 的默认端点会忽略工具而不是拒绝，以前只有 `/v1/compat` 是这样。强制的 `tool_choice` 永远不桥接。
- **要求的 JSON 格式现在会被强制保证。** `response_format`（`json_object`、`json_schema`）、Responses 的 `text.format`、Gemini 的 `responseMimeType` 加 `responseSchema`、Claude 的 `output_config.format`，以前在 OpenAI 默认端点上被拒绝，或作为一个从未被检查的愿望交给智能体。现在成功的响应一定是能解析且符合 schema 的 JSON；答错了，会发回给智能体修正，最多 `structuredOutput.maxRepairs` 次（0 到 3，缺省 1），仍然不对则运行以 `structured_output_invalid`（422）失败。流式响应会先扣住，等答案检查通过后一次发出。旧的透传没有开关可以恢复：不要再发这个格式，或把 `structuredOutput.maxRepairs` 设为 `0` 让它在第一次答错时就失败。
- **只影响采样的参数在 OpenAI 默认端点上不再报错。** `top_k`、`min_p`、`repeat_penalty`、`logit_bias`、任意长度的 `stop` 列表以及类似的厂商参数会被接受并忽略，被忽略的名字列在响应头 `X-OAA-Ignored-Params` 里。会改变网关该做什么的参数（强制的 `tool_choice`、`logprobs: true`、大于 1 的 `n`、未知字段）仍然被拒绝。
- **Responses 与 Gemini 的流式响应现在带有运行过程。** 在 `/v1/responses` 或 Gemini 入口上做流式调用，以前流里只有答案。现在流里还会带上运行每个阶段的一行简短说明（排队、开始、调用了某个工具、等待审批、修正轮等），用各协议自己的思考形状：Responses 是一个 `reasoning` 输出项（放在最前面，所以之后的 `output_index` 都加一），Gemini 是标了 `"thought": true` 的部分。答案文本、非流式响应和用量统计都没有变，不显示思考的客户端看到的答案不变。Chat Completions 与 Claude Messages 保持原样（关）。想对单个请求关掉，发 `X-OAA-Progress: off`（或 `metadata: {"oaa.progress": "off"}`）；想对整个网关关掉，把 `streamProgress.responses` 与 `streamProgress.gemini` 设为 `"off"`；想在 Chat 或 Claude 上打开，把 `streamProgress.chat` 或 `streamProgress.claude` 设为 `"reasoning"`。读取流式 `response.completed` 事件里 `response.output[0]` 的代码会拿到这个 reasoning 项，请改读 `output_text`。见 `docs/progress.md`。
- **图片被接受了。** 图片内容段以前在每个入口都被 400 `unsupported_content` 拒绝。现在能用图片的智能体会接受；不能的智能体仍会在运行创建之前拒绝它。除非打开 `images.fetchRemote`，否则不会去抓远程 URL。
- **开发者平台的计费不再透支。** 每个任务的价格现在在任务开始时预扣，任务没有完成就退回。以前是在结束时才扣，并发的调用可以全都通过余额检查，把余额扣成负数。按 token 计的那一部分现在到余额为 0 就停止，不会扣成负数。本来就是负数的余额不会被进一步压低。旧行为没有开关可以恢复。
- **不上报 token 用量的智能体设置按 token 的价格会被拒绝**（`usage_pricing_unsupported`，400）：这样的智能体只能按次定价。以前保存的上架项保留原价。
- **限定智能体的管理员密钥有了边界。** 只限某些智能体的 `admin` 密钥，不能再吊销或修改它的智能体范围之外的密钥的额度，也不能改自己。它有额度时，不能创建或修改出高于这个额度的密钥（`quota_exceeds_own`，403）。要管理那些密钥，请用覆盖整个所有者的管理员密钥。
- **桥接的 ACP 回合里，自动批准的权限请求变少了。** 只有当请求的标题恰好点名了中继提供的一个调用方工具（其余的词只能是「run」「call」之类的填充词），并且智能体自己没有把这次调用归为执行命令或修改文件时，才不经所有者放行。标题里只是提到中继名与工具名的 shell 命令，现在要等所有者批准。
- **未鉴权的门户表单**（登录、注册、重置密码）接受的请求体最大 64 KiB。

### 安装

- **Linux**：`Open-Agent-API-<版本>-linux-x64.tar.gz` 与 `…-linux-arm64.tar.gz` 自带官方 Node.js 运行时和 `oaa` 启动脚本（没有桌面外壳；需要 glibc 2.28 及以上）。`install.sh`（`curl -fsSL …/releases/latest/download/install.sh | sh`）不需要 root：它用发布页的 `SHA256SUMS` 校验下载，安装到 `~/.local/share/open-agent-api`，并把 `~/.local/bin/oaa` 链接过去，支持 `--version`、`--prefix` 与 `--uninstall`。下载中途被截断时什么都不会运行。
- **Docker**：多阶段的 `Dockerfile`（`node:24-slim`、非 root 用户、状态放在 `/data` 卷、对 `/healthz` 的健康检查）与 `docker-compose.yml`，后者只把端口发布在宿主机的 `127.0.0.1:8787`。首次启动会初始化数据目录并发布离线示例智能体。发布 Release 时会把 `ghcr.io/jiangxingfan1-coder/open-agent-api` 推送为 `linux/amd64` 与 `linux/arm64`。容器里没有你宿主机上的那些智能体命令行，所以它适合内置智能体、ACP 与 A2A 远程智能体，以及主动连进来的执行节点。
- **npm tarball**：每个发布版本都带 `open-agent-api-<版本>.tgz`，用 `npm install -g <文件的 URL>` 安装。这个包仍是 `private`：不在 npm 官方仓库里。
- **更小的包**：去掉了第三方的 source map、测试与文档目录、图标库里用不到的构建，以及其他平台的沙箱程序（macOS 的 `.dmg` 从 123 MB 降到 86 MB，实测）。
- **Node.js 24 与 26**：`engines` 现在是 `>=24.18.0 <27`，CI 在两条线上都跑完整测试。安装包里自带的运行时仍是 24.18.0。
- **发布工作流**：`release.yml` 还会构建两个 Linux 包与 npm 包，把版本号盖进 `install.sh`，并把每个文件写进 `SHA256SUMS`。对每个包运行的烟雾测试现在会逐个 import 所有模块，对示例智能体在三种协议上做首次调用，经 API 与经 `oaa approve` 各处理一次审批，检查第二次 `quickstart` 不重复创建任何东西，并检查 `oaa stop` 之后没有残留进程。
- **修复**：经符号链接启动的 `oaa`（例如 `npm install -g` 创建的命令）没有任何输出；npm 把依赖提升之后（`npx`、装进项目），控制台的图标库返回 HTTP 500。

### Windows

- 命令经 `PATH` 与 `PATHEXT` 发现（`oaa init`、`quickstart`、`connect`、`doctor`、ACP 预设），记录带扩展名的完整路径。npm 的启动器（`codex.cmd` 之类）直接用 node 启动；其他 `.cmd` 与 `.bat` 经 `cmd.exe /d /s /c` 启动，每个参数都做了转义，所以调用方输入里的 `&`、`|`、`%VAR%` 与引号都按文本传递。给这类文件的参数里带换行会被拒绝（`invalid_request`）。
- 在 Windows 上，`oaa connect <预设>` 重启由它自己启动的后台网关时，先像 `oaa stop` 那样请它通过 `POST /v1/gateway/shutdown` 自行关闭，因为那里的普通终止会直接结束进程。
- 取消、超时与关机时，用 `taskkill /T /F` 结束智能体的整棵进程树。`oaa stop` 先通过新增的 `POST /v1/gateway/shutdown`（覆盖整个所有者的管理员密钥，只接受来自回环地址的请求）请网关自己关闭，十秒后仍在运行才终止进程。
- 调用方工具中继用命名管道代替 Unix socket。私有文件（管理员密钥、调用方密钥、`server.pid`）尽力用 `icacls` 收紧权限。Windows 会特殊处理的文件名（保留的设备名、含 `:`、以点或空格结尾）会被 `invalid_path` 拒绝。`oaa status` 与 `oaa verify` 在没有 `ps` 时也能工作。
- 完整的测试集现在在 CI 的 `windows-latest` 上运行（`windows.yml`，每个测试文件一个进程）；只在 POSIX 上有意义的测试带明确原因跳过。PowerShell 启动器脚本的提示文字跟随 Windows 的显示语言。细节与限制（没有沙箱、强制结束、安装包未签名）见 `docs/windows.md`。

### 安全

- 对网关做了一次安全审查，并做了修复：限定智能体的管理员密钥的边界、桥接 ACP 回合里收紧的自动批准、门户表单的上限，都在「行为变化」里。
- 日志与错误信息的脱敏现在还覆盖执行节点令牌（`oan_…`）、门户会话令牌（`oas_…`）和常见的上游密钥格式（Google `AIza…`、GitHub、Slack、AWS 访问密钥）。
- 新增可选的 `maxStoredBytesPerSubject`：限制一个调用方存储的文件字节数（包括从请求里存下的图片）；超过后上传以 `storage_quota_exceeded`（413）失败。不设置时没有变化。
- 新增可选的 `security.profile`：`local`（缺省，没有变化）或 `public`；后者为配置里没有设置的每一项换上更安全的默认值：`defaultKeyExecution: workspace`、外部智能体继承的环境变量改为白名单、`maxStoredBytesPerSubject` 为 256 MiB、接收一个请求的时限为 120 秒。配置看起来能被外部访问、档位却还是 `local` 时，`oaa doctor` 与 `oaa status` 会警告。
- 新增 `docs/security-model.md`：谁能做什么、默认暴露什么、对外开放之前该做什么、哪些没有防护（比如：门户注册会回答 `email_taken`，因为没有邮箱验证；登录失败计数只在内存里）。补了 Host 与 Origin 检查、静态资源路径的回归检查。

### 兼容性

- **兼容性实验室**（`integrations/compat/`、`npm run compat`，CI 里的 `compat.yml` 每次 push 与每周各跑一次）：官方的 `openai`、`anthropic`、`google-genai` Python SDK，Node 的 `openai`、`@anthropic-ai/sdk`、`@google/genai`，Vercel AI SDK、LangChain、LiteLLM、OpenAI Agents SDK 与 LlamaIndex，对着一个带离线智能体的隔离网关实际运行；Open WebUI、LibreChat、Chatbox、Cherry Studio、LobeChat、NextChat、Dify、n8n、Continue、Cline、Roo Code、Zed 与 Cursor 的请求（读自它们的源码或文档）被回放。哪个客户端实际运行过、哪个只是回放、哪个未核实，以及版本与配置，见 `docs/compatibility.md`。
- 根据实验室的发现做的修改：采样与厂商参数被宽容（见「行为变化」）；`reasoning_effort` 与 `reasoning.effort` 是选路提示；Responses 接受 `instructions`、带类型的 message 项与 `output_text` 历史；`GET /v1/models/{id}` 以 OpenAI、Claude、Gemini 各自的形状回答；`POST` 上长度为零的 JSON 请求体（官方 SDK 的 `responses.cancel` 会这样发）不再报 `invalid_json`；CORS 预检的回答列出浏览器问到的请求头；Gemini 的请求体可以用 snake_case 字段名（`google-genai` 3.3 的工具参数以前会丢），`/v1beta/{agent}:generateContent`（不带 `models/`）被接受；Base URL 末尾或中间多出的斜杠照常路由，缺少或重复 `/v1` 造成的 404 会说明原因。

### 新增能力

- **结构化输出**（`structured-output-v1`）：「行为变化」里说明的契约，覆盖四种线上格式，请求到达时检查 schema（`invalid_schema`、`schema_dialect_unsupported`、`output_schema_unsupported`），并对内核智能体和会话可以继续的外部智能体做修复轮。任务检查器显示契约与已用的修复次数。schema 不会交给模型提供方自己的结构化输出功能。见 `docs/structured-output.md`。
- **图片输入**（`image-input-v1`）：PNG、JPEG、GIF 与 WebP，经 OpenAI Chat 与 Responses、Claude Messages、Gemini、UAP 与原生请求体，可以是内联、已上传的文件或 `https` URL。上限是每张 5 MiB、每个请求 10 张与 8 MiB（`images.*`）。图片会存为调用方的输入文件。每个智能体按它能用的形式接收，否则请求在运行创建之前被拒绝；`GET /v1/models` 里有 `image_input`。网关缺省不抓取远程 URL。新增错误码：`image_invalid`、`image_too_large`、`too_many_images`、`image_fetch_failed`、`image_delivery_failed`。见 `docs/images.md`。
- **运行事件回调**（`webhooks-v1`）：带签名（HMAC-SHA256）的 HTTPS 回调，事件有 `run.requires_action`、`run.completed`、`run.failed`、`run.cancelled`、`run.incomplete` 与 `run.interrupted`；有持久队列、大约 40 分钟内共 6 次尝试、`/v1/webhooks` 下的端点与投递管理、出站地址检查（`security.profile: "public"` 下更严）、控制台里的只读列表。`examples/webhook-receiver.mjs` 是一个可以批准待办的接收端示例。只有覆盖整个所有者的管理员密钥能配置端点。见 `docs/webhooks.md`。

- **模型提供方预设**：`oaa connect <预设>` 一条命令就让内置智能体接上模型，并发布 `agent/assistant`，一个带工作区文件工具的通用助手。预设有：`ollama`、`lmstudio`、`openai-compatible`、`openai`、`anthropic`、`gemini-api`、`openrouter`、`deepseek`、`moonshot`、`zhipu`、`siliconflow`、`groq`、`together`、`mistral`。提供方现在可以从文件里读密钥（`apiKeyFile`，每次调用都读，所以换密钥不用重启），也可以不需要密钥（`noApiKey`，给本地模型用），并新增设置 `streamUsage` 与 `preset`。密钥从不接受命令行参数。上游调用失败时，错误现在会点名提供方并说明改哪里，新增错误码 `upstream_auth_failed`、`upstream_model_not_found` 与 `upstream_incompatible`。控制台发布内置智能体的对话框可以从已配置的提供方里选，智能体卡片显示所用的提供方以及它的密钥能不能解析。预设里的取值来自各服务自己的文档。见 `docs/models.md`。
- **流式过程**（`stream-progress-v1`）：「行为变化」里说明的行为，可以按请求（`X-OAA-Progress`、`oaa.progress`）或按协议（`streamProgress`）选择。这些行从不带工具参数、工具结果、提示词或内部标识，语言跟随 `Accept-Language`。兼容性实验室对每个 SDK 和框架都跑了一个 `stream_progress` 场景；聊天客户端里只有 Dify 对照了它的源码，它会在 Chat 上把过程混进答案里，所以 Chat 保持关闭。见 `docs/progress.md`。

### 开发者平台

- 上架项可以打开 `host_execution`，让平台账号能调用那一个外部智能体（Codex、Claude Code、ACP 智能体、适配器、带本机工具的内核智能体）。默认关闭并有审计，它委派的智能体需要各自的开关。控制台的上架对话框有这个开关和它的说明，上架列表会标出账号暂时调不了的智能体。见 `docs/platform.md`。
- 计费：每个任务的价格在开始时预扣、任务没有完成就退回，按 token 的扣费不再透支，不上报用量的智能体只能按次定价（见「行为变化」）。
- `examples/platform-walkthrough.ts` 用示例智能体离线走一遍整条路径：上架、打开开关、兑换码、注册、密钥、调用、扣费、充值。

### 命令行

- 新增 `oaa approvals`（带 `--watch`）、`oaa approve` 与 `oaa deny`：在终端里列出并处理审批。决定之前先打印要决定的操作。
- 新增 `oaa status`：用一个只读的回答说明网关和它的智能体怎么样了，支持 `--json`。
- 新增 `oaa verify AGENT`：打印计划；加 `--confirm-live-cost` 才会在隔离网关上运行真实智能体的验收场景，并写出脱敏的 `report.md` 与 `report.json`，可以附到 issue 里（模板：「智能体验证报告」）。`examples/live-agents-acceptance.ts` 现在与它共用场景。
- 新增 `oaa webhook add|list|remove|test|deliveries`。
- 新增 `oaa connect <预设>` 与 `oaa models`：给内置智能体接上模型提供方，并列出已配置的提供方，说明密钥能不能解析、端点有没有回应（本机地址自动探测，托管服务只有加 `--check` 才探测，而且只请求模型列表）。`oaa connect` 不会调用模型，除非加 `--test`，而且那时也只对本机地址的端点调用。
- 新增 `oaa prune [--older-than 30d] [--dry-run] [--vacuum]`：删除早于某个时间点的已结束运行及其事件与文件（见「稳定性」）。`oaa doctor` 现在会报告数据库大小。
- 命令参考见 `docs/cli.md`。

### 稳定性

新增的 `docs/zh-CN/stability.md` 写有方法、数字、崩溃恢复的语义和已知限制。

- **数据保留。** 你不要求，就什么都不删。新的 `retention` 设置（`runsDays`、`intervalMinutes`、`warnDatabaseMb`）会按定时器清理超过 `runsDays` 的已结束运行；`oaa prune`（`--older-than`、`--dry-run`、`--vacuum`）或 `POST /v1/maintenance/prune`（需要覆盖整个所有者的管理员密钥）则一次性清理。排队、执行中、等待审批和 interrupted 的运行永远不会被清理；账号与计费记录（账本、密钥用量合计）和记忆也不清理。`oaa doctor` 报告数据库大小，超过 `retention.warnDatabaseMb`（默认 1024 MB）时 `oaa status` 会打印一条提示；两者都不删任何东西。
- **压测发现并修复的内存与数据库增长。**（1）每次执行都会设一个无法取消的 30 分钟超时，使每个已结束运行的数据在 30 分钟内一直可达（负载下堆约每分钟增长 1.3 MB），现在改成可清除的计时器。（2）按精确时长反复重设的计时器，每次都会留下一个空的 Node 内部计时器列表；Node 要等原定时长过去才回收这样的列表，所以这是随负载和截止时长增长的积压，不是永久泄漏，这些计时器现在改用取整的时长。（3）清理之后，控制台的活动窗口仍保留刚被删除的运行。（4）持续失败的端点会让它的投递队列无限增长。修复之前，一次 65 分钟的运行里堆每分钟增长 0.29 MB、数据库每分钟增长 0.8 MB；修复之后分别是 0.008 与 0.0 MB。
- **事件回调：** 每个端点最多排队 10,000 条投递；超出的最旧几条标为 `failed`，原因是 `queue_overflow`。
- **备份与日志：** 迁移之前写的备份，每个源版本只保留最近 3 份（以前没有上限，所以守护程序反复重启一个起不来的网关时可能写满磁盘）；后台网关的 `server.log` 在启动时若大于 10 MB，会轮换为 `server.log.1`。被清理删掉的会话工作区，本机 worker 会重建，不再沿用缓存里的旧路径。
- **`npm run soak`**（只支持 macOS 与 Linux，不属于 `npm test`）用一个真实的网关进程、一个假模型和离线示例智能体做混合负载，重启三次（SIGTERM、SIGKILL、SIGTERM），并核对恢复情况与一组通过判据。它在这一版代码上的最新结果，环境是 macOS（Apple 芯片）、Node 24、并发 8：一轮 32 分钟带重启（34,010 个请求没有意外错误；另有 24 个失败发生在重启窗口内，单独计数），一轮 62 分钟单段（67,799 个请求，没有意外错误）。两轮都满足全部判据：数据库、文件描述符、句柄与子进程都保持平稳，SIGKILL 时在执行中的运行重启后都是 `interrupted`，没有智能体进程比网关活得更久。短末段的内存判据是在 32 分钟那一轮之后修正的：它 10 分钟的末段拟合斜率主要量到的是约 ±25 MB 的正常波动；所以 32 分钟那一轮满足的是修正后的判据，不是最初写的那一条（细节见 `docs/zh-CN/stability.md`）。
- **`npm run upgrade-check`** 用真实的二进制重复一次升级：旧版本建库，当前版本接管，旧版本再打开。一个真实的 0.0.64 数据库是测试夹具。

### 桌面应用

- macOS 应用的菜单、对话框与提示跟随系统语言。「关于」读取真实的版本号。端口取自 `config.json`，并且应用只连接它能确认属于自己数据目录的网关。隔离运行（`OAA_DESKTOP_HOME`、`OAA_DESKTOP_PORT`）不碰已安装的副本和它们的数据。管理员密钥只注入主框架里控制台的 `sessionStorage`，旧版本留在 `localStorage` 里的副本会被清除。首次启动会弹出一次对话框，列出发布了什么、启用了什么，以及去哪里关掉某个引擎。Windows 包的 PowerShell 启动器用中文或英文显示提示。
- 项目所有者于 2026-11-14 在一台 Apple 芯片的 Mac 上，用隔离方式运行发布模式构建的包，亲手确认了五处（只做了一次）：控制台直接是已连接状态，没有连接对话框；首次启动的一次性说明出现；刷新（⌘R）后仍然已连接（这检验了管理员密钥经 `sessionStorage` 交接）；「关于」里的版本号正确；菜单与对话框跟随系统语言。桌面应用的其余部分都没有验证，见「尚未验证」。

### 文档

- 每份文档都是英文为主，中文版在 `docs/zh-CN/`（以及 `README.zh-CN.md`、`CHANGELOG.zh-CN.md`、`ROADMAP.zh-CN.md`）。一个测试会检查链接与锚点有效、每份文档都有对应的另一语言版本、语言切换行在、错误码表与错误目录一致，以及这份变更记录以一个空的「未发布」小节开头。
- **文档站点与示例集。** `tools/docs-site/` 把中英文档生成为带搜索的静态站点；Pages 工作流现在先生成它，再与展示页一起部署，并有检查校验生成的页面和其中的链接。`examples/cookbook/` 有八组可复制运行的调用示例（第一次调用、长时间任务、审批、调用方工具、结构化输出、图片、错误与重试、接上工具），用 curl、Python 和 Node 写，兼容性实验室会逐个运行它们。`examples/README.md` 说明每个文件是给谁的。展示页的导航里有这两处的入口。
- 小项：文档现在写明每个入口都认 `Idempotency-Key`，以及取消之后调用方会看到什么（`cancelled`，或者在无法排除外部副作用时是带 `effect_outcome_unknown` 的 `interrupted`）。离线示例智能体的回答不再自称「本会话第 N 轮」，它的 README 也说明了它不能续接会话。
- 新增：`ROADMAP.md`、`docs/cli.md`、`docs/install.md`、`docs/windows.md`、`docs/security-model.md`、`docs/compatibility.md`、`docs/structured-output.md`、`docs/images.md`、`docs/webhooks.md`、`docs/models.md`、`docs/progress.md`、`docs/stability.md`，以及智能体验证报告的 issue 模板。`docs/evidence.md` 现在把离线测试与 CI 能说明的，和用真实智能体跑过的，分开写。

### 尚未验证

- **真实智能体。** 用真实智能体做过的端到端验证只有一次：2026-11-13 对 Antigravity，用的是验收脚本的早期版本。Codex 与 Claude Code 没有经过它；装了其中之一的人可以用 `oaa verify` 来做。
- **向 Codex 与 Claude Code 交付图片**是按厂商文档实现的，没有对着真实的智能体运行过。Claude Agent SDK 在带图片的那一条流式消息之后是否正常结束会话，是个悬而未决的问题。Antigravity 与 DSH 以工作区文件的形式接收图片，同样没有对真实智能体运行过。
- **结构化输出的修复轮在真实外部智能体上的表现**，以及 2026-11-11 那次手工联调（Antigravity 与 Qoder）之外的调用方工具桥接，只用替身智能体测过。
- **向真实的公网 HTTPS 端点投递事件回调**：测试只用本机的明文 http 接收端。
- **桌面应用里那五处之外的部分。** 没有验证的有：端口被占用时的三种提示；系统语言在中文与英文之间的两个方向切换（只看了所有者当前的系统语言）；同一数据目录第二次启动不再弹首次启动说明；应用崩溃后遗留的网关的识别与复用；Intel 芯片的包；这个版本在正常的、非隔离安装下（数据目录在默认位置、端口 8787）的表现；Windows 启动器的双语提示（没有 Windows 机器，CI 里只有 PowerShell 语法检查）。macOS 应用背后的逻辑有离线测试覆盖。
- **Windows 上的真实智能体。** CI 用替身智能体在 Windows 上通过了完整测试。
- **发布工作流的新增部分。** Linux 包、`install.sh`、npm tarball、扩充后的烟雾测试与多架构的 Docker 推送，还没有在 GitHub 上运行过：第一次运行就是这个版本的发布，这个版本的 Windows 包也是。Docker 镜像已经在 CI 里构建（amd64）并通过烟雾测试。
- **兼容性实验室用的是确定性的夹具模型和示例智能体**，从来不是真实智能体。回放只说明网关接受客户端记录下来的请求、并以它能解析的形式回答，不说明整个应用可用。Cursor 未核实，LibreChat 与 LobeChat 只是部分从源码推出。
- **开发者平台**：真实外部智能体的计费成功路径，以及公网部署，都没有见到过。
- **模型提供方预设**没有对任何真实的模型服务运行过。地址和差异来自各服务自己的文档，测试用的是假服务。某个预设不能用时，`oaa models --check` 和错误码会说明该改哪项设置。
- **文档站点**已经构建、链接也检查过，但没有在真实的 GitHub Pages 上看过：第一次部署就是它第一次露面。
- **压测**只用了假模型和离线示例智能体，最长 62 分钟。真实的模型提供方和真实的智能体命令行会带来它没有测到的延迟、内存和故障方式，有设计上限的缓存要几个小时才会填满。较早的一次 32 分钟尝试里，网关在 SIGKILL 之后约 110 秒才有回应；之后的三次 SIGKILL 重启和一次手工尝试都没有再出现，原因不明（见 `docs/zh-CN/stability.md` 的「已知限制」）。
- **外部智能体的流式过程**只用替身智能体测过，没有对真实的智能体运行过。
- **没有做的**：把 schema 交给模型提供方自己的结构化输出功能、强制工具选择、真实的支付渠道。

## 0.0.64（2026-11-14）

公开版本从 0.0.64 起重新编号；下面 0.1.0–0.6.4 是公开之前的内部版本号，保留作为变更记录。

第一个公开版本：以 Apache-2.0 开源，并提供自带 Node 运行时的 macOS（Apple 芯片、Intel）与 Windows 安装包。网关行为与 0.6.4 相同。

### 发布构建

- 打包脚本新增发布模式 `--release`：不安装到任何应用目录、不链接 CLI、不写用户主目录，产物只写到 `release/`（越界的写操作直接报错）；`--dry-run` 只打印每一步要写的路径与要执行的外部命令。本机开发打包（不带 `--release`）的行为不变。新增 `npm run package:release:mac`、`package:release:win`。
- 发布包自带官方 Node 运行时（`--node-dir`，版本按 `engines.node` 校验），并按 `package-lock.json` 排除开发依赖、专有的 `@anthropic-ai/claude-agent-sdk` 及只被它引用的包、其他平台/架构的原生包。macOS 支持 `--arch arm64|x64`；产物统一命名为 `Open-Agent-API-<版本>-macOS-<arch>.dmg`、`…-win-x64.zip`，并生成 `SHA256SUMS`。
- Claude 原生引擎在缺少 Claude Agent SDK 时返回 `adapter_unavailable` 与安装说明（可另行安装到 `~/.oaa/vendor` 或 `OAA_CLAUDE_SDK_DIR`），`oaa doctor` 与本机后端信息标为 `requires_separate_install`；随依赖安装时行为不变。
- Windows 启动器：Node 版本提示与 `engines` 一致；修正 `oaa.cmd` 在括号块里提前展开 `%ERRORLEVEL%` 导致退出码不对；桌面启动器补上缺失的 `System.Windows.Forms` 加载（以前出错时什么提示都没有）、读取配置里的端口、端口被占用与启动失败时给出提示和日志位置；新增 `Stop-OpenAgentAPI.cmd` 退出后台网关；`.ps1` 以 UTF-8 BOM 写出以便显示中文。
- 新增 GitHub Actions 发布工作流 `release.yml`（推送 `v*` 标签或手动触发）：三个平台各自检查、下载并用 `SHASUMS256.txt` 校验官方 Node、打包、烟雾测试（用包内 Node 运行 CLI、在随机回环端口启动网关核对 `/healthz` 版本），最后创建草稿 Release。`ci.yml` 扩展到 Ubuntu、macOS 与 Windows。说明见 `docs/releasing.md`。

### 上手

- 在干净的 HOME 下按 README 实际走了一遍源码路线与安装包路线（外部智能体用仓库里的 ACP 测试替身代替），据此修正上手步骤：先说明需要一个可发布的智能体；默认用 `serve --detach`；补上命令行建密钥、`invoke` 之后用 `wait` 取结果、常见报错表，以及不装任何智能体时用测试替身走完整条路的步骤。
- 新增 `oaa connect <codex|claude|agy|ACP 预设名>`：检测是否安装 → 在本网关启用 → 发布为 `agent/<名字>`（已发布则跳过）→ 确认 quickstart 的密钥能调用它（否则单独建一把只能调用它的密钥）→ 打印 model 与 curl。不调用该智能体，并说明第一次调用会用它自己的登录与额度。quickstart 结尾改为每个检测到的智能体一行 `oaa connect …`。
- Windows 桌面启动器改由 `oaa quickstart --dir %LOCALAPPDATA%\OpenAgentAPI` 启动网关，首次启动即有可调用的离线示例智能体，输出写进 `quickstart.log`；退出脚本同时处理 `oaa stop`。`README-WINDOWS.txt` 把 `oaa.cmd quickstart` 写成第一步。
- 控制台：发布返回 `not_runnable_here` 警告时，发布对话框保持打开并显示原因；概览「快速上手」里已有示例智能体 `agent/sample` 时，第一步视为完成。
- 示例智能体的工具演示改为「读取本机时间」，不再统计提示字数（那个数包含网关拼进去的上下文，容易误解）。
- 新增 `oaa quickstart`：初始化（已有则跳过）→ 后台启动网关，只监听 127.0.0.1（已在运行则复用，配置变了则重启；端口被占用时报 `port_in_use` 并提示 `--port`）→ 发布离线示例智能体 `agent/sample` → 生成调用方密钥（私有文件，已有且有效则复用）→ 真调一次并打印回答、Base URL、model、curl、OpenAI SDK 代码，以及接上本机 codex / claude / agy 或内置智能体的下一步。重复运行不重复创建。中英双语输出。
- 新增离线示例智能体 `examples/sample-agent.mjs`（ACP；不调用任何模型、不联网，回答写明是示例），演示多步、一次工具调用和可选的一次审批；定义在 `examples/sample-agent.json`。随源码与安装包分发。
- 报错改准：`model_unavailable` 点名没安装或没启用的引擎/适配器、缺少的提供方环境变量及处理方法；发布本机当前跑不了的智能体时，发布成功但返回 `warning`（`not_runnable_here`）；受限密钥请求未授权或不存在的 `model` 时提示用 `GET /v1/models` 查看（不透露是否存在），管理员密钥的 `agent_not_found` 同样提示；401 说明密钥从哪里来。四种入口的错误体形状不变。
- `oaa init` 输出管理员密钥文件位置与下一步（`oaa quickstart`）。
- macOS 桌面应用：首次启动发布离线示例智能体（标记文件升级为 `.seeded-v2`，老用户也会补上）；agy 示例只在检测到 agy 时发布；去掉对不存在的 `examples/smart-repo-inspector.oaa` 的发布。自动启用检测到的本机智能体的行为不变，文档改为如实说明。
- 安装包的 `examples/` 不再带跑不了的 `.ts`、`live-agents/` 与 `gemini-sdk-probe.mjs`；找不到 npm 时 Claude SDK 的安装提示先说明需要另装 Node.js（自带 npm）。
- 新增 `oaa key create`：经 `POST /v1/keys` 生成调用方密钥，写进 0600 私有文件（默认 `.oaa/keys/<name>.key`，不覆盖已有文件），只打印文件路径、Base URL、模型名和一条可直接运行的 curl 命令，不打印密钥本身。
- 新增 `oaa stop`：停止 `oaa serve --detach` 启动的网关，只向 `/health` 报告的那个 pid 发 SIGTERM。
- 命令行连不上网关时报 `gateway_unreachable` 并提示如何启动（以前是 `execution_failed: fetch failed`）；未知选项报 `arguments`（以前是 `execution_failed`）；`token_required` 补上下一步建议。

### 开源准备

- 英文适配：错误目录的每个码新增英文说明 `en` 与下一步建议 `nextEn`（`GET /v1/errors` 一并返回）；HTTP 错误响应按 `Accept-Language` 选择语言，没有该头时用进程默认语言（`OAA_LOCALE`，否则看系统区域）。原本只有中文说明的抛出点（ACP 智能体、本机后端、Claude SDK 安装提示等）改为中英双语，四种入口的错误体形状不变。`oaa` 的帮助改为分组并按进程默认语言显示中文或英文，失败时附上目录里的下一步建议。中文系统上的默认体验不变；测试统一固定为中文。规则见 `docs/protocol.md`「错误说明的语言」。
- ACP 预设说明（`GET /v1/local/backends` 的 `presets[].notes`，控制台本机后端页显示）提供中英两版，同样按 `Accept-Language` 选择，没有该头时用进程默认语言；英文文案在 `src/config/agent-presets-en.ts`。
- 新增 `LICENSE`（Apache License 2.0 标准全文）与 `NOTICE`（版权持有人为 The Open Agent API Authors，并保留 Open Design 的 Apache-2.0 署名）。`package.json` 声明 `"license": "Apache-2.0"`，补上 `repository`、`bugs`、`homepage` 与 `files` 白名单（只含 `dist/src`、`web`、说明与许可证类文件）；`"private": true` 仍保留。
- `THIRD_PARTY_NOTICES.md` 补全 `@anthropic-ai/sandbox-runtime`（Apache-2.0）的署名，列出全部运行时依赖及其许可证，并单列专有许可的 `@anthropic-ai/claude-agent-sdk`（由使用者自行安装，不受本项目许可证覆盖）；附运行时依赖闭包的许可证核查结果，并把 `lucide` 的许可证全文复制到 `licenses/Lucide-ISC.txt`。
- 新增 `CONTRIBUTING.md`、`SECURITY.md`（漏洞通过 GitHub 私密漏洞报告提交）、`CODE_OF_CONDUCT.md`，以及 issue 与 Pull Request 模板。
- README 顶部加许可证与社区文件链接，「许可与署名」一节补充说明；上手步骤对照 `package.json` 与 `src/cli.ts` 核对过，命令与参数均存在。
- 测试夹具里带个人名字的示例域名改为 `agents.example.com`。

## 0.6.4（2026-11-13）

这一版修正了审批与调用方工具结果的等待在过期计时器早于到期时间触发时停住、不再超时的问题：运行会一直挂到智能体放弃或运行总超时，而不是按 `approvalTimeoutMs` 失败。现在没到期就重新计时。

### 修正

- 进程内等待调用方工具结果（外部智能体经中继调用调用方工具）与等待外部智能体权限审批时，过期计时器若比墙上时钟早到（`setTimeout` 走单调时钟、`Date.now()` 走墙上时钟，相差约 1 ms 就会出现，系统校时把时钟往回拨时更多），等待会停住不再计时：运行不按 `approvalTimeoutMs` 以 `client_tool_timeout` / `approval_expired` 失败，而是一直挂到智能体自己放弃或运行总超时。现在没到期就重新计时。

## 0.6.3（2026-11-13）

这一版让开发者平台可以直接在控制台里一键启用、改设置、停用；保存后重启网关生效，不必再改配置文件。同时去掉控制台侧栏底部的密钥名与地址，并重写开发者平台未启用时的说明页。

### 新增

- 开发者平台可以在控制台里一键启用、改设置、停用，不必手工改配置文件：新接口 `GET/PUT /v1/platform/setup`（特性 `platform-setup-v1`，平台未启用时也可用，需要 owner 级管理员密钥、只在控制台域名上）。设置保存在网关数据库的 `gateway_platform_setup` 表（第一次保存时才建，不改写 `config.json`），重启网关后生效；设置归首次启用它的 owner（其它 owner 403），修改时没填的字段保持原值；停用只关开关，账号、流水、上架都保留。配置文件里的 `platform` 段仍然可用且优先，写了之后界面只读（409 `platform_managed_by_config`）。每次保存写审计记录 `platform_setup`。

### 变更（界面）

- 控制台侧栏底部「设置」下面那一条（状态圆点、密钥名、地址）整条去掉。未连接时，顶栏的「未连接」可以点开连接对话框；密钥被拒绝或失效时，错误横幅里带「重新连接」。已连接时在设置页「连接」里切换密钥或断开。
- 「开发者平台」未启用时的说明页重写：先讲用途与「什么时候不需要」，再用一张两行的对照说明「API 密钥」与「开发者平台」两种分发方式的区别，最后才是启用方式。owner 只在这一页解释；启用后在「概况」里弱化显示一行「智能体归属（owner）」。

## 0.6.2（2026-11-12）

这一版把 API 密钥改成常见的 `sk-oaa-` 格式（旧的 `oaa_` 密钥继续有效），并把密钥的「停用 / 吊销」改为真正的删除。创建密钥后的结果页突出服务地址（Base URL）与 API Key，设置页去掉了没有作用的条目。

### 变更

- API 密钥改成常见的 `sk-` 格式：控制台新建的密钥与开发者账号密钥都形如 `sk-oaa-` 加 48 位字母数字（此前是 `oaa_` 加 base64url）。**旧的 `oaa_` 开头的密钥继续有效**，无需重新生成。调用方只需 Base URL 与 API 密钥，`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、`?key=` 均可。错误信息脱敏与发布元数据的密钥检测同时识别新旧两种格式。
- 删除密钥：`DELETE /v1/keys/:id` 与 `DELETE /v1/portal/keys/:id` 之后，密钥立即失效，并且不再出现在 `GET /v1/keys`、`GET /v1/portal/keys` 的列表里（此前标为已撤销后仍留在列表中；此前已撤销的旧密钥也一并不再列出）。记录在内部保留，账单、任务归属与用量结算不变；响应里的 `revoked` 字段保留，恒为 `false`。

### 变更（界面）

- 控制台与门户的「停用 / 吊销密钥」统一为「删除」：删除后该行从列表消失。配置文件里定义的密钥不能在界面里删除，那一行显示锁图标并说明原因。
- 创建密钥后的结果页只突出三样：服务地址（Base URL）、API Key、模型名，各自一键复制，另有「复制全部」（三行环境变量）；示例代码默认折叠。
- 设置页去掉没有作用的条目：「网关地址」「所有者（owner）」「协议能力」，以及与「关于」重复的「网关版本」；连接信息里只留密钥名称、权限范围、可访问的智能体和服务地址（Base URL）。全控制台统一叫「服务地址（Base URL）」，桌面应用菜单同步改名。

## 0.6.1（2026-11-12）

这一版用官方 SDK（`@anthropic-ai/sdk` 1.3.0、`@google/genai` 3.2.0）实测了 Claude 与 Gemini 两个兼容入口，修正了实测发现的问题，其中 Gemini SDK 默认的 `v1` 前缀此前直接返回 404。Gemini 入口还补上了调用方工具的桥接。

### 新增

- Gemini 兼容入口支持调用方工具的桥接（`X-OAA-Client-Tools: bridge`，`/v1beta` 与 `/v1` 两个前缀）：`tools[].functionDeclarations` 成为调用方工具（`parameters` 的 OpenAPI 大写类型转成 JSON Schema，`parametersJsonSchema` 原样），停车时返回 `functionCall` part（`args` 为对象，并行调用多个 part）与 `finishReason: "STOP"`，流式在一个分片里给全；`contents` 末尾的 `functionResponse` 按 `id` 或（不带 `id` 时）按名字与顺序配对续接同一个运行。`googleSearch` 等内置工具在 bridge 下报 `client_tools_unsupported`，`toolConfig` 仍列在 `X-OAA-Ignored-Params`。此前 Gemini 请求 bridge 一律 400 `client_tools_bridge_unsupported`；这个错误码保留，只用于不支持桥接的外部智能体与缺少执行机器的情况。用官方 `@google/genai` 3.2.0 一次性实测（探测脚本 `examples/gemini-sdk-probe.mjs`）。

### 修正（协议转换）

- `/v1/messages/*` 下网关没有的子路径（SDK 的 `messages.countTokens()`、`messages.batches.*`）的 404 改用 Claude 错误体，SDK 解析为 `NotFoundError`、`type: "not_found_error"`（此前是 OpenAI 形状，`type` 解析成 `invalid_request_error`）。
- 带 `anthropic-version` 请求头的 `GET /v1/models` 返回 Anthropic 的 ModelInfo 列表与游标分页字段，SDK 的 `models.list()` 拿到 `type`、`display_name`、`created_at`（此前是 OpenAI 列表，这些字段为空）。不带该头时不变。
- Gemini：接受 `/v1/models/{agent}:generateContent` 与 `:streamGenerateContent`（`@google/genai` 默认 `apiVersion` 是 `v1`，此前不显式设 `v1beta` 就是 404）；该路径的错误用 Google 错误体，`?key=` 同样可用。
- Gemini：新增 `GET /v1beta/models` 与 `GET /v1beta/models/{agent}`，带 `x-goog-api-client` 头的 `GET /v1/models[/{agent}]` 也用 Google 的 Model 形状，SDK 的 `models.list()`/`models.get()` 拿到 `name`、`displayName`、`supportedGenerationMethods`（此前 `/v1beta` 是 404，`/v1/models` 是 OpenAI 列表，`models.list()` 静默得到空列表）。
- OpenAPI（`/openapi.json`）登记此前漏掉的路由：`POST /v1/models/*`、`GET /v1beta/models`、`GET /v1beta/models/*`、`GET /v1/models/*`，`GET /v1/models` 说明三种响应形状并列出 `anthropic-version`、`x-goog-api-client` 两个请求头参数；同一路径的多个方法（如 `/v1beta/models/*` 的 GET 与 POST）合并登记，不再互相覆盖。
- Claude 响应补齐官方 SDK 1.3.0 类型里必有、可为 null 的字段：`Message` 的 `container`、`stop_details`、`diagnostics`，`usage` 的缓存计数、`cache_creation`、`output_tokens_details`、`server_tool_use`、`service_tier`、`inference_geo`、`speed`（均为 `null`）；流式 `message_start`、`message_delta`（`delta` 与 `usage`）同样补齐，桥接停车时的响应一致。SDK 读到 `null` 而不是 `undefined`。
- Gemini 桥接的 `parameters`（OpenAPI 子集）转 JSON Schema 时，除 `properties`、`items`、`anyOf` 外也递归 `oneOf`、`allOf`、`not`、对象形式的 `additionalProperties`、`prefixItems`、`$defs`/`definitions`、`patternProperties`；映射类关键字里名为 `type`、`nullable`、`items` 的属性不当关键字处理，`enum`、`default`、`const`、`example(s)` 的值原样保留。

### 修正（界面）

- 控制台任务列表的「模型」列：很长的模型名不再折成多行把那一行撑高，改为单行显示、超出用省略号、悬停看完整值。共享表格层新增列选项 `truncate`。余额流水里的外部单号同样处理。

### 验证

- Claude Messages 兼容入口用官方 `@anthropic-ai/sdk` 1.3.0（声明为开发依赖，版本与锁文件已有的一致）经进程内网关实测，新增 `test/compat-anthropic-sdk.test.ts`、`test/compat-anthropic-sdk-errors.test.ts`：非流式与流式解析、截断、系统提示与多轮、三种鉴权写法、各错误类、失败与待审批只发一次请求且只建一个运行、限流的 `Retry-After`、桥接工具（单个与并行、流式拼装）、托管模式。Gemini 入口用临时安装的官方 `@google/genai` 3.2.0 做了一次性实测（SDK 不是项目依赖；探测脚本 `examples/gemini-sdk-probe.mjs`），发现的问题用不依赖该 SDK 的 `test/compat-gemini-sdk-findings.test.ts` 回归。

## 0.6.0（2026-11-12）

这一版是协议兼容与控制面的一轮审计与修正。四份只读审计（OpenAI 兼容面、Claude 与 Gemini 兼容面、控制协议两部分、界面）找出协议与控制面的 7 条 P0 与 18 条 P1，以及界面的 4 处破损与 13 条体系性问题。这一版关掉了全部 P0 与 P1：其中一条 P1（桥接续接沿用同一个响应 ID）按产品语义保留并写进文档，一条控制面的 P1 经复现证伪；界面的 4 处破损与 13 条体系性问题都已处理。少数 P2 没有做。会影响已有调用方的变化（状态码、错误形状、截断、内联图片、幂等与事件流）集中列在「升级须知」一节，升级前请先读。

### 修正（协议转换）

- **错误形状按各家协议**：OpenAI 入口为 `error.code`、`error.param`；Claude 入口为 `{ "type": "error", "error": { "type", "message", "code" } }`，`error.type` 按 HTTP 状态映射；Gemini 入口为 `{ "error": { "code", "message", "status", "details" } }`，网关码在 `details[0].reason`。运行已创建后的错误带 `run_id`。流开始之后出错时，错误帧带真实的错误码与原因，不再是固定的一句话。
- **失败与待审批返回 422**：非流式 Chat、Claude、Gemini 在运行已创建但没有正常结束（失败、取消、中断、待审批）时返回 422 并带 `x-should-retry: false`，不再是会被官方 SDK 自动重试的 409。`action_required`、`incomplete` 的主状态随之由 409 改为 422。
- **截断与结束原因**：Chat Completions 截断时返回 200 与 `finish_reason: "length"`（流式照常以 `[DONE]` 结束）；Claude 为 `stop_reason: "max_tokens"`，Gemini 为 `finishReason: "MAX_TOKENS"`，Responses 为 `status: "incomplete"`。
- **输出长度上限生效**：`max_tokens`、`max_output_tokens`、`maxOutputTokens` 取请求值与智能体自身上限的较小者，只对内置内核智能体生效。采样类参数（`temperature` 等）仍接受并忽略，被忽略的参数名经 `X-OAA-Ignored-Params` 告知。
- **`/v1/universal` 不再猜协议**：`X-OAA-Protocol` 请求头优先；否则只按各家独有的请求头与结构判定，判定不了返回 400 `protocol_undetected`。`max_tokens`、字符串 `system` 等两家都有的字段不参与判断。
- **Claude 的 `system` 不截断**：去掉 2000 字符的限制，整体长度受输入上限约束，超限报 `invalid_request`。
- **内联图片明确拒绝**：Claude 与 Gemini 入口的内联图片（base64 或 URL，以及 Gemini 的 `inlineData`）返回 400 `unsupported_content`，不再当作文本交给智能体。工具调用与工具结果内容块改为以标注文本交给智能体。
- **严格端点的参数**：`/v1/chat/completions`、`/v1/responses` 对不支持的字段返回 400 `unsupported_parameter`，`error.param` 为字段名，并指向兼容端点。
- **Gemini 与 Claude 的流**：Gemini 支持 `?key=`；`:streamGenerateContent` 不带 `alt=sse` 时返回 JSON 数组分块；Claude 流在 `message_start` 之后发 `ping`。
- **Responses 的续接与用量**：`GET /v1/responses/{id}?stream=true` 能重新接上后台运行的流，`starting_after` 跳过已收到的帧；流事件的 `sequence_number` 从 0 连续；`usage` 补上 `input_tokens_details` 与 `output_tokens_details`。
- **限流与配额的重试头**：限流类 429 的 `Retry-After` 为当前窗口真实的剩余秒数；配额耗尽的 429 带 `x-should-retry: false`，不再被 SDK 当作可重试。
- **桥接续接的响应 ID**：一个任务一个 ID、一次计费，续接沿用同一个响应 ID。这与 OpenAI「每次调用一个新 Response」不同，是有意的差异，已写进 `docs/protocol.md`。

### 修正（控制面）

- **密钥用量按差额累加**：同一运行多次收尾（中断后恢复、再次完成）只计一次 token；升级前已经多记的历史数据不回改。
- **恢复计入并发**：恢复的运行与网关启动后重新入队的运行重新计入所属密钥的并发上限，并发上限对恢复生效。
- **恢复前重新检查资格**：密钥是否过期或被吊销、账号是否停用、智能体是否仍对这把密钥可用（上架被下架）、余额与全部配额。不满足时拒绝恢复，运行保持原状；管理员代恢复别人的运行而原密钥已失效时返回 409 `run_key_inactive`。
- **平台流水与中断**：中断的运行即按已用 token 结算；恢复时这一行改回进行中，完成后按差额补结。
- **取消不再静默**：取消一个不在本进程执行的进行中运行，返回 409 `run_not_attached`。
- **大运行的事件流续传**：单个大帧（带完整输出的终态帧）不再因缓冲上限被截断，断线重连后一定能收到终态；补发按背压分批，读不动的慢客户端仍会被断开。
- **事件流数量上限**：每个调用方 64 条、每个 owner 256 条运行事件流，超限返回 429 `too_many_streams` 并带 `Retry-After`；兼容入口的流式请求在创建运行之前占名额。
- **节点消息校验**：网关对节点上行的消息做结构校验，畸形、超大或类型不对的消息以 1008 断开；旧版节点的合法消息照常接受。
- **终态后的等待步骤**：运行终结时仍在等待的步骤标为 `failed`，错误写明 `not_executed: <运行错误码>`。
- **幂等指纹**：区分是否带了自带的提供方密钥（BYOK）及是哪一把，只并入密钥的摘要，密钥本身不落库。
- **调用方工具的审批检查**：`action_kind_mismatch` 的检查移入内核的 `decide`，任何入口都不能人工批准调用方工具。
- **只作运行错误码的写法**：`turn_limit`、`token_budget`、`max_output_tokens` 改用不带 HTTP 状态的 `RunErrorFault` 抛出，错误目录里状态统一为 `null`（`turn_limit`、`token_budget` 原为 409，实际从不作为 HTTP 状态返回）；兼容入口错误体的类别按原因区分：调用自身的上限（这三个码）流式与非流式都归 Claude `invalid_request_error`、Gemini `FAILED_PRECONDITION`（流里原为 `conflict_error` / `ABORTED`）；服务一侧的原因（`gateway_restarted`、`run_timeout`、`parent_interrupted`）归 `api_error` / `INTERNAL`（非流式原为 `invalid_request_error` / `FAILED_PRECONDITION`）。HTTP 状态与 `x-should-retry` 不变。

### 界面

- **字体随产品发布**：Geist、Geist Mono、Instrument Serif、Noto Serif SC（OFL-1.1，约 3.4 MB），放在 `web/fonts/`，许可证在 `licenses/`，`THIRD_PARTY_NOTICES.md` 已登记。不联网下载。
- **修复 4 处破损**：门户登录后页头在约 1000px 以下重叠；控制台任务表在 1024 下耗时列被裁；开发者平台表在 1024 下数字列相撞；调用地址页代码块的复制按钮盖住首行。
- **体系统一**：间距、字号、圆角走设计变量；卡片改为无投影的 1px 细边，删去渐变与印章装饰；控制台与门户共用表格列模型（数字列右对齐，放不下时在容器内横向滚动）、格式函数（点数、token、时间）与设计变量。
- **样式拆分**：控制台的 `console.css` 与门户的 `runs.css` 按分节拆成多个文件，拆分本身不改变渲染结果。
- **用词统一**：控制台的「请求」统一叫「任务」（界面文案；协议字段、路由、错误码不变）。
- **开发者平台页分四个标签**：概况与用量、上架与定价、开发者、兑换码。
- **门户导航**：主导航为首页、智能体、文档、试用；用量、任务、密钥、账单与退出收进账户菜单。
- **任务的输入预览**：控制台任务列表与概览的「输入」取最后一条用户消息的文本，不再显示 `[user]`、`[system]` 等角色标记与系统提示；已有的旧摘要在读取时同样处理，交给智能体的输入不变。

### 升级须知

- **非流式失败与待审批**：Chat、Claude、Gemini 从 409 改为 422 并带 `x-should-retry: false`。按状态码分支的客户端需要改；官方 SDK 不再自动重试这类调用。
- **截断**：Chat Completions 的截断从 409 改为 200 与 `finish_reason: "length"`。
- **通用入口**：`/v1/universal` 判定不了协议时返回 400 `protocol_undetected`，不再猜。
- **内联图片**：Claude 与 Gemini 入口的内联图片从「被当作文本」变为明确拒绝（400 `unsupported_content`）。需要图片的调用方请先 `POST /v1/files` 上传，再按文件 ID 引用。
- **严格端点的参数**：`/v1/chat/completions` 与 `/v1/responses`（不带兼容头）对不支持的字段返回 400 `unsupported_parameter`。
- **输出长度上限**：`max_tokens` 等现在真正生效，只能调低智能体自身的上限。
- **Responses 流**：`sequence_number` 从 0 开始（之前直接用事件 ID）；`usage` 多了 `input_tokens_details` 与 `output_tokens_details`。
- **错误目录**：新增 5 个码（`unsupported_parameter`、`unsupported_content`、`protocol_undetected`、`run_key_inactive`、`run_not_attached`）；`action_required`、`incomplete` 的主状态改为 422；`GET /v1/errors` 的修订号随之变化，按修订号做缓存的需要重新拉取一次。
- **幂等**：同一个 `Idempotency-Key` 在带与不带自带提供方密钥之间切换，现在返回 409 `idempotency_conflict`。
- **事件流上限**：每个调用方同时打开超过 64 条运行事件流时返回 429 `too_many_streams`。
- **恢复与取消**：恢复会检查资格，不满足时拒绝；取消不在本进程执行的运行返回 409 `run_not_attached`。
- **平台流水**：中断的运行即按已用 token 结算（之前停在进行中）。
- **数据库**：新增表 `api_key_run_tokens`（密钥 token 差额记账），第一次启动时为已中断的运行补记。`SCHEMA_VERSION` 仍为 4。
- **静态资源路径**：控制台新增 `/styles/`、`/shared/`、`/fonts/`，门户新增 `/portal/styles/`、`/portal/shared/`、`/portal/fonts/`。自建反向代理若对路径做了白名单，需要放行（见 [docs/zh-CN/deploy-public.md](docs/zh-CN/deploy-public.md) 第 5 节）。
- **节点**：远程执行机器收到的 `Work.maxOutputTokens` 是可选字段，不认识它的旧版节点仍按已发布的上限执行；畸形消息会被断开。
- **界面用词**：控制台里的「请求」改叫「任务」。

### 限制

- Claude 与 Gemini 的兼容性没有用官方 SDK 实测，断言按各家官方文档写。OpenAI 兼容接口（Chat Completions、Responses）用官方 Node SDK 经进程内网关测试。
- 不支持内联图片与音频（base64 或 URL）。所有兼容入口（OpenAI、Claude、Gemini 与 `/v1/universal`）都明确拒绝，返回 400 `unsupported_content`，需先经 `POST /v1/files` 上传再按文件 ID 引用，见 [docs/zh-CN/protocol.md](docs/zh-CN/protocol.md#兼容入口的参数错误与结束原因060)。
- 运行记录已被清理、而流水仍在进行中时，启动对账按 0 token 结算，可能少收。
- 仍然是单网关 + SQLite，不支持多实例与 Postgres。
- 仍然没有支付渠道与邮件。

### 验证

全量测试 696 项通过（其中离线 528 项；0.5.0 是 620 项）。OpenAI 的两个入口用官方 Node SDK（经自定义 `fetch` 接进程内网关）测了非流式、流式、截断、失败与待审批不被自动重试、限流、桥接往返、内联图片被拒绝。在本机隔离网关上用本地确定性模型抽查了各入口的错误形状、被忽略参数的响应头、Claude 的长系统提示、Gemini 的 `?key=`、通用入口的协议识别，并逐页看了控制台（1440 浅色与 1024 深色的全部视图）与门户（1280 浅色与 390 深色的全部页面）：没有横向溢出，没有浏览器控制台报错，每屏实心主操作不超过一个。

没有验证的：Claude 与 Gemini 没有用官方 SDK 实测（断言按官方文档写）；没有调用真实模型，没有在公网与反向代理环境里验证；界面只在 Chromium 内核的浏览器里看过，1440 与 1920 宽度的完整页面只看了离线截图；「30 秒不读数据即断开慢客户端」只有代码核对。

## 0.5.0（2026-11-12）

这一版让「智能体即 API」在门户里看得见，并补齐接入支付与运营稳健性：开发者能看到自己每个任务的过程，并能在浏览器里试用智能体；运营者可以用只能加点数的密钥接自己的支付回调，并按外部单号去重；忘记密码的开发者凭运营者给的重置码自己设置新密码；网关重启后未结算的流水会被对账。不配置 `platform` 段时，除本节列出的变化外，行为与 0.4.0 相同。

### 新增

- **门户任务记录与任务详情**：「任务」页列出账号发起的任务，可按智能体过滤、翻页；详情给出状态、起止时间、用量、费用、输出，以及按段列出的执行过程（类别、名称、状态与耗时）。见 [docs/zh-CN/platform.md](docs/zh-CN/platform.md#查看任务的过程)。
- **门户试用台**：「试用」页选择已上架的智能体，填入自己的账号密钥，流式查看输出，结束后给出这个任务的记录页链接。密钥只留在页面内存里，不写入 `localStorage`；试用同样计费。不新增后端接口。
- **充值专用密钥（`billing`）**：只能给账号加点数（`POST /v1/platform/accounts/:id/credit`，`amount` 必须大于 0）和按邮箱找账号（`GET /v1/platform/accounts?query=`），不受 `consoleHosts` 限制。见 [docs/zh-CN/platform.md](docs/zh-CN/platform.md#接入你自己的支付)。
- **按外部单号去重的入账**：`credit` 的请求体可带 `reference`。同一单号再次提交时不再入账，返回第一次的结果并带 `duplicate: true`；金额或账号与第一次不同时返回 409 `reference_conflict`。带单号的流水行多一个字段 `reference`。
- **一次性重置码**：`POST /v1/platform/accounts/:id/reset-code` 生成 20 个字符的重置码，24 小时有效、只能用一次，数据库里只存散列。开发者用 `POST /v1/portal/password-reset` 或门户登录页自己设置新密码，运营者不再需要知道开发者的密码。
- **启动对账**：平台启用后，网关启动完成之后异步核对流水里仍为进行中的行。运行已经结束的按终态结算，运行已不存在的记为 `interrupted`，仍在进行的不动。不阻塞启动，重复执行结果不变。
- **控制台平台页**：新增「用量」区块（近 30 天按天、按智能体、按账号）；开发者一行的操作里可以生成重置码；密钥对话框的权限里新增「充值（billing）」。
- **英文开发者指南**（当时是单独的 `docs/platform.en.md`，现已并入英文版 [docs/platform.md](docs/platform.md)）。
- **错误码** `reference_conflict`（409）。

### 变化

- 平台的用量统计改为数据库聚合，数值不变；`GET /v1/platform/usage` 的 `by_account` 最多返回消耗最高的 50 个账号。
- 权限取值新增 `billing`，配置与 `POST /v1/keys` 都接受。
- `invalid_code` 的含义扩展到重置码：重置码错误、过期、已用过或邮箱不存在时，也返回 400 `invalid_code`。

### 修正

- 重置密码对话框生成重置码后，结果页的副标题不再显示「选一种做法」的提示。

### 升级须知

- **错误目录变化**：`GET /v1/errors` 的目录内容与修订号因新增 `reference_conflict` 与 `invalid_code` 的说明而变化，未启用平台的部署也一样。按 `code` 分支的客户端无需改动；按修订号做缓存的，需要重新拉取一次。
- 启用平台时新增两张表 `platform_references`、`platform_reset_codes`，`SCHEMA_VERSION` 仍为 4。旧版网关打开这个库时会忽略这些表。

### 限制

- 仍然没有支付渠道与邮件：重置码要由运营者经其它渠道交给开发者，没有邮箱验证。
- 单网关 + SQLite，不支持多实例与 Postgres。
- 启动对账会扫描流水里仍为进行中的行，流水很多时启动后的这一步会慢一些（它不阻塞启动）。

### 验证

全量测试 620 项通过（其中离线 452 项）；在本机隔离网关上用本地确定性模型实测了充值专用密钥的权限边界、单号去重、重置码、任务记录与试用台。启动对账只有进程内测试。没有调用真实模型，没有在公网部署上验证。

## 0.4.0（2026-11-12）

这一版是「开发者平台」：网关可以作为面向开发者的 Agent API 平台对外提供。开发者自助注册、自己建密钥、调用运营者上架的智能体，按点数结算。分发的是智能体，不做订阅池，也不中转登录态；与模型中转平台的区别见 [docs/zh-CN/platform.md](docs/zh-CN/platform.md#定位)。不配置 `platform` 段时，除本节列出的变化外，行为与 0.3.0 相同。

### 新增

- **`platform` 配置段**：配置后启用开发者平台，字段与默认值见 [docs/zh-CN/platform.md](docs/zh-CN/platform.md#启用)。未配置时不建表、不注册路由，`/health` 的 `features` 不变。
- **开发者账号与门户会话**：注册方式由 `registration` 决定（`closed`、`invite`、`open`），支持登录与改密码。门户会话（`oas_…`）只用于 `/v1/portal/*`。密码用 scrypt 存储；注册与登录按来源 IP 与邮箱限流。
- **账号密钥**（`oaa_…`）：同一账号的多把密钥共享运行、文件与记忆，不同账号之间互相隔离。权限固定为 `invoke`、`read`、`files`；只能调用上架且启用的智能体；执行等级只能是 `workspace` 或 `sandbox`。
- **智能体上架与定价**：运营者把 `platform.owner` 名下已发布的智能体上架，设置标题、简介、标签，以及按次与按千 token 的价格（各 0 到 1000 点）。下架保留记录，移除则删除记录。
- **点数、流水、兑换码与邀请码**：点数是中性的记账单位（1 点 = 1,000,000 微点），由运营者通过兑换码、邀请码或手动调整发放。每次变动记一行流水；兑换码只存散列，明文只返回一次。
- **计费**：提交前检查余额，不足返回 402 `insufficient_balance`；运行开始时登记流水，结束时按实际结果结算；同一运行重复结算只补差额，不会重复扣费。规则见 [docs/zh-CN/platform.md 的计费规则](docs/zh-CN/platform.md#计费规则)。
- **接口**：门户接口 `/v1/portal/*`；运营者接口 `/v1/platform/*`，需要 owner 级管理员密钥，只在控制台域名上可用。`GET /openapi.json` 在启用平台时包含这两组路由。
- **开发者门户 `/portal/`**：中文为主，可切换英文。
- **控制台「开发者平台」页**：概况、上架与定价、开发者、兑换码四个区块。
- **审计码**：`platform_credit_adjusted`、`platform_account_status`、`platform_password_reset`。记录不含密码、备注原文与兑换码。
- **错误类别 `platform`**：12 个错误码，见 [docs/zh-CN/protocol.md「错误码」](docs/zh-CN/protocol.md#错误码errorcode)。
- **`/health` 特性 `platform-v1`**：启用平台时出现在 `features` 中。
- **文档**：新增 [docs/zh-CN/platform.md](docs/zh-CN/platform.md)；`README.en.md` 增加开发者平台一节。
- **外部智能体可在发布时设为自动批准**（`approvals: "auto"`，缺省 `ask`）：它运行中的权限请求不再进入 `requires_action`，由策略直接批准并留下记录（审批记录 `response: { auto: true }`，事件 `approval.resolved` 的 `actor: "policy:auto"`）；超大审批详情仍被拒绝。入口：`POST /v1/agents/publish-native` 的 `approvals`、CLI `publish-native` / `expose` 的 `--approvals ask|auto`、OAA-Lang 的 `approvals = auto`、控制台发布对话框的开关。内核智能体写 `auto` 报校验错误；不写时定义与摘要不变。`GET /v1/agents` 与概览的条目对这类智能体带 `approvals: "auto"`；发布或更新这类智能体写审计记录 `approval_policy_auto`。`/health` 的 `features` 增加 `approval-policy-v1`。**风险**：调用方以你在这台机器上的权限驱动这个智能体，请配合专用且限定智能体的 API 密钥，必要时用沙箱执行等级。见 [docs/zh-CN/protocol.md](docs/zh-CN/protocol.md#approval-policy-for-external-agents-approval-policy-v1)。

### 修正（真实联调发现，见 [docs/zh-CN/evidence.md](docs/zh-CN/evidence.md)）

- **Claude Code 失败时带出原因**：结果消息的文本（或 `errors`）脱敏、限长 240 字符后写进错误消息；能识别为未登录（`not logged in`、`please run /login`、`invalid api key`、`authentication`）时报 `adapter_auth_required`（503），其余仍是 `native_incomplete`（502）。
- **桥接回合里对调用方工具的权限请求自动放行**：ACP 智能体对中继 `oaa-caller` 提供的工具发 `session/request_permission` 时直接允许一次，不再创建 owner 审批（无人值守时原来会卡住），记进度 `permission_auto_allowed`；智能体自带工具照旧走 owner 审批。见 [docs/zh-CN/harness.md](docs/zh-CN/harness.md#外部智能体的桥接是怎么工作的)。
- **ACP 全零用量按未知处理**：`PromptResponse.usage` 三项全为 0 时不再记成 0 个 token，运行的 `usage` 为 null、`oaa.usage_complete` 为 `false`，Chat 响应不带 `usage`。

### 升级须知

- **错误目录变化**：`GET /v1/errors` 的目录内容与修订号因新增平台错误码而变化，未启用平台的部署也一样。按 `code` 分支的客户端无需改动；按修订号做缓存的，需要重新拉取一次。
- **`GET /v1/me` 的新字段**：账号密钥调用时，响应多一个 `account: { id, balance }` 字段；其它密钥的响应不变。
- `/health` 的 `features` 增加 `approval-policy-v1`（所有部署）；启用平台时另有 `platform-v1`。

### 限制

- 单网关 + SQLite，不支持多实例与 Postgres。
- 不接支付渠道，不发邮件：没有邮箱验证与自助找回密码，密码由运营者重置。不做多个发布者各自结算。
- 限流计数在内存里，重启后清零。网关在反向代理后面时必须开启 `trustProxy`，否则所有访客共用同一个计数。
- 外部智能体可能不报告 token，此时只有按次价格生效，token 数不是费用估算。

### 验证

全量测试 602 项通过（其中离线 434 项）；在本机隔离网关上用本地确定性模型走通了上架、注册、兑换、建密钥、三种协议调用与扣费。没有调用真实模型，没有在公网部署上验证。

## 0.3.0（2026-11-11）

### 新增

- **ACP 外部智能体的调用方工具桥接**（`X-OAA-Client-Tools: bridge`）：调用方工具经 stdio MCP 中继 `oaa mcp-relay`（服务名 `oaa-caller`，本机 Unix 域套接字，0600，一次性令牌，不监听网络端口）交给 ACP 智能体；智能体调用时以标准的 `tool_calls` / `function_call` / `tool_use` 交给调用方，回传后同一个运行接着做。等待期间内层进程保持存活；网关重启会中断这类运行。见 [docs/zh-CN/harness.md](docs/zh-CN/harness.md#外部智能体的桥接是怎么工作的)。
- 新事件 `run.awaiting_caller`（`data: { approval_ids }`）：外部智能体的桥接运行在等调用方时发出，同一时刻的并行调用合并成一次。
- 节点特性 `client-tools-v1`：执行机器上报 `execution.clientTools.native`（支持桥接的引擎）；桥接运行只放到声明了支持的执行机器上，没有时提交阶段报 `client_tools_bridge_unsupported`（400）。内核智能体的桥接运行同样按这个特性放置（0.2.0 是到执行时才报 `manifest_mismatch`）。
- `/health` 的 `features` 增加 `harness-bridge-acp-v1`；ACP 接入的画像 `client_tools` 改为 `bridge`。

- 请求列表与概览的行新增可选字段 `waiting_on`（`caller` / `owner`）：区分「等待调用方执行工具」与「待审批」。控制台相应显示「等待调用方」，详情里单列待处理的调用，时间线新增「调用方执行工具」段，「调用地址」页新增「调用方自己也是智能体时」小节。见 [docs/zh-CN/console.md](docs/zh-CN/console.md)。
- 调用方工具中继在等待期间按 MCP 的进度通知保活（智能体的 MCP 客户端给了 progressToken 时）；智能体放弃某次调用后，对应步骤以 `client_tool_abandoned` 结束，不再挂到超时。
- OAA-Lang：流程表达式里的 `input` 与 `$input` 等价（如 `when $(input.limit > 0)`）。

### 工程

- `web/run-inspector.js` 按职责拆分为入口加 3 个模块。

### 升级须知

- 不带 `tools`、或不请求 `bridge` 的请求，交给 ACP 智能体的 `mcpServers` 仍是 `[]`，线上字节不变。
- 0.2.0 的远程执行机器不声明 `client-tools-v1`：它们不再接收任何桥接任务（包括内核智能体的）。需要桥接时请升级执行机器。
- 没有对真实 ACP 智能体联调；`mcpServers` 条目的字段形状依据 ACP 规范的公开描述。 （2026-11-11 更新：已对本机 agy 1.5.5 的 ACP 入口用 Gemini 3.8 Flash 做过一次真实联调，托管与桥接各一次调用均通过，`mcpServers` 的 stdio 条目形状被接受；并行调用、流式、慢回传与其它 ACP 智能体仍未验证。）

## 0.2.0

这一版是「架构统一升级」：源码分层、内核与接入层收口、调用方工具桥接、错误 / 事件 / 限额目录、OAA-Lang 变严格、控制台术语统一。

### 升级须知

可能影响现有使用者的变化：

- **OAA-Lang 变严格**：以前「碰巧能编译」或会崩溃的写法现在会报错，例如单值属性重复声明、`delegate` 块里拼错的键、修饰与类型不符、名为 `input` 的步骤、`route r null`、超出范围的数字。常量不再替换工具名与键名。合法程序的编译产物不变，`oaa fmt` 的输出有变化。逐条对照见 [docs/zh-CN/language.md「升级说明（0.2.0）」](docs/zh-CN/language.md#升级说明020)。
- **Gemini 兼容接口带 `tools` 时的行为**：原来静默丢弃 `tools`，现在按托管 / 拒绝模式处理（默认托管，响应头 `X-OAA-Client-Tools: ignored`）；请求 `bridge` 报 `client_tools_bridge_unsupported`。见 [docs/zh-CN/harness.md](docs/zh-CN/harness.md)。
- **远程执行机器需要升级才能运行桥接请求**：执行机器比对智能体定义时要放行尾部的合成绑定，旧版执行机器会拒绝带调用方工具的副本。
- **进度事件新增字段**：外部智能体的进度事件经入口约束（字段白名单、字符串截断），并新增 `source: "agent"` 等字段；只增字段不改名。见 [docs/zh-CN/adapters.md](docs/zh-CN/adapters.md#外部智能体事件的入口约束2026-11-11)。
- **新接口 `GET /v1/errors`**：错误目录（需要 `read` 权限，带 ETag）；`/health` 的 `features` 增加 `error-catalog-v1`、`client-tools-policy-v1`、`harness-bridge-v1`。
- **关闭时挂起的运行的错误码**：网关关闭时仍在挂起的运行，错误码统一为 `shutting_down`。
- **没有变化的部分**：存储结构（schema v4）与节点线协议没有变化；不带 `tools` 的兼容请求，线上字节与此前一致。

### 新增

- 双层 Harness：兼容接口带非空 `tools` 时按 `managed`（默认）/ `reject` / `bridge` 处理，用请求头 `X-OAA-Client-Tools` 或 `metadata["oaa.client_tools"]` 选择；画像新增 `client_tools`。见 [docs/zh-CN/harness.md](docs/zh-CN/harness.md)。
- 调用方工具桥接：内置内核智能体在 Chat Completions（`tool_calls`）、Responses（`function_call` / `function_call_output`）与 Claude Messages（`tool_use` / `tool_result`）上把调用方工具交回调用方执行，回传结果后同一个运行接着做；Gemini 与 UAP/1 不支持桥接。
- 错误目录（238 条、11 个类别）、事件目录（31 个事件）与限额目录，错误目录通过 `GET /v1/errors` 对外提供。见 [docs/zh-CN/architecture.md 第 9 节](docs/zh-CN/architecture.md#9-三份目录错误事件限额)。
- 运行状态机：合法转移登记成表，存储层落盘前校验，非法转移报 `invalid_run_transition` 且不写入。见 [docs/zh-CN/architecture.md 3.2](docs/zh-CN/architecture.md#32-运行状态机)。
- OAA-Lang：agent 级属性同时接受 `=` 与 `:`，`network` 接受 `allowed_domains`，flow 里的 `$常量` 解析为常量的值，校验错误带源码位置；新错误码 `oaa_validation_error`。
- `docs/language.md` 重写为完整语法参考，其中的示例代码块由测试保证能编译且格式化幂等。
- 控制台：智能体详情新增「工具与模型」说明，发布方式随选项给出解释，可用性检查的原因显示中文。见 [docs/zh-CN/console.md](docs/zh-CN/console.md)。
- 新文档：[docs/zh-CN/harness.md](docs/zh-CN/harness.md)、[docs/zh-CN/engineering.md](docs/zh-CN/engineering.md)、[docs/zh-CN/operations.md](docs/zh-CN/operations.md)、[docs/zh-CN/README.md](docs/zh-CN/README.md)。

### 变更

- 委托步骤按子智能体的实际情况登记副作用等级：外部智能体与会继续委托的智能体是「影响未知」，重启后等人工确认，不再自动重跑。
- 备选智能体（`oaa.agent_fallback`）按真实可用性（执行机器、BYOK、沙箱条件）与完整的执行级别检查选取，不合格的候选被跳过。
- 「可换线路重试 / 不触发换人 / 结果按未知处理」三份错误码名单并入错误目录（`routeRetryable`、`fallbackExempt`、`uncertainWhenStarted`），`GET /v1/errors` 会带出这些标记。
- 调用方回传的工具结果写回对话时：能解析成 JSON 对象或数组就按值写回，否则按原字符串写回、不加引号。
- `oaa fmt` 保留 `let` 声明，多行说明输出三引号，连续的 `use builtin` 合并成列表；源码含注释时给出警告。
- 控制台术语按统一术语表替换（网关、执行机器、模型线路、内置内核、外部智能体、调用名称、关键路径、中位耗时 / P95 耗时），错误说明改为读取后端错误目录；去掉了前端自行猜测的「意图识别」徽标。
- `docs/architecture.md` 按主题重整为中文；README 重写，操作细节移入 [docs/zh-CN/operations.md](docs/zh-CN/operations.md)。

### 修复

- 委托：恢复后不再重复委托同一个子运行；子运行「结果未知」会传到父运行；并行委托不再突破 `maxActiveRuns`；父运行已不活跃的排队子运行以 `cancelled / parent_interrupted` 结束；委托超时报 `delegate_timeout`。见 [docs/zh-CN/architecture.md 3.7](docs/zh-CN/architecture.md#37-委托与子智能体一致性)。
- 准入队列去重，修掉了「换人重新排队后任务登记被旧任务的清理误删」的问题。
- `context_limit` 的文案与数值一致（2 MB）。
- 外部智能体：事件回调失败不再成为未处理的 Promise 拒绝；产物全部校验落盘后才标记步骤完成；Antigravity 只有能识别为拒绝的工具错误才报 `permission_denied`；超过 256 KiB 的审批详情直接拒绝。
- OAA-Lang：常量不再替换工具名（`let read_file = "write_file"` 后授予的仍是 `read_file`）；原来会抛 `TypeError` 的写法改为带位置的报错；默认提供方与声明顺序无关。
- 控制台：错误说明修正 `permission_denied` 与 `catalog_capacity`；密钥删除地址编码、停用图标、命令面板 `aria-expanded`、重绘时保留折叠区展开状态与滚动位置。

### 工程

- 全仓按 Prettier 统一排版，新增 `npm run format` / `format:check`。
- `src/` 按层分为 10 个目录，架构测试守住依赖方向、循环引用、文件行数与 `any` 数量（上限 0）。见 [docs/zh-CN/engineering.md](docs/zh-CN/engineering.md#2-目录分层与依赖规则)。
- 新增 `npm run test:offline`（不监听端口的测试）与 `npm run verify`（类型检查 + 排版检查 + 全量测试），CI 运行 `verify`；打开 `noImplicitOverride`、`noFallthroughCasesInSwitch`、`noImplicitReturns`。
- 纯重构：`lang.ts` 按职责拆成词法、解析、类型、流程、语句、编译、输出、诊断等文件；`web/console.js` 拆成原生 ES 模块，不引入构建步骤；`engines/` 的四种接入方式共用 `engines/shared.ts`；内核把委托、备选智能体链、记忆工具等移到独立文件。
- 依赖：移除不再使用的 `eventsource-parser` 直接依赖，`openai` 移到 `devDependencies`。

## 0.1.0

初始版本。
