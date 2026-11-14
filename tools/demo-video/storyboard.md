# 演示视频分镜

总长 58.4 秒，1920×1080，30 fps，无配音，画面自解释。中文为主，每屏下方配一行小号英文。浅色纸底（与展示页一致），
色板、字体、圆角、细线全部取自产品的 `web/shared/tokens.css`：墨与纸为底，潮（蒂芙尼绿）只用来标「改过的行」
「当前所在」，朱砂只出现在控制台截图里的「待审批」。切镜一律是淡出再淡入，不用转场花样；每屏只有一个重点。

文案与仓库地址都在 `copy.json`，下表的字幕以它为准（`{agent}` 是录制时的智能体名称）。

## 分镜表

| # | 镜头 | 时间 | 时长 | 画面 | 字幕（中文 / 英文） | 素材来源 | 诚实标注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 开场 | 0.0–3.4 | 3.4 秒 | 标志（O 与 A 互扣）由三笔单线依次描出，然后淡入 Open Agent API 与一句话。 | 把智能体变成 API / Turn agents into APIs | `docs/brand/` 的标志几何 | 无 |
| 2 | 改一行 | 3.4–14.4 | 11 秒 | 编辑器里一段 openai SDK 代码（Node.js）。光标先选中 `baseURL` 的旧值、删掉、打出网关地址，再对 `model` 做同样的事；改过的两行淡绿亮起，旁边浮出「服务地址」「智能体的调用名」，其余行退到背景。 | 同一段代码，只改两处 / The same code. Only two things change. | 代码文本取自 `recording.json` 的 `code`，就是 `record.mjs` 实际执行的那一段 | 画面里的网关地址写产品默认端口 8787；录制时实际监听的是随机端口（记在 `gateway.actual_port`）。`apiKey` 仍读 `OPENAI_API_KEY`，换成 `sk-oaa-` 密钥在下一镜的命令里体现（已遮蔽成 `sk-oaa-…`） |
| 3 | 真实调用 | 14.4–26.4 | 12 秒 | 终端里逐字打出 `OPENAI_API_KEY=sk-oaa-… node todo.mjs`，回车后底栏计时，回答出现；下方四个小标签：智能体、耗时、用量、任务 ID。 | 真实调用：本机的 Antigravity 智能体 / A real call to the Antigravity agent on this machine（占位素材：本版的智能体是本地替身 / Placeholder cut: the agent here is a local stand-in） | `recording.json` 的 `calls.openai`：真实回答全文、耗时、`usage`、运行 ID | 右下角：「真实录制」标签（占位素材时改为「占位素材 · 模型为本地替身」）；耗时说明「实际耗时 X 秒，画面已加速」，真实耗时不超过 4.5 秒时只写「实际耗时 X 秒」。等待最多压缩到 4.5 秒，计时器照真实耗时走，到回答出现时恰好走完。回答是非流式的，所以整段一次出现，与真实终端一致 |
| 4 | 不是模型，是任务 | 26.4–36.4 | 10 秒 | 控制台「任务」列表（三个真实调用各一行）；光标点开分镜 3 那次调用对应的一行，打开任务检查器：时间线、时间花在哪、输出。缓慢推近。 | 不是模型，是任务 / Not a model call. A task you can inspect. | 控制台真实前端的截图，数据是同一次录制导出的接口快照（`snapshots.tasks`）。光标与推移是后期叠加 | 右下角同分镜 3 的标签；占位素材时标「占位素材」 |
| 5 | 人在回路 | 36.4–48.4 | 12 秒 | 控制台概览出现「1 个任务等待你审批」；点「去审批」打开任务，待审批卡片里是智能体要写 `note.txt` 的请求；光标移到「批准」点下；画面切到同一个任务的完成状态，时间线上橙色的「等待审批」一段占了大半。 | 任务停在“待审批”，等你批准 / The task pauses at “awaiting approval”. → 批准之后，同一个任务接着做完 / Approve it, and the same task carries on. | 控制台真实前端的截图，数据是 `snapshots.approval_pending` 与 `approval_done`；任务由 `test/fixtures/acp-live-agent.mjs`（仓库里的假 ACP 智能体）驱动 | 整镜右下角：**此段模型为本地替身；审批流程为产品真实行为**（The model in this segment is a local stand-in; the approval flow is real product behaviour.）。真实智能体引擎目前不支持审批桥接，所以这一镜无论哪种录制都是替身。录制时在待审批上停了 2 秒再批准，时间线上的等待因此看得见，那是真实的等待。审批段是单独跑的（网关里只有审批演示智能体），所以列表里只有这一个任务 |
| 6 | 三家协议 | 48.4–54.0 | 5.6 秒 | OpenAI、Claude、Gemini 三行调用依次亮起；每行下面只写调用方式（官方 openai SDK、官方 `@anthropic-ai/sdk`、线上格式的 HTTP 请求）、这次调用真实得到的 HTTP 状态、耗时与 token 用量。**不显示回答正文**：真实智能体的回答可能很长，还可能带它自己生成的文件链接，不适合上镜。 | 三家协议原样兼容 / OpenAI, Claude and Gemini protocols, as they are | `calls.openai`、`calls.anthropic`、`calls.gemini`：官方 `openai` SDK、官方 `@anthropic-ai/sdk`，Gemini 是线上格式的直接 HTTP 请求（不是 SDK，画面上写明） | 右下角同分镜 3 的标签。用量一栏：OpenAI 取 `total_tokens`，Gemini 取 `totalTokenCount`，Claude 只有输入与输出两项，画面上写二者之和 |
| 7 | 收尾 | 54.0–58.4 | 4.4 秒 | 标志、名称、仓库地址、许可证，随后淡出到纸色。 | Apache-2.0 开源 / Open source under Apache-2.0 | `copy.json` 的 `repo_url`（占位地址，集中在这一处） | 无 |

