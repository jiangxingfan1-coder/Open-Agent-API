# OAA-Lang 语法参考

[English](../language.md) · 简体中文

OAA-Lang 是描述智能体的源码语言。一个 `.oaa` 文件编译成一份智能体定义，和 JSON 发布用的是同一个契约（`AgentDefinition`），其中的 `flow` 编译成同一种依赖图。编译、格式化和检查都不调用模型。

```sh
npm run build
npm run oaa -- check examples/projected-workflow.oaa   # 检查，一次报出多处错误
npm run oaa -- fmt examples/projected-workflow.oaa     # 格式化
```

本文的代码块里，标 `oaa` 的是完整、可以直接编译的程序（`test/lang-docs.test.ts` 会逐个编译它们，并检查格式化结果对自身幂等）；标 `text` 的是片段。

最小的程序：

```oaa
agent "agent/hello" {
  model = "gpt-5"
}
```

## 1. 词法

### 注释

`#` 与 `//` 到行尾为止，`/* ... */` 可以跨行（没有闭合时报错）。字符串里的 `#`、`//` 不是注释。

```oaa
# 文件头注释
agent "agent/comments" { // 行尾注释
  /* 块注释
     可以跨行 */
  model = "gpt-5"
}
```

格式化会丢掉注释，`oaa fmt` 发现源码里有注释时会在标准错误输出里给出警告。

### 字符串

- `"..."` 或 `'...'`，不能跨行。支持的转义：`\n` `\r` `\t` `\b` `\f` `\uXXXX` `\"` `\'` `\\` `\/`；其他字符前的反斜杠被丢掉，保留字符本身。
- 三引号 `"""..."""` 可以跨行，内容不做转义。读取时去掉开头紧跟的换行、去掉最后一行只有空白的行，再去掉所有非空行共同的缩进；只含空白的行变成空行。

```oaa
agent "agent/strings" {
  model = 'gpt-5'
  description = "第一行\n第二行，中"
  instructions = """
    你是一名研究助理。
      这一行保留两个空格的相对缩进。
  """
}
```

### 数字与时长

整数、小数、负数和科学计数法（`1e3`、`2.5E-4`）都可以；超出数值范围（如 `1e400`）报错。数字后面紧跟 `ms`、`s`、`m`、`h` 表示时长，编译成毫秒整数：`500ms` → 500、`30s` → 30000、`5m` → 300000、`1h` → 3600000。

### 标识符、引用与表达式

- 标识符以字母、`_` 或 `$` 开头，后面可以有字母、数字、`_`、`.`、`-`；以 `$` 开头的还可以含 `#` 和 `/`（例如 `$listing#/files/0`）。
- `true`、`false`、`null` 是字面量。
- `$( ... )` 是一段安全表达式，原样交给执行图的表达式求值器（括号要配平，可以包含字符串）。
- 单字符符号：`{ } [ ] ( ) = : , ? | @ / ->`。
- 源码大小上限 512 KiB。

### 常量与插值

`let 名字 = 值` 声明常量，可以写在 `agent` 之前，也可以写在 `agent` 里面；先声明后使用，同名常量不许重复声明。

常量只在**值的位置**展开：属性的值、参数的值、数组与对象里的值、route / delegate 的目标，以及字符串里的 `${名字}` 插值（对象和数组插值成 JSON 文本）。键名、`use builtin` 后的工具名、tool / flow / step / route / delegate 的名字与 ID、类型名、`engine` 的值都**不会**被替换。`${没声明的名字}` 原样保留为文字。

```oaa
let who = "研究员"
let model_id = "gpt-5"

agent "agent/constants" {
  let turns = 4
  model = model_id
  description = "${who}使用的智能体"
  limits { max_turns = turns }
}
```

在 `flow` 里，`$名字` 如果不是步骤、不是 `input`、也不是 `foreach` 变量，而是一个常量，就解析为常量的值；与步骤同名时步骤优先。`$常量.字段` 这种带路径的写法不适用于常量，会报错。

