# 演示视频：录制与渲染

两步：`record.mjs` 在本机录一次素材（`recording.json`），`render.mjs` 把素材渲染成视频。分镜见 [storyboard.md](storyboard.md)。
有中文版与英文版两个成片（`--lang zh|en`，见下面「英文版」一节）。
这个目录不属于产品，不随发布包分发。

## 一、录制素材

先编译（录制脚本读 `dist/` 下的编译产物，与 `examples/live-agents-acceptance.ts` 用同一套内核）：

```sh
npm run build
```

**真实录制**（运行真实智能体，会产生费用）：

```sh
node tools/demo-video/record.mjs \
  --agent antigravity \
  --executable "$(command -v agy)" \
  --model gemini-3.8-flash-low \
  --out /path/to/NEW_DIR \
  --confirm-live-cost
```

- 真实智能体最多 **3 次调用**，不自动重试：官方 `openai` SDK、官方 `@anthropic-ai/sdk`、Gemini 线上格式各一次。任何一次失败，
  后面的真实调用就不再发（避免白花钱），错误写进 `recording.json` 的 `problems`，退出码为 1。
- 审批那一段另有 1 次调用，但对象是仓库里的假 ACP 智能体，不产生费用。
- `--out` 必须是不存在的新目录；`--confirm-live-cost` 对真实智能体必填。
- `--lang zh|en`（默认 zh）：提示词集的语言，见「英文版」。
- `--native-env allowlist`（默认）只把基础环境变量交给智能体子进程；如果 agy 在这种模式下找不到登录状态，
  改用 `--native-env inherit`（与 `live-agents-acceptance` 的默认一致，但会把除 `OAA_*` 外的环境变量都交出去）。
- `--call-timeout-sec`（默认 240）是每次调用的硬超时；`--agy-mode` 默认 `plan`，沿用 `examples/live-agents-acceptance.ts`。

**占位录制**（不产生费用，用来先跑通整条流水线）：

```sh
node tools/demo-video/record.mjs --agent fixture --out /path/to/NEW_DIR
```

占位录制与真实录制走**完全相同的网关配置**（`native.antigravity` 引擎、同样的参数与 `--model` 校验、同样的 `--native-env`），
唯一的差别是把 agy 可执行文件换成本目录的 `placeholder-agy.mjs`（说 agy 的 stream-json 协议，固定回答，会「想」
`--placeholder-delay-ms` 毫秒，默认 6500）。渲染出的画面会自动标成「占位素材」。

**只补录审批段**（不发起任何真实调用，不需要 `--confirm-live-cost`）：

```sh
node tools/demo-video/record.mjs --approval-only --merge /path/to/old/recording.json --out /path/to/NEW_DIR
```

只跑替身驱动的审批段，把结果与三份审批快照并入已有录制的副本，写到新目录，不改原文件；`problems` 里与审批有关的旧记录作废、
重新判定，`recording.json` 里多一个 `merged` 字段标明来源。审批段用的网关里只有审批演示智能体，所以控制台列表里只有这一个任务。

**自检**（不调用任何真实智能体）：

```sh
npm run build && node tools/demo-video/selfcheck.mjs
```

用 `--agent fixture --model gemini-3.8-flash-low`（与真实录制相同的模型参数）完整录一遍，检查三次调用、四份快照、审批从待审批到完成、
没有遗留子进程、没有路径与密钥；再用 `--lang en` 录一遍占位录制，检查语言标记、提示词与回答里没有汉字、示例代码每行放得进画面；再检查 `--approval-only` 补录（原文件不变、副本里审批段是新的、能修复「审批段失败」的旧录制）与遮蔽函数。

### 审批段为什么不用 `--model`

审批演示智能体是 ACP 适配器（`test/fixtures/acp-live-agent.mjs`），它在会话里不声明可选模型。网关对显式指定的模型要求智能体声明过，
所以只能发布成 `default`；若沿用主智能体的 `--model gemini-3.8-flash-low`，任务会立刻以 `model_not_supported`
失败，永远到不了「待审批」。第一版的 `record.mjs` 正是这样：占位录制默认模型是 `default`，没触发；真实录制传了
`--model gemini-3.8-flash-low`，审批段失败，等「待审批」超时。现在审批智能体固定发布成 `default`，等待时若任务提前结束会立刻报出网关给的错误码与说明，
而不是傻等。

两种录制都在进程内起一个只监听 `127.0.0.1` 随机端口的隔离网关，数据与工作目录都在 `--out` 下，
不读写用户真实的数据目录，不改任何代理或网络环境变量；结束后确认子进程已退出、端口已释放。

### `recording.json` 里有什么