## 节奏

- 每镜首尾各有约 0.4 秒淡入淡出；镜内的文字、光标、推移都是时间的纯函数（见 `README.md`）。
- 分镜 2 的两处编辑各占约 2.5 秒，其余留给读；分镜 3 在回答出现后留 4.5 秒给人读；分镜 5 的批准动作在第 6.5 秒点下，
  前面是看清「等你批准」，后面是看到「接着做完」。
- 只出现一个光标，只在分镜 4、5 里出现；编辑器里的是文本光标（潮绿色细竖线）。

## 真实与替身一览

| 内容 | 真实录制（`--agent antigravity`） | 占位素材（`--agent fixture`） |
| --- | --- | --- |
| 分镜 3 的命令输出、耗时、用量 | 真实智能体的一次调用 | 本地替身（`placeholder-agy.mjs`）的固定回答，画面标「占位素材」 |
| 分镜 4 的任务列表与检查器 | 真实调用产生的任务记录与时间线 | 同上，来自替身的调用，画面标「占位素材」 |
| 分镜 5 的审批流程 | 本地替身驱动，审批机制是产品真实行为 | 同左 |
| 分镜 6 的三行调用的状态、耗时、用量 | 真实调用得到的 | 替身调用得到的，画面标「占位素材」 |

## 控制台截图的两处处理

- 右上角的「更新于 HH:MM」与审批卡片里的「到期」时刻：回放时把快照里所有时间整体平移到本地时间 10:00，相对时间（「刚刚」「已运行 8.5 s」）不变，录制时的本机钟点不会上镜。
- 检查器标题里过长的任务 ID（`resp_` 加 32 位）与审批卡片里的审批 ID 在回放页里自然截断，不成为画面焦点。这是回放页的样式，产品本身不变。

## 不该上镜的内容

任何 `file://` 链接、`~/` 开头的路径、本机绝对路径一律不出现在画面里：`record.mjs` 导出时遮蔽（换成「（本机路径已遮蔽）」），
渲染时再兜底检查（页面文字与每一张控制台截图的可见文字），命中就拒绝渲染并指出是哪一镜、哪段文字。

## 英文版（`render.mjs --lang en`）

分镜、时间轴与画面构成与中文版相同；文案在 `copy.en.json`，每屏只有一行主文案（英文标题字体，与产品英文界面一致），不再有「中文加小号英文」的两行。

| # | 镜头 | 主文案 |
| --- | --- | --- |
| 1 | 开场 | Turn agents into an API.（小字：You call an agent, not a model.） |
| 2 | 改一行 | The same code. Two values change.（标注：Your gateway / The agent to call） |
| 3 | 真实调用 | A real call to the Antigravity agent on this machine（占位素材：Placeholder cut: the agent here is a local stand-in） |
| 4 | 任务 | Not a model call. A task you can inspect. |
| 5 | 人在回路 | The task stops and waits for your approval. → Approve it, and the same task carries on. |
| 6 | 三家协议 | OpenAI, Claude and Gemini protocols, unmodified. |
| 7 | 收尾 | Open source under Apache-2.0 |

诚实标注逐条对应：Recorded for real / Placeholder cut · the model is a local stand-in / Actual time X s; the wait is sped up /
The model in this segment is a local stand-in; the approval flow is real product behavior.
用英文提示词重新录制后，终端回答、示例代码与控制台里的任务内容也是英文；在那之前（用中文录制渲染的草稿）这些真实内容保持中文原样。
