# OAA-Lang syntax reference

English · [简体中文](zh-CN/language.md)

OAA-Lang is a source language for describing agents. A `.oaa` file compiles into one agent definition, using the same contract (`AgentDefinition`) as publishing from JSON, and its `flow` compiles into the same kind of dependency graph. Compiling, formatting, and checking never call a model.

```sh
npm run build
npm run oaa -- check examples/projected-workflow.oaa   # check; reports several errors at once
npm run oaa -- fmt examples/projected-workflow.oaa     # format
```

In the code blocks of this document, those marked `oaa` are complete programs that compile as they are (`test/lang-docs.test.ts` compiles each of them and checks that the formatted result is idempotent with respect to itself); those marked `text` are fragments.

The smallest program:

```oaa
agent "agent/hello" {
  model = "gpt-5"
}
```

## 1. Lexical structure

### Comments

`#` and `//` run to the end of the line, and `/* ... */` can span lines (an unclosed one is an error). A `#` or `//` inside a string is not a comment.

```oaa
# File header comment
agent "agent/comments" { // trailing comment
  /* block comment
     can span lines */
  model = "gpt-5"
}
```

Formatting drops comments; when `oaa fmt` finds comments in the source it prints a warning on standard error.

### Strings

- `"..."` or `'...'`, which cannot span lines. Supported escapes: `\n` `\r` `\t` `\b` `\f` `\uXXXX` `\"` `\'` `\\` `\/`; a backslash before any other character is dropped and the character itself is kept.
- Triple quotes `"""..."""` can span lines, and the content is not escaped. On reading, the newline immediately after the opening quotes is removed, a last line that contains only whitespace is removed, and then the indentation common to all non-blank lines is removed; lines that contain only whitespace become empty lines.

```oaa
agent "agent/strings" {
  model = 'gpt-5'
  description = "First line\nSecond line"
  instructions = """
    You are a research assistant.
      This line keeps two spaces of relative indentation.
  """
}
```

### Numbers and durations

Integers, decimals, negative numbers, and scientific notation (`1e3`, `2.5E-4`) are all allowed; a value outside the numeric range (such as `1e400`) is an error. A number immediately followed by `ms`, `s`, `m`, or `h` is a duration and compiles to an integer number of milliseconds: `500ms` → 500, `30s` → 30000, `5m` → 300000, `1h` → 3600000.

### Identifiers, references, and expressions

- An identifier starts with a letter, `_`, or `$`, and may be followed by letters, digits, `_`, `.`, and `-`; one that starts with `$` may also contain `#` and `/` (for example `$listing#/files/0`).
- `true`, `false`, and `null` are literals.
- `$( ... )` is a safe expression, handed as is to the execution graph's expression evaluator (parentheses must balance, and it may contain strings).
- Single-character symbols: `{ } [ ] ( ) = : , ? | @ / ->`.
- The source size limit is 512 KiB.

### Constants and interpolation

`let name = value` declares a constant. It may be written before `agent` or inside `agent`; a constant must be declared before it is used, and declaring the same name twice is not allowed.

A constant is expanded only in **value positions**: property values, argument values, values inside arrays and objects, route / delegate targets, and `${name}` interpolation inside strings (an object or array is interpolated as JSON text). Key names, the tool name after `use builtin`, the names and IDs of tools / flows / steps / routes / delegates, type names, and the value of `engine` are **not** replaced. `${undeclared_name}` is kept as literal text.

```oaa
let who = "researcher"
let model_id = "gpt-5"

agent "agent/constants" {
  let turns = 4
  model = model_id
  description = "An agent for ${who}"
  limits { max_turns = turns }
}
```

In a `flow`, if `$name` is not a step, not `input`, and not a `foreach` variable, but is a constant, it resolves to the constant's value; when it has the same name as a step, the step wins. A path form such as `$constant.field` does not apply to constants and is an error.

## 2. Top-level declarations

