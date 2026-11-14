"""Errors and retries with the OpenAI Python SDK: which failures to retry, which not, and how to tell.

What it shows:
  * `max_retries=0` and your own policy. A run is not free to repeat, and an SDK retry after a timeout would start a
    SECOND run (a disconnected client does not cancel the first one).
  * One `Idempotency-Key` per logical task, the same on every attempt: a retry then attaches to the run that already
    exists instead of starting another.
  * What the gateway tells you: `x-should-retry: false` (do not retry), `Retry-After` (seconds to wait, on 429/503),
    the stable `error.code`, and the catalog `GET /v1/errors` (`retryable`, and `en` / `nextEn` text) for the rest.
  * Part 3 and 4 use a stub transport, so the rate-limit and failed-run cases are shown without having to overload
    your gateway.
Needs:    pip install openai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    any agent.
Run:      python retries_openai.py
"""

import json
import os
import sys
import time
import uuid

try:  # the OpenAI SDK 3.x is built on httpx2; older releases on httpx
    import httpx2 as httpx
except ImportError:
    import httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Say hello in one sentence.")

client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY, max_retries=0, timeout=300)
CATALOG = {e["code"]: e for e in client.get("/errors", cast_to=object)["data"]}  # GET /v1/errors (needs `read`)


def decide(error):
    """Return (wait_seconds, why) to retry, or (None, why) to stop. Pure function of what the gateway said."""
    if isinstance(error, (APITimeoutError, APIConnectionError)):
        # The request may have reached the gateway and started a run. Safe only because every attempt carries the
        # same Idempotency-Key: the retry attaches to that run.
        return 2, "no answer from the gateway; retry with the same Idempotency-Key"
    assert isinstance(error, APIStatusError)
    headers = error.response.headers
    code = error.code or "?"
    known = CATALOG.get(code, {})
    if headers.get("x-should-retry") == "false":
        return None, f"{error.status_code} {code}: the gateway says do not retry"
    if error.status_code in (429, 503) and "retry-after" in headers:
        return min(int(headers["retry-after"]), 60), f"{error.status_code} {code}: server asked to wait"
    if known.get("retryable") or error.status_code in (408, 500, 502, 503, 504):
        return 2, f"{error.status_code} {code}: transient"
    return None, f"{error.status_code} {code}: {known.get('en', error.message)} {known.get('nextEn', '')}".strip()


def call_with_retry(client_, attempts=4, **request):
    key = str(uuid.uuid4())  # one key per logical task, reused by every attempt
    for attempt in range(1, attempts + 1):
        try:
            result = client_.chat.completions.create(extra_headers={"Idempotency-Key": key}, **request)
            return result, attempt
        except (APIStatusError, APITimeoutError, APIConnectionError) as error:
            wait, why = decide(error)
            if wait is None or attempt == attempts:
                raise
            print(f"  attempt {attempt}: {why}; waiting {wait}s")
            time.sleep(wait)


messages = [{"role": "user", "content": PROMPT}]

# 1. A normal call through the wrapper.
completion, attempts = call_with_retry(client, model=AGENT, messages=messages)
print(f"1. real call: ok in {attempts} attempt(s): {completion.choices[0].message.content[:60]!r}")

# 2. A request that can never succeed: stop at once, and say why from the catalog.
try:
    call_with_retry(client, model="agent/does-not-exist", messages=messages)
except APIStatusError as error:
    wait, why = decide(error)
    assert wait is None and error.status_code == 404 and error.code == "agent_not_found"
    print(f"2. unknown agent: stop ({why})")


def stub(responses):
    """A client whose transport answers from a list: (status, headers, body) per request."""
    answers = iter(responses)

    def handler(request):
        status, headers, body = next(answers)
        return httpx.Response(status, headers=headers, content=json.dumps(body).encode())

    return OpenAI(
        base_url="http://stub.invalid/v1",
        api_key="stub",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


OK = {
    "id": "chatcmpl_stub",
    "object": "chat.completion",
    "created": 0,
    "model": AGENT,
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
}
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "slow down", "type": "invalid_request_error"}}
RUN_FAILED = {"error": {"code": "structured_output_invalid", "message": "run failed", "type": "invalid_request_error"}}
JSON = {"content-type": "application/json"}

# 3. Rate limited with Retry-After: wait what the server says, then the same request succeeds.
started = time.monotonic()
stubbed = stub([(429, {**JSON, "retry-after": "1"}, RATE_LIMITED), (200, JSON, OK)])
_, attempts = call_with_retry(stubbed, model=AGENT, messages=messages)
print(f"3. simulated 429 + Retry-After: 1: succeeded on attempt {attempts} after {time.monotonic() - started:.1f}s")
assert attempts == 2

# 4. A run that was created and ended badly (422 with x-should-retry: false): never retry it, the run exists.
stubbed = stub([(422, {**JSON, "x-should-retry": "false"}, RUN_FAILED), (200, JSON, OK)])
try:
    call_with_retry(stubbed, model=AGENT, messages=messages)
    sys.exit("a 422 with x-should-retry: false was retried")
except APIStatusError as error:
    print(f"4. simulated 422 + x-should-retry: false: stop ({decide(error)[1]})")
print("ok")
