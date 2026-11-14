# Developer platform

> This is the English guide for developers who call agents through a gateway that runs the developer platform. Operator documentation and the full protocol reference are currently in Chinese: see [platform.md](platform.md) for the operator guide and configuration, and [protocol.md](protocol.md) for the complete protocol. Hostnames such as `api.example.com`, keys, and passwords in this guide are placeholders.

## What this is

> **Operators:** the platform can be enabled from the console's developer platform page (the "启用" button), without editing `config.json`. The settings are stored in the gateway's own database and take effect after the gateway restarts. A `platform` section in `config.json` still works and takes precedence; while it is present the console settings are read-only (`PUT /v1/platform/setup` returns 409 `platform_managed_by_config`). The settings belong to the owner who first enables the platform: afterwards only that owner's owner-wide admin keys can read or change them (others get 403 `scope_denied`). Disabling keeps all accounts, ledgers and listings. See [platform.md](platform.md) (Chinese) for details.

The developer platform lets an operator offer its agents to developers through self-service sign-up. You register, create your own API keys, see which agents you may call, and pay per task with credits. Credits are an accounting unit that the operator issues. They are not a currency, and the platform has no payment channel.

The platform borrows the shape of model relay platforms (accounts, keys, quotas, usage, and an admin console) but not their supply model:

| | Model relay platforms | Open Agent API |
| --- | --- | --- |
| What is distributed | Model inference capacity | Agents: complete execution units with their own tools, skills, model routes, and permissions |
| What goes in `model` | A model name | An agent's call name, such as `agent/research` |
| What one call is | One model completion | One task: a multi-turn tool loop with approvals, checkpoints, recovery, and artifacts |
| Where supply comes from | Upstream accounts or subscription pools | Execution machines run by the publisher (they connect outbound to the gateway), or agents defined with OAA-Lang |
| Unit of billing | Tokens | Per task, plus an optional per-token rate |
| What the catalog lists | Models | Agents: what they do, which tools they have, which model routes they can use, and how caller-side tools are handled |
| Credentials | Pooled subscription logins | The publisher's API key, or the caller's own key (BYOK). No subscription pooling and no relaying of login sessions |

## Get an account and a key

Whether you can sign up yourself depends on how the operator has set registration:

- `closed`: the operator creates your account. Ask the operator for one.
- `invite`: you need an invite code. Signing up without one returns 403 `invite_required`.
- `open`: anyone can sign up.

```bash
curl -s https://api.example.com/v1/portal/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"choose-your-own-password"}'
```

Sign-up returns 201 with `account` and `session`. `session.token` starts with `oas_`. It works only on the portal endpoints under `/v1/portal/*`.

To add credits, redeem a code from the operator. An account can redeem a given code only once. Codes are not case-sensitive, and leading and trailing spaces are ignored.

```bash
curl -s https://api.example.com/v1/portal/redeem \
  -H "Authorization: Bearer $OAS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"CODE-FROM-OPERATOR"}'
```

To create an API key, call the Keys endpoint, or use the Keys page of the portal:

```bash
curl -s https://api.example.com/v1/portal/keys \
  -H "Authorization: Bearer $OAS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-app"}'
```

This returns 201 with a `token` that starts with `sk-oaa-` (followed by 48 letters and digits). The token is shown only once. Older keys that start with `oaa_` keep working. `DELETE /v1/portal/keys/:id` deletes a key: it stops working at once and is no longer listed. Account keys have fixed scopes: `invoke`, `read`, and `files`. The operator caps the number of keys per account; going past the cap returns 409 `key_limit_reached`. An account key can see and call only the agents that the operator has listed and enabled.

## Call an agent

In `model`, pass the agent's call name, not a model name. To choose a model route, pass `metadata["oaa.model"]`. The routes an agent accepts are listed as `models` in `GET /v1/portal/agent?id=`, and always include `auto`.

Python, with the OpenAI SDK:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://api.example.com/v1",
    api_key=os.environ["OAA_API_KEY"],  # your account key, starts with sk-oaa-
)

