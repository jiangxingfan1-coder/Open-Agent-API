# Run-event webhooks

English · [简体中文](zh-CN/webhooks.md)

A call to an agent is a **run**. Runs can take a long time and can stop to wait for a person's
approval. Without webhooks a caller has to poll or keep a connection open, and approvals can only be
handled in the console or with `oaa approve`. Webhooks push run events to an HTTPS endpoint of yours,
so that you can be told when a long task ends and route approval requests into a chat tool or your
own system.

Feature flag: `webhooks-v1` in `GET /health`.

## Contents

1. [Who can configure webhooks](#who-can-configure-webhooks)
2. [Events](#events)
3. [Payload](#payload)
4. [Signature and headers](#signature-and-headers)
5. [Delivery](#delivery)
6. [Outbound safety](#outbound-safety)
7. [API](#api)
8. [Command line and console](#command-line-and-console)
9. [Walkthrough: approvals in your own system](#walkthrough-approvals-in-your-own-system)
10. [Limits and what is not covered](#limits-and-what-is-not-covered)

## Who can configure webhooks

Only an **owner-wide admin key** (the `admin` scope and `agents` containing `*`). Developer-platform
accounts and ordinary caller keys cannot configure webhooks, and a single request cannot carry a
callback URL: a caller-chosen URL would let any caller make the gateway send requests to addresses of
its choosing (SSRF). Endpoints belong to the owner and receive the events of every run of that owner,
whichever key started the run.

## Events

Every event corresponds to one run status of the kernel state machine (`src/core/run-status.ts`) and
to the run event the kernel writes when the run enters it (`src/core/events.ts`):

| Webhook event | Run status | Kernel event | When |
| --- | --- | --- | --- |
| `run.requires_action` | `requires_action` | `run.requires_action` | A new item is waiting: an approval, or a tool result the caller has to send back (bridge). Sent once per new pending item; the payload lists every item pending at that moment. |
| `run.completed` | `completed` | `response.completed` | The run finished normally. |
| `run.failed` | `failed` | `response.failed` | The run failed (including a denied or expired approval). `error.code` says why. |
| `run.cancelled` | `cancelled` | `response.cancelled` | The run was cancelled. |
| `run.incomplete` | `incomplete` | `response.incomplete` | The run stopped at a limit: deadline, turns or budget. |
| `run.interrupted` | `interrupted` | `run.interrupted` | The run was interrupted, for example by a gateway restart; it can be resumed with `POST /v1/runs/{id}/resume`. |

`run.incomplete` is an addition to the list the feature started with: `incomplete` is a final status of
the kernel too, and without it a task that ran into its deadline would end silently.

An endpoint subscribes to a list of events (empty means all six) and can be limited to a list of
agents (empty means all). Each run sends each final event at most once; `run.interrupted` is sent
once per run as well, even if the run is resumed and interrupted again.

There is also `webhook.test`, sent only by `POST /v1/webhooks/{id}/test`.

## Payload

The request body is JSON:

```json
{
  "id": "evt_6c1f…",
  "type": "run.requires_action",
  "created_at": 1763101040,
  "data": {
    "object": "run",
    "run_id": "resp_c61d…",
    "agent": "agent/sample",
    "agent_version": "9f2c…(64 hex)",
    "status": "requires_action",
    "error": null,
    "usage": null,
    "key_id": "key_…",
    "subject": "key:key_…",
    "created_at": 1763101039,
    "updated_at": 1763101040,
    "pending_actions": [
      {
        "id": "approval_a7b0…",
        "type": "native",
        "title": "Write outputs/sample-note.txt",
        "status": "pending",
        "expires_at": 1763101340
      }
    ]
  }
}
```

- `id` is the event ID; when one event goes to several endpoints they all get the same `id`.
- `created_at`, `data.created_at`, `data.updated_at` and `expires_at` are Unix seconds.
- `data.error` is `{code, message}` or `null`; `data.usage` is `{input_tokens, output_tokens,
  total_tokens}` or `null` (unknown).
- `data.key_id` and `data.subject` identify the key that started the run and its caller partition
  (`key:<id>`, or `acct:<id>` for a developer-platform account).
- `pending_actions` appears only on `run.requires_action`. `type` is `tool`, `native`, `reconcile` or
  `client_tool` (a tool result the caller has to send back). `status` is the item's state when the
  body was built (normally `pending`).
- **The task input and the output text are not included** (privacy and size). An endpoint created with
  `include_output: true` gets `data.output = {text, truncated, bytes}` on run events: the final output
  text, cut to at most 32 KiB of UTF-8 (`truncated: true` and the full size in `bytes` when cut).
- For anything else, read the run with its ID: `GET /v1/runs/{id}`, `GET /v1/runs/{id}/output`,
  `GET /v1/runs/{id}/actions`.

The body is built at the first delivery attempt and then fixed: retries send the same bytes.

## Signature and headers

Every request carries:

| Header | Value |
| --- | --- |
| `X-OAA-Signature` | `t=<Unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>` |
| `X-OAA-Event` | The event type, for example `run.completed` |
| `X-OAA-Delivery` | The delivery ID (`whd_…`). It stays the same across retries and manual redelivery: use it to drop duplicates. |
| `User-Agent` | `OpenAgentAPI/<version>` |
| `Content-Type` | `application/json` |

The signing secret (`whsec_…`) is returned only when the endpoint is created and when it is rotated.
The gateway stores it (it has to sign with it), in its database, next to the endpoint.

To verify: take the **raw** request body (before any JSON parsing), compute HMAC-SHA256 over
`t + "." + body` with the secret, compare it with `v1` in constant time, and **reject a `t` that is
more than 5 minutes away from your clock** so a captured request cannot be replayed later. Then
de-duplicate on `X-OAA-Delivery`.

Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(parts.v1 ?? '') ? parts.v1 : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Python:

```python
import hashlib, hmac, time

def verify(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

## Delivery

- **At least once.** Events are queued in the gateway's SQLite database (`webhook_deliveries`) and
  survive a restart; whatever was not delivered when the gateway stopped is sent after it starts
  again. A receiver may see a delivery more than once; de-duplicate on `X-OAA-Delivery`.
- **Success** is any `2xx` answer within **10 seconds** (connect, send and answer together).
  Redirects are not followed; a `3xx` counts as a failure. Answer fast and do the work afterwards.
- **Retries.** A failed attempt is retried after about 5 s, 30 s, 2 min, 10 min and 30 min (each ±20 %
  random jitter): 6 attempts in all. After the last one the delivery is marked `failed` and kept.
  A finished delivery can be queued again by hand with
  `POST /v1/webhooks/{id}/deliveries/{delivery}/redeliver` (same delivery ID, a fresh attempt budget).
- **Order.** Deliveries to one endpoint go out one at a time, oldest first, so a receiver sees the
  events of an endpoint in order; a delivery waiting for its retry holds back the later ones of the
  same endpoint. Different endpoints do not wait for each other.
- **Never in the way of a run.** Queuing an event is one small insert after the run's status is
  committed, and happens only when a matching endpoint exists. Sending happens in the background; a
  slow or dead receiver does not delay or block any run.
- **Failing endpoints** are not deleted or disabled automatically. The endpoint's `status` shows
  `state: "failing"`, `consecutive_failures`, the last error and how many deliveries are queued.
- A disabled endpoint (`enabled: false`) gets no new events; deliveries already queued for it wait until
  it is enabled again. Deleting an endpoint deletes its queued deliveries.
- The last 200 finished deliveries per endpoint are kept.
- At most 10,000 deliveries wait per endpoint. Above that (an endpoint that keeps failing while events keep coming) the oldest waiting deliveries after the one in progress are marked `failed` with `queue_overflow` and dropped, so a broken receiver cannot grow the database without bound.

## Outbound safety

- The URL must be `http` or `https` and must not contain a user name or password.
- `http` is accepted only for loopback addresses (`127.0.0.0/8`, `::1`, `localhost`). Anything else
  needs `https`, unless the endpoint sets `allow_insecure_http: true`. With plain http the body and the
  signature travel unencrypted and can be read or changed on the way; use it only on a network you
  trust.
- Under `security.profile: "public"` (see [security-model.md](security-model.md)) an endpoint may not
  point at loopback, private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local
  (`169.254/16`, `fe80::/10`, which includes the cloud metadata address `169.254.169.254`), shared
  (`100.64/10`, which includes `100.100.100.200`) or "this network" addresses, unless the endpoint sets
  `allow_private_network: true`. The rule is checked on the URL when the endpoint is saved, and again
  on **every address the host name resolves to, at each delivery, inside the connection's own
  lookup**: the address that is checked is the address that is connected to.
- Under the default `local` profile there is no address restriction, so a local receiver on
  `127.0.0.1` works out of the box.
- **DNS rebinding, honestly.** Because the check happens in the lookup used for the connection, a name
  that resolves to a public address when the endpoint is saved and to a private one later is refused
  at delivery time. What is not covered: HTTP proxies are not used for webhooks (no proxy could
  re-resolve the name), and an attacker who controls a public address you allowed can of course still
  receive the events. `allow_private_network` turns the check off for that endpoint entirely.

## API

All endpoints need an owner-wide admin key; other keys get 403 `scope_denied`.

| Endpoint | Body / result |
| --- | --- |
| `GET /v1/webhooks` | `{data: [endpoint]}` |
| `POST /v1/webhooks` | `{url, events?, agents?, include_output?, enabled?, description?, allow_insecure_http?, allow_private_network?}` → 201 endpoint plus `secret` (shown only here) |
| `GET /v1/webhooks/{id}` | endpoint |
| `PATCH /v1/webhooks/{id}` | any of the fields of `POST` → endpoint |
| `DELETE /v1/webhooks/{id}` | 204; queued deliveries are deleted, an in-flight one is aborted |
| `POST /v1/webhooks/{id}/rotate-secret` | `{id, secret}`; the old secret stops working at once |
| `POST /v1/webhooks/{id}/test` | 202 delivery; queues a `webhook.test` event |
| `GET /v1/webhooks/{id}/deliveries?limit=20` | `{data: [delivery]}`, newest first (at most 200) |
| `POST /v1/webhooks/{id}/deliveries/{delivery}/redeliver` | 202 delivery; 409 `webhook_delivery_pending` while it is still queued |

An **endpoint** is `{object: "webhook_endpoint", id, url, events, agents, include_output, enabled,
description, allow_insecure_http, allow_private_network, created_at, updated_at, status}` with
`status = {state: "ok" | "failing" | "disabled", consecutive_failures, last_success_at, last_failure_at,
last_error, pending, latest_delivery}`. Times are Unix milliseconds, as elsewhere in the management API.

A **delivery** is `{object: "webhook_delivery", id, endpoint_id, event_id, event_type, run_id, status:
"pending" | "succeeded" | "failed", attempts, next_attempt_at, http_status, duration_ms, last_error,
created_at, updated_at}`.

`events` accepts the six run events above. At most 20 endpoints per owner (409
`webhook_limit_reached`). Error codes: `webhook_not_found`, `webhook_url_invalid`,
`webhook_target_denied`, `webhook_limit_reached`, `webhook_delivery_not_found`,
`webhook_delivery_pending` (see [protocol.md](protocol.md#webhook-errors)).

## Command line and console

```
oaa webhook add URL [--event EVENT]... [--agent AGENT]... [--include-output] [--out SECRET_FILE]
oaa webhook list
oaa webhook remove ID
oaa webhook test ID
oaa webhook deliveries ID [--limit 20]
```

All take `--json`, and `--url` / `--token-file` / `--dir` like the other commands (see
[cli.md](cli.md)). `add` prints the signing secret once; with `--out FILE` it writes it to a new file
with mode 0600 instead. `test` waits up to 15 seconds for the first attempt and exits with 1 when it
failed. Changing an endpoint (enable, disable, filters) and rotating its secret go through the API.

The console's **Endpoints** page has a read-only **Webhooks** section listing the endpoints with their
state and latest delivery.

## Walkthrough: approvals in your own system

[`examples/webhook-receiver.mjs`](../examples/webhook-receiver.mjs) is a minimal receiver (Node built-ins
only). It verifies the signature, ignores repeated deliveries, prints every event, and on
`run.requires_action` prints the pending items. With `--auto-approve` it also approves them through
`POST /v1/runs/{id}/actions/{action}` with an admin key; without it, it only prints. Put your own logic
there instead: post to a chat tool, open a ticket, approve from a button.

Everything below runs offline at no cost with the bundled sample agent, which asks for one approval
when the task contains "approve".

1. Start a local gateway with the sample agent (it listens on `127.0.0.1:8787`):

   ```bash
   oaa quickstart
   ```

2. Add an endpoint for the receiver and keep its secret in a private file:

   ```bash
   oaa webhook add http://127.0.0.1:8790/ --event run.requires_action \
     --event run.completed --event run.failed --out .oaa/webhook.secret
   ```

3. Start the receiver in a second terminal:

   ```bash
   node examples/webhook-receiver.mjs --secret-file .oaa/webhook.secret \
     --token-file .oaa/admin.token --auto-approve
   ```

4. Start a task that needs an approval, then wait for it:

   ```bash
   oaa invoke agent/sample --input "please approve writing the note" --token-file .oaa/admin.token
   oaa wait RESPONSE_ID --token-file .oaa/admin.token
   ```

The receiver prints (IDs shortened):

```text
Receiver ready: http://127.0.0.1:8790/
run.requires_action  resp_c61d…  agent/sample  requires_action
  pending approval_a7b0…  native  Write outputs/sample-note.txt  expires 2026-11-14T05:17:20.000Z
  approved approval_a7b0…
run.completed  resp_c61d…  agent/sample  completed
```

Without `--auto-approve` the second line after the event reads
`not approved (add --auto-approve to approve)` and the run keeps waiting; approve it with
`oaa approve RESPONSE_ID` or in the console. `oaa webhook deliveries ID` shows both deliveries with
HTTP status 204. The same flow is run by `test/webhook-receiver-example.test.ts`.

The receiver approves with an **admin key**; in your own system give that key to the component that
decides, not to every receiver, and prefer a key limited to the `approve` scope for the agents it
handles.

## Limits and what is not covered

- Endpoints per owner: 20. Kept finished deliveries per endpoint: 200. Output carried with
  `include_output`: 32 KiB. Timeout per attempt: 10 s. Attempts: 6.
- Only owner-wide admin keys configure webhooks; there are no per-account or per-request webhooks.
- HTTPS endpoints are verified against the certificate authorities trusted by Node.js. The automated
  tests only use local plain-http receivers; delivery to a real public HTTPS endpoint goes through the
  same code but is not covered by them.
- `run.interrupted` for runs interrupted while the gateway shuts down or restarts is queued either at
  shutdown or when the gateway starts again (runs interrupted since the process started), and sent
  once.
- Several gateway processes sharing one data directory are not supported (as for the rest of the
  gateway); each would send the queue.
