# Developer platform

English · [简体中文](zh-CN/platform.md)

> Scope: the developer platform added in 0.4.0. 0.5.0 added task records, the playground, billing-only keys, reset codes and startup reconciliation; 0.6.0 corrected billing, key concurrency and event-stream details for interruption and resume (see [Billing rules](#billing-rules) and [Limits](#limits)). It is enabled only when the `platform` section is configured. When it is not enabled, the routes, tables and pages described here do not exist, and the gateway's output is the same as before.
>
> This document covers features, configuration and endpoints, not deployment steps. For domains, reverse proxies and certificates see [deploy-public.md](deploy-public.md). The hostnames in this document (`api.example.com`, `console.example.com`), the admin key path, and all keys and passwords are placeholders.

## Positioning

The developer platform lets an operator hand Open Agent API to developers for self-service use: developers sign up, create their own keys, see which agents they may call, and pay by usage. The operator lists agents, sets prices, issues credits and manages accounts in the console.

The platform borrows the shape of model relay platforms (accounts, keys, quotas, usage, an admin console) but not their supply model. The table below only states how the two kinds of product differ and does not judge any specific project.

| | Model relay platforms | Open Agent API |
| --- | --- | --- |
| What is distributed | Model inference capacity | Agents: complete execution units with their own tools, skills, model routes, and permissions |
| What goes in `model` | A model name | An agent's call name, such as `agent/research` |
| What one call is | One model completion | One task: a multi-turn tool loop with approvals, checkpoints, recovery, and artifacts |
| Where supply comes from | Upstream accounts or subscription pools | Execution machines run by the publisher (they connect outbound to the gateway), or agents the publisher defines with OAA-Lang |
| Unit of billing | Tokens | Per task, plus an optional per-token rate |
| What the catalog lists | Models | Agents: what they do, which tools they have, which model routes they can use, and how caller-side tools are handled |
| Credentials | Pooled subscription logins | The publisher's API key, or the caller's own key (BYOK). No subscription pooling and no relaying of login sessions |

This product does not pool subscriptions and does not relay login sessions. An agent's execution machines are provided by the publisher, and the credentials are the publisher's own API key or a key the caller brings (BYOK, see [protocol.md](protocol.md#caller-supplied-model-keys-byok-p1), "Caller-supplied model keys").

The developer platform is optional and off by default. Credits in the platform are only an accounting unit; there is no payment integration (see [Limits](#limits)).

## Concepts

| Concept | Meaning |
| --- | --- |
| Account | An identity a developer registers in the portal (or the operator creates), with an email, name, status and credit balance. The email is unique within an owner and case-insensitive. |
| Portal session | The token an account gets after signing in, of the form `oas_…`, used only for `/v1/portal/*`. |
| Account key | A calling key an account creates in the portal, of the form `sk-oaa-…` (older keys starting with `oaa_` keep working). It is used only for calling endpoints and cannot access portal endpoints. Several keys of one account share runs, files and memory; different accounts are isolated from each other. |
| Listing | The operator puts an agent already published under the owner into the platform catalog, with a title, summary, tags, price and an enabled flag. An agent that is not listed or is disabled is invisible to account keys and cannot be called. |
| Credits | A neutral accounting unit; 1 credit = 1,000,000 micro-credits. The operator issues them through redeem codes or manual adjustments; they do not correspond to any currency. |
| Ledger | Every balance change is one line, of kind `run`, `redeem`, `grant` (a gift) or `adjust` (an operator adjustment). |
| Redeem code | A `credit` code is a credit code that a developer redeems to receive credits; an `invite` code is an invite code used at sign-up. The plaintext of a code is returned only once, when it is generated; the database stores only a hash. |
| Task record | The record of each task an account started, viewable on the portal's "Tasks" page: status, usage, charge, output, and the task's execution timeline (`timeline`). |
| Playground | The portal's "Playground" page: choose a listed agent, enter your own account key, and call it directly in the browser. Playground calls are billed too. |
| Billing-only key (`billing`) | A key with the `billing` permission can only add credits to accounts (`credit`) and look accounts up by email, for the operator's payment callbacks. It has no other permission. |
| Reset code | A one-time password reset code the operator generates for an account, valid for 24 hours. The developer uses it to set a new password in the portal, and the operator never learns that password. |

The ledger `note` values are as follows: a `redeem` line is `code <code ID>` (redemption) or `invite <code ID>` (sign-up with an invite code); a `grant` line is `signup` (the sign-up gift, set by `signupCredits`) or `operator` (credits the operator gave when creating the account); an `adjust` line is the note the operator wrote; a `run` line has no note. For a credit with an external reference, the reference is recorded in the ledger line's `reference` field and not written into `note`; see [Connect your own payments](#connect-your-own-payments).

## Enabling

### Enable from the console (recommended)

Open the "Developer platform" page under the "Access" group in the console. When the platform is not enabled, the page has an "Enable" button: fill in the site name, the registration mode (`closed` / `invite` / `open`) and the credits given to new accounts, and save. The settings are stored in the gateway's own database (the `gateway_platform_setup` table, created on first save) and **`config.json` is not rewritten**; **they take effect after the gateway (the background service) restarts**: once the gateway is listening it can no longer add routes, so the platform is not hot-enabled while running. After enabling, the `owner` the agents belong to is the owner of the key used when saving; the other fields (`maxKeysPerAccount`, `keyQuota`, `keyExecution`, `sessionTtlHours`) take the defaults in the table below.

- To change settings: edit them on the same page and save again; they also take effect after a restart.
- To disable: this only turns the switch off, and after a restart the platform is off; the saved settings and all platform data (accounts, ledger, listings, redeem codes) are kept and are still there when you enable it again.
- This needs an owner-level admin key (the `admin` permission with `agents` set to `*`), usable only on the console domain, in the same tier as the [operator endpoints](#operator-owner-level-admin-key-console-domain-only). **The settings belong to the owner that enabled it first**: once saved (also after disabling), only that owner's admins can view and change them, any other owner gets 403 `scope_denied`, and the owner does not change on later saves; when the configuration file manages it, only `platform.owner` can view it. Fields left out when changing keep their saved values. Each save writes an audit record (`platform_setup`). The endpoint is `GET/PUT /v1/platform/setup`, which is available even when the platform is not enabled, and `features` in `/health` contains `platform-setup-v1`.

### Enable with the configuration file

The configuration-file method still works and takes **precedence**: when `config.json` has a `platform` section, the file wins and the console settings are read-only (`PUT /v1/platform/setup` returns 409 `platform_managed_by_config`). To go back to managing it in the UI, delete the section and restart.

Add a `platform` section at the top level of `config.json` (at the same level as the fields in [deploy-public.md](deploy-public.md#4-gateway-configuration), section 4):

```json
{
  "platform": {
    "owner": "owner",
    "siteName": "Open Agent API",
    "registration": "closed",
    "signupCredits": 0,
    "maxKeysPerAccount": 10,
    "keyQuota": { "rpm": 60, "maxConcurrentRuns": 2 },
    "keyExecution": "workspace",
    "sessionTtlHours": 720
  }
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `owner` | Whose listed agents are offered to developers. Required | — |
| `siteName` | The site name shown in the portal | `Open Agent API` |
| `registration` | `closed`: only the operator creates accounts; `invite`: sign-up needs an invite code; `open`: anyone can sign up | `closed` |
| `signupCredits` | Credits given to new accounts | `0` |
| `maxKeysPerAccount` | How many undeleted keys each account may have | `10` |
| `keyQuota` | The quota of account keys, in the same format as `quota` of `POST /v1/keys` | `rpm` 60, `maxConcurrentRuns` 2 |
| `keyExecution` | The execution level of account keys; only `workspace` or `sandbox`, and `host` is not accepted (writing `host` fails configuration validation) | `workspace` |
| `sessionTtlHours` | How long a portal login session is valid, in hours | `720` |

### What changes when enabled

- `features` in `/health` gains `platform-v1`.
- Data: tables whose names start with `platform_` are created in the same database, 8 in total: the 6 from 0.4.0 (`platform_accounts`, `platform_sessions`, `platform_listings`, `platform_codes`, `platform_code_uses` (which account used which code), `platform_ledger`) plus the 2 added in 0.5.0 (`platform_references`, which records the operator's external references for de-duplicating credits, and `platform_reset_codes`, which stores the hashes of reset codes, with at most one valid code per account). They are created with `CREATE TABLE IF NOT EXISTS` when the platform is enabled. The structure of existing tables such as `runs` is unchanged, and `SCHEMA_VERSION` is still 4. An older gateway that opens this database ignores these tables.
- Routes: `/v1/portal/*` (portal and developer endpoints) and `/v1/platform/*` (operator endpoints), see [Endpoint overview](#endpoint-overview). `GET /openapi.json` includes these two groups of routes only when the platform is enabled (`/v1/platform/setup` is always included).
- Pages: `/portal/` is the developer portal, reachable on any allowed Host. With `consoleHosts` configured, `/` on a non-console hostname redirects to `/portal/`.
- Console: the "Developer platform" page (`#platform`) under the "Access" group. When the platform is not enabled, this page shows only the enabling guide.

### When not enabled

No tables are created, no routes are registered, and `features` in `/health` has no `platform-v1`. The `/v1/portal/*` and `/v1/platform/*` routes below all return 404 `route_not_found`; the only exception is `GET/PUT /v1/platform/setup` (used to enable it in the console). A gateway that never saved settings in the console has no `gateway_platform_setup` table in its database either.

## What operators do

Operators have two entry points: the console's "Developer platform" page (split into four tabs: "Overview & usage", "Listings & pricing", "Developers" and "Redeem codes") and the `/v1/platform/*` endpoints. The endpoints require an owner-level admin key: one with the `admin` permission, `agents` set to `*`, and whose owner equals `platform.owner`. An admin key authorized for only some agents gets 403 `scope_denied`. Like the other admin endpoints, they can be used only on the console domain configured in `consoleHosts`. The only exception is the billing-only key with the `billing` permission, see [Connect your own payments](#connect-your-own-payments). The examples below follow the style of [deploy-public.md](deploy-public.md#7-distribute-caller-keys), section 7.

### List agents and set prices

A listed agent must already be published by `platform.owner`. Once listed, developers' account keys can see and call it.

```bash
curl -s -X PUT https://console.example.com/v1/platform/listings \
  -H "Authorization: Bearer $(cat /srv/oaa/data/admin.token)" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent/research","title":"Research assistant","summary":"Reads sources and gives an analysis.","tags":["research"],"price":{"per_run":2,"per_1k_tokens":0.5},"enabled":true}'
```

The prices in this example only show the format and are not recommended prices.

- `PUT` updates if the listing exists and creates it if not. Every field except `agent_id` can be omitted. If the agent does not exist, it returns 404 `agent_not_found`.
- `price.per_run` is credits per task and `price.per_1k_tokens` is credits per 1,000 tokens; either can be 0, with a range of 0 to 1000 credits. For a new listing, `enabled` defaults to `true`, the title defaults to the agent ID, and prices default to 0.
- A price change affects only tasks submitted afterwards; tasks in progress are settled at the price they started with (see [Billing rules](#billing-rules)).
- `enabled: false` keeps the record but takes the agent off the shelf; `DELETE /v1/platform/listings?agent_id=` removes the record. Listing status changes take effect immediately.

### Issue credits

There are three ways:

1. **Redeem codes.** Generate them in a batch and give them to developers, who redeem them in the portal or with `POST /v1/portal/redeem`.

    ```bash
    curl -s https://console.example.com/v1/platform/codes \
      -H "Authorization: Bearer $(cat /srv/oaa/data/admin.token)" \
      -H 'Content-Type: application/json' \
      -d '{"kind":"credit","credits":10,"max_uses":1,"count":5,"note":"first developers"}'
    ```

    `count` is 1 to 100; `max_uses` is how many times each code can be used, default 1, range 1 to 1,000,000; for the `credit` kind, `credits` must be greater than 0; `expires_at` (a millisecond timestamp) is optional and, when given, must be in the future. Each returned item carries the plaintext `code`, shown only this once, and can be copied as a batch. Revoke with `DELETE /v1/platform/codes/:id`.

    Redeem code input is case-insensitive and leading and trailing spaces are ignored. An `invite` code can carry `credits`, which are credited when sign-up succeeds, with ledger kind `redeem`.

2. **Adjusting a balance directly.** `POST /v1/platform/accounts/:id/credit`, with the body `{amount, note}`; `amount` can be positive or negative but not 0. If the adjusted balance would be below 0, it returns 402 `insufficient_balance` and changes nothing. `note` is at most 200 characters. When you need de-duplication by external reference (for example a payment callback), put `reference` in the body; for the payment-callback approach see [Connect your own payments](#connect-your-own-payments).
3. **A sign-up gift for new accounts.** Set by `platform.signupCredits`, or given through `credits` when the operator creates an account.

### Connect your own payments

The platform has no payment channel. You integrate payments yourself, and the platform provides the two things the integration needs:

1. A `billing` key that can only add credits.
2. Crediting de-duplicated by external reference: the same `reference` is credited only once.

**Create the key.** In the console's "API keys" page, tick "Top-up (billing)" and create it; or call `POST /v1/keys` with the `platform.owner` admin key, with `scopes` containing `billing`. The key's owner must equal `platform.owner`, otherwise it has no effect.

```bash
curl -s https://console.example.com/v1/keys \
  -H "Authorization: Bearer $(cat /srv/oaa/data/admin.token)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"payment callback","agents":["agent/research"],"scopes":["billing"]}'
```

The existing key validation requires at least one entry in both `agents` and `scopes`, so the example still carries `agent/research`. It is only a placeholder, and the key does not gain calling permission because of it: a `billing` key has only that one permission (no `invoke`) and cannot call agents. The returned `token` is shown only this once; save it in the environment of the payment callback service, written below as `$OAA_BILLING_KEY`.

**What it can and cannot do.**

- Can: add credits to an account with `POST /v1/platform/accounts/:id/credit` (`amount` must be greater than 0); find an account by email with `GET /v1/platform/accounts?query=`.
- Cannot: deduct (deducting still needs an owner-level admin key); credit with `amount` below 0 (403 `scope_denied`); list or create keys; disable accounts, reset passwords, view ledgers or do other operator actions (also 403 `scope_denied`); call agents.
- It is not an `admin` key, so it is not limited by `consoleHosts` and can be used on the API domain. Payment callbacks usually run on a server, which is exactly what this is for.

**What to do in the callback.** First find the account by email:

```bash
curl -s "https://api.example.com/v1/platform/accounts?query=dev@example.com" \
  -H "Authorization: Bearer $OAA_BILLING_KEY"
```

From the returned `data`, pick the account whose email matches exactly and take its `id` (written below as `$ACCOUNT_ID`), then credit it. Put your own external reference in `reference` (1 to 200 characters). The amount in the example only shows the format; how credits convert to actual payments is up to you.

```bash
curl -s "https://api.example.com/v1/platform/accounts/$ACCOUNT_ID/credit" \
  -H "Authorization: Bearer $OAA_BILLING_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"amount":10,"note":"payment callback","reference":"PAY-20261112-000123"}'
```

**Repeated submissions and conflicts.**

- First submission: the credit is applied, `{account, entry}` is returned, and the audit `platform_credit_adjusted` is written.
- The same `reference` submitted again: nothing is credited again, the first `{account, entry}` is returned with an extra field `duplicate: true`, and no audit is written. So repeated callbacks from the payment channel do not add credits twice.
- The same `reference` with a different `amount` than the first time, or used for another account: returns 409 `reference_conflict`, and the reference needs manual checking.
- The reference and the credit are written in one transaction and recorded in the `platform_references` table (fields: owner, reference, and ledger line ID).

**Note.** The callback must verify the payment channel's signature before calling `credit`; the platform has no payment integration and does not verify signatures for you. Keep `$OAA_BILLING_KEY` only in the callback service's environment; do not put it in a frontend and do not share it.

### Manage accounts

- Create: `POST /v1/platform/accounts`, with the body `{email, password, name?, credits?}`, not limited by `registration`.
- Find: `GET /v1/platform/accounts?query=&limit=&cursor=`, which returns each account's balance, key count, task count, cumulative consumption and last activity.
- Disable or enable: `POST /v1/platform/accounts/:id/status`, with the body `{status}` set to `active` or `disabled`. After disabling, all of the account's sessions are invalidated, and its keys are rejected at the next authentication (`account_disabled`, 403).
- Resetting a password can be done in two ways:
  - **Generate a one-time reset code (recommended)**: `POST /v1/platform/accounts/:id/reset-code`, with no body, returns 201 `{code, expires_at}`. The plaintext is returned only this once and is valid for 24 hours; generating another invalidates the old code. Hand the code to the developer through another channel, and the developer sets a new password in the portal (see [Forgot password](#forgot-password) under "What developers do"). So the operator never learns the developer's password. Once the code is used, all of the account's sessions are invalidated.
  - **Set a new password directly**: `POST /v1/platform/accounts/:id/password`, with the body `{new_password}`. All of the account's sessions are invalidated. The operator will know this new password.
- Ledger and usage: `GET /v1/platform/accounts/:id/ledger` and `GET /v1/platform/usage?days=30`; for the overview see `GET /v1/platform/summary`. The "Overview & usage" tab of the console platform page has a usage block that views usage by day, by agent and by account; `by_account` returns at most the 50 accounts with the highest consumption.
- Audit: adjusting a balance, disabling or enabling an account, and resetting a password (including generating a reset code) all write audit records. An admin key on the console domain can read them through `GET /v1/audit`, see [protocol.md](protocol.md#audit-records-p1) ("Audit records"). The platform's audit codes are `platform_credit_adjusted`, `platform_account_status` and `platform_password_reset` (for generating a reset code, the detail is `reset_code`); a record carries `account_id` and a one-line description (such as `amount=3 balance_after=3`, `status=disabled`), and contains no passwords, original notes or redeem codes; see the "Developer platform" chapter of [protocol.md](protocol.md#developer-platform).

## What developers do

Developers can sign up, redeem codes, create keys and view usage in the portal at `https://api.example.com/portal/`; the portal defaults to Chinese and can switch to English. They can also call the `/v1/portal/*` endpoints directly; `curl` examples of the calls are given below.

### Sign up and sign in

How you can sign up depends on `registration`:

- `closed`: returns 403 `registration_closed`; contact the operator to have an account created.
- `invite`: an `invite_code` is required. A missing one returns 403 `invite_required`; an invalid, used-up or expired code returns 400 `invalid_code`.
- `open`: anyone can sign up.

```bash
curl -s https://api.example.com/v1/portal/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"choose-your-own-password"}'
```

A successful sign-up returns 201 with `{ account, session }`. `session.token` starts with `oas_`; put it in the `Authorization: Bearer` header afterwards, and it works only on `/v1/portal/*`. A registered account signs in with `POST /v1/portal/login` (body `{email, password}`). An unknown email and a wrong password both return 401 `invalid_credentials`. The session lifetime is set by `sessionTtlHours`, 720 hours by default. The password must be 8 to 200 characters.

The platform has no email, so there is no email verification and no reset by email. For a forgotten password see [Forgot password](#forgot-password) below.

### Redeem credits

```bash
curl -s https://api.example.com/v1/portal/redeem \
  -H "Authorization: Bearer $OAS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"CODE-FROM-OPERATOR"}'
```

It returns `{ account, credited }`. An account cannot use the same code twice.

### Create an account key

```bash
curl -s https://api.example.com/v1/portal/keys \
  -H "Authorization: Bearer $OAS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-app"}'
```

It returns 201, and the `token` in it starts with `sk-oaa-` (`sk-oaa-` followed by 48 letters and digits) and is shown only this once; older keys starting with `oaa_` keep working. When the number of undeleted keys reaches `maxKeysPerAccount`, it returns 409 `key_limit_reached`. Delete with `DELETE /v1/portal/keys/:id`: the key stops working at once and no longer appears in the key list.

An account key's permissions are fixed: `scopes` are `invoke`, `read` and `files`, with no `approve` and no `admin`. The agents it can see and call are the ones listed and enabled under the owner. The execution level and quota come from the `platform` configuration. Several keys of one account share runs and files.

### See which agents you can call

- `GET /v1/portal/agents`: the list of listed and enabled agents.
- `GET /v1/portal/agent?id=agent/research`: details of one agent, including its description, price, selectable model routes (`models`, which always include `auto`) and its access profile (`conversion`). If it is not listed, it returns 404 `agent_not_found`.
- `GET /v1/me` (called with an account key): the response has an extra field `account: { id, balance }`, which lets you see the balance.

### Call an agent

In `model`, pass the agent's call name, not a model name. To choose a model route, pass `metadata["oaa.model"]`; the routes an agent accepts are listed as `models`.

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

- Account keys work on the OpenAI Responses, OpenAI Chat Completions and Claude Messages endpoints (and the other compatibility endpoints), and streaming works on all of them.
- `model` takes the agent's call name, not a model name.
- If the agent has a price (the two prices are not both 0) and your balance is too low, the request fails with 402 `insufficient_balance`, and no task is created.
- For a long task, pass `background=True` in the Python SDK call, and poll the task with `client.responses.retrieve(response.id)`; the style is the same as in [Running in three minutes](../README.md#running-in-three-minutes) in the README.
- If a non-streaming call fails, is cancelled or interrupted, or waits for approval after its task was created, Chat Completions, Claude Messages and Gemini return 422 with `x-should-retry: false`, so the official SDKs do not retry it (checked in this repository with the official `openai` and `@anthropic-ai/sdk` Node SDKs; and once with a temporarily installed `@google/genai` 3.2.0, which does not retry by default). Responses returns a response object with a `status` as usual. For each endpoint's error shape, retry headers and finish reason on truncation, see [Compatibility-endpoint parameters, errors and finish reasons](protocol.md#compatibility-endpoint-parameters-errors-and-finish-reasons-060) in protocol.md and [Error handling](#error-handling) below.

### See what your task did

The Tasks page of the portal (its heading is "Task history") lists the tasks your account started, newest first; you can filter by agent and page through the list. Opening a task shows its "Task details": status, start and end times, usage, charge, output, and the execution timeline. The matching endpoints are:

- `GET /v1/portal/runs?limit=20&cursor=&agent=` returns `{ data: RunItem[], next_cursor }`. `limit` is 1 to 200, default 20; `agent` is optional and filters by agent; `next_cursor` is the cursor for the next page (a number) and is `null` when there are no more pages.
- `GET /v1/portal/runs/:id` returns `RunDetail`. A task that is not your account's, or does not exist, returns 404 `run_not_found`.

```bash
curl -s "https://api.example.com/v1/portal/runs?limit=20" \
  -H "Authorization: Bearer $OAS_TOKEN"
```

The `timeline` in the detail is the execution record of the task and is the same as the response of `GET /v1/runs/:id/timeline`. It lists the task's spans in order: queueing, model turns, tool calls, approvals and so on. Each span has a kind, a label, a status, and start and end times in milliseconds from the start of the task. There are 8 kinds (`kind`): `queue`, `model`, `tool`, `approval`, `client_tool` (waiting for the caller to run its own tool), `subagent`, `interrupted`, and `native` (the run of an external agent).

- `status` is `in_progress` while the task runs; after that it is the task's final state, the same as in its ledger line, that is, the run's final status.
- `created_at` is when the task was recorded, the same as its ledger line. `completed_at` is when the task ended, and `null` while it runs.
- `charge` is the credits already charged for the task, as a positive number. `price` is the price recorded when the task started.
- `usage` is the task's usage object and may be `null`; `error` is `{code, message}` or `null`.
- `output_text` is the output text, with the parts separated by a blank line. It is truncated to 200,000 characters, with an ellipsis (`…`) at the end when it is cut.
- If the task's detailed run record has been cleaned up but its ledger line remains, the detail still returns the fields the ledger has; `timeline`, `usage`, `error` and `completed_at` are `null`, and `output_text` is an empty string.

### Try it in the browser

The Playground of the portal lets you call a listed agent from the browser: choose an agent, optionally a model route, enter one of your own account keys (`sk-oaa-…`), and type a task. The output streams into the page, and when the task finishes, the page links to the record page of that task.

- The page calls `POST /v1/chat/completions` directly (`stream: true`) and passes the model route in `metadata["oaa.model"]`. It needs no extra backend endpoint.
- The key stays only in the page's memory, is not written to `localStorage`, and is discarded when you leave the page.
- Trying an agent is billed the same way as any other call, with the same price rules.
- The Playground is for trying things out. For production, call the API from your own server, and do not put the key into a browser page.

### Usage, ledger and password

- `GET /v1/portal/usage?days=30`: the balance, and the totals, per-day and per-agent usage for the last `days` days (1 to 90). `totals` counts only the data within these `days` days; the cumulative figures over all time are in the operator endpoint `GET /v1/platform/summary`, and in `runs` and `spent` of `AdminAccount`.
- `GET /v1/portal/ledger?limit=50&cursor=`: the ledger, newest first. Use the returned `next_cursor` to page.
- `POST /v1/portal/account/password`, with the body `{current_password, new_password}`, returns 204. After the password changes, all of the account's sessions (including the current one) are invalidated and you need to sign in again. A wrong current password returns 401 `invalid_credentials` and the session is unaffected.
- `POST /v1/portal/logout` returns 204.

### Forgot password

The platform has no email, so there is no self-service reset by email. If you forget your password, first ask the operator for a one-time reset code. The code is 20 characters, is valid for 24 hours, and can be used once; if the operator generates a new one, the old one stops working. Then do one of the following:

1. On the portal sign-in page, click "Forgot your password?" to open the page titled "Set a new password with a reset code".
2. Call `POST /v1/portal/password-reset`:

```bash
curl -s https://api.example.com/v1/portal/password-reset \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","code":"CODE-FROM-OPERATOR","new_password":"choose-a-new-password"}'
```

It returns 204. The new password is 8 to 200 characters. Once the code is used, every session of the account is invalidated and you need to sign in again. A wrong, expired or already-used code, or an unknown email, all return 400 `invalid_code`, and the endpoint never reveals whether the email exists. The endpoint is rate limited by source IP and by email, with the same numbers as sign-in (30 attempts per source IP and 10 per email, each within 10 minutes), but counted separately from sign-in; exceeding them returns 429 `rate_limited`. To change the password while signed in, use `POST /v1/portal/account/password`, see above.

## Billing rules

Billing is recorded in credits. One run corresponds to one task. Amounts are stored internally as integer micro-credits (1 credit = 1,000,000 micro-credits), and API amounts have up to six decimal places. The rules are:

1. **Prices.** Each listed agent has two prices: `per_run` (credits per task) and `per_1k_tokens` (credits per 1,000 tokens). Either can be zero.
2. **What is billed.** Only root runs started with an account key are billed. Runs started with the operator's own keys are not billed. One run is one task: continuing a conversation with `previous_response_id` starts a new call each time, billed as a new task. Caller-tool bridging (a task stops to wait for the caller to execute a tool and continues after the result is returned) is the same run and is billed once. Child runs produced by delegation are not billed separately, but the tokens they use are already merged into the parent run's usage, so the per-token part includes the child runs.
3. **Checked at submission.** For an agent that is not free (the two prices are not both 0), a submission is refused with 402 `insufficient_balance` and no run is created if the balance is below `per_run` or the balance is 0 or less. A free agent (both prices 0) can be called even with a zero balance.
4. **Recorded at start.** When a run starts, a ledger line of `kind: run` is written with the price at that moment. A later price change does not affect a task in progress. While the run is in progress, the line has `status` of `in_progress` and `amount` of 0; when it ends, `status` becomes the run's status (`completed`, `failed`, `cancelled`, `interrupted` or `incomplete`) and `amount` becomes the actual amount.
5. **Settled at the end.** A `completed` run is charged `per_run + per_1k_tokens × total_tokens / 1000`. Other final states (failed, cancelled, interrupted and so on) charge only the token part, not the per-task fee. An interrupted run is settled at the tokens it had used when it was interrupted: at a normal gateway shutdown that happens at once, and a line left in progress by a gateway crash is settled by reconciliation at the next startup (rule 11). Amounts round up to the micro-credit.
6. **Idempotent.** A run corresponds to one ledger line. When the same run is settled more than once (for example, interrupted, then resumed and completed again), the balance is adjusted by the difference between the new and old amounts due, and it is never charged twice. The account key's token usage (`PortalKey.usage.used_tokens`) is also increased only by the difference; historical data that was over-counted before the upgrade is not corrected.
7. **Overdraft.** The token count cannot be known before a task ends, so after settlement the balance can briefly go negative. The next submission is then refused by rule 3. The concurrency limits (`keyQuota.maxConcurrentRuns`, `maxActiveRunsPerSubject`) bound the worst-case overdraft.
8. **External agents may not report tokens.** When `total_tokens` is 0 or missing, only the per-task price applies. Token counts are not cost estimates, and this document does not present them as costs.
9. **Precision.** Amounts are stored and calculated internally as integer micro-credits (1 credit = 1,000,000 micro-credits). Amounts in the API are in credits, with up to 6 decimal places.
10. **Invariant.** The balance of any account always equals the sum of the `amount` of all its ledger lines.
11. **Startup reconciliation.** After the gateway starts (without blocking startup), it checks the ledger lines that are still `in_progress`. A run that has ended (including an interrupted run still in the database) is settled by the final-state rule in rule 5, and an interrupted run is settled by the tokens it had used; if the run record no longer exists, the line is marked `interrupted` and settled at 0 tokens, so the amount is 0 (its usage can no longer be known); a run still queued or waiting is left alone. Reconciliation is idempotent: running it repeatedly does not change the result.
12. **Resume.** Before an interrupted run is resumed (`POST /v1/runs/{id}/resume`), the rules for a new submission are checked again: whether the key that owns the run is still valid (an expired or deleted key is refused; when an admin resumes another key's run and the original key is inactive, it returns 409 `run_key_inactive`), whether the account is enabled (a disabled one returns 403 `account_disabled`), whether the agent is still available to this key (if the listing was taken down, 403 `scope_denied`), the balance for a paid agent (insufficient returns 402 `insufficient_balance`), and the key's concurrency, token and run-count quotas. If any check fails, the run stays interrupted and nothing is written. When they pass, the line goes back to `in_progress` and is settled by the difference when it completes. A resumed run, and a run re-queued after the gateway starts, count against the owning key's concurrency limit again, but do not increase its run count.

## Endpoint overview

Conventions:

- Error responses keep the shape `{ "error": { "code", "message", "type" } }`; for error codes see [Error codes](#error-codes).
- Amount fields are all in credits.
- Times are all millisecond timestamps.
- When `platform` is not configured, the routes below do not exist (404 `route_not_found`).

### Objects

```text
Account      { id, email, name, status, balance, created_at }
Session      { token, expires_at }
PortalKey    { id, name, created_at, revoked (always false), quota, usage: { used_tokens, used_runs, active_runs } }
Price        { per_run, per_1k_tokens }
ListedAgent  { id, title, summary, tags, description, kind: "kernel" | "external", models, price, updated_at, conversion? }
Listing      { agent_id, title, summary, tags, price, enabled, updated_at, agent_exists }
LedgerEntry  { id, kind, amount, balance_after, agent, run_id, tokens, status, note, reference?, created_at }
Usage        { balance, totals: { runs, tokens, spent }, daily: [{ date, runs, tokens, spent }], by_agent: [{ agent, runs, tokens, spent }] }
RunItem      { id, agent, status, tokens, charge, created_at }
RunDetail    { id, agent, status, created_at, completed_at, usage, error, charge, price: Price, output_text, timeline }
Code         { id, kind, credits, max_uses, used, expires_at, note, revoked, created_at }
AdminAccount = Account + { keys, runs, spent, last_active_at }
```

`models` is the list of model route names the agent accepts (including `auto`). `conversion` is the existing access-profile object, passed through as is. `daily[].date` is the UTC `YYYY-MM-DD`, with no missing days. `spent` is positive. `charge` is the credits already charged (a positive number). `reference?` appears only on a credit that carries an external reference; other ledger lines do not have this field (it is not `null`). For the meaning of the fields of `RunDetail` see [See what your task did](#see-what-your-task-did).

### Public (no credentials)

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /v1/portal/site` | — | `{ site_name, registration, base_url, endpoints, version }` (`endpoints` is the same directory as `GET /v1/me`) |
| `GET /v1/portal/agents` | — | `{ data: ListedAgent[] }` |
| `GET /v1/portal/agent?id=` | — | `ListedAgent`; not listed: 404 `agent_not_found` |
| `POST /v1/portal/signup` | `{ email, password, name?, invite_code? }` | 201 `{ account, session }` |
| `POST /v1/portal/login` | `{ email, password }` | `{ account, session }` |
| `POST /v1/portal/password-reset` | `{ email, code, new_password }` | 204; a wrong, expired or used code or an unknown email all give 400 `invalid_code`; rate limited by source IP and email |

### Portal session (`Authorization: Bearer oas_…`)

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /v1/portal/logout` | — | 204 |
| `GET /v1/portal/account` | — | `{ account }` |
| `POST /v1/portal/account/password` | `{ current_password, new_password }` | 204; all sessions end |
| `GET /v1/portal/keys` | — | `{ data: PortalKey[] }`, newest first; deleted keys are not listed |
| `POST /v1/portal/keys` | `{ name }` | 201 `PortalKey + { token }` (the plaintext appears only once) |
| `DELETE /v1/portal/keys/:id` | — | 204 |
| `POST /v1/portal/redeem` | `{ code }` | `{ account, credited }` |
| `GET /v1/portal/usage?days=30` | — | `Usage` (`days` is 1 to 90) |
| `GET /v1/portal/ledger?limit=50&cursor=` | — | `{ data: LedgerEntry[], next_cursor }` (newest first) |
| `GET /v1/portal/runs?limit=20&cursor=&agent=` | — | `{ data: RunItem[], next_cursor }` (newest first; `limit` is 1 to 200, `agent` is optional and filters by agent) |
| `GET /v1/portal/runs/:id` | — | `RunDetail`; not this account's task or not found: 404 `run_not_found` |

### Operator (owner-level admin key, console domain only)

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /v1/platform/setup` | — | `{ enabled, source, managed_by_config, pending_restart, owner, settings, desired }`: `enabled` is whether the platform is running in the current process; `source` is where the running platform comes from, `"config"` (the configuration file) or `"console"` (settings saved in the UI), and `null` when it is not running; `managed_by_config` is true when the configuration file has a `platform` section (the UI is read-only); `pending_restart` means the saved settings differ from the current running state and take effect after a restart; `owner` is the owner the agents belong to once enabled; `settings` is `{ site_name, registration, signup_credits }`, or `null` if never saved; `desired` is the saved switch. **Available even when the platform is not enabled**; the settings belong to the owner that enabled it first, and any other owner gets 403 `scope_denied` |
| `PUT /v1/platform/setup` | `{ enabled, site_name?, registration?, signup_credits? }` (extra fields give 400; value ranges are the same as the `platform` section of the configuration file; with `enabled: false` the other fields are ignored; fields not given keep their saved values) | The same as GET; takes effect after a restart; writes an audit (`platform_setup`); 409 `platform_managed_by_config` when the configuration file has a `platform` section |
| `GET /v1/platform/summary` | — | `{ site_name, registration, accounts: { total, active, disabled }, balance_total, spent_total, runs_total, tokens_total, listings }` |
| `GET /v1/platform/accounts?query=&limit=&cursor=` | — | `{ data: AdminAccount[], next_cursor }` |
| `POST /v1/platform/accounts` | `{ email, password, name?, credits? }` | 201 `{ account }` (not limited by `registration`) |
| `POST /v1/platform/accounts/:id/status` | `{ status }` | `{ account }` |
| `POST /v1/platform/accounts/:id/credit` | `{ amount, note, reference? }` (positive or negative, and the result must not go below 0; `reference` is an external reference of 1 to 200 characters; a `billing` key can use positive amounts only) | `{ account, entry }`; when the same `reference` is submitted again there is an extra `duplicate: true` and the first result is returned |
| `POST /v1/platform/accounts/:id/password` | `{ new_password }` | 204 |
| `POST /v1/platform/accounts/:id/reset-code` | — | 201 `{ code, expires_at }` (the plaintext appears only once, valid for 24 hours, and generating a new one invalidates the old one) |
| `GET /v1/platform/accounts/:id/ledger?limit=&cursor=` | — | `{ data: LedgerEntry[], next_cursor }` |
| `GET /v1/platform/listings` | — | `{ data: Listing[] }` |
| `PUT /v1/platform/listings` | `{ agent_id, title?, summary?, tags?, price?, enabled? }` | `Listing` (updates if it exists and creates otherwise; 404 `agent_not_found` if the agent does not exist) |
| `DELETE /v1/platform/listings?agent_id=` | — | 204 |
| `GET /v1/platform/codes` | — | `{ data: Code[] }` |
| `POST /v1/platform/codes` | `{ kind, credits?, max_uses?, count?, expires_at?, note? }` (`count` is 1 to 100) | 201 `{ data: (Code + { code })[] }` |
| `DELETE /v1/platform/codes/:id` | — | 204 (revoke) |
| `GET /v1/platform/usage?days=30` | — | `Usage + { by_account: [{ account_id, email, runs, tokens, spent }] }` |

A few more points:

- When an account key calls `GET /v1/me`, the response has an extra field `account: { id, balance }`. Responses for other keys are unchanged.
- `GET /v1/keys` (the console's key list) does not include account keys, and its output is the same as before.
- A billing-only key with the `billing` permission (whose owner equals `platform.owner`) can call `POST /v1/platform/accounts/:id/credit` and `GET /v1/platform/accounts?query=` from the table above, is not limited by `consoleHosts`, but `credit` can only add credits (`amount` must be greater than 0). The other operator endpoints still accept only owner-level admin keys.

## Error handling

Each compatibility entry returns errors in its own protocol's shape:

- **OpenAI-compatible endpoints** return `{"error":{"code","message","type","param"}}`. The gateway's stable code is in `error.code`.
- **Claude Messages** returns `{"type":"error","error":{"type","message","code"}}`. `error.type` follows the HTTP status (for example `rate_limit_error` for 429). The gateway's code is in `error.code`. Paths under `/v1/messages/` that the gateway does not serve (such as `count_tokens`) return the same shape with `not_found_error`, which the Anthropic SDK raises as `NotFoundError`.
- **Gemini** returns `{"error":{"code","message","status","details"}}`. The gateway's code is in `details[0].reason`.

When a task has already been created, the error also carries its run ID (`run_id`, or `details[0].metadata.run_id` for Gemini).

- **422, not retried.** A non-streaming Chat Completions, Claude Messages or Gemini call whose task was created but did not finish (failed, cancelled, interrupted or waiting for approval) returns 422 with `x-should-retry: false`. Responses returns a response object with a `status` instead.
- **Retry-After.** A rate-limited 429 (`rate_limited`) gives the seconds left in the current 60-second window. Other retryable capacity limits give 10 seconds. A 429 for an exhausted key quota has `x-should-retry: false` and no `Retry-After`.
- **Ignored parameters.** Sampling parameters such as `temperature` are accepted but not forwarded. Their names are listed in the `X-OAA-Ignored-Params` header, which is absent when nothing was ignored.
- **Output limits.** `max_tokens`, `max_output_tokens` and `maxOutputTokens` take effect. The gateway uses the smaller of the request value and the agent's own limit. This applies to built-in kernel agents only; external agents are not affected.
- **Truncation is not an error.** Chat Completions returns `finish_reason: "length"` with status 200 (a stream still ends with `[DONE]`). Claude returns `stop_reason: "max_tokens"`, Gemini returns `finishReason: "MAX_TOKENS"`, and Responses returns `status: "incomplete"`.
- **Unsupported input.** An unknown field on a strict endpoint returns 400 `unsupported_parameter`, with the field name in `param`. Inline images and audio return 400 `unsupported_content` on every compatibility endpoint (OpenAI, Claude, Gemini); see [protocol.md](protocol.md).

## Error codes

These error codes belong to the `platform` category. The complete error-code catalog is in [protocol.md](protocol.md#error-codes-errorcode) ("Error codes"). The portal endpoints can also return general codes such as `run_not_found` and `rate_limited`, which are likewise in protocol.md.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `registration_closed` | 403 | Self-service sign-up is not open on this site |
| `invite_required` | 403 | Sign-up requires an invite code |
| `invalid_code` | 400 | A redeem or invite code is invalid, used up, expired, or already used by this account; any failure of a reset code (wrong, expired, already used, or unknown email) also returns this code |
| `email_taken` | 409 | The email is already registered |
| `invalid_credentials` | 401 | The email or password is incorrect |
| `session_invalid` | 401 | The portal session is invalid or has expired |
| `account_disabled` | 403 | The account is disabled (its sessions and account keys are rejected) |
| `account_not_found` | 404 | The account does not exist |
| `insufficient_balance` | 402 | The balance is not enough (returned before a task is created) |
| `key_limit_reached` | 409 | The account has reached its key limit |
| `listing_not_found` | 404 | The agent has no listing |
| `code_not_found` | 404 | The code does not exist |
| `reference_conflict` | 409 | This external reference was already used for a credit of a different amount, or for a credit to another account (when a `billing` key calls `credit`) |
| `platform_managed_by_config` | 409 | The configuration file already has a `platform` section, so the platform settings cannot be changed in the console (`PUT /v1/platform/setup`); edit the configuration file and restart, or delete that section and enable it in the console |

## Security notes

- **The two kinds of tokens are not interchangeable.** A portal session (`oas_…`) works only on `/v1/portal/*`; an account key (`sk-oaa-…`, and likewise the older `oaa_…`) works only on calling endpoints.
- **An account key's permissions are fixed.** `scopes` are `invoke`, `read` and `files`, with no `approve` and no `admin`. The execution level can only be `workspace` or `sandbox` as configured by `keyExecution`, never `host`. The meaning of the execution level is the same as `defaultKeyExecution` in [deploy-public.md](deploy-public.md#4-gateway-configuration), section 4: a `workspace`-level key can call only workspace-level agents and cannot call native agents, adapters or host tools.
- **Only listed agents can be called.** An agent that is not listed or is disabled is invisible to and cannot be called by an account key.
- **Disabled means invalid.** When an account is disabled, all its sessions are invalidated and its keys are rejected at authentication (`account_disabled`, 403). All of an account's sessions are invalidated when the password changes, when it is disabled, when the operator resets the password, and when a new password is set with a reset code.
- **Password storage.** It uses scrypt from `node:crypto` with the parameters `N=32768, r=8, p=3`, an independent random salt per account, and `timingSafeEqual` for comparison. The parameters are written together with the salt in the stored string (`scrypt$N$r$p$salt$hash`), so changing the strength later does not affect existing accounts. The length is 8 to 200 characters. No new dependency is introduced.
- **Sign-in failures do not reveal whether an email exists.** An unknown email and a wrong password both return 401 `invalid_credentials`; an equivalent hash computation is also done for an unknown email.
- **Rate limits.** Sign-up allows 10 attempts per source IP per hour; sign-in and password reset (`POST /v1/portal/password-reset`) allow 30 attempts per source IP and 10 per email, each within 10 minutes. Exceeding them returns 429 `rate_limited`. Every attempt counts, whether it succeeds or fails. The counters are kept in process memory and are effective for a single instance. The source IP follows the gateway's existing rule: `X-Forwarded-For` is read only when `trustProxy` is on.
- **Auditing of admin endpoints.** Adjusting a balance, disabling or enabling an account, resetting a password and generating a reset code all write audit records.
- **Redeem codes.** The plaintext is returned only once, when generated, and the database stores only a hash. An account cannot use the same code twice.
- **Billing-only keys.** A key with the `billing` permission can only add credits to accounts (`credit`, `amount` must be greater than 0) and look accounts up by email; it cannot deduct, manage accounts or call agents. It is not an `admin` key, so it can be used on the API domain; only such a key whose owner equals `platform.owner` takes effect. Keep it only in the payment callback service, and verify the payment channel's signature in the callback before calling `credit`.
- **Reset codes.** A reset code the operator generates is stored only as a hash, bound to the account, valid once, and expires after 24 hours; generating a new one invalidates the old one; once used, all of the account's sessions are invalidated. The reset endpoint returns 400 `invalid_code` uniformly for a wrong code, an expired code, a used code and an unknown email, and does an equivalent hash computation, so it does not reveal whether an email exists. Its rate-limit numbers are the same as sign-in, but counted separately from sign-in.
- **Abuse prevention for open registration.** It relies on invite-code mode (`registration: invite`) and rate limiting; passwords are set by the developer with a reset code, or set directly by the operator.
- **Portal pages.** They use the same strict CSP as the console, with no inline scripts or inline styles.
- **Do not list native agents for developers you do not know.** Native agents such as Codex, Claude, Antigravity and DSH run with the host's permissions, see [deploy-public.md](deploy-public.md#1-confirm-before-deploying), section 1. At the `workspace` level, an account key cannot call them anyway.

## Limits

These are the current explicit boundaries:

- **Single gateway with SQLite.** There are no multiple instances, no Postgres and no failover.
- **One publisher.** The platform offers only the agents listed under `platform.owner` to developers; there is no settlement across several publishers.
- **No real payments.** Credits are issued by the operator (redeem codes or manual adjustments). Which payment channel to use and which currency, is up to the operator.
- **No email.** So reset codes must be handed to the developer by the operator through another channel. There is no email verification.
- **Rate-limit counters are in process memory** and reset when the gateway restarts.
- **Startup reconciliation scans the ledger.** Startup reconciliation (see [Billing rules](#billing-rules), rule 11) has to find the ledger lines still marked in progress; with a large ledger, this step is slower after startup. It runs asynchronously after startup and does not block it.
- **Some external agents do not report tokens.** In that case only the per-task price applies, and token counts are not cost estimates.
- **The balance can briefly go negative.** See [Billing rules](#billing-rules), rule 7.
- **The command line has no platform management commands.** Operator actions are done in the console or through the `/v1/platform/*` endpoints.
- **`trustProxy` must be on behind a reverse proxy.** When the gateway sits behind a reverse proxy, `trustProxy` must be on (see [deploy-public.md](deploy-public.md#4-gateway-configuration), section 4); otherwise every visitor's source IP is the proxy's address, and they all share one rate-limit counter.
- **Per-email sign-in rate limiting has a side effect.** If someone repeatedly tries wrong passwords for an email, that email cannot sign in for 10 minutes, even with the correct password. This is the trade-off for resisting brute force.
- **No inline images** (base64 or URL). Upload through `POST /v1/files` first and reference by file ID. Every compatibility endpoint explicitly rejects inline images and audio (400 `unsupported_content`), see [protocol.md](protocol.md).
- **Event streams are capped.** Each key may hold at most 64 run event streams at once (`/events`, `/wait`, `GET /v1/responses/{id}?stream=true` and streaming requests on the compatibility endpoints), and each owner 256; more answer 429 `too_many_streams` with `Retry-After`.
- **No subscription pooling, and no relaying of login sessions.**