response = client.responses.create(
    model="agent/research",  # the agent's call name
    input="Analyze these notes.",
    metadata={"oaa.model": "auto"},  # optional: a model route listed for this agent
)
```

Node.js, with the OpenAI SDK:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.example.com/v1",
  apiKey: process.env.OAA_API_KEY, // your account key, starts with sk-oaa-
});

const response = await client.responses.create({
  model: "agent/research", // the agent's call name
  input: "Analyze these notes.",
  metadata: { "oaa.model": "auto" }, // optional
});
```

curl, with the Responses endpoint:

```bash
curl -s https://api.example.com/v1/responses \
  -H "Authorization: Bearer $OAA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"agent/research","input":"Analyze these notes.","metadata":{"oaa.model":"auto"}}'
```

Claude Messages, with the `x-api-key` header:

```bash
curl -s https://api.example.com/v1/messages \
  -H "x-api-key: $OAA_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{"model":"agent/research","max_tokens":1024,"messages":[{"role":"user","content":"Analyze these notes."}]}'
```

- Account keys work on the OpenAI Responses, OpenAI Chat Completions, and Claude Messages endpoints. Streaming works on all of them.
- For a long task, pass `background=True` in the Python SDK call, and poll the task with `client.responses.retrieve(response.id)`.
- If the agent has a price and your balance is too low, the request fails with 402 `insufficient_balance`, and no task is created.
- If a non-streaming call fails, is cancelled or interrupted, or waits for approval after its task was created, Chat Completions, Claude Messages, and Gemini return 422 with `x-should-retry: false`, so the official SDKs do not retry it (checked in this repository with the official `openai` and `@anthropic-ai/sdk` Node SDKs; and once with a temporarily installed `@google/genai` 3.2.0, which does not retry by default). See "Error handling" below.

## See what your task did

The Tasks page of the portal (its heading is "Task history") lists your tasks, newest first. You can filter by agent and page through the list. Opening a task shows its "Task details": status, start and end times, usage, charge, output, and its timeline.

- `GET /v1/portal/runs?limit=20&cursor=&agent=` returns `{ data: RunItem[], next_cursor }`. `limit` is 1 to 200, default 20. `next_cursor` is a number, or `null` when there are no more pages.
- `GET /v1/portal/runs/:id` returns `RunDetail`. A task that is not yours, or does not exist, returns 404 `run_not_found`.

The `timeline` in the detail is the execution record of the task. It is the same object that `GET /v1/runs/:id/timeline` returns. It lists the task's spans in order, such as queueing, model turns, tool calls, and approvals. Each span has a kind, a label, a status, and a start and end time, in milliseconds from the start of the task. The kinds are `queue`, `model`, `tool`, `approval`, `client_tool` (waiting for your side to run a tool), `subagent`, `interrupted`, and `native` (the run of an external agent).

- `status` is `in_progress` while the task runs. After that, it is the task's final state, the same as in its ledger line.
- `created_at` is when the task was recorded, the same as its ledger line. `completed_at` is when the task ended, and `null` while it runs.
- `charge` is the points charged for the task, as a positive number.
- `usage` may be `null`. `error` is `{code, message}` or `null`.
- `output_text` is the output text, with the parts separated by a blank line. It is truncated to 200,000 characters, with an ellipsis at the end when it is cut.
- If the task's detailed run record has been cleaned up but its ledger line remains, the detail still returns the ledger fields. `timeline`, `usage`, `error`, and `completed_at` are `null`, and `output_text` is an empty string.

## Try it in the browser

The Playground of the portal lets you call a listed agent from the browser, without writing code. Choose an agent, optionally a model route, paste one of your account keys (`sk-oaa-…`), and enter a task. The output streams into the page. When the task finishes, the page links to the record of that task.

- The page calls `POST /v1/chat/completions` with streaming on. It adds no backend endpoint. The model route is passed in `metadata["oaa.model"]`.
- The key stays in the page's memory only. It is not written to `localStorage`, and it is discarded when you leave the page.
- Trying an agent is billed the same way as any other call.
- The Playground is for experiments. For production, call the API from your own server, so that the key never sits in a browser page.

## Billing rules

Amounts are in points. Internally they are stored as integer micro-points (1 point = 1,000,000 micro-points), and API amounts have up to six decimal places.