| 字段 | 内容 |
| --- | --- |
| `lang` | 提示词语言：`zh` 或 `en`；旧录制没有这个字段（视为 `zh`） |
| `agent` | `real`（真实还是替身）、`kind`、智能体 ID 与显示名、请求的模型、可执行文件名 |
| `gateway` | 画面里展示的服务地址（产品默认端口 8787）与实际监听的随机端口 |
| `code` | 分镜 2 展示的那段代码（改前、改后），就是 `record.mjs` 里实际执行的那一段 |
| `calls.openai / anthropic / gemini` | 每次调用的请求摘要、完整回答、耗时、用量、运行 ID、HTTP 状态 |
| `approval` | 审批演示：任务提示词、待审批项、批准的决定、最终状态；`real: false` 永远成立 |
| `merged` | 只在 `--approval-only` 补录出的录制里有：来源与说明 |
| `snapshots` | 控制台前端读的接口响应：`tasks`（真实调用之后）、`approval_pending`、`approval_approved`、`approval_done`；每份含 `captured_at`（回放时冻结时钟）与 `routes` |
| `agent_invocations`、`child_processes`、`problems` | 调用次数、子进程回收情况、录制中出现的问题 |

快照里的密钥值（管理密钥、`sk-oaa-` 密钥）已遮蔽，本机路径替换成 `/demo`、`/repo`、`~`，网关地址统一写成 `127.0.0.1:8787`。
`file://` 链接、`~/` 路径与本机绝对路径会换成「（本机路径已遮蔽）」。导出前会再整体检查一遍（`sk-oaa-` 形状的值、`file://`、`~/`、`/Users/`、`/Volumes/`、`/private/tmp/` 等），命中就拒绝写出快照。

## 二、渲染

```sh
node tools/demo-video/render.mjs \
  --recording /path/to/NEW_DIR/recording.json \
  --out /path/to/OUT_DIR
```

输出到 `--out`：

| 文件 | 说明 |
| --- | --- |
| `demo.mp4` | H.264、yuv420p（BT.709）、1920×1080、30 fps；先用 CRF 20，超过 8 MiB 自动提高 CRF 重编 |
| `demo.webm` | VP9（`--no-webm` 可跳过） |
| `demo-poster.png` | 封面帧，取 `copy.json` 的 `poster` 指定的镜头与时间 |
| `demo.gif` | 给 README 用：「改一行 → 真实调用拿到回答」，宽 960、15 fps、调色板优化；超过 12 秒整体略微加速，超过 4 MiB 自动降帧率与色数（`--no-gif` 可跳过） |
| `render-report.json` | 各镜头的起止时间与帧数、各文件的体积与 ffprobe 信息 |

其他参数：

- `--lang zh|en`：成片语言，默认 zh；英文版的输出文件名带 `-en`（`demo-en.mp4` 等），中间产物默认在 `--out/.work-en`。
- `--work DIR`：中间产物目录，默认 `--out/.work`（英文版 `--out/.work-en`）。控制台截图、渲染页与逐帧 PNG 都在这里。
- `--jobs N`：并行的无头 Chrome 个数，默认 2–4。
- `--only open,edit`：指定的镜头无条件重画；其余镜头缓存有效就沿用。`--force` 全部重画。
- `--frame run:9.5,edit:10`：只把这几个时刻各截一张图到 `--work/preview/`，不合成，改版式时几秒就能看到。
- `--copy FILE`：用另一份文案（默认中文版 `copy.json`，英文版 `copy.en.json`）。

### 渲染是怎么做到确定、可重复的

- 每个镜头是 `scenes/sN-*.js` 里的一个纯函数 `render(t)`：给定镜内时间，把 DOM 摆成那一刻的样子。页面不读真实时钟，
  不用 CSS 动画或 transition，同一个 `t` 得到的画面相同。逐帧用无头 Chrome 的 `Page.captureScreenshot` 截下。
  实测：从零重画两遍，纯文字的镜头逐字节相同；带截图、阴影或透明度渐变的镜头个别像素有 ±1 级的差异（PSNR 在 98 dB 以上），
  肉眼无法分辨，编码后的视频不受影响。
- 无头 Chrome 通过 `--remote-debugging-pipe` 控制（继承的管道，不监听任何端口），页面全部是 `file://`，不联网。
- 不该上镜的内容：渲染页与每张控制台截图的可见文字都会过一遍 `lib/scrub.mjs` 的兜底检查（`file://`、`~/`、本机绝对路径、密钥形状），命中就拒绝渲染并指出镜头与文字。
- 控制台画面：`lib/console-shots.mjs` 把 `web/index.html` 里的绝对路径改写成 `web/` 的 file URL，注入 `scenes/console-replay.js`
  （替换 `fetch` 回放快照、冻结时钟并把快照里的时间整体平移到本地 10:00、预置假的连接令牌），再截图；过长的任务 ID 在回放页里自然截断。截到的是产品当前的真实界面，不是仿制品；
  `web/` 里的文件变了会自动重新截图。
- 按镜缓存：每镜的缓存键是「录制内容 + 文案 + 公共脚本与样式 + 本镜脚本」的摘要。改某一镜的脚本只重画那一镜；
  改 `copy.json` 或换录制则全部重画。整片约 1750 帧，本机 2–4 个 Chrome 并行约半分钟出帧；断点重跑时已完成的镜头直接沿用。

字体：Noto Serif SC、Instrument Serif、Geist、Geist Mono 都取自 `web/fonts/`（SIL OFL 1.1）。正文里的中文无衬线回退到系统的
PingFang SC，所以渲染要在 macOS 上做；换机器要保证有同样的中文字体，否则字形会不同。

