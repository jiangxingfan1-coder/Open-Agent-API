# Cookbook: Copy-and-Run Recipes

English · [简体中文](README.zh-CN.md)

Practical, single-file examples organized by real integration tasks. Each file documents what it demonstrates, what it expects, and how to run it in its opening lines—covering `curl` alongside the official `openai`, `anthropic`, and `google-genai` SDKs for Python and Node.js. Every script reads configuration from environment variables with zero hardcoded secrets.

> Tip: You can also prototype interactively in the console's **Workbench** (`#workbench`)—attach images, toggle routing or mock bridge tools, and click **Code** in the header to export ready-to-run snippets for your exact session.

Every runnable script in this folder is executed automatically by the [compatibility lab](../../docs/compatibility.md#the-compatibility-lab) (`npm run compat`) against an isolated gateway on CI, asserting exit codes and output lines (see [`integrations/compat/cookbook.mjs`](../../integrations/compat/cookbook.mjs)).

---

## Setup

Every recipe reads the same three environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `OAA_BASE_URL` | Gateway origin without a path suffix | `http://127.0.0.1:8787` |
| `OAA_API_KEY` | Scoped caller key (`sk-oaa-…`) | Required |
| `OAA_AGENT` | Published agent call name (as listed by `GET /v1/models`) | `agent/sample` |

`OAA_PROMPT` (plus `OAA_LONG_PROMPT` in recipe 02) optionally overrides the prompt text.

### 1. Run Immediately Offline (Zero Model Keys Needed)

Two commands start a local gateway and wire up a caller key against the offline sample agent:

```bash
oaa quickstart                                        # boots 127.0.0.1:8787 and publishes agent/sample
export OAA_API_KEY="$(cat .oaa/keys/quickstart.key)"  # caller key with invoke, read, files & approve scopes
```

> Registering outbound webhooks in recipe 03 is an admin operation and additionally reads `export OAA_ADMIN_KEY="$(cat .oaa/admin.token)"`.

### 2. Point the Same Scripts at a Real Agent

Once you publish a real CLI or model-backed agent (via the console or `oaa connect codex` / `oaa connect ollama`), point `OAA_AGENT` at it to run the exact same scripts against live tasks:

```bash
export OAA_AGENT="agent/codex"  # or agent/antigravity, agent/assistant, etc.
```

### 3. Install Your Preferred SDKs

Install only the SDKs you plan to run (`curl` scripts require nothing extra):

```bash
pip install openai anthropic google-genai
npm install openai @anthropic-ai/sdk @google/genai
```

Avoid naming your own test script `openai.py` or `anthropic.py` in Python, which would shadow the installed SDK package.

---

## Recipe Index

| Scenario (opens folder) | cURL | Python | Node.js |
| --- | --- | --- | --- |
| [01 · First synchronous & streaming calls across all three protocols](01-first-call/) | [`hello.sh`](01-first-call/hello.sh) | [OpenAI](01-first-call/hello_openai.py), [Anthropic](01-first-call/hello_anthropic.py), [Gemini](01-first-call/hello_genai.py) | [OpenAI](01-first-call/hello_openai.mjs), [Anthropic](01-first-call/hello_anthropic.mjs), [Gemini](01-first-call/hello_genai.mjs) |
| [02 · Background runs, polling, cancellation & multi-turn `previous_response_id`](02-long-running/) | [`long_task.sh`](02-long-running/long_task.sh) | [`long_task_openai.py`](02-long-running/long_task_openai.py) | [`long_task_openai.mjs`](02-long-running/long_task_openai.mjs) |
| [03 · Detect `requires_action` runs and approve or deny via API](03-approvals/) | [`approve.sh`](03-approvals/approve.sh) | [`approve_openai.py`](03-approvals/approve_openai.py) | [`approve_openai.mjs`](03-approvals/approve_openai.mjs) |
| [03 · Receive signed webhook notifications and resolve approvals from your handler](03-approvals/) | — | — | [`webhook_approve.mjs`](03-approvals/webhook_approve.mjs) (standalone server: [`examples/webhook-receiver.mjs`](../webhook-receiver.mjs)) |
| [04 · Let the agent invoke functions in your own app (caller-tool bridge loop)](04-caller-tools/) | — | [OpenAI](04-caller-tools/tools_openai.py), [Anthropic](04-caller-tools/tools_anthropic.py), [Gemini](04-caller-tools/tools_genai.py) | [OpenAI](04-caller-tools/tools_openai.mjs), [Anthropic](04-caller-tools/tools_anthropic.mjs), [Gemini](04-caller-tools/tools_genai.mjs) |
| [05 · Enforce strict JSON Schema output and handle validation failures](05-structured-output/) | [`structured.sh`](05-structured-output/structured.sh) | [OpenAI](05-structured-output/structured_openai.py), [Anthropic](05-structured-output/structured_anthropic.py), [Gemini](05-structured-output/structured_genai.py) | [OpenAI](05-structured-output/structured_openai.mjs) |
| [06 · Send local images or screenshots for multimodal inspection](06-images/) | [`image.sh`](06-images/image.sh) | [OpenAI](06-images/image_openai.py), [Anthropic](06-images/image_anthropic.py), [Gemini](06-images/image_genai.py) | [OpenAI](06-images/image_openai.mjs), [Anthropic](06-images/image_anthropic.mjs), [Gemini](06-images/image_genai.mjs) |
| [07 · Distinguish retryable errors and retry safely with `Idempotency-Key`](07-errors-and-retries/) | [`errors.sh`](07-errors-and-retries/errors.sh) | [`retries_openai.py`](07-errors-and-retries/retries_openai.py) | [`retries_openai.mjs`](07-errors-and-retries/retries_openai.mjs) |
| [08 · Point existing SDK toolchains at the gateway via environment variables alone](08-connect-tools/) | — | [`env_check.py`](08-connect-tools/env_check.py) | [`env_check.mjs`](08-connect-tools/env_check.mjs) |

Run any recipe directly from `examples/cookbook`:

```bash
python 01-first-call/hello_openai.py
node 04-caller-tools/tools_anthropic.mjs
sh 05-structured-output/structured.sh
```

---

## Offline `agent/sample` vs. Live Agents

`agent/sample` ([`examples/sample-agent.mjs`](../sample-agent.mjs)) is a deterministic, zero-cost ACP process with no LLM behind it. It is ideal for verifying connectivity offline, while multi-turn tool and schema recipes shine when pointed at a real agent:

| Recipe | Behavior with Offline `agent/sample` | Recommended Agent for Full Flow |
| --- | --- | --- |
| **01 First call** | Runs end-to-end with deterministic rule-based text | Any agent |
| **02 Long-running** | Background queuing and polling work; cancel finishes as `incomplete` (`effect_outcome_unknown`) and `previous_response_id` returns `native_resume_unsupported` because the sample process is stateless | Built-in kernel agent, or a session-resumable Codex / ACP agent |
| **03 Approvals** | Runs end-to-end: prompts containing `approve` trigger a file-write checkpoint; approving completes the run, denying fails with `permission_denied` | Any agent with approval gates |
| **04 Caller tools** | Sample process never invokes caller functions (exits cleanly with code `3` explaining why) | Built-in kernel agent, or Codex / Claude Code / Antigravity / ACP agent ([Dual-Layer Harness](../../docs/harness.md)) |
| **05 Structured output** | Exercises the validation-failure branch (`structured_output_invalid`, exit code `3`) | Built-in kernel agent or multi-turn external agent ([Structured Output](../../docs/structured-output.md)) |
| **06 Images** | Accepts image payloads; fixed reply does not describe visual content | Vision-capable agent (`image_input` in `GET /v1/models`) |
| **07 Errors & retries** | Runs end-to-end | Any agent |
| **08 Connect tools** | Runs end-to-end | Any agent |

Exit code convention across scripts: `0` = completed target flow; `2` = request rejected or unsupported by the chosen agent (e.g. sending images to a text-only agent); `3` = script completed cleanly, but the offline sample agent did not exercise the advanced branch.

---

## Wiring IDEs, Chat Clients & Automation Platforms

- **One-click local wiring (recommended)**: For **Cursor**, **Windsurf**, **Claude Desktop**, **Claude Code**, **OpenCode**, **Codex CLI**, and **DSH** installed on the same machine, open **[Local Connections](../../docs/local-connections.md)** in the console to inject API providers or MCP bridges automatically without editing config files by hand.
- **Standard three-value setup**: Any other OpenAI-, Claude-, or Gemini-compatible tool needs only your **Base URL**, **API Key**, and **Agent call name** (full client notes in [Compatibility](../../docs/compatibility.md#chat-clients)):

| Tool / Platform | Where to Configure | Base URL | Model Field | Config Template |
| --- | --- | --- | --- | --- |
| **Open WebUI** | Admin Settings → Connections → OpenAI | `http://<host>:8787/v1` | Fetched from `/models` or entered under Model IDs | — |
| **LibreChat** | `librechat.yaml` → `endpoints.custom[]` | `http://<host>:8787/v1` | `models.default` or `models.fetch: true` | [`librechat.yaml`](08-connect-tools/librechat.yaml) |
| **Chatbox** | Provider → API Host | `http://<host>:8787/v1` | Fetch models or add agent name manually | — |
| **Cherry Studio** | Model Provider → Add → OpenAI → API Host | `http://<host>:8787` or `.../v1` | Fetch list or add manually | — |
| **LobeChat** | AI Service Provider → OpenAI → API Proxy URL | `http://<host>:8787/v1` | Fetch models or add manually | — |
| **NextChat** | Settings → Custom Endpoint → OpenAI Endpoint | `http://<host>:8787` (no `/v1`) | Settings → Custom Models | — |
| **Dify** | Model Provider → OpenAI-API-compatible | `http://host.docker.internal:8787/v1` when Dify runs in Docker | Agent call name | — |
| **n8n** | Credentials → OpenAI | `http://<host>:8787/v1` | Select from list or enter ID | — |
| **Continue** | `config.yaml` → `models[]` | `http://<host>:8787/v1` | `model: agent/sample` | [`continue.config.yaml`](08-connect-tools/continue.config.yaml) |
| **Cline / Roo Code** | API Provider → `OpenAI Compatible` | `http://<host>:8787/v1` | Agent call name | — |
| **Zed** | `settings.json` → `language_models.openai_compatible` | `http://<host>:8787/v1` | `available_models[].name` | [`zed.settings.json`](08-connect-tools/zed.settings.json) |

**Quick tips**:
1. **`/v1` path convention**: OpenAI SDKs and most OpenAI-compatible apps expect `/v1` at the end of the Base URL; Anthropic and Gemini SDKs take the root origin **without** `/v1`:

   ```bash
   export OPENAI_BASE_URL="$OAA_BASE_URL/v1"   OPENAI_API_KEY="$OAA_API_KEY"
   export ANTHROPIC_BASE_URL="$OAA_BASE_URL"   ANTHROPIC_API_KEY="$OAA_API_KEY"
   ```

2. **Docker & browser origins**: Containerized apps reaching the host via `host.docker.internal` require adding `host.docker.internal` to `allowedHosts` in `.oaa/config.json`; browser-only web apps require adding their origin to `allowedOrigins`.
3. **Clients that send custom `tools`**: IDE agents (Cline, Continue agent mode, Zed) send client-side tool schemas. Bridging-capable backends (built-in kernel, Codex, Claude Code, Antigravity, ACP) bridge those calls automatically; for non-bridging adapters, point the client at `http://<host>:8787/v1/compat` so external tool schemas are ignored cleanly.
