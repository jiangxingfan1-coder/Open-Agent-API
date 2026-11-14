# Examples

English · [简体中文](README.zh-CN.md)

Everything in this folder, sorted by who it is for. The first section is what you read when you want to call an agent; the rest is for publishing agents or for people working on the gateway itself.

## For people who call agents

| What | Where | What it is |
|---|---|---|
| **Cookbook** | [`cookbook/`](cookbook/README.md) | Copy-and-run examples organised by what you want to do: first call, long tasks, approvals, caller tools, structured output, images, errors and retries, connecting tools. curl, and the official `openai`, `anthropic` and `google-genai` SDKs for Python and Node. Each one is run automatically by the compatibility lab (`npm run compat`) against an isolated gateway, so it cannot go stale unnoticed. Start here. |
| Webhook receiver | [`webhook-receiver.mjs`](webhook-receiver.mjs) | A minimal receiver for run-event callbacks (Node built-ins only): verifies the signature, prints each event and, only with `--auto-approve`, approves what waits for approval. The walkthrough is in [docs/webhooks.md](../docs/webhooks.md); a self-contained round trip is in the cookbook ([`03-approvals/webhook_approve.mjs`](cookbook/03-approvals/webhook_approve.mjs)). |

## The offline sample agent

| What | Where | What it is |
|---|---|---|
| Sample agent | [`sample-agent.mjs`](sample-agent.mjs) | An ACP agent process (JSON-RPC over stdio) that calls **no model and uses no network**. It answers with fixed text, makes one fake tool call and asks for one approval when the task contains "approve". `oaa quickstart` publishes it as `agent/sample`, so there is something to call before any model key exists. It cannot call your tools, answer structured-output requests or continue a session; the cookbook README says which examples it can and cannot show. |
| Its definition | [`sample-agent.json`](sample-agent.json) | The agent definition (`agent/sample`, engine `adapter/oaa-sample`) that `quickstart` publishes. |

Both files are in the npm package.

## Agent definition templates

Starting points for publishing your own agent. They contain model placeholders on purpose (`configure-your-model`): nothing here is an invented working connection. Check one with `oaa check`, publish it with `oaa publish` ([docs/cli.md](../docs/cli.md), [docs/language.md](../docs/language.md)).

| File | What it is |
|---|---|
| [`research.oaa`](research.oaa) | A research agent in OAA-Lang: routes for a primary and a fast model, built-in file tools, a flow. |
| [`research.agent.json`](research.agent.json) | The same idea as a plain JSON definition (publish with `oaa publish examples/research.agent.json`). |
| [`projected-workflow.oaa`](projected-workflow.oaa) | A small OAA-Lang agent with one checked workflow (`read_file`, bounded output schema); the example of [docs/language.md](../docs/language.md). |
| [`agy-gemini-3.8-flash.oaa`](agy-gemini-3.8-flash.oaa) | Wraps the local Antigravity command line (`agy`) as an agent that uses Gemini 3.8 Flash. Needs `agy` installed and signed in. |

The `.oaa` files and `research.agent.json` are in the npm package.

## For people working on the gateway (internal acceptance and demo scripts)

These are not examples for callers. They run an isolated gateway inside the process and exercise the product end to end; some can cost money. They are TypeScript files that `npm run build` compiles to `dist/examples/`, which is why they live here and not in `tools/`. None of them is part of the npm package.

| File | What it does | Cost |
|---|---|---|
| [`demo.ts`](demo.ts) | `npm run demo`: a research agent over three small files with a deterministic local model, writes `.oaa-demo/report.md`. | none |
| [`platform-walkthrough.ts`](platform-walkthrough.ts) | The developer-platform walkthrough with the sample agent (list it, open it up, redeem a code, register, create a key, call, bill, run out of balance, top up) on a temporary data directory and a random loopback port. `node dist/examples/platform-walkthrough.js`. | none |
| [`local-capability-acceptance.ts`](local-capability-acceptance.ts) | Wires one selected MCP tool (a test MCP server that reads a note) and a skill directory you name into a kernel agent driven by a fixture model, and checks that the capability is imported, called and audited (`--skill DIR --out NEW_DIR`). | none (no live model) |
| [`live-agents-acceptance.ts`](live-agents-acceptance.ts) | End-to-end agent verification, scenarios S1 to S12, shared with `oaa verify`. `--agent fixture` uses the repository's fake ACP agent. | none for `fixture`; real agents (claude, codex, antigravity) need `--confirm-live-cost` |
| [`live-native-acceptance.ts`](live-native-acceptance.ts) | One real invocation of a native Antigravity executable through the gateway (an exact model id and the executable path are required). | real, needs `--confirm-live-cost` |
| [`gemini-sdk-probe.mjs`](gemini-sdk-probe.mjs) | A one-off probe of the Gemini compatible entry with the official `@google/genai` SDK installed outside the repository. Not part of the automated tests; the cookbook and the compatibility lab cover the same SDK now. | none (in-process, no network) |

To check that the **user-facing** examples still work, run the compatibility lab, not these scripts: `npm run compat` (see [docs/compatibility.md](../docs/compatibility.md#the-compatibility-lab)).
