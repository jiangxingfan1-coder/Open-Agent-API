# 图片输入

[English](../images.md) · 简体中文

「把截图发给智能体」是最常见的用法之一。Open Agent API 在三种兼容协议和自己的入口上都接受图片：先检查，再作为调用方的输入文件保存，然后按智能体真正能用的方式交给它。不能处理图片的智能体会在创建运行之前就清楚地拒绝；图片不会被悄悄丢掉。

这项能力在 `GET /health` 的 `features` 里声明为 `image-input-v1`。

## 能发什么

| 入口 | 图片内容段 | 内联字节 | https URL | 已上传的文件 |
| --- | --- | --- | --- | --- |
| OpenAI Chat Completions（`/v1/chat/completions`、`/v1/compat/...`） | `{"type":"image_url","image_url":{"url":…,"detail":…}}` | `data:image/png;base64,…` | `https://…` | （用 Responses 或 `file` 内容段） |
| OpenAI Responses（`/v1/responses`、`/v1/compat/responses`） | `{"type":"input_image","image_url":…}` 或 `{"type":"input_image","file_id":…}` | `image_url` 里写 `data:` URL | `image_url: "https://…"` | `file_id` |
| Claude Messages（`/v1/messages`） | `{"type":"image","source":…}` | `source.type: "base64"`，带 `media_type` 与 `data` | `source.type: "url"` | `source.type: "file"`，带 `file_id` |
| Gemini `generateContent` | `inlineData` / `fileData` | `{"inlineData":{"mimeType":"image/png","data":…}}` | `fileData`，`fileUri` 为 `https://`，`mimeType` 为 `image/*` | `fileData`，`fileUri: "oaa://files/<id>"`，`mimeType` 为 `image/*` |
| UAP（`/v1/uap`） | `content` 里的 `{"type":"image",…}`（或 `input_image`） | `data` + `media_type` | `url` | `file_id` |
| OAA 原生请求体（`agent` + `input`） | 顶层 `images: [...]` | `{"data":…,"media_type":…}` | `{"url":…}` | `{"file_id":…}` |

`detail` 会被接受并忽略。图片可以先用 `POST /v1/files`（或 `oaa upload`）上传一次，之后在任意多个请求里按文件 ID 引用。Gemini 的 `inlineData` 如果不是图片（音频、PDF），仍然报 `unsupported_content`。

智能体看到的文本里，图片原来的位置留一个 `[Image #1]` 这样的标记；图片字节不会进入提示词文本、运行事件、时间线或日志。

## 检查与上限

每张内联图片在创建运行之前解码一次：

- 标准与 URL 安全两种 base64 字母表都接受，补位可有可无（`google-genai` 发的是 URL 安全的）。
- 先比较 base64 字符串的长度与上限，**再**解码，超大的 `data:` URL 拒绝时几乎没有开销。
- 真实格式从字节判断，只接受 PNG、JPEG、GIF、WebP。声明的类型（`media_type`、`data:` 头、`mimeType`）必须与字节一致（`image/jpg` 视同 `image/jpeg`），不一致报 `image_invalid`。
- 按图片引用的已上传文件必须对调用方可见，并且是上述格式之一。

| 配置项（网关配置里的 `images.*`） | 缺省 | 范围 | 错误 |
| --- | --- | --- | --- |
| `maxImageBytes`（单张，解码后） | 5 MiB | 1 KiB – 8 MiB | `image_too_large`（413） |
| `maxImagesPerRequest` | 10 | 1 – 20 | `too_many_images`（400） |
| `maxTotalBytes`（一次请求的全部图片） | 8 MiB | 1 KiB – 8 MiB | `image_too_large`（413） |
| `fetchRemote`（网关代取 https 图片 URL） | `false` | | |
| `fetchTimeoutMs` | 10 000 | 500 – 60 000 | `image_fetch_failed`（400） |

整个请求体仍受 24 MiB 上限约束，一次运行的输入文件合计仍受 8 MiB 上限约束。错误在 `error.param`（OpenAI 入口）里指出具体的内容段，例如 `messages.0.content.1`；各协议的错误体形状不变。

