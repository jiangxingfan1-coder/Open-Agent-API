# Five-Minute Quickstart: Publish, Issue a Key, Make a Call

English · [简体中文](zh-CN/quickstart.md)

This guide walks through the three steps at the heart of Open Agent API: **publish an agent to your gateway → issue a scoped API key → call it from an official SDK or CLI**.

Whether you end up wiring a Python backend, a Next.js app, Dify, or Cursor / Claude Desktop, every integration follows this exact loop.

---

## Prerequisite: Start Your Local Gateway

If you installed the **macOS, Windows, or Linux desktop app**, launching the app starts the local gateway automatically on `http://127.0.0.1:8787` and opens the console—skip straight to Step 1.

From the CLI or a repository checkout, one command initializes `.oaa/` and boots the background service:

```bash
# Run `oaa quickstart` if installed globally, or from a source checkout:
npm run oaa -- quickstart
```

`quickstart` creates `.oaa/`, starts the gateway bound strictly to `127.0.0.1:8787`, publishes an offline sample agent (`agent/sample`, requiring no model key), and verifies a live loopback call. Open `http://127.0.0.1:8787` in your browser and load `.oaa/admin.token` in the connection dialog to enter the admin console.

---

## Step 1: Publish Your First Agent

Pick whichever path matches what you already have on your machine:

### Option A: Wrap a Coding CLI Already Installed on Your Machine (Recommended)

If **Codex CLI**, **Claude Code**, **Antigravity**, or **Qoder CLI** is already installed and signed in locally, you can expose it as a standard API without re-entering any model credentials:

- **In the web console**:
  1. On a CLI-started gateway, open **Execution machines** in the sidebar and toggle on the detected local engine (the desktop app enables detected engines automatically on first launch).
  2. Click **+ Publish agent** in the top bar, pick the engine (e.g. `Antigravity` or `Codex`), keep or customize the call name (`agent/antigravity`, `agent/codex`), and click **Publish**.
- **Or in one CLI command**:

  ```bash
  # Verifies installation, enables the engine locally, and publishes agent/codex
  npm run oaa -- connect codex
  ```

### Option B: Connect a Local Runner or Cloud Model Provider (Built-in Kernel Agent)

To run the gateway's built-in stateful kernel (with workspace file tools, SQLite FTS5 project memory, and OAA-Lang workflows), connect a model provider:

```bash
# Local Ollama (no key needed; or scan local runners from Execution machines in the console)
npm run oaa -- connect ollama

# Or a cloud provider (reads the key from a private file, never shell history)
npm run oaa -- connect deepseek --key-file ~/.config/deepseek.key
```

This configures the provider and publishes a ready-to-use `agent/assistant`. To author custom instructions, tool permissions, and multi-step flows, click **+ Publish agent → OAA-Lang 2.0** in the console (see [OAA-Lang Reference](language.md)).

---

## Step 2: Issue a Caller API Key

Applications never use your admin token—they authenticate with a scoped `sk-oaa-…` key restricted to specific agents:

- **In the web console**: Leaving "Create an API key right after publishing" checked opens the key wizard automatically after Step 1, or open **API keys → Generate key** anytime. Select the target agent and click **Generate key**. The ready sheet displays the three values your caller needs:
  1. **Base URL**: `http://127.0.0.1:8787/v1`
  2. **API Key**: `sk-oaa-…` (shown once with one-click copy)
  3. **Model name** (passed in `model`): the agent's call name, such as `agent/codex` or `agent/assistant`
- **From the CLI**:

  ```bash
  npm run oaa -- key create --name my-app --agent agent/codex \
    --url http://127.0.0.1:8787 --token-file .oaa/admin.token
  ```

  The key is written with `0600` permissions to `.oaa/keys/my-app.key`, alongside a ready-to-paste `curl` command.

---

## Step 3: Call the Agent from Your Code

Drop those three values into any official SDK. What used to be a single-shot model completion now dispatches a full agent run:

### Python (Official `openai` SDK)

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key=os.environ["OAA_API_KEY"],  # your sk-oaa-… caller key
)

resp = client.responses.create(
    model="agent/codex",                # agent call name; supports @fast / @best / @eco
    input="Inspect the repository layout and summarize each module's responsibility",
)
print(resp.output_text)
```

### Node.js (Streaming & Multi-Turn Continuation)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: process.env.OAA_API_KEY,
});

const stream = await client.responses.create({
  model: 'agent/codex',
  input: 'Audit the error codes in the auth module and flag missing cases',
  stream: true,
});

let lastId = '';
for await (const event of stream) {
  if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);
  if (event.type === 'response.completed') lastId = event.response.id;
}

// Pass previous_response_id to continue in the same agent session
const followUp = await client.responses.create({
  model: 'agent/codex',
  previous_response_id: lastId,
  input: 'Turn the first missing case into a unit test',
});
console.log('\n', followUp.output_text);
```

### Anthropic Claude SDK & Google Gemini SDK

The gateway natively speaks Claude `/v1/messages` and Gemini `v1beta` as well (note that Anthropic and Gemini `baseURL` values omit `/v1`):

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  baseURL: 'http://127.0.0.1:8787',
  apiKey: process.env.OAA_API_KEY,
});

const msg = await anthropic.messages.create({
  model: 'agent/codex',
  max_tokens: 2048,
  messages: [{ role: 'user', content: 'Summarize API changes in the latest commit' }],
});
console.log(msg.content);
```

---

## Interactive Debugging & Live Approvals

- **Test in `#workbench`, then export code**: Open **Workbench** in the console sidebar to chat across turns, paste screenshots, test caller-tool bridging, and click **Code** in the header to export ready-to-run cURL, Python, Node.js, Claude, or Gemini snippets matching your exact setup.
- **Approve sensitive actions without dropping the stream**: When an agent needs confirmation before editing files or running shell commands, the run pauses cleanly at **Awaiting approval**. Click **Approve** in the console inspector, the `#workbench` inline card, or the system-tray popover, and the open stream resumes to completion.

---

## Where to Go Next

- **Copy-and-run recipes** (background runs, programmatic approvals, caller-tool loops, strict JSON Schema output, image input): [Cookbook](../examples/cookbook/README.md)
- **One-click IDE & local client wiring** (Cursor, Windsurf, Claude Desktop, Claude Code, OpenCode, Codex, DSH): [Local Connections](local-connections.md)
- **Smart model routing, shared memory & scheduled workflows**: [Intelligent Routing](intelligence.md) and [Workstation & Workflows](workstation.md)
- **Self-service keys & quotas for your team**: [Developer Platform](platform.md)
