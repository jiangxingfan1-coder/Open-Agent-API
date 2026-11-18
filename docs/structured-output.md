# Structured output

English · [简体中文](zh-CN/structured-output.md)

When a caller asks for structure, a successful response means the answer **is** that structure: JSON that parses and fits the schema. If the gateway cannot get there, the run fails with a clear error instead of returning text that only looks like what was asked for. This page is the exact contract; the lab that checks it with the official SDK helpers is described in [compatibility.md](compatibility.md).

## How to ask

| Entry | Field | Forms |
|---|---|---|
| Chat Completions (`/v1/chat/completions`, `/v1/compat/chat/completions`) | `response_format` | `{"type":"json_object"}`; `{"type":"json_schema","json_schema":{"name","schema","strict"}}` |
| Responses (`/v1/responses`, `/v1/compat/responses`) | `text.format` | `{"type":"json_object"}`; `{"type":"json_schema","name","schema","strict"}` |
| Gemini `generateContent` | `generationConfig.responseMimeType: "application/json"` | with `responseSchema` (the OpenAPI subset the SDKs send, uppercase types), with `responseJsonSchema` (plain JSON Schema), or alone (any JSON) |
| Claude Messages | `output_config.format` | `{"type":"json_schema","schema":{...}}` (the field of the official SDKs, TypeScript 1.3 and Python 2.8) |

`text` / `text/plain` formats mean no contract, as before. Gemini `text/x.enum` is refused (`invalid_request`). Both OpenAI endpoints accept the fields; the default endpoints no longer refuse them. `strict` is recorded and echoed, but it adds nothing to the check: what is enforced is the schema itself, so write `required` and `additionalProperties: false` in it if you want them.

## What the gateway guarantees

1. **The answer is held back while the agent works.** Nothing of an attempt that may turn out wrong is written to the run's output or sent to a stream.
2. **The final answer is unwrapped, parsed and validated.** Code fences, a sentence before or after the JSON, and whitespace are not part of the answer: the gateway takes the whole text, else a fenced block, else the outermost braces or brackets, and parses the first form that is JSON. `json_object` needs a JSON object; `json_schema` is validated with Ajv (draft-07, 2019-09 and 2020-12; `format` is enforced through ajv-formats, which the MCP SDK already brings in).
3. **A good answer is returned normalized**: compact JSON, no fence, no explanation, written out in one piece. Chat: `message.content`; Responses: the output text, and the response's `text.format` echoes your format object; Claude: the text block; Gemini: the text part.
4. **A wrong answer is sent back for correction** (below). Still wrong after the rounds: the run fails with `structured_output_invalid` (HTTP 422 with `x-should-retry: false` on Chat, Claude and Gemini; on Responses a `failed` response with the error code, as for every failed run). The message names the first problem and never quotes the answer.
5. **A schema that cannot be enforced honestly is refused when the request arrives** (below); no run is created.

## Correction rounds

* **Kernel agents**: the wrong answer stays in the conversation and a user message follows it (it starts with `[Structured output repair]`, names the problem, shows a shortened copy of the answer and asks for the corrected JSON only). The model takes one more turn; turns and token usage are counted like any other turn.
* **External agents** (ACP, Codex, Claude Code, Antigravity): only when their session can be continued, because asking again must not redo the work: an ACP agent that advertises `loadSession` / `resumeSession`, or a native engine that returned a session or thread handle. The prompt goes to the same session, as its own step; usage adds up. A2A and HTTP adapters, and ACP agents that cannot load a session, are **not** asked again: the run fails, and the message says so.
* **How many**: the gateway setting `structuredOutput.maxRepairs` (0 to 3, default 1). `0` fails at the first wrong answer. The count already spent is kept in the run, so a run that is resumed after an approval or a restart does not start over.
* `metadata["oaa.output_contract"]` (`json_object`, `json_any` or `json_schema`) and `metadata["oaa.output_repairs"]` are written to the run; the console's task inspector shows both next to the usage, and `GET /v1/runs/{id}/state` has `output_contract: {kind, repairs}`.

## What is refused at request time

