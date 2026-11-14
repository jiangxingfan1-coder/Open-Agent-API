# Cookbook

English · [简体中文](README.zh-CN.md)

Copy-and-run examples for calling an agent through Open Agent API, organised by what you want to do. Every example is one file; its first lines say what it shows, what it needs and how to run it. They use curl, and the official `openai`, `anthropic` and `google-genai` SDKs for Python and Node. None of them contains a key: they read the environment.

Every runnable example is also run automatically by the [compatibility lab](../../docs/compatibility.md#the-compatibility-lab) (`npm run compat`) against an isolated gateway, with its exit code and key output asserted, so a change that breaks an example fails the build. The files and the scenarios that run them: [`integrations/compat/cookbook.mjs`](../../integrations/compat/cookbook.mjs).

## Before you start

Three variables, the same for every example:

| Variable | Meaning | Default |
|---|---|---|
| `OAA_BASE_URL` | the gateway address, without a path | `http://127.0.0.1:8787` |
| `OAA_API_KEY` | a caller key (`sk-oaa-…`) | none, required |
| `OAA_AGENT` | the agent name, exactly as `GET /v1/models` lists it | `agent/sample` |

`OAA_PROMPT` (and `OAA_LONG_PROMPT` in the long-task example) optionally replaces the task text.

```bash
oaa quickstart                                        # starts a local gateway and publishes agent/sample
export OAA_API_KEY="$(cat .oaa/keys/quickstart.key)"  # a caller key: invoke, read, files and approve
```

The key that `oaa quickstart` writes can call every agent and decide approvals. Webhooks (recipe 3) can only be configured with the admin key: `export OAA_ADMIN_KEY="$(cat .oaa/admin.token)"`.

Install the SDKs you use (nothing else is needed; the curl examples only need `curl`):

```bash
pip install openai anthropic google-genai
npm install openai @anthropic-ai/sdk @google/genai
```

Name your own script anything but `openai.py` or `anthropic.py`: a Python file with the name of the package it imports hides the package. That is why the examples are called `hello_openai.py`, `tools_genai.py` and so on.

## The recipes

| I want to… (opens the folder) | curl | Python | Node |
|---|---|---|---|
| [make my first call, blocking and streaming, on all three protocols](01-first-call/) | [`hello.sh`](01-first-call/hello.sh) | [OpenAI](01-first-call/hello_openai.py), [Anthropic](01-first-call/hello_anthropic.py), [Gemini](01-first-call/hello_genai.py) | [OpenAI](01-first-call/hello_openai.mjs), [Anthropic](01-first-call/hello_anthropic.mjs), [Gemini](01-first-call/hello_genai.mjs) |
| [run a long task in the background, poll it, cancel it, continue it with `previous_response_id`](02-long-running/) | [`long_task.sh`](02-long-running/long_task.sh) | [`long_task_openai.py`](02-long-running/long_task_openai.py) | [`long_task_openai.mjs`](02-long-running/long_task_openai.mjs) |
| [find a task that waits for approval and approve or deny it through the API](03-approvals/) | [`approve.sh`](03-approvals/approve.sh) | [`approve_openai.py`](03-approvals/approve_openai.py) | [`approve_openai.mjs`](03-approvals/approve_openai.mjs) |
| [be told by an event callback that a task needs approval, and approve it from the handler](03-approvals/) | | | [`webhook_approve.mjs`](03-approvals/webhook_approve.mjs) (and [`examples/webhook-receiver.mjs`](../webhook-receiver.mjs)) |
| [let the agent call a function in my program (a tool loop)](04-caller-tools/) | | [OpenAI](04-caller-tools/tools_openai.py), [Anthropic](04-caller-tools/tools_anthropic.py), [Gemini](04-caller-tools/tools_genai.py) | [OpenAI](04-caller-tools/tools_openai.mjs), [Anthropic](04-caller-tools/tools_anthropic.mjs), [Gemini](04-caller-tools/tools_genai.mjs) |
| [get JSON that fits a schema, and handle the case where it cannot](05-structured-output/) | [`structured.sh`](05-structured-output/structured.sh) | [OpenAI](05-structured-output/structured_openai.py), [Anthropic](05-structured-output/structured_anthropic.py), [Gemini](05-structured-output/structured_genai.py) | [OpenAI](05-structured-output/structured_openai.mjs) |
| [send a local image to the agent](06-images/) | [`image.sh`](06-images/image.sh) | [OpenAI](06-images/image_openai.py), [Anthropic](06-images/image_anthropic.py), [Gemini](06-images/image_genai.py) | [OpenAI](06-images/image_openai.mjs), [Anthropic](06-images/image_anthropic.mjs), [Gemini](06-images/image_genai.mjs) |
| [tell retryable errors from the others, and retry without starting a second run](07-errors-and-retries/) | [`errors.sh`](07-errors-and-retries/errors.sh) | [`retries_openai.py`](07-errors-and-retries/retries_openai.py) | [`retries_openai.mjs`](07-errors-and-retries/retries_openai.mjs) |
| [connect the gateway to tools I already use](08-connect-tools/) | | [`env_check.py`](08-connect-tools/env_check.py) | [`env_check.mjs`](08-connect-tools/env_check.mjs) |

Run one the way its first lines say, for example:

```bash
python 01-first-call/hello_openai.py
node 04-caller-tools/tools_anthropic.mjs
sh 05-structured-output/structured.sh
```

## What the offline sample agent can and cannot show

`agent/sample` ([`examples/sample-agent.mjs`](../sample-agent.mjs)) calls no model: it is an ACP process that answers with fixed text, makes one fake tool call, and asks for one approval when the task contains "approve". It is the right agent to try the examples without a model key, and it shows some recipes and not others. A built-in (kernel) agent with a model key, or a real external agent, shows all of them.

| Recipe | With `agent/sample` | Needs |
|---|---|---|
| 1 first call | works; the answer is the fixed text | any agent |
| 2 long task | background and polling work. A cancel ends the run `incomplete` with `effect_outcome_unknown` (an external agent stopped in the middle of a step: the gateway cannot know what it did). Continuing with `previous_response_id` is refused with `native_resume_unsupported`, because its ACP process declares neither `session/load` nor `session/resume` | a built-in agent for a clean `cancelled` and for continuation |
| 3 approvals | works: the task text contains "approve", so it asks to write a file. Approve completes the run, deny fails it with `permission_denied` | an agent that asks for approval |
| 4 caller tools | cannot be shown: it accepts your tools but never calls them (the examples exit with code 3 and say so) | a built-in agent, or an ACP agent that supports MCP ([harness.md](../../docs/harness.md)) |
| 5 structured output | ends in the failure path: it cannot be asked a second time, so the call fails with `structured_output_invalid` (the examples exit with code 3) | a built-in agent, or an external agent whose session can be continued ([structured-output.md](../../docs/structured-output.md)) |
| 6 images | the image is accepted, the fixed answer does not describe it | an agent with image input (`image_input` in `GET /v1/models`) |
| 7 errors and retries | works | any agent |
| 8 connect tools | works | any agent |

Exit codes the examples agree on: `0` = done; `2` = the request was refused or does not fit this agent (for example an agent without image input); `3` = the example ran but the agent did not do what the recipe shows (no tool call, or `structured_output_invalid`).

## Connect common tools

Chat clients, editors and automation tools only need a Base URL, a key and an agent name. The table is the short form of [docs/compatibility.md](../../docs/compatibility.md#chat-clients), which also says how each client was checked and what its quirks are. Replace `<host>` with the gateway address; the key is a caller key; the model is the agent name exactly as `GET /v1/models` lists it.

| Tool | Where | Base URL | Model | Evidence | Ready-made |
|---|---|---|---|---|---|
| Open WebUI | Admin Settings > Connections > OpenAI | `http://<host>:8787/v1` | listed from `/models`, or add it under Model IDs (Filter) | replayed from the client source | |
| LibreChat | `librechat.yaml`, `endpoints.custom[]` | `http://<host>:8787/v1` | `models.default`, or `models.fetch: true` | partly inferred | [`librechat.yaml`](08-connect-tools/librechat.yaml) |
| Chatbox | Provider > API Host | `http://<host>:8787/v1` | add it, or fetch models | replayed from the client source | |
| Cherry Studio | Model Provider > Add > OpenAI > API Host | `http://<host>:8787` or `.../v1` | add manually, or fetch | replayed from the client source | |
| LobeChat | AI Service Provider > OpenAI > API Proxy URL | `http://<host>:8787/v1` | fetch models, or add by hand | partly inferred | |
| NextChat | Settings > Custom Endpoint > OpenAI Endpoint | `http://<host>:8787` without `/v1` | Settings > Custom Models | replayed from the client source | |
| Dify | Model Provider > OpenAI-API-compatible > Add Model | `http://host.docker.internal:8787/v1` when Dify runs in Docker | Model Name = the agent name | replayed from the client source | |
| n8n | Credentials > OpenAI | `http://<host>:8787/v1` | By ID, or From List | replayed from the client source | |
| Continue | `config.yaml`, `models[]` | `http://<host>:8787/v1` | `model: agent/sample` | replayed from the client source | [`continue.config.yaml`](08-connect-tools/continue.config.yaml) |
| Cline / Roo Code | API Provider "OpenAI Compatible" | `http://<host>:8787/v1` | the agent name | replayed from the client source | |
| Zed | `settings.json`, `language_models.openai_compatible.<name>` | `http://<host>:8787/v1` | `available_models[].name` | replayed from the client source | [`zed.settings.json`](08-connect-tools/zed.settings.json) |
| Cursor | Settings > Models > Override OpenAI Base URL | a public HTTPS URL, probably with `/v1` | a custom model name | **unverified** | |

Notes that apply to several of them (all from the compatibility document): a Base URL without `/v1` is the most common cause of a 404; a client running in Docker reaches the gateway as `host.docker.internal`, which has to be added to the gateway's `allowedHosts`; a browser-based client needs its origin in `allowedOrigins`; clients that send `tools` (Cline, Roo Code, Continue's agent mode, Zed) work against an agent that can take the tools over, and an agent that cannot (a native engine such as Codex or Claude Code) answers a clear 400 that names the way out: use the Base URL `http://<host>:8787/v1/compat`.

Anything built on the official SDKs can be pointed at the gateway with environment variables alone. [`env_check.py`](08-connect-tools/env_check.py) and [`env_check.mjs`](08-connect-tools/env_check.mjs) prove it for the OpenAI and Anthropic SDKs:

```bash
export OPENAI_BASE_URL="$OAA_BASE_URL/v1"   OPENAI_API_KEY="$OAA_API_KEY"      # OpenAI SDKs: the Base URL ends in /v1
export ANTHROPIC_BASE_URL="$OAA_BASE_URL"   ANTHROPIC_API_KEY="$OAA_API_KEY"   # Anthropic SDKs: no /v1
```

## How the examples are verified

`npm run compat` starts an isolated gateway on `127.0.0.1` (a random port, a temporary data directory, one generated key) with the offline sample agent and a deterministic fixture-model agent, copies this folder to a temporary directory, runs every example from there the way you would, and asserts the exit code and key lines of the output. Three clients of the lab do it: `cookbook-curl`, `cookbook-python` and `cookbook-node`. The fixture model is told what to do by a word in the prompt (the lab sets `OAA_PROMPT` for that; you never need it), for example `CALLTOOL` makes it call your tool and `ALWAYSBAD` makes it answer prose to a structured-output request.

What the lab does **not** run, and why:

| File | Why |
|---|---|
| [`08-connect-tools/continue.config.yaml`](08-connect-tools/continue.config.yaml), [`zed.settings.json`](08-connect-tools/zed.settings.json), [`librechat.yaml`](08-connect-tools/librechat.yaml) | configuration of third-party applications, not programs. The lab has none of those applications; the offline tests parse each file and check its keys against the compatibility document and against the recorded request shapes the lab replays |
| a real model | no example calls one: every example runs against the sample agent or the fixture model. How a real model behaves (for instance how often it needs the structured-output correction round) is not shown |