## 存储与隐私

对于新建的隐式上传，网关在写图片内容前，先在 SQLite 里登记文件 ID、调用方和独占创建的文件身份。
运行或工作流持久引用该文件时，同一笔事务解除回收权。进程重启后分批清理确实未被认领的输入；写到一半、
已删除目录记录但尚未删除磁盘文件，也能继续。写锁繁忙会推迟清理。普通上传、没有归属证据的旧文件，
以及身份不符的替换文件均保留，不按文件名或内容相同来猜测。

配置每调用方存储上限时，JSON 上传、multipart 上传和新建内联图片都在写内容前，以同一 SQLite 写锁预留字节。
写入中的字节只计一次，发布文件时转成实际用量。普通上传在自身元数据提交时就被接受，不需要运行认领。
同一 owner、同一调用方的相同内联图片可以并发复用一次落盘，每个请求仍须通过自己的授权和运行准入。
智能体产物计入使用量，但不会因该上限而失败；无法核实的用量不视为零。

内联图片成为调用方的输入文件：与 `POST /v1/files` 同一套文件存储、访问控制和每调用方存储配额（`maxStoredBytesPerSubject`，超出报 `storage_quota_exceeded`）。别的调用方读不到，也引用不了。调用方已经存过完全相同的字节时直接复用那个文件，所以每次都重发整段历史的聊天客户端不会把同一张图存很多份，带幂等键的重试也得到同一个请求。请求在创建运行之前被拒绝时（例如智能体不接受图片），这次请求新存的文件会被删掉，调用方的存储用量不会增加；复用的旧文件保留。

`GET /v1/runs/{id}/state` 与 `GET /v1/runs/{id}/timeline` 列出运行带的图片（`images: [{kind:"file", file_id, name, mime, bytes}]`；URL 图片只给主机名）。控制台任务检查器显示「这次任务带了 N 张图片」及文件名、大小与缩略图；缩略图取自受鉴权的文件下载接口（`GET /v1/files/{id}/content`），经 `blob:` URL 显示。事件回调的载荷里不带图片内容。

## URL：默认不替调用方抓取

让网关去抓任意地址，等于让任何调用方都能叫网关连接任何地方。所以默认：

- `https` 图片 URL **原样**转交给模型提供方，而且只在智能体是内置内核智能体、所选线路接受图片 URL 时（见下文的提供方表）。由提供方去取，网关不取。
- 其他情况（外部智能体需要字节；Gemini 线路不收 URL）报 `unsupported_content`，文案说明「请改用内联数据或先上传」。
- 普通 `http`、带用户名密码的 URL，以及 `https` / `data:` 以外的地址报 `image_invalid`。

开启 `images.fetchRemote: true` 后，网关自己抓取所有图片 URL，结果按内联图片处理。此时只允许 `https`、不跟随重定向、读取时执行 `fetchTimeoutMs` 与 `maxImageBytes`、要求图片类的 `Content-Type` 且与探测出的格式一致，并且在 `security.profile: "public"` 下拒绝私网、回环、链路本地与云元数据地址。这套地址规则就是事件回调的规则，检查的是实际连接的地址（只解析一次，在连接自己的 lookup 里检查）。

## 各类智能体怎样拿到图片

执行机器在 `image-input-v1` 下声明能否收图片：按内核的模型提供方、按外部引擎分别声明。转换档案（`conversion.image_input`）和 `GET /v1/models`（`image_input: true|false`）都能看到，调用方可以事先判断。

