"""A long task with the OpenAI Python SDK: run in the background and poll, cancel, continue.

What it shows (Responses API, `background=True`):
  1. start a run, poll it until it ends (a request never has to stay open for the whole task);
  2. cancel a run that is still working (and cope with one that had already finished);
  3. continue the same conversation with `previous_response_id` (the agent keeps its session).
Needs:    pip install openai   and   OAA_API_KEY
          optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT (steps 1 and 3), OAA_LONG_PROMPT (step 2: something slow)
Agent:    any agent. agent/sample (offline) finishes at once, so a cancel in step 2 ends "incomplete" or
          "completed", and it cannot continue a session (step 3 reports native_resume_unsupported): its
          ACP process declares neither session/load nor session/resume. A built-in agent does all three.
Run:      python long_task_openai.py
"""

import os
import sys
import time

from openai import OpenAI

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Summarise what an API gateway does in two sentences.")
LONG_PROMPT = os.environ.get(
    "OAA_LONG_PROMPT", "Write a very detailed report on the history of the printing press, with sections and sources."
)
TERMINAL = ("completed", "failed", "cancelled", "incomplete")

client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY, max_retries=0, timeout=60)


def wait(run, limit=600):
    """Poll until the run ends. `requires_action` means it waits for an approval: see 03-approvals."""
    deadline = time.monotonic() + limit
    while run.status not in TERMINAL:
        if (run.metadata or {}).get("oaa.status") == "requires_action":
            print("  the run is waiting for an approval (see recipe 03); stop polling")
            return run
        if time.monotonic() > deadline:
            sys.exit(f"gave up waiting for {run.id}")
        time.sleep(1)
        run = client.responses.retrieve(run.id)
    return run


# 1. Start in the background and poll. The create call returns at once with status "queued".
first = client.responses.create(model=AGENT, input=PROMPT, background=True)
print("started", first.id, first.status)
first = wait(first)
print("1. poll ->", first.status, "|", first.output_text[:120])
assert first.status == "completed", first.status

# 2. Cancel, then poll for the final state. Three outcomes are normal:
#    - "cancelled": a built-in (kernel) agent stopped cleanly;
#    - "incomplete" with reason effect_outcome_unknown: an external agent (ACP, Codex, ...) was stopped in the
#      middle of a step, so the gateway cannot know whether its side effects happened (docs/operations.md,
#      "Inspect and recover work");
#    - "completed": the run had already finished (cancelling a finished run changes nothing).
slow = client.responses.create(model=AGENT, input=LONG_PROMPT, background=True)
client.responses.cancel(slow.id)
slow = wait(client.responses.retrieve(slow.id))
reason = slow.incomplete_details.reason if slow.incomplete_details else None
print("2. cancel ->", slow.status, f"({reason})" if reason else "")
assert slow.status in ("cancelled", "incomplete", "completed"), slow.status

# 3. Continue the conversation: the new run belongs to the same session. Not every agent can: an external agent
#    that supports neither session/load nor session/resume (the offline sample agent is one) cannot pick up its
#    previous session, and the run fails with native_resume_unsupported. Built-in agents always can.
second = client.responses.create(
    model=AGENT, input="Now say it again, shorter.", previous_response_id=first.id, background=True
)
second = wait(second)
if second.status == "failed" and second.error and second.error.code == "native_resume_unsupported":
    print("3. continue -> this agent cannot continue a session (native_resume_unsupported); use another agent")
else:
    print("3. continue ->", second.status, "|", second.output_text[:120])
    assert second.status == "completed", second.status
    assert second.previous_response_id == first.id
print("ok")