A file consists of some `let` / `type` declarations (optional) and exactly one `agent "ID" { ... }`. An agent ID starts with a letter or digit, may contain `.`, `_`, `/`, and `-`, and is at most 120 characters long.

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

## 3. Agent properties and sub-blocks

A property is written `name = value`, or `name: value`. Single-valued properties and singleton sub-blocks can be declared only once, and a repeated declaration is an error.

| Property | Value | Description |
| --- | --- | --- |
| `description` | string | Capability summary, empty by default |
| `instructions` | string or triple-quoted block | System instructions; the `=` can be omitted (`instructions "..."`) |
| `engine` | `kernel`, `codex`, `claude`, `antigravity`, `dsh`, or `adapter/<name>` | Default `kernel`; an identifier or a string both work |
| `provider` | string | Default provider; when omitted, the provider of the first route is used, otherwise `default` |
| `model` | string | The model; when omitted, the model of the first route is used. At least one of `model` and `route` is required |
| `allow_graph` | boolean | Whether the model may generate execution graphs dynamically, default `true` (`allowGraph` is also accepted) |
| `approvals` | `ask` or `auto` | External agents only: mid-run permission requests are handed to you for approval (`ask`, the default) or approved automatically by publish policy (`auto`; for the risks see [protocol.md](protocol.md#approval-policy-for-external-agents-approval-policy-v1)); writing `auto` for a kernel agent is an error |
| `allowed_nodes` | array of strings | Node IDs that may be used (`allowedNodes` is also accepted) |
| `files` | array of strings | Relative paths published with the definition |
| `skills` | array of objects | Published skill descriptions, each `{ name, description, path }` |
| `output_schema` | type notation | The schema of the agent's final output (see "Type notation") |
| `limits` | object block | Run limits (see "limits") |

Sub-blocks and statements: `let`, `type`, `use builtin`, `route`, `tool`, `delegate`, and `flow` (which can also be written `workflow`).

```oaa
agent "agent/props" {
  description: "A colon and an equals sign are interchangeable"
  engine = kernel
  provider = "openai"
  model = "gpt-5"
  allow_graph = false
  allowed_nodes = ["node-a"]
  files = ["prompts/style.md"]
  skills = [{ name: "review", description: "Review", path: "skills/review/SKILL.md" }]
  output_schema { summary: string }
  instructions "Answer briefly."
}
```

Approval policy for an external agent:

```oaa
agent "agent/acp-auto" {
  engine = "adapter/acp"
  provider = "native"
  model = "default"
  approvals = auto
}
```

## 4. route, tool, delegate, and use builtin

### use builtin

Grants built-in tools: `read_file`, `write_file`, `list_files`, `read_skill`, `memory_read`, `memory_write`. You can write one at a time, or as a list.

```oaa
agent "agent/builtins" {
  model = "gpt-5"
  use builtin read_file
  use builtin [list_files, write_file]
}
```

### route

A model route. Inline form: `route ID -> model` or `route ID -> provider/model`, optionally followed by `priority=`, `cost=`, `speed=` (1–5), and `tags=[...]`. Block form: `route ID { provider model priority tags cost speed }` (`cost` can also be written `cost_tier` / `costTier`, and likewise `speed`). `priority` defaults to the ordinal of the route. A route without a provider uses the `provider` determined after the whole agent block has been parsed, regardless of the order of writing.

```oaa
agent "agent/routes" {
  route fast -> "openai"/"gpt-5-mini" priority=0 cost=1 speed=5 tags=["cheap"]
  route deep { model = "gpt-5", priority = 1, cost = 4 }
  provider = "openai"
}
```

### tool

Declares a tool provided by a node or a script. The keys in the block (snake_case is the canonical form, and camelCase still works):

| Key | Description |
| --- | --- |
| `node` | Binds to a node (`node_id` / `nodeId` are synonyms); if written, the tool is host-bound, otherwise portable |
| `script`, `runtime` | The script path and the runtime (`node` or `python3`, default `node`) |
| `reference` | The tool reference on the node, equal to the tool name by default |
| `capability`, `version`, `description` | The capability ID (default `custom/<tool name>`), the version (default `"1"`), and the description |
| `effect` | `read`, `idempotent-write`, `write`, or `unknown` (the default) |
| `approval` | Whether approval is required (`requiresApproval` is a synonym), default `false` |
| `timeout_ms`, `cache_ttl_ms` | The timeout (default 60 seconds) and the cache duration (default 0); `timeout` and `cache_ttl` are also accepted |
| `resource_key`, `result_export`, `required` | The resource key, whether the result is exported (default `true`), and whether it is required |
| `network { allowed_domains = [...] }` | Domains a sandboxed script may reach (`allowedDomains` is a synonym) |
| `params { ... }` | The type notation of the input parameters (`schema` and `input_schema` are synonyms) |

```oaa
agent "agent/tools" {
  model = "gpt-5"
  tool search {
    node = "node-a"
    description = "Full-text search"
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

There is also a complete binding form, `tool "name" = { ... }`, whose value is the complete `ToolBinding` contract (without the outer `name`); it is for cases the block form cannot express, such as rewriting the policy of a built-in tool:

```oaa
agent "agent/exact-binding" {
  model = "gpt-5"
  tool reviewed_read = {
    handler: { kind: "builtin", name: "read_file" }
    capability: {
      id: "builtin/read_file", version: "1", description: "A read that needs approval"
      placement: "portable", effect: "read", inputSchema: { type: "object" }
      requiresApproval: true, timeoutMs: 60000, cacheTtlMs: 0, resultExport: true
    }
    required: true
  }
}
```

### delegate

Delegates a subtask to another agent: `delegate name -> "agent-ID"`. You can use `@profile` to specify the other agent's route or semantic profile (it can also be written directly in the ID: `"agent/x@fast"`), and a block can follow: `agent`, `model`, `description`, `timeout` (`timeout_ms` / `timeoutMs` / `max_wait` are synonyms, default 120 seconds), and `forward_files` (default `false`).

```oaa
agent "agent/delegates" {
  model = "gpt-5"
  delegate ask_researcher -> "agent/research"@fast {
    description = "Look things up"
    timeout = 60s
    forward_files = true
  }
}
```

## 5. flow and steps

`flow name { ... }` declares a workflow macro that the model can call just like a tool. The block may contain:

- `params { ... }`: the input parameters (`schema` and `input_schema` are synonyms; it may be written only once); when omitted, there are no parameters.
- `description = "..."`: the description (only once).
- `step ...`: at least one step.
- `return value`: the projection of the final result (only once); when omitted, all step results are returned.
- `output_schema { ... }`: the schema of the result (only once).

A step is written `step ID = tool(argument = value, ...)`. The tool can be a name declared by `use builtin`, `tool`, or `delegate`, a flow declared earlier, or the built-in pure transform `$transform` (its result is its arguments). A step ID cannot be `input`; an ID that is not a plain identifier is quoted (`step "1a" = ...`).

An authored flow can declare up to 64 static steps. A model-generated `execute_graph` remains limited to 32. Before publication, the primary-item budget counts each non-loop step once and each loop at its declared `max_items`; the sum may not exceed 1,024. This does not increase tool concurrency or the run's tool-call allowance. Use upgraded gateways and workers when publishing a flow larger than 32 steps.

A step can be followed by modifiers, in any order, each at most once:

| Modifier | Description |
| --- | --- |
| `foreach variable in $reference (max=N)` | Runs once per list item; `max` defaults to 16 and is at most 32 |
| `when value` | A condition; it is evaluated once as a whole before the loop starts and cannot refer to the loop variable |
| `fallback tool(...)` / `fallback = value` | A fallback call or fallback value used on failure |
| `depends_on = ["step", ...]` | Explicit dependencies |
| `retry N` / `retry(N, backoff=duration)` | Retries up to N more times after a failure (1–3) |
| `timeout duration` | The timeout per attempt (100 milliseconds to 10 minutes); on expiry it reports `step_timeout` |

`retry` and `timeout` are allowed only on read-only or `idempotent-write` tools; otherwise compilation reports `unsafe_graph_retry`. While waiting for approval, when the run is cancelled, or when the outcome of a side effect is unknown, there is no retry, and the failure is not hidden by a fallback value.

```oaa
agent "agent/flows" {
  model = "gpt-5"
  use builtin [list_files, read_file]
  flow gather {
    description = "Read the first few files in a directory"
    params { dir: string limit?: int(default=4) }
    step listing = list_files(path = $input.dir) retry(2, backoff=200ms) timeout 30s
    step docs = read_file(path = $item) foreach item in $listing.files (max=8) fallback = "missing"
    step first = read_file(path = "{{listing.files.0}}") depends_on = ["listing"] when $listing.files
    output_schema { count: int first: any }
    return { count: $(len(listing.files)), first: $first }
  }
}
```

The block form `step "ID" { tool = "...", arguments = { ... } }` corresponds one to one with the step object in a JSON execution graph:

```oaa
agent "agent/step-block" {
  model = "gpt-5"
  use builtin read_file
  flow load {
    step "doc" { tool = "read_file", arguments = { path = "README.md" } }
  }
}
```

`return` is the final projection after the graph has run, not an early return: all steps still execute according to dependencies and approvals. It reduces the data that enters the next model round's context, while the complete step results and artifact references remain in the run record; it is not a privacy or authorization boundary. Referring to a step that does not exist, or using a `foreach` local variable in the final result, is an error before publishing.

## 6. Values and references

- Literals: strings, numbers, durations, `true` / `false` / `null`, arrays `[a, b]`, and objects `{ key = value }` or `{ key: value }` (commas may be omitted and keys may be quoted). A repeated key in an object is an error.
- Constant names are expanded in value positions (see "Constants and interpolation").
- In a flow:
  - `$step`, `$step.a.b`, and `$step#/a/b` are references to step results; `$input.x` refers to the flow input; `$item`, `$index`, and the `foreach` variable refer to the loop item. A reference may be followed by `default = value`.
  - `$( ... )` is a safe expression, for example `$(slice(doc.text, 0, 200))`. In expressions (and templates), `input` and `$input` are equivalent and both mean the flow input, creating no dependency on a step; this holds only in a flow, and an `execute_graph` the model initiates directly has no flow input. If a flow published directly as JSON has a step named `input`, the step wins.
  - A string containing `{{...}}` is a template, for example `"{{$input.prefix}}:{{doc.title}}"`; to write ordinary text that contains `{{`, use `literal("...")` (it accepts only a string).
  - An explicit JSON descriptor `{ "$ref": "doc#/text", "$default": "none" }` is kept as is and is no longer parsed as shorthand.
  - In `$(input.limit ?? 10)`, use 10 only when the field is missing or null. The operator returns the value itself, preserving 0, false and empty strings, and does not evaluate an unused default. Both operands are still checked at compile time. It binds below `||` and above `? :`; parenthesize mixed expressions for readability. Older runtimes need an upgrade before using this syntax.

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
      exact = { "$ref": "doc#/text", "$default": "none" }
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

## 7. Type notation

Used in `params`, `output_schema`, and `type` aliases, and compiled to JSON Schema:

- Basic types: `string` (`str`), `int` (`integer`), `number` (`float`), `bool` (`boolean`), `object` (`json`), and `any`, case-insensitive.
- Modifiers: `string("description", min=1, max=200, pattern="^a")`, `int(min=0, max=9, default=3)`. `min` / `max` apply only to strings (length) and numbers, `pattern` only to strings, the value of `default` must match the type, and `enum` must be an array; any other modifier is an error.
- Arrays: add `[]` after a type; they can be stacked (`int[][]`).
- Literal unions: `"fast" | "deep"` or `1 | 2 | 3`; strings and numbers cannot be mixed.
- Objects: `{ field: type  optional_field?: type }`; a field with a `default` is also not required.
- Aliases: `type Name = type`, expanded at compile time only; the name cannot be the same as a built-in type (case-insensitive) and cannot be declared twice.
- Arbitrary JSON Schema: `json { ... }` (a schema object starting with `type = "..."` can also be written directly).

```oaa
type Mode = "fast" | "deep"

agent "agent/types" {
  model = "gpt-5"
  type Excerpt = string("Excerpt", max=2000)
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

| Key | Default | Range | Synonyms |
| --- | --- | --- | --- |
| `max_turns` | 16 | 1–100 | `maxTurns` |
| `max_output_tokens` | 4096 | 1–100000 | `maxOutputTokens` |
| `timeout_ms` | 1800000 (30 minutes) | 100 milliseconds–1 hour | `timeout`, `timeoutMs`, `wall_ms` |
| `tool_concurrency` | 4 | 1–32 | `toolConcurrency` |
| `max_total_tokens` | 200000 | 1–10000000 | `maxTotalTokens` |

An unknown key is an error (with a suggestion); a value out of range reports `oaa_validation_error`, with the location pointing at that line.

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

## 9. Formatting and diagnostics

`oaa fmt` (`formatOaaLang`) regenerates the source from the compiled output, and the result must, after recompiling, be exactly identical to the original definition, otherwise output is refused (`oaa_roundtrip_error`). The rules:

- `let` constants are kept (declarations go at the start of the file; when the value of `description`, `model`, or `provider` is exactly equal to a string constant, the constant name is written) and so are `type` aliases (the alias name is written where it is used).
- Parameters and output schemas use type notation, and what it cannot express is written as `json { ... }`.
- A multi-line `instructions` is output as a triple-quoted block; content that contains `\r`, `"""`, `${`, or that would be changed by removing indentation is still written as a JSON string.
- Consecutive `use builtin` lines are merged into a list; custom tools are output as snake_case `tool "name" { ... }` blocks, and as a complete binding when the block form cannot express them.
- References, expressions, and templates are restored to shorthand; unsafe step IDs are quoted.
- Candidate forms are tried from the most refined to the plainest, and the first one that passes the comparison is taken; comments are lost. The formatted result is idempotent with respect to itself.

`oaa check` (`diagnoseOaaLang`, `POST /v1/lang/compile`) returns a list of diagnostics:

- An error carries `line` / `col` and an error code: `oaa_syntax_error` (syntax and static checks), `oaa_validation_error` (a value does not match the agent contract), or the original error code of execution graph validation (such as `invalid_graph`, `unsafe_graph_retry`).
- Misspelling errors carry the closest spelling (`Did you mean 'description'?`), and several independent misspelling errors are reported at once (up to 8); for a structural error such as a missing parenthesis only the first is reported.
- When a program compiles but formatting fails, it is still judged valid, and the formatting problem is downgraded to a warning.
- There are also hints: an empty description, empty instructions for the kernel engine, only one route, and the number of topological layers and the maximum parallel width of each flow.

`workflow-output-v1` and `oaa-lang-roundtrip-v1` in `GET /health` indicate that the gateway supports workflow result projection and formatting round-trip comparison.

## Upgrade notes (0.2.0)

This version makes the compiler report clear errors for constructs that used to "happen to compile" or crash, and unifies several pieces of syntax. All the new errors carry a `Line N, Col M:` position; the compiled output of valid programs is unchanged (formatted output changes; see the last rows of the table).

| Construct | Previous behavior | Now |
| --- | --- | --- |
| `route r null`, `limits = null`, `limits = [1]` | Threw `TypeError` (`execution_failed`, no position) | `oaa_syntax_error`: `Route 'r' must be '-> provider/model' or an object block.` / `'limits' must be an object block.` |
| After `let read_file = "write_file"`, writing `use builtin read_file`; after `let path = "zzz"`, writing `path = ...` as an argument key | The constant replaced the identifier: `write_file` was actually granted and the key became `zzz` | A constant is expanded only in value positions (property values, argument values, values in arrays and objects, `${}` interpolation, route / delegate targets); key names, tool names, the names and IDs of tools / flows / steps / routes / delegates, type names, and the value of `engine` are no longer replaced |
| A program that compiles but fails to format (such as `step "1a" = ...`) | `diagnoseOaaLang` judged it invalid, with the line number taken from the formatted source | The program is judged valid; a formatting failure is downgraded to a warning; the formatter quotes unsafe step IDs |
| Contract validation failure (such as `max_turns = 0`, `engine = "nope"`, `route ... cost=9`) | `execution_failed` plus raw Zod JSON, no position | `oaa_validation_error`, one sentence of explanation, with the position pointing at the corresponding declaration or key (such as the `max_turns` line in the `limits` block); when it cannot be mapped, it points at the agent declaration |
| Execution graph validation failure (a reference to a nonexistent step, and so on) | The original error code, no position | The original error code is unchanged, with the position of the owning step (the step mentioned in the error) or flow declaration prepended before the error |
| Repeated declarations: `description`, `model`, `instructions`, `limits`, `engine`, `provider`, `output_schema`, `allow_graph`, `allowed_nodes`, `files`, `skills`, a `let` of the same name; `params` / `description` in a flow; `when` / `fallback` / `depends_on` on a step | The later one silently overwrote the earlier | `Duplicate '...' declaration.` / `Duplicate constant 'x'.` / `Duplicate 'when' modifier.` and so on |
| An unknown key in a `delegate` block (`timout`), `foreach (maxx=3)`, an unknown type modifier (`string(foo=1)`) | Silently ignored, or written into the schema as is | `Unknown property` / `Unknown foreach option` / `Unknown type modifier`, with a "Did you mean" suggestion |
| A modifier that does not fit the type: `bool(min=1)`, `int(default="x")`, `string(pattern=1)`; a mixed literal union `"x" \| 1` | Generated an inconsistent schema | `Type modifier 'min' does not apply to type 'bool'.`, `Type modifier 'default' does not match type 'int'.`, `A union type cannot mix string and number literals.` |
| A property value of the wrong type: `description = { ... }`, `model = 5`, `files = [1, 2]`, a flow's `description = 5` | Coerced by `String(...)` | `'description' must be a string.`, `'files' must be an array of relative paths.` and so on |
| An alias with the same name as a built-in type (case-insensitive): `type Str = int`, `type STRING = int` | `Str` could be declared | `would shadow a built-in type` |
| A step named `input` | Compiled, and was confused with the flow input `$input` | `A step cannot be named 'input'` |
| Numbers such as `1e400` | Split into the number `1` plus the identifier `e400` | Scientific notation (`1e3`) is supported; out of range reports `Numeric literal '1e400' is out of range.` |
| A `route` written before `provider =` | The provider of that route was `default`, and the result depended on declaration order | The default provider is determined only after the whole agent block has been parsed; the output of programs that already wrote `provider` first is unchanged |
| An agent-level property written as `description: "x"` | Reported `Expected =` | Equivalent to `=` |
| `network { allowed_domains = [...] }` in a `tool` | `allowed_domains` was not recognized, and contract validation failed | Equivalent to `allowedDomains`; snake_case is the canonical form |
| Writing `$constant` in a flow (where the constant is not a step name) | Reported "refers to a nonexistent step" | Resolves to the constant's value; `$constant.field` is an error that explains a constant cannot have a path |
| The output of `oaa fmt` | Dropped `let`, wrote a multi-line instruction as a one-line JSON string, one line per `use builtin`, and wrote custom tools as complete camelCase bindings | Keeps `let`, uses triple quotes for multi-line instructions, merges consecutive `use builtin` into a list, and writes custom tools as snake_case blocks; warns when the source has comments |

`${nonexistent_constant}` is still kept as literal text and is not an error: `${…}` appearing in description text is a legitimate need.