| 智能体 | 图片怎样到达 | `conversion.image_input` | 验证情况 |
| --- | --- | --- | --- |
| 内置内核智能体 | 放进用户消息，按线路提供方自己的形状：OpenAI Responses `input_image`、Chat Completions `image_url`（data URL 或 https URL）、Anthropic `image`（`base64` 或 `url` 来源）、Gemini `inlineData` | `route` | 测试里的夹具模型（回显收到的图片） |
| 声明 `promptCapabilities.image` 的 ACP 智能体 | 文本之后的 ACP `image` 内容块（`mimeType`、base64 `data`），同时有工作目录文件 | `agent-declared`（握手检查后为 `native`） | ACP 测试替身 |
| 未声明图片能力的 ACP 智能体 | 工作目录文件（见下）；适配器设 `imageFiles: false` 时改为拒绝 | `agent-declared` / `workspace-file` | ACP 测试替身 |
| Claude Code（Agent SDK） | 提示词改为一条流式用户消息，内含 Anthropic `image` 块（base64） | `native` | 只按文档实现，未用真实智能体验证 |
| Codex（app-server） | `turn/start` 的输入项在文本之后加 `{"type":"localImage","path":…}` | `native` | 只按文档实现，未用真实智能体验证 |
| Antigravity、DSH、stdio `oaa/1` 适配器 | 工作目录文件 | `workspace-file` | Antigravity 与 DSH：只按文档行为 |
| A2A 远程智能体、HTTP `oaa/1` 适配器 | 拒绝（`unsupported_content`）：它们只收文本 | `none` | 测试 |

**工作目录文件回退。** 图片文件写进任务工作目录的 `inputs/<文件编号>/image-<n>.<扩展名>`（文件名由网关生成；会跑出工作目录的路径一律拒绝），交给智能体的输入末尾附一段列表，例如 `[Image #1] inputs/file_…/image-1.png (image/png)`。智能体用自己的工具去看。

### 内核线路与提供方的图片能力

模型提供方声明 `imageInput`：`none`、`inline`（字节）或 `url`（字节和 https URL）。不写时按类型取保守的缺省值：

| 提供方 `kind` | 缺省 `imageInput` |
| --- | --- |
| `openai-responses` | `url` |
| `anthropic-messages` | `url` |
| `gemini-generate` | `inline` |
| `openai-chat` | `none`（很多兼容服务只收文本；视觉模型请设为 `inline` 或 `url`） |

提供方收不了这次请求的图片的线路，不参与这次请求的选路；智能体的所有线路都不行时，请求报 `unsupported_content`。

## 续接

- `previous_response_id`：内核智能体的历史里保存图片的**引用**；模型本身无状态，所以历史图片在之后每一轮都会再发给模型，但不会再存一份。外部智能体自己的会话已经看过图片，只附上新一轮的图片。
- 多轮 `messages` / `contents` 里早先轮次带图片：请求里的每张图片都属于这次请求，都会发送；相同字节复用已保存的文件（不存第二份）。

## 远程执行节点

图片作为运行的输入文件随任务发到远程节点，与其他输入文件一样。节点必须声明 `image-input-v1`（网关提供这项特性之后，节点才在广告里带上自己的图片声明）；旧版本节点永远不会被选去执行带图片的运行，所以拒绝发生在派发之前，而不是执行时。

## 验证状况

| 路径 | 状况 |
| --- | --- |
| 内核线路（四种提供方形状）、ACP 图片块与工作目录文件回退、远程节点、调用方工具（auto 桥接）与结构化输出修复轮 | 离线测试里用确定性夹具实跑 |
| 官方 SDK 与聊天客户端回放 | 兼容性实验室里对夹具智能体实跑 |
| Claude Code（Agent SDK 图片块） | **只按文档实现，未用真实智能体验证。** 未消除的风险：带图片时提示词改为只含一条用户消息的流式输入，SDK 在这一条消息之后能否正常结束会话没有验证 |
| Codex（`turn/start` 的 `localImage` 输入项） | **只按文档实现，未用真实智能体验证** |
| Antigravity、DSH | 工作目录文件回退；未用真实智能体验证 |

Claude Code 或 Codex 的某一轮失败、而这一轮带了图片时，错误码不变，文案里补上「这一轮带了 N 张图片、以什么形式发送、这条图片路径只按文档实现」，用户能看出是不是图片交付这一步的问题。工作目录里缺图片文件时报 `image_delivery_failed`。
