"""Approvals with the OpenAI Python SDK: notice that a task is waiting for approval, then approve or deny it.

What it shows: a background run that needs a person's approval stops in `requires_action`. You find the
pending items with GET /v1/runs/{id}/actions and decide each one with
POST /v1/runs/{id}/actions/{action_id} {"decision": "approve" | "deny"}.
Needs:    pip install openai   and   OAA_API_KEY of a key with the `approve` scope (the key that
          `oaa quickstart` writes has it)      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    an agent that asks for approval. The offline sample agent does when the task contains "approve":
          it asks to write a file. An agent that never asks simply finishes ("no approval was needed").
Run:      python approve_openai.py [approve|deny]        (default: approve)
Result:   approve -> the run completes; deny -> the run fails with permission_denied.
"""

import json
import os
import sys
import time

from openai import OpenAI

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Please write a short note to outputs/note.txt. This needs my approval.")
DECISION = sys.argv[1] if len(sys.argv) > 1 else "approve"
if DECISION not in ("approve", "deny"):
    sys.exit("usage: python approve_openai.py [approve|deny]")
TERMINAL = ("completed", "failed", "cancelled", "incomplete")

client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY, max_retries=0, timeout=60)


def waiting_for_approval(run):
    return (run.metadata or {}).get("oaa.status") == "requires_action"


def poll(run, until):
    """Retrieve the run every half second until `until(run)` is true."""
    deadline = time.monotonic() + 120
    while not until(run):
        if time.monotonic() > deadline:
            sys.exit(f"gave up waiting for {run.id}")
        time.sleep(0.5)
        run = client.responses.retrieve(run.id)
    return run


run = client.responses.create(model=AGENT, input=PROMPT, background=True)
print("started", run.id)
run = poll(run, lambda r: r.status in TERMINAL or waiting_for_approval(r))

if run.status in TERMINAL:
    print(f"{run.status}: no approval was needed |", run.output_text[:100])
    sys.exit(0)

# The run is parked. GET /v1/runs/{id}/actions lists what it waits for. The gateway's own endpoints are not
# part of the OpenAI SDK, but its generic client.get / client.post reach them with the same key.
pending = client.get(f"/runs/{run.id}/actions", cast_to=object)["data"]
decided = 0
for action in pending:
    if action["kind"] == "client_tool":
        continue  # a tool result the *caller* must send back, not an approval: see recipe 04
    detail = json.loads(action["detail"]["preview"])
    print(f"pending {action['id']} ({action['kind']}): {detail.get('title')}  -> {DECISION}")
    client.post(f"/runs/{run.id}/actions/{action['id']}", body={"decision": DECISION}, cast_to=object)
    decided += 1
assert decided, "the run waits for something other than an approval"

run = poll(run, lambda r: r.status in TERMINAL)
if run.status == "failed":
    print("failed:", run.error.code if run.error else "?")  # a denied approval ends with permission_denied
else:
    print(run.status, "|", run.output_text[:100])
assert run.status == ("completed" if DECISION == "approve" else "failed"), run.status
print("ok")