| Code | When |
|---|---|
| `invalid_schema` (400) | the schema is missing, larger than 64 KiB, or does not compile |
| `schema_dialect_unsupported` (400) | `$schema` is not draft-07, 2019-09 or 2020-12; `$async` |
| `output_schema_unsupported` (400) | something Ajv would silently skip or that could hurt the gateway: a `$ref` that points outside the document, a `format` that nobody implements (the standard names of ajv-formats are all enforced), a `pattern` or `patternProperties` key longer than 256 characters or with nested quantifiers such as `(a+)+`, nesting deeper than 40 levels |
| `invalid_request` (400) | `response_format.type`, `text.format.type` or `responseMimeType` is not one of the supported values, `json_schema` without a schema |

`error.param` names the field that holds the problem (for example `response_format.json_schema.schema`). Nothing is checked "as far as possible": a contract that is not enforced would be worse than none.

## Streaming

By default (when `structuredOutput.maxRepairs > 0` or the schema is not pushed down as a strict provider-native schema), a stream holds the answer while the agent generates it so that a piece from an invalid attempt is never emitted before silent repair: the gateway validates the final JSON and sends it as **one** text chunk in that protocol's normal event sequence (while waiting, `: heartbeat` frames every 15 seconds keep the connection alive; a failed answer ends the stream with the protocol's error and no content before it). When a kernel route pushes a compatible strict `json_schema` down natively to the model driver and `structuredOutput.maxRepairs === 0`, token deltas stream straight through and Ajv still asserts the completed output before closing. Use a non-streaming call or `background: true` when you cannot hold a connection open.

## Next to other features

* **Caller tools (bridge)**: tool rounds come first, only the last answer is checked. The text before a tool call is not output. The contract belongs to the run, so the follow-up request that returns tool results continues the same run under the same contract.
* **Approvals, resume, restart**: the run waits as usual; the contract and the number of corrections spent are in its checkpoint.
* **Cancel**: the run ends `cancelled` with no output.
* **Truncation** (`max_tokens` / `max_output_tokens` reached): the run ends `incomplete` as before, with no output, since a cut-off answer cannot be checked.
* **Fallback agents** (`oaa.agent_fallback`) work as before; they apply before any output exists.
* **Published `outputSchema`** of an agent still applies after the caller's contract; failing it is `output_contract` as before.

## Native pushdown and boundaries

* **Native schema pushdown with graceful fallback**: for kernel agents, compatible contracts are pushed down to all four model drivers (`response_format` on OpenAI Chat, `text.format` on OpenAI Responses, `output_config.format` on Anthropic Messages, `generationConfig.responseMimeType = "application/json"` plus `responseSchema` / `responseJsonSchema` on Gemini) during the final answer turn (when caller tools are forced first, `toolChoice` runs in the tool turn and `outputContract` activates for the final answer). Schemas outside a provider's strict subset (such as free-form objects rejected by strict mode) automatically degrade to prompt guidance plus gateway Ajv validation instead of failing with an upstream 400.
* `json_object` accepts objects only; a top-level array needs `json_schema` (or Gemini's plain JSON mime type).
* `strict` is forwarded on compatible native `json_schema` pushdown and echoed; gateway validation always enforces the schema itself.
* **Forced tool calls (`tool_choice`)**: callers that extract structure via a forced tool call (such as LangChain `with_structured_output(method="function_calling")` or `@ai-sdk/anthropic` in `jsonTool` mode) are supported on bridged agents (`kernel`, `codex`, `claude`, Antigravity ACP, and ACP adapters; see [harness.md](harness.md)): kernel drivers push `tool_choice` down natively on the first turn and converge back to `auto` on continuation, while external bridged agents enforce a prompt constraint plus up to 1 continuation repair round (returning 422 `tool_choice_unmet` if still unmet).

## Example

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $OAA_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "agent/sample",
    "messages": [{"role": "user", "content": "Who wrote Hamlet? Reply as JSON."}],
    "response_format": {"type": "json_schema", "json_schema": {
      "name": "author", "strict": true,
      "schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"], "additionalProperties": false}}}
  }'
```

With the official SDKs the helpers work unchanged: `client.chat.completions.parse(..., response_format=Model)` and `client.responses.parse(..., text_format=Model)` (OpenAI), `messages.parse(..., output_format=Model)` (Anthropic), `response_schema=Model` with `response_mime_type="application/json"` (Gemini), `generateObject` (Vercel AI SDK), `with_structured_output(Model, method="json_schema")` (LangChain).
