# Model providers and `oaa connect <preset>`

English · [简体中文](zh-CN/models.md)

The built-in agent (the gateway's own agent loop, `engine = kernel`) is the most capable kind of
agent: caller-tool bridging, the structured-output repair round and image input are all defined
against it. It needs a model provider. One command sets one up and publishes a ready agent:

```bash
oaa connect ollama                                   # a local model, no key
oaa connect deepseek --key-file ~/.config/deepseek.key
oaa connect openai --key-env OPENAI_API_KEY --model <model>
```

After it finishes you have `agent/assistant`, a general assistant with the workspace file tools
(`list_files`, `read_file`, `write_file`), and a `curl` line you can paste. `oaa connect` with no
target lists the external agents found on this machine and every model preset.

## What `oaa connect <preset>` does

1. **Model.** For a local service (loopback address) it asks the service for its model list
   (`GET <baseUrl>/models`, sent only to 127.0.0.1) and picks the only model or the one given with
   `--model`. When nothing answers it says so in both languages: the service is not running or uses
   another port, and how to pass `--base-url`. For a hosted service the model comes from `--model`
   (or the preset's single suggestion); nothing is sent to it.
2. **Provider.** It writes `localWorker.providers.<name>` into `.oaa/config.json` (name = preset, or
   `--name`). An identical entry is left alone; a different entry with the same name is refused
   (`provider_conflict`), never overwritten. Only a *reference* to the key is stored.
3. **Gateway.** Providers are read when the gateway starts, so a new provider needs a restart. If
   the gateway was started from this data directory (`oaa quickstart`, `oaa serve --detach`), connect
   restarts it; if none is running it starts one; if another program owns the port (for example the
   desktop app), connect leaves it alone and tells you to restart it yourself.
4. **Agent.** It publishes `examples/assistant.oaa` with the route pointed at the provider and model
   (`--agent` changes the name, `--definition FILE.oaa` publishes your own file; its
   `default/"configure-your-model"` route is rewritten the same way). An agent of the same name on
   another engine or provider is refused (`agent_conflict`).
5. **Key and call.** It checks that the quickstart caller key can call the agent (or creates a key
   for this agent only) and prints the model name, the base URL and a `curl`.

It is idempotent: running it again changes nothing and reuses the key. **It never calls a model**,
because a hosted call costs money. Add `--test` to send one minimal request through the gateway;
this is only done when the endpoint is on the loopback interface.

## Keys

A key is never accepted on the command line or typed in (it would end up in shell history):

- `--key-env NAME` stores the *name* of an environment variable. The gateway process reads it when
  it starts, so the variable must be set in the environment that starts the gateway. A gateway that
  connect or `oaa serve` starts from your terminal inherits that terminal's variables; the desktop
  app, a service manager or a gateway someone else started does not. Changing the variable needs a
  gateway restart.
- `--key-file FILE` stores the file's absolute path (`apiKeyFile`). connect checks that it is a
  regular file (no directories, links or devices), at most 8 KiB, holds one line, and on macOS and
  Linux that only you can read it (`chmod 600`). The gateway reads the file on every call, so
  rotating the key needs no restart. The content is never printed, logged or copied into the
  configuration; error messages name the path only.
- Local presets (`ollama`, `lmstudio`) need no key (`noApiKey: true`, no auth header is sent).

## Presets

Every endpoint and difference below was checked against the service's own documentation
(November 2026). Addresses are fixed in the code and never fetched from the network. Model names
change often, so a preset keeps at most one suggestion and `--model` always wins.

| Preset | Service | Protocol | Base URL | Key variable | Known differences set by the preset | Suggested model |
| --- | --- | --- | --- | --- | --- | --- |
| `ollama` | Ollama (local) | openai-chat | `http://127.0.0.1:11434/v1` | none | `max_tokens`; images inline (base64) | from the local list |
| `lmstudio` | LM Studio (local) | openai-chat | `http://127.0.0.1:1234/v1` | none | `max_tokens`; no images | from the local list |
| `openai-compatible` | any OpenAI-compatible endpoint | openai-chat | `--base-url` | `--key-env`/`--key-file`, else keyless | `max_tokens`; no stream usage; no images | `--model` |
| `openai` | OpenAI | openai-responses | `https://api.openai.com/v1` | `OPENAI_API_KEY` | none | `--model` |
| `anthropic` | Anthropic | anthropic-messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | `anthropic-version: 2023-06-01` | `claude-sonnet-5-5` |
| `gemini-api` | Google Gemini API | gemini-generate | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` | `x-goog-api-key` header | `--model` |
| `openrouter` | OpenRouter | openai-chat | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `max_tokens` | `--model` |
| `deepseek` | DeepSeek | openai-chat | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `max_tokens` | `deepseek-flash` |
| `moonshot` | Moonshot (Kimi) | openai-chat | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | `max_tokens`; no stream usage; no images | `--model` |
| `zhipu` | Zhipu (BigModel) | openai-chat | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | `max_tokens`; no stream usage; no images | `glm-5.3` |
| `siliconflow` | SiliconFlow | openai-chat | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | `max_tokens`; no stream usage; no images | `--model` |
| `groq` | Groq | openai-chat | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `max_completion_tokens` (`max_tokens` is deprecated there); no stream usage | `--model` |
| `together` | Together AI | openai-chat | `https://api.together.ai/v1` | `TOGETHER_API_KEY` | `max_tokens`; no stream usage | `--model` |
| `mistral` | Mistral AI | openai-chat | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `max_tokens`; no stream usage; no images | `--model` |

"No stream usage" means the documentation does not promise `stream_options.include_usage`, so the
preset leaves it out (`streamUsage: false`); runs still work, token counts are then not reported.
"No images" means the preset keeps image input off (`imageInput: "none"`) because the
documentation does not describe image input for this endpoint in a way the gateway could rely on;
set `imageInput` yourself when you use a vision model.

Preset names never clash with external agents: `gemini` stays the Gemini CLI (ACP), `kimi`, `qwen`
and `glm` stay the ACP presets of those tools, hence `gemini-api`, `moonshot` and `zhipu` here.

**Not included:** Alibaba Cloud Model Studio (Bailian / Qwen). Its current documentation gives an
endpoint that contains your own workspace ID (`https://{WorkspaceId}.<region>.maas.aliyuncs.com/compatible-mode/v1`),
so there is no fixed address to put in a preset, and it says tools cannot yet be combined with
`stream=true`, while the built-in agent always streams. Use `openai-compatible --base-url …` with
your workspace address if your models accept streamed tool calls.

## Provider settings

`localWorker.providers.<name>` (and a worker's `providers`) accepts:

| Field | Meaning |
| --- | --- |
| `kind` | `openai-chat`, `openai-responses`, `anthropic-messages`, `gemini-generate` |
| `baseUrl` | Endpoint; anything off the loopback interface must be https |
| `apiKeyEnv` | Environment variable holding the key (default `OPENAI_API_KEY`) |
| `apiKeyFile` | New. File holding the key; read on each call; wins over `apiKeyEnv` |
| `noApiKey` | New. `true`: the endpoint needs no key and no auth header is sent |
| `maxTokensField` | `max_completion_tokens` (default) or `max_tokens` |
| `streamUsage` | New. `false`: do not send `stream_options.include_usage` |
| `imageInput` | `none`, `inline` or `url` ([images.md](images.md)) |
| `preset` | New. The preset the entry came from (informational) |
| `byok`, `timeoutMs`, `anthropicVersion` | Unchanged |

## `oaa models`

```bash
oaa models [--dir .oaa] [--check] [--json]
```

Lists the configured providers: protocol, endpoint, where the key comes from and whether it
resolves (as seen by the running gateway when there is one, otherwise by this terminal), whether
the endpoint answers, its models, and which agents use it. Loopback endpoints are probed
automatically. Hosted endpoints are only contacted with `--check`, and then only their model-list
endpoint is requested (no generation, no token cost).

## When a run fails

Errors name the provider, its endpoint and what to change:

| Code | Cause | Fix |
| --- | --- | --- |
| `model_not_configured` | the key reference does not resolve in the gateway process | set the variable and restart, or fix the key file |
| `upstream_auth_failed` | HTTP 401/403 | wrong key, wrong region or missing permission |
| `upstream_model_not_found` | HTTP 404 or "model does not exist" | fix the model name (`oaa models --check`) or `baseUrl` |
| `upstream_incompatible` | HTTP 400/422 naming a field | the message names the setting: `maxTokensField`, `streamUsage`, `imageInput`, or a model with tool support |
| `upstream_rate_limited` | HTTP 429 | retry later or check your quota |

The upstream response body is only inspected to classify the failure; it is never copied into the
message a caller sees.

## Agent Model Catalogs and Orchestration

`GET /v1/agents/models?agent=<id>` and MCP `oaa_list_models` provide a bounded runtime catalog. Keep `revision` for subsequent `offset` pages. This is separate from the immutable, version-pinned declared routes. A key's optional `connection.audience:"external"` marks an untrusted caller: it cannot grant host execution, owner-wide data, administration, or private-agent execution. The console distinguishes it from trusted personal keys.

External agents do not need another model-provider key. OAA queries their own programmatic interfaces: Antigravity `models`, Codex app-server `model/list`, Claude Agent SDK `supportedModels()`, and ACP session model configuration. It neither intercepts upstream traffic nor extracts the agent's credentials. DSH's explicit mappings are **configured**, not account discovery; unsupported adapters return an explicit unsupported state.

Owner administrators use `GET /v1/local/backends/{engine}/models` (`adapter/name` must be URL-encoded); `?refresh=true` refreshes it. Catalogs are cached for five minutes with a 15-second discovery deadline. A private on-disk cache survives restarts as stale evidence. Failed refreshes retain the last actual list, never substitute built-in model names. `ready` means discovery succeeded, **not** that each model's quota or a real task was verified.

`POST /v1/agents/publish-native` accepts these optional fields (bundle definitions use `modelPolicy` instead of `model_policy`):

```json
{
  "id": "agent/my-native",
  "engine": "antigravity",
  "models": ["default"],
  "model_policy": {"mode": "discover"},
  "access": {"modes": ["managed", "hybrid"], "defaultMode": "managed", "approval": "owner", "trust": "private"},
  "orchestration": {"enabled": true, "helpers": []}
}
```

- Discovery follows the agent's catalog; optional `allow` restricts it. Declared defaults/routes must also be inside that allowlist. Existing publications without these fields keep their previous behavior.
- Standard model lists expose `agent/name`, `agent/name@<route-id>`, and `@fast`, `@best`, `@eco`. Use returned identifiers rather than guessing account model names. Selecting an explicit model does not start orchestration or silently substitute another model.
- Key creation accepts `connection: {toolMode, allowedModes, models}`. `models` maps agent IDs to default selectors; it is a preference, not a model permission restriction. Explicit client selections override it. Tool grants remain a ceiling; a `hybrid` grant also permits either narrower execution location.
- Orchestration uses the already connected agents for planning and review. It snapshots the admitted model pool, validates the plan's agent/model grants, runs at most two independent analyses concurrently, serializes main execution, and performs bounded review/correction. Helpers require both publication opt-in and caller authorization. No combination-publication product is required.
- Planning, analysis and review use a tool-restricted reasoning path with the full output schema in the request. Evidence is supplied as bounded text excerpts, not by granting these stages arbitrary filesystem access. This currently supports kernel agents, Antigravity's per-session deny policy and Claude's empty-tool SDK mode; other native/adapter entries do not offer multi-model planning until an enforceable restriction is implemented. This does not turn an external process into an OS sandbox.
- Default limits are smart: 8 stages/15 minutes; speed: 3/5; quality: 12/30; economy: 4/10. Publication `maxStages` and `timeoutMs` can override them. Simple tasks can use one model. Limits are outer execution limits, not enforceable upstream token or currency guarantees.
- Routing uses observations and explicitly declared `costTier`, `speedTier`, `qualityTier`; it no longer guesses price or quality from model-name fragments. Unknown evidence remains unknown. `oaa.review_source: "agent"` distinguishes an agent's review from independent verification.
- Plans, child references, confirmed results and usage are checkpointed. Unknown external writes are not automatically replayed. Disconnecting does not cancel an accepted task. Model changes on new publications carry portable history and files, not incompatible native hidden state; clients without session identifiers use their supplied history, not guessed session matching.

OAA-Lang preserves these settings as `model_policy = {...}`, `access = {...}`, `orchestration = {...}` and route `quality=...`. Worker additions are feature-negotiated (`model-catalog-v1`, `agent-policy-v1`); old workers are not selected for policies they cannot enforce.

## Console

In **Publish agent → OAA-Lang 2.0** a "Model provider" list shows the configured providers; picking
one rewrites the provider of every `route` line. Agent cards of built-in agents show the provider
in use and, marked for attention, when its key does not resolve in the gateway process.

## Security

- `--base-url` accepts only http and https, without credentials, query or fragment; anything off the
  loopback interface must be https. There is no switch to relax this: the gateway's model drivers
  refuse plain-http remote endpoints anyway.
- Preset addresses are part of the code; nothing is downloaded.
- With `security.profile: public` nothing changes: providers remain administrator configuration.

These presets were checked against documentation and exercised against fake services only. Real
services can change; if one stops working, `oaa models --check` and the error code above tell you
which setting to adjust.