1. **Prices.** Each listed agent has two prices: `per_run` (points per task) and `per_1k_tokens` (points per 1,000 tokens). Either can be zero.
2. **What is billed.** Only runs started with an account key are billed. One run is one task. Continuing a conversation with `previous_response_id` starts a new call, which is billed as a new task. When the agent pauses to ask for your tool results and then continues, that is still one run, billed once. Sub-runs created by delegation are not billed separately, but their tokens count toward the parent task's usage, so the per-token price covers them.
3. **Checked at submission.** For an agent that is not free (either price is non-zero), a task is refused with 402 `insufficient_balance` if the balance is below `per_run`, or if the balance is zero or negative. No task is created. A free agent (both prices zero) can be called with a zero balance.
4. **Recorded at start.** When a run starts, a ledger line is written with the price at that moment. Later price changes do not affect a running task. While the run is in progress, its line has status `in_progress` and amount 0. When the run ends, the status becomes the final state (`completed`, `failed`, `cancelled`, `interrupted`, or `incomplete`), and the amount becomes the actual charge.
5. **Settled at the end.** A `completed` run is charged `per_run + per_1k_tokens × total_tokens / 1000`. Other final states (failed, cancelled, interrupted) charge only the token part, not the per-task price. An interrupted run is settled at the tokens it had used when it was interrupted: at a normal shutdown that happens at once, and after a crash the next startup's reconciliation settles it (rule 11). Amounts round up to the micro-point.
6. **Idempotent.** A run has one ledger line. If a run is settled more than once, for example after recovery, only the difference is applied. It is never charged twice. The key's token usage (`PortalKey.usage.used_tokens`) is also increased only by the difference. Usage recorded before version 0.6.0 is not corrected.
7. **The balance can briefly go negative.** Token counts are not known until a task ends, so the balance can fall below zero after settlement. The next submission is then refused under rule 3. Concurrency limits bound the worst case.
8. **Tokens may be missing.** Some external agents do not report token usage. If `total_tokens` is 0 or missing, only the per-task price applies. Reported token counts are not cost estimates.
9. **Precision.** Amounts are stored and calculated as integer micro-points internally. API amounts are in points, with up to six decimal places.
10. **Invariant.** An account's balance always equals the sum of the `amount` values of all its ledger lines.
11. **Startup reconciliation.** When the gateway starts, it checks the ledger lines that are still `in_progress`, without blocking startup. If the run has ended (including an interrupted run that is still stored), the line is settled by its final state, as in rule 5, so an interrupted run is settled at the tokens it had used. If the run record no longer exists, the line is marked `interrupted` and settled as 0 tokens, so its amount is 0, because its usage can no longer be known. A run that is still queued or waiting is left alone. Reconciliation is idempotent: running it again changes nothing.
12. **Resume.** Before an interrupted run is resumed, the rules for a new submission are checked again. The run's own key must still be valid: an expired or deleted key is refused, and when the operator resumes another key's run and that key is inactive, the response is 409 `run_key_inactive`. The account must be active (`account_disabled`), the agent must still be listed for that key (`scope_denied`), a paid agent needs enough balance (`insufficient_balance`), and the key's concurrency, token, and run quotas must not be exceeded. If any check fails, the run stays interrupted and nothing is written. When it passes, the run's ledger line goes back to `in_progress` and is settled by the difference when the run finishes. A resumed run, and a run re-queued at startup, counts against its key's concurrency again, but not as another run.

## Forgot your password

The platform has no email, so there is no reset by email. Ask the operator for a one-time reset code. The code is 20 characters long, is valid for 24 hours, and can be used once. If the operator generates a new code, the old one stops working.

Then either open the portal sign-in page, choose "Forgot your password?", and set the new password on the page titled "Set a new password with a reset code", or call the endpoint:

```bash
curl -s https://api.example.com/v1/portal/password-reset \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","code":"CODE-FROM-OPERATOR","new_password":"choose-a-new-password"}'
```

The response is 204. The new password must be 8 to 200 characters. Using the code signs out every session of the account. A wrong, expired, or already-used code, or an unknown email, returns 400 `invalid_code`. The response never reveals whether the email exists. The endpoint is rate-limited by source IP address (30 attempts in 10 minutes) and by email (10 attempts in 10 minutes). These limits are the same as for sign-in, but counted separately. Exceeding them returns 429 `rate_limited`.

