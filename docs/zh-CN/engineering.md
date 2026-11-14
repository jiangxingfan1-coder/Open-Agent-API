# 工程规范

[English](../engineering.md) · 简体中文

本文记录 Open Agent API 仓库的日常工程约定。每条规则都对应仓库里实际存在的检查；规则与检查不一致时，以检查为准，并修正本文。

## 1. 常用命令

命令定义在 `package.json` 的 `scripts` 中。

| 命令 | 作用 |
| --- | --- |
| `npm run build` | `tsc -p tsconfig.json`，输出到 `dist/` |
| `npm run check` | 只做类型检查（`tsc --noEmit`） |
| `npm run format` | 用 Prettier 排版 `src`、`test`、`bench`、`examples`、`scripts/*.mjs`、`web/*.js`、`web/{lib,views,dialogs,shared}/*.js`、`web/*.css`、`web/{styles,shared}/*.css`、`web/portal/*.js`、`web/portal/*.css`、`web/portal/styles/*.css` |
| `npm run format:check` | 只检查排版，不改文件 |
| `npm run test:offline` | 先 build，再运行不监听端口的测试（见第 5 节） |
| `npm test` | 先 build，再运行 `dist/test/*.test.js` 全部测试，会在 127.0.0.1 随机端口临时监听 |
| `npm run verify` | `check` + `format:check` + `test`，一键校验，CI 运行的就是它 |

CI（`.github/workflows/ci.yml`）在 push 与 pull request 时，于 Ubuntu 与 macOS 上用 Node 24 与 Node 26（各自最新的版本，即 `engines` 支持的两条线）执行 `npm ci --omit=optional --ignore-scripts` 和 `npm run verify`。Windows 作业（同样两条线）只跑类型检查、格式检查与打包相关的测试（见 [releasing.md](releasing.md)）。完整测试在 Windows 上由单独的工作流 `.github/workflows/windows.yml` 运行（Node 24，`--isolate`，见 [windows.md](windows.md)）。

## 2. 目录分层与依赖规则

`src/` 下除命令行入口 `src/cli.ts` 外，每个文件都放在一个分层目录里，且只有一级（`src/<目录>/<文件>.ts`）。层级定义在 `test/architecture.test.ts` 的 `LAYERS`：

| 目录 | 层级 | 内容 |
| --- | --- | --- |
| `core/` | 0 | 契约与基础：contracts、util、schemas、builtins、suspension、version、locale，以及错误目录 errors（英文文案在 errors-en）、事件目录 events、限额目录 limits、运行状态转移表 run-status |
| `config/` | 1 | 配置与预设：config、agent-presets |
| `lang/` | 2 | 定义语言与执行图：lang、graph、bundle（以及与它们相邻的编译器文件） |
| `store/` | 2 | 持久化：store、output、inspection、audit |
| `providers/` | 2 | 模型接入：models、http-stream、provider-state |
| `engines/` | 3 | 智能体接入（内层 Harness）：native、acp、a2a、adapter、conformance、process、sandbox，四种接入方式共用的 shared |
| `fabric/` | 4 | 分发网络：network、worker、placement、mcp-connections、tool-import、local-backends |
| `kernel/` | 5 | 内核（外层 Harness）：kernel、run-state、routing、invocation、response-object 等 |
| `gateway/` | 6 | 网关与协议：server、各 `*-routes`、auth、streams、compat-stream、protocol、uap、discovery 等 |
| `client/` | 7 | 客户端：client、mcp |

`src/cli.ts` 位置固定（打包脚本与桌面外壳依赖 `dist/src/cli.js`），可以引用任何目录。

架构测试强制以下规则：

- **只向下引用**：一个文件只能引用同目录或层级更低的目录。同层不同目录（`lang` / `store` / `providers`）互不引用。任何文件都不能引用 `cli.ts`。
- **没有循环引用**：文件之间不允许形成环，`import type` 也算。
- **行数棘轮**：默认每个文件不超过 600 行；超过 600 行的文件登记在 `LINE_BUDGETS`，上限是登记时的行数向上取整到 50。预算只许调低：文件变短后，把预算调到新行数向上取整到 50；不要为了放行而调高或新增登记，应先拆分文件。
- **不用 `any`**：`as any` 与 `: any` 的数量上限 `ANY_BUDGET` 为 0。外部输入先用 `unknown` 接住，再用 zod 校验、`typeof` 判断或局部的窄类型收窄。