## 三、英文版

英文版是同一条片子的另一个语言版本：分镜、时间轴、画面构成都一样，变的是文案、字体与控制台界面语言。

- **文案**在 [copy.en.json](copy.en.json)，形状与 `copy.json` 一致，只是每条文案是 `{ "en": 主文案, "sub": 可选的小号副文案 }`
  （中文版是大号中文加一行小号英文，英文版只有一行主文案）。定位语与 `README.en.md` 一致：开场是「Turn agents into an API.」加一行
  「You call an agent, not a model.」。
- **字体**：英文标题与字幕用 Instrument Serif（与产品英文界面的标题字体一致），小字用 Geist / Geist Mono；中文版仍是 Noto Serif SC。
  录制里原样保留的中文（真实问答）会带上 `lang="zh-CN"`，字形不会被英文环境换掉。
- **控制台画面**：回放页把 `oaa.console.lang` 设成 `en`，截到的是产品当前的英文界面。
- **标注**：「Recorded for real」「Placeholder cut · the model is a local stand-in」「Actual time X s; the wait is sped up」
  「The model in this segment is a local stand-in; the approval flow is real product behavior.」，与中文版一一对应，措辞同样如实。

渲染：

```sh
node tools/demo-video/render.mjs --lang en --recording /path/to/recording.json --out /path/to/OUT_DIR
```

### 英文版草稿与正式版

- **草稿**：用现有的中文录制渲染英文版。真实调用的提问和回答是中文的，**原样保留、不翻译、不改写**（那是录制内容，改了就是造假），
  所以草稿里代码、终端回答、控制台列表里的任务内容是中文，只有文案、标注与控制台界面是英文。草稿只用来检查版式、文案与节奏，不要对外发布。
  渲染时会在日志里提示「录制是中文的」。
- **正式版**：用英文提示词重新录制一次（会调用真实智能体，产生费用），再渲染。录制只要这一条命令，渲染一条命令：

```sh
npm run build
node tools/demo-video/record.mjs \
  --lang en \
  --agent antigravity \
  --executable "$(command -v agy)" \
  --model gemini-3.8-flash-low \
  --out /path/to/NEW_DIR_EN \
  --confirm-live-cost
node tools/demo-video/render.mjs --lang en --recording /path/to/NEW_DIR_EN/recording.json --out /path/to/OUT_DIR
```

  `--lang en` 换的是 `record.mjs` 里的一整套提示词（三次真实调用的提问、审批段的提问）、占位智能体与审批演示智能体的显示名、
  `recording.json` 里的说明文字，以及路径遮蔽后的占位文字（`(local path hidden)`）。三次真实调用仍是最多 3 次、不自动重试。
  录制时 `recording.json` 会写入 `lang: "en"`；中文录制没有这个字段（视为 zh）。
- 英文提示词：`Turn this into a P1/P2/P3 list, one item per line, no explanations: order coffee beans; send the quote by Friday; fix the login page bug`、
  `Introduce yourself in one sentence, under 12 words.`、审批段 `Create a file named note.txt …, containing exactly one line: RELEASE-OK. …`。
  提示词太长放不进一行时，画面里的示例代码会把它折成两段字符串（用 `+` 连接），中文版不受影响。
- 占位录制也支持：`record.mjs --agent fixture --lang en`（占位智能体按提示词的语言给固定回答），不产生费用，可用来检查英文版的版式。
- 审批演示用的假 ACP 智能体（`test/fixtures/acp-live-agent.mjs`）除了中文的「内容只有一行：X」，也认英文的 “containing exactly one line: X”。
- `--approval-only --merge` 补录审批段沿用原录制的语言，不接受 `--lang`。

## 四、替换文案与仓库地址

全部在 [copy.json](copy.json)（英文版在 [copy.en.json](copy.en.json)）：字幕、角标、仓库地址（`repo_url`，只出现在收尾一镜）、封面取哪一帧、GIF 取哪几段。
改完重新运行 `render.mjs` 即可。分镜的时间轴与版式在 `scenes/` 下各镜的脚本里；换一段演示的提示词在 `record.mjs`
顶部的常量（`TASK`、`SHORT_PROMPT`、`APPROVAL_PROMPT`）里，改后需要重新录制。

## 五、哪些是真实的

- 真实录制：分镜 3、4 里的智能体回答、耗时、用量、任务记录与时间线，以及分镜 6 里的 HTTP 状态、耗时与用量，都来自 Antigravity 的真实运行。
- 永远是替身：分镜 5 的智能体（审批流程是产品的真实行为，智能体是仓库里的假 ACP 智能体），画面全程标注。
- 画面里的网关地址是产品默认端口 8787，实际录制用的是随机端口。
- 光标、推移、淡入淡出是后期叠加；控制台截图本身没有任何手工修改。
- 占位录制（`--agent fixture`）的成片不是最终版，不要对外发布：回答是固定文本，画面会标「占位素材」。
- 英文版草稿（英文成片 + 中文录制）里的真实问答是中文：真实，但与英文版画面的语言不一致，不要对外发布；用英文提示词重录后才是正式版。