To change your password while signed in, call `POST /v1/portal/account/password` with `current_password` and `new_password`. Every session of the account, including the current one, is then signed out.

## API reference

### Public endpoints (no credentials)

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /v1/portal/site` | — | `{ site_name, registration, base_url, endpoints, version }` |
| `GET /v1/portal/agents` | — | `{ data: ListedAgent[] }` |
| `GET /v1/portal/agent?id=` | — | `ListedAgent`; not listed: 404 `agent_not_found` |
| `POST /v1/portal/signup` | `{ email, password, name?, invite_code? }` | 201 `{ account, session }` |
| `POST /v1/portal/login` | `{ email, password }` | `{ account, session }` |
| `POST /v1/portal/password-reset` | `{ email, code, new_password }` | 204 |

With an account key, `GET /v1/me` also returns `account: { id, balance }`.

### Portal session endpoints (`Authorization: Bearer oas_…`)

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /v1/portal/logout` | — | 204 |
| `GET /v1/portal/account` | — | `{ account }` |
| `POST /v1/portal/account/password` | `{ current_password, new_password }` | 204; all sessions end |
| `GET /v1/portal/keys` | — | `{ data: PortalKey[] }`, newest first; deleted keys are not listed |
| `POST /v1/portal/keys` | `{ name }` | 201 `PortalKey + { token }`; the token is shown once |
| `DELETE /v1/portal/keys/:id` | — | 204 |
| `POST /v1/portal/redeem` | `{ code }` | `{ account, credited }` |
| `GET /v1/portal/usage?days=30` | — | `Usage`; `days` is 1 to 90 |
| `GET /v1/portal/ledger?limit=50&cursor=` | — | `{ data: LedgerEntry[], next_cursor }`, newest first |
| `GET /v1/portal/runs?limit=20&cursor=&agent=` | — | `{ data: RunItem[], next_cursor }`, newest first; `agent` is optional |
| `GET /v1/portal/runs/:id` | — | `RunDetail`; not yours or not found: 404 `run_not_found` |

### Objects

```text
Account      { id, email, name, status, balance, created_at }
Session      { token, expires_at }
PortalKey    { id, name, created_at, revoked (always false), quota, usage: { used_tokens, used_runs, active_runs } }
Price        { per_run, per_1k_tokens }
ListedAgent  { id, title, summary, tags, description, kind: "kernel" | "external", models, price, updated_at, conversion? }
LedgerEntry  { id, kind, amount, balance_after, agent, run_id, tokens, status, note, reference?, created_at }
Usage        { balance, totals: { runs, tokens, spent }, daily: [{ date, runs, tokens, spent }], by_agent: [{ agent, runs, tokens, spent }] }
RunItem      { id, agent, status, tokens, charge, created_at }
RunDetail    { id, agent, status, created_at, completed_at, usage, error, charge, price: Price, output_text, timeline }
```

- Times are millisecond timestamps. Amounts are in points.
- `models` lists the model routes the agent accepts, including `auto`.
- `daily[].date` is the UTC date (`YYYY-MM-DD`), with no missing days. `spent` is positive.
- `charge` is the points charged, as a positive number. `reference` appears only on an entry that was credited with an external reference. Other entries have no such field (it is not `null`).

## Error handling

Each compatibility entry returns errors in its own protocol's shape:

- **OpenAI-compatible endpoints** return `{"error":{"code","message","type","param"}}`. The gateway's stable code is in `error.code`.
- **Claude Messages** returns `{"type":"error","error":{"type","message","code"}}`. `error.type` follows the HTTP status (for example `rate_limit_error` for 429). The gateway's code is in `error.code`. Paths under `/v1/messages/` that the gateway does not serve (such as `count_tokens`) return the same shape with `not_found_error`, which the Anthropic SDK raises as `NotFoundError`.
- **Gemini** returns `{"error":{"code","message","status","details"}}`. The gateway's code is in `details[0].reason`.

When a task has already been created, the error also carries its run ID (`run_id`, or `details[0].metadata.run_id` for Gemini).