新增文件时，先确定它属于哪一层；如果它需要引用更高层的东西，说明职责放错了位置，应把共用部分下沉到更低层。

## 3. 编码与命名约定

- **语言与模块**：TypeScript，`"type": "module"`，`module` 与 `moduleResolution` 为 `NodeNext`。相对引用一律写 `.js` 后缀（如 `import { Fault } from '../core/util.js'`）。
- **编译检查**：`tsconfig.json` 打开了 `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`noImplicitReturns`、`noEmitOnError`。覆盖父类成员要写 `override`；有返回值的函数每条路径都要 `return`；`switch` 的非空分支不能贯穿。
- **排版**：Prettier，配置在 `.prettierrc.json`（单引号、行宽 100、尾随逗号 `all`）。提交前跑 `npm run format`。
- **文件名**：小写短横线（kebab-case），如 `run-state.ts`、`compat-stream.ts`；测试文件为 `test/<主题>.test.ts`。
- **标识符**：类型与类用 PascalCase，函数与变量用 camelCase，模块级常量用 UPPER_SNAKE_CASE（如 `VALID_STRATEGIES`）。
- **协议字段与错误码**：保持英文，错误码用 snake_case（如 `run_not_found`），元数据键用 `oaa.` 前缀（如 `oaa.routing_strategy`）。
- **文案与注释**：代码注释、测试名、提交信息、issue 与 PR 默认用英文（中文同样欢迎）。文档以英文为主，中文版放在 `docs/zh-CN/`，改了一边要同步另一边。面向用户的文案必须中英双语：控制台文案在 `web/lib/messages-*-zh.js` 与 `web/lib/messages-*-en.js`（开发者门户在 `web/portal/messages-*.js`），错误说明在 `src/core/errors.ts` 与 `src/core/errors-en.ts`，命令行与网关消息用 `src/core/locale.ts` 的 `bi(zh, en)` 写双语，展示页是 `site/index.html`（中文）与 `site/en/index.html`（英文）。
- **依赖**：不随意新增运行时依赖；确需新增时单独提交并说明理由。

## 4. 怎么加一个错误码 / 事件

### 错误码

1. 在 `src/core/errors.ts` 的 `ROWS` 里按所属类别加一行：`[code, status 或 statuses, category, retryable, zh, next?]`。
   - `code`：snake_case 英文，一旦发布就是稳定接口。
   - `status`：最常用的 HTTP 状态；同一个码在不同场景用不同状态时写成数组（第一个为主状态）；不作为 HTTP 响应出现（只是运行错误码、worker 或客户端本地产生）时写 `null`。
   - `category`：`ERROR_CATEGORIES` 里的稳定英文标识（`request` `agent` `publish` `run` `approval` `file` `tool` `provider` `engine` `node` `client` `platform`），与 `docs/protocol.md`「Error codes」一章的小节一一对应。
   - `retryable`：调用方原样重试有可能成功（限流、超时、容量、节点暂时不可用、网关关闭中）写 `R`，其余写 `_`；拿不准写 `_`。
   - `zh`：写给使用者看的一句话，准确、不口语化、不超过 40 个汉字；`next`：可执行的下一步，可省。
   - 英文文案写在 `src/core/errors-en.ts`：每个码一行 `[en, nextEn?]`，与 `zh` / `next` 一一对应（`next` 与 `nextEn` 要么都有，要么都没有），不含汉字。
   - 调度标记：码需要「第一轮模型调用失败时可换线路重试」「不触发换用备选智能体」「外部执行开始后按结果未知处理」时，再把它加进文件末尾的 `ROUTE_RETRYABLE`、`FALLBACK_EXEMPT`、`UNCERTAIN_WHEN_STARTED` 集合（每码一行）。集合里的码必须已在 `ROWS` 里登记，否则模块加载即报错；`GET /v1/errors` 会带出 `routeRetryable`、`fallbackExempt`、`uncertainWhenStarted` 标记。
2. 在源码里照旧用 `new Fault(code, message, status)` 抛出（`Fault` 在 `src/core/util.ts`），`code` 尽量写成字符串字面量。码是拼接出来或在 `Fault` 之外赋值的，把它登记进 `test/error-catalog.test.ts` 的 `DYNAMIC_ERROR_CODES`。只终结运行、不决定 HTTP 状态的运行错误码（如 `turn_limit`、`token_budget`、`max_output_tokens`，run-state 记为 incomplete）用 `new RunErrorFault(code, message)` 抛出，不写状态，目录里 `status` 写 `null`；不要用 `new Fault` 加占位状态或命名常量。这类码还要归类：原因是调用自身的上限或额度的，加进 `errors.ts` 的 `CALLER_LIMIT`（兼容入口错误体按 422 一类：Claude `invalid_request_error`、Gemini `FAILED_PRECONDITION`）；服务一侧的原因登记进 `test/error-catalog.test.ts` 的 `SERVICE_SIDE_RUN_CODES`（按 500 一类：`api_error`、`INTERNAL`）。HTTP 状态与重试头不受归类影响。
3. 在 `docs/protocol.md`「Error codes (`error.code`)」一章对应小节的表格里补一行（HTTP 状态与含义），`docs/zh-CN/protocol.md`「错误码（`error.code`）」里同样补一行。
4. `test/error-catalog.test.ts`（离线）核对：源码里每个 `Fault` 字面量码与动态码都在目录里；目录没有重复码；每个码都同时出现在 `docs/protocol.md` 与 `docs/zh-CN/protocol.md`；`zh` 非空且不超过 40 个汉字，`en` 非空且不含汉字；代码里该码用过的每个 HTTP 状态都包含在 `status` / `statuses` 里。`RunErrorFault` 抛出的码在目录里必须是 `null`，`run` 类里状态为 `null` 的码不得以 `new Fault` 抛出。`test/overview.test.ts` 另外核对源码里的码都写进了文档。
5. 目录通过 `GET /v1/errors`（需要 `read` 权限，带 ETag，`If-None-Match` 命中返回 304）对外提供，`/health` 的 `features` 含 `error-catalog-v1`。`revision` 是目录内容的 sha256 前 16 位，改动目录就会变。
6. 客户端按 `code` 分支，不要改名或复用旧码表达新含义；`message` 可以改。

### 运行事件

1. 运行事件的结构是 `src/core/contracts.ts` 里的 `RunEvent`（`id`、`runId`、`type`、`time`、`data`）。全部事件类型登记在 `src/core/events.ts` 的 `RUN_EVENT_TYPES`，每项一行注释写明含义与 `data` 的关键字段；类型 `RunEventType` 由它导出。按点分命名：对外输出用 `response.*`，生命周期用 `run.*`，其余为 `tool.*`、`subagent.*`、`approval.*`、`step.*`、`route.*`、`workflow.*`。
2. 新增事件：先在 `RUN_EVENT_TYPES` 里加一行（含注释），再在源码里写入。写入入口 `store.emit(runId, type, data)` 与 `EventInput.type` 的参数类型是 `RunEventType`，未登记的名字编译不过；读出的 `RunEvent.type` 仍是 string。
3. 判断运行是否结束用 `isTerminalEvent(type)`（`TERMINAL_EVENT_TYPES`：四个 `response.*` 终态加 `run.interrupted`），不要在各处再写一份名单。`OUTPUT_EVENT_TYPES`（输出投影）与 `TIMELINE_EVENT_TYPES`（时间线读取）也在事件目录里。
4. 事件由 `src/store/store.ts` 在同一事务里与检查点一起写入；内核通过存储层提交，不要绕过存储直接拼事件序号。
5. 在 `docs/protocol.md`（以及 `docs/zh-CN/protocol.md`）相应章节写明 `type` 与 `data` 的形状。已有事件的名字、字段、顺序都不能改，字段只能新增。
6. `test/event-catalog.test.ts`（离线）核对 `core/`、`store/`、`kernel/`、`gateway/`、`fabric/` 里作为事件名出现的字面量都在目录里。兼容端点（OpenAI / Claude / Gemini / UAP）对外的事件流不能因此改变（见第 7 节）。

### 运行状态

`Run.status` 的合法转移登记在 `src/core/run-status.ts` 的 `RUN_TRANSITIONS`（`kernel/run-state.ts` 再导出），存储层落盘前按表校验，非法转移抛 `invalid_run_transition` 且不写入。新增状态转移先登记进表（每条边一行注释写明触发条件），再改内核；规则见 [architecture.md「3.2 运行状态机」](architecture.md#32-运行状态机)，测试在 `test/run-transitions.test.ts`。

## 5. 测试分类与何时跑哪种

测试用 Node 自带的 `node:test`，源码在 `test/*.test.ts`，编译到 `dist/test/*.test.js` 后运行，并发度固定为 1。

| 类别 | 判定 | 怎么跑 |
| --- | --- | --- |
| 离线测试 | 文件里不含 `.listen(`、`WebSocketServer(`、`createServer(` | `npm run test:offline` |
| 监听端口的测试 | 含上述任一写法 | 只能随全量 `npm test` 运行 |

- `scripts/test-offline.mjs` 按上面的规则自动挑出离线文件，交给 `node --test --test-concurrency=1 --test-timeout=120000`（另有 20 分钟总时限，到点结束进程树并报错；不用 `--test-force-exit`，它会让部分测试不被执行）（任何一项卡住都会在 2 分钟内以测试名报失败），退出码原样返回；一个文件都没挑到或缺少编译产物时以非零退出。加 `--isolate`（`.github/workflows/windows.yml` 使用）时每个测试文件单独起一个 `node --test` 进程，各自时限 3 分钟（`OAA_TEST_FILE_TIMEOUT_MS` 可调）；超时则结束该文件的进程树（Windows 用 `taskkill /T /F`）、记为超时并继续下一个文件；最后汇总失败与超时的文件，有任何一项未通过即以非零退出。
- 监听端口的测试一律用 `port: 0`，只在 127.0.0.1 上临时监听随机端口，用测试替身代替真实模型，不访问外网，也不会占用桌面应用的 8787 端口。`test/sandbox-srt.test.ts` 会启动 srt 的本地代理，文件里特意写了 `createServer(`，让它归入监听端口一类。
- **何时跑**：改动过程中频繁跑 `npm run check` 和 `npm run test:offline`；提交前、合并前跑 `npm run verify`（含全量测试）。在本机运行会监听端口的测试前，按个人约定先确认是否允许。
- `test/architecture.test.ts` 是离线测试，只静态读取 `src/`，改结构后先跑它。
- 纯重构不改测试断言，只允许改 import 路径；功能改动先写会失败的测试，再实现。

## 6. 提交信息格式

- 英文为主，中文同样欢迎。格式为 `范围：做了什么`（英文写作 `scope: what changed`），例如 `工程：新增离线测试入口 test:offline 与一键校验 verify`、`类型：消除 src 里全部 any`、`结构：src 按层次分目录`。常见范围：`工程`、`结构`、`类型`、`测试`、`排版`、`依赖`、`规划`、`OAA-Lang`（英文：`engineering`、`structure`、`types`、`tests`、`formatting`、`deps`、`planning`、`OAA-Lang`）。
- 一个提交只做一件事；只 `git add` 自己改的文件，不用 `git add -A`。
- 由智能体协作产生的提交，末尾加 `Co-Authored-By:` 行。

## 7. 兼容性红线

以下内容是对外承诺，任何改动都不能破坏：

- **线上字节**：既有请求在既有条件下的线上输出一个字节都不能变。兼容流有逐字节测试（`test/observability.test.ts`，按 `bench/protocol-speed.ts` 的同一工作量：UAP NDJSON 10,238 字节，OpenAI Chat SSE 55,219 字节），这些断言不许改。重构请求解析时，只允许改类型，不改运行时逻辑。
- **存储结构**：不改 SQLite 结构（当前 schema v4，即 `src/store/store.ts` 的 `SCHEMA_VERSION`）。确需迁移时必须单独设计、单独评审，并保证旧数据库可升级。
- **节点线协议**：网关与执行节点之间的消息（见 [protocol.md](protocol.md)「Node wire protocol」）既有字段不改名、不删除、不改含义；只能新增可选字段。
- **错误码与事件**：已发布的错误码和事件字段同样是稳定接口（见第 4 节）。
- **署名**：`src/config/agent-presets.ts` 文件头与 `THIRD_PARTY_NOTICES.md` 中的 Apache-2.0 署名必须保留。