## 2. 顶层声明

一个文件由若干 `let` / `type` 声明（可选）和恰好一个 `agent "ID" { ... }` 组成。智能体 ID 由字母数字开头，可以含 `.`、`_`、`/`、`-`，最长 120 个字符。

```oaa
let base = "docs"
type Doc = { path: string(min=1) title?: string }

agent "agent/top-level" {
  model = "gpt-5"
  use builtin read_file
  flow "open" {
    params { doc: Doc }
    step file = read_file(path = $input.doc.path)
  }
}
```

## 3. agent 的属性与子块

属性写成 `名字 = 值`，也可以写成 `名字: 值`。单值属性和单例子块都只能声明一次，重复声明会报错。

| 属性 | 值 | 说明 |
| --- | --- | --- |
| `description` | 字符串 | 能力摘要，默认空 |
| `instructions` | 字符串或三引号块 | 系统指令；`=` 可以省略（`instructions "..."`） |
| `engine` | `kernel` `codex` `claude` `antigravity` `dsh` 或 `adapter/<名称>` | 默认 `kernel`；写标识符或字符串均可 |
| `provider` | 字符串 | 默认提供方；不写时取第一条 route 的提供方，再不行是 `default` |
| `model` | 字符串 | 模型；不写时取第一条 route 的模型。`model` 与 `route` 至少要有一个 |
| `allow_graph` | 布尔 | 是否允许模型动态生成执行图，默认 `true`（也接受 `allowGraph`） |
| `approvals` | `ask` 或 `auto` | 仅外部智能体：运行中的权限请求转交你审批（`ask`，默认）或由发布策略自动批准（`auto`，风险见 [protocol.md](protocol.md#approval-policy-for-external-agents-approval-policy-v1)）；内核智能体写 `auto` 报错 |
| `allowed_nodes` | 字符串数组 | 允许使用的节点 ID（也接受 `allowedNodes`） |
| `files` | 字符串数组 | 随定义一起发布的相对路径 |
| `skills` | 对象数组 | 已发布的技能描述，每项 `{ name, description, path }` |
| `output_schema` | 类型写法 | 智能体最终输出的 Schema（见「类型写法」） |
| `limits` | 对象块 | 运行上限（见「limits」） |

子块与语句：`let`、`type`、`use builtin`、`route`、`tool`、`delegate`、`flow`（也可以写 `workflow`）。

```oaa
agent "agent/props" {
  description: "冒号与等号可以互换"
  engine = kernel
  provider = "openai"
  model = "gpt-5"
  allow_graph = false
  allowed_nodes = ["node-a"]
  files = ["prompts/style.md"]
  skills = [{ name: "review", description: "评审", path: "skills/review/SKILL.md" }]
  output_schema { summary: string }
  instructions "简短回答。"
}
```

外部智能体的审批策略：

```oaa
agent "agent/acp-auto" {
  engine = "adapter/acp"
  provider = "native"
  model = "default"
  approvals = auto
}
```

## 4. route、tool、delegate 与 use builtin

### use builtin

授予内置工具：`read_file`、`write_file`、`list_files`、`read_skill`、`memory_read`、`memory_write`。可以一次写一个，也可以写成列表。

```oaa
agent "agent/builtins" {
  model = "gpt-5"
  use builtin read_file
  use builtin [list_files, write_file]
}
```

### route

模型路由。行内写法：`route ID -> 模型` 或 `route ID -> 提供方/模型`，后面可以跟 `priority=`、`cost=`、`speed=`（1–5）、`tags=[...]`。块写法：`route ID { provider model priority tags cost speed }`（`cost` 也可以写 `cost_tier` / `costTier`，`speed` 同理）。`priority` 默认是这条 route 的序号。没写提供方的 route 使用整个 agent 块解析完之后确定的 `provider`，与书写顺序无关。

```oaa
agent "agent/routes" {
  route fast -> "openai"/"gpt-5-mini" priority=0 cost=1 speed=5 tags=["cheap"]
  route deep { model = "gpt-5", priority = 1, cost = 4 }
  provider = "openai"
}
```

### tool

声明一个由节点或脚本提供的工具。块里的键（规范写法是 snake_case，camelCase 照旧可用）：

| 键 | 说明 |
| --- | --- |
| `node` | 绑定到某个节点（`node_id` / `nodeId` 同义）；写了就是 host-bound，否则可移植 |
| `script`、`runtime` | 脚本路径与运行时（`node` 或 `python3`，默认 `node`） |
| `reference` | 节点上的工具引用，默认等于工具名 |
| `capability`、`version`、`description` | 能力 ID（默认 `custom/<工具名>`）、版本（默认 `"1"`）、说明 |
| `effect` | `read`、`idempotent-write`、`write` 或 `unknown`（默认） |
| `approval` | 是否需要审批（`requiresApproval` 同义），默认 `false` |
| `timeout_ms`、`cache_ttl_ms` | 超时（默认 60 秒）与缓存时长（默认 0）；也接受 `timeout`、`cache_ttl` |
| `resource_key`、`result_export`、`required` | 资源键、结果是否导出（默认 `true`）、是否必需 |
| `network { allowed_domains = [...] }` | 沙箱脚本可访问的域名（`allowedDomains` 同义） |
| `params { ... }` | 输入参数的类型写法（`schema`、`input_schema` 同义） |

```oaa
agent "agent/tools" {
  model = "gpt-5"
  tool search {
    node = "node-a"
    description = "全文检索"
    effect = "read"
    timeout_ms = 10s
    params { query: string(min=1) limit?: int(min=1, max=50) }
  }
  tool fetch {
    script = "scripts/fetch.mjs"
    effect = "read"
    network { allowed_domains = ["example.com"] }
    params { url: string }
  }
}
```

另有完整绑定写法 `tool "名字" = { ... }`，值是完整的 `ToolBinding` 契约（不含外层的 `name`），用于改写内置工具的策略等块写法表达不了的情况：

```oaa
agent "agent/exact-binding" {
  model = "gpt-5"
  tool reviewed_read = {
    handler: { kind: "builtin", name: "read_file" }
    capability: {
      id: "builtin/read_file", version: "1", description: "需要审批的读取"
      placement: "portable", effect: "read", inputSchema: { type: "object" }
      requiresApproval: true, timeoutMs: 60000, cacheTtlMs: 0, resultExport: true
    }
    required: true
  }
}
```

### delegate

把子任务委托给另一个智能体：`delegate 名字 -> "智能体ID"`，可以用 `@配置` 指定对方的 route 或语义配置（也可以直接写在 ID 里：`"agent/x@fast"`），后面可以跟块：`agent`、`model`、`description`、`timeout`（`timeout_ms` / `timeoutMs` / `max_wait` 同义，默认 120 秒）、`forward_files`（默认 `false`）。

```oaa
agent "agent/delegates" {
  model = "gpt-5"
  delegate ask_researcher -> "agent/research"@fast {
    description = "查资料"
    timeout = 60s
    forward_files = true
  }
}
```

## 5. flow 与步骤

`flow 名字 { ... }` 声明一个工作流宏，模型可以像调用工具一样调用它。块里可以写：

- `params { ... }`：输入参数（`schema`、`input_schema` 同义，只能写一次）；不写时没有参数。
- `description = "..."`：说明（只能写一次）。
- `step ...`：至少一个步骤。
- `return 值`：最终结果的投影（只能写一次），不写时返回全部步骤结果。
- `output_schema { ... }`：结果的 Schema（只能写一次）。

步骤写成 `step ID = 工具(参数 = 值, ...)`，工具可以是 `use builtin`、`tool`、`delegate` 声明的名字、前面声明过的 flow，或内置的纯变换 `$transform`（结果就是它的参数）。步骤 ID 不能叫 `input`；不是普通标识符的 ID 加引号（`step "1a" = ...`）。

预先编写的流程最多可声明 64 个静态步骤；模型临时生成的 `execute_graph` 仍最多 32 步。发布前，普通步骤按 1 项、循环按声明的 `max_items` 项计数，主分支合计不得超过 1,024 项。这不增加工具并发或单次运行的工具调用额度。使用超过 32 步的流程时，请同时升级网关和执行节点。

步骤可以跟修饰，每种只能写一次；逐项筛选条件写在它所属的 `foreach` 后面：

| 修饰 | 说明 |
| --- | --- |
| `foreach 变量 in $引用 (max=N)` | 对列表逐项执行，`max` 默认 16、最大 32 |
| `foreach row in $input.rows (max=8) where $(row.enabled)` | 只执行匹配项。`where` 可引用别名、`$item` 和原列表从零开始的 `$index`；别名不要使用 `index`。 |
| `when 值` | 条件；在循环开始前整体判断一次，不能引用循环变量 |
| `fallback 工具(...)` / `fallback = 值` | 失败时的回退调用或回退值 |
| `depends_on = ["步骤", ...]` | 显式依赖 |
| `retry N` / `retry(N, backoff=时长)` | 失败后最多再试 N 次（1–3） |
| `timeout 时长` | 每次尝试的超时（100 毫秒到 10 分钟），到点报 `step_timeout` |

**先检查原列表长度，再筛选。** 同一循环全部条件算完才开始派发；不匹配项不执行工具、不创建审批、不走回退。例如步骤 `send` 只有原索引 1、3 匹配，则执行编号是 `send_1`、`send_3`；返回数组按原顺序紧凑排列。全不匹配返回 `[]`，整个步骤的 `when` 为假仍返回 `{skipped: true}`。循环上限和工具预算都不变。网关通过 `GET /health` 的 `foreach-where-v1` 声明支持此语法，在 JSON 图中对应 `foreach.where`。

`retry` 与 `timeout` 只允许用在只读或 `idempotent-write` 的工具上，否则编译期报 `unsafe_graph_retry`。等待审批、运行取消、副作用结果未知时不会重试，也不会被回退值掩盖。

```oaa
agent "agent/flows" {
  model = "gpt-5"
  use builtin [list_files, read_file]
  flow gather {
    description = "读出目录里的前几个文件"
    params { dir: string limit?: int(default=4) }
    step listing = list_files(path = $input.dir) retry(2, backoff=200ms) timeout 30s
    step docs = read_file(path = $item) foreach item in $listing.files (max=8) fallback = "missing"
    step first = read_file(path = "{{listing.files.0}}") depends_on = ["listing"] when $listing.files
    output_schema { count: int first: any }
    return { count: $(len(listing.files)), first: $first }
  }
}
```

块写法 `step "ID" { tool = "...", arguments = { ... } }` 与 JSON 执行图里的步骤对象一一对应：

```oaa
agent "agent/step-block" {
  model = "gpt-5"
  use builtin read_file
  flow load {
    step "doc" { tool = "read_file", arguments = { path = "README.md" } }
  }
}
```

`return` 是图执行完之后的最终投影，不是提前返回：所有步骤照常按依赖和审批执行。它减少进入下一轮模型上下文的数据，完整的步骤结果和产物引用仍保留在运行记录里；它不是隐私或授权边界。引用了不存在的步骤，或在最终结果里用了 `foreach` 的局部变量，会在发布前报错。

## 6. 值与引用

- 字面量：字符串、数字、时长、`true` / `false` / `null`、数组 `[a, b]`、对象 `{ 键 = 值 }` 或 `{ 键: 值 }`（逗号可省略，键可以加引号）。对象里重复的键会报错。
- 常量名在值的位置展开（见「常量与插值」）。
- 在 flow 里：
  - `$step`、`$step.a.b`、`$step#/a/b` 是对步骤结果的引用；`$input.x` 引用流程输入；`$item`、`$index` 和 `foreach` 变量引用循环项。引用后面可以加 `default = 值`。
  - `$( ... )` 是安全表达式，例如 `$(slice(doc.text, 0, 200))`。表达式（以及模板）里 `input` 与 `$input` 等价，都指流程输入，不产生对步骤的依赖；这只在 flow 里成立，模型直接发起的 `execute_graph` 没有流程输入。直接用 JSON 发布的流程如果有名为 `input` 的步骤，步骤优先。
  - 含 `{{...}}` 的字符串是模板，例如 `"{{$input.prefix}}:{{doc.title}}"`；要写含 `{{` 的普通文字用 `literal("...")`（只接受字符串）。
  - 显式的 JSON 描述符 `{ "$ref": "doc#/text", "$default": "无" }` 原样保留，不再按简写解析。
  - `$(input.limit ?? 10)` 只在字段缺失或为 `null` 时取 10；左侧为 0、`false`、空字符串时保留原值，且不计算右侧。两侧仍须通过编译期检查。它的优先级低于 `||`、高于 `? :`，混用时建议加括号。使用此语法前请升级旧版运行时。

```oaa
agent "agent/values" {
  model = "gpt-5"
  use builtin read_file
  flow show {
    params { prefix: string }
    step doc = read_file(path = "README.md")
    step label = $transform(
      text = "{{$input.prefix}}:{{doc.path}}",
      raw = literal("{{not_a_reference}}"),
      head = $(slice(doc.text, 0, 20)),
      size = $doc.size default = 0,
      exact = { "$ref": "doc#/text", "$default": "无" }
    )
    return $label
  }
}
```

```oaa
agent "agent/input-expr" {
  model = "gpt-5"
  use builtin read_file
  flow peek {
    params { path: string limit?: int(default=200) }
    step doc = read_file(path = $input.path) when $(input.limit > 0)
    return { head: $(slice(doc.text, 0, input.limit)) }
  }
}
```

## 7. 类型写法

用在 `params`、`output_schema` 和 `type` 别名里，编译成 JSON Schema：

- 基本类型：`string`（`str`）、`int`（`integer`）、`number`（`float`）、`bool`（`boolean`）、`object`（`json`）、`any`，不分大小写。
- 修饰：`string("说明", min=1, max=200, pattern="^a")`、`int(min=0, max=9, default=3)`。`min` / `max` 只用于字符串（长度）和数字，`pattern` 只用于字符串，`default` 的值必须与类型相符，`enum` 必须是数组；其他修饰报错。
- 数组：在类型后面加 `[]`，可以叠加（`int[][]`）。
- 字面量联合：`"fast" | "deep"` 或 `1 | 2 | 3`，不能混用字符串和数字。
- 对象：`{ 字段: 类型  可选字段?: 类型 }`，带 `default` 的字段也不算必填。
- 别名：`type 名字 = 类型`，只在编译期展开；不能与内置类型同名（不分大小写），不能重复声明。
- 任意 JSON Schema：`json { ... }`（也可以直接写以 `type = "..."` 开头的 Schema 对象）。

```oaa
type Mode = "fast" | "deep"

agent "agent/types" {
  model = "gpt-5"
  type Excerpt = string("摘要", max=2000)
  output_schema {
    mode: Mode
    level?: 1 | 2 | 3
    tags: string(max=32)[]
    excerpt: Excerpt
    doc: { path: string meta?: { size: int(min=0) } }
    extra?: any
  }
}
```

```oaa
agent "agent/json-schema" {
  model = "gpt-5"
  output_schema = json { anyOf: [{ type: "string" }, { type: "null" }] }
}
```

## 8. limits

| 键 | 默认 | 范围 | 同义写法 |
| --- | --- | --- | --- |
| `max_turns` | 16 | 1–100 | `maxTurns` |
| `max_output_tokens` | 4096 | 1–100000 | `maxOutputTokens` |
| `timeout_ms` | 1800000（30 分钟） | 100 毫秒–1 小时 | `timeout`、`timeoutMs`、`wall_ms` |
| `tool_concurrency` | 4 | 1–32 | `toolConcurrency` |
| `max_total_tokens` | 200000 | 1–10000000 | `maxTotalTokens` |

未知的键报错（带建议）；值超出范围时报 `oaa_validation_error`，位置指向那一行。

```oaa
agent "agent/limits" {
  model = "gpt-5"
  limits {
    max_turns = 8
    timeout_ms = 10m
    tool_concurrency = 2
  }
}
```

## 9. 格式化与诊断

`oaa fmt`（`formatOaaLang`）以编译产物为准重新生成源码，结果必须重新编译后与原定义完全一致，否则拒绝输出（`oaa_roundtrip_error`）。规则：

- 保留 `let` 常量（声明放在文件开头；`description`、`model`、`provider` 的值恰好等于某个字符串常量时写常量名）和 `type` 别名（用到的地方写别名名字）。
- 参数与输出 Schema 用类型写法，表达不了的写 `json { ... }`。
- 多行 `instructions` 输出三引号块；含 `\r`、`"""`、`${` 或会被去缩进改变的内容仍写成 JSON 字符串。
- 连续的 `use builtin` 合并成列表；自定义工具输出 snake_case 的 `tool "名字" { ... }` 块，块写法表达不了时输出完整绑定。
- 引用、表达式、模板还原成简写；不安全的步骤 ID 加引号。
- 候选写法从讲究到朴素依次尝试，取第一个通过比对的；注释会丢失。格式化结果对自身幂等。

`oaa check`（`diagnoseOaaLang`、`POST /v1/lang/compile`）返回诊断列表：

- 错误带 `line` / `col` 与错误码：`oaa_syntax_error`（语法与静态检查）、`oaa_validation_error`（值不符合智能体契约）、执行图校验的原错误码（如 `invalid_graph`、`unsafe_graph_retry`）。
- 拼写类错误会带最接近的写法（`Did you mean 'description'?`），并一次报出多处独立的拼写错误（最多 8 条）；遇到缺括号等结构性错误只报第一条。
- 程序能编译但格式化失败时仍判为有效，格式化问题降级为警告。
- 另有提示：描述为空、kernel 引擎的指令为空、只有一条 route、每个 flow 的拓扑层数与最大并行宽度。

`GET /health` 中的 `workflow-output-v1` 与 `oaa-lang-roundtrip-v1` 表示网关支持工作流结果投影和格式化往返比对。
[按勾选项读取文档的示例](../../examples/filtered-workflow.oaa) 是一份使用逐项筛选的完整智能体定义。

## 升级说明（0.2.0）

这一版让编译器对以前「碰巧能编译」或会崩溃的写法给出明确报错，并统一了几处语法。所有新报错都带 `Line N, Col M:` 位置；合法程序的编译产物不变（格式化输出会有变化，见表末几行）。

| 写法 | 原来的表现 | 现在 |
| --- | --- | --- |
| `route r null`、`limits = null`、`limits = [1]` | 抛 `TypeError`（`execution_failed`，无位置） | `oaa_syntax_error`：`Route 'r' must be '-> provider/model' or an object block.` / `'limits' must be an object block.` |
| `let read_file = "write_file"` 后写 `use builtin read_file`；`let path = "zzz"` 后写 `path = ...` 作参数键 | 常量替换了标识符：实际授予 `write_file`、键名变成 `zzz` | 常量只在值的位置展开（属性值、参数值、数组与对象里的值、`${}` 插值、route / delegate 的目标）；键名、工具名、tool / flow / step / route / delegate 的名字与 ID、类型名、`engine` 的值不再替换 |
| 能编译但格式化失败的程序（如 `step "1a" = ...`） | `diagnoseOaaLang` 判为无效，行号来自格式化后的源码 | 程序判为有效；格式化失败降级为警告；格式化器给不安全的步骤 ID 加引号 |
| 契约校验失败（如 `max_turns = 0`、`engine = "nope"`、`route ... cost=9`） | `execution_failed` 加原始 Zod JSON，无位置 | `oaa_validation_error`，一句话说明，位置指向对应的声明或键（如 `limits` 块里 `max_turns` 那一行）；映射不到时指向 agent 声明 |
| 执行图校验失败（引用不存在的步骤等） | 原错误码，无位置 | 原错误码不变，报错前加上所属 step（报错里提到的步骤）或 flow 声明的位置 |
| 重复声明：`description`、`model`、`instructions`、`limits`、`engine`、`provider`、`output_schema`、`allow_graph`、`allowed_nodes`、`files`、`skills`、同名 `let`；flow 里的 `params` / `description`；步骤上的 `when` / `fallback` / `depends_on` | 后一个静默覆盖前一个 | `Duplicate '...' declaration.` / `Duplicate constant 'x'.` / `Duplicate 'when' modifier.` 等 |
| `delegate` 块里的未知键（`timout`）、`foreach (maxx=3)`、未知类型修饰（`string(foo=1)`） | 静默忽略，或原样写进 Schema | `Unknown property` / `Unknown foreach option` / `Unknown type modifier`，带「Did you mean」建议 |
| 修饰与类型不符：`bool(min=1)`、`int(default="x")`、`string(pattern=1)`；混合字面量联合 `"x" \| 1` | 生成不一致的 Schema | `Type modifier 'min' does not apply to type 'bool'.`、`Type modifier 'default' does not match type 'int'.`、`A union type cannot mix string and number literals.` |
| 属性值类型不对：`description = { ... }`、`model = 5`、`files = [1, 2]`、flow 的 `description = 5` | 被 `String(...)` 强转 | `'description' must be a string.`、`'files' must be an array of relative paths.` 等 |
| 与内置类型同名（不分大小写）的别名：`type Str = int`、`type STRING = int` | `Str` 能声明 | `would shadow a built-in type` |
| 名为 `input` 的步骤 | 编译通过，与流程输入 `$input` 混淆 | `A step cannot be named 'input'` |
| `1e400` 这类数字 | 被拆成数字 `1` 加标识符 `e400` | 支持科学计数法（`1e3`）；超出范围时报 `Numeric literal '1e400' is out of range.` |
| `route` 写在 `provider =` 之前 | 这条 route 的提供方是 `default`，结果依赖声明顺序 | 整个 agent 块解析完之后才确定默认提供方；原来就把 `provider` 写在前面的程序产物不变 |
| agent 级属性写成 `description: "x"` | 报 `Expected =` | 与 `=` 等价 |
| `tool` 的 `network { allowed_domains = [...] }` | `allowed_domains` 不被识别，契约校验失败 | 与 `allowedDomains` 等价；snake_case 是规范写法 |
| flow 里写 `$常量`（常量不是步骤名） | 报「引用了不存在的步骤」 | 解析为常量的值；`$常量.字段` 报错并说明常量不能带路径 |
| `oaa fmt` 的输出 | 丢掉 `let`、多行指令写成一行 JSON 字符串、每个 `use builtin` 一行、自定义工具写成 camelCase 的完整绑定 | 保留 `let`、多行指令用三引号、连续 `use builtin` 合并成列表、自定义工具写成 snake_case 的块；源码有注释时警告 |

`${不存在的常量}` 仍然原样保留为文字，不报错：说明文字里出现 `${…}` 是合法需求。