- **422, not retried.** A non-streaming Chat Completions, Claude Messages, or Gemini call whose task was created but did not finish (failed, cancelled, interrupted, or waiting for approval) returns 422 with `x-should-retry: false`. Responses returns a response object with a `status` instead.
- **Retry-After.** A rate-limited 429 (`rate_limited`) gives the seconds left in the current 60-second window. Other retryable capacity limits give 10 seconds. A 429 for an exhausted key quota has `x-should-retry: false` and no `Retry-After`.
- **Ignored parameters.** Sampling parameters such as `temperature` are accepted but not forwarded. Their names are listed in the `X-OAA-Ignored-Params` header, which is absent when nothing was ignored.
- **Output limits.** `max_tokens`, `max_output_tokens`, and `maxOutputTokens` take effect. The gateway uses the smaller of the request value and the agent's own limit. This applies to built-in kernel agents only; external agents are not affected.
- **Truncation is not an error.** Chat Completions returns `finish_reason: "length"` with status 200 (a stream still ends with `[DONE]`). Claude returns `stop_reason: "max_tokens"`, Gemini returns `finishReason: "MAX_TOKENS"`, and Responses returns `status: "incomplete"`.
- **Unsupported input.** An unknown field on a strict endpoint returns 400 `unsupported_parameter`, with the field name in `param`. Inline images and audio return 400 `unsupported_content` on every compatibility endpoint (OpenAI, Claude, Gemini); see [protocol.md](protocol.md#兼容入口的参数错误与结束原因060).

## Error codes

These codes belong to the `platform` category. Other codes, such as `run_not_found` and `rate_limited`, are listed in [protocol.md](protocol.md).

| Code | HTTP | Meaning |
| --- | --- | --- |
| `registration_closed` | 403 | Self-service sign-up is not open on this site |
| `invite_required` | 403 | Sign-up requires an invite code |
| `invalid_code` | 400 | A redeem or invite code is invalid, used up, expired, or already used by this account. Any failure of a reset code (wrong, expired, already used, or unknown email) also returns this code |
| `email_taken` | 409 | The email is already registered |
| `invalid_credentials` | 401 | The email or password is incorrect |
| `session_invalid` | 401 | The portal session is invalid or has expired |
| `account_disabled` | 403 | The account is disabled. Its sessions and account keys are rejected |
| `account_not_found` | 404 | The account does not exist |
| `insufficient_balance` | 402 | The balance is not enough. Returned before a task is created |
| `key_limit_reached` | 409 | The account has reached its key limit |
| `listing_not_found` | 404 | The agent has no listing |
| `code_not_found` | 404 | The code does not exist |
| `reference_conflict` | 409 | The external reference was already used for a credit of a different amount, or for a credit to a different account. This applies to billing-key callers of the operator API |
| `platform_managed_by_config` | 409 | Operators only: the platform is configured in `config.json`, so `PUT /v1/platform/setup` cannot change it from the console |

## Limits

- **Single gateway with SQLite.** There are no multiple instances, no Postgres, and no failover.
- **One publisher.** The platform offers the agents owned by the operator's owner account. There is no settlement across several publishers.
- **No real payments.** Credits are issued by the operator, through redeem codes or manual adjustments.
- **No email.** There is no email verification. Reset codes are passed to you by the operator through another channel.
- **Rate-limit counters are in process memory.** They reset when the gateway restarts.
- **Sign-in is rate-limited per email.** Every attempt counts, whether or not the password is correct. More than 10 attempts for one email within 10 minutes are refused, so a correct password can be refused too.
- **Some external agents do not report tokens.** In that case only the per-task price applies, and token counts are not cost estimates.
- **No inline images.** Upload files with `POST /v1/files` and reference them by ID. Every compatibility endpoint rejects inline images and audio with 400 `unsupported_content`; see [protocol.md](protocol.md#兼容入口的参数错误与结束原因060).
- **Event streams are capped.** Each key may hold 64 run event streams at once, and each owner 256. More answer 429 `too_many_streams` with `Retry-After`.
- **The balance can briefly go negative.** See rule 7 in [Billing rules](#billing-rules).
- **No subscription pooling, and no relaying of login sessions.**
